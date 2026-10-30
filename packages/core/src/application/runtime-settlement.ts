/**
 * F-009: persist independent Runtime/result, recording and stop observations, then
 * delegate the fenced business transition to the existing Attempt applicator.
 * No verifier/commit capability is assembled here; completed is never passed.
 */
import { createHash } from 'node:crypto';
import { recoveryRecordingForRequest } from './runtime-recovery-recording.js';
import type { WorkSessionStore } from '../ports/work-session.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { AttemptLifecycleStore, AttemptApplicationResult, AttemptNotification } from '../ports/attempt-lifecycle.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { TaskDagStore } from '../ports/task-dag.js';
import { isRuntimeError, validateRuntimeExecutionRequest, validateRuntimeExecutionResult, validateRuntimeStopEvidence,
  type RuntimeExecutionRequest, type RuntimeExecutionResult, type RuntimeStopEvidence } from '../ports/runtime-execution.js';
import { classifyRuntimeExecutionResult, classifyRuntimeFailure, type RuntimeFailureClassification } from '../ports/runtime-failure.js';
import { isPlanningAttemptSnapshot } from '../ports/attempt-store.js';
import type { WorkResourceIdentity } from '../ports/work-resources.js';
import type { RuntimeSettlementFacts, RuntimeControlFacts } from '../ports/runtime-settlement.js';
import type { WorkEvidenceRecordingOutcome } from './work-evidence-recorder.js';
import { WorkEvidenceRecordingError, recordingRequiresStop } from './work-evidence-recorder.js';

export interface RuntimeSettlementInput {
  readonly request: RuntimeExecutionRequest;
  readonly result: PromiseSettledResult<RuntimeExecutionResult>;
  readonly recording: PromiseSettledResult<WorkEvidenceRecordingOutcome> | null;
  /** A bounded controller observation; null explicitly means stop not observed. */
  readonly stopped: PromiseSettledResult<RuntimeStopEvidence> | null;
  readonly control?: RuntimeControlFacts;
}
export interface RuntimeSettlementService {
  settle(input: RuntimeSettlementInput): Promise<AttemptApplicationResult>;
  rejectLaunch?(input: { readonly identity: WorkResourceIdentity; readonly taskId: string; readonly runId: string;
    readonly error: unknown }): Promise<{ readonly receipt: AttemptApplicationResult; readonly evidenceRef: string }>;
}
export interface RuntimeSettlementDeps {
  readonly lifecycle: AttemptLifecycleStore;
  readonly publisher: ArtifactPublisher;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly dag: TaskDagStore;
  readonly secrets?: readonly string[];
  readonly sessions?: Pick<WorkSessionStore, 'getWorkSession'>;
}

export function createRuntimeSettlementService(deps: RuntimeSettlementDeps): RuntimeSettlementService {
  // Only bounded machine reasons are retained. Error.message/cause are never persisted.
  const token = (value: string) => {
    let redacted = value;
    for (const secret of deps.secrets ?? []) if (secret) redacted = redacted.split(secret).join('redacted');
    return redacted.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 200) || 'unknown';
  };
  const redact = (_key: string, value: unknown): unknown => typeof value === 'string'
    ? (deps.secrets ?? []).filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) : value;
  const failure = (error: unknown, fallback: string): NonNullable<RuntimeSettlementFacts['failure']> =>
    isRuntimeError(error) ? { kind: error.kind, reason: token(error.reason) } : { kind: 'protocol', reason: fallback };

  return { async rejectLaunch(input) {
    const { identity, taskId, runId } = input;
    const error = failure(input.error, 'launch_rejected');
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'runtime-not-started', identity,
      taskId, runId, failure: error, recording: { complete: false, gaps: ['runtime_not_started'] } }));
    const published = await deps.publisher.publishArtifact({ projectId: identity.projectId, kind: 'runtime-settlement',
      mediaType: 'application/json', expectedHash: createHash('sha256').update(body).digest('hex'),
      locator: `attempts/${identity.attemptId}/launch-rejection.json`, content: [body] });
    const receipt = deps.lifecycle.apply({ ...identity, taskId, runId, notificationId: 'runtime-not-started',
      kind: 'preparation_failed', errorKind: 'input', evidenceRef: published.artifact.id });
    return { receipt, evidenceRef: published.artifact.id };
  }, async settle(input) {
    const request = validateRuntimeExecutionRequest(input.request);
    if (request.identity.purpose !== 'work') throw new TypeError('Work settlement requires a Work identity');
    const identity = { projectId: request.projectId, attemptId: request.identity.attemptId,
      taskId: request.identity.taskId, runId: request.identity.runId, owner: request.owner.principalId,
      hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
    let result: RuntimeExecutionResult | null = null;
    let classification: RuntimeFailureClassification | null = null;
    let executionFailure: RuntimeSettlementFacts['failure'] = null;
    if (input.result.status === 'fulfilled') {
      try {
        const parsed = validateRuntimeExecutionResult(input.result.value);
        result = { ...parsed, reason: parsed.reason === null ? null : token(parsed.reason) };
        classification = classifyRuntimeExecutionResult(result, { secrets: deps.secrets,
          errorChain: result.reason === null ? [] : [{ source: 'sdk',
            code: result.reason === 'temporary_server_failure' ? 'server_error' : result.reason,
            message: result.reason.replace(/_/g, ' ') }],
          ...(result.reason === 'tool_failed' ? { lastStage: 'tool' } : {}),
          ...(parsed.terminal === 'completed' ? {} : { partialResult: {
            usage: parsed.usage, durationMs: parsed.durationMs, lastEventSequence: parsed.lastEventSequence } }),
        });
        if (parsed.terminal !== 'completed' || (parsed.exitCode !== null && parsed.exitCode !== 0)) {
          executionFailure = { kind: classification.settlementKind ?? (parsed.terminal === 'timed_out' ? 'timeout' : 'process'),
            reason: token(parsed.reason ?? `runtime_${parsed.terminal}`) };
        }
      } catch (error) { executionFailure = failure(error, 'invalid_runtime_result'); }
    } else executionFailure = failure(input.result.reason, 'runtime_result_rejected');
    if (classification === null && executionFailure !== null) {
      classification = classifyRuntimeFailure({ existingRuntimeError: executionFailure, terminalObserved: false, secrets: deps.secrets });
    }
    let stopped: RuntimeStopEvidence | null = null;
    let stopFailure: string | null = null;
    if (input.stopped?.status === 'fulfilled') {
      try {
        const parsed = validateRuntimeStopEvidence(input.stopped.value);
        stopped = { ...parsed, detail: parsed.detail === null ? null : token(parsed.detail) };
      } catch { stopFailure = 'invalid_stop_evidence'; }
    } else if (input.stopped?.status === 'rejected') stopFailure = 'runtime_stop_rejected';
    const recording = input.recording?.status === 'fulfilled' ? input.recording.value : null;
    const recordingError = input.recording?.status === 'rejected' ? input.recording.reason : null;
    const recordingMode = recording?.recordingMode
      ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.recordingMode : 'required');
    const manifestRef = recording?.manifestArtifactId
      ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.manifestArtifactId : null);
    // Keep the original Runtime failure authoritative even if evidence cleanup also fails.
    const recordingFailure = recordingError === null ? null : recordingError instanceof WorkEvidenceRecordingError
      ? token(recordingError.reason) : 'recording_rejected';
    if (executionFailure === null && recordingError instanceof WorkEvidenceRecordingError && recordingError.reason === 'event_stream_failed') {
      executionFailure = { kind: 'protocol', reason: 'runtime_events_failed' };
      classification = classifyRuntimeFailure({ terminal: result?.terminal, terminalObserved: result !== null,
        protocolIssue: 'runtime_events_failed', usage: result?.usage, durationMs: result?.durationMs, secrets: deps.secrets });
    }
    if (input.control?.reason === 'user_cancelled' || input.control?.reason === 'service_close') executionFailure = null;
    else if (input.control?.reason === 'runtime_timeout' || input.control?.reason === 'tool_timeout' || input.control?.reason === 'parent_deadline') {
      executionFailure = { kind: 'timeout', reason: input.control.reason };
    } else if (input.control?.reason === 'recording_failed' && (executionFailure === null || result?.terminal === 'cancelled')) {
      executionFailure = { kind: 'protocol', reason: 'recording_failed' };
    }
    const recordingBlocksExecution = input.recording !== null && recordingRequiresStop(input.recording);
    // A fulfilled partial recording is a durable, inspectable observation. Keep it
    // as a required-recording gate when stop is confirmed; only a rejected
    // recording (or an unconfirmed stop) is itself a settlement failure. The
    // supervisor's explicit recording_failed control still takes precedence
    // above, so hard recorder faults retain their cancellation/failure path.
    const recordingObservationFailed = input.recording?.status === 'rejected'
      || input.stopped?.status !== 'fulfilled' || input.stopped.value.confirmed !== true;
    if (recordingBlocksExecution && recordingObservationFailed && executionFailure === null
        && input.control?.reason !== 'user_cancelled' && input.control?.reason !== 'service_close') {
      executionFailure = { kind: 'protocol', reason: 'recording_failed' };
    }
    const recovery = recording?.recovery
      ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.recovery : undefined)
      ?? recoveryRecordingForRequest(request, undefined, deps.sessions);
    const runtime: RuntimeSettlementFacts = { sessionId: request.sessionId, invocationId: request.invocationId,
      result, failure: executionFailure, recording: { mode: recordingMode, complete: recording?.status === 'complete', manifestRef,
        gaps: [...new Set([...(recording?.gaps ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.gaps : [])),
          ...(recovery?.gaps ?? []).map(gap => token(`recovery:${gap}`))])].slice(0, 32).map(token) }, stopped,
      ...(input.control ? { control: input.control } : {}) };
    const attempt = deps.attempts.getAttempt(identity.projectId, identity.attemptId);
    // P05-1 / F-007：planning Task 不在编码 DAG 事实集内；行级围栏由 planning
    // 生命周期结算分支重核（Task 状态/版本 CAS）。
    const task = isPlanningAttemptSnapshot(attempt.inputSnapshot)
      ? { executionVersion: identity.executionVersion }
      : deps.dag.readTaskDagView(identity.projectId, identity.runId).facts.find(f => f.taskId === identity.taskId);
    const current = attempt.owner === identity.owner && attempt.hostInstanceId === identity.hostInstanceId
      && attempt.executionVersion === identity.executionVersion && task?.executionVersion === identity.executionVersion
      && attempt.taskId === identity.taskId && attempt.runId === identity.runId && attempt.invocationId === request.invocationId;
    const notification = (evidenceRef: string): AttemptNotification => ({ ...identity, kind: 'runtime_settled',
      notificationId: 'runtime-settlement', evidenceRef, runtime });
    // Existing receipt replay is decided by the applicator before its nonterminal CAS.
    // Stale notifications cannot publish output or mutate Session/watermarks/accounting.
    if (!current || !['preparing', 'executing'].includes(attempt.status)) {
      return deps.lifecycle.apply(notification(attempt.diagnosticRef ?? request.inputManifest.artifactId));
    }
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'runtime-settlement',
      identity: { ...identity, sessionId: request.sessionId, invocationId: request.invocationId },
      execution: { result, failure: executionFailure, classification },
      ...(recovery === undefined ? {} : { recovery }),
      routing: { category: classification?.category ?? null,
        previousFailures: (attempt.inputSnapshot.runtimeFallback?.previousFailures ?? []).slice(0, 32)
          .map(item => ({ category: item.category, reason: token(item.reason) })),
        selected: attempt.inputSnapshot.runtimeFallback ? {
          runtime: token(attempt.inputSnapshot.runtimeFallback.strategy.runtime),
          provider: token(attempt.inputSnapshot.runtimeFallback.strategy.provider),
          model: token(attempt.inputSnapshot.runtimeFallback.strategy.model),
          source: token(attempt.inputSnapshot.runtimeFallback.strategySource),
        } : null },
      recording: { ...(recordingMode === 'best_effort' ? { mode: recordingMode } : {}),
        complete: runtime.recording.complete, manifestRef, failure: recordingFailure,
        cleanupStatus: recordingError instanceof WorkEvidenceRecordingError ? recordingError.cleanupStatus : 'confirmed',
        gaps: (recording?.gaps ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.gaps : ['recording_unobserved'])).slice(0, 32).map(token),
        watermark: recording?.watermark ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.watermark : null) },
      stop: { evidence: stopped, failure: stopFailure }, ...(input.control ? { control: input.control } : {}) }, redact), 'utf8');
    const published = await deps.publisher.publishArtifact({ projectId: request.projectId,
      kind: 'runtime-settlement', mediaType: 'application/json', expectedHash: createHash('sha256').update(body).digest('hex'),
      locator: `sessions/${request.sessionId}/runtime-settlement.json`, content: [body] });
    return deps.lifecycle.apply(notification(published.artifact.id));
  } };
}
