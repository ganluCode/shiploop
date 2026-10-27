/**
 * P05-7 / F-001：确定性 Git 集成执行输入端口。
 *
 * 这里仅冻结和校验跨边界的数据，不读取 SQLite、Git、文件系统、HTTP、SDK
 * 或模型。前置交付、目标基线和组合验证结果是不同事实；当前 branch HEAD
 * 或 branch 名永远不会进入该契约。
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import { stableStringify } from './feature-plan.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const INTEGRATION_EXECUTION_PLAN_SCHEMA_VERSION = 1 as const;
export const INTEGRATION_EXECUTION_INPUT_DIGEST_DOMAIN = 'shiploop:integration-execution-input:v1';
export const INTEGRATION_EXECUTION_COVERED_INPUT_DIGEST_DOMAIN = 'shiploop:integration-covered-input:v1';
export const INTEGRATION_EXECUTION_IDENTITY_DIGEST_DOMAIN = 'shiploop:integration-execution-identity:v1';

export type IntegrationExecutionPlanStatus = 'dependency_passed' | 'integration_passed';

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const MAX_PREDECESSORS = 128;
const MAX_APPROVED_INPUTS = 4_096;
const MAX_SCOPE_ITEMS = 256;
const MAX_TEXT_LENGTH = 4_096;
const MAX_REPO_IDENTITY_LENGTH = 512;

export interface IntegrationExecutionTarget {
  readonly baseCommit: string;
  readonly repoIdentity: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string;
}

export interface IntegrationApprovedInput {
  readonly inputId: string;
  readonly digest: string;
}

export interface IntegrationDeliverySnapshot {
  readonly commitSha: string;
  readonly repoIdentity: string;
  /** 摘要覆盖 coveredInputIds 对应的批准输入，而不是运行时 branch HEAD。 */
  readonly inputDigest: string;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

export interface IntegrationExecutionPredecessor {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly dependencyPassed: boolean;
  readonly delivery: IntegrationDeliverySnapshot | null;
  readonly coveredInputIds: readonly string[];
}

export interface IntegrationCombinedVerificationEvidence {
  readonly evidenceId: string;
  readonly evidenceDigest: string;
}

export interface IntegrationExecutionResult {
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly inputDigest: string;
  readonly verificationEvidence: IntegrationCombinedVerificationEvidence | null;
}

export interface IntegrationExecutionPlanInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly successorFeatureId: string;
  readonly target: IntegrationExecutionTarget;
  readonly predecessors: readonly IntegrationExecutionPredecessor[];
  readonly approvedInputs: readonly IntegrationApprovedInput[];
  /** 该数组定义确定性的 Git 合并顺序。 */
  readonly mergeOrder: readonly string[];
  /** 检查身份/路径摘要；作为冻结输入参与摘要，不执行检查。 */
  readonly verificationScope: readonly string[];
  readonly integrationResult: IntegrationExecutionResult | null;
}

export interface IntegrationExecutionPlan extends IntegrationExecutionPlanInput {
  readonly schemaVersion: typeof INTEGRATION_EXECUTION_PLAN_SCHEMA_VERSION;
  readonly integrationId: string;
  readonly inputDigest: string;
  readonly status: IntegrationExecutionPlanStatus;
}

const INPUT_KEYS = [
  'projectId', 'phaseId', 'batchId', 'runId', 'successorFeatureId', 'target', 'predecessors',
  'approvedInputs', 'mergeOrder', 'verificationScope', 'integrationResult',
] as const;
const TARGET_KEYS = ['baseCommit', 'repoIdentity', 'canonicalPath', 'gitCommonDir'] as const;
const APPROVED_INPUT_KEYS = ['inputId', 'digest'] as const;
const PREDECESSOR_KEYS = [
  'projectId', 'phaseId', 'batchId', 'runId', 'featureId', 'dependencyPassed', 'delivery', 'coveredInputIds',
] as const;
const DELIVERY_KEYS = ['commitSha', 'repoIdentity', 'inputDigest', 'evidenceId', 'evidenceDigest'] as const;
const RESULT_KEYS = ['commitSha', 'treeSha', 'inputDigest', 'verificationEvidence'] as const;
const EVIDENCE_KEYS = ['evidenceId', 'evidenceDigest'] as const;

function context(operation = 'IntegrationExecutionPlan.validate'): ValidationContext {
  return { operation, entity: { type: 'feature' } };
}

function fail(ctx: ValidationContext, field: string, message: string, reason = message): never {
  throw new StorageError('validation', ctx.operation, `${ctx.operation}: ${field} ${message}`, {
    entity: ctx.entity,
    details: { field, reason },
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitSha(value: unknown, ctx: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    throw validationError(ctx, field, '必须是 40 或 64 位小写十六进制 Git 对象 ID', value);
  }
  return value;
}

function optionalGitSha(value: unknown, ctx: ValidationContext, field: string): string | null {
  if (value === null || value === undefined) return null;
  return gitSha(value, ctx, field);
}

function boundedText(value: unknown, ctx: ValidationContext, field: string, max = MAX_TEXT_LENGTH): string {
  const text = requireNonEmptyString(value, ctx, field).trim();
  if (text.length > max || CONTROL_PATTERN.test(text)) {
    throw validationError(ctx, field, `必须是 1..${max} 字符且不含控制字符`, value);
  }
  return text;
}

function repoIdentity(value: unknown, ctx: ValidationContext, field: string): string {
  return boundedText(value, ctx, field, MAX_REPO_IDENTITY_LENGTH);
}

function canonicalPath(value: unknown, ctx: ValidationContext, field: string): string {
  const raw = requireNonEmptyString(value, ctx, field);
  if (raw !== raw.trim()) throw validationError(ctx, field, '路径不得包含首尾空白', value);
  const path = boundedText(raw, ctx, field);
  const segments = path.split('/');
  if (!path.startsWith('/') || path === '/' || path.endsWith('/') || segments.includes('.') || segments.includes('..')
    || segments.some((segment, index) => index > 0 && segment.length === 0)) {
    throw validationError(ctx, field, '必须是规范化的绝对路径且不得包含 `.`/`..` 段', value);
  }
  return path;
}

function stringList(value: unknown, ctx: ValidationContext, field: string, max: number, sort: boolean): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw validationError(ctx, field, `必须是最多 ${max} 项的字符串数组`, value);
  }
  const seen = new Set<string>();
  const result = value.map((item, index) => {
    const itemValue = boundedText(item, ctx, `${field}[${index}]`);
    if (seen.has(itemValue)) fail(ctx, `${field}[${index}]`, '不得重复');
    seen.add(itemValue);
    return itemValue;
  });
  return sort ? result.sort(compare) : result;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\n${stableStringify(value)}`, 'utf8').digest('hex');
}

/** 对前置 Feature 实际覆盖的批准输入做稳定摘要。 */
export function computeCoveredInputDigest(inputs: readonly IntegrationApprovedInput[]): string {
  return digest(INTEGRATION_EXECUTION_COVERED_INPUT_DIGEST_DOMAIN,
    [...inputs].map(input => ({ inputId: input.inputId, digest: input.digest })).sort((left, right) => compare(left.inputId, right.inputId)));
}

function target(value: unknown, ctx: ValidationContext): IntegrationExecutionTarget {
  const object = requirePlainObject(value, ctx, 'target');
  rejectUnknownKeys(object, TARGET_KEYS, ctx, 'target');
  return {
    baseCommit: gitSha(object.baseCommit, ctx, 'target.baseCommit'),
    repoIdentity: repoIdentity(object.repoIdentity, ctx, 'target.repoIdentity'),
    canonicalPath: canonicalPath(object.canonicalPath, ctx, 'target.canonicalPath'),
    gitCommonDir: canonicalPath(object.gitCommonDir, ctx, 'target.gitCommonDir'),
  };
}

function approvedInput(value: unknown, index: number, ctx: ValidationContext): IntegrationApprovedInput {
  const field = `approvedInputs[${index}]`;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, APPROVED_INPUT_KEYS, ctx, field);
  return {
    inputId: validateStableId(object.inputId, ctx, `${field}.inputId`),
    digest: validateSha256Digest(object.digest, ctx, `${field}.digest`),
  };
}

function evidence(value: unknown, ctx: ValidationContext, field: string): IntegrationCombinedVerificationEvidence | null {
  if (value === null || value === undefined) return null;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, EVIDENCE_KEYS, ctx, field);
  return {
    evidenceId: validateStableId(object.evidenceId, ctx, `${field}.evidenceId`),
    evidenceDigest: validateSha256Digest(object.evidenceDigest, ctx, `${field}.evidenceDigest`),
  };
}

function delivery(value: unknown, index: number, ctx: ValidationContext): IntegrationDeliverySnapshot | null {
  const field = `predecessors[${index}].delivery`;
  if (value === null || value === undefined) return null;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, DELIVERY_KEYS, ctx, field);
  return {
    commitSha: gitSha(object.commitSha, ctx, `${field}.commitSha`),
    repoIdentity: repoIdentity(object.repoIdentity, ctx, `${field}.repoIdentity`),
    inputDigest: validateSha256Digest(object.inputDigest, ctx, `${field}.inputDigest`),
    evidenceId: validateStableId(object.evidenceId, ctx, `${field}.evidenceId`),
    evidenceDigest: validateSha256Digest(object.evidenceDigest, ctx, `${field}.evidenceDigest`),
  };
}

function predecessor(
  value: unknown,
  index: number,
  root: Pick<IntegrationExecutionPlanInput, 'projectId' | 'phaseId' | 'batchId' | 'runId'>,
  targetValue: IntegrationExecutionTarget,
  approvedById: ReadonlyMap<string, IntegrationApprovedInput>,
  ctx: ValidationContext,
): IntegrationExecutionPredecessor {
  const field = `predecessors[${index}]`;
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, PREDECESSOR_KEYS, ctx, field);
  const projectId = validateStableId(object.projectId, ctx, `${field}.projectId`);
  const phaseId = validateStableId(object.phaseId, ctx, `${field}.phaseId`);
  const batchId = validateStableId(object.batchId, ctx, `${field}.batchId`);
  const runId = validateStableId(object.runId, ctx, `${field}.runId`);
  const featureId = validateStableId(object.featureId, ctx, `${field}.featureId`);
  if (projectId !== root.projectId) fail(ctx, `${field}.projectId`, '必须属于当前 Project', 'cross_project');
  if (phaseId !== root.phaseId) fail(ctx, `${field}.phaseId`, '必须属于当前 Phase', 'cross_phase');
  if (batchId !== root.batchId) fail(ctx, `${field}.batchId`, '必须属于当前 Batch', 'cross_batch');
  if (runId !== root.runId) fail(ctx, `${field}.runId`, '必须属于当前 Run', 'cross_run');
  if (typeof object.dependencyPassed !== 'boolean') {
    throw validationError(ctx, `${field}.dependencyPassed`, '必须是布尔值', object.dependencyPassed);
  }
  if (!object.dependencyPassed) fail(ctx, `${field}.dependencyPassed`, '前置 Feature 尚未通过', 'dependency_not_passed');
  const coveredInputIds = stringList(object.coveredInputIds, ctx, `${field}.coveredInputIds`, MAX_APPROVED_INPUTS, true);
  if (coveredInputIds.length === 0) fail(ctx, `${field}.coveredInputIds`, '不得为空', 'missing_input_coverage');
  const covered = coveredInputIds.map(inputId => {
    const input = approvedById.get(inputId);
    if (input === undefined) fail(ctx, `${field}.coveredInputIds`, '必须引用当前批准输入', 'input_not_approved');
    return input;
  });
  const deliveryValue = delivery(object.delivery, index, ctx);
  if (deliveryValue === null) fail(ctx, `${field}.delivery`, '缺少批准交付证据', 'missing_delivery_evidence');
  if (deliveryValue.repoIdentity !== targetValue.repoIdentity) {
    fail(ctx, `${field}.delivery.repoIdentity`, '必须与集成目标仓库一致', 'repo_identity_mismatch');
  }
  if (deliveryValue.inputDigest !== computeCoveredInputDigest(covered)) {
    fail(ctx, `${field}.delivery.inputDigest`, '不匹配当前批准输入摘要', 'input_digest_mismatch');
  }
  return { projectId, phaseId, batchId, runId, featureId, dependencyPassed: true, delivery: deliveryValue, coveredInputIds };
}

function frozenBody(input: IntegrationExecutionPlanInput): Record<string, unknown> {
  return {
    schemaVersion: INTEGRATION_EXECUTION_PLAN_SCHEMA_VERSION,
    projectId: input.projectId,
    phaseId: input.phaseId,
    batchId: input.batchId,
    runId: input.runId,
    successorFeatureId: input.successorFeatureId,
    target: input.target,
    predecessors: input.predecessors,
    approvedInputs: input.approvedInputs,
    mergeOrder: input.mergeOrder,
    verificationScope: input.verificationScope,
  };
}

function normalize(value: unknown, operation: string): IntegrationExecutionPlanInput {
  const ctx = context(operation);
  const object = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(object, INPUT_KEYS, ctx, 'input');
  const projectId = validateStableId(object.projectId, ctx, 'projectId');
  const phaseId = validateStableId(object.phaseId, ctx, 'phaseId');
  const batchId = validateStableId(object.batchId, ctx, 'batchId');
  const runId = validateStableId(object.runId, ctx, 'runId');
  const successorFeatureId = validateStableId(object.successorFeatureId, ctx, 'successorFeatureId');
  const targetValue = target(object.target, ctx);

  if (!Array.isArray(object.approvedInputs) || object.approvedInputs.length === 0 || object.approvedInputs.length > MAX_APPROVED_INPUTS) {
    throw validationError(ctx, 'approvedInputs', `必须是 1..${MAX_APPROVED_INPUTS} 项数组`, object.approvedInputs);
  }
  const approvedInputs = object.approvedInputs.map((item, index) => approvedInput(item, index, ctx));
  if (new Set(approvedInputs.map(item => item.inputId)).size !== approvedInputs.length) {
    fail(ctx, 'approvedInputs', '输入身份不得重复', 'duplicate_input');
  }
  approvedInputs.sort((left, right) => compare(left.inputId, right.inputId));
  const approvedById = new Map(approvedInputs.map(item => [item.inputId, item]));

  if (!Array.isArray(object.predecessors) || object.predecessors.length === 0 || object.predecessors.length > MAX_PREDECESSORS) {
    throw validationError(ctx, 'predecessors', `必须是 1..${MAX_PREDECESSORS} 项数组`, object.predecessors);
  }
  const rawPredecessors = object.predecessors.map((item, index) => predecessor(
    item, index, { projectId, phaseId, batchId, runId }, targetValue, approvedById, ctx,
  ));
  const featureIds = rawPredecessors.map(item => item.featureId);
  if (new Set(featureIds).size !== featureIds.length) fail(ctx, 'predecessors', '前置 Feature 身份不得重复', 'duplicate_feature');

  const mergeOrder = stringList(object.mergeOrder, ctx, 'mergeOrder', MAX_PREDECESSORS, false);
  if (mergeOrder.length !== featureIds.length || new Set(mergeOrder).size !== mergeOrder.length
    || mergeOrder.some(featureId => !featureIds.includes(featureId))) {
    fail(ctx, 'mergeOrder', '必须一次且仅一次包含全部前置 Feature', 'invalid_merge_order');
  }
  const predecessors = mergeOrder.map(featureId => rawPredecessors.find(item => item.featureId === featureId)!);
  const covered = new Set(predecessors.flatMap(item => item.coveredInputIds));
  if (approvedInputs.some(item => !covered.has(item.inputId))) fail(ctx, 'approvedInputs', '存在未被前置成果覆盖的输入', 'input_coverage_incomplete');
  const verificationScope = stringList(object.verificationScope, ctx, 'verificationScope', MAX_SCOPE_ITEMS, true);

  const resultObject = object.integrationResult;
  let integrationResult: IntegrationExecutionResult | null = null;
  if (resultObject !== null && resultObject !== undefined) {
    const result = requirePlainObject(resultObject, ctx, 'integrationResult');
    rejectUnknownKeys(result, RESULT_KEYS, ctx, 'integrationResult');
    integrationResult = {
      commitSha: optionalGitSha(result.commitSha, ctx, 'integrationResult.commitSha'),
      treeSha: optionalGitSha(result.treeSha, ctx, 'integrationResult.treeSha'),
      inputDigest: validateSha256Digest(result.inputDigest, ctx, 'integrationResult.inputDigest'),
      verificationEvidence: evidence(result.verificationEvidence, ctx, 'integrationResult.verificationEvidence'),
    };
  }
  return {
    projectId, phaseId, batchId, runId, successorFeatureId, target: targetValue,
    predecessors, approvedInputs, mergeOrder, verificationScope, integrationResult,
  };
}

function validateResultAgainstDigest(input: IntegrationExecutionPlanInput, inputDigest: string, ctx: ValidationContext): void {
  const result = input.integrationResult;
  if (result === null) return;
  if (result.inputDigest !== inputDigest) fail(ctx, 'integrationResult.inputDigest', '必须匹配冻结输入摘要', 'input_digest_mismatch');
  const complete = result.commitSha !== null && result.treeSha !== null && result.verificationEvidence !== null;
  const empty = result.commitSha === null && result.treeSha === null && result.verificationEvidence === null;
  if (!complete && !empty) fail(ctx, 'integrationResult', 'commit、tree 和组合验证证据必须同时存在', 'integration_evidence_incomplete');
}

export function validateIntegrationExecutionPlanInput(value: unknown, operation = 'IntegrationExecutionPlan.validate'): IntegrationExecutionPlanInput {
  const normalized = normalize(value, operation);
  const inputDigest = digest(INTEGRATION_EXECUTION_INPUT_DIGEST_DOMAIN, frozenBody(normalized));
  validateResultAgainstDigest(normalized, inputDigest, context(operation));
  return normalized;
}

export function computeIntegrationExecutionInputDigest(value: unknown): string {
  const normalized = normalize(value, 'IntegrationExecutionPlan.digest');
  return digest(INTEGRATION_EXECUTION_INPUT_DIGEST_DOMAIN, frozenBody(normalized));
}

export function computeIntegrationExecutionIdentity(value: unknown): string {
  const normalized = validateIntegrationExecutionPlanInput(value, 'IntegrationExecutionPlan.identity');
  return digest(INTEGRATION_EXECUTION_IDENTITY_DIGEST_DOMAIN, frozenBody(normalized));
}

export function createIntegrationExecutionPlan(value: unknown): IntegrationExecutionPlan {
  const input = validateIntegrationExecutionPlanInput(value);
  const inputDigest = digest(INTEGRATION_EXECUTION_INPUT_DIGEST_DOMAIN, frozenBody(input));
  return {
    ...input,
    schemaVersion: INTEGRATION_EXECUTION_PLAN_SCHEMA_VERSION,
    integrationId: digest(INTEGRATION_EXECUTION_IDENTITY_DIGEST_DOMAIN, frozenBody(input)),
    inputDigest,
    status: input.integrationResult !== null && input.integrationResult.commitSha !== null
      && input.integrationResult.treeSha !== null && input.integrationResult.verificationEvidence !== null
      ? 'integration_passed' : 'dependency_passed',
  };
}

export const validateIntegrationExecutionPlan = validateIntegrationExecutionPlanInput;
