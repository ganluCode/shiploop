/** Core owns the bounded request loop; the live Runner supplies I/O and observations. */
import { RuntimeError } from '../ports/runtime-execution.js';
import {
  decideSameAttemptRetry, recordRuntimeBackoff, recordRuntimeRequest, recordRuntimeSuccess,
  waitForRuntimeRetryBackoff,
  type RuntimeRetryCounters, type RuntimeRetryDecision, type RuntimeRetryFailure, type RuntimeRetryPolicy,
} from '../ports/runtime-retry.js';

/** One outer budget for a Work Attempt. SDK automatic retries must be disabled. */
export const DEFAULT_RUNTIME_REQUEST_RETRY_POLICY: RuntimeRetryPolicy = Object.freeze({
  maxRetries: 2, maxTotalRetries: 2, baseBackoffMs: 250, maxBackoffMs: 2_000,
});
export interface RuntimeRequestRetryObservation {
  readonly kind: 'request' | 'failure' | 'backoff' | 'success' | 'stop';
  readonly counters: RuntimeRetryCounters;
  readonly decision?: RuntimeRetryDecision;
  readonly stopReason?: string;
}
export interface RuntimeRequestOutcome<T> {
  readonly value: T;
  /** Absence means a complete, valid request, never just headers or a delta. */
  readonly failure?: RuntimeRetryFailure;
}
export interface RuntimeRequestRetryController {
  execute<T>(request: () => Promise<RuntimeRequestOutcome<T>>): Promise<T>;
  counters(): RuntimeRetryCounters;
}
export interface RuntimeRequestRetryDeps {
  readonly policy: RuntimeRetryPolicy;
  readonly deadlineUtcMs: number;
  readonly nowUtcMs: () => number;
  readonly runnerAlive: () => boolean;
  readonly signal?: AbortSignal;
  readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly observe?: (event: RuntimeRequestRetryObservation) => void;
}

export function createRuntimeRequestRetryController(deps: RuntimeRequestRetryDeps): RuntimeRequestRetryController {
  for (const key of ['maxRetries', 'maxTotalRetries', 'baseBackoffMs', 'maxBackoffMs'] as const) {
    const limit = deps.policy[key];
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > (key.endsWith('Ms') ? 86_400_000 : 100)) {
      throw new RuntimeError('configuration', 'invalid_request_retry_policy');
    }
  }
  if (!Number.isSafeInteger(deps.deadlineUtcMs)) throw new RuntimeError('configuration', 'invalid_request_deadline');
  let counters: RuntimeRetryCounters = { runtimeStarts: 1, requestCount: 0, retryCount: 0, sdkRetryCount: 0,
    consecutiveFailures: 0, peakConsecutiveFailures: 0, cumulativeFailures: 0, failureElapsedMs: 0, backoffElapsedMs: 0 };
  let active = false;
  const observe = (kind: RuntimeRequestRetryObservation['kind'], extra: Omit<RuntimeRequestRetryObservation, 'kind' | 'counters'> = {}) =>
    deps.observe?.({ kind, counters: { ...counters }, ...extra });
  return {
    counters: () => ({ ...counters }),
    async execute<T>(request: () => Promise<RuntimeRequestOutcome<T>>): Promise<T> {
      if (active) throw new RuntimeError('protocol', 'overlapping_runtime_requests');
      active = true;
      try {
        let previous: RuntimeRequestOutcome<T> | undefined;
        for (;;) {
          // Cancellation/deadline can change after the planner or an awaited wait.
          const stopReason = deps.signal?.aborted ? 'cancelled'
            : !deps.runnerAlive() ? 'runner_not_alive'
            : deps.nowUtcMs() >= deps.deadlineUtcMs ? 'deadline_reached' : null;
          if (stopReason !== null) {
            observe('stop', { stopReason });
            if (previous !== undefined) return previous.value;
            throw new RuntimeError(stopReason === 'deadline_reached' ? 'timeout' : 'process', stopReason);
          }
          // The planner already reserves retryCount; count the actual request once.
          counters = recordRuntimeRequest(counters, 'initial');
          observe('request');
          const outcome = await request();
          if (outcome.failure === undefined) {
            counters = recordRuntimeSuccess(counters, { complete: true, valid: true });
            observe('success');
            return outcome.value;
          }
          previous = outcome;
          const decision = decideSameAttemptRetry({ failure: outcome.failure, counters, policy: deps.policy,
            nowUtcMs: deps.nowUtcMs(), deadlineUtcMs: deps.deadlineUtcMs,
            runnerAlive: deps.runnerAlive(), cancelled: deps.signal?.aborted });
          counters = decision.counters;
          observe('failure', { decision });
          if (decision.action === 'stop') {
            observe('stop', { decision, stopReason: decision.stopReason ?? undefined });
            return outcome.value;
          }
          const waited = await waitForRuntimeRetryBackoff({ delayMs: decision.backoffMs,
            nowUtcMs: deps.nowUtcMs, deadlineUtcMs: deps.deadlineUtcMs, signal: deps.signal, wait: deps.wait });
          counters = recordRuntimeBackoff(counters, waited.elapsedMs);
          observe('backoff', { decision });
          if (waited.status !== 'completed') {
            observe('stop', { stopReason: waited.status });
            return outcome.value;
          }
        }
      } finally { active = false; }
    },
  };
}
