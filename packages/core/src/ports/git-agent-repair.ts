/**
 * P05-8 / F-001：有界 GitAgent 修复授权契约。
 *
 * 本模块只冻结 Core 已保存的集成失败授权和 Runtime 可回传的最小事实，
 * 不执行 Git、文件系统、SQLite、模型或网络操作。GitAgent 不拥有提交、
 * 组合验证、预算结算、锁、审批或 push 权限；这些事实仍由 Core 裁决。
 *
 * 公开输入只使用稳定 ID、摘要和仓库相对路径。绝对工作区路径、凭据、
 * 模型正文、原始堆栈以及 Core 私有状态字段不属于本契约。
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import { stableStringify } from './feature-plan.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateNonNegativeInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';

export const GIT_AGENT_REPAIR_SCHEMA_VERSION = 1 as const;
export const GIT_AGENT_REPAIR_BASELINE_DIGEST_DOMAIN = 'shiploop:git-agent-baseline:v1';
export const GIT_AGENT_REPAIR_AUTHORIZATION_DIGEST_DOMAIN = 'shiploop:git-agent-authorization:v1';
export const GIT_AGENT_REPAIR_COMMAND_DIGEST_DOMAIN = 'shiploop:git-agent-command:v1';
export const GIT_AGENT_REPAIR_MAX_PATHS = 512;
export const GIT_AGENT_REPAIR_MAX_PATH_LENGTH = 512;

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_KINDS = ['conflict', 'combined_verification_failed'] as const;
const RUNTIME_STATUSES = ['modified', 'no_change', 'failed', 'cancelled'] as const;

export type GitAgentRepairFailureKind = typeof FAILURE_KINDS[number];
export type GitAgentRepairRuntimeStatus = typeof RUNTIME_STATUSES[number];

export interface GitAgentRepairFailureSource {
  readonly projectId: string;
  readonly phaseId: string;
  readonly parentBatchId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly integrationId: string;
  readonly operationId: string;
  readonly operationType: 'integration' | 'integration_commit';
  /** Existing GitOperationRecord.intentDigest, not a user supplied failure explanation. */
  readonly operationDigest: string;
  readonly failureKind: GitAgentRepairFailureKind;
  readonly evidenceId: string;
  readonly evidenceDigest: string;
  readonly inputDigest: string;
}

export interface GitAgentRepairTarget {
  readonly repoIdentity: string;
  readonly baselineCommitSha: string;
  /** Digest of the Core-owned repository identity + baseline SHA binding. */
  readonly baselineDigest: string;
}

export interface GitAgentRepairWorkspace {
  readonly workspaceId: string;
  /** Opaque digest of the Core-owned integration workspace facts. */
  readonly workspaceDigest: string;
}

export interface GitAgentRepairArtifactRef {
  readonly intentId: string;
  readonly digest: string;
}

export interface GitAgentRepairVerificationRef {
  readonly strategyId: string;
  readonly digest: string;
}

export interface GitAgentRepairBudget {
  readonly remainingAttempts: number;
  readonly remainingTokens: number;
  readonly remainingRuntimeMs: number;
  readonly deadlineUtcMs: number;
}

export interface GitAgentRepairAuthorizationInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly parentBatchId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly repairId: string;
  readonly commandId: string;
  /** Core-owned persisted conflict/verification failure; never a user explanation. */
  readonly source: GitAgentRepairFailureSource;
  readonly target: GitAgentRepairTarget;
  readonly workspace: GitAgentRepairWorkspace;
  /** Repository-relative exact paths; no absolute paths or directory grants. */
  readonly conflictFiles: readonly string[];
  readonly writablePaths: readonly string[];
  readonly intent: GitAgentRepairArtifactRef;
  readonly verification: GitAgentRepairVerificationRef;
  readonly budget: GitAgentRepairBudget;
}

export interface GitAgentRepairRequest extends GitAgentRepairAuthorizationInput {
  readonly schemaVersion: typeof GIT_AGENT_REPAIR_SCHEMA_VERSION;
  readonly authorizationDigest: string;
  readonly commandDigest: string;
}

export interface GitAgentRepairRuntimeUsage {
  readonly consumedTokens: number;
  readonly runtimeMs: number;
}

/** Runtime 只能报告受限修改和用量；Core 负责验证、提交及最终裁决。 */
export interface GitAgentRepairRuntimeOutput {
  readonly schemaVersion: typeof GIT_AGENT_REPAIR_SCHEMA_VERSION;
  readonly repairId: string;
  readonly status: GitAgentRepairRuntimeStatus;
  readonly changedPaths: readonly string[];
  readonly usage: GitAgentRepairRuntimeUsage;
  readonly failureCode: string | null;
}

const AUTHORIZATION_KEYS = [
  'projectId', 'phaseId', 'parentBatchId', 'featureId', 'runId', 'repairId', 'commandId',
  'source', 'target', 'workspace', 'conflictFiles', 'writablePaths', 'intent', 'verification', 'budget',
] as const;
const REQUEST_KEYS = ['schemaVersion', ...AUTHORIZATION_KEYS, 'authorizationDigest', 'commandDigest'] as const;
const SOURCE_KEYS = [
  'projectId', 'phaseId', 'parentBatchId', 'featureId', 'runId', 'integrationId', 'operationId',
  'operationType', 'operationDigest', 'failureKind', 'evidenceId', 'evidenceDigest', 'inputDigest',
] as const;
const TARGET_KEYS = ['repoIdentity', 'baselineCommitSha', 'baselineDigest'] as const;
const WORKSPACE_KEYS = ['workspaceId', 'workspaceDigest'] as const;
const ARTIFACT_KEYS = ['intentId', 'digest'] as const;
const VERIFICATION_KEYS = ['strategyId', 'digest'] as const;
const BUDGET_KEYS = ['remainingAttempts', 'remainingTokens', 'remainingRuntimeMs', 'deadlineUtcMs'] as const;
const RUNTIME_KEYS = ['schemaVersion', 'repairId', 'status', 'changedPaths', 'usage', 'failureCode'] as const;
const USAGE_KEYS = ['consumedTokens', 'runtimeMs'] as const;

function context(operation: string): ValidationContext {
  return { operation, entity: { type: 'git_operation' } };
}

function fail(ctx: ValidationContext, field: string, reason: string, kind: 'validation' | 'conflict' = 'validation'): never {
  throw new StorageError(kind, ctx.operation, `${ctx.operation}: ${field} is invalid`, {
    entity: ctx.entity,
    details: { field, reason },
  });
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\n${stableStringify(value)}`, 'utf8').digest('hex');
}

function boundedText(value: unknown, ctx: ValidationContext, field: string, max = GIT_AGENT_REPAIR_MAX_PATH_LENGTH): string {
  const text = requireNonEmptyString(value, ctx, field);
  if (text.trim() !== text || text.length > max || CONTROL_PATTERN.test(text)) {
    throw validationError(ctx, field, '必须是有界字符串且不含控制字符');
  }
  return text;
}

function gitSha(value: unknown, ctx: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    throw validationError(ctx, field, '必须是 40 或 64 位小写十六进制 Git 对象 ID');
  }
  return value;
}

function artifact(value: unknown, ctx: ValidationContext, field: string): GitAgentRepairArtifactRef {
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, ARTIFACT_KEYS, ctx, field);
  return {
    intentId: validateStableId(object.intentId, ctx, `${field}.intentId`),
    digest: validateSha256Digest(object.digest, ctx, `${field}.digest`),
  };
}

function verificationArtifact(value: unknown, ctx: ValidationContext, field: string): GitAgentRepairVerificationRef {
  const object = requirePlainObject(value, ctx, field);
  rejectUnknownKeys(object, VERIFICATION_KEYS, ctx, field);
  return {
    strategyId: validateStableId(object.strategyId, ctx, `${field}.strategyId`),
    digest: validateSha256Digest(object.digest, ctx, `${field}.digest`),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function relativePath(value: unknown, ctx: ValidationContext, field: string): string {
  const path = boundedText(value, ctx, field);
  const segments = path.split('/');
  const lower = path.toLowerCase();
  if (path.startsWith('/') || path.includes('\\') || path.endsWith('/') || segments.includes('.') || segments.includes('..')
    || segments.some(segment => segment.length === 0)
    || segments[0] === '.shiploop' || segments[0].startsWith('.shiploop')
    || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3') || lower.endsWith('.db')) {
    fail(ctx, field, 'path_outside_workspace');
  }
  return path;
}

function pathList(value: unknown, ctx: ValidationContext, field: string, required: boolean): string[] {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > GIT_AGENT_REPAIR_MAX_PATHS) {
    throw validationError(ctx, field, `必须是 ${required ? '1' : '0'}..${GIT_AGENT_REPAIR_MAX_PATHS} 项路径数组`);
  }
  const result = value.map((item, index) => relativePath(item, ctx, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail(ctx, field, 'duplicate_path');
  return result.sort();
}

function source(value: unknown, root: Pick<GitAgentRepairAuthorizationInput, 'projectId' | 'phaseId' | 'parentBatchId' | 'featureId' | 'runId'>, ctx: ValidationContext): GitAgentRepairFailureSource {
  if (value === undefined || value === null) fail(ctx, 'source', 'missing_failure_source');
  const object = requirePlainObject(value, ctx, 'source');
  rejectUnknownKeys(object, SOURCE_KEYS, ctx, 'source');
  const projectId = validateStableId(object.projectId, ctx, 'source.projectId');
  const phaseId = validateStableId(object.phaseId, ctx, 'source.phaseId');
  const parentBatchId = validateStableId(object.parentBatchId, ctx, 'source.parentBatchId');
  const featureId = validateStableId(object.featureId, ctx, 'source.featureId');
  const runId = validateStableId(object.runId, ctx, 'source.runId');
  const roots = [
    ['projectId', projectId, root.projectId], ['phaseId', phaseId, root.phaseId],
    ['parentBatchId', parentBatchId, root.parentBatchId], ['featureId', featureId, root.featureId],
    ['runId', runId, root.runId],
  ] as const;
  for (const [field, actual, expected] of roots) {
    if (actual !== expected) fail(ctx, `source.${field}`, field === 'projectId' ? 'cross_project' : 'source_identity_mismatch');
  }
  if (!FAILURE_KINDS.includes(object.failureKind as GitAgentRepairFailureKind)) {
    fail(ctx, 'source.failureKind', 'failure_not_authorized');
  }
  if (object.operationType !== 'integration' && object.operationType !== 'integration_commit') {
    fail(ctx, 'source.operationType', 'source_not_integration');
  }
  return {
    projectId, phaseId, parentBatchId, featureId, runId,
    integrationId: validateStableId(object.integrationId, ctx, 'source.integrationId'),
    operationId: validateStableId(object.operationId, ctx, 'source.operationId'),
    operationType: object.operationType,
    operationDigest: validateSha256Digest(object.operationDigest, ctx, 'source.operationDigest'),
    failureKind: object.failureKind as GitAgentRepairFailureKind,
    evidenceId: validateStableId(object.evidenceId, ctx, 'source.evidenceId'),
    evidenceDigest: validateSha256Digest(object.evidenceDigest, ctx, 'source.evidenceDigest'),
    inputDigest: validateSha256Digest(object.inputDigest, ctx, 'source.inputDigest'),
  };
}

export function computeGitAgentRepairBaselineDigest(target: Pick<GitAgentRepairTarget, 'repoIdentity' | 'baselineCommitSha'>): string {
  return digest(GIT_AGENT_REPAIR_BASELINE_DIGEST_DOMAIN, {
    repoIdentity: target.repoIdentity,
    baselineCommitSha: target.baselineCommitSha,
  });
}

function normalize(value: unknown, options: { readonly nowUtcMs: number }, operation: string): GitAgentRepairAuthorizationInput {
  const ctx = context(operation);
  const object = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(object, AUTHORIZATION_KEYS, ctx, 'input');
  const projectId = validateStableId(object.projectId, ctx, 'projectId');
  const phaseId = validateStableId(object.phaseId, ctx, 'phaseId');
  const parentBatchId = validateStableId(object.parentBatchId, ctx, 'parentBatchId');
  const featureId = validateStableId(object.featureId, ctx, 'featureId');
  const runId = validateStableId(object.runId, ctx, 'runId');
  const repairId = validateStableId(object.repairId, ctx, 'repairId');
  const commandId = validateStableId(object.commandId, ctx, 'commandId');
  const sourceValue = source(object.source, { projectId, phaseId, parentBatchId, featureId, runId }, ctx);

  const targetObject = requirePlainObject(object.target, ctx, 'target');
  rejectUnknownKeys(targetObject, TARGET_KEYS, ctx, 'target');
  const repoIdentity = boundedText(targetObject.repoIdentity, ctx, 'target.repoIdentity', 512);
  const baselineCommitSha = gitSha(targetObject.baselineCommitSha, ctx, 'target.baselineCommitSha');
  const baselineDigest = validateSha256Digest(targetObject.baselineDigest, ctx, 'target.baselineDigest');
  if (computeGitAgentRepairBaselineDigest({ repoIdentity, baselineCommitSha }) !== baselineDigest) {
    fail(ctx, 'target.baselineDigest', 'baseline_digest_mismatch');
  }

  const workspaceObject = requirePlainObject(object.workspace, ctx, 'workspace');
  rejectUnknownKeys(workspaceObject, WORKSPACE_KEYS, ctx, 'workspace');
  const workspace = {
    workspaceId: validateStableId(workspaceObject.workspaceId, ctx, 'workspace.workspaceId'),
    workspaceDigest: validateSha256Digest(workspaceObject.workspaceDigest, ctx, 'workspace.workspaceDigest'),
  };
  const conflictFiles = pathList(object.conflictFiles, ctx, 'conflictFiles', true);
  const writablePaths = pathList(object.writablePaths, ctx, 'writablePaths', true);
  if (conflictFiles.some(path => !writablePaths.includes(path))) fail(ctx, 'conflictFiles', 'conflict_path_not_writable');
  const intent = artifact(object.intent, ctx, 'intent');
  const verification = verificationArtifact(object.verification, ctx, 'verification');

  const budgetObject = requirePlainObject(object.budget, ctx, 'budget');
  rejectUnknownKeys(budgetObject, BUDGET_KEYS, ctx, 'budget');
  const budget = {
    remainingAttempts: validateNonNegativeInteger(budgetObject.remainingAttempts, ctx, 'budget.remainingAttempts'),
    remainingTokens: validateNonNegativeInteger(budgetObject.remainingTokens, ctx, 'budget.remainingTokens'),
    remainingRuntimeMs: validateNonNegativeInteger(budgetObject.remainingRuntimeMs, ctx, 'budget.remainingRuntimeMs'),
    deadlineUtcMs: validateNonNegativeInteger(budgetObject.deadlineUtcMs, ctx, 'budget.deadlineUtcMs'),
  };
  if (budget.remainingAttempts < 1 || budget.remainingTokens < 1 || budget.remainingRuntimeMs < 1) {
    fail(ctx, 'budget', 'budget_exhausted');
  }
  if (budget.deadlineUtcMs <= options.nowUtcMs) fail(ctx, 'budget.deadlineUtcMs', 'deadline_expired');

  return {
    projectId, phaseId, parentBatchId, featureId, runId, repairId, commandId,
    source: sourceValue,
    target: { repoIdentity, baselineCommitSha, baselineDigest },
    workspace, conflictFiles, writablePaths, intent, verification, budget,
  };
}

function authorizationBody(input: GitAgentRepairAuthorizationInput): Record<string, unknown> {
  const { repairId: _repairId, commandId: _commandId, ...body } = input;
  void _repairId;
  void _commandId;
  return body;
}

function commandBody(input: GitAgentRepairAuthorizationInput): Record<string, unknown> {
  return { commandId: input.commandId, authorization: authorizationBody(input) };
}

export function computeGitAgentRepairAuthorizationDigest(input: GitAgentRepairAuthorizationInput): string {
  return digest(GIT_AGENT_REPAIR_AUTHORIZATION_DIGEST_DOMAIN, authorizationBody(input));
}

export function computeGitAgentRepairCommandDigest(input: GitAgentRepairAuthorizationInput): string {
  return digest(GIT_AGENT_REPAIR_COMMAND_DIGEST_DOMAIN, commandBody(input));
}

export function createGitAgentRepairRequest(
  value: unknown,
  options: { readonly nowUtcMs?: number } = {},
): GitAgentRepairRequest {
  const input = normalize(value, { nowUtcMs: options.nowUtcMs ?? Date.now() }, 'GitAgentRepair.create');
  return deepFreeze({
    ...input,
    schemaVersion: GIT_AGENT_REPAIR_SCHEMA_VERSION,
    authorizationDigest: computeGitAgentRepairAuthorizationDigest(input),
    commandDigest: computeGitAgentRepairCommandDigest(input),
  });
}

export function validateGitAgentRepairRequest(
  value: unknown,
  options: { readonly nowUtcMs?: number } = {},
): GitAgentRepairRequest {
  const ctx = context('GitAgentRepair.validate');
  const object = requirePlainObject(value, ctx, 'request');
  rejectUnknownKeys(object, REQUEST_KEYS, ctx, 'request');
  if (object.schemaVersion !== GIT_AGENT_REPAIR_SCHEMA_VERSION) fail(ctx, 'schemaVersion', 'unsupported_schema_version');
  const { schemaVersion: _schemaVersion, authorizationDigest, commandDigest, ...input } = object;
  void _schemaVersion;
  const normalized = normalize(input, { nowUtcMs: options.nowUtcMs ?? Date.now() }, ctx.operation);
  const expectedAuthorizationDigest = computeGitAgentRepairAuthorizationDigest(normalized);
  const expectedCommandDigest = computeGitAgentRepairCommandDigest(normalized);
  if (authorizationDigest !== expectedAuthorizationDigest) fail(ctx, 'authorizationDigest', 'authorization_digest_mismatch');
  if (commandDigest !== expectedCommandDigest) fail(ctx, 'commandDigest', 'command_digest_mismatch');
  return deepFreeze({
    ...normalized,
    schemaVersion: GIT_AGENT_REPAIR_SCHEMA_VERSION,
    authorizationDigest: expectedAuthorizationDigest,
    commandDigest: expectedCommandDigest,
  });
}

/** 同 repairId 或 commandId 的重放必须拥有完全相同的不可变摘要。 */
export function assertSameGitAgentRepairRequest(
  existing: GitAgentRepairRequest,
  candidate: GitAgentRepairRequest,
): boolean {
  const left = validateGitAgentRepairRequest(existing, { nowUtcMs: 0 });
  const right = validateGitAgentRepairRequest(candidate, { nowUtcMs: 0 });
  if (left.repairId === right.repairId && left.commandDigest !== right.commandDigest) {
    fail(context('GitAgentRepair.replay'), 'repairId', 'repair_identity_conflict', 'conflict');
  }
  if (left.commandId === right.commandId && left.commandDigest !== right.commandDigest) {
    fail(context('GitAgentRepair.replay'), 'commandId', 'command_digest_conflict', 'conflict');
  }
  if (left.commandId === right.commandId && left.repairId !== right.repairId) {
    fail(context('GitAgentRepair.replay'), 'commandId', 'command_repair_identity_conflict', 'conflict');
  }
  return left.repairId === right.repairId && left.commandId === right.commandId
    && left.commandDigest === right.commandDigest;
}

export function validateGitAgentRepairRuntimeOutput(
  value: unknown,
  request: GitAgentRepairRequest,
): GitAgentRepairRuntimeOutput {
  const ctx = context('GitAgentRepair.runtimeOutput');
  const object = requirePlainObject(value, ctx, 'output');
  rejectUnknownKeys(object, RUNTIME_KEYS, ctx, 'output');
  if (object.schemaVersion !== GIT_AGENT_REPAIR_SCHEMA_VERSION) fail(ctx, 'schemaVersion', 'unsupported_schema_version');
  const repairId = validateStableId(object.repairId, ctx, 'repairId');
  if (repairId !== request.repairId) fail(ctx, 'repairId', 'repair_identity_mismatch');
  if (!RUNTIME_STATUSES.includes(object.status as GitAgentRepairRuntimeStatus)) fail(ctx, 'status', 'invalid_runtime_status');
  const changedPaths = pathList(object.changedPaths, ctx, 'changedPaths', false);
  if (changedPaths.some(path => !request.writablePaths.includes(path))) fail(ctx, 'changedPaths', 'path_outside_authorized_scope');
  if (object.status === 'modified' && changedPaths.length === 0) fail(ctx, 'changedPaths', 'modified_without_changes');
  if (object.status === 'no_change' && changedPaths.length !== 0) fail(ctx, 'changedPaths', 'no_change_with_changes');

  const usageObject = requirePlainObject(object.usage, ctx, 'usage');
  rejectUnknownKeys(usageObject, USAGE_KEYS, ctx, 'usage');
  const consumedTokens = validateNonNegativeInteger(usageObject.consumedTokens, ctx, 'usage.consumedTokens');
  const runtimeMs = validateNonNegativeInteger(usageObject.runtimeMs, ctx, 'usage.runtimeMs');
  if (consumedTokens > request.budget.remainingTokens || runtimeMs > request.budget.remainingRuntimeMs) {
    fail(ctx, 'usage', 'budget_exhausted');
  }
  const failureCode = object.failureCode === null ? null : boundedText(object.failureCode, ctx, 'failureCode', 64);
  if (failureCode !== null && !REASON_CODE_PATTERN.test(failureCode)) fail(ctx, 'failureCode', 'invalid_failure_code');
  return deepFreeze({
    schemaVersion: GIT_AGENT_REPAIR_SCHEMA_VERSION,
    repairId,
    status: object.status as GitAgentRepairRuntimeStatus,
    changedPaths,
    usage: { consumedTokens, runtimeMs },
    failureCode,
  });
}
