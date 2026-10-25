/**
 * P05-6 / F-001 依赖成果与代码集成计划端口契约。
 *
 * 本模块只规范化输入、计算稳定身份并推导可观察状态；不读取 branch HEAD，
 * 不执行 Git merge，不访问 SQLite/ORM/Host/Runtime。固定成果 commit 是前置
 * Feature 的交付证据，不由当前分支状态推导。后续 Feature 负责把该契约持久化
 * 并接入实际 Git/验证操作。
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validatePositiveInteger,
  validationError,
} from './validation.js';
import { stableStringify } from './feature-plan.js';
import type { ValidationContext } from './validation.js';

export const INTEGRATION_PLAN_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_INPUT_DIGEST_DOMAIN = 'shiploop:integration-input:v1';
export const INTEGRATION_IDENTITY_DIGEST_DOMAIN = 'shiploop:integration-identity:v1';

export const INTEGRATION_PLAN_STATUSES = [
  'dependency_passed',
  'integration_passed',
  'stale',
  'blocked',
] as const;
export type IntegrationPlanStatus = (typeof INTEGRATION_PLAN_STATUSES)[number];

export const INTEGRATION_PLAN_MODES = [
  'reuse_single_predecessor',
  'merge_multiple_predecessors',
] as const;
export type IntegrationPlanMode = (typeof INTEGRATION_PLAN_MODES)[number];

export const INTEGRATION_BLOCK_REASONS = [
  'dependency_not_passed',
  'missing_delivery_evidence',
  'input_coverage_incomplete',
  'ancestor_not_verified',
  'integration_evidence_incomplete',
] as const;
export type IntegrationBlockReason = (typeof INTEGRATION_BLOCK_REASONS)[number];

export const INTEGRATION_OPERATION_STATUSES = ['pending', 'succeeded', 'failed', 'unknown'] as const;
export type IntegrationOperationStatus = (typeof INTEGRATION_OPERATION_STATUSES)[number];

export const INTEGRATION_STALE_REASONS = [
  'input_digest_changed',
  'target_baseline_changed',
  'integration_identity_changed',
] as const;
export type IntegrationStaleReason = (typeof INTEGRATION_STALE_REASONS)[number];

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const MAX_PREDECESSORS = 128;
const MAX_APPROVED_INPUTS = 4_096;
const MAX_VERIFICATION_SCOPE_ITEMS = 256;
const MAX_TEXT_LENGTH = 4_096;

export interface IntegrationInputRef {
  readonly inputId: string;
  readonly digest: string;
}

export type IntegrationStrategySummary = Readonly<Record<string, unknown>>;

export interface IntegrationDeliveryEvidence {
  readonly commitSha: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

export interface IntegrationPredecessorInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  /** 业务交付通过和代码集成通过是两件事；此字段只表达前者。 */
  readonly dependencyPassed: boolean;
  /** 缺失时为 null，表示不能声称存在固定代码成果。 */
  readonly delivery: IntegrationDeliveryEvidence | null;
  /** 此前置成果实际覆盖的获准输入身份。 */
  readonly coveredInputIds: readonly string[];
  /** 由调用方提供的祖先关系核对事实；端口不执行 Git。 */
  readonly ancestorVerified: boolean;
}

export interface IntegrationVerificationEvidence {
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

export interface IntegrationResult {
  /** 确定性 Git 集成后的固定 commit；没有完整结果时保持 null。 */
  readonly commitSha: string | null;
  /** 受测 tree 身份；只有 commit/tree/验证证据齐全才可通过。 */
  readonly treeSha: string | null;
  readonly verificationEvidence: IntegrationVerificationEvidence | null;
  /** 仅作审计文字，不能单独使状态变为 integration_passed。 */
  readonly llmNoConflictText: string | null;
  /** F-004：外部集成操作的持久身份；缺省表示旧版无操作元数据。 */
  readonly operationId?: string | null;
  readonly ownerId?: string | null;
  readonly ownerVersion?: number | null;
  readonly operationStatus?: IntegrationOperationStatus | null;
}

export interface IntegrationPlanInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly successorFeatureId: string;
  /** 固定目标基线 commit；不接受 branch 名或当前 HEAD。 */
  readonly targetBaseline: string;
  readonly predecessors: readonly IntegrationPredecessorInput[];
  /** Batch 获准的完整输入集合；覆盖校验以 inputId 为稳定身份。 */
  readonly approvedInputs: readonly IntegrationInputRef[];
  /** 每个前置 Feature 在此数组中的位置就是固定合并顺序。 */
  readonly mergeOrder: readonly string[];
  /** 验证范围摘要（路径/检查身份等），顺序不影响规范化身份。 */
  readonly verificationScope: readonly string[];
  /** 冻结的策略摘要；作为不透明 JSON 数据参与身份摘要。 */
  readonly strategySummary: IntegrationStrategySummary;
  readonly integrationResult: IntegrationResult | null;
}

export interface IntegrationCoverage {
  readonly approvedInputCount: number;
  readonly coveredInputCount: number;
  readonly complete: boolean;
  readonly missingInputIds: readonly string[];
}

export interface IntegrationPlan extends IntegrationPlanInput {
  readonly schemaVersion: typeof INTEGRATION_PLAN_SCHEMA_VERSION;
  readonly integrationId: string;
  readonly inputDigest: string;
  readonly mode: IntegrationPlanMode;
  readonly status: IntegrationPlanStatus;
  readonly blockReasons: readonly IntegrationBlockReason[];
  readonly staleReasons: readonly IntegrationStaleReason[];
  readonly coverage: IntegrationCoverage;
}

export interface IntegrationPlanStatusResult {
  readonly status: IntegrationPlanStatus;
  readonly blockReasons: readonly IntegrationBlockReason[];
  readonly staleReasons: readonly IntegrationStaleReason[];
}

const INPUT_KEYS = ['projectId', 'phaseId', 'batchId', 'successorFeatureId', 'targetBaseline',
  'predecessors', 'approvedInputs', 'mergeOrder', 'verificationScope', 'strategySummary', 'integrationResult'] as const;
const PREDECESSOR_KEYS = ['projectId', 'phaseId', 'featureId', 'dependencyPassed', 'delivery',
  'coveredInputIds', 'ancestorVerified'] as const;
const DELIVERY_KEYS = ['commitSha', 'evidenceId', 'evidenceDigest'] as const;
const INPUT_REF_KEYS = ['inputId', 'digest'] as const;
const RESULT_KEYS = ['commitSha', 'treeSha', 'verificationEvidence', 'llmNoConflictText',
  'operationId', 'ownerId', 'ownerVersion', 'operationStatus'] as const;
const VERIFICATION_EVIDENCE_KEYS = ['evidenceId', 'evidenceDigest'] as const;

function context(operation = 'IntegrationPlan.validate'): ValidationContext {
  return { operation, entity: { type: 'feature' } };
}

function fail(
  ctx: ValidationContext,
  field: string,
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new StorageError('validation', ctx.operation, `${ctx.operation}: ${field} ${reason}`, {
    entity: ctx.entity,
    details: { field, reason, ...details },
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateGitSha(value: unknown, ctx: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    throw validationError(ctx, field, '必须是 40 或 64 位小写十六进制成果 SHA', value);
  }
  return value;
}

function validateOptionalGitSha(value: unknown, ctx: ValidationContext, field: string): string | null {
  if (value === undefined || value === null) return null;
  return validateGitSha(value, ctx, field);
}

function validateBoundedText(value: unknown, ctx: ValidationContext, field: string): string {
  const text = requireNonEmptyString(value, ctx, field).trim();
  if (text.length > MAX_TEXT_LENGTH || CONTROL_PATTERN.test(text)) {
    throw validationError(ctx, field, `必须是 1..${MAX_TEXT_LENGTH} 字符且不含控制字符`, value);
  }
  return text;
}

function validateStringList(
  value: unknown,
  ctx: ValidationContext,
  field: string,
  max: number,
  sort: boolean,
): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw validationError(ctx, field, `必须是最多 ${max} 项的字符串数组`, value);
  }
  const seen = new Set<string>();
  const result = value.map((item, index) => {
    const text = validateBoundedText(item, ctx, `${field}[${index}]`);
    if (seen.has(text)) fail(ctx, `${field}[${index}]`, '不得重复', { reason: 'duplicate_identity' });
    seen.add(text);
    return text;
  });
  return sort ? result.sort(compare) : result;
}

function validateJsonValue(value: unknown, ctx: ValidationContext, field: string, depth = 0): unknown {
  if (depth > 16) fail(ctx, field, '嵌套层级过深', { reason: 'invalid_strategy_summary' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => validateJsonValue(item, ctx, `${field}[${index}]`, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const object = requirePlainObject(value, ctx, field);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort(compare)) {
      result[key] = validateJsonValue(object[key], ctx, `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw validationError(ctx, field, '必须是有限 JSON 值', value);
}

function validateInputRef(value: unknown, index: number, ctx: ValidationContext): IntegrationInputRef {
  const field = `approvedInputs[${index}]`;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, INPUT_REF_KEYS, ctx, field);
  return {
    inputId: validateStableId(object.inputId, ctx, `${field}.inputId`),
    digest: validateSha256Digest(object.digest, ctx, `${field}.digest`),
  };
}

function validateDelivery(value: unknown, ctx: ValidationContext, field: string): IntegrationDeliveryEvidence | null {
  if (value === undefined || value === null) return null;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, DELIVERY_KEYS, ctx, field);
  return {
    commitSha: validateGitSha(object.commitSha, ctx, `${field}.commitSha`),
    evidenceId: validateStableId(object.evidenceId, ctx, `${field}.evidenceId`),
    evidenceDigest: validateSha256Digest(object.evidenceDigest, ctx, `${field}.evidenceDigest`),
  };
}

function validatePredecessor(
  value: unknown,
  index: number,
  root: Pick<IntegrationPlanInput, 'projectId' | 'phaseId'>,
  ctx: ValidationContext,
): IntegrationPredecessorInput {
  const field = `predecessors[${index}]`;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, PREDECESSOR_KEYS, ctx, field);
  const projectId = validateStableId(object.projectId, ctx, `${field}.projectId`);
  const phaseId = validateStableId(object.phaseId, ctx, `${field}.phaseId`);
  const featureId = validateStableId(object.featureId, ctx, `${field}.featureId`);
  if (projectId !== root.projectId) fail(ctx, `${field}.projectId`, '必须属于当前项目', { reason: 'cross_project' });
  if (phaseId !== root.phaseId) fail(ctx, `${field}.phaseId`, '必须属于当前 Phase', { reason: 'cross_phase' });
  if (typeof object.dependencyPassed !== 'boolean') {
    throw validationError(ctx, `${field}.dependencyPassed`, '必须是布尔值', object.dependencyPassed);
  }
  if (typeof object.ancestorVerified !== 'boolean') {
    throw validationError(ctx, `${field}.ancestorVerified`, '必须是布尔值', object.ancestorVerified);
  }
  const coveredInputIds = validateStringList(object.coveredInputIds, ctx, `${field}.coveredInputIds`, MAX_APPROVED_INPUTS, true);
  return {
    projectId,
    phaseId,
    featureId,
    dependencyPassed: object.dependencyPassed,
    delivery: validateDelivery(object.delivery, ctx, `${field}.delivery`),
    coveredInputIds,
    ancestorVerified: object.ancestorVerified,
  };
}

function validateVerificationEvidence(
  value: unknown,
  ctx: ValidationContext,
  field: string,
): IntegrationVerificationEvidence | null {
  if (value === undefined || value === null) return null;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, VERIFICATION_EVIDENCE_KEYS, ctx, field);
  return {
    evidenceId: validateStableId(object.evidenceId, ctx, `${field}.evidenceId`),
    evidenceDigest: validateSha256Digest(object.evidenceDigest, ctx, `${field}.evidenceDigest`),
  };
}

function validateResult(value: unknown, ctx: ValidationContext): IntegrationResult | null {
  if (value === undefined || value === null) return null;
  const field = 'integrationResult';
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, RESULT_KEYS, ctx, field);
  const llmNoConflictText = object.llmNoConflictText === undefined || object.llmNoConflictText === null
    ? null : validateBoundedText(object.llmNoConflictText, ctx, `${field}.llmNoConflictText`);
  const operationId = object.operationId === undefined || object.operationId === null
    ? null : validateStableId(object.operationId, ctx, `${field}.operationId`);
  const ownerId = object.ownerId === undefined || object.ownerId === null
    ? null : validateStableId(object.ownerId, ctx, `${field}.ownerId`);
  const ownerVersion = object.ownerVersion === undefined || object.ownerVersion === null
    ? null : validatePositiveInteger(object.ownerVersion, ctx, `${field}.ownerVersion`);
  const operationStatus = object.operationStatus === undefined || object.operationStatus === null
    ? null : (() => {
      if (typeof object.operationStatus !== 'string'
        || !(INTEGRATION_OPERATION_STATUSES as readonly string[]).includes(object.operationStatus)) {
        throw validationError(ctx, `${field}.operationStatus`, '必须是有效的集成操作状态', object.operationStatus);
      }
      return object.operationStatus as IntegrationOperationStatus;
    })();
  if ((operationId === null) !== (ownerId === null) || (operationId === null) !== (ownerVersion === null)) {
    throw validationError(ctx, field, 'operationId、ownerId、ownerVersion 必须同时存在或同时为空');
  }
  if (operationStatus !== null && operationId === null) {
    throw validationError(ctx, `${field}.operationStatus`, '带操作状态时必须绑定操作和 owner 身份');
  }
  return {
    commitSha: validateOptionalGitSha(object.commitSha, ctx, `${field}.commitSha`),
    treeSha: validateOptionalGitSha(object.treeSha, ctx, `${field}.treeSha`),
    verificationEvidence: validateVerificationEvidence(object.verificationEvidence, ctx, `${field}.verificationEvidence`),
    llmNoConflictText,
    operationId, ownerId, ownerVersion, operationStatus,
  };
}

function canonicalPlanBody(input: IntegrationPlanInput): Record<string, unknown> {
  return {
    schemaVersion: INTEGRATION_PLAN_SCHEMA_VERSION,
    projectId: input.projectId,
    phaseId: input.phaseId,
    batchId: input.batchId,
    successorFeatureId: input.successorFeatureId,
    targetBaseline: input.targetBaseline,
    predecessors: input.predecessors,
    approvedInputs: input.approvedInputs,
    mergeOrder: input.mergeOrder,
    verificationScope: input.verificationScope,
    strategySummary: input.strategySummary,
    integrationResult: input.integrationResult,
  };
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\n${stableStringify(value)}`, 'utf8').digest('hex');
}

/** 由规范化获准输入、成果 SHA、基线、顺序、范围、策略和结果共同产生。 */
export function computeIntegrationInputDigest(input: IntegrationPlanInput): string {
  return digest(INTEGRATION_INPUT_DIGEST_DOMAIN, canonicalPlanBody(input));
}

/** 稳定 integration identity；时间、owner 和 branch HEAD 不参与。 */
export function computeIntegrationIdentity(input: IntegrationPlanInput): string {
  return digest(INTEGRATION_IDENTITY_DIGEST_DOMAIN, canonicalPlanBody(input));
}

function deriveCoverage(
  approvedInputs: readonly IntegrationInputRef[],
  predecessors: readonly IntegrationPredecessorInput[],
): IntegrationCoverage {
  const approved = new Set(approvedInputs.map((item) => item.inputId));
  const covered = new Set(predecessors.flatMap((item) => item.coveredInputIds));
  const missingInputIds = [...approved].filter((id) => !covered.has(id)).sort(compare);
  return {
    approvedInputCount: approved.size,
    coveredInputCount: [...covered].filter((id) => approved.has(id)).length,
    complete: missingInputIds.length === 0,
    missingInputIds,
  };
}

function deriveBlockedReasons(input: IntegrationPlanInput, coverage: IntegrationCoverage): IntegrationBlockReason[] {
  const reasons: IntegrationBlockReason[] = [];
  if (input.predecessors.some((item) => !item.dependencyPassed)) reasons.push('dependency_not_passed');
  if (input.predecessors.some((item) => item.delivery === null)) reasons.push('missing_delivery_evidence');
  if (!coverage.complete) reasons.push('input_coverage_incomplete');
  if (input.predecessors.some((item) => !item.ancestorVerified)) reasons.push('ancestor_not_verified');
  const result = input.integrationResult;
  if (result !== null && ((result.commitSha === null) !== (result.treeSha === null)
    || (result.commitSha === null && result.verificationEvidence !== null)
    || (result.commitSha !== null && result.verificationEvidence === null))) {
    reasons.push('integration_evidence_incomplete');
  }
  if (result?.operationStatus !== undefined && result.operationStatus !== null && result.operationStatus !== 'succeeded') {
    reasons.push('integration_evidence_incomplete');
  }
  return [...new Set(reasons)];
}

function hasCompleteIntegrationResult(result: IntegrationResult | null): boolean {
  return result !== null
    && result.commitSha !== null
    && result.treeSha !== null
    && result.verificationEvidence !== null
    && (result.operationStatus === undefined || result.operationStatus === null || result.operationStatus === 'succeeded');
}

function deriveStatus(input: IntegrationPlanInput, coverage: IntegrationCoverage): IntegrationPlanStatusResult {
  const blockReasons = deriveBlockedReasons(input, coverage);
  if (blockReasons.length > 0) return { status: 'blocked', blockReasons, staleReasons: [] };
  return {
    status: hasCompleteIntegrationResult(input.integrationResult) ? 'integration_passed' : 'dependency_passed',
    blockReasons: [],
    staleReasons: [],
  };
}

/**
 * 校验并规范化外部 JSON。此函数不检查成果是否真实存在，只检查证据形状；
 * 真实存在性/祖先关系由调用方读取已有 Core/Git 事实后填入对应证据。
 */
export function validateIntegrationPlanInput(value: unknown, operation = 'IntegrationPlan.validate'): IntegrationPlanInput {
  const ctx = context(operation);
  const input = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(input, INPUT_KEYS, ctx, 'input');
  const projectId = validateStableId(input.projectId, ctx, 'projectId');
  const phaseId = validateStableId(input.phaseId, ctx, 'phaseId');
  const batchId = validateStableId(input.batchId, ctx, 'batchId');
  const successorFeatureId = validateStableId(input.successorFeatureId, ctx, 'successorFeatureId');
  const targetBaseline = validateGitSha(input.targetBaseline, ctx, 'targetBaseline');

  if (!Array.isArray(input.predecessors) || input.predecessors.length === 0 || input.predecessors.length > MAX_PREDECESSORS) {
    throw validationError(ctx, 'predecessors', `必须是 1..${MAX_PREDECESSORS} 项数组`, input.predecessors);
  }
  const rawPredecessors = input.predecessors.map((item, index) => validatePredecessor(
    item, index, { projectId, phaseId }, ctx,
  ));
  const featureIds = rawPredecessors.map((item) => item.featureId);
  if (new Set(featureIds).size !== featureIds.length) {
    fail(ctx, 'predecessors', '前置 Feature 身份不得重复', { reason: 'duplicate_identity' });
  }
  if (rawPredecessors.length === 1 && !rawPredecessors[0].ancestorVerified) {
    fail(ctx, 'predecessors[0].ancestorVerified', '单前置复用必须先核对祖先关系', { reason: 'ancestor_not_verified' });
  }

  if (!Array.isArray(input.approvedInputs) || input.approvedInputs.length === 0 || input.approvedInputs.length > MAX_APPROVED_INPUTS) {
    throw validationError(ctx, 'approvedInputs', `必须是 1..${MAX_APPROVED_INPUTS} 项数组`, input.approvedInputs);
  }
  const approvedInputs = input.approvedInputs.map((item, index) => validateInputRef(item, index, ctx));
  if (new Set(approvedInputs.map((item) => item.inputId)).size !== approvedInputs.length) {
    fail(ctx, 'approvedInputs', '获准输入身份不得重复', { reason: 'duplicate_identity' });
  }
  approvedInputs.sort((left, right) => compare(left.inputId, right.inputId));
  const approvedInputIds = new Set(approvedInputs.map((item) => item.inputId));
  for (const [predecessorIndex, predecessor] of rawPredecessors.entries()) {
    for (const [inputIndex, inputId] of predecessor.coveredInputIds.entries()) {
      if (!approvedInputIds.has(inputId)) {
        fail(ctx, `predecessors[${predecessorIndex}].coveredInputIds[${inputIndex}]`,
          '必须引用当前 Batch 的获准输入', { reason: 'input_not_approved', inputId });
      }
    }
  }

  const mergeOrder = validateStringList(input.mergeOrder, ctx, 'mergeOrder', MAX_PREDECESSORS, false);
  if (mergeOrder.length !== featureIds.length || new Set(mergeOrder).size !== mergeOrder.length
    || mergeOrder.some((id) => !featureIds.includes(id))) {
    fail(ctx, 'mergeOrder', '必须一次且仅一次包含全部前置 Feature', { reason: 'invalid_merge_order' });
  }
  const predecessors = mergeOrder.map((featureId) => rawPredecessors.find((item) => item.featureId === featureId)!);
  const verificationScope = validateStringList(input.verificationScope, ctx, 'verificationScope', MAX_VERIFICATION_SCOPE_ITEMS, true);
  const strategySummary = requirePlainObject(input.strategySummary, ctx, 'strategySummary');
  const normalizedStrategy = validateJsonValue(strategySummary, ctx, 'strategySummary') as Readonly<Record<string, unknown>>;
  return {
    projectId,
    phaseId,
    batchId,
    successorFeatureId,
    targetBaseline,
    predecessors,
    approvedInputs,
    mergeOrder,
    verificationScope,
    strategySummary: normalizedStrategy,
    integrationResult: validateResult(input.integrationResult, ctx),
  };
}

/** 校验后的计划及其当前初始状态。 */
export function createIntegrationPlan(value: unknown): IntegrationPlan {
  const input = validateIntegrationPlanInput(value);
  const coverage = deriveCoverage(input.approvedInputs, input.predecessors);
  const derived = deriveStatus(input, coverage);
  return {
    ...input,
    schemaVersion: INTEGRATION_PLAN_SCHEMA_VERSION,
    integrationId: computeIntegrationIdentity(input),
    inputDigest: computeIntegrationInputDigest(input),
    mode: input.predecessors.length === 1 ? 'reuse_single_predecessor' : 'merge_multiple_predecessors',
    status: derived.status,
    blockReasons: derived.blockReasons,
    staleReasons: derived.staleReasons,
    coverage,
  };
}

export type IntegrationPlanObservation =
  | IntegrationPlanInput
  | {
      readonly targetBaseline?: string;
      readonly inputDigest?: string;
      readonly integrationId?: string;
    };

/**
 * 比较冻结计划与当前已获准输入的观察值。只要基线或身份摘要漂移就返回
 * stale；该函数不会用当前 branch HEAD 替换计划中已冻结的成果 SHA。
 */
export function deriveIntegrationPlanStatus(
  plan: IntegrationPlan,
  observation: IntegrationPlanObservation | null = null,
): IntegrationPlanStatusResult {
  if (observation !== null) {
    const staleReasons: IntegrationStaleReason[] = [];
    if ('predecessors' in observation) {
      const current = createIntegrationPlan(observation);
      if (current.inputDigest !== plan.inputDigest) staleReasons.push('input_digest_changed');
      if (current.integrationId !== plan.integrationId) staleReasons.push('integration_identity_changed');
      if (current.targetBaseline !== plan.targetBaseline) staleReasons.push('target_baseline_changed');
    } else {
      if (observation.targetBaseline !== undefined && observation.targetBaseline !== plan.targetBaseline) {
        staleReasons.push('target_baseline_changed');
      }
      if (observation.inputDigest !== undefined && observation.inputDigest !== plan.inputDigest) {
        staleReasons.push('input_digest_changed');
      }
      if (observation.integrationId !== undefined && observation.integrationId !== plan.integrationId) {
        staleReasons.push('integration_identity_changed');
      }
    }
    if (staleReasons.length > 0) {
      return { status: 'stale', blockReasons: [], staleReasons: [...new Set(staleReasons)] };
    }
  }
  return {
    status: plan.status,
    blockReasons: plan.blockReasons,
    staleReasons: plan.staleReasons,
  };
}

export const validateIntegrationPlan = validateIntegrationPlanInput;
export const computeIntegrationPlanDigest = computeIntegrationInputDigest;
export const computeIntegrationPlanIdentity = computeIntegrationIdentity;
