/**
 * P08-3 存量演示结构化证据封套纯契约。
 *
 * 封套关联源仓库代码身份（基线与当前）、受测提交、检查范围、每项检查的
 * 状态/退出/超时信息、制品引用、工作区保留事实和 remaining gaps。它复用
 * P06-5 brownfield 契约的绑定/检查定义/结果/比较语义（core-design/07 §1、§3），
 * 不把诊断日志当审计真相，也没有单一"成功"字段可供成功文本豁免新检查。
 *
 * 本模块不读文件系统、数据库、网络，不执行命令：
 * - 收集（collect）只在内存里规范化调用方提供的结构化事实，仓库绝对路径仅
 *   用于计算域分隔摘要后立即丢弃，封套永不保存路径本身；
 * - 读取（validate）先做全量脱敏扫描，再核对结构、身份绑定、派生结果与
 *   envelopeDigest；损坏或身份不匹配的封套整体拒绝，不降级读取。
 * 真实 Git/SQLite/Host/进程快照的采集与清理后核验属于 Phase 集成场景，在
 * phaseIntegration 中保持 not_run，不在本契约内伪造或折算为通过。
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { stableCanonicalJson } from './command-receipts.js';
import { StorageError } from './errors.js';
import {
  compareBrownfieldFailureResults,
  computeBrownfieldCheckCommandDigest,
  validateBrownfieldBindingRef,
  validateBrownfieldCheckDefinition,
  validateBrownfieldCheckResult,
  validateBrownfieldCheckSnapshot,
  validateBrownfieldCodeIdentity,
  type BrownfieldCheckDefinition,
  type BrownfieldCheckResult,
  type BrownfieldCheckSnapshot,
  type BrownfieldCodeIdentity,
  type BrownfieldComparableResult,
  type BrownfieldFailureComparison,
} from './brownfield.js';
import { validateStableId } from './validation.js';
import type { ValidationContext } from './validation.js';

export const BROWNFIELD_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const BROWNFIELD_EVIDENCE_KIND = 'shiploop.brownfield.evidence-envelope' as const;
export const BROWNFIELD_EVIDENCE_DIGEST_DOMAIN = 'shiploop:brownfield-evidence:v1:';

/** 单项检查相对基线的判定结果；existing_failure 不得豁免其他检查的新失败。 */
export const BROWNFIELD_EVIDENCE_OUTCOMES = [
  'passed',
  'existing_failure',
  'new_failure',
  'fixed',
  'incomparable',
  'not_run',
] as const;
export type BrownfieldEvidenceOutcome = (typeof BROWNFIELD_EVIDENCE_OUTCOMES)[number];

export const BROWNFIELD_EVIDENCE_GAP_KINDS = [
  'existing_failure',
  'new_failure',
  'required_check_not_run',
  'working_tree_changed',
  'phase_integration_not_run',
] as const;
export type BrownfieldEvidenceGapKind = (typeof BROWNFIELD_EVIDENCE_GAP_KINDS)[number];

export const BROWNFIELD_EVIDENCE_DIRTY_STATES = ['modified_unstaged', 'modified_staged', 'untracked'] as const;
export type BrownfieldEvidenceDirtyState = (typeof BROWNFIELD_EVIDENCE_DIRTY_STATES)[number];

const MAX_CHECKS = 64;
const MAX_ARTIFACTS = 256;
const MAX_DIRTY_FILES = 512;
const MAX_PHASE_SCOPES = 16;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const GAP_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const RELATIVE_REF = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** 原始命令/模型输出与认证字段不允许进入封套（脱敏边界，不是日志过滤器）。 */
const RAW_OUTPUT_FIELDS = new Set(['stdout', 'stderr', 'output', 'rawoutput', 'modeloutput', 'transcript', 'messages']);
const SENSITIVE_FIELDS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'apikey', 'api_key',
  'token', 'access_token', 'password', 'secret', 'credentials', 'privatekey', 'private_key',
]);
const CREDENTIAL_TEXT = /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9]|api[_-]?key\s*[:=]|access[_-]?token\s*[:=]|-----BEGIN\s[A-Z ]*PRIVATE KEY-----)/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** 所有拒绝均归为 validation，保留结构化 field/reason 且不回显被拒绝的值。 */
export class BrownfieldEvidenceError extends StorageError {
  readonly field: string;
  readonly reason: string;

  constructor(operation: string, field: string, reason: string) {
    super('validation', operation, `${operation}: ${field} ${reason}`, {
      details: { field, reason },
    });
    this.name = 'BrownfieldEvidenceError';
    this.field = field;
    this.reason = reason;
  }
}

function fail(operation: string, field: string, reason: string): never {
  throw new BrownfieldEvidenceError(operation, field, reason);
}

const COLLECT_OPERATION = 'brownfield.evidence.collect';
const VALIDATE_OPERATION = 'brownfield.evidence.validate';

function object(value: unknown, operation: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(operation, field, 'must_be_json_object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(operation, field, 'must_be_plain_json_object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], operation: string, field: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) fail(operation, `${field}.${unknown}`, 'field_not_allowed');
}

function required(value: Record<string, unknown>, key: string, operation: string, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return fail(operation, `${field}.${key}`, 'field_required');
  return value[key];
}

function nonEmpty(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    return fail(operation, field, 'must_be_non_empty_string');
  }
  return value;
}

function stableId(value: unknown, operation: string, field: string): string {
  try {
    return validateStableId(value, { operation } satisfies ValidationContext, field);
  } catch {
    return fail(operation, field, 'must_be_stable_id');
  }
}

function digest(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) return fail(operation, field, 'must_be_sha256_digest');
  return value;
}

function commit(value: unknown, operation: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !COMMIT.test(value)) return fail(operation, field, 'must_be_commit_or_null');
  return value;
}

function boolean(value: unknown, operation: string, field: string): boolean {
  if (typeof value !== 'boolean') return fail(operation, field, 'must_be_boolean');
  return value;
}

function integer(value: unknown, operation: string, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return fail(operation, field, `must_be_integer_at_least_${minimum}`);
  }
  return value;
}

function stringArray(value: unknown, operation: string, field: string): string[] {
  if (!Array.isArray(value)) return fail(operation, field, 'must_be_string_array');
  return value.map((entry, index) => nonEmpty(entry, operation, `${field}[${index}]`));
}

/** 唯一且严格升序；读取端用于拒绝乱序/重复，收集端排序后再核对。 */
function assertSortedUnique(values: readonly string[], operation: string, field: string): void {
  if (new Set(values).size !== values.length) fail(operation, field, 'duplicate_entry');
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) fail(operation, field, 'must_be_sorted_ascending');
  }
}

/** 封套内任何字符串都不得携带绝对路径、用户目录引用或凭据文本（写入与读取同一标准）。 */
function assertRedacted(value: unknown, operation: string, field: string): void {
  if (typeof value === 'string') {
    if (isAbsolute(value) || WINDOWS_ABSOLUTE.test(value) || value.startsWith('\\\\') || value.startsWith('file://')) {
      fail(operation, field, 'absolute_path');
    }
    if (value.startsWith('~')) fail(operation, field, 'user_home_reference');
    if (CREDENTIAL_TEXT.test(value)) fail(operation, field, 'credential_text');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertRedacted(child, operation, `${field}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (RAW_OUTPUT_FIELDS.has(lower)) fail(operation, `${field}.${key}`, 'raw_output_field');
      if (SENSITIVE_FIELDS.has(lower)) fail(operation, `${field}.${key}`, 'sensitive_field');
      assertRedacted(child, operation, `${field}.${key}`);
    }
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function domainDigest(domain: string, value: unknown): string {
  return sha256(`${BROWNFIELD_EVIDENCE_DIGEST_DOMAIN}${domain}:${stableCanonicalJson(value)}`);
}

/** 计算封套正文（除 envelopeDigest 外全部字段）的域分隔摘要。 */
export function computeBrownfieldEvidenceDigest(body: unknown): string {
  return domainDigest('envelope', body);
}

/* ------------------------------------------------------------------ *
 * 结构定义
 * ------------------------------------------------------------------ */

/** 绑定身份：与 BrownfieldBindingRef 同源，但仓库路径只保留域分隔摘要。 */
export interface BrownfieldEvidenceProjectBinding {
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly bindingRevision: number;
  readonly repoIdentity: string;
  readonly pathDigest: string;
}

export interface BrownfieldEvidenceDirtyFile {
  readonly path: string;
  readonly state: BrownfieldEvidenceDirtyState;
  readonly digest: string;
}

/** 制品引用保留内容摘要与字节数，读取方可独立复核，不需要原始路径。 */
export interface BrownfieldEvidenceArtifactRef {
  readonly ref: string;
  readonly digest: string;
  readonly bytes: number;
}

/** Phase 集成场景（真实 Git/SQLite/Host/进程快照采集与清理后核验）的未执行声明。 */
export interface BrownfieldEvidencePhaseScope {
  readonly id: string;
  readonly status: 'not_run';
  readonly owner: 'phase-integration';
  readonly reason: string;
}

export interface BrownfieldEvidenceTimeoutInfo {
  readonly limitMs: number;
  readonly timedOut: boolean;
}

/** 单项检查行：基线快照 + 当前结果 + 派生判定，全部可复核。 */
export interface BrownfieldEvidenceCheckRow {
  readonly check: BrownfieldCheckDefinition;
  readonly commandDigest: string;
  readonly baseline: BrownfieldCheckSnapshot | null;
  readonly current: BrownfieldCheckResult;
  readonly outcome: BrownfieldEvidenceOutcome;
  readonly failureComparison: BrownfieldFailureComparison;
  readonly timeout: BrownfieldEvidenceTimeoutInfo;
}

export interface BrownfieldEvidenceGap {
  readonly id: string;
  readonly kind: BrownfieldEvidenceGapKind;
  readonly reason: string;
}

export interface BrownfieldEvidenceSummary {
  readonly checks: number;
  readonly passed: number;
  readonly existingFailure: number;
  readonly newFailure: number;
  readonly fixed: number;
  readonly incomparable: number;
  readonly notRun: number;
}

export interface BrownfieldEvidenceEnvelope {
  readonly schemaVersion: typeof BROWNFIELD_EVIDENCE_SCHEMA_VERSION;
  readonly kind: typeof BROWNFIELD_EVIDENCE_KIND;
  readonly projectId: string;
  readonly binding: BrownfieldEvidenceProjectBinding;
  /** 受测代码提交；必须与 currentCodeIdentity.headCommit 一致。 */
  readonly testCommit: string | null;
  readonly baselineCodeIdentity: BrownfieldCodeIdentity;
  readonly currentCodeIdentity: BrownfieldCodeIdentity;
  readonly checkScope: {
    readonly requiredCheckKeys: readonly string[];
    readonly optionalCheckKeys: readonly string[];
  };
  readonly checks: readonly BrownfieldEvidenceCheckRow[];
  readonly artifacts: readonly BrownfieldEvidenceArtifactRef[];
  readonly workingTreePreservation: {
    readonly status: 'preserved' | 'changed';
    readonly baselineDirtyFiles: readonly BrownfieldEvidenceDirtyFile[];
    readonly currentDirtyFiles: readonly BrownfieldEvidenceDirtyFile[];
  };
  readonly phaseIntegration: readonly BrownfieldEvidencePhaseScope[];
  readonly remainingGaps: readonly BrownfieldEvidenceGap[];
  readonly summary: BrownfieldEvidenceSummary;
  readonly collectedAtUtcMs: number;
  readonly envelopeDigest: string;
}

export interface BrownfieldEvidencePhaseScopeInput {
  readonly id: string;
  readonly reason: string;
}

export interface BrownfieldEvidenceCollectionInput {
  readonly projectId: string;
  /** 真实绑定（含绝对 canonicalPath）；仅用于身份校验和摘要计算，不进入封套。 */
  readonly binding: unknown;
  readonly testCommit: string | null;
  readonly baselineCodeIdentity: BrownfieldCodeIdentity;
  readonly currentCodeIdentity: BrownfieldCodeIdentity;
  readonly checkScope: {
    readonly requiredCheckKeys: readonly string[];
    readonly optionalCheckKeys: readonly string[];
  };
  readonly baselineChecks: readonly BrownfieldCheckSnapshot[];
  readonly currentChecks: readonly BrownfieldCheckSnapshot[];
  readonly artifacts: readonly BrownfieldEvidenceArtifactRef[];
  readonly baselineDirtyFiles: readonly BrownfieldEvidenceDirtyFile[];
  readonly currentDirtyFiles: readonly BrownfieldEvidenceDirtyFile[];
  readonly phaseIntegration: readonly BrownfieldEvidencePhaseScopeInput[];
  readonly collectedAtUtcMs: number;
}

/* ------------------------------------------------------------------ *
 * 派生逻辑
 * ------------------------------------------------------------------ */

function comparableOf(snapshot: BrownfieldCheckSnapshot): BrownfieldComparableResult {
  return { ...snapshot.result, commandDigest: snapshot.commandDigest };
}

/**
 * 依据基线快照与当前快照判定单项检查结果：
 * - not_run：当前未执行；
 * - fixed：基线失败、当前通过；
 * - existing_failure：同一命令下同一组失败用例持续失败；
 * - new_failure：新检查失败、基线通过后失败或失败用例发生变化；
 * - incomparable：命令定义漂移、失败用例缺失、基线不可比或当前不确定。
 */
export function deriveBrownfieldEvidenceOutcome(
  baseline: BrownfieldCheckSnapshot | null,
  current: BrownfieldCheckSnapshot,
): BrownfieldEvidenceOutcome {
  const currentResult = current.result;
  if (currentResult.status === 'not_run') return 'not_run';
  const baselineComparable = baseline === null ? null : comparableOf(baseline);
  const comparison = compareBrownfieldFailureResults(baselineComparable, comparableOf(current));
  if (currentResult.status === 'passed') {
    return baselineComparable !== null && baselineComparable.status === 'failed' ? 'fixed' : 'passed';
  }
  if (currentResult.status === 'failed') {
    switch (comparison) {
      case 'same_failure':
        return 'existing_failure';
      case 'different_failure':
        return 'new_failure';
      case 'different_command':
      case 'indeterminate':
        return 'incomparable';
      case 'not_applicable':
        if (baselineComparable === null) return 'new_failure';
        return baselineComparable.status === 'passed' ? 'new_failure' : 'incomparable';
    }
  }
  return 'incomparable';
}

function timeoutInfoOf(check: BrownfieldCheckDefinition, result: BrownfieldCheckResult): BrownfieldEvidenceTimeoutInfo {
  return {
    limitMs: check.timeoutMs,
    timedOut: result.status === 'inconclusive' && result.reasonCode === 'timed_out',
  };
}

function dirtyFilesPreserved(
  baselineDirtyFiles: readonly BrownfieldEvidenceDirtyFile[],
  currentDirtyFiles: readonly BrownfieldEvidenceDirtyFile[],
): boolean {
  const current = new Map(currentDirtyFiles.map((file) => [file.path, file]));
  return baselineDirtyFiles.every((file) => {
    const after = current.get(file.path);
    return after !== undefined && after.state === file.state && after.digest === file.digest;
  });
}

function deriveGaps(
  rows: readonly BrownfieldEvidenceCheckRow[],
  workingTreeStatus: 'preserved' | 'changed',
  phaseIntegration: readonly BrownfieldEvidencePhaseScope[],
): BrownfieldEvidenceGap[] {
  const gaps: BrownfieldEvidenceGap[] = [];
  for (const row of rows) {
    const checkKey = row.check.checkKey;
    if (row.outcome === 'existing_failure') {
      gaps.push({ id: `known-failure:${checkKey}`, kind: 'existing_failure', reason: 'baseline_failure_unresolved' });
    } else if (row.outcome === 'new_failure') {
      gaps.push({ id: `new-failure:${checkKey}`, kind: 'new_failure', reason: 'new_or_changed_failure' });
    } else if (row.outcome === 'not_run' && row.check.required) {
      gaps.push({
        id: `not-run:${checkKey}`,
        kind: 'required_check_not_run',
        reason: row.current.reasonCode ?? 'not_started',
      });
    }
  }
  if (workingTreeStatus === 'changed') {
    gaps.push({ id: 'working-tree-preservation', kind: 'working_tree_changed', reason: 'baseline_dirty_files_not_preserved' });
  }
  for (const scope of phaseIntegration) {
    gaps.push({ id: `phase:${scope.id}`, kind: 'phase_integration_not_run', reason: scope.reason });
  }
  return gaps;
}

function summarize(rows: readonly BrownfieldEvidenceCheckRow[]): BrownfieldEvidenceSummary {
  const summary: Record<'checks' | 'passed' | 'existingFailure' | 'newFailure' | 'fixed' | 'incomparable' | 'notRun', number> = {
    checks: rows.length,
    passed: 0,
    existingFailure: 0,
    newFailure: 0,
    fixed: 0,
    incomparable: 0,
    notRun: 0,
  };
  for (const row of rows) {
    if (row.outcome === 'passed') summary.passed += 1;
    else if (row.outcome === 'existing_failure') summary.existingFailure += 1;
    else if (row.outcome === 'new_failure') summary.newFailure += 1;
    else if (row.outcome === 'fixed') summary.fixed += 1;
    else if (row.outcome === 'incomparable') summary.incomparable += 1;
    else summary.notRun += 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * 分段校验
 * ------------------------------------------------------------------ */

function validateEnvelopeBinding(input: unknown, operation: string, field: string): BrownfieldEvidenceProjectBinding {
  const value = object(input, operation, field);
  exactKeys(value, ['projectId', 'repositoryBindingId', 'bindingRevision', 'repoIdentity', 'pathDigest'], operation, field);
  return {
    projectId: stableId(required(value, 'projectId', operation, field), operation, `${field}.projectId`),
    repositoryBindingId: stableId(required(value, 'repositoryBindingId', operation, field), operation, `${field}.repositoryBindingId`),
    bindingRevision: integer(required(value, 'bindingRevision', operation, field), operation, `${field}.bindingRevision`, 1),
    repoIdentity: nonEmpty(required(value, 'repoIdentity', operation, field), operation, `${field}.repoIdentity`),
    pathDigest: digest(required(value, 'pathDigest', operation, field), operation, `${field}.pathDigest`),
  };
}

/**
 * 校验检查范围并返回排序副本；requireSorted=false（收集端）只要求唯一，
 * 排序由收集端负责；requireSorted=true（读取端）拒绝乱序输入。
 */
function normalizeCheckScope(
  input: unknown,
  operation: string,
  field: string,
  requireSorted: boolean,
): {
  readonly requiredCheckKeys: readonly string[];
  readonly optionalCheckKeys: readonly string[];
} {
  const value = object(input, operation, field);
  exactKeys(value, ['requiredCheckKeys', 'optionalCheckKeys'], operation, field);
  const parse = (raw: unknown, listField: string): readonly string[] => {
    const keys = stringArray(raw, operation, listField).map((key, index) => stableId(key, operation, `${listField}[${index}]`));
    if (new Set(keys).size !== keys.length) fail(operation, listField, 'duplicate_entry');
    if (requireSorted) assertSortedUnique(keys, operation, listField);
    return [...keys].sort();
  };
  const requiredKeys = parse(required(value, 'requiredCheckKeys', operation, field), `${field}.requiredCheckKeys`);
  const optionalKeys = parse(required(value, 'optionalCheckKeys', operation, field), `${field}.optionalCheckKeys`);
  const overlap = requiredKeys.find((key) => optionalKeys.includes(key));
  if (overlap !== undefined) fail(operation, `${field}.optionalCheckKeys`, 'scope_overlap');
  return { requiredCheckKeys: requiredKeys, optionalCheckKeys: optionalKeys };
}

function validateArtifact(input: unknown, operation: string, field: string): BrownfieldEvidenceArtifactRef {
  const value = object(input, operation, field);
  exactKeys(value, ['ref', 'digest', 'bytes'], operation, field);
  const ref = nonEmpty(required(value, 'ref', operation, field), operation, `${field}.ref`);
  if (!RELATIVE_REF.test(ref)) fail(operation, `${field}.ref`, 'must_be_relative_artifact_ref');
  const digestInput = required(value, 'digest', operation, field);
  if (typeof digestInput !== 'string' || !SHA256.test(digestInput)) {
    fail(operation, `${field}.digest`, 'artifact_digest_invalid');
  }
  return {
    ref,
    digest: digestInput,
    bytes: integer(required(value, 'bytes', operation, field), operation, `${field}.bytes`, 0),
  };
}

function validateDirtyFile(input: unknown, operation: string, field: string): BrownfieldEvidenceDirtyFile {
  const value = object(input, operation, field);
  exactKeys(value, ['path', 'state', 'digest'], operation, field);
  const path = nonEmpty(required(value, 'path', operation, field), operation, `${field}.path`);
  if (!RELATIVE_REF.test(path)) fail(operation, `${field}.path`, 'must_be_relative_file_path');
  const state = required(value, 'state', operation, field);
  if (typeof state !== 'string' || !(BROWNFIELD_EVIDENCE_DIRTY_STATES as readonly string[]).includes(state)) {
    fail(operation, `${field}.state`, 'dirty_state_invalid');
  }
  return {
    path,
    state: state as BrownfieldEvidenceDirtyState,
    digest: digest(required(value, 'digest', operation, field), operation, `${field}.digest`),
  };
}

/** 校验预存改动列表；requireSorted=false 时由调用方排序后返回。 */
function normalizeDirtyFiles(
  input: unknown,
  operation: string,
  field: string,
  requireSorted: boolean,
): readonly BrownfieldEvidenceDirtyFile[] {
  if (!Array.isArray(input) || input.length > MAX_DIRTY_FILES) {
    fail(operation, field, `dirty_files_limit_${MAX_DIRTY_FILES}`);
  }
  const files = input.map((entry, index) => validateDirtyFile(entry, operation, `${field}[${index}]`));
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail(operation, field, 'duplicate_entry');
  if (requireSorted) assertSortedUnique(paths, operation, field);
  return [...files].sort((left, right) => (left.path < right.path ? -1 : 1));
}

function validatePhaseScope(input: unknown, operation: string, field: string): BrownfieldEvidencePhaseScope {
  const value = object(input, operation, field);
  exactKeys(value, ['id', 'status', 'owner', 'reason'], operation, field);
  if (required(value, 'status', operation, field) !== 'not_run') {
    fail(operation, `${field}.status`, 'phase_scope_invalid');
  }
  if (required(value, 'owner', operation, field) !== 'phase-integration') {
    fail(operation, `${field}.owner`, 'phase_scope_invalid');
  }
  return {
    id: stableId(required(value, 'id', operation, field), operation, `${field}.id`),
    status: 'not_run',
    owner: 'phase-integration',
    reason: nonEmpty(required(value, 'reason', operation, field), operation, `${field}.reason`),
  };
}

function validateCheckRow(input: unknown, operation: string, field: string): BrownfieldEvidenceCheckRow {
  const value = object(input, operation, field);
  exactKeys(value, ['check', 'commandDigest', 'baseline', 'current', 'outcome', 'failureComparison', 'timeout'], operation, field);
  const check = validateBrownfieldCheckDefinition(required(value, 'check', operation, field), operation, `${field}.check`);
  const commandDigest = digest(required(value, 'commandDigest', operation, field), operation, `${field}.commandDigest`);
  if (commandDigest !== computeBrownfieldCheckCommandDigest(check)) {
    fail(operation, `${field}.commandDigest`, 'command_digest_mismatch');
  }
  const baselineInput = required(value, 'baseline', operation, field);
  const baseline = baselineInput === null ? null : validateBrownfieldCheckSnapshot(baselineInput, operation, `${field}.baseline`);
  if (baseline !== null && baseline.check.checkKey !== check.checkKey) {
    fail(operation, `${field}.baseline.check.checkKey`, 'baseline_check_key_mismatch');
  }
  const current = validateBrownfieldCheckResult(required(value, 'current', operation, field), operation, `${field}.current`);
  const outcome = required(value, 'outcome', operation, field);
  if (typeof outcome !== 'string' || !(BROWNFIELD_EVIDENCE_OUTCOMES as readonly string[]).includes(outcome)) {
    fail(operation, `${field}.outcome`, 'outcome_invalid');
  }
  const failureComparison = required(value, 'failureComparison', operation, field);
  const baselineComparable = baseline === null ? null : comparableOf(baseline);
  const expectedComparison = compareBrownfieldFailureResults(baselineComparable, { ...current, commandDigest });
  if (failureComparison !== expectedComparison) fail(operation, `${field}.failureComparison`, 'failure_comparison_mismatch');
  if (outcome !== deriveBrownfieldEvidenceOutcome(baseline, { check, commandDigest, result: current })) {
    fail(operation, `${field}.outcome`, 'outcome_mismatch');
  }
  const timeout = object(required(value, 'timeout', operation, field), operation, `${field}.timeout`);
  exactKeys(timeout, ['limitMs', 'timedOut'], operation, `${field}.timeout`);
  const timeoutValue = {
    limitMs: integer(required(timeout, 'limitMs', operation, `${field}.timeout.limitMs`), operation, `${field}.timeout.limitMs`, 1),
    timedOut: boolean(required(timeout, 'timedOut', operation, `${field}.timeout.timedOut`), operation, `${field}.timeout.timedOut`),
  };
  if (timeoutValue.limitMs !== check.timeoutMs || timeoutValue.timedOut !== timeoutInfoOf(check, current).timedOut) {
    fail(operation, `${field}.timeout`, 'timeout_info_mismatch');
  }
  return {
    check,
    commandDigest,
    baseline,
    current,
    outcome: outcome as BrownfieldEvidenceOutcome,
    failureComparison: expectedComparison,
    timeout: timeoutValue,
  };
}

function collectEvidenceRefs(rows: readonly BrownfieldEvidenceCheckRow[]): Set<string> {
  const refs = new Set<string>();
  for (const row of rows) {
    for (const ref of row.current.evidenceRefs) refs.add(ref);
    if (row.baseline !== null) {
      for (const ref of row.baseline.result.evidenceRefs) refs.add(ref);
    }
  }
  return refs;
}

function assertScopeCoverage(
  checkScope: { readonly requiredCheckKeys: readonly string[]; readonly optionalCheckKeys: readonly string[] },
  rowKeys: readonly string[],
  lookup: (key: string) => BrownfieldCheckDefinition | undefined,
  operation: string,
  field: string,
): void {
  const scopedKeys = new Set([...checkScope.requiredCheckKeys, ...checkScope.optionalCheckKeys]);
  for (const key of rowKeys) {
    if (!scopedKeys.has(key)) fail(operation, field, 'scope_mismatch');
  }
  for (const key of scopedKeys) {
    if (!rowKeys.includes(key)) fail(operation, field, 'scope_mismatch');
  }
  for (const key of checkScope.requiredCheckKeys) {
    if (lookup(key)?.required !== true) fail(operation, field, 'scope_required_flag_mismatch');
  }
  for (const key of checkScope.optionalCheckKeys) {
    if (lookup(key)?.required !== false) fail(operation, field, 'scope_required_flag_mismatch');
  }
}

/* ------------------------------------------------------------------ *
 * 收集与读取
 * ------------------------------------------------------------------ */

function buildEnvelope(input: BrownfieldEvidenceCollectionInput, operation: string): BrownfieldEvidenceEnvelope {
  const projectId = stableId(input.projectId, operation, 'projectId');
  const binding = validateBrownfieldBindingRef(input.binding, operation, 'binding');
  if (binding.projectId !== projectId) fail(operation, 'binding.projectId', 'binding_project_mismatch');
  const baselineCodeIdentity = validateBrownfieldCodeIdentity(input.baselineCodeIdentity, operation, 'baselineCodeIdentity');
  const currentCodeIdentity = validateBrownfieldCodeIdentity(input.currentCodeIdentity, operation, 'currentCodeIdentity');
  const testCommit = input.testCommit === null ? null : commit(input.testCommit, operation, 'testCommit');

  if (binding.repoIdentity !== baselineCodeIdentity.repoIdentity || binding.repoIdentity !== currentCodeIdentity.repoIdentity) {
    fail(operation, 'currentCodeIdentity.repoIdentity', 'identity_mismatch');
  }
  if (testCommit !== currentCodeIdentity.headCommit) {
    fail(operation, 'testCommit', 'test_commit_mismatch');
  }

  const checkScope = normalizeCheckScope(input.checkScope, operation, 'checkScope', false);

  if (!Array.isArray(input.baselineChecks) || input.baselineChecks.length > MAX_CHECKS) {
    fail(operation, 'baselineChecks', `checks_limit_${MAX_CHECKS}`);
  }
  if (!Array.isArray(input.currentChecks) || input.currentChecks.length === 0 || input.currentChecks.length > MAX_CHECKS) {
    fail(operation, 'currentChecks', `checks_limit_${MAX_CHECKS}`);
  }
  const baselineByKey = new Map<string, BrownfieldCheckSnapshot>();
  input.baselineChecks.forEach((entry, index) => {
    const snapshot = validateBrownfieldCheckSnapshot(entry, operation, `baselineChecks[${index}]`);
    if (baselineByKey.has(snapshot.check.checkKey)) fail(operation, `baselineChecks[${index}].check.checkKey`, 'duplicate_entry');
    baselineByKey.set(snapshot.check.checkKey, snapshot);
  });
  const currentByKey = new Map<string, BrownfieldCheckSnapshot>();
  input.currentChecks.forEach((entry, index) => {
    const snapshot = validateBrownfieldCheckSnapshot(entry, operation, `currentChecks[${index}]`);
    if (currentByKey.has(snapshot.check.checkKey)) fail(operation, `currentChecks[${index}].check.checkKey`, 'duplicate_entry');
    currentByKey.set(snapshot.check.checkKey, snapshot);
  });
  assertScopeCoverage(
    checkScope,
    [...currentByKey.keys()],
    (key) => currentByKey.get(key)?.check,
    operation,
    'currentChecks',
  );
  for (const key of baselineByKey.keys()) {
    if (!currentByKey.has(key)) fail(operation, 'baselineChecks', 'scope_mismatch');
  }

  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0 || input.artifacts.length > MAX_ARTIFACTS) {
    fail(operation, 'artifacts', `artifacts_limit_${MAX_ARTIFACTS}`);
  }
  const artifacts = input.artifacts.map((entry, index) => validateArtifact(entry, operation, `artifacts[${index}]`));
  const artifactRefs = new Set(artifacts.map((item) => item.ref));
  if (artifactRefs.size !== artifacts.length) fail(operation, 'artifacts', 'duplicate_entry');

  const baselineDirtyFiles = normalizeDirtyFiles(input.baselineDirtyFiles, operation, 'baselineDirtyFiles', false);
  const currentDirtyFiles = normalizeDirtyFiles(input.currentDirtyFiles, operation, 'currentDirtyFiles', false);
  const workingTreeStatus = dirtyFilesPreserved(baselineDirtyFiles, currentDirtyFiles) ? 'preserved' as const : 'changed' as const;

  if (!Array.isArray(input.phaseIntegration) || input.phaseIntegration.length > MAX_PHASE_SCOPES) {
    fail(operation, 'phaseIntegration', `phase_scopes_limit_${MAX_PHASE_SCOPES}`);
  }
  const phaseScopes = input.phaseIntegration.map((entry, index) => {
    const value = object(entry, operation, `phaseIntegration[${index}]`);
    return validatePhaseScope(
      {
        id: required(value, 'id', operation, `phaseIntegration[${index}]`),
        status: 'not_run',
        owner: 'phase-integration',
        reason: required(value, 'reason', operation, `phaseIntegration[${index}]`),
      },
      operation,
      `phaseIntegration[${index}]`,
    );
  });
  if (new Set(phaseScopes.map((scope) => scope.id)).size !== phaseScopes.length) {
    fail(operation, 'phaseIntegration', 'duplicate_entry');
  }

  const collectedAtUtcMs = integer(input.collectedAtUtcMs, operation, 'collectedAtUtcMs', 0);

  const rows = [...currentByKey.values()]
    .sort((left, right) => (left.check.checkKey < right.check.checkKey ? -1 : 1))
    .map((current) => {
      const baseline = baselineByKey.get(current.check.checkKey) ?? null;
      return {
        check: current.check,
        commandDigest: current.commandDigest,
        baseline,
        current: current.result,
        outcome: deriveBrownfieldEvidenceOutcome(baseline, current),
        failureComparison: compareBrownfieldFailureResults(
          baseline === null ? null : comparableOf(baseline),
          comparableOf(current),
        ),
        timeout: timeoutInfoOf(current.check, current.result),
      } satisfies BrownfieldEvidenceCheckRow;
    });

  for (const ref of collectEvidenceRefs(rows)) {
    if (!artifactRefs.has(ref)) fail(operation, 'artifacts', 'artifact_coverage_missing');
  }

  const body = {
    schemaVersion: BROWNFIELD_EVIDENCE_SCHEMA_VERSION,
    kind: BROWNFIELD_EVIDENCE_KIND,
    projectId,
    binding: {
      projectId: binding.projectId,
      repositoryBindingId: binding.repositoryBindingId,
      bindingRevision: binding.bindingRevision,
      repoIdentity: binding.repoIdentity,
      pathDigest: domainDigest('repo-path', binding.canonicalPath),
    },
    testCommit,
    baselineCodeIdentity,
    currentCodeIdentity,
    checkScope,
    checks: rows,
    artifacts: [...artifacts].sort((left, right) => (left.ref < right.ref ? -1 : 1)),
    workingTreePreservation: { status: workingTreeStatus, baselineDirtyFiles, currentDirtyFiles },
    phaseIntegration: [...phaseScopes].sort((left, right) => (left.id < right.id ? -1 : 1)),
    remainingGaps: deriveGaps(rows, workingTreeStatus, phaseScopes),
    summary: summarize(rows),
    collectedAtUtcMs,
  } satisfies Omit<BrownfieldEvidenceEnvelope, 'envelopeDigest'>;
  return { ...body, envelopeDigest: domainDigest('envelope', body) };
}

/**
 * 收集（写入端）：规范化结构化事实并脱敏。仓库绝对路径只参与摘要计算，
 * 绝不进入封套；携带绝对路径/凭据的输入在读取端同一标准下直接拒绝，
 * 不静默改写命令参数。返回值已经过读取端校验自检。
 */
export function collectBrownfieldEvidenceEnvelope(input: unknown): BrownfieldEvidenceEnvelope {
  const operation = COLLECT_OPERATION;
  const value = object(input, operation, 'input');
  exactKeys(value, [
    'projectId', 'binding', 'testCommit', 'baselineCodeIdentity', 'currentCodeIdentity', 'checkScope',
    'baselineChecks', 'currentChecks', 'artifacts', 'baselineDirtyFiles', 'currentDirtyFiles',
    'phaseIntegration', 'collectedAtUtcMs',
  ], operation, 'input');
  const envelope = buildEnvelope(
    {
      projectId: required(value, 'projectId', operation, 'input') as string,
      binding: required(value, 'binding', operation, 'input'),
      testCommit: required(value, 'testCommit', operation, 'input') as string | null,
      baselineCodeIdentity: required(value, 'baselineCodeIdentity', operation, 'input') as BrownfieldCodeIdentity,
      currentCodeIdentity: required(value, 'currentCodeIdentity', operation, 'input') as BrownfieldCodeIdentity,
      checkScope: required(value, 'checkScope', operation, 'input') as BrownfieldEvidenceCollectionInput['checkScope'],
      baselineChecks: required(value, 'baselineChecks', operation, 'input') as BrownfieldCheckSnapshot[],
      currentChecks: required(value, 'currentChecks', operation, 'input') as BrownfieldCheckSnapshot[],
      artifacts: required(value, 'artifacts', operation, 'input') as BrownfieldEvidenceArtifactRef[],
      baselineDirtyFiles: required(value, 'baselineDirtyFiles', operation, 'input') as BrownfieldEvidenceDirtyFile[],
      currentDirtyFiles: required(value, 'currentDirtyFiles', operation, 'input') as BrownfieldEvidenceDirtyFile[],
      phaseIntegration: required(value, 'phaseIntegration', operation, 'input') as BrownfieldEvidencePhaseScopeInput[],
      collectedAtUtcMs: required(value, 'collectedAtUtcMs', operation, 'input') as number,
    },
    operation,
  );
  return validateBrownfieldEvidenceEnvelope(envelope);
}

/**
 * 读取（验证端）：全量脱敏扫描 + 结构校验 + 身份绑定 + 派生字段重算 +
 * envelopeDigest 核对。任一失败整体拒绝，不降级、不修复。
 */
export function validateBrownfieldEvidenceEnvelope(input: unknown): BrownfieldEvidenceEnvelope {
  const operation = VALIDATE_OPERATION;
  const value = object(input, operation, 'envelope');
  assertRedacted(value, operation, 'envelope');
  exactKeys(value, [
    'schemaVersion', 'kind', 'projectId', 'binding', 'testCommit',
    'baselineCodeIdentity', 'currentCodeIdentity', 'checkScope', 'checks', 'artifacts',
    'workingTreePreservation', 'phaseIntegration', 'remainingGaps', 'summary',
    'collectedAtUtcMs', 'envelopeDigest',
  ], operation, 'envelope');
  if (value.schemaVersion !== BROWNFIELD_EVIDENCE_SCHEMA_VERSION) {
    fail(operation, 'envelope.schemaVersion', 'schema_version_invalid');
  }
  if (value.kind !== BROWNFIELD_EVIDENCE_KIND) {
    fail(operation, 'envelope.kind', 'kind_invalid');
  }
  const projectId = stableId(required(value, 'projectId', operation, 'envelope'), operation, 'envelope.projectId');
  const binding = validateEnvelopeBinding(required(value, 'binding', operation, 'envelope'), operation, 'envelope.binding');
  if (binding.projectId !== projectId) fail(operation, 'envelope.binding.projectId', 'binding_project_mismatch');
  const testCommit = commit(required(value, 'testCommit', operation, 'envelope'), operation, 'envelope.testCommit');

  const baselineCodeIdentity = validateBrownfieldCodeIdentity(
    required(value, 'baselineCodeIdentity', operation, 'envelope'), operation, 'envelope.baselineCodeIdentity',
  );
  const currentCodeIdentity = validateBrownfieldCodeIdentity(
    required(value, 'currentCodeIdentity', operation, 'envelope'), operation, 'envelope.currentCodeIdentity',
  );
  if (binding.repoIdentity !== baselineCodeIdentity.repoIdentity || binding.repoIdentity !== currentCodeIdentity.repoIdentity) {
    fail(operation, 'envelope.currentCodeIdentity.repoIdentity', 'identity_mismatch');
  }
  if (testCommit !== currentCodeIdentity.headCommit) {
    fail(operation, 'envelope.testCommit', 'test_commit_mismatch');
  }

  const checkScope = normalizeCheckScope(required(value, 'checkScope', operation, 'envelope'), operation, 'envelope.checkScope', true);

  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > MAX_CHECKS) {
    fail(operation, 'envelope.checks', `checks_limit_${MAX_CHECKS}`);
  }
  const rows = value.checks.map((entry, index) => validateCheckRow(entry, operation, `envelope.checks[${index}]`));
  assertSortedUnique(rows.map((row) => row.check.checkKey), operation, 'envelope.checks');
  assertScopeCoverage(
    checkScope,
    rows.map((row) => row.check.checkKey),
    (key) => rows.find((row) => row.check.checkKey === key)?.check,
    operation,
    'envelope.checks',
  );

  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > MAX_ARTIFACTS) {
    fail(operation, 'envelope.artifacts', `artifacts_limit_${MAX_ARTIFACTS}`);
  }
  const artifacts = value.artifacts.map((entry, index) => validateArtifact(entry, operation, `envelope.artifacts[${index}]`));
  assertSortedUnique(artifacts.map((item) => item.ref), operation, 'envelope.artifacts');
  const artifactRefs = new Set(artifacts.map((item) => item.ref));
  for (const ref of collectEvidenceRefs(rows)) {
    if (!artifactRefs.has(ref)) fail(operation, 'envelope.artifacts', 'artifact_coverage_missing');
  }

  const workingTreeInput = object(
    required(value, 'workingTreePreservation', operation, 'envelope'),
    operation,
    'envelope.workingTreePreservation',
  );
  exactKeys(workingTreeInput, ['status', 'baselineDirtyFiles', 'currentDirtyFiles'], operation, 'envelope.workingTreePreservation');
  const baselineDirtyFiles = normalizeDirtyFiles(
    required(workingTreeInput, 'baselineDirtyFiles', operation, 'envelope.workingTreePreservation'),
    operation,
    'envelope.workingTreePreservation.baselineDirtyFiles',
    true,
  );
  const currentDirtyFiles = normalizeDirtyFiles(
    required(workingTreeInput, 'currentDirtyFiles', operation, 'envelope.workingTreePreservation'),
    operation,
    'envelope.workingTreePreservation.currentDirtyFiles',
    true,
  );
  const expectedStatus = dirtyFilesPreserved(baselineDirtyFiles, currentDirtyFiles) ? 'preserved' : 'changed';
  if (required(workingTreeInput, 'status', operation, 'envelope.workingTreePreservation') !== expectedStatus) {
    fail(operation, 'envelope.workingTreePreservation.status', 'working_tree_status_mismatch');
  }

  if (!Array.isArray(value.phaseIntegration) || value.phaseIntegration.length > MAX_PHASE_SCOPES) {
    fail(operation, 'envelope.phaseIntegration', `phase_scopes_limit_${MAX_PHASE_SCOPES}`);
  }
  const phaseScopes = value.phaseIntegration.map((entry, index) =>
    validatePhaseScope(entry, operation, `envelope.phaseIntegration[${index}]`),
  );
  assertSortedUnique(phaseScopes.map((scope) => scope.id), operation, 'envelope.phaseIntegration');

  if (!Array.isArray(value.remainingGaps)) fail(operation, 'envelope.remainingGaps', 'gap_invalid');
  value.remainingGaps.forEach((entry, index) => {
    const gap = object(entry, operation, `envelope.remainingGaps[${index}]`);
    exactKeys(gap, ['id', 'kind', 'reason'], operation, `envelope.remainingGaps[${index}]`);
    const id = nonEmpty(required(gap, 'id', operation, `envelope.remainingGaps[${index}]`), operation, `envelope.remainingGaps[${index}].id`);
    if (!GAP_ID.test(id)) fail(operation, `envelope.remainingGaps[${index}].id`, 'gap_invalid');
    if (!(BROWNFIELD_EVIDENCE_GAP_KINDS as readonly string[]).includes(required(gap, 'kind', operation, `envelope.remainingGaps[${index}]`) as string)) {
      fail(operation, `envelope.remainingGaps[${index}].kind`, 'gap_invalid');
    }
    nonEmpty(required(gap, 'reason', operation, `envelope.remainingGaps[${index}]`), operation, `envelope.remainingGaps[${index}].reason`);
  });
  const expectedGaps = deriveGaps(rows, expectedStatus, phaseScopes);
  if (stableCanonicalJson(value.remainingGaps) !== stableCanonicalJson(expectedGaps)) {
    fail(operation, 'envelope.remainingGaps', 'gap_mismatch');
  }

  const summaryInput = object(required(value, 'summary', operation, 'envelope'), operation, 'envelope.summary');
  exactKeys(summaryInput, ['checks', 'passed', 'existingFailure', 'newFailure', 'fixed', 'incomparable', 'notRun'], operation, 'envelope.summary');
  for (const key of ['checks', 'passed', 'existingFailure', 'newFailure', 'fixed', 'incomparable', 'notRun']) {
    integer(required(summaryInput, key, operation, 'envelope.summary'), operation, `envelope.summary.${key}`, 0);
  }
  if (stableCanonicalJson(summaryInput) !== stableCanonicalJson(summarize(rows))) {
    fail(operation, 'envelope.summary', 'summary_mismatch');
  }

  const collectedAtUtcMs = integer(
    required(value, 'collectedAtUtcMs', operation, 'envelope'), operation, 'envelope.collectedAtUtcMs', 0,
  );
  const envelopeDigest = digest(required(value, 'envelopeDigest', operation, 'envelope'), operation, 'envelope.envelopeDigest');
  const body: Record<string, unknown> = { ...value };
  delete body.envelopeDigest;
  let recomputed: string;
  try {
    recomputed = domainDigest('envelope', body);
  } catch {
    fail(operation, 'envelope.envelopeDigest', 'envelope_digest_mismatch');
  }
  if (envelopeDigest !== recomputed) {
    fail(operation, 'envelope.envelopeDigest', 'envelope_digest_mismatch');
  }

  return {
    schemaVersion: BROWNFIELD_EVIDENCE_SCHEMA_VERSION,
    kind: BROWNFIELD_EVIDENCE_KIND,
    projectId,
    binding,
    testCommit,
    baselineCodeIdentity,
    currentCodeIdentity,
    checkScope,
    checks: rows,
    artifacts,
    workingTreePreservation: { status: expectedStatus, baselineDirtyFiles, currentDirtyFiles },
    phaseIntegration: phaseScopes,
    remainingGaps: expectedGaps,
    summary: summarize(rows),
    collectedAtUtcMs,
    envelopeDigest,
  };
}
