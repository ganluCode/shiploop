/**
 * P04-3 / F-002: bounded same-Attempt retry contract.
 *
 * This module is deliberately pure at the decision boundary. It does not create an
 * Attempt, alter Task state, spend a code-attempt budget, or call an SDK. The
 * adapter may report SDK retries through the same counters so Core can enforce one
 * outer retry budget across both layers.
 */
import type { RuntimeFailureCategory } from './runtime-failure.js';

export type RuntimeRetrySideEffect = 'none' | 'known_safe' | 'uncertain';

export interface RuntimeRetryFailure {
  readonly category: RuntimeFailureCategory;
  /** Omitted means safe only for pre-request connection/server failures. */
  readonly sideEffect?: RuntimeRetrySideEffect;
  /** A response header alone is evidence, but does not reset the streak. */
  readonly responseHeadersReceived?: boolean;
  /** Any model/tool delta means the request may have had an observable effect. */
  readonly deltaReceived?: boolean;
  readonly partialResult?: boolean;
  /** Informational rate-limit warnings are evidence and never reset a streak. */
  readonly rateLimitNotice?: boolean;
  readonly durationMs?: number;
}

export interface RuntimeRetryCounters {
  /** Runtime/Runner starts; a same-Attempt retry never increments this. */
  readonly runtimeStarts: number;
  /** Individual request attempts, including SDK and Core retries. */
  readonly requestCount: number;
  /** All retries, regardless of whether SDK or Core initiated them. */
  readonly retryCount: number;
  /** Subset of retryCount initiated inside the SDK/adapter. */
  readonly sdkRetryCount: number;
  readonly consecutiveFailures: number;
  readonly peakConsecutiveFailures: number;
  /** Task-scoped cumulative failures; a valid complete success never clears it. */
  readonly cumulativeFailures: number;
  readonly failureElapsedMs: number;
  readonly backoffElapsedMs: number;
}

export interface RuntimeRetryPolicy {
  /** Core-approved maximum number of Core retries for this Attempt. */
  readonly maxRetries: number;
  /** One outer ceiling shared by SDK and Core retries. */
  readonly maxTotalRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export type RuntimeRetryStopReason =
  | 'non_retryable_category'
  | 'side_effect_uncertain'
  | 'runner_not_alive'
  | 'retry_limit_exhausted'
  | 'shared_retry_budget_exhausted'
  | 'deadline_reached'
  | 'cancelled';

export interface RuntimeRetryDecision {
  readonly action: 'retry' | 'stop';
  readonly stopReason: RuntimeRetryStopReason | null;
  readonly triggerCategory: RuntimeFailureCategory;
  /** Failure round within this Attempt, including a decision that stops. */
  readonly currentRound: number;
  /** Core retry ordinal; null when the decision stops before a retry. */
  readonly retryRound: number | null;
  readonly backoffMs: number;
  readonly deadlineUtcMs: number;
  readonly counters: RuntimeRetryCounters;
}

export interface DecideSameAttemptRetryInput {
  readonly failure: RuntimeRetryFailure;
  readonly counters: RuntimeRetryCounters;
  readonly policy: RuntimeRetryPolicy;
  readonly nowUtcMs: number;
  /** Absolute UTC deadline; it is never moved by a retry. */
  readonly deadlineUtcMs: number;
  readonly runnerAlive: boolean;
  readonly cancelled?: boolean;
}

const SAFE_CATEGORIES = new Set<RuntimeFailureCategory>([
  'transient_connection',
  'transient_server',
  'timeout',
  'tool_failure',
]);

function boundedDuration(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function backoffFor(retryRound: number, policy: RuntimeRetryPolicy): number {
  // The policy is validated by the configuration boundary. Clamping here keeps a
  // malformed adapter input from turning the decision into an unbounded wait.
  const base = Math.max(0, Math.min(policy.baseBackoffMs, 86_400_000));
  const cap = Math.max(0, Math.min(policy.maxBackoffMs, 86_400_000));
  if (base === 0 || cap === 0) return 0;
  return Math.min(cap, base * 2 ** Math.max(0, retryRound - 1));
}

function failureCounters(input: DecideSameAttemptRetryInput): RuntimeRetryCounters {
  const nextConsecutive = input.counters.consecutiveFailures + 1;
  return {
    ...input.counters,
    consecutiveFailures: nextConsecutive,
    peakConsecutiveFailures: Math.max(input.counters.peakConsecutiveFailures, nextConsecutive),
    cumulativeFailures: input.counters.cumulativeFailures + 1,
    failureElapsedMs: input.counters.failureElapsedMs + boundedDuration(input.failure.durationMs),
  };
}

function decision(
  input: DecideSameAttemptRetryInput,
  counters: RuntimeRetryCounters,
  action: 'retry' | 'stop',
  stopReason: RuntimeRetryStopReason | null,
  retryRound: number | null,
  backoffMs: number,
): RuntimeRetryDecision {
  return {
    action,
    stopReason,
    triggerCategory: input.failure.category,
    currentRound: counters.consecutiveFailures,
    retryRound,
    backoffMs,
    deadlineUtcMs: input.deadlineUtcMs,
    counters,
  };
}

/** Decide one bounded retry without mutating the supplied counters. */
export function decideSameAttemptRetry(input: DecideSameAttemptRetryInput): RuntimeRetryDecision {
  const counters = failureCounters(input);
  const failure = input.failure;
  const safeSideEffect = failure.sideEffect === undefined
    ? (failure.category === 'transient_connection' || failure.category === 'transient_server'
      ? 'none' : 'uncertain')
    : failure.sideEffect;

  if (input.cancelled === true || failure.category === 'cancelled') {
    return decision(input, counters, 'stop', 'cancelled', null, 0);
  }
  if (failure.deltaReceived === true || failure.partialResult === true) {
    return decision(input, counters, 'stop', 'side_effect_uncertain', null, 0);
  }
  if (!SAFE_CATEGORIES.has(failure.category)) {
    return decision(input, counters, 'stop',
      failure.category === 'tool_failure' && safeSideEffect === 'uncertain'
        ? 'side_effect_uncertain' : 'non_retryable_category', null, 0);
  }
  if (safeSideEffect === 'uncertain') {
    return decision(input, counters, 'stop', 'side_effect_uncertain', null, 0);
  }
  if (!input.runnerAlive) {
    return decision(input, counters, 'stop', 'runner_not_alive', null, 0);
  }

  const coreRetries = Math.max(0, counters.retryCount - counters.sdkRetryCount);
  const nextCoreRetry = coreRetries + 1;
  const totalObservedRetries = Math.max(counters.retryCount, counters.sdkRetryCount);
  if (nextCoreRetry > input.policy.maxRetries) {
    return decision(input, counters, 'stop', 'retry_limit_exhausted', null, 0);
  }
  if (totalObservedRetries >= input.policy.maxTotalRetries) {
    return decision(input, counters, 'stop', 'shared_retry_budget_exhausted', null, 0);
  }
  if (input.nowUtcMs >= input.deadlineUtcMs) {
    return decision(input, counters, 'stop', 'deadline_reached', null, 0);
  }

  const backoffMs = backoffFor(nextCoreRetry, input.policy);
  // A retry must be able to begin before the persisted absolute deadline. The
  // wait itself is charged to the same Session/Run/Batch time by the caller.
  if (input.nowUtcMs + backoffMs >= input.deadlineUtcMs) {
    return decision(input, counters, 'stop', 'deadline_reached', null, backoffMs);
  }

  return decision(input, {
    ...counters,
    retryCount: counters.retryCount + 1,
  }, 'retry', null, nextCoreRetry, backoffMs);
}

export type RuntimeRequestRetryKind = 'initial' | 'core_retry' | 'sdk_retry';

/** Record a request metric. It intentionally leaves runtimeStarts unchanged. */
export function recordRuntimeRequest(
  counters: RuntimeRetryCounters,
  kind: RuntimeRequestRetryKind,
): RuntimeRetryCounters {
  if (kind === 'initial') return { ...counters, requestCount: counters.requestCount + 1 };
  return {
    ...counters,
    requestCount: counters.requestCount + 1,
    retryCount: counters.retryCount + 1,
    sdkRetryCount: kind === 'sdk_retry' ? counters.sdkRetryCount + 1 : counters.sdkRetryCount,
  };
}

export interface RuntimeRetrySuccess {
  readonly complete: boolean;
  readonly valid: boolean;
  readonly responseHeadersReceived?: boolean;
  readonly deltaReceived?: boolean;
  readonly rateLimitNotice?: boolean;
  readonly partialResult?: boolean;
}

/** Reset only the consecutive streak after a complete, valid, effect-free result. */
export function recordRuntimeSuccess(
  counters: RuntimeRetryCounters,
  result: RuntimeRetrySuccess,
): RuntimeRetryCounters {
  const canReset = result.complete && result.valid
    && result.responseHeadersReceived !== true
    && result.deltaReceived !== true
    && result.partialResult !== true
    && result.rateLimitNotice !== true;
  return canReset ? { ...counters, consecutiveFailures: 0 } : { ...counters };
}

export function recordRuntimeBackoff(
  counters: RuntimeRetryCounters,
  elapsedMs: number,
): RuntimeRetryCounters {
  const elapsed = Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
  return { ...counters, backoffElapsedMs: counters.backoffElapsedMs + elapsed };
}

export interface RuntimeRetryBackoffWaitInput {
  readonly delayMs: number;
  readonly nowUtcMs: () => number;
  readonly deadlineUtcMs: number;
  readonly signal?: AbortSignal;
  /** A real or virtual cancellable wait supplied by the host. */
  readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface RuntimeRetryBackoffWaitResult {
  readonly status: 'completed' | 'cancelled' | 'deadline_reached';
  readonly elapsedMs: number;
}

/** Wait once, with an absolute deadline and cancellation; no unbounded polling loop. */
export async function waitForRuntimeRetryBackoff(
  input: RuntimeRetryBackoffWaitInput,
): Promise<RuntimeRetryBackoffWaitResult> {
  const start = input.nowUtcMs();
  if (input.signal?.aborted === true) return { status: 'cancelled', elapsedMs: 0 };
  if (start >= input.deadlineUtcMs) return { status: 'deadline_reached', elapsedMs: 0 };
  const delay = Math.max(0, Math.min(input.delayMs, input.deadlineUtcMs - start));
  try {
    await input.wait(delay, input.signal);
  } catch (error) {
    if (input.signal?.aborted) {
      const elapsedOnCancel = Math.max(0, Math.min(input.deadlineUtcMs - start, input.nowUtcMs() - start));
      return { status: 'cancelled', elapsedMs: elapsedOnCancel };
    }
    throw error;
  }
  const elapsed = Math.max(0, Math.min(input.deadlineUtcMs - start, input.nowUtcMs() - start));
  if (input.signal?.aborted) return { status: 'cancelled', elapsedMs: elapsed };
  if (input.nowUtcMs() >= input.deadlineUtcMs || delay >= input.deadlineUtcMs - start) {
    return { status: 'deadline_reached', elapsedMs: elapsed };
  }
  return { status: 'completed', elapsedMs: elapsed };
}

/** Explicit alias used by orchestration code that calls this a retry planner. */
export const planSameAttemptRetry = decideSameAttemptRetry;
