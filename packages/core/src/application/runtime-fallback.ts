/**
 * P04-3 / F-004：Task 冻结备用链与纯选择决策。
 *
 * 该模块只接受已冻结的 Task 策略、显式切换政策和 Core 已取得的能力/授权事实。
 * 它不读时钟以外的环境、不调用 Runtime adapter、不创建 Attempt、不释放占用，也不
 * 修改 settings。选择结果只是一份下一执行所需的策略快照；新 Attempt 的创建和
 * 停止核验由后续 Core 编排负责。
 */
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { validateRuntimeStrategyCapabilities } from '../ports/runtime-capabilities.js';
import type { RuntimeRegistry } from '../ports/runtime-registry.js';
import type { RuntimeFailureCategory } from '../ports/runtime-failure.js';
import { RUNTIME_FAILURE_CATEGORIES } from '../ports/runtime-failure.js';
import type { RuntimeStrategyV1 } from '../ports/settings-schema.js';
import { validateRuntimeStrategy } from '../ports/settings-schema.js';
import { StorageError } from '../ports/errors.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

export const RUNTIME_FALLBACK_SCHEMA_VERSION = 1;
export const RUNTIME_FALLBACK_OPERATION = 'RuntimeFallback';

export type RuntimeFallbackAction = 'switch' | 'stop';
export type RuntimeFallbackStopReason =
  | 'category_not_switchable'
  | 'same_attempt_retry_not_exhausted'
  | 'no_candidate'
  | 'all_candidates_unavailable';

export interface RuntimeFallbackPermissions {
  readonly grants: readonly string[];
  readonly isolation: string;
}

/** Task 创建时捕获的不可变策略引用；approved 不是运行期动态授权的替代品。 */
export interface FrozenRuntimeStrategyReference {
  readonly strategy: RuntimeStrategyV1;
  readonly source: string;
  readonly approved: true;
  readonly trustedRecoveryAtUtcMs?: number | null;
  readonly authorization?: 'authorized' | 'denied';
  readonly permissions?: RuntimeFallbackPermissions;
}

export interface RuntimeFallbackPolicyV1 {
  readonly switchOn: readonly RuntimeFailureCategory[];
  readonly onQuotaBlocked?: RuntimeFallbackAction;
  readonly onTransientConnection?: RuntimeFallbackAction;
  readonly onTransientServer?: RuntimeFallbackAction;
  readonly onAuthentication?: RuntimeFallbackAction;
}

export interface RuntimeFallbackPlanV1 {
  readonly schemaVersion: typeof RUNTIME_FALLBACK_SCHEMA_VERSION;
  readonly preferred: FrozenRuntimeStrategyReference;
  readonly fallbacks: readonly FrozenRuntimeStrategyReference[];
  readonly policy: RuntimeFallbackPolicyV1;
}

export interface RuntimeFallbackFailure {
  readonly category: RuntimeFailureCategory;
  readonly reason: string;
}

export interface RuntimeFallbackCandidateEvaluation {
  readonly source: string;
  readonly outcome: 'unavailable' | 'selected';
  readonly reason: string;
}

export interface RuntimeFallbackDecisionBasis {
  readonly recoveryTime:
    | 'trusted_time_not_reached'
    | 'trusted_time_reached'
    | 'unknown_real_request'
    | 'not_applicable';
  readonly capability: 'runtime_provider_model_catalog_and_registry';
  readonly authorization: 'task_approval_and_runtime_authorization';
}

export interface RuntimeFallbackSwitchDecision {
  readonly mode: 'switch';
  readonly nextExecution: 'new_attempt';
  readonly triggerCategory: RuntimeFailureCategory;
  readonly previousFailures: readonly RuntimeFallbackFailure[];
  readonly strategySource: string;
  readonly strategySnapshot: RuntimeStrategyV1;
  readonly candidateEvaluations: readonly RuntimeFallbackCandidateEvaluation[];
  readonly decisionBasis: RuntimeFallbackDecisionBasis;
  /** Explicit boundary for F-004; Core F-005 must establish these facts/actions. */
  readonly attemptCreated: false;
  readonly occupancyReleased: false;
  readonly nativeHistoryMigrated: false;
}

export interface RuntimeFallbackStopDecision {
  readonly mode: 'stop';
  readonly nextExecution: 'stop';
  readonly stopReason: RuntimeFallbackStopReason;
  readonly triggerCategory: RuntimeFailureCategory;
  readonly previousFailures: readonly RuntimeFallbackFailure[];
  readonly candidateEvaluations: readonly RuntimeFallbackCandidateEvaluation[];
  readonly decisionBasis: RuntimeFallbackDecisionBasis;
  readonly attemptCreated: false;
  readonly occupancyReleased: false;
  readonly nativeHistoryMigrated: false;
}

export type RuntimeFallbackDecision = RuntimeFallbackSwitchDecision | RuntimeFallbackStopDecision;

export interface RuntimeFallbackDecisionInput {
  readonly plan: RuntimeFallbackPlanV1;
  readonly failure: RuntimeFallbackFailure;
  readonly previousFailures?: readonly RuntimeFallbackFailure[];
  readonly priorFailures?: readonly RuntimeFallbackFailure[];
  readonly nowUtcMs: number;
  readonly trustedRecoveryAtUtcMs?: number | null;
  readonly sameAttemptRetryExhausted?: boolean;
  readonly retryExhausted?: boolean;
  readonly capabilities: RuntimeCapabilityCatalog;
  readonly registry?: RuntimeRegistry;
  /** Runtime authorization results keyed by the frozen candidate source. */
  readonly authorization?: Readonly<Record<string, 'authorized' | 'denied'>>;
}

const PLAN_KEYS = ['schemaVersion', 'preferred', 'fallbacks', 'policy'] as const;
const REFERENCE_KEYS = ['strategy', 'source', 'approved', 'trustedRecoveryAtUtcMs', 'authorization', 'permissions'] as const;
const PERMISSION_KEYS = ['grants', 'isolation'] as const;
const POLICY_KEYS = [
  'switchOn', 'onQuotaBlocked', 'onTransientConnection', 'onTransientServer', 'onAuthentication',
] as const;
const DECISION_INPUT_KEYS = [
  'plan', 'failure', 'previousFailures', 'priorFailures', 'nowUtcMs', 'trustedRecoveryAtUtcMs',
  'sameAttemptRetryExhausted', 'retryExhausted', 'capabilities', 'registry', 'authorization',
] as const;

const SWITCHABLE_CATEGORIES = new Set<RuntimeFailureCategory>([
  'quota_blocked', 'transient_connection', 'transient_server', 'authentication',
]);

function context(operation = `${RUNTIME_FALLBACK_OPERATION}.validate`): ValidationContext {
  return { operation, entity: { type: 'task' } };
}

function fail(ctx: ValidationContext, field: string, reason: string, received?: unknown): never {
  throw validationError(ctx, field, reason, received);
}

function isFailureCategory(value: unknown): value is RuntimeFailureCategory {
  return typeof value === 'string' && (RUNTIME_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

function boundedTime(value: unknown, ctx: ValidationContext, field: string, nullable = false): number | null | undefined {
  if (value === undefined) return undefined;
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(ctx, field, '必须是 ≥0 的安全整数或 null', value);
  }
  return value;
}

function failure(value: unknown, ctx: ValidationContext, field: string): RuntimeFallbackFailure {
  const raw = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(raw, ['category', 'reason'], ctx, field);
  if (!isFailureCategory(raw.category)) fail(ctx, `${field}.category`, '不是受支持的 Runtime 故障类别', raw.category);
  return { category: raw.category, reason: requireNonEmptyString(raw.reason, ctx, `${field}.reason`) };
}

function permissions(value: unknown, ctx: ValidationContext, field: string): RuntimeFallbackPermissions {
  const raw = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(raw, PERMISSION_KEYS, ctx, field);
  if (!Array.isArray(raw.grants) || raw.grants.some((grant) => typeof grant !== 'string' || grant.trim().length === 0)
    || new Set(raw.grants).size !== raw.grants.length) {
    fail(ctx, `${field}.grants`, '必须是非空且不重复的权限字符串数组', raw.grants);
  }
  return {
    grants: [...raw.grants] as string[],
    isolation: requireNonEmptyString(raw.isolation, ctx, `${field}.isolation`),
  };
}

function strategyKey(strategy: RuntimeStrategyV1): string {
  return JSON.stringify([strategy.runtime, strategy.provider, strategy.model, strategy.credentialRef ?? null, strategy.endpointRef ?? null]);
}

function reference(value: unknown, ctx: ValidationContext, field: string): FrozenRuntimeStrategyReference {
  const raw = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(raw, REFERENCE_KEYS, ctx, field);
  if (raw.approved !== true) fail(ctx, `${field}.approved`, 'Task 备用策略必须是已批准的冻结条目', raw.approved);
  const result: FrozenRuntimeStrategyReference = {
    strategy: validateRuntimeStrategy(raw.strategy, ctx, `${field}.strategy`),
    source: requireNonEmptyString(raw.source, ctx, `${field}.source`),
    approved: true,
  };
  const recovery = boundedTime(raw.trustedRecoveryAtUtcMs, ctx, `${field}.trustedRecoveryAtUtcMs`, true);
  const authorization = raw.authorization;
  if (authorization !== undefined && authorization !== 'authorized' && authorization !== 'denied') {
    fail(ctx, `${field}.authorization`, '必须是 authorized 或 denied', authorization);
  }
  return {
    ...result,
    ...(recovery === undefined ? {} : { trustedRecoveryAtUtcMs: recovery }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(raw.permissions === undefined ? {} : { permissions: permissions(raw.permissions, ctx, `${field}.permissions`) }),
  };
}

function action(value: unknown, ctx: ValidationContext, field: string): RuntimeFallbackAction {
  if (value !== 'switch' && value !== 'stop') fail(ctx, field, '必须是 switch 或 stop', value);
  return value;
}

function policy(value: unknown, ctx: ValidationContext, field: string): RuntimeFallbackPolicyV1 {
  const raw = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(raw, POLICY_KEYS, ctx, field);
  if (!Array.isArray(raw.switchOn)) fail(ctx, `${field}.switchOn`, '必须显式提供故障类别数组', raw.switchOn);
  const switchOn: RuntimeFailureCategory[] = [];
  for (const [index, category] of raw.switchOn.entries()) {
    if (!isFailureCategory(category) || !SWITCHABLE_CATEGORIES.has(category)) {
      fail(ctx, `${field}.switchOn[${index}]`, '只有可显式切换的故障类别可以进入备用政策', category);
    }
    if (switchOn.includes(category)) fail(ctx, `${field}.switchOn`, '故障类别不得重复');
    switchOn.push(category);
  }
  const result: RuntimeFallbackPolicyV1 = { switchOn };
  for (const key of ['onQuotaBlocked', 'onTransientConnection', 'onTransientServer', 'onAuthentication'] as const) {
    if (raw[key] !== undefined) Object.assign(result, { [key]: action(raw[key], ctx, `${field}.${key}`) });
  }
  // Per-category fields are an auditable alternative spelling. A conflict is ambiguous.
  for (const [key, category] of [
    ['onQuotaBlocked', 'quota_blocked'],
    ['onTransientConnection', 'transient_connection'],
    ['onTransientServer', 'transient_server'],
    ['onAuthentication', 'authentication'],
  ] as const) {
    const configured = raw[key] as RuntimeFallbackAction | undefined;
    if (configured !== undefined && configured === 'switch' && !switchOn.includes(category)) {
      fail(ctx, `${field}.${key}`, '显式 switch 必须同时出现在 switchOn 中');
    }
    if (configured === 'stop' && switchOn.includes(category)) {
      fail(ctx, `${field}.${key}`, 'stop 与 switchOn 中的类别冲突');
    }
  }
  return result;
}

/** 校验并复制 Task 冻结的首选与有序备用策略。 */
export function validateRuntimeFallbackPlan(value: unknown): RuntimeFallbackPlanV1 {
  const ctx = context();
  const raw = requirePlainObject(value, ctx, 'plan');
  rejectUnknownKeys(raw, PLAN_KEYS, ctx, 'plan');
  if (raw.schemaVersion !== RUNTIME_FALLBACK_SCHEMA_VERSION) {
    fail(ctx, 'plan.schemaVersion', `仅支持 ${RUNTIME_FALLBACK_SCHEMA_VERSION}`, raw.schemaVersion);
  }
  const preferred = reference(raw.preferred, ctx, 'plan.preferred');
  if (!Array.isArray(raw.fallbacks)) fail(ctx, 'plan.fallbacks', '必须是有序数组', raw.fallbacks);
  const fallbacks = raw.fallbacks.map((entry, index) => reference(entry, ctx, `plan.fallbacks[${index}]`));
  const seen = new Set([strategyKey(preferred.strategy)]);
  const seenSources = new Set([preferred.source]);
  for (const [index, candidate] of fallbacks.entries()) {
    if (seenSources.has(candidate.source)) fail(ctx, `plan.fallbacks[${index}].source`, '策略来源不得重复');
    seenSources.add(candidate.source);
    const key = strategyKey(candidate.strategy);
    if (seen.has(key)) fail(ctx, `plan.fallbacks[${index}].strategy`, '策略不得重复，避免循环尝试');
    seen.add(key);
  }
  return {
    schemaVersion: RUNTIME_FALLBACK_SCHEMA_VERSION,
    preferred,
    fallbacks,
    policy: policy(raw.policy, ctx, 'plan.policy'),
  };
}

function copyFailureList(value: unknown, ctx: ValidationContext, field: string): RuntimeFallbackFailure[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(ctx, field, '必须是故障数组', value);
  return value.map((item, index) => failure(item, ctx, `${field}[${index}]`));
}

function authorizationFor(candidate: FrozenRuntimeStrategyReference, input: Record<string, unknown>): 'authorized' | 'denied' {
  const map = input.authorization;
  if (isPlainObject(map)) {
    const result = map[candidate.source];
    if (result === 'denied') return 'denied';
    if (result === 'authorized') return 'authorized';
  }
  return candidate.authorization ?? 'authorized';
}

function validateAuthorizationMap(value: unknown, ctx: ValidationContext): void {
  if (value === undefined) return;
  const map = requirePlainObject(value, ctx, 'input.authorization');
  for (const [source, result] of Object.entries(map)) {
    if (result !== 'authorized' && result !== 'denied') {
      fail(ctx, `input.authorization.${source}`, '授权结果必须是 authorized 或 denied', result);
    }
  }
}

function capabilityReason(error: unknown): string {
  if (error instanceof StorageError) {
    const reason = error.details?.reason;
    if (typeof reason === 'string') return reason;
  }
  return 'capability_rejected';
}

function verifyCandidate(
  candidate: FrozenRuntimeStrategyReference,
  input: Record<string, unknown>,
  ctx: ValidationContext,
): string | null {
  if (authorizationFor(candidate, input) !== 'authorized') return 'authorization_denied';
  const capabilities = input.capabilities as unknown as RuntimeCapabilityCatalog;
  try {
    validateRuntimeStrategyCapabilities(candidate.strategy, capabilities, ctx, 'candidate.strategy');
  } catch (error) {
    return capabilityReason(error);
  }
  const registry = input.registry as RuntimeRegistry | undefined;
  if (registry !== undefined) {
    const entry = registry.resolve(candidate.strategy.runtime);
    if (entry === undefined) return 'runtime_not_registered';
    const provider = entry.descriptor.providers.find((item) => item.providerId === candidate.strategy.provider);
    if (provider === undefined) return 'incompatible_provider';
    if (provider.models !== undefined && provider.models.length > 0 && !provider.models.includes(candidate.strategy.model)) {
      return 'unsupported_model';
    }
    const requested = candidate.permissions;
    if (requested !== undefined) {
      for (const grant of requested.grants) {
        if (!entry.descriptor.permissionGrants.includes(grant)) return 'grant_not_enforceable';
      }
      if (!entry.descriptor.isolationModes.includes(requested.isolation)) return 'isolation_not_providable';
    }
  }
  return null;
}

function decisionBasis(recoveryTime: RuntimeFallbackDecisionBasis['recoveryTime']): RuntimeFallbackDecisionBasis {
  return {
    recoveryTime,
    capability: 'runtime_provider_model_catalog_and_registry',
    authorization: 'task_approval_and_runtime_authorization',
  };
}

function stop(
  reason: RuntimeFallbackStopReason,
  triggerCategory: RuntimeFailureCategory,
  previousFailures: readonly RuntimeFallbackFailure[],
  evaluations: readonly RuntimeFallbackCandidateEvaluation[],
  basis: RuntimeFallbackDecisionBasis,
): RuntimeFallbackStopDecision {
  return {
    mode: 'stop',
    nextExecution: 'stop',
    stopReason: reason,
    triggerCategory,
    previousFailures: [...previousFailures],
    candidateEvaluations: [...evaluations],
    decisionBasis: basis,
    attemptCreated: false,
    occupancyReleased: false,
    nativeHistoryMigrated: false,
  };
}

/**
 * 根据故障类别、能力/权限和可信恢复时间选择下一策略。
 * 这是纯决策：调用者负责把该结果交给停止核验和新 Attempt 流程。
 */
export function decideRuntimeFallback(value: unknown): RuntimeFallbackDecision {
  const ctx = context(`${RUNTIME_FALLBACK_OPERATION}.decide`);
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, DECISION_INPUT_KEYS, ctx, 'input');
  const plan = validateRuntimeFallbackPlan(raw.plan);
  const trigger = failure(raw.failure, ctx, 'input.failure');
  const previous = raw.previousFailures !== undefined
    ? copyFailureList(raw.previousFailures, ctx, 'input.previousFailures')
    : copyFailureList(raw.priorFailures, ctx, 'input.priorFailures');
  const failures = [...previous, trigger];
  if (!Number.isSafeInteger(raw.nowUtcMs) || (raw.nowUtcMs as number) < 0) {
    fail(ctx, 'input.nowUtcMs', '必须是 ≥0 的安全整数', raw.nowUtcMs);
  }
  const now = raw.nowUtcMs as number;
  const rootRecovery = boundedTime(raw.trustedRecoveryAtUtcMs, ctx, 'input.trustedRecoveryAtUtcMs', true);
  validateAuthorizationMap(raw.authorization, ctx);
  if (!isPlainObject(raw.capabilities) || typeof (raw.capabilities as unknown as RuntimeCapabilityCatalog).resolve !== 'function') {
    fail(ctx, 'input.capabilities', '必须是已装配的 RuntimeCapabilityCatalog');
  }
  const retryExhausted = raw.sameAttemptRetryExhausted ?? raw.retryExhausted;
  if (trigger.category === 'transient_connection' && retryExhausted !== true) {
    return stop('same_attempt_retry_not_exhausted', trigger.category, failures, [], decisionBasis('not_applicable'));
  }
  if (!SWITCHABLE_CATEGORIES.has(trigger.category) || !plan.policy.switchOn.includes(trigger.category)) {
    return stop('category_not_switchable', trigger.category, failures, [], decisionBasis('not_applicable'));
  }
  if (plan.fallbacks.length === 0) {
    return stop('no_candidate', trigger.category, failures, [], decisionBasis('not_applicable'));
  }

  const evaluations: RuntimeFallbackCandidateEvaluation[] = [];
  let recoveryBasis: RuntimeFallbackDecisionBasis['recoveryTime'] = 'unknown_real_request';
  for (const candidate of plan.fallbacks) {
    const capabilityFailure = verifyCandidate(candidate, raw, ctx);
    if (capabilityFailure !== null) {
      evaluations.push({ source: candidate.source, outcome: 'unavailable', reason: capabilityFailure });
      continue;
    }
    const recoveryAt = candidate.trustedRecoveryAtUtcMs !== undefined
      ? candidate.trustedRecoveryAtUtcMs
      : rootRecovery;
    if (recoveryAt !== undefined && recoveryAt !== null) {
      if (recoveryAt > now) {
        recoveryBasis = 'trusted_time_not_reached';
        evaluations.push({ source: candidate.source, outcome: 'unavailable', reason: 'trusted_recovery_not_ready' });
        continue;
      }
      recoveryBasis = 'trusted_time_reached';
    } else {
      if (recoveryBasis !== 'trusted_time_not_reached') recoveryBasis = 'unknown_real_request';
    }
    evaluations.push({ source: candidate.source, outcome: 'selected', reason: 'candidate_approved_and_compatible' });
    return {
      mode: 'switch',
      nextExecution: 'new_attempt',
      triggerCategory: trigger.category,
      previousFailures: failures,
      strategySource: candidate.source,
      strategySnapshot: { ...candidate.strategy },
      candidateEvaluations: evaluations,
      decisionBasis: decisionBasis(recoveryBasis),
      attemptCreated: false,
      occupancyReleased: false,
      nativeHistoryMigrated: false,
    };
  }
  return stop('all_candidates_unavailable', trigger.category, failures, evaluations, decisionBasis(recoveryBasis));
}
