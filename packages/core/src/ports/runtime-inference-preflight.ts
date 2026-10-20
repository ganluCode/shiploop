/** Separate admission contract: no Attempt identity, cwd, input reader or business storage. */
import type { RuntimeStrategyV1 } from './settings-schema.js';
import type { RuntimeFailureCategory } from './runtime-failure.js';

export interface RuntimeInferencePreflightPolicy {
  readonly enabled: boolean;
  /** Total wall time including authorization, transport and backoff. */
  readonly timeoutMs: number;
  readonly maxRequests: number;
  readonly backoffMs: number;
  readonly successTtlMs: number;
}
export interface RuntimeInferenceSelection {
  readonly strategy: RuntimeStrategyV1;
  /** Opaque registered source (including the selected auth plugin when required). */
  readonly authenticationRef: string;
  readonly environmentDigest: string;
  readonly resourceDigest: string;
}
export interface RuntimeInferenceUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
}
export interface RuntimeInferenceProbeRequest extends RuntimeInferenceSelection {
  readonly signal: AbortSignal;
  readonly prompt: 'Reply with OK.';
  readonly maxOutputTokens: 32;
  readonly maxRetries: 0;
  /** Cumulative request usage, including partial response facts before timeout/cancel. */
  readonly observeUsage: (usage: RuntimeInferenceUsage) => void;
}
export interface RuntimeInferenceProbeResult {
  readonly terminal: 'completed' | 'failed';
  readonly response: string;
  readonly category?: RuntimeFailureCategory;
  readonly usage: RuntimeInferenceUsage;
}
export interface RuntimeInferenceAdapter {
  /** Enforced by the adapter, never a prompt instruction or trusted-project claim. */
  readonly isolation: 'inference_only';
  probe(request: RuntimeInferenceProbeRequest): Promise<RuntimeInferenceProbeResult>;
}
export type RuntimeInferenceReason = 'complete_response' | 'invalid_terminal' | 'empty_response' | 'output_limit'
  | 'isolation_unavailable' | 'authorization_denied' | 'probe_failed' | 'timeout' | 'cancelled' | 'cached_success';
export interface RuntimeInferenceAudit {
  readonly probeId: string;
  readonly requestNumber: number;
  readonly phase: 'started' | 'finished';
  readonly selection: RuntimeInferenceSelection;
  readonly cacheKey: string;
  readonly policy: RuntimeInferencePreflightPolicy;
  readonly outcome: 'started' | 'passed' | 'failed' | 'cached';
  readonly category: RuntimeFailureCategory | null;
  readonly reason: RuntimeInferenceReason | null;
  readonly usage: RuntimeInferenceUsage;
  readonly startedAtUtcMs: number;
  readonly finishedAtUtcMs: number | null;
  readonly elapsedMs: number | null;
  readonly accounting: 'inference_preflight';
}
export interface RuntimeInferenceDecision {
  readonly outcome: 'disabled' | 'passed' | 'failed' | 'cached';
  readonly dispatchAllowed: boolean;
  readonly reason: RuntimeInferenceReason | null;
}
export interface RuntimeInferencePreflightDependencies {
  readonly policy?: unknown;
  readonly adapter?: RuntimeInferenceAdapter;
  /** Checks explicit probe authorization, source/policy binding and revocation on every check/cache hit. */
  authorize(selection: RuntimeInferenceSelection, signal: AbortSignal): Promise<boolean>;
  /** Durable Core audit; a failed write rejects admission. Never Task usage settlement. */
  audit(record: RuntimeInferenceAudit): Promise<void>;
  readonly nowUtcMs?: () => number;
  readonly monotonicNow?: () => number;
}
/** Returned only by trusted Runtime assembly. No settings-driven executable discovery. */
export interface WorkInferencePreflightAssembly extends Omit<RuntimeInferencePreflightDependencies, 'audit'> {
  select(context: { readonly projectId: string; readonly runId: string; readonly taskId: string;
    readonly strategy: RuntimeStrategyV1 }): RuntimeInferenceSelection;
}
