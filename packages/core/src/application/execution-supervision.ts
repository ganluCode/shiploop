import type { WorkResourceIdentity } from '../ports/work-resources.js';
import type { RuntimeSession } from './runtime-execution.js';
import type { RuntimeExecutionRequest, RuntimeExecutionResult, RuntimeStopEvidence } from '../ports/runtime-execution.js';
import { RuntimeError } from '../ports/runtime-execution.js';
import type { RuntimeControlFacts } from '../ports/runtime-settlement.js';
import type { RuntimeSettlementService } from './runtime-settlement.js';
import type { WorkEvidenceRecordingOutcome } from './work-evidence-recorder.js';
import type { WorkspaceRetentionReason } from '../ports/workspace-retention.js';

export interface ExecutionCompletion {
  readonly stopConfirmed: boolean;
  readonly persisted: boolean;
  readonly retained: boolean;
  readonly error: string | null;
}
export interface ExecutionRetentionInput {
  readonly identity: WorkResourceIdentity;
  readonly runId: string;
  readonly taskId: string;
  readonly featureId: string;
  readonly reason: WorkspaceRetentionReason;
  readonly evidenceRef: string;
}
/** Trusted lifecycle assembly. No verifier/acceptance capability is implied. */
export interface ExecutionSupervisionOptions {
  readonly stopWaitMs: number;
  readonly drainWaitMs: number;
  readonly closeWaitMs: number;
  readonly retain: (input: ExecutionRetentionInput) => Promise<void>;
}
export type ExecutionStopReason = RuntimeControlFacts['reason'];

/** Finite observation only; a timeout never resolves or rewrites the original promise. */
export async function observeWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally { clearTimeout(timer); }
}

export function superviseExecution(input: {
  readonly request: RuntimeExecutionRequest;
  readonly runtime: RuntimeSession;
  readonly controller: AbortController;
  readonly result: Promise<PromiseSettledResult<RuntimeExecutionResult>>;
  readonly stopped: Promise<PromiseSettledResult<RuntimeStopEvidence>>;
  readonly recording: Promise<PromiseSettledResult<WorkEvidenceRecordingOutcome>>;
  readonly options: ExecutionSupervisionOptions;
  readonly settlement: RuntimeSettlementService;
  readonly quarantine: () => void;
  readonly evidenceRef: () => string | null;
  readonly timeoutMs: number;
  readonly timeoutReason: 'runtime_timeout' | 'parent_deadline';
}) {
  let reason: ExecutionStopReason | null = null;
  let cancel: RuntimeControlFacts['cancel'] = 'unobserved';
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });
  let finished = false;
  const stop = (value: ExecutionStopReason) => {
    if (finished || reason !== null) return;
    reason = value;
    // Abort only this Attempt's collection; cancellation remains independent of stop evidence.
    input.controller.abort(value);
    void Promise.resolve().then(() => input.runtime.cancel()).then(
      receipt => { cancel = receipt.accepted ? 'accepted' : 'rejected'; },
      () => { cancel = 'failed'; },
    );
    resolveStop();
  };
  const timer = setTimeout(() => stop(input.timeoutReason), Math.max(1, input.timeoutMs));
  void input.recording.then(outcome => {
    if (outcome.status === 'rejected' || outcome.value.status !== 'complete') stop('recording_failed');
  });
  void input.result.then(outcome => {
    if (outcome.status === 'rejected' || outcome.value.terminal === 'failed') stop('runtime_failed');
    else if (outcome.value.terminal === 'timed_out') stop(outcome.value.reason === 'tool_timeout' ? 'tool_timeout' : 'runtime_timeout');
    else if (outcome.value.terminal === 'cancelled') stop('runtime_cancelled');
  });
  void input.stopped.then(outcome => {
    if (outcome.status === 'rejected' || !outcome.value.confirmed) stop('stop_unconfirmed');
  });
  const completion = (async (): Promise<ExecutionCompletion> => {
    let confirmed = false;
    let persisted = false;
    try {
      await Promise.race([Promise.all([input.result, input.recording]), stopRequested]);
      let stopped = await observeWithin(input.stopped, input.options.stopWaitMs);
      if (stopped?.status !== 'fulfilled' || !stopped.value.confirmed) {
        stop('stop_unconfirmed');
        if (stopped === undefined) stopped = await observeWithin(input.stopped, input.options.stopWaitMs);
      }
      confirmed = stopped?.status === 'fulfilled' && stopped.value.confirmed;
      const observations = await observeWithin(Promise.all([input.result, input.recording]), input.options.drainWaitMs);
      const result = observations?.[0] ?? await observeWithin(input.result, 1)
        ?? { status: 'rejected' as const, reason: new RuntimeError('process', 'runtime_result_unobserved') };
      const recording = observations?.[1] ?? await observeWithin(input.recording, 1) ?? null;
      // The controller's reason augments raw observations, preserving known usage and unknown fields.
      const control: RuntimeControlFacts | undefined = reason === null ? undefined : { reason, cancel };
      const receipt = await input.settlement.settle({ request: input.request, result, recording,
        stopped: stopped ?? null, ...(control ? { control } : {}) });
      if (receipt.disposition !== 'applied' && receipt.disposition !== 'replayed') {
        return { stopConfirmed: confirmed, persisted: false, retained: false, error: 'stale_execution_identity' };
      }
      if (!receipt.resultSaved) throw new Error('result_not_saved');
      persisted = true;
      let retained = false;
      if (confirmed && receipt.status !== 'verifying') {
        const evidenceRef = input.evidenceRef();
        if (evidenceRef === null) throw new Error('missing_settlement_evidence');
        const retentionReason: WorkspaceRetentionReason = receipt.status === 'cancelled' ? 'cancelled'
          : control?.reason === 'runtime_timeout' || control?.reason === 'tool_timeout' || control?.reason === 'parent_deadline' ? 'timed_out' : 'execution_error';
        const work = input.request.identity;
        if (work.purpose !== 'work') throw new TypeError('Expected Work execution');
        await input.options.retain({ identity: { projectId: input.request.projectId, attemptId: work.attemptId,
          owner: input.request.owner.principalId, hostInstanceId: input.request.owner.hostInstanceId,
          executionVersion: input.request.executionVersion }, runId: work.runId, taskId: work.taskId,
          featureId: input.request.featureId, reason: retentionReason, evidenceRef });
        retained = true;
      }
      return { stopConfirmed: confirmed, persisted: true, retained, error: null };
    } catch {
      input.quarantine();
      return { stopConfirmed: confirmed, persisted, retained: false, error: 'execution_finalization_failed' };
    } finally { finished = true; clearTimeout(timer); }
  })();
  return { stop, completion };
}
