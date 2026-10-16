/**
 * P03-7 / F-002 VerificationBatch / CheckResult 与不可变验证证据身份（端口，迁移 v21）。
 *
 * VerificationBatch 把针对同一代码状态的一组可信检查归为一个权威边界：批次关联
 * Project/Feature/Run/Task/Attempt/executionVersion 与产生它的 operation，保存代码
 * 身份（codeDigest）、检查定义快照（执行时的 argv/cwd/environment/timeout/required/
 * requirementRefs）、策略身份（policyDigest）、环境身份（environmentSummary）与
 * 选择/回退理由（selection）。CheckResult 逐项保存状态、argv/cwd/timeout 快照（取自
 * 批次快照，调用方不能携带不同定义）、时间、exitCode/signal、输出 Artifact 引用与
 * 有界 tail；未知指标保持 null，不填 0。
 *
 * 不变量：
 * - 批次创建与逐项保存幂等：同身份同内容重放返回既有记录（created=false），同身份
 *   冲突内容一律 conflict；批次/结果身份列不可变，逐项结果整体不可变（不写、不改）；
 * - 大输出正文永不进库：output_artifact_id 只引用同项目 ready Artifact，保存时记录
 *   实测摘要身份（outputDigest）；pending/缺失/failed/摘要不匹配的证据读取为
 *   incomplete 或 none，绝不作为 complete 返回；文件级完整性核对由 artifact-verify
 *   承担，本端口只做索引级身份核验；
 * - running 批次才可补写结果与定版；定版（passed/failed/error/inconclusive）经 CAS
 *   一次性完成且不可回退；passed 要求至少一项结果且全部为 passed（空检查 fail-closed，
 *   更严格的选择/必需性聚合由上层 Verifier 判定，不属于本存储端口）；
 * - 不建设 check_definitions 表（定义存 settings，批次保存快照）与配置/计划版本表；
 *   不改变 Task/Run/Attempt 状态与预算语义。
 */

import {
  rejectUnknownKeys,
  requirePlainObject,
  validateExpectedRevision,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';
import { StorageError } from './errors.js';
import type { CommandTransaction } from './atomic-commands.js';

/** P03-7 / F-002：selection 快照契约版本（固定 v1）。 */
export const VERIFICATION_SELECTION_SCHEMA_VERSION = 1;

export const VERIFICATION_BATCH_STATUSES = ['running', 'passed', 'failed', 'error', 'inconclusive'] as const;
export type VerificationBatchStatus = (typeof VERIFICATION_BATCH_STATUSES)[number];
/** 定版只允许终态（running 为唯一非终态）。 */
export const VERIFICATION_BATCH_TERMINAL_STATUSES = ['passed', 'failed', 'error', 'inconclusive'] as const;
export type VerificationBatchTerminalStatus = (typeof VERIFICATION_BATCH_TERMINAL_STATUSES)[number];

export const CHECK_RESULT_STATUSES = ['passed', 'failed', 'error', 'inconclusive', 'not_run'] as const;
export type CheckResultStatus = (typeof CHECK_RESULT_STATUSES)[number];

export const VERIFICATION_CHECK_SNAPSHOT_MAX_COUNT = 128;
export const VERIFICATION_SELECTION_KEYS_MAX_COUNT = 128;
export const VERIFICATION_OPERATION_MAX_LENGTH = 128;
export const VERIFICATION_REASON_MAX_CODE_POINTS = 500;
export const VERIFICATION_ENVIRONMENT_MAX_JSON_LENGTH = 8192;
export const CHECK_OUTPUT_TAIL_MAX_CODE_POINTS = 8192;
export const CHECK_SIGNAL_MAX_LENGTH = 32;
export const CHECK_TIMEOUT_MIN_MS = 1;
export const CHECK_TIMEOUT_MAX_MS = 3_600_000;

const CHECK_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const CHECK_SCOPES = ['task', 'module', 'project'] as const;
export type VerificationCheckScope = (typeof CHECK_SCOPES)[number];

/** P03-7 / F-002：批次保存的单项检查定义快照（与 F-001 CheckDefinition 同形）。 */
export interface VerificationCheckSnapshotEntry {
  readonly checkKey: string;
  readonly scope: VerificationCheckScope;
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeout: number;
  readonly required: boolean;
  readonly requirementRefs: readonly string[];
}

/** P03-7 / F-002：选择或安全回退理由快照。 */
export interface VerificationSelectionSnapshot {
  readonly schemaVersion: 1;
  readonly mode: 'candidates' | 'full_fallback';
  readonly reason: string;
  readonly selectedCheckKeys: readonly string[];
}

/** P03-7 / F-002：VerificationBatch 记录（与 verification_batches 表逐列对应）。 */
export interface VerificationBatchRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly revision: number;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly operation: string;
  readonly codeDigest: string;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly checkSnapshot: readonly VerificationCheckSnapshotEntry[];
  readonly selection: VerificationSelectionSnapshot;
  readonly status: VerificationBatchStatus;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/** P03-7 / F-002：CheckResult 记录（与 check_results 表逐列对应）。 */
export interface CheckResultRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly revision: number;
  readonly projectId: string;
  readonly batchId: string;
  readonly checkKey: string;
  readonly argv: readonly string[];
  readonly cwdRef: string | null;
  readonly environmentRef: string | null;
  readonly timeoutMs: number;
  readonly required: boolean;
  readonly status: CheckResultStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputArtifactId: string | null;
  readonly outputDigest: string | null;
  readonly outputTail: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

// ---------------------------------------------------------------------------
// 校验辅助
// ---------------------------------------------------------------------------

function boundedText(maxCodePoints: number, options: { readonly allowNewline?: boolean } = {}) {
  return (value: unknown, context: ValidationContext, field: string): string => {
    if (typeof value !== 'string') {
      throw validationError(context, field, `必须是有界文本（≤${maxCodePoints} 码点）`, value);
    }
    const length = [...value].length;
    if (length === 0 || length > maxCodePoints) {
      throw validationError(context, field, `必须是有界文本（1..${maxCodePoints} 码点）`, value);
    }
    const control = options.allowNewline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/;
    if (control.test(value)) {
      throw validationError(context, field, '不得含控制字符', value);
    }
    return value;
  };
}

function validateCheckKey(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || !CHECK_KEY_PATTERN.test(value)) {
    throw validationError(context, field, '必须是小写稳定检查身份（^[a-z][a-z0-9._-]{0,127}$）', value);
  }
  return value;
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], context: ValidationContext, field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw validationError(context, field, `必须是 ${allowed.join(' | ')}`, value);
  }
  return value as T;
}

function validateOptionalEpochMs(value: unknown, context: ValidationContext, field: string): number | null {
  if (value === null || value === undefined) return null;
  return validateNonNegativeInteger(value, context, field);
}

function validateNullableRef(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\0-\x1f\x7f]/.test(value)) {
    throw validationError(context, field, '必须是 null 或有界非空引用字符串', value);
  }
  return value;
}

function validateArgv(value: unknown, context: ValidationContext, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(context, field, '必须是非空 argv 字符串数组（不使用 shell）', value);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.includes('\0')) {
      throw validationError(context, `${field}[${index}]`, '参数必须是非空字符串且不得包含 NUL', item);
    }
    return item;
  });
}

function validateTimeoutMs(value: unknown, context: ValidationContext, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < CHECK_TIMEOUT_MIN_MS ||
    value > CHECK_TIMEOUT_MAX_MS
  ) {
    throw validationError(context, field, `必须是 ${CHECK_TIMEOUT_MIN_MS}..${CHECK_TIMEOUT_MAX_MS} 的整数毫秒`, value);
  }
  return value;
}

const SNAPSHOT_ENTRY_KEYS = [
  'checkKey', 'scope', 'kind', 'argv', 'cwdRef', 'environmentRef', 'timeout', 'required', 'requirementRefs',
] as const;

function validateCheckSnapshot(
  value: unknown,
  context: ValidationContext,
  field: string,
): VerificationCheckSnapshotEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > VERIFICATION_CHECK_SNAPSHOT_MAX_COUNT) {
    throw validationError(context, field, `必须是 1..${VERIFICATION_CHECK_SNAPSHOT_MAX_COUNT} 项定义快照数组`, value);
  }
  const result: VerificationCheckSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(raw, context, itemField);
    rejectUnknownKeys(object, SNAPSHOT_ENTRY_KEYS, context, itemField);
    for (const key of SNAPSHOT_ENTRY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        throw validationError(context, `${itemField}.${key}`, '缺少必填字段');
      }
    }
    const checkKey = validateCheckKey(object.checkKey, context, `${itemField}.checkKey`);
    if (seen.has(checkKey)) {
      throw validationError(context, `${itemField}.checkKey`, '检查身份重复（批次快照内必须唯一）', object.checkKey);
    }
    seen.add(checkKey);
    const scope = validateEnum(object.scope, CHECK_SCOPES, context, `${itemField}.scope`);
    if (object.kind !== 'command') {
      throw validationError(context, `${itemField}.kind`, '当前仅支持 command', object.kind);
    }
    if (typeof object.required !== 'boolean') {
      throw validationError(context, `${itemField}.required`, '必须是布尔值', object.required);
    }
    if (!Array.isArray(object.requirementRefs) || object.requirementRefs.length > 64) {
      throw validationError(context, `${itemField}.requirementRefs`, '必须是 ≤64 项引用数组', object.requirementRefs);
    }
    const requirementRefs = (object.requirementRefs as unknown[]).map((item, refIndex) =>
      boundedText(256)(item, context, `${itemField}.requirementRefs[${refIndex}]`));
    result.push({
      checkKey,
      scope,
      kind: 'command',
      argv: validateArgv(object.argv, context, `${itemField}.argv`),
      cwdRef: validateNullableRef(object.cwdRef, context, `${itemField}.cwdRef`),
      environmentRef: validateNullableRef(object.environmentRef, context, `${itemField}.environmentRef`),
      timeout: validateTimeoutMs(object.timeout, context, `${itemField}.timeout`),
      required: object.required as boolean,
      requirementRefs,
    });
  }
  return result;
}

function validateSelection(
  value: unknown,
  context: ValidationContext,
  field: string,
  snapshot: readonly VerificationCheckSnapshotEntry[],
): VerificationSelectionSnapshot {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['schemaVersion', 'mode', 'reason', 'selectedCheckKeys'], context, field);
  if (object.schemaVersion !== VERIFICATION_SELECTION_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, `不支持的选择快照版本：仅支持 ${VERIFICATION_SELECTION_SCHEMA_VERSION}`, value);
  }
  const mode = validateEnum(object.mode, ['candidates', 'full_fallback'], context, `${field}.mode`);
  const reason = boundedText(VERIFICATION_REASON_MAX_CODE_POINTS)(object.reason, context, `${field}.reason`);
  if (!Array.isArray(object.selectedCheckKeys) || object.selectedCheckKeys.length > VERIFICATION_SELECTION_KEYS_MAX_COUNT) {
    throw validationError(context, `${field}.selectedCheckKeys`, `必须是 ≤${VERIFICATION_SELECTION_KEYS_MAX_COUNT} 项检查身份数组`, value);
  }
  const known = new Set(snapshot.map((entry) => entry.checkKey));
  const selectedCheckKeys: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (object.selectedCheckKeys as unknown[]).entries()) {
    const key = validateCheckKey(item, context, `${field}.selectedCheckKeys[${index}]`);
    if (seen.has(key)) {
      throw validationError(context, `${field}.selectedCheckKeys[${index}]`, '选择身份重复', item);
    }
    if (!known.has(key)) {
      throw validationError(context, `${field}.selectedCheckKeys[${index}]`, '选择了快照之外的检查身份', item);
    }
    seen.add(key);
    selectedCheckKeys.push(key);
  }
  return { schemaVersion: VERIFICATION_SELECTION_SCHEMA_VERSION, mode, reason, selectedCheckKeys };
}

function validateEnvironmentSummary(
  value: unknown,
  context: ValidationContext,
  field: string,
): Readonly<Record<string, unknown>> {
  const object = requirePlainObject(value, context, field);
  let serialized: string;
  try {
    serialized = JSON.stringify(object);
  } catch {
    throw validationError(context, field, '必须是可 JSON 序列化的环境身份对象', value);
  }
  if (serialized === undefined || serialized.length > VERIFICATION_ENVIRONMENT_MAX_JSON_LENGTH) {
    throw validationError(context, field, `环境身份 JSON 必须 ≤${VERIFICATION_ENVIRONMENT_MAX_JSON_LENGTH} 字符`, value);
  }
  return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
}

function validateOutputTail(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(CHECK_OUTPUT_TAIL_MAX_CODE_POINTS, { allowNewline: true })(value, context, field);
}

function validateOptionalSignal(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(CHECK_SIGNAL_MAX_LENGTH)(value, context, field);
}

function validateOptionalExitCode(value: unknown, context: ValidationContext, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw validationError(context, field, '必须是整数退出码或 null（未知不填 0）', value);
  }
  return value;
}

function validateOptionalArtifactId(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null || value === undefined) return null;
  return validateStableId(value, context, field);
}

function validateOptionalDigest(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null || value === undefined) return null;
  return validateSha256Digest(value, context, field);
}

/** 逐项结果状态形状（与 check_results DDL 一致；record 与 save 输入共用）。 */
function assertResultShape(
  shape: {
    readonly status: CheckResultStatus;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly startedAtUtcMs: number | null;
    readonly endedAtUtcMs: number | null;
  },
  context: ValidationContext,
  field: string,
): void {
  const shapeError = (reason: string): never => {
    throw validationError(context, field, `非法检查结果形状（status=${shape.status}）：${reason}`);
  };
  if (shape.status === 'not_run') {
    if (shape.exitCode !== null || shape.signal !== null || shape.timedOut
      || shape.startedAtUtcMs !== null || shape.endedAtUtcMs !== null) {
      shapeError('not_run 不得携带退出码/信号/超时/时间');
    }
  }
  if (shape.status === 'passed' && (shape.exitCode !== 0 || shape.timedOut)) {
    shapeError('passed 必须是 exitCode=0 且未超时');
  }
  if (shape.timedOut && shape.status !== 'failed' && shape.status !== 'error') {
    shapeError('超时只允许 failed/error');
  }
  if (shape.startedAtUtcMs !== null && shape.endedAtUtcMs !== null && shape.endedAtUtcMs < shape.startedAtUtcMs) {
    shapeError('endedAtUtcMs 不得早于 startedAtUtcMs');
  }
}

// ---------------------------------------------------------------------------
// 记录校验（行读取 fail-closed）
// ---------------------------------------------------------------------------

const BATCH_RECORD_KEYS = [
  'id', 'createdAtUtcMs', 'updatedAtUtcMs', 'revision', 'projectId', 'featureId', 'runId',
  'taskId', 'attemptId', 'executionVersion', 'operation', 'codeDigest', 'policyDigest',
  'environmentSummary', 'checkSnapshot', 'selection', 'status', 'startedAtUtcMs', 'endedAtUtcMs',
] as const;

export function validateVerificationBatchRecord(
  value: unknown,
  context: ValidationContext = { operation: 'VerificationBatch' },
  field = 'verificationBatch',
): VerificationBatchRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, BATCH_RECORD_KEYS, context, field);
  const checkSnapshot = validateCheckSnapshot(object.checkSnapshot, context, 'checkSnapshot');
  const status = validateEnum(object.status, VERIFICATION_BATCH_STATUSES, context, 'status');
  const startedAtUtcMs = validateOptionalEpochMs(object.startedAtUtcMs, context, 'startedAtUtcMs');
  const endedAtUtcMs = validateOptionalEpochMs(object.endedAtUtcMs, context, 'endedAtUtcMs');
  // 生命周期形状：running 无 ended_at；终态必须有 ended_at 且不早于 started_at。
  if (status === 'running' && endedAtUtcMs !== null) {
    throw validationError(context, field, 'running 批次不得携带 endedAtUtcMs', value);
  }
  if (status !== 'running' && endedAtUtcMs === null) {
    throw validationError(context, field, '终态批次必须携带 endedAtUtcMs', value);
  }
  if (startedAtUtcMs !== null && endedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) {
    throw validationError(context, field, 'endedAtUtcMs 不得早于 startedAtUtcMs', value);
  }
  return {
    id: validateStableId(object.id, context, 'id'),
    createdAtUtcMs: validateNonNegativeInteger(object.createdAtUtcMs, context, 'createdAtUtcMs'),
    updatedAtUtcMs: validateNonNegativeInteger(object.updatedAtUtcMs, context, 'updatedAtUtcMs'),
    revision: validatePositiveInteger(object.revision, context, 'revision'),
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    runId: validateStableId(object.runId, context, 'runId'),
    taskId: validateStableId(object.taskId, context, 'taskId'),
    attemptId: validateStableId(object.attemptId, context, 'attemptId'),
    executionVersion: validatePositiveInteger(object.executionVersion, context, 'executionVersion'),
    operation: boundedText(VERIFICATION_OPERATION_MAX_LENGTH)(object.operation, context, 'operation'),
    codeDigest: validateSha256Digest(object.codeDigest, context, 'codeDigest'),
    policyDigest: validateSha256Digest(object.policyDigest, context, 'policyDigest'),
    environmentSummary: validateEnvironmentSummary(object.environmentSummary, context, 'environmentSummary'),
    checkSnapshot,
    selection: validateSelection(object.selection, context, 'selection', checkSnapshot),
    status,
    startedAtUtcMs,
    endedAtUtcMs,
  };
}

const RESULT_RECORD_KEYS = [
  'id', 'createdAtUtcMs', 'updatedAtUtcMs', 'revision', 'projectId', 'batchId', 'checkKey',
  'argv', 'cwdRef', 'environmentRef', 'timeoutMs', 'required', 'status', 'exitCode', 'signal',
  'timedOut', 'outputArtifactId', 'outputDigest', 'outputTail', 'startedAtUtcMs', 'endedAtUtcMs',
] as const;

export function validateCheckResultRecord(
  value: unknown,
  context: ValidationContext = { operation: 'CheckResult' },
  field = 'checkResult',
): CheckResultRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, RESULT_RECORD_KEYS, context, field);
  if (typeof object.required !== 'boolean') {
    throw validationError(context, 'required', '必须是布尔值', object.required);
  }
  if (typeof object.timedOut !== 'boolean') {
    throw validationError(context, 'timedOut', '必须是布尔值', object.timedOut);
  }
  const status = validateEnum(object.status, CHECK_RESULT_STATUSES, context, 'status');
  const exitCode = validateOptionalExitCode(object.exitCode, context, 'exitCode');
  const signal = validateOptionalSignal(object.signal, context, 'signal');
  const outputArtifactId = validateOptionalArtifactId(object.outputArtifactId, context, 'outputArtifactId');
  const outputDigest = validateOptionalDigest(object.outputDigest, context, 'outputDigest');
  // 输出证据身份形状：制品引用与记录摘要同时存在或同时为空。
  if ((outputArtifactId === null) !== (outputDigest === null)) {
    throw validationError(context, field, 'outputArtifactId 与 outputDigest 必须同时存在或同时为 null', value);
  }
  const startedAtUtcMs = validateOptionalEpochMs(object.startedAtUtcMs, context, 'startedAtUtcMs');
  const endedAtUtcMs = validateOptionalEpochMs(object.endedAtUtcMs, context, 'endedAtUtcMs');
  assertResultShape({
    status, exitCode, signal, timedOut: object.timedOut as boolean, startedAtUtcMs, endedAtUtcMs,
  }, context, field);
  return {
    id: validateStableId(object.id, context, 'id'),
    createdAtUtcMs: validateNonNegativeInteger(object.createdAtUtcMs, context, 'createdAtUtcMs'),
    updatedAtUtcMs: validateNonNegativeInteger(object.updatedAtUtcMs, context, 'updatedAtUtcMs'),
    revision: validatePositiveInteger(object.revision, context, 'revision'),
    projectId: validateStableId(object.projectId, context, 'projectId'),
    batchId: validateStableId(object.batchId, context, 'batchId'),
    checkKey: validateCheckKey(object.checkKey, context, 'checkKey'),
    argv: validateArgv(object.argv, context, 'argv'),
    cwdRef: validateNullableRef(object.cwdRef, context, 'cwdRef'),
    environmentRef: validateNullableRef(object.environmentRef, context, 'environmentRef'),
    timeoutMs: validateTimeoutMs(object.timeoutMs, context, 'timeoutMs'),
    required: object.required as boolean,
    status,
    exitCode,
    signal,
    timedOut: object.timedOut as boolean,
    outputArtifactId,
    outputDigest,
    outputTail: validateOutputTail(object.outputTail, context, 'outputTail'),
    startedAtUtcMs,
    endedAtUtcMs,
  };
}

// ---------------------------------------------------------------------------
// 输入契约
// ---------------------------------------------------------------------------

/** P03-7 / F-002：创建 VerificationBatch 的输入（Attempt 关联 + 身份快照）。 */
export interface VerificationBatchCreateInput {
  readonly batchId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly operation: string;
  readonly codeDigest: string;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly checkSnapshot: readonly VerificationCheckSnapshotEntry[];
  readonly selection: VerificationSelectionSnapshot;
  readonly startedAtUtcMs: number | null;
}

const BATCH_CREATE_KEYS = [
  'batchId', 'projectId', 'featureId', 'runId', 'taskId', 'attemptId', 'executionVersion',
  'operation', 'codeDigest', 'policyDigest', 'environmentSummary', 'checkSnapshot', 'selection',
  'startedAtUtcMs',
] as const;

export function validateVerificationBatchCreateInput(
  value: unknown,
  context: ValidationContext = { operation: 'VerificationBatch.create' },
  field = 'input',
): VerificationBatchCreateInput {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, BATCH_CREATE_KEYS, context, field);
  const checkSnapshot = validateCheckSnapshot(object.checkSnapshot, context, 'checkSnapshot');
  return {
    batchId: validateStableId(object.batchId, context, 'batchId'),
    projectId: validateStableId(object.projectId, context, 'projectId'),
    featureId: validateStableId(object.featureId, context, 'featureId'),
    runId: validateStableId(object.runId, context, 'runId'),
    taskId: validateStableId(object.taskId, context, 'taskId'),
    attemptId: validateStableId(object.attemptId, context, 'attemptId'),
    executionVersion: validatePositiveInteger(object.executionVersion, context, 'executionVersion'),
    operation: boundedText(VERIFICATION_OPERATION_MAX_LENGTH)(object.operation, context, 'operation'),
    codeDigest: validateSha256Digest(object.codeDigest, context, 'codeDigest'),
    policyDigest: validateSha256Digest(object.policyDigest, context, 'policyDigest'),
    environmentSummary: validateEnvironmentSummary(object.environmentSummary, context, 'environmentSummary'),
    checkSnapshot,
    selection: validateSelection(object.selection, context, 'selection', checkSnapshot),
    startedAtUtcMs: validateOptionalEpochMs(object.startedAtUtcMs, context, 'startedAtUtcMs'),
  };
}

/**
 * P03-7 / F-002：保存逐项 CheckResult 的输入。argv/cwd/environment/timeout/required
 * 由批次检查定义快照派生，调用方不得携带（防止混用不同检查定义身份）。
 */
export interface CheckResultSaveInput {
  readonly resultId: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly checkKey: string;
  readonly status: CheckResultStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputArtifactId: string | null;
  readonly outputTail: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

const RESULT_SAVE_KEYS = [
  'resultId', 'projectId', 'batchId', 'checkKey', 'status', 'exitCode', 'signal', 'timedOut',
  'outputArtifactId', 'outputTail', 'startedAtUtcMs', 'endedAtUtcMs',
] as const;

export function validateCheckResultSaveInput(
  value: unknown,
  context: ValidationContext = { operation: 'CheckResult.save' },
  field = 'input',
): CheckResultSaveInput {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, RESULT_SAVE_KEYS, context, field);
  if (typeof object.timedOut !== 'boolean') {
    throw validationError(context, 'timedOut', '必须是布尔值', object.timedOut);
  }
  const status = validateEnum(object.status, CHECK_RESULT_STATUSES, context, 'status');
  const exitCode = validateOptionalExitCode(object.exitCode, context, 'exitCode');
  const signal = validateOptionalSignal(object.signal, context, 'signal');
  const startedAtUtcMs = validateOptionalEpochMs(object.startedAtUtcMs, context, 'startedAtUtcMs');
  const endedAtUtcMs = validateOptionalEpochMs(object.endedAtUtcMs, context, 'endedAtUtcMs');
  assertResultShape({
    status, exitCode, signal, timedOut: object.timedOut as boolean, startedAtUtcMs, endedAtUtcMs,
  }, context, field);
  return {
    resultId: validateStableId(object.resultId, context, 'resultId'),
    projectId: validateStableId(object.projectId, context, 'projectId'),
    batchId: validateStableId(object.batchId, context, 'batchId'),
    checkKey: validateCheckKey(object.checkKey, context, 'checkKey'),
    status,
    exitCode,
    signal,
    timedOut: object.timedOut as boolean,
    outputArtifactId: validateOptionalArtifactId(object.outputArtifactId, context, 'outputArtifactId'),
    outputTail: validateOutputTail(object.outputTail, context, 'outputTail'),
    startedAtUtcMs,
    endedAtUtcMs,
  };
}

/** P03-7 / F-002：批次定版输入（CAS expectedRevision + 终态）。 */
export interface VerificationBatchFinalizeInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly status: VerificationBatchTerminalStatus;
  readonly endedAtUtcMs: number | null;
}

export function validateVerificationBatchFinalizeInput(
  value: unknown,
  context: ValidationContext = { operation: 'VerificationBatch.finalize' },
  field = 'input',
): VerificationBatchFinalizeInput {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['projectId', 'batchId', 'expectedRevision', 'status', 'endedAtUtcMs'], context, field);
  return {
    projectId: validateStableId(object.projectId, context, 'projectId'),
    batchId: validateStableId(object.batchId, context, 'batchId'),
    expectedRevision: validateExpectedRevision(object.expectedRevision, context),
    status: validateEnum(object.status, VERIFICATION_BATCH_TERMINAL_STATUSES, context, 'status'),
    endedAtUtcMs: validateOptionalEpochMs(object.endedAtUtcMs, context, 'endedAtUtcMs'),
  };
}

// ---------------------------------------------------------------------------
// 证据读取与变更结果
// ---------------------------------------------------------------------------

/** P03-7 / F-002：逐项结果证据读取结果；incomplete/none 绝不冒充 complete。 */
export type CheckResultEvidence =
  | {
      readonly status: 'complete';
      readonly artifactId: string;
      readonly contentHash: string;
      readonly sizeBytes: number;
      readonly locator: string;
      readonly version: number;
      readonly outputTail: string | null;
    }
  | { readonly status: 'none'; readonly outputTail: string | null }
  | {
      readonly status: 'incomplete';
      readonly reason: 'artifact_missing' | 'artifact_pending' | 'artifact_failed' | 'digest_mismatch';
      readonly artifactId: string;
    };

export interface VerificationBatchMutation {
  readonly batch: VerificationBatchRecord;
  /** false 表示同身份同内容的幂等重放（未写入新行）。 */
  readonly created: boolean;
}

export interface CheckResultMutation {
  readonly result: CheckResultRecord;
  readonly created: boolean;
}

/** P03-7 / F-002：Verification 访问面（读取 + 同端口下的事务化写入）。 */
export interface VerificationStore {
  getVerificationBatch(projectId: string, batchId: string): VerificationBatchRecord;
  /** 同 Attempt 的历史批次按创建顺序读回（历史失败记录不被新批次覆盖）。 */
  listAttemptVerificationBatches(projectId: string, attemptId: string): readonly VerificationBatchRecord[];
  listCheckResults(projectId: string, batchId: string): readonly CheckResultRecord[];
  createVerificationBatch(input: unknown): VerificationBatchMutation;
  saveCheckResult(input: unknown): CheckResultMutation;
  finalizeVerificationBatch(input: unknown): VerificationBatchRecord;
  readCheckResultEvidence(projectId: string, resultId: string): CheckResultEvidence;
  createVerificationBatchInTransaction(transaction: CommandTransaction, input: unknown): VerificationBatchMutation;
  saveCheckResultInTransaction(transaction: CommandTransaction, input: unknown): CheckResultMutation;
  finalizeVerificationBatchInTransaction(transaction: CommandTransaction, input: unknown): VerificationBatchRecord;
}

/** 供适配器抛出归属/冲突错误的辅助（保持 ports 层错误形态一致）。 */
export function verificationStorageError(
  kind: 'validation' | 'not_found' | 'conflict' | 'ownership' | 'corrupt',
  operation: string,
  message: string,
  entity?: { readonly type: 'verification_batch' | 'check_result'; readonly id?: string; readonly projectId?: string },
): StorageError {
  return new StorageError(kind, operation, message, entity === undefined ? undefined : { entity });
}
