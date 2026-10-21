/**
 * P03-6 / F-006：最小 Work Session 与 Attempt 执行诊断持久关联（端口，迁移 v20）。
 *
 * Session 是 Runtime 一次执行的最小持久关联与诊断入口：区分启动预占（reserved）/
 * 实际已启动（started）/执行已结束（ended）/已停止（stopped），读取实际 runtime、
 * 适配版本、输入引用（attempt.input_ref 快照）、executionStage、结果/诊断制品引用
 * 与最后活动；保存可见记录范围（recording_watermark）与缺口（recording_gaps）的最小
 * 元数据。未知或缺失指标保持 null，不补造“已完成”假象。正文（transcript、结果、
 * 诊断）一律经 ready Artifact 引用；原生记录只保存带 schemaVersion/storageKind/
 * formatVersion 的自描述指针，不写大事件或秘密正文。本端口不建设 ChatTurn、
 * session_messages 或 SessionRecorder 表组，不改变 Task/Feature 状态语义。
 */

import {
  requireNonEmptyString,
  requirePlainObject,
  rejectUnknownKeys,
  validationError,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStableId,
  type ValidationContext,
} from './validation.js';
import { ATTEMPT_EXECUTION_STAGES, type AttemptExecutionStage } from './attempt-store.js';
import type { WorkResourceIdentity } from './work-resources.js';
import { validateWorkResourceIdentity } from './work-resources.js';
import type { CommandTransaction } from './atomic-commands.js';

/** P03-6 / F-006：sessions 契约版本（native_ref.schemaVersion 与事件 payload 固定 v1）。 */
export const WORK_SESSION_SCHEMA_VERSION = 1;
/** P03-6 / F-006：Session 状态事件类型（每 Session 每 revision 至多一条）。 */
export const WORK_SESSION_EVENT_TYPE = 'work.session.updated';

export const WORK_SESSION_KINDS = ['work', 'chat'] as const;
export type WorkSessionKind = (typeof WORK_SESSION_KINDS)[number];

/** 生命周期：reserved（启动预占）→ started（实际已启动）→ ended（执行已结束）→ stopped（已停止）。 */
export const WORK_SESSION_STATUSES = ['reserved', 'started', 'ended', 'stopped'] as const;
export type WorkSessionStatus = (typeof WORK_SESSION_STATUSES)[number];

/** 允许的迁移：reserved→started、reserved→ended（启动失败）、started→ended、ended→stopped。 */
export const WORK_SESSION_TRANSITIONS: Readonly<Record<WorkSessionStatus, readonly WorkSessionStatus[]>> = {
  reserved: ['started', 'ended'],
  started: ['ended'],
  ended: ['stopped'],
  stopped: [],
};

export const RECORDING_GAPS_MAX_COUNT = 32;
export const RECORDING_GAP_MAX_LENGTH = 256;
const TITLE_MAX_CODE_POINTS = 200;

export interface WorkSessionNativeRef {
  readonly schemaVersion: 1;
  readonly storageKind: string;
  readonly formatVersion: string;
}

/** P03-6 / F-006：Session 记录（原生列；与 sessions 表逐列对应）。 */
export interface WorkSessionRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly revision: number;
  readonly projectId: string;
  readonly attemptId: string | null;
  readonly parentSessionId: string | null;
  readonly kind: WorkSessionKind;
  readonly title: string | null;
  readonly purpose: string;
  readonly runtime: string;
  readonly adapterVersion: string;
  readonly providerSessionId: string | null;
  readonly status: WorkSessionStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly inputRef: string;
  readonly resultRef: string | null;
  readonly lastActivityAtUtcMs: number;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly stoppedAtUtcMs: number | null;
  readonly nativeRef: WorkSessionNativeRef | null;
  readonly recordingWatermark: number | null;
  readonly recordingGaps: readonly string[] | null;
}

function boundedText(maxCodePoints: number) {
  return (value: unknown, context: ValidationContext, field: string): string => {
    if (typeof value !== 'string') {
      throw validationError(context, field, `必须是有界文本（≤${maxCodePoints} 码点）`, value);
    }
    const length = [...value].length;
    if (length === 0 || length > maxCodePoints) {
      throw validationError(context, field, `必须是有界文本（≤${maxCodePoints} 码点）`, value);
    }
    if (/[\u0000-\u001F\u007F]/.test(value)) {
      throw validationError(context, field, '不得含控制字符', value);
    }
    return value;
  };
}

const boundedIdText = boundedText(128);

function validateOptionalBoundedText(
  value: unknown,
  maxCodePoints: number,
  context: ValidationContext,
  field: string,
): string | null {
  if (value === null) return null;
  return boundedText(maxCodePoints)(value, context, field);
}

function validateOptionalEpochMs(value: unknown, context: ValidationContext, field: string): number | null {
  if (value === null) return null;
  return validateNonNegativeInteger(value, context, field);
}

function validateOptionalStableId(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null) return null;
  return validateStableId(value, context, field);
}

/** 指针型字段拒绝路径样取值：原生引用只能指向同进程私有存储标识，不得携带绝对/相对路径。 */
function rejectPathLike(value: string, context: ValidationContext, field: string): void {
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw validationError(context, field, '不得携带路径样取值', value);
  }
}

/** 校验原生记录引用：必须带 schemaVersion（固定 1）/storageKind/formatVersion 的自描述指针。 */
export function validateWorkSessionNativeRef(
  value: unknown,
  context: ValidationContext = { operation: 'WorkSession.nativeRef' },
  field = 'nativeRef',
): WorkSessionNativeRef {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['schemaVersion', 'storageKind', 'formatVersion'], context, field);
  if (object.schemaVersion !== WORK_SESSION_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, `不支持的 Work Session 原生引用版本：仅支持 ${WORK_SESSION_SCHEMA_VERSION}`, value);
  }
  const storageKind = boundedIdText(object.storageKind, context, `${field}.storageKind`);
  rejectPathLike(storageKind, context, `${field}.storageKind`);
  const formatVersion = boundedText(64)(object.formatVersion, context, `${field}.formatVersion`);
  rejectPathLike(formatVersion, context, `${field}.formatVersion`);
  return { schemaVersion: WORK_SESSION_SCHEMA_VERSION, storageKind, formatVersion };
}

function validateRecordingGaps(value: unknown, context: ValidationContext, field: string): string[] {
  if (!Array.isArray(value)) {
    throw validationError(context, field, `必须是有界缺口摘要数组（≤${RECORDING_GAPS_MAX_COUNT} 项）`, value);
  }
  if (value.length > RECORDING_GAPS_MAX_COUNT) {
    throw validationError(context, field, `必须是有界缺口摘要数组（≤${RECORDING_GAPS_MAX_COUNT} 项）`, value);
  }
  return value.map((entry, index) => boundedText(RECORDING_GAP_MAX_LENGTH)(entry, context, `${field}[${index}]`));
}

function validateOptionalRecordingGaps(value: unknown, context: ValidationContext, field: string): string[] | null {
  if (value === null) return null;
  return validateRecordingGaps(value, context, field);
}

function validateOptionalWatermark(value: unknown, context: ValidationContext, field: string): number | null {
  if (value === null) return null;
  return validateNonNegativeInteger(value, context, field);
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], context: ValidationContext, field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw validationError(context, field, `必须是 ${allowed.join(' | ')}`, value);
  }
  return value as T;
}

const WORK_SESSION_RECORD_KEYS = [
  'id', 'createdAtUtcMs', 'updatedAtUtcMs', 'revision', 'projectId', 'attemptId', 'parentSessionId',
  'kind', 'title', 'purpose', 'runtime', 'adapterVersion', 'providerSessionId', 'status',
  'executionStage', 'inputRef', 'resultRef', 'lastActivityAtUtcMs', 'startedAtUtcMs', 'endedAtUtcMs',
  'stoppedAtUtcMs', 'nativeRef', 'recordingWatermark', 'recordingGaps',
] as const;

/** 校验 Session 记录（行读取 fail-closed；与 sessions_lifecycle_shape_check 形状一致）。 */
export function validateWorkSessionRecord(
  value: unknown,
  context: ValidationContext = { operation: 'WorkSession' },
  field = 'workSession',
): WorkSessionRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, WORK_SESSION_RECORD_KEYS, context, field);
  const id = validateStableId(object.id, context, 'id');
  const createdAtUtcMs = validateNonNegativeInteger(object.createdAtUtcMs, context, 'createdAtUtcMs');
  const updatedAtUtcMs = validateNonNegativeInteger(object.updatedAtUtcMs, context, 'updatedAtUtcMs');
  const revision = validatePositiveInteger(object.revision, context, 'revision');
  const projectId = validateStableId(object.projectId, context, 'projectId');
  const attemptId = validateOptionalStableId(object.attemptId, context, 'attemptId');
  const parentSessionId = validateOptionalStableId(object.parentSessionId, context, 'parentSessionId');
  const kind = validateEnum(object.kind, WORK_SESSION_KINDS, context, 'kind');
  const title = validateOptionalBoundedText(object.title, TITLE_MAX_CODE_POINTS, context, 'title');
  const purpose = boundedIdText(object.purpose, context, 'purpose');
  const runtime = boundedIdText(object.runtime, context, 'runtime');
  const adapterVersion = boundedIdText(object.adapterVersion, context, 'adapterVersion');
  const providerSessionId = validateOptionalBoundedText(object.providerSessionId, 256, context, 'providerSessionId');
  const status = validateEnum(object.status, WORK_SESSION_STATUSES, context, 'status');
  const executionStage = validateEnum(object.executionStage, ATTEMPT_EXECUTION_STAGES, context, 'executionStage');
  const inputRef = validateStableId(object.inputRef, context, 'inputRef');
  const resultRef = validateOptionalStableId(object.resultRef, context, 'resultRef');
  const lastActivityAtUtcMs = validateNonNegativeInteger(object.lastActivityAtUtcMs, context, 'lastActivityAtUtcMs');
  const startedAtUtcMs = validateOptionalEpochMs(object.startedAtUtcMs, context, 'startedAtUtcMs');
  const endedAtUtcMs = validateOptionalEpochMs(object.endedAtUtcMs, context, 'endedAtUtcMs');
  const stoppedAtUtcMs = validateOptionalEpochMs(object.stoppedAtUtcMs, context, 'stoppedAtUtcMs');
  const nativeRef = object.nativeRef === null ? null : validateWorkSessionNativeRef(object.nativeRef, context, 'nativeRef');
  const recordingWatermark = validateOptionalWatermark(object.recordingWatermark, context, 'recordingWatermark');
  const recordingGaps = validateOptionalRecordingGaps(object.recordingGaps, context, 'recordingGaps');
  // 生命周期形状（与 DDL 一致）：reserved 无时间/结果；started 必有 started_at；
  // ended 可无 started_at（启动失败）但时间单调；stopped 必有 ended/stopped 且单调；
  // result_ref 只允许 ended/stopped 携带。
  const shapeError = (): never => {
    throw validationError(context, field, `非法 Session 生命周期形状（status=${status}）`, value);
  };
  if (kind === 'chat' && (attemptId !== null || parentSessionId !== null)) shapeError();
  if (kind === 'work' && attemptId === null && parentSessionId === null) shapeError();
  if (status === 'reserved') {
    if (startedAtUtcMs !== null || endedAtUtcMs !== null || stoppedAtUtcMs !== null || resultRef !== null) shapeError();
  } else if (status === 'started') {
    if (startedAtUtcMs === null || endedAtUtcMs !== null || stoppedAtUtcMs !== null || resultRef !== null) shapeError();
  } else if (status === 'ended') {
    if (endedAtUtcMs === null || stoppedAtUtcMs !== null) shapeError();
    else if (startedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) shapeError();
  } else {
    if (endedAtUtcMs === null || stoppedAtUtcMs === null) shapeError();
    else if (stoppedAtUtcMs < endedAtUtcMs) shapeError();
    else if (startedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) shapeError();
  }
  return {
    id, createdAtUtcMs, updatedAtUtcMs, revision, projectId, attemptId, parentSessionId, kind, title,
    purpose, runtime, adapterVersion, providerSessionId, status, executionStage, inputRef, resultRef,
    lastActivityAtUtcMs, startedAtUtcMs, endedAtUtcMs, stoppedAtUtcMs, nativeRef, recordingWatermark,
    recordingGaps: recordingGaps === null ? null : [...recordingGaps],
  };
}

/** P03-6 / F-006：创建顶层 Work Session 的输入（Attempt 身份 + 运行时元数据）。 */
export interface WorkSessionCreateInput extends WorkResourceIdentity {
  readonly sessionId: string;
  readonly purpose: string;
  readonly runtime: string;
  readonly adapterVersion: string;
  readonly providerSessionId?: string | null;
  readonly parentSessionId?: string | null;
  readonly nativeRef?: WorkSessionNativeRef | null;
}

export function validateWorkSessionCreateInput(
  value: unknown,
  context: ValidationContext = { operation: 'WorkSession.create' },
  field = 'input',
): WorkSessionCreateInput {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion',
    'sessionId', 'purpose', 'runtime', 'adapterVersion', 'providerSessionId', 'parentSessionId', 'nativeRef'], context, field);
  const identity = validateWorkResourceIdentity({ projectId: object.projectId, attemptId: object.attemptId,
    owner: object.owner, hostInstanceId: object.hostInstanceId, executionVersion: object.executionVersion });
  const sessionId = validateStableId(object.sessionId, context, 'sessionId');
  const purpose = boundedIdText(object.purpose, context, 'purpose');
  const runtime = boundedIdText(object.runtime, context, 'runtime');
  const adapterVersion = boundedIdText(object.adapterVersion, context, 'adapterVersion');
  const providerSessionId = validateOptionalBoundedText(object.providerSessionId ?? null, 256, context, 'providerSessionId');
  const parentSessionId = object.parentSessionId === undefined || object.parentSessionId === null
    ? null : validateStableId(object.parentSessionId, context, 'parentSessionId');
  const nativeRef = object.nativeRef === undefined || object.nativeRef === null
    ? null
    : validateWorkSessionNativeRef(object.nativeRef, context, 'nativeRef');
  return { ...identity, sessionId, purpose, runtime, adapterVersion, providerSessionId,
    ...(object.parentSessionId === undefined ? {} : { parentSessionId }), nativeRef };
}

export const WORK_SESSION_PROGRESS_KINDS = ['started', 'ended', 'stopped', 'activity'] as const;
export type WorkSessionProgressKind = (typeof WORK_SESSION_PROGRESS_KINDS)[number];

/** P03-6 / F-006：Session 推进输入（started/ended/stopped/activity + 可选诊断元数据）。 */
export interface WorkSessionProgressInput extends WorkResourceIdentity {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly kind: WorkSessionProgressKind;
  readonly executionStage?: AttemptExecutionStage | null;
  readonly resultRef?: string | null;
  readonly providerSessionId?: string | null;
  readonly nativeRef?: WorkSessionNativeRef | null;
  readonly recordingWatermark?: number | null;
  readonly recordingGaps?: readonly string[] | null;
}

const PROGRESS_KEYS_BY_KIND: Readonly<Record<WorkSessionProgressKind, readonly string[]>> = {
  started: ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion', 'sessionId',
    'expectedRevision', 'kind', 'executionStage', 'providerSessionId', 'nativeRef'],
  ended: ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion', 'sessionId',
    'expectedRevision', 'kind', 'executionStage', 'resultRef', 'recordingWatermark', 'recordingGaps', 'providerSessionId'],
  stopped: ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion', 'sessionId',
    'expectedRevision', 'kind', 'executionStage', 'recordingWatermark', 'recordingGaps'],
  activity: ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion', 'sessionId',
    'expectedRevision', 'kind', 'executionStage', 'recordingWatermark', 'recordingGaps', 'providerSessionId', 'nativeRef'],
};

export function validateWorkSessionProgressInput(
  value: unknown,
  context: ValidationContext = { operation: 'WorkSession.progress' },
  field = 'input',
): WorkSessionProgressInput {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [...new Set(Object.values(PROGRESS_KEYS_BY_KIND).flat())], context, field);
  const kind = validateEnum(object.kind, WORK_SESSION_PROGRESS_KINDS, context, 'kind');
  // activity 可补齐异步 Runner 首次观察的原生绑定；存储层拒绝覆盖已有绑定。
  rejectUnknownKeys(object, PROGRESS_KEYS_BY_KIND[kind], context, field);
  const identity = validateWorkResourceIdentity({ projectId: object.projectId, attemptId: object.attemptId,
    owner: object.owner, hostInstanceId: object.hostInstanceId, executionVersion: object.executionVersion });
  const sessionId = validateStableId(object.sessionId, context, 'sessionId');
  const expectedRevision = validatePositiveInteger(object.expectedRevision, context, 'expectedRevision');
  const executionStage = object.executionStage === undefined || object.executionStage === null
    ? null
    : validateEnum(object.executionStage, ATTEMPT_EXECUTION_STAGES, context, 'executionStage');
  return {
    ...identity, sessionId, expectedRevision, kind, executionStage,
    resultRef: object.resultRef === undefined ? null : validateOptionalStableId(object.resultRef, context, 'resultRef'),
    providerSessionId: object.providerSessionId === undefined
      ? null
      : validateOptionalBoundedText(object.providerSessionId, 256, context, 'providerSessionId'),
    nativeRef: object.nativeRef === undefined || object.nativeRef === null
      ? null
      : validateWorkSessionNativeRef(object.nativeRef, context, 'nativeRef'),
    recordingWatermark: object.recordingWatermark === undefined
      ? null
      : validateOptionalWatermark(object.recordingWatermark, context, 'recordingWatermark'),
    recordingGaps: object.recordingGaps === undefined
      ? null
      : validateOptionalRecordingGaps(object.recordingGaps, context, 'recordingGaps'),
  };
}

export interface WorkSessionMutation {
  readonly session: WorkSessionRecord;
  /** 状态推进事件 ID；纯活动推进（activity）不写事件，返回 null。 */
  readonly eventId: string | null;
}

/** P03-6 / F-006：Work Session 访问面（读取 + 同端口下的事务化推进）。 */
export interface WorkSessionStore {
  /** Current Attempt/Task generation and active recording Session; stale checks retain only bounded diagnostics. */
  checkWorkSessionFence(input: WorkResourceIdentity & { readonly sessionId: string }): boolean;
  getWorkSession(projectId: string, sessionId: string): WorkSessionRecord;
  getAttemptWorkSession(projectId: string, attemptId: string): WorkSessionRecord | null;
  createWorkSession(input: WorkSessionCreateInput): WorkSessionMutation;
  applyWorkSessionProgress(input: WorkSessionProgressInput): WorkSessionMutation;
  createWorkSessionInTransaction(transaction: CommandTransaction, input: WorkSessionCreateInput): WorkSessionMutation;
  applyWorkSessionProgressInTransaction(transaction: CommandTransaction, input: WorkSessionProgressInput): WorkSessionMutation;
}
