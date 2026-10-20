import { RUNTIME_FAILURE_CATEGORIES, type RuntimeFailureCategory } from './runtime-failure.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import type { PreparedExecutionInputGroup } from './execution-input-prepare.js';
import type { TaskClaimReceipt } from './task-claim.js';
import { rejectUnknownKeys, requireNonEmptyString, requirePlainObject, validateSha256Digest, validateStableId, validationError } from './validation.js';

export const RUNTIME_FALLBACK_ATTEMPT_SCHEMA_VERSION = 1 as const;

export interface RuntimeFallbackAttemptFailure {
  readonly category: RuntimeFailureCategory;
  readonly reason: string;
}

export interface RuntimeFallbackCapabilityEvidence {
  readonly catalogDigest: string;
  readonly registryDigest: string;
  readonly authorizationDigest: string;
}

/** Immutable, managed evidence copied into the replacement Attempt input snapshot. */
export interface RuntimeFallbackAttemptMetadata {
  readonly schemaVersion: typeof RUNTIME_FALLBACK_ATTEMPT_SCHEMA_VERSION;
  readonly switchKey: string;
  readonly strategySource: string;
  readonly strategy: RuntimeStrategyV1;
  readonly triggerCategory: RuntimeFailureCategory;
  readonly previousFailures: readonly RuntimeFallbackAttemptFailure[];
  readonly policyVersion: string;
  readonly capabilityEvidence: RuntimeFallbackCapabilityEvidence;
}

export function validateRuntimeFallbackAttemptMetadata(value: unknown): RuntimeFallbackAttemptMetadata {
  const context = { operation: 'RuntimeFallbackAttemptMetadata.validate' };
  const raw = requirePlainObject(value, context, 'runtimeFallback');
  rejectUnknownKeys(raw, ['schemaVersion', 'switchKey', 'strategySource', 'strategy', 'triggerCategory',
    'previousFailures', 'policyVersion', 'capabilityEvidence'], context, 'runtimeFallback');
  if (raw.schemaVersion !== RUNTIME_FALLBACK_ATTEMPT_SCHEMA_VERSION) {
    throw validationError(context, 'runtimeFallback.schemaVersion', 'unsupported_schema_version');
  }
  const strategy = requirePlainObject(raw.strategy, context, 'runtimeFallback.strategy');
  rejectUnknownKeys(strategy, ['runtime', 'provider', 'model', 'credentialRef', 'endpointRef'], context, 'runtimeFallback.strategy');
  for (const field of ['runtime', 'provider', 'model'] as const) requireNonEmptyString(strategy[field], context, `runtimeFallback.strategy.${field}`);
  for (const field of ['credentialRef', 'endpointRef'] as const) {
    if (strategy[field] !== undefined) requireNonEmptyString(strategy[field], context, `runtimeFallback.strategy.${field}`);
  }
  const category = raw.triggerCategory;
  if (!RUNTIME_FAILURE_CATEGORIES.includes(category as RuntimeFailureCategory)) throw validationError(context, 'runtimeFallback.triggerCategory', 'invalid_category');
  if (!Array.isArray(raw.previousFailures) || raw.previousFailures.length > 32) {
    throw validationError(context, 'runtimeFallback.previousFailures', 'invalid_bounded_array');
  }
  const previousFailures = raw.previousFailures.map((failure, index) => {
    const item = requirePlainObject(failure, context, `runtimeFallback.previousFailures[${index}]`);
    rejectUnknownKeys(item, ['category', 'reason'], context, `runtimeFallback.previousFailures[${index}]`);
    if (!RUNTIME_FAILURE_CATEGORIES.includes(item.category as RuntimeFailureCategory)) throw validationError(context, `runtimeFallback.previousFailures[${index}].category`, 'invalid_category');
    return { category: item.category as RuntimeFailureCategory, reason: requireNonEmptyString(item.reason, context, `runtimeFallback.previousFailures[${index}].reason`) };
  });
  const evidence = requirePlainObject(raw.capabilityEvidence, context, 'runtimeFallback.capabilityEvidence');
  rejectUnknownKeys(evidence, ['catalogDigest', 'registryDigest', 'authorizationDigest'], context, 'runtimeFallback.capabilityEvidence');
  return {
    schemaVersion: 1,
    switchKey: validateStableId(raw.switchKey, context, 'runtimeFallback.switchKey'),
    strategySource: requireNonEmptyString(raw.strategySource, context, 'runtimeFallback.strategySource'),
    strategy: { runtime: strategy.runtime as string, provider: strategy.provider as string, model: strategy.model as string,
      ...(strategy.credentialRef === undefined ? {} : { credentialRef: strategy.credentialRef as string }),
      ...(strategy.endpointRef === undefined ? {} : { endpointRef: strategy.endpointRef as string }) },
    triggerCategory: category as RuntimeFailureCategory,
    previousFailures,
    policyVersion: requireNonEmptyString(raw.policyVersion, context, 'runtimeFallback.policyVersion'),
    capabilityEvidence: {
      catalogDigest: validateSha256Digest(evidence.catalogDigest, context, 'runtimeFallback.capabilityEvidence.catalogDigest'),
      registryDigest: validateSha256Digest(evidence.registryDigest, context, 'runtimeFallback.capabilityEvidence.registryDigest'),
      authorizationDigest: validateSha256Digest(evidence.authorizationDigest, context, 'runtimeFallback.capabilityEvidence.authorizationDigest'),
    },
  };
}

export interface RuntimeFallbackSwitchInput {
  readonly switchKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly oldAttempt: {
    readonly attemptId: string;
    readonly owner: string;
    readonly hostInstanceId: string;
    readonly executionVersion: number;
  };
  readonly newOwner: string;
  readonly newHostInstanceId: string;
  readonly workspace: unknown;
  readonly leaseUntilUtcMs: number;
  readonly stopEvidence: unknown;
  readonly authorized: boolean;
  readonly decision: {
    readonly mode: 'switch';
    readonly triggerCategory: RuntimeFailureCategory;
    readonly previousFailures: readonly RuntimeFallbackAttemptFailure[];
    readonly strategySource: string;
    readonly strategySnapshot: RuntimeStrategyV1;
  };
  readonly policyVersion: string;
  readonly capabilityEvidence: RuntimeFallbackCapabilityEvidence;
  readonly inputSnapshot: PreparedExecutionInputGroup;
}

export interface RuntimeFallbackSwitchResult {
  readonly disposition: 'applied' | 'replayed';
  readonly paused: false;
  readonly oldAttemptId: string;
  readonly receipt: TaskClaimReceipt;
  readonly metadata: RuntimeFallbackAttemptMetadata;
}

export interface RuntimeFallbackStopResult {
  readonly disposition: 'stopped';
  readonly paused: true;
  readonly reason: 'all_candidates_unavailable' | 'fallback_not_authorized' | 'stop_unconfirmed' | 'workspace_occupied' | 'recovery_unsafe';
}

export interface RuntimeFallbackSwitchService {
  switch(input: unknown): RuntimeFallbackSwitchResult;
  /** Persist the Core pause boundary when no candidate is usable. */
  stop(input: unknown): RuntimeFallbackStopResult;
}
