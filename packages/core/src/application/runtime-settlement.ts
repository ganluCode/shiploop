/**
 * F-009: persist independent Runtime/result, recording and stop observations, then
 * delegate the fenced business transition to the existing Attempt applicator.
 * No verifier/commit capability is assembled here; completed is never passed.
 */
import { createHash } from 'node:crypto';
import type { ArtifactPublisher } from './artifact-publish.js';
import type { AttemptLifecycleStore, AttemptApplicationResult, AttemptNotification } from '../ports/attempt-lifecycle.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { TaskDagStore } from '../ports/task-dag.js';
import { isRuntimeError, validateRuntimeExecutionRequest, validateRuntimeExecutionResult, validateRuntimeStopEvidence,
  type RuntimeExecutionRequest, type RuntimeExecutionResult, type RuntimeStopEvidence } from '../ports/runtime-execution.js';
import type { WorkResourceIdentity } from '../ports/work-resources.js';
import type { RuntimeSettlementFacts, RuntimeControlFacts } from '../ports/runtime-settlement.js';
import type { WorkEvidenceRecordingOutcome } from './work-evidence-recorder.js';
import { WorkEvidenceRecordingError } from './work-evidence-recorder.js';

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
}

export function createRuntimeSettlementService(deps: RuntimeSettlementDeps): RuntimeSettlementService {
  // Only bounded machine reasons are retained. Error.message/cause are never persisted.
  const token = (value: string) => {
    let redacted = value;
    for (const secret of deps.secrets ?? []) if (secret) redacted = redacted.split(secret).join('redacted');
    return redacted.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 200) || 'unknown';
  };
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
    let executionFailure: RuntimeSettlementFacts['failure'] = null;
    if (input.result.status === 'fulfilled') {
      try {
        const parsed = validateRuntimeExecutionResult(input.result.value);
        result = { ...parsed, reason: parsed.reason === null ? null : token(parsed.reason) };
        if (parsed.terminal !== 'completed' || (parsed.exitCode !== null && parsed.exitCode !== 0)) {
          executionFailure = { kind: parsed.terminal === 'timed_out' ? 'timeout' : 'process',
            reason: token(parsed.reason ?? `runtime_${parsed.terminal}`) };
        }
      } catch (error) { executionFailure = failure(error, 'invalid_runtime_result'); }
    } else executionFailure = failure(input.result.reason, 'runtime_result_rejected');
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
    const manifestRef = recording?.manifestArtifactId
      ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.manifestArtifactId : null);
    // Keep the original Runtime failure authoritative even if evidence cleanup also fails.
    const recordingFailure = recordingError === null ? null : recordingError instanceof WorkEvidenceRecordingError
      ? token(recordingError.reason) : 'recording_rejected';
    if (executionFailure === null && recordingError instanceof WorkEvidenceRecordingError && recordingError.reason === 'event_stream_failed') {
      executionFailure = { kind: 'protocol', reason: 'runtime_events_failed' };
    }
    if (input.control?.reason === 'user_cancelled' || input.control?.reason === 'service_close') executionFailure = null;
    else if (input.control?.reason === 'runtime_timeout' || input.control?.reason === 'tool_timeout' || input.control?.reason === 'parent_deadline') {
      executionFailure = { kind: 'timeout', reason: input.control.reason };
    } else if (input.control?.reason === 'recording_failed' && (executionFailure === null || result?.terminal === 'cancelled')) {
      executionFailure = { kind: 'protocol', reason: 'recording_failed' };
    }
    const runtime: RuntimeSettlementFacts = { sessionId: request.sessionId, invocationId: request.invocationId,
      result, failure: executionFailure, recording: { complete: recording?.status === 'complete', manifestRef }, stopped,
      ...(input.control ? { control: input.control } : {}) };
    const attempt = deps.attempts.getAttempt(identity.projectId, identity.attemptId);
    const task = deps.dag.readTaskDagView(identity.projectId, identity.runId).facts.find(f => f.taskId === identity.taskId);
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
      execution: { result, failure: executionFailure },
      recording: { complete: runtime.recording.complete, manifestRef, failure: recordingFailure,
        gaps: (recording?.gaps ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.gaps : ['recording_unobserved'])).slice(0, 32).map(token),
        watermark: recording?.watermark ?? (recordingError instanceof WorkEvidenceRecordingError ? recordingError.watermark : null) },
      stop: { evidence: stopped, failure: stopFailure }, ...(input.control ? { control: input.control } : {}) }), 'utf8');
    const published = await deps.publisher.publishArtifact({ projectId: request.projectId,
      kind: 'runtime-settlement', mediaType: 'application/json', expectedHash: createHash('sha256').update(body).digest('hex'),
      locator: `sessions/${request.sessionId}/runtime-settlement.json`, content: [body] });
    return deps.lifecycle.apply(notification(published.artifact.id));
  } };
}
