import { describe, expect, it } from 'vitest';
import {
  decideSameAttemptRetry,
  recordRuntimeRequest,
  recordRuntimeSuccess,
  recordRuntimeBackoff,
  waitForRuntimeRetryBackoff,
  type RuntimeRetryCounters,
} from '../../../packages/core/src/index.js';

const counters = (overrides: Partial<RuntimeRetryCounters> = {}): RuntimeRetryCounters => ({
  runtimeStarts: 1,
  requestCount: 1,
  retryCount: 0,
  sdkRetryCount: 0,
  consecutiveFailures: 0,
  peakConsecutiveFailures: 0,
  cumulativeFailures: 0,
  failureElapsedMs: 0,
  backoffElapsedMs: 0,
  ...overrides,
});

describe('P04-3 F-002 same Attempt retry decisioner', () => {
  it('[case:F002-RETRY-TRANSIENT] retries safe transient failures with an auditable bounded decision', () => {
    const result = decideSameAttemptRetry({
      failure: { category: 'transient_connection', sideEffect: 'none', durationMs: 17 },
      counters: counters(),
      policy: { maxRetries: 2, maxTotalRetries: 3, baseBackoffMs: 100, maxBackoffMs: 1_000 },
      nowUtcMs: 1_000,
      deadlineUtcMs: 2_000,
      runnerAlive: true,
    });

    expect(result.action).toBe('retry');
    expect(result.stopReason).toBeNull();
    expect(result.triggerCategory).toBe('transient_connection');
    expect(result.retryRound).toBe(1);
    expect(result.backoffMs).toBe(100);
    expect(result.counters.consecutiveFailures).toBe(1);
    expect(result.counters.peakConsecutiveFailures).toBe(1);
    expect(result.counters.cumulativeFailures).toBe(1);
    expect(result.counters.failureElapsedMs).toBe(17);
    expect(result.counters.retryCount).toBe(1);
  });

  it('[case:F002-STOP-CLASSIFICATION] stops unsafe categories and uncertain tool side effects', () => {
    for (const category of ['authentication', 'configuration', 'protocol', 'unknown', 'cancelled'] as const) {
      const result = decideSameAttemptRetry({
        failure: { category }, counters: counters(),
        policy: { maxRetries: 5, maxTotalRetries: 5, baseBackoffMs: 1, maxBackoffMs: 10 },
        nowUtcMs: 10, deadlineUtcMs: 1_000, runnerAlive: true,
      });
      expect(result.action).toBe('stop');
      expect(result.stopReason).toBe(category === 'cancelled' ? 'cancelled' : 'non_retryable_category');
    }

    const toolResult = decideSameAttemptRetry({
      failure: { category: 'tool_failure', sideEffect: 'uncertain' }, counters: counters(),
      policy: { maxRetries: 5, maxTotalRetries: 5, baseBackoffMs: 1, maxBackoffMs: 10 },
      nowUtcMs: 10, deadlineUtcMs: 1_000, runnerAlive: true,
    });
    expect(toolResult.action).toBe('stop');
    expect(toolResult.stopReason).toBe('side_effect_uncertain');
  });

  it('[case:F002-STOP-PARTIAL] stops after any delta or partial result and retains evidence counters', () => {
    const result = decideSameAttemptRetry({
      failure: {
        category: 'transient_server', sideEffect: 'none',
        responseHeadersReceived: true, deltaReceived: true, partialResult: true,
        durationMs: 25,
      },
      counters: counters({ cumulativeFailures: 3, backoffElapsedMs: 40 }),
      policy: { maxRetries: 2, maxTotalRetries: 4, baseBackoffMs: 100, maxBackoffMs: 1_000 },
      nowUtcMs: 100, deadlineUtcMs: 1_000, runnerAlive: true,
    });
    expect(result.action).toBe('stop');
    expect(result.stopReason).toBe('side_effect_uncertain');
    expect(result.counters.cumulativeFailures).toBe(4);
    expect(result.counters.failureElapsedMs).toBe(25);
    expect(result.counters.backoffElapsedMs).toBe(40);
  });

  it('[case:F002-STOP-BOUNDS] shares the outer retry budget and honors absolute deadline', () => {
    const sdkExhausted = decideSameAttemptRetry({
      failure: { category: 'transient_connection', sideEffect: 'none' },
      counters: counters({ sdkRetryCount: 2 }),
      policy: { maxRetries: 5, maxTotalRetries: 2, baseBackoffMs: 10, maxBackoffMs: 100 },
      nowUtcMs: 100, deadlineUtcMs: 1_000, runnerAlive: true,
    });
    expect(sdkExhausted.action).toBe('stop');
    expect(sdkExhausted.stopReason).toBe('shared_retry_budget_exhausted');

    const deadline = decideSameAttemptRetry({
      failure: { category: 'transient_connection', sideEffect: 'none' }, counters: counters(),
      policy: { maxRetries: 5, maxTotalRetries: 5, baseBackoffMs: 100, maxBackoffMs: 100 },
      nowUtcMs: 950, deadlineUtcMs: 1_000, runnerAlive: true,
    });
    expect(deadline.action).toBe('stop');
    expect(deadline.stopReason).toBe('deadline_reached');
  });

  it('[case:F002-COUNTERS-SUCCESS] only a complete valid success resets consecutive failures', () => {
    const failed = counters({ consecutiveFailures: 2, peakConsecutiveFailures: 3, cumulativeFailures: 4 });
    expect(recordRuntimeSuccess(failed, { complete: false, valid: true, deltaReceived: true }).consecutiveFailures).toBe(2);
    expect(recordRuntimeSuccess(failed, { complete: true, valid: true, responseHeadersReceived: true }).consecutiveFailures).toBe(2);
    expect(recordRuntimeSuccess(failed, { complete: true, valid: true, rateLimitNotice: true }).consecutiveFailures).toBe(2);
    expect(recordRuntimeSuccess(failed, { complete: true, valid: false }).consecutiveFailures).toBe(2);
    const success = recordRuntimeSuccess(failed, { complete: true, valid: true });
    expect(success.consecutiveFailures).toBe(0);
    expect(success.peakConsecutiveFailures).toBe(3);
    expect(success.cumulativeFailures).toBe(4);
    expect(success.failureElapsedMs).toBe(failed.failureElapsedMs);
    expect(success.backoffElapsedMs).toBe(failed.backoffElapsedMs);
    expect(recordRuntimeBackoff(success, 13).backoffElapsedMs).toBe(failed.backoffElapsedMs + 13);
  });

  it('[case:F002-COUNTERS-METRICS] separates starts, requests, and retries', () => {
    const afterRequest = recordRuntimeRequest(counters(), 'core_retry');
    expect(afterRequest.runtimeStarts).toBe(1);
    expect(afterRequest.requestCount).toBe(2);
    expect(afterRequest.retryCount).toBe(1);
    expect(afterRequest.sdkRetryCount).toBe(0);

    const afterSdk = recordRuntimeRequest(afterRequest, 'sdk_retry');
    expect(afterSdk.runtimeStarts).toBe(1);
    expect(afterSdk.requestCount).toBe(3);
    expect(afterSdk.retryCount).toBe(2);
    expect(afterSdk.sdkRetryCount).toBe(1);
  });

  it('[case:F002-WAIT-CANCEL] uses an injected clock and stops a cancellable wait at cancellation', async () => {
    let now = 100;
    const waits: number[] = [];
    const controller = new AbortController();
    const result = await waitForRuntimeRetryBackoff({
      delayMs: 100, nowUtcMs: () => now, deadlineUtcMs: 500, signal: controller.signal,
      wait: async (ms) => { waits.push(ms); now += ms; controller.abort(); },
    });
    expect(result.status).toBe('cancelled');
    expect(result.elapsedMs).toBe(100);
    expect(waits).toEqual([100]);
  });
});
