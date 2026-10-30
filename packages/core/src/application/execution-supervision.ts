import type { WorkResourceIdentity } from '../ports/work-resources.js';
import type { RuntimeSession } from './runtime-execution.js';
import type { RuntimeExecutionRequest, RuntimeExecutionResult, RuntimeStopEvidence } from '../ports/runtime-execution.js';
import { RuntimeError } from '../ports/runtime-execution.js';
import type { RuntimeControlFacts, RuntimeTimeoutFact } from '../ports/runtime-settlement.js';
import type { RuntimeSettlementInput, RuntimeSettlementService } from './runtime-settlement.js';
import type { AttemptApplicationResult } from '../ports/attempt-lifecycle.js';
import { WorkEvidenceRecordingError, recordingRequiresStop, type WorkEvidenceRecordingOutcome } from './work-evidence-recorder.js';
import type { WorkspaceRetentionReason } from '../ports/workspace-retention.js';

export interface ExecutionCompletion {
  readonly stopConfirmed: boolean;
  readonly persisted: boolean;
  readonly retained: boolean;
  readonly error: string | null;
  /** F-004：公开 recording/事件尾部是否已完成有界 flush；缺失表示旧装配未提供该事实。 */
  readonly recordingFlushed?: boolean;
  /** P03-9 / F-003：停止证据关联的实际退出码/信号；未知保持 null。 */
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** true＝观察到强制终止；null＝无法判定；绝不填 false 冒充未升级。 */
  readonly forced?: boolean | null;
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
  /** Trusted routing after fenced persistence and before releasing the old workspace. */
  readonly routeFailure?: (input: RuntimeSettlementInput & { readonly receipt: AttemptApplicationResult }) => Promise<boolean>;
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
  /** P03-9 / F-004：触发层（Session/Run/Batch）与观察起点（已知耗时基准）。 */
  readonly timeoutLayer: 'session' | 'run' | 'batch';
  readonly timeoutLimitMs: number;
  /** Absolute deadline used to classify a result that was delivered after the timer boundary. */
  readonly deadlineUtcMs?: number | null;
  readonly nowUtcMs?: () => number;
}) {
  let reason: ExecutionStopReason | null = null;
  let cancel: RuntimeControlFacts['cancel'] = 'unobserved';
  let timeout: RuntimeTimeoutFact | undefined;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });
  let finished = false;
  // Monotonic elapsed base: epoch clocks (including test-injected clocks) do not
  // have to be real-time; elapsed is still a known observed duration.
  const observedFromMs = performance.now();
  const stop = (value: ExecutionStopReason, fact?: RuntimeTimeoutFact) => {
    if (finished || reason !== null) return;
    // Recorder and Runtime share a finite execution budget. If recording's
    // callback wins after that boundary, preserve the timeout fact even when
    // the event loop has not delivered the supervisor's timer yet.
    if (value === 'recording_failed' && (performance.now() - observedFromMs >= input.timeoutMs || deadlineReached())) {
      value = input.timeoutReason;
      fact = timeoutFact(elapsed());
    }
    reason = value;
    if (fact !== undefined) timeout = fact;
    // Abort only this Attempt's collection; cancellation remains independent of stop evidence.
    // A failed result still has a final event watermark to drain and persist.
    // Other control paths interrupt collection immediately; failure uses the same finite drain deadline.
    if (value !== 'runtime_failed') input.controller.abort(value);
    void Promise.resolve().then(() => input.runtime.cancel()).then(
      receipt => { cancel = receipt.accepted ? 'accepted' : 'rejected'; },
      () => { cancel = 'failed'; },
    );
    resolveStop();
  };
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - observedFromMs));
  const deadlineReached = (): boolean => {
    if (input.deadlineUtcMs === undefined || input.deadlineUtcMs === null || input.nowUtcMs === undefined) return false;
    const now = input.nowUtcMs();
    return Number.isSafeInteger(now) && now >= input.deadlineUtcMs;
  };
  const timeoutFact = (elapsedMs: number): RuntimeTimeoutFact => ({
    layer: input.timeoutLayer,
    stage: 'runtime',
    limitMs: input.timeoutLimitMs,
    elapsedMs,
    deadlineUtcMs: input.deadlineUtcMs ?? null,
  });
  const timer = setTimeout(() => stop(input.timeoutReason, timeoutFact(elapsed())), Math.max(1, input.timeoutMs));
  void input.recording.then(outcome => {
    if (recordingRequiresStop(outcome)) stop('recording_failed');
  });
  void input.result.then(outcome => {
    if (outcome.status === 'rejected' || outcome.value.terminal === 'failed') stop('runtime_failed');
    else if (outcome.value.terminal === 'timed_out') {
      const toolTimedOut = outcome.value.reason === 'tool_timeout';
      stop(toolTimedOut ? 'tool_timeout' : 'runtime_timeout', {
        layer: toolTimedOut ? 'tool' : 'session',
        stage: 'runtime',
        limitMs: toolTimedOut ? input.request.limits.toolTimeoutMs ?? null : input.request.limits.timeoutMs,
        elapsedMs: outcome.value.durationMs ?? elapsed(),
        deadlineUtcMs: toolTimedOut ? null : input.deadlineUtcMs ?? null,
      });
    }
    else if (outcome.value.terminal === 'completed' && deadlineReached()) {
      stop(input.timeoutReason, timeoutFact(outcome.value.durationMs ?? elapsed()));
    }
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
      if (observations === undefined) input.controller.abort('drain_timeout');
      const result = observations?.[0] ?? await observeWithin(input.result, 1)
        ?? { status: 'rejected' as const, reason: new RuntimeError('process', 'runtime_result_unobserved') };
      const recording = observations?.[1] ?? await observeWithin(input.recording, 1) ?? null;
      const cleanupConfirmed = confirmed && !(recording?.status === 'rejected'
        && recording.reason instanceof WorkEvidenceRecordingError && recording.reason.cleanupStatus === 'cleanup_unconfirmed');
      if (!cleanupConfirmed) input.quarantine();
      const recordingFlushed = recording?.status === 'fulfilled';
      // The controller's reason augments raw observations, preserving known usage and unknown fields.
      const control: RuntimeControlFacts | undefined = reason === null ? undefined : {
        reason,
        cancel,
        ...(timeout === undefined ? {} : { timeout }),
      };
      const runtimeResult = observations?.[0]?.status === 'fulfilled' ? observations[0].value : undefined;
      const observedExit = runtimeResult?.exitCode ?? null;
      const observedSignal = runtimeResult?.signal ?? null;
      const observedForced = observedSignal === 'SIGKILL' ? true : null;
      const receipt = await input.settlement.settle({ request: input.request, result, recording,
        stopped: stopped ?? null, ...(control ? { control } : {}) });
      if (receipt.disposition !== 'applied' && receipt.disposition !== 'replayed') {
        return { stopConfirmed: confirmed, persisted: false, retained: false, error: 'stale_execution_identity',
          recordingFlushed,
          exitCode: observedExit, signal: observedSignal, forced: observedForced };
      }
      if (!receipt.resultSaved) throw new Error('result_not_saved');
      persisted = true;
      let retained = false;
      const routed = cleanupConfirmed && receipt.status === 'failed' && receipt.disposition === 'applied'
        && recording !== null && !recordingRequiresStop(recording)
        && await input.options.routeFailure?.({ request: input.request, result, recording,
          stopped: stopped ?? null, receipt, ...(control ? { control } : {}) }) === true;
      if (cleanupConfirmed && receipt.status !== 'verifying' && !routed) {
        const evidenceRef = input.evidenceRef();
        if (evidenceRef === null) throw new Error('missing_settlement_evidence');
        const retentionReason: WorkspaceRetentionReason = receipt.status === 'cancelled' ? 'cancelled'
          : receipt.status === 'succeeded' ? 'planning_delivered'
          : control?.reason === 'runtime_timeout' || control?.reason === 'tool_timeout' || control?.reason === 'parent_deadline' ? 'timed_out' : 'execution_error';
        const work = input.request.identity;
        if (work.purpose !== 'work') throw new TypeError('Expected Work execution');
        await input.options.retain({ identity: { projectId: input.request.projectId, attemptId: work.attemptId,
          owner: input.request.owner.principalId, hostInstanceId: input.request.owner.hostInstanceId,
          executionVersion: input.request.executionVersion }, runId: work.runId, taskId: work.taskId,
          featureId: input.request.featureId, reason: retentionReason, evidenceRef });
        retained = true;
      }
      return { stopConfirmed: confirmed, persisted: true, retained, error: cleanupConfirmed ? null : 'cleanup_unconfirmed',
        recordingFlushed: recordingFlushed || persisted,
        exitCode: observedExit, signal: observedSignal, forced: observedForced };
    } catch {
      input.quarantine();
      return { stopConfirmed: confirmed, persisted, retained: false, error: 'execution_finalization_failed',
        recordingFlushed: false,
        exitCode: null, signal: null, forced: null };
    } finally { finished = true; clearTimeout(timer); }
  })();
  return { stop, completion };
}
