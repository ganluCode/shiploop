/**
 * P06-5 存量仓库接入与基线增量纯契约。
 *
 * 本模块只校验版本化 JSON、计算摘要并比较不可变检查快照。仓库检查、项目注册、
 * TrustedPrincipal 授权、进程监督和制品读取继续由既有端口/应用层负责；这里不读
 * 文件系统、数据库、网络或供应商 SDK，也不执行任何外部命令。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { stableCanonicalJson } from './command-receipts.js';
import { StorageError } from './errors.js';
import { validateStableId } from './validation.js';
import type { ValidationContext } from './validation.js';

export const BROWNFIELD_CONTRACT_SCHEMA_VERSION = 1 as const;
export const BROWNFIELD_DIGEST_DOMAIN = 'shiploop:brownfield:v1:';
export const BROWNFIELD_REPO_IDENTITY_PATTERN = /^gitdir-sha256:[0-9a-f]{64}$/;
export const BROWNFIELD_CHECK_STATUSES = ['passed', 'failed', 'error', 'inconclusive', 'not_run'] as const;
export type BrownfieldCheckStatus = (typeof BROWNFIELD_CHECK_STATUSES)[number];

export const BROWNFIELD_FAILURE_COMPARISONS = [
  'same_failure',
  'different_failure',
  'different_command',
  'indeterminate',
  'not_applicable',
] as const;
export type BrownfieldFailureComparison = (typeof BROWNFIELD_FAILURE_COMPARISONS)[number];

export const BROWNFIELD_CHECK_REASONS = [
  'non_zero_exit',
  'timed_out',
  'cancelled',
  'stop_unconfirmed',
  'tool_unavailable',
  'not_started',
  'spawn_failed',
  'missing_evidence',
] as const;
export type BrownfieldCheckReason = (typeof BROWNFIELD_CHECK_REASONS)[number];

const MAX_CHECKS = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPO_IDENTITY = BROWNFIELD_REPO_IDENTITY_PATTERN;

/** 新契约的所有拒绝均归为 validation，保留结构化 field/reason 且不回显输入值。 */
export class BrownfieldContractError extends StorageError {
  constructor(operation: string, field: string, reason: string) {
    super('validation', operation, `${operation}: ${field} ${reason}`, {
      details: { field, reason },
    });
    this.name = 'BrownfieldContractError';
  }
}

function fail(operation: string, field: string, reason: string): never {
  throw new BrownfieldContractError(operation, field, reason);
}

function object(value: unknown, operation: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(operation, field, '必须是 JSON 对象');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(operation, field, '必须是普通 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], operation: string, field: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) fail(operation, `${field}.${unknown}`, '不是当前 schemaVersion 允许的字段');
}

function required(value: Record<string, unknown>, key: string, operation: string, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return fail(operation, `${field}.${key}`, '为必填字段');
  return value[key];
}

function version(value: unknown, operation: string, field: string): typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION {
  if (value !== BROWNFIELD_CONTRACT_SCHEMA_VERSION) {
    return fail(operation, field, `必须是受支持的 schemaVersion=${BROWNFIELD_CONTRACT_SCHEMA_VERSION}`);
  }
  return BROWNFIELD_CONTRACT_SCHEMA_VERSION;
}

function stableId(value: unknown, operation: string, field: string): string {
  try {
    return validateStableId(value, { operation } satisfies ValidationContext, field);
  } catch {
    return fail(operation, field, '必须是合法稳定 ID');
  }
}

function digest(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) return fail(operation, field, '必须是 64 位小写 SHA-256 摘要');
  return value;
}

function repoIdentity(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !REPO_IDENTITY.test(value)) return fail(operation, field, '必须是 gitdir-sha256 身份');
  return value;
}

function nonEmpty(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    return fail(operation, field, '必须是非空字符串且不得包含 NUL');
  }
  return value;
}

function absolutePath(value: unknown, operation: string, field: string): string {
  const path = nonEmpty(value, operation, field);
  if (!isAbsolute(path)) return fail(operation, field, '必须是绝对路径');
  return path;
}

function boolean(value: unknown, operation: string, field: string): boolean {
  if (typeof value !== 'boolean') return fail(operation, field, '必须是布尔值');
  return value;
}

function integer(value: unknown, operation: string, field: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    return fail(operation, field, `必须是大于等于 ${minimum} 的整数`);
  }
  return value;
}

function commit(value: unknown, operation: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !COMMIT.test(value)) return fail(operation, field, '必须是 40 位小写 commit hash 或 null');
  return value;
}

function stringArray(value: unknown, operation: string, field: string, allowEmpty = true): string[] {
  if (!Array.isArray(value)) return fail(operation, field, '必须是字符串数组');
  if (!allowEmpty && value.length === 0) return fail(operation, field, '不得为空');
  return value.map((entry, index) => nonEmpty(entry, operation, `${field}[${index}]`));
}

function optionalString(value: unknown, operation: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, operation, field);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function domainDigest(domain: string, value: unknown): string {
  return sha256(`${BROWNFIELD_DIGEST_DOMAIN}${domain}:${stableCanonicalJson(value)}`);
}

export interface BrownfieldBindingRef {
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly bindingRevision: number;
  readonly repoIdentity: string;
}

export interface BrownfieldRepositoryFacts {
  readonly canonicalPath: string;
  readonly repoIdentity: string;
  readonly headCommit: string | null;
  readonly hasInitialCommit: boolean;
  readonly hasUncommittedChanges: boolean;
  readonly workingTreeDigest: string;
}

export interface BrownfieldCodeIdentity {
  readonly repoIdentity: string;
  readonly headCommit: string | null;
  readonly workingTreeDigest: string;
  readonly hasUncommittedChanges: boolean;
}

export interface BrownfieldMovePreviewInput {
  readonly schemaVersion: typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly oldBinding: BrownfieldBindingRef;
  readonly newRepository: BrownfieldRepositoryFacts;
}

export interface BrownfieldMovePreview extends BrownfieldMovePreviewInput {
  readonly previewDigest: string;
  readonly requiresExplicitConfirmation: true;
  readonly identityRelation: 'same' | 'different';
}

export interface BrownfieldMoveConfirmation {
  readonly schemaVersion: typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly oldBinding: BrownfieldBindingRef;
  readonly previewDigest: string;
  readonly decision: 'confirm';
}

export function validateBrownfieldBindingRef(input: unknown, operation = 'brownfield.binding', field = 'binding'): BrownfieldBindingRef {
  const value = object(input, operation, field);
  exactKeys(value, ['projectId', 'repositoryBindingId', 'bindingRevision', 'repoIdentity'], operation, field);
  return {
    projectId: stableId(required(value, 'projectId', operation, field), operation, `${field}.projectId`),
    repositoryBindingId: stableId(required(value, 'repositoryBindingId', operation, field), operation, `${field}.repositoryBindingId`),
    bindingRevision: integer(required(value, 'bindingRevision', operation, field), operation, `${field}.bindingRevision`),
    repoIdentity: repoIdentity(required(value, 'repoIdentity', operation, field), operation, `${field}.repoIdentity`),
  };
}

export function validateBrownfieldRepositoryFacts(input: unknown, operation = 'brownfield.repository', field = 'repository'): BrownfieldRepositoryFacts {
  const value = object(input, operation, field);
  exactKeys(value, ['canonicalPath', 'repoIdentity', 'headCommit', 'hasInitialCommit', 'hasUncommittedChanges', 'workingTreeDigest'], operation, field);
  const canonicalPath = absolutePath(required(value, 'canonicalPath', operation, field), operation, `${field}.canonicalPath`);
  const repoIdentityValue = repoIdentity(required(value, 'repoIdentity', operation, field), operation, `${field}.repoIdentity`);
  const headCommit = commit(required(value, 'headCommit', operation, field), operation, `${field}.headCommit`);
  const hasInitialCommit = boolean(required(value, 'hasInitialCommit', operation, field), operation, `${field}.hasInitialCommit`);
  const hasUncommittedChanges = boolean(required(value, 'hasUncommittedChanges', operation, field), operation, `${field}.hasUncommittedChanges`);
  if ((headCommit !== null) !== hasInitialCommit) fail(operation, `${field}.hasInitialCommit`, '必须与 headCommit 是否存在一致');
  return {
    canonicalPath,
    repoIdentity: repoIdentityValue,
    headCommit,
    hasInitialCommit,
    hasUncommittedChanges,
    workingTreeDigest: digest(required(value, 'workingTreeDigest', operation, field), operation, `${field}.workingTreeDigest`),
  };
}

function movePreviewBase(input: unknown, operation: string): BrownfieldMovePreviewInput {
  const value = object(input, operation, 'payload');
  exactKeys(value, ['schemaVersion', 'projectId', 'oldBinding', 'newRepository'], operation, 'payload');
  version(required(value, 'schemaVersion', operation, 'payload'), operation, 'payload.schemaVersion');
  const projectId = stableId(required(value, 'projectId', operation, 'payload'), operation, 'payload.projectId');
  const oldBinding = validateBrownfieldBindingRef(required(value, 'oldBinding', operation, 'payload'), operation, 'payload.oldBinding');
  if (oldBinding.projectId !== projectId) fail(operation, 'payload.oldBinding.projectId', '必须与 payload.projectId 相同');
  const newRepository = validateBrownfieldRepositoryFacts(required(value, 'newRepository', operation, 'payload'), operation, 'payload.newRepository');
  return { schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION, projectId, oldBinding, newRepository };
}

export function computeBrownfieldMovePreviewDigest(input: BrownfieldMovePreviewInput): string {
  const normalized = movePreviewBase(input, 'brownfield.move.preview');
  return domainDigest('move-preview', normalized);
}

export function createBrownfieldMovePreview(input: unknown): BrownfieldMovePreview {
  const normalized = movePreviewBase(input, 'brownfield.move.preview');
  return {
    ...normalized,
    previewDigest: computeBrownfieldMovePreviewDigest(normalized),
    requiresExplicitConfirmation: true,
    identityRelation: normalized.oldBinding.repoIdentity === normalized.newRepository.repoIdentity ? 'same' : 'different',
  };
}

export function validateBrownfieldMovePreview(input: unknown): BrownfieldMovePreview {
  const value = object(input, 'brownfield.move.preview', 'payload');
  exactKeys(value, ['schemaVersion', 'projectId', 'oldBinding', 'newRepository', 'previewDigest', 'requiresExplicitConfirmation', 'identityRelation'], 'brownfield.move.preview', 'payload');
  const normalized = movePreviewBase({
    schemaVersion: value.schemaVersion,
    projectId: value.projectId,
    oldBinding: value.oldBinding,
    newRepository: value.newRepository,
  }, 'brownfield.move.preview');
  const previewDigest = digest(required(value, 'previewDigest', 'brownfield.move.preview', 'payload'), 'brownfield.move.preview', 'payload.previewDigest');
  if (previewDigest !== computeBrownfieldMovePreviewDigest(normalized)) fail('brownfield.move.preview', 'payload.previewDigest', '与只读预览内容不匹配');
  if (value.requiresExplicitConfirmation !== true) fail('brownfield.move.preview', 'payload.requiresExplicitConfirmation', '必须为 true');
  const identityRelation = value.identityRelation;
  const expectedRelation = normalized.oldBinding.repoIdentity === normalized.newRepository.repoIdentity ? 'same' : 'different';
  if (identityRelation !== expectedRelation) fail('brownfield.move.preview', 'payload.identityRelation', '与新旧 repoIdentity 不匹配');
  return { ...normalized, previewDigest, requiresExplicitConfirmation: true, identityRelation: expectedRelation };
}

export function validateBrownfieldMoveConfirmation(input: unknown, preview?: BrownfieldMovePreview): BrownfieldMoveConfirmation {
  const operation = 'brownfield.move.confirm';
  const value = object(input, operation, 'payload');
  exactKeys(value, ['schemaVersion', 'projectId', 'oldBinding', 'previewDigest', 'decision'], operation, 'payload');
  version(required(value, 'schemaVersion', operation, 'payload'), operation, 'payload.schemaVersion');
  const projectId = stableId(required(value, 'projectId', operation, 'payload'), operation, 'payload.projectId');
  const oldBinding = validateBrownfieldBindingRef(required(value, 'oldBinding', operation, 'payload'), operation, 'payload.oldBinding');
  if (oldBinding.projectId !== projectId) fail(operation, 'payload.oldBinding.projectId', '必须与 payload.projectId 相同');
  const previewDigest = digest(required(value, 'previewDigest', operation, 'payload'), operation, 'payload.previewDigest');
  if (value.decision !== 'confirm') fail(operation, 'payload.decision', '必须是 confirm，移动不能隐式确认');
  if (preview !== undefined) {
    const checked = validateBrownfieldMovePreview(preview);
    if (checked.projectId !== projectId) fail(operation, 'payload.projectId', '必须与预览属于同一项目');
    if (checked.oldBinding.repositoryBindingId !== oldBinding.repositoryBindingId) fail(operation, 'payload.oldBinding.repositoryBindingId', '必须与预览中的旧绑定身份完全一致');
    if (checked.oldBinding.bindingRevision !== oldBinding.bindingRevision) fail(operation, 'payload.oldBinding.bindingRevision', '必须与预览中的旧 bindingRevision 一致');
    if (checked.oldBinding.repoIdentity !== oldBinding.repoIdentity) fail(operation, 'payload.oldBinding.repoIdentity', '必须与预览中的旧 repoIdentity 一致');
    if (checked.previewDigest !== previewDigest) fail(operation, 'payload.previewDigest', '必须与用户确认的预览摘要一致');
  }
  return { schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION, projectId, oldBinding, previewDigest, decision: 'confirm' };
}

export interface BrownfieldCheckDefinition {
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef?: string;
  readonly environmentIdentity: string;
  readonly timeoutMs: number;
  readonly required: boolean;
}

export interface BrownfieldCheckResult {
  readonly status: BrownfieldCheckStatus;
  readonly reasonCode?: BrownfieldCheckReason;
  readonly exitCode?: number;
  readonly evidenceRefs: readonly string[];
  readonly failureCaseIds?: readonly string[];
}

export interface BrownfieldCheckSnapshot {
  readonly check: BrownfieldCheckDefinition;
  readonly commandDigest: string;
  readonly result: BrownfieldCheckResult;
}

export interface BrownfieldBaselineState {
  readonly schemaVersion: typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly binding: BrownfieldBindingRef;
  readonly codeIdentity: BrownfieldCodeIdentity;
  readonly checks: readonly BrownfieldCheckSnapshot[];
  readonly historicalEvidenceRefs: readonly string[];
}

export interface BrownfieldComparisonInput {
  readonly schemaVersion: typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly old: BrownfieldBaselineState;
  readonly current: BrownfieldBaselineState;
}

export interface BrownfieldComparableResult {
  readonly status: BrownfieldCheckStatus;
  readonly reasonCode?: BrownfieldCheckReason;
  readonly exitCode?: number;
  readonly evidenceRefs: readonly string[];
  readonly failureCaseIds?: readonly string[];
  readonly commandDigest: string;
}

export interface BrownfieldComparisonRow {
  readonly checkKey: string;
  readonly old: BrownfieldComparableResult | null;
  readonly current: BrownfieldComparableResult | null;
  readonly failureComparison: BrownfieldFailureComparison;
}

export interface BrownfieldComparisonResult {
  readonly schemaVersion: typeof BROWNFIELD_CONTRACT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly oldCodeIdentity: BrownfieldCodeIdentity;
  readonly newCodeIdentity: BrownfieldCodeIdentity;
  readonly checks: readonly BrownfieldComparisonRow[];
  readonly historicalEvidenceRefs: readonly string[];
}

export function validateBrownfieldCheckDefinition(input: unknown, operation = 'brownfield.check', field = 'check'): BrownfieldCheckDefinition {
  const value = object(input, operation, field);
  exactKeys(value, ['checkKey', 'argv', 'cwdRef', 'environmentIdentity', 'timeoutMs', 'required'], operation, field);
  const checkKey = stableId(required(value, 'checkKey', operation, field), operation, `${field}.checkKey`);
  const argv = stringArray(required(value, 'argv', operation, field), operation, `${field}.argv`, false);
  const cwdRef = optionalString(value.cwdRef, operation, `${field}.cwdRef`);
  if (cwdRef !== undefined && (isAbsolute(cwdRef) || cwdRef === '.' || cwdRef.startsWith('../') || cwdRef.includes('/../') || cwdRef.includes('\\'))) {
    fail(operation, `${field}.cwdRef`, '必须是仓库内相对目录引用');
  }
  return {
    checkKey,
    argv,
    ...(cwdRef === undefined ? {} : { cwdRef }),
    environmentIdentity: digest(required(value, 'environmentIdentity', operation, field), operation, `${field}.environmentIdentity`),
    timeoutMs: integer(required(value, 'timeoutMs', operation, field), operation, `${field}.timeoutMs`),
    required: boolean(required(value, 'required', operation, field), operation, `${field}.required`),
  };
}

export function computeBrownfieldCheckCommandDigest(input: BrownfieldCheckDefinition): string {
  const check = validateBrownfieldCheckDefinition(input, 'brownfield.check.digest', 'check');
  return domainDigest('check-command', {
    checkKey: check.checkKey,
    argv: [...check.argv],
    cwdRef: check.cwdRef ?? null,
    environmentIdentity: check.environmentIdentity,
    timeoutMs: check.timeoutMs,
    required: check.required,
  });
}

function validateBrownfieldCheckResult(input: unknown, operation: string, field: string): BrownfieldCheckResult {
  const value = object(input, operation, field);
  exactKeys(value, ['status', 'reasonCode', 'exitCode', 'evidenceRefs', 'failureCaseIds'], operation, field);
  const status = value.status;
  if (typeof status !== 'string' || !(BROWNFIELD_CHECK_STATUSES as readonly string[]).includes(status)) fail(operation, `${field}.status`, '不是受支持的检查状态');
  const evidenceRefs = stringArray(required(value, 'evidenceRefs', operation, field), operation, `${field}.evidenceRefs`);
  const reasonCode = value.reasonCode === undefined ? undefined : value.reasonCode;
  if (reasonCode !== undefined && !(BROWNFIELD_CHECK_REASONS as readonly string[]).includes(reasonCode as string)) fail(operation, `${field}.reasonCode`, '不是受支持的诊断原因');
  const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode, operation, `${field}.exitCode`, 0);
  const failureCaseIds = value.failureCaseIds === undefined ? undefined : stringArray(value.failureCaseIds, operation, `${field}.failureCaseIds`);
  if (status === 'passed' && (reasonCode !== undefined || exitCode !== undefined)) fail(operation, field, 'passed 不得携带失败诊断');
  if (status === 'failed' && reasonCode !== 'non_zero_exit') fail(operation, `${field}.reasonCode`, 'failed 必须保留 non_zero_exit 诊断');
  if (status === 'inconclusive' && !['timed_out', 'cancelled', 'stop_unconfirmed'].includes(reasonCode as string)) fail(operation, `${field}.reasonCode`, 'inconclusive 必须保留超时、取消或停止核验诊断');
  if (status === 'not_run' && !['tool_unavailable', 'not_started'].includes(reasonCode as string)) fail(operation, `${field}.reasonCode`, 'not_run 必须说明未执行原因');
  if (status === 'failed' && (exitCode === undefined || exitCode === 0)) fail(operation, `${field}.exitCode`, '非零退出必须保留非零退出码');
  if (status !== 'failed' && exitCode !== undefined && status !== 'error') fail(operation, `${field}.exitCode`, '只有失败或错误结果可以携带退出码');
  return { status: status as BrownfieldCheckStatus, ...(reasonCode === undefined ? {} : { reasonCode: reasonCode as BrownfieldCheckReason }), ...(exitCode === undefined ? {} : { exitCode }), evidenceRefs, ...(failureCaseIds === undefined ? {} : { failureCaseIds }) };
}

function validateCodeIdentity(input: unknown, operation: string, field: string): BrownfieldCodeIdentity {
  const value = object(input, operation, field);
  exactKeys(value, ['repoIdentity', 'headCommit', 'workingTreeDigest', 'hasUncommittedChanges'], operation, field);
  return {
    repoIdentity: repoIdentity(required(value, 'repoIdentity', operation, field), operation, `${field}.repoIdentity`),
    headCommit: commit(required(value, 'headCommit', operation, field), operation, `${field}.headCommit`),
    workingTreeDigest: digest(required(value, 'workingTreeDigest', operation, field), operation, `${field}.workingTreeDigest`),
    hasUncommittedChanges: boolean(required(value, 'hasUncommittedChanges', operation, field), operation, `${field}.hasUncommittedChanges`),
  };
}

function validateEvidenceRefs(input: unknown, operation: string, field: string): string[] {
  return stringArray(input, operation, field);
}

function validateCheckSnapshot(input: unknown, operation: string, field: string): BrownfieldCheckSnapshot {
  const value = object(input, operation, field);
  exactKeys(value, ['check', 'commandDigest', 'result'], operation, field);
  const check = validateBrownfieldCheckDefinition(required(value, 'check', operation, field), operation, `${field}.check`);
  const commandDigest = digest(required(value, 'commandDigest', operation, field), operation, `${field}.commandDigest`);
  if (commandDigest !== computeBrownfieldCheckCommandDigest(check)) fail(operation, `${field}.commandDigest`, '与获准 command/cwd/environment identity 不匹配');
  return { check, commandDigest, result: validateBrownfieldCheckResult(required(value, 'result', operation, field), operation, `${field}.result`) };
}

export function validateBrownfieldBaselineState(input: unknown): BrownfieldBaselineState {
  const operation = 'brownfield.baseline.state';
  const value = object(input, operation, 'state');
  exactKeys(value, ['schemaVersion', 'projectId', 'binding', 'codeIdentity', 'checks', 'historicalEvidenceRefs'], operation, 'state');
  version(required(value, 'schemaVersion', operation, 'state'), operation, 'state.schemaVersion');
  const projectId = stableId(required(value, 'projectId', operation, 'state'), operation, 'state.projectId');
  const binding = validateBrownfieldBindingRef(required(value, 'binding', operation, 'state'), operation, 'state.binding');
  if (binding.projectId !== projectId) fail(operation, 'state.binding.projectId', '必须与 state.projectId 相同');
  const codeIdentity = validateCodeIdentity(required(value, 'codeIdentity', operation, 'state'), operation, 'state.codeIdentity');
  if (codeIdentity.repoIdentity !== binding.repoIdentity) fail(operation, 'state.codeIdentity.repoIdentity', '必须与绑定 repoIdentity 相同');
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) fail(operation, 'state.checks', `必须是最多 ${MAX_CHECKS} 项的数组`);
  const checks = value.checks.map((entry, index) => validateCheckSnapshot(entry, operation, `state.checks[${index}]`));
  const seen = new Set<string>();
  for (const [index, entry] of checks.entries()) {
    if (seen.has(entry.check.checkKey)) fail(operation, `state.checks[${index}].check.checkKey`, '同一基线不得重复');
    seen.add(entry.check.checkKey);
  }
  return {
    schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
    projectId,
    binding,
    codeIdentity,
    checks,
    historicalEvidenceRefs: validateEvidenceRefs(required(value, 'historicalEvidenceRefs', operation, 'state'), operation, 'state.historicalEvidenceRefs'),
  };
}

export function deriveUnavailableBrownfieldCheck(check: BrownfieldCheckDefinition, reasonCode: 'tool_unavailable' | 'not_started'): BrownfieldCheckSnapshot {
  const normalized = validateBrownfieldCheckDefinition(check, 'brownfield.check.unavailable', 'check');
  return {
    check: normalized,
    commandDigest: computeBrownfieldCheckCommandDigest(normalized),
    result: { status: 'not_run', reasonCode, evidenceRefs: [] },
  };
}

function comparable(snapshot: BrownfieldCheckSnapshot): BrownfieldComparableResult {
  return { ...snapshot.result, commandDigest: snapshot.commandDigest };
}

function failureComparison(oldResult: BrownfieldComparableResult | null, currentResult: BrownfieldComparableResult | null): BrownfieldFailureComparison {
  if (oldResult === null || currentResult === null || oldResult.status !== 'failed' || currentResult.status !== 'failed') return 'not_applicable';
  if (oldResult.commandDigest !== currentResult.commandDigest) return 'different_command';
  const oldCases = oldResult.failureCaseIds;
  const currentCases = currentResult.failureCaseIds;
  if (oldCases === undefined || currentCases === undefined) return 'indeterminate';
  const a = [...oldCases].sort();
  const b = [...currentCases].sort();
  return JSON.stringify(a) === JSON.stringify(b) ? 'same_failure' : 'different_failure';
}

function stateForComparison(input: unknown, operation: string, field: string): BrownfieldBaselineState {
  try {
    return validateBrownfieldBaselineState(input);
  } catch (error) {
    if (error instanceof BrownfieldContractError) throw error;
    return fail(operation, field, '基线状态非法');
  }
}

export function compareBrownfieldBaseline(input: unknown): BrownfieldComparisonResult {
  const operation = 'brownfield.baseline.compare';
  const value = object(input, operation, 'payload');
  exactKeys(value, ['schemaVersion', 'projectId', 'old', 'current'], operation, 'payload');
  version(required(value, 'schemaVersion', operation, 'payload'), operation, 'payload.schemaVersion');
  const projectId = stableId(required(value, 'projectId', operation, 'payload'), operation, 'payload.projectId');
  const old = stateForComparison(required(value, 'old', operation, 'payload'), operation, 'payload.old');
  const current = stateForComparison(required(value, 'current', operation, 'payload'), operation, 'payload.current');
  if (old.projectId !== projectId || current.projectId !== projectId) fail(operation, 'payload.projectId', '旧、新基线必须属于同一明确项目');
  const oldByKey = new Map(old.checks.map((entry) => [entry.check.checkKey, entry]));
  const currentByKey = new Map(current.checks.map((entry) => [entry.check.checkKey, entry]));
  const keys = [...new Set([...oldByKey.keys(), ...currentByKey.keys()])].sort();
  const checks = keys.map((checkKey) => {
    const oldEntry = oldByKey.get(checkKey);
    const currentEntry = currentByKey.get(checkKey);
    const oldResult = oldEntry === undefined ? null : comparable(oldEntry);
    const currentResult = currentEntry === undefined ? null : comparable(currentEntry);
    return { checkKey, old: oldResult, current: currentResult, failureComparison: failureComparison(oldResult, currentResult) };
  });
  return {
    schemaVersion: BROWNFIELD_CONTRACT_SCHEMA_VERSION,
    projectId,
    oldCodeIdentity: old.codeIdentity,
    newCodeIdentity: current.codeIdentity,
    checks,
    historicalEvidenceRefs: [...new Set([...old.historicalEvidenceRefs, ...current.historicalEvidenceRefs])],
  };
}
