import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as backoff } from 'node:timers/promises';
import { stableStringify } from '../ports/feature-plan.js';
import { validateRuntimeStrategy } from '../ports/settings-schema.js';
import { RUNTIME_FAILURE_CATEGORIES } from '../ports/runtime-failure.js';
import type { RuntimeFailureCategory } from '../ports/runtime-failure.js';
import type {
  RuntimeInferenceAudit, RuntimeInferenceDecision, RuntimeInferencePreflightDependencies,
  RuntimeInferencePreflightPolicy, RuntimeInferenceReason, RuntimeInferenceSelection, RuntimeInferenceUsage,
} from '../ports/runtime-inference-preflight.js';

export const DEFAULT_RUNTIME_INFERENCE_PREFLIGHT_POLICY: RuntimeInferencePreflightPolicy = Object.freeze({
  enabled: false, timeoutMs: 5_000, maxRequests: 1, backoffMs: 100, successTtlMs: 30_000,
});
export function resolveRuntimeInferencePreflightPolicy(value?: unknown): RuntimeInferencePreflightPolicy {
  if (value === undefined) return DEFAULT_RUNTIME_INFERENCE_PREFLIGHT_POLICY;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_inference_preflight_policy');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_RUNTIME_INFERENCE_PREFLIGHT_POLICY, key))
    || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) throw new TypeError('invalid_inference_preflight_policy');
  const result = { ...DEFAULT_RUNTIME_INFERENCE_PREFLIGHT_POLICY, ...raw, enabled: raw.enabled ?? false } as RuntimeInferencePreflightPolicy;
  for (const [key, minimum, maximum] of [
    ['timeoutMs', 1, 60_000], ['maxRequests', 1, 3], ['backoffMs', 0, 5_000], ['successTtlMs', 0, 300_000],
  ] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new TypeError('invalid_inference_preflight_policy');
  }
  return Object.freeze(result);
}

/** Canonical allowlist copy: unknown fields, secrets and provider output never reach the journal. */
export function validateRuntimeInferenceSelection(value: RuntimeInferenceSelection): RuntimeInferenceSelection {
  const strategy = validateRuntimeStrategy(value.strategy, { operation: 'RuntimeInference.select' }, 'strategy');
  for (const entry of [strategy.runtime, strategy.provider, strategy.model, strategy.credentialRef, strategy.endpointRef, value.authenticationRef]) {
    if (entry !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(entry)
      || /^(?:sk-|gh[pousr]_|eyJ|Bearer)/i.test(entry))) throw new TypeError('invalid_inference_reference');
  }
  if (typeof value.authenticationRef !== 'string' || !value.authenticationRef
    || !/^[a-f0-9]{64}$/.test(value.environmentDigest) || !/^[a-f0-9]{64}$/.test(value.resourceDigest)) {
    throw new TypeError('invalid_inference_selection');
  }
  return Object.freeze({ strategy: Object.freeze(strategy), authenticationRef: value.authenticationRef,
    environmentDigest: value.environmentDigest, resourceDigest: value.resourceDigest });
}
export function runtimeInferenceSelectionKey(value: RuntimeInferenceSelection): string {
  return createHash('sha256').update(`shiploop:inference-preflight:v1\n${stableStringify(validateRuntimeInferenceSelection(value))}`).digest('hex');
}
const unknownUsage: RuntimeInferenceUsage = Object.freeze({ inputTokens: null, outputTokens: null, costUsdMicros: null });
function usage(value: unknown): RuntimeInferenceUsage {
  const raw = value as Partial<RuntimeInferenceUsage> | null;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  return { inputTokens: count(raw?.inputTokens), outputTokens: count(raw?.outputTokens), costUsdMicros: count(raw?.costUsdMicros) };
}

function mergeUsage(value: unknown, previous: RuntimeInferenceUsage): RuntimeInferenceUsage {
  const current = usage(value);
  return { inputTokens: current.inputTokens ?? previous.inputTokens, outputTokens: current.outputTokens ?? previous.outputTokens,
    costUsdMicros: current.costUsdMicros ?? previous.costUsdMicros };
}

/** One startup scope per service. Only successes live in memory; no cross-startup health claims. */
export function createRuntimeInferencePreflight(deps: RuntimeInferencePreflightDependencies) {
  const policy = resolveRuntimeInferencePreflightPolicy(deps.policy);
  const now = deps.nowUtcMs ?? Date.now;
  const monotonic = deps.monotonicNow ?? (() => performance.now());
  const cache = new Map<string, number>();
  let busy = false;
  return {
    policy,
    async check(value: RuntimeInferenceSelection, signal?: AbortSignal): Promise<RuntimeInferenceDecision> {
      if (!policy.enabled) return { outcome: 'disabled', dispatchAllowed: true, reason: null };
      if (busy) throw new Error('inference_preflight_busy');
      busy = true;
      const started = monotonic(), startedAtUtcMs = now(), probeId = randomUUID();
      const controller = new AbortController();
      let timeout = false;
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(() => { timeout = true; controller.abort(); }, policy.timeoutMs);
      let rejectAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new Error('inference_preflight_aborted'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      aborted.catch(() => undefined);
      const assertBudget = () => {
        controller.signal.throwIfAborted();
        if (monotonic() - started >= policy.timeoutMs) { timeout = true; controller.abort(); controller.signal.throwIfAborted(); }
      };
      const bounded = async <T>(fn: () => Promise<T>): Promise<T> => {
        assertBudget();
        const result = await Promise.race([Promise.resolve().then(fn), aborted]);
        assertBudget();
        return result;
      };
      try {
        const selection = validateRuntimeInferenceSelection(value), cacheKey = runtimeInferenceSelectionKey(selection);
        let requestNumber = 0;
        const record = async (phase: RuntimeInferenceAudit['phase'], outcome: RuntimeInferenceAudit['outcome'],
          reason: RuntimeInferenceReason | null, category: RuntimeFailureCategory | null, consumed = unknownUsage) => {
          // Audit writes are awaited independently of an already expired model-request deadline.
          await deps.audit(Object.freeze({ probeId, requestNumber, phase, selection, cacheKey, policy, outcome, category, reason,
            usage: Object.freeze(consumed), startedAtUtcMs, finishedAtUtcMs: phase === 'started' ? null : now(),
            elapsedMs: phase === 'started' ? null : Math.max(0, monotonic() - started), accounting: 'inference_preflight' }));
        };
        let reason: RuntimeInferenceReason = 'probe_failed';
        let category: RuntimeFailureCategory = 'unknown';
        let consumed = unknownUsage;
        try {
          if (!deps.adapter || deps.adapter.isolation !== 'inference_only') {
            reason = 'isolation_unavailable'; category = 'configuration';
          } else {
            if (!await bounded(() => deps.authorize(selection, controller.signal))) {
              reason = 'authorization_denied'; category = 'authentication';
            } else {
              const validUntil = cache.get(cacheKey) ?? -Infinity;
              if (validUntil > monotonic()) {
                await record('finished', 'cached', 'cached_success', null);
                assertBudget();
                if (validUntil > monotonic()) return { outcome: 'cached', dispatchAllowed: true, reason: 'cached_success' };
              }
              cache.delete(cacheKey);
              for (requestNumber = 1; requestNumber <= policy.maxRequests; requestNumber++) {
                consumed = unknownUsage;
                await record('started', 'started', null, null);
                const result = await bounded(() => deps.adapter!.probe({ ...selection, signal: controller.signal,
                  prompt: 'Reply with OK.', maxOutputTokens: 32, maxRetries: 0,
                  observeUsage: value => { if (!controller.signal.aborted) consumed = mergeUsage(value, consumed); } }));
                consumed = mergeUsage(result?.usage, consumed);
                if (result?.terminal === 'completed' && typeof result.response === 'string' && result.response.trim()
                  && Buffer.byteLength(result.response) <= 4096) {
                  // Recheck current authorization after transport and before granting admission/cache.
                  if (!await bounded(() => deps.authorize(selection, controller.signal))) {
                    reason = 'authorization_denied'; category = 'authentication';
                  } else {
                    const validUntil = monotonic() + policy.successTtlMs;
                    await record('finished', 'passed', 'complete_response', null, consumed);
                    consumed = unknownUsage;
                    assertBudget();
                    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
                    if (validUntil > monotonic()) cache.set(cacheKey, validUntil);
                    return { outcome: 'passed', dispatchAllowed: true, reason: 'complete_response' };
                  }
                } else {
                  reason = result?.terminal === 'completed'
                    ? (typeof result.response === 'string' && Buffer.byteLength(result.response) > 4096 ? 'output_limit' : 'empty_response')
                    : 'invalid_terminal';
                  category = result?.terminal === 'failed' && RUNTIME_FAILURE_CATEGORIES.includes(result.category!) ? result.category! : 'protocol';
                }
                await record('finished', 'failed', reason, category, consumed);
                consumed = unknownUsage;
                if (requestNumber === policy.maxRequests || !['transient_connection', 'transient_server'].includes(category)) {
                  return { outcome: 'failed', dispatchAllowed: false, reason };
                }
                await bounded(() => backoff(policy.backoffMs, undefined, { signal: controller.signal }));
                if (!await bounded(() => deps.authorize(selection, controller.signal))) {
                  reason = 'authorization_denied'; category = 'authentication'; break;
                }
              }
            }
          }
        } catch {
          reason = controller.signal.aborted ? (timeout ? 'timeout' : 'cancelled') : 'probe_failed';
          category = controller.signal.aborted ? (timeout ? 'timeout' : 'cancelled') : 'unknown';
        }
        cache.delete(cacheKey);
        await record('finished', 'failed', reason, category, consumed);
        return { outcome: 'failed', dispatchAllowed: false, reason };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', rejectAbort);
        controller.abort();
        busy = false;
      }
    },
  };
}
