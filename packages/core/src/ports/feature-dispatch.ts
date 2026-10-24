/**
 * P05-4 / F-001 Feature 级派发策略与准入窄端口。
 *
 * 该模块只读取已批准 Batch 的不可变快照并组合受信只读检查结果。它不创建
 * Run/Attempt、占用槽位、启动 Runtime、扣减预算，也不维护第二套生命周期状态机。
 * P04 的 Run claimVersion、Task executionVersion、owner 和 host fencing 仍由
 * execution-dispatch/task-claim 端口负责；这里的并发数只是 Feature 派发策略。
 */
import { StorageError } from './errors.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';

const OPERATION = 'FeatureDispatch';

/** P05-4 策略的缺省并发；沿用 P04 单并发行为。 */
export const FEATURE_DISPATCH_CONCURRENCY_DEFAULT = 1;
/** 配置契约允许的最大 Feature 并发；槽位原子实现仍由后续派发任务负责。 */
export const FEATURE_DISPATCH_CONCURRENCY_MAX = 16;

export const FEATURE_DISPATCH_ACTIVE_BATCH_STATUSES = [
  'queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted',
] as const;
export type FeatureDispatchActiveBatchStatus = (typeof FEATURE_DISPATCH_ACTIVE_BATCH_STATUSES)[number];

export const FEATURE_DISPATCH_BLOCKING_REASONS = [
  'batch_project_mismatch',
  'batch_phase_mismatch',
  'feature_outside_batch_scope',
  'batch_not_dispatchable',
  'batch_authorization_missing',
  'batch_authorization_invalid',
  'batch_scope_invalid',
  'batch_concurrency_invalid',
  'batch_concurrency_unsupported',
  'batch_budget_exhausted',
  'batch_deadline_reached',
  'dependency_not_ready',
  'authorization_invalid',
  'budget_exhausted',
  'code_prerequisite_not_ready',
] as const;
export type FeatureDispatchBlockingReason = (typeof FEATURE_DISPATCH_BLOCKING_REASONS)[number];

export interface FeatureDispatchBudgetSnapshot {
  readonly maxTotalAttempts: number;
  readonly maxRuntimeStarts: number;
  readonly attemptsCreated: number;
  readonly runtimeStarts: number;
  readonly deadlineUtcMs: number;
}

export interface FeatureDispatchBatchSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly batchId: string;
  readonly phaseId: string;
  readonly status: FeatureDispatchActiveBatchStatus;
  readonly scope: { readonly featureIds: readonly string[] };
  readonly authorization: { readonly status: 'approved'; readonly digest: string };
  readonly concurrency: {
    readonly maxConcurrentFeatures: number;
    readonly source?: string;
  };
  readonly budget: FeatureDispatchBudgetSnapshot;
}

export interface FeatureDispatchBatchPolicy {
  readonly projectId: string;
  readonly batchId: string;
  readonly phaseId: string;
  readonly featureIds: readonly string[];
  readonly status: FeatureDispatchActiveBatchStatus;
  readonly authorizationDigest: string;
  readonly maxConcurrentFeatures: number;
  readonly concurrencySource: string | null;
  readonly budget: FeatureDispatchBudgetSnapshot;
  readonly evaluatedAtUtcMs: number;
}

export interface FeatureDispatchCandidateIdentity {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly runId: string;
}

export interface FeatureDispatchCheckResult {
  readonly ready?: boolean;
  readonly valid?: boolean;
  readonly allowed?: boolean;
  readonly reason: string | null;
}

export interface FeatureDispatchCandidateEvaluation {
  readonly identity: FeatureDispatchCandidateIdentity;
  readonly eligible: boolean;
  readonly reason: FeatureDispatchBlockingReason | null;
  /** false means no downstream Attempt/Runtime/budget side effect may be started. */
  readonly attemptMayBeCreated: boolean;
}

export interface FeatureDispatchAdmissionPort {
  check(identity: unknown): FeatureDispatchCandidateEvaluation;
}

function fail(
  field: string,
  reason: string,
  message: string,
  received?: unknown,
): never {
  throw new StorageError('validation', `${OPERATION}.validate`, `${OPERATION}: ${field} ${message}`, {
    details: { field, reason, ...(received === undefined ? {} : { receivedType: typeof received }) },
  });
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return fail(field, 'invalid_string', '必须是 1..512 字符字符串', value);
  }
  return value;
}

function requireBatchConcurrency(value: unknown): number {
  if (value === undefined) return FEATURE_DISPATCH_CONCURRENCY_DEFAULT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail('concurrency.maxConcurrentFeatures', 'batch_concurrency_invalid', '必须是正的安全整数', value);
  }
  if (value > FEATURE_DISPATCH_CONCURRENCY_MAX) {
    return fail('concurrency.maxConcurrentFeatures', 'batch_concurrency_unsupported', `不得超过 ${FEATURE_DISPATCH_CONCURRENCY_MAX}`, value);
  }
  return value;
}

function validateBudget(value: unknown): FeatureDispatchBudgetSnapshot {
  const context = { operation: `${OPERATION}.validate` } as const;
  const raw = requirePlainObject(value, context, 'budget');
  rejectUnknownKeys(raw, ['maxTotalAttempts', 'maxRuntimeStarts', 'attemptsCreated', 'runtimeStarts', 'deadlineUtcMs'], context, 'budget');
  const deadline = raw.deadlineUtcMs;
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 1) {
    throw validationError(context, 'budget.deadlineUtcMs', '必须是正的安全整数', deadline);
  }
  return {
    maxTotalAttempts: validatePositiveInteger(raw.maxTotalAttempts, context, 'budget.maxTotalAttempts'),
    maxRuntimeStarts: validatePositiveInteger(raw.maxRuntimeStarts, context, 'budget.maxRuntimeStarts'),
    attemptsCreated: validateNonNegativeInteger(raw.attemptsCreated, context, 'budget.attemptsCreated'),
    runtimeStarts: validateNonNegativeInteger(raw.runtimeStarts, context, 'budget.runtimeStarts'),
    deadlineUtcMs: deadline,
  };
}

function normalizeFeatureDispatchBatchSnapshot(value: unknown): unknown {
  if (!isRecord(value) || !('scopeSnapshot' in value)) return value;
  const scopeSnapshot = value.scopeSnapshot;
  const configSnapshot = value.configSnapshot;
  const budgetSnapshot = value.budgetSnapshot;
  const approval = isRecord(configSnapshot) && isRecord(configSnapshot.approval) ? configSnapshot.approval : {};
  const concurrency = isRecord(configSnapshot) && isRecord(configSnapshot.concurrency)
    ? configSnapshot.concurrency : {};
  const batchBudget = isRecord(budgetSnapshot) && isRecord(budgetSnapshot.batch) ? budgetSnapshot.batch : {};
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    batchId: value.id ?? value.batchId,
    phaseId: value.phaseId,
    status: value.status,
    scope: isRecord(scopeSnapshot) ? { featureIds: scopeSnapshot.featureIds } : scopeSnapshot,
    authorization: isRecord(approval) && (approval.planDigest !== undefined || approval.checkPolicyDigest !== undefined)
      ? { status: 'approved', digest: approval.planDigest ?? approval.checkPolicyDigest }
      : undefined,
    concurrency,
    budget: {
      maxTotalAttempts: isRecord(batchBudget) ? batchBudget.maxTotalAttempts : undefined,
      maxRuntimeStarts: isRecord(batchBudget) ? batchBudget.maxRuntimeStarts : undefined,
      attemptsCreated: value.attemptsCreated,
      runtimeStarts: value.runtimeStarts,
      deadlineUtcMs: value.deadlineAtUtcMs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 P05-3 批准后供派发消费的固定快照。 */
export function validateFeatureDispatchBatchSnapshot(value: unknown): FeatureDispatchBatchSnapshot {
  const normalized = normalizeFeatureDispatchBatchSnapshot(value);
  const context = { operation: `${OPERATION}.validateBatch` } as const;
  const raw = requirePlainObject(normalized, context, 'batch');
  rejectUnknownKeys(raw, ['schemaVersion', 'projectId', 'batchId', 'phaseId', 'status', 'scope', 'authorization', 'concurrency', 'budget'], context, 'batch');
  if (raw.schemaVersion !== 1) throw validationError(context, 'schemaVersion', '只支持版本 1', raw.schemaVersion);
  const projectId = validateStableId(raw.projectId, context, 'projectId');
  const batchId = validateStableId(raw.batchId, context, 'batchId');
  const phaseId = validateStableId(raw.phaseId, context, 'phaseId');
  const status = raw.status;
  if (typeof status !== 'string' || !(FEATURE_DISPATCH_ACTIVE_BATCH_STATUSES as readonly string[]).includes(status)) {
    throw validationError(context, 'status', '必须是可派发的活动 Batch 状态', status);
  }

  const scope = requirePlainObject(raw.scope, context, 'scope');
  rejectUnknownKeys(scope, ['featureIds'], context, 'scope');
  if (!Array.isArray(scope.featureIds) || scope.featureIds.length === 0 || scope.featureIds.length > 1_000) {
    return fail('scope.featureIds', 'batch_scope_invalid', '必须是 1..1000 个固定 Feature 身份', scope.featureIds);
  }
  const featureIds = scope.featureIds.map((featureId, index) => validateStableId(featureId, context, `scope.featureIds[${index}]`));
  if (new Set(featureIds).size !== featureIds.length) {
    return fail('scope.featureIds', 'batch_scope_invalid', '不得包含重复 Feature 身份');
  }

  if (raw.authorization === undefined || raw.authorization === null) {
    return fail('authorization', 'batch_authorization_missing', '批准授权摘要必填');
  }
  const authorization = requirePlainObject(raw.authorization, context, 'authorization');
  rejectUnknownKeys(authorization, ['status', 'digest'], context, 'authorization');
  if (authorization.status !== 'approved') {
    return fail('authorization.status', 'batch_authorization_invalid', '必须是 approved', authorization.status);
  }
  const authorizationDigest = validateSha256Digest(authorization.digest, context, 'authorization.digest');

  const concurrencyObject = raw.concurrency === undefined ? {} : requirePlainObject(raw.concurrency, context, 'concurrency');
  rejectUnknownKeys(concurrencyObject, ['maxConcurrentFeatures', 'maxConcurrentWorks', 'source'], context, 'concurrency');
  const rawConcurrency = concurrencyObject.maxConcurrentFeatures ?? concurrencyObject.maxConcurrentWorks;
  if (concurrencyObject.maxConcurrentFeatures !== undefined && concurrencyObject.maxConcurrentWorks !== undefined
    && concurrencyObject.maxConcurrentFeatures !== concurrencyObject.maxConcurrentWorks) {
    return fail('concurrency', 'batch_concurrency_invalid', 'maxConcurrentFeatures 与 maxConcurrentWorks 不得漂移');
  }
  const concurrency = requireBatchConcurrency(rawConcurrency);
  const source = concurrencyObject.source === undefined ? undefined : requireText(concurrencyObject.source, 'concurrency.source');

  return {
    schemaVersion: 1,
    projectId,
    batchId,
    phaseId,
    status: status as FeatureDispatchActiveBatchStatus,
    scope: { featureIds },
    authorization: { status: 'approved', digest: authorizationDigest },
    concurrency: { maxConcurrentFeatures: concurrency, ...(source === undefined ? {} : { source }) },
    budget: validateBudget(raw.budget),
  };
}

/**
 * 把固定快照转成候选准入策略。截止时间使用调用方时钟；不会读取系统时间或执行
 * 任何写操作，因此可在一致读事务外准备，并在认领事务内重新核对。
 */
export function deriveFeatureDispatchBatchPolicy(
  value: unknown,
  nowUtcMs: number,
): FeatureDispatchBatchPolicy {
  const context = { operation: `${OPERATION}.derivePolicy` } as const;
  if (!Number.isSafeInteger(nowUtcMs) || nowUtcMs < 0) {
    throw validationError(context, 'nowUtcMs', '必须是非负安全整数', nowUtcMs);
  }
  const snapshot = validateFeatureDispatchBatchSnapshot(normalizeFeatureDispatchBatchSnapshot(value));
  if (snapshot.budget.attemptsCreated >= snapshot.budget.maxTotalAttempts
    || snapshot.budget.runtimeStarts >= snapshot.budget.maxRuntimeStarts) {
    throw new StorageError('conflict', `${OPERATION}.derivePolicy`, 'Batch 预算已耗尽', {
      details: { reason: 'batch_budget_exhausted' },
    });
  }
  if (nowUtcMs >= snapshot.budget.deadlineUtcMs) {
    throw new StorageError('conflict', `${OPERATION}.derivePolicy`, 'Batch deadline 已到达', {
      details: { reason: 'batch_deadline_reached' },
    });
  }
  return {
    projectId: snapshot.projectId,
    batchId: snapshot.batchId,
    phaseId: snapshot.phaseId,
    featureIds: [...snapshot.scope.featureIds],
    status: snapshot.status,
    authorizationDigest: snapshot.authorization.digest,
    maxConcurrentFeatures: snapshot.concurrency.maxConcurrentFeatures,
    concurrencySource: snapshot.concurrency.source ?? null,
    budget: snapshot.budget,
    evaluatedAtUtcMs: nowUtcMs,
  };
}

export function snapshotFeatureDispatchBatch(value: unknown): FeatureDispatchBatchSnapshot {
  return validateFeatureDispatchBatchSnapshot(value);
}

/** 候选身份只携带队列事实；fencing 字段可随输入存在，但不会成为并发身份/计数。 */
export function validateFeatureDispatchCandidateIdentity(value: unknown): FeatureDispatchCandidateIdentity {
  const context = { operation: `${OPERATION}.validateCandidate` } as const;
  const raw = requirePlainObject(value, context, 'candidate');
  rejectUnknownKeys(raw, [
    'projectId', 'phaseId', 'batchId', 'featureId', 'runId',
    'claimVersion', 'executionVersion', 'ownerId', 'hostInstanceId',
  ], context, 'candidate');
  if (raw.claimVersion !== undefined) validatePositiveInteger(raw.claimVersion, context, 'candidate.claimVersion');
  if (raw.executionVersion !== undefined) validatePositiveInteger(raw.executionVersion, context, 'candidate.executionVersion');
  return {
    projectId: validateStableId(raw.projectId, context, 'candidate.projectId'),
    phaseId: validateStableId(raw.phaseId, context, 'candidate.phaseId'),
    batchId: validateStableId(raw.batchId, context, 'candidate.batchId'),
    featureId: validateStableId(raw.featureId, context, 'candidate.featureId'),
    runId: validateStableId(raw.runId, context, 'candidate.runId'),
  };
}

function candidateBlocked(
  identity: FeatureDispatchCandidateIdentity,
  reason: FeatureDispatchBlockingReason,
): FeatureDispatchCandidateEvaluation {
  return { identity, eligible: false, reason, attemptMayBeCreated: false };
}

function checkValue(check: FeatureDispatchCheckResult, key: 'ready' | 'valid' | 'allowed'): boolean {
  return check[key] === true;
}

/** 组合全部受信准入结果；等待状态永远没有 Attempt/Runtime/额度副作用。 */
export function evaluateFeatureDispatchCandidate(input: {
  readonly policy: FeatureDispatchBatchPolicy;
  readonly identity: FeatureDispatchCandidateIdentity;
  readonly dependency: FeatureDispatchCheckResult;
  readonly authorization: FeatureDispatchCheckResult;
  readonly budget: FeatureDispatchCheckResult;
  readonly code: FeatureDispatchCheckResult;
}): FeatureDispatchCandidateEvaluation {
  const { policy, identity } = input;
  if (identity.projectId !== policy.projectId) return candidateBlocked(identity, 'batch_project_mismatch');
  if (identity.phaseId !== policy.phaseId) return candidateBlocked(identity, 'batch_phase_mismatch');
  if (identity.batchId !== policy.batchId || !policy.featureIds.includes(identity.featureId)) {
    return candidateBlocked(identity, 'feature_outside_batch_scope');
  }
  if (!FEATURE_DISPATCH_ACTIVE_BATCH_STATUSES.includes(policy.status)) return candidateBlocked(identity, 'batch_not_dispatchable');
  if (policy.evaluatedAtUtcMs >= policy.budget.deadlineUtcMs) return candidateBlocked(identity, 'batch_deadline_reached');
  if (policy.budget.attemptsCreated >= policy.budget.maxTotalAttempts
    || policy.budget.runtimeStarts >= policy.budget.maxRuntimeStarts) {
    return candidateBlocked(identity, 'batch_budget_exhausted');
  }
  if (!checkValue(input.dependency, 'ready')) return candidateBlocked(identity, 'dependency_not_ready');
  if (!checkValue(input.authorization, 'valid')) return candidateBlocked(identity, 'authorization_invalid');
  if (!checkValue(input.budget, 'allowed')) return candidateBlocked(identity, 'budget_exhausted');
  if (!checkValue(input.code, 'ready')) return candidateBlocked(identity, 'code_prerequisite_not_ready');
  return { identity, eligible: true, reason: null, attemptMayBeCreated: true };
}

export interface FeatureDispatchAdmissionDependencies {
  readBatch(identity: FeatureDispatchCandidateIdentity): unknown;
  checkDependencies(identity: FeatureDispatchCandidateIdentity): FeatureDispatchCheckResult;
  checkAuthorization(identity: FeatureDispatchCandidateIdentity): FeatureDispatchCheckResult;
  checkBudget(identity: FeatureDispatchCandidateIdentity, policy: FeatureDispatchBatchPolicy): FeatureDispatchCheckResult;
  checkCodePrerequisites(identity: FeatureDispatchCandidateIdentity): FeatureDispatchCheckResult;
  readonly nowUtcMs: () => number;
}

/**
 * 受信任装配使用的只读准入端口。依赖未就绪时立即返回等待原因，不调用后续
 * 预算/代码端口，也不暴露任何可以写队列、槽位、预算或通过标志的方法。
 */
export function createFeatureDispatchAdmission(
  dependencies: FeatureDispatchAdmissionDependencies,
): FeatureDispatchAdmissionPort {
  if (dependencies === null || typeof dependencies !== 'object') throw new TypeError('FeatureDispatch admission dependencies must be an object');
  for (const name of ['readBatch', 'checkDependencies', 'checkAuthorization', 'checkBudget', 'checkCodePrerequisites', 'nowUtcMs'] as const) {
    if (typeof dependencies[name] !== 'function') throw new TypeError(`FeatureDispatch admission dependency ${name} must be a function`);
  }
  return {
    check(rawIdentity: unknown): FeatureDispatchCandidateEvaluation {
      const identity = validateFeatureDispatchCandidateIdentity(rawIdentity);
      const policy = deriveFeatureDispatchBatchPolicy(dependencies.readBatch(identity), dependencies.nowUtcMs());
      const dependency = dependencies.checkDependencies(identity);
      if (!checkValue(dependency, 'ready')) return candidateBlocked(identity, 'dependency_not_ready');
      const authorization = dependencies.checkAuthorization(identity);
      if (!checkValue(authorization, 'valid')) return candidateBlocked(identity, 'authorization_invalid');
      const budget = dependencies.checkBudget(identity, policy);
      if (!checkValue(budget, 'allowed')) return candidateBlocked(identity, 'budget_exhausted');
      const code = dependencies.checkCodePrerequisites(identity);
      return evaluateFeatureDispatchCandidate({ policy, identity, dependency, authorization, budget, code });
    },
  };
}

/** 兼容调用方对“Feature 并发策略”命名的窄别名。 */
export const validateFeatureConcurrencySnapshot = validateFeatureDispatchBatchSnapshot;
export const evaluateFeatureDispatchAdmission = evaluateFeatureDispatchCandidate;
