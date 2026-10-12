/**
 * P03-3 / F-005 执行域存储窄契约（ports 契约层：记录形态、事务原语输入校验、
 * 脱敏事件追加契约；无任何 I/O）。
 *
 * 设计依据：core-design/04 §6.1（Run 外层的 ExecutionController：显式调用
 * StateStore 创建 Run；所有 Run 归属用户明确授权的 ExecutionBatch；所有计数与
 * 对象创建在同一事务）、core-design/04 §6（成功、失败、取消的已创建 Run 都消耗
 * maxRuns；同 Batch workKey 已成功不得再次自动创建 Run；显式重试失败工作增加
 * dispatchOrdinal 但共享预算）、docs/p03-3-execution-schema-contract.md（迁移 v9
 * 三表与条件唯一/不可变触发器）、docs/p03-3-work-command-receipts-contract.md
 * （Work accepted 回执 v6：operationId=batchId、真实 Batch/Run 外键）。
 * 实施契约：docs/p03-3-execution-start-contract.md。
 *
 * 契约要点：
 * - 本模块只定义记录形态与事务原语输入校验（输入一律 unknown，先校验后写入；
 *   非法输入在任何 SQL 之前拒绝）；SQL 实现见 adapters/sqlite/execution-store.ts；
 * - 写入原语只在调用方的同一 BEGIN IMMEDIATE 写事务内使用（供
 *   CommandTransaction 组合），绝不嵌套事务、绝不做外部 I/O；
 * - 执行域事件（execution.run.dispatched）写入 state_events 并进入公开白名单
 *   （ports/events.ts 同步登记）；payload 恒为脱敏固定形状 {dispatched:true}，
 *   不携带计划正文/预算数值/输入正文/凭据；
 * - 快照列（scope/config/input）只保存身份级内容（摘要、版本、引用身份），
 *   绝不内联制品正文或绝对路径；序列化有界（EXECUTION_SNAPSHOT_MAX_BYTES）。
 *
 * 本模块不实现：启动命令编排（application/execution-start）、预算结算与无进展
 * 计数（F-008）、预算修订命令（F-009）、查询面（F-010）；P03-3 / F-006 起本模块
 * 追加 Task 尝试预算预占与分类记账的记录形态与事务原语输入校验。
 */
import type { ExecutionBudgetSnapshot } from './execution-budget.js';
import {
  TASK_MAX_ATTEMPTS_PER_TASK_MAX,
  TASK_MAX_ATTEMPTS_PER_TASK_MIN,
  validateExecutionBudgetSnapshot,
} from './execution-budget.js';
import type { StorageEntityRef } from './errors.js';
import { StorageError } from './errors.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requirePlainObject,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/**
 * P03-3 / F-005 执行 Run 派发事件（仅命令路径派发成功后写入；脱敏 payload 恒为
 * {dispatched:true}，聚合为派发创建的 Run 自身，aggregateRevision=创建 revision）。
 * 不携带预算数值/计划正文/输入正文/启动语义（派发不等于 Runtime 已启动）。
 */
export const EXECUTION_RUN_DISPATCHED_EVENT_TYPE = 'execution.run.dispatched';

/** 快照 JSON 列（scope/config/input）序列化字节上限（有界，拒绝无界快照）。 */
export const EXECUTION_SNAPSHOT_MAX_BYTES = 65_536;

/** Batch 生命周期（与迁移 v9 CHECK 同枚举）。 */
export const EXECUTION_BATCH_STATUSES = [
  'queued',
  'running',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'interrupted',
] as const;
export type ExecutionBatchStatus = (typeof EXECUTION_BATCH_STATUSES)[number];

/** Run 生命周期（与迁移 v9 CHECK 同枚举；succeeded/failed/cancelled 为不可重开终态）。 */
export const EXECUTION_RUN_STATUSES = EXECUTION_BATCH_STATUSES;
export type ExecutionRunStatus = ExecutionBatchStatus;

/** 迁移 v9 条件唯一索引同源的活动集（paused/interrupted 不是可绕过的终态）。 */
export const EXECUTION_ACTIVE_STATUSES = [
  'queued',
  'running',
  'pausing',
  'paused',
  'cancelling',
  'interrupted',
] as const;

export function isExecutionActiveStatus(status: string): boolean {
  return (EXECUTION_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isExecutionTerminalStatus(status: string): boolean {
  return !isExecutionActiveStatus(status);
}

/** 单 Feature 执行批次记录（迁移 v9 execution_batches 行的应用侧形态）。 */
export interface ExecutionBatchRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly phaseId: string;
  readonly featureId: string;
  /** 授权范围快照（JSON 对象；featureIds 恰含一个成员由 DDL CHECK 强制）。 */
  readonly scopeSnapshot: Readonly<Record<string, unknown>>;
  /** 输入配置依据（脱敏身份级 JSON 对象；不可变）。 */
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  readonly status: ExecutionBatchStatus;
  readonly budgetRevision: number;
  /** 当前批准预算（持久 JSON 重经 ports/execution-budget 校验；损坏 corrupt）。 */
  readonly budgetSnapshot: ExecutionBudgetSnapshot;
  readonly runsCreated: number;
  readonly attemptsCreated: number;
  readonly runtimeStarts: number;
  readonly noProgressRuns: number;
  readonly deadlineAtUtcMs: number;
  readonly reason: string | null;
}

/** 执行 Run 记录（迁移 v9 runs 行的应用侧形态）。 */
export interface RunRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly batchId: string;
  readonly featureId: string;
  readonly purpose: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  readonly status: ExecutionRunStatus;
  readonly scopeDigest: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly maxAttemptsPerRun: number;
  readonly runTimeLimitMs: number;
  readonly attemptsCreated: number;
  readonly reason: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/** 批次预算修订记录（迁移 v9 batch_budget_revisions 行；插后不可变证据行）。 */
export interface BatchBudgetRevisionRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly batchId: string;
  readonly version: number;
  readonly budgetSnapshot: ExecutionBudgetSnapshot;
  readonly deadlineAtUtcMs: number;
  readonly approvedBy: string;
  readonly reason: string;
}

/* ------------------------------------------------------------------ *
 * 事务原语输入校验（先校验后写入；非法输入零 SQL）
 * ------------------------------------------------------------------ */

function requireStableIdField(
  value: unknown,
  context: ValidationContext,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw validationError(context, field, '必须是非空字符串（≤128 字符）', value);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw validationError(context, field, '必须是稳定 ID 或 UUID v4 形态', value);
  }
  return value;
}

/** 快照对象校验：JSON 对象 + 序列化有界（无界快照在 SQL 之前拒绝）。 */
function requireBoundedSnapshot(
  value: unknown,
  context: ValidationContext,
  field: string,
): Readonly<Record<string, unknown>> {
  const object = requirePlainObject(value, context, field);
  let serialized: string;
  try {
    serialized = JSON.stringify(object);
  } catch {
    throw validationError(context, field, '必须是 JSON 安全对象', value);
  }
  if (Buffer.byteLength(serialized, 'utf8') > EXECUTION_SNAPSHOT_MAX_BYTES) {
    throw validationError(context, field, `序列化不得超过 ${EXECUTION_SNAPSHOT_MAX_BYTES} 字节（limit_exceeded）`, undefined);
  }
  return object;
}

export interface ValidatedExecutionBatchInsertInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly scopeSnapshot: Readonly<Record<string, unknown>>;
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  readonly budgetSnapshot: ExecutionBudgetSnapshot;
  readonly status: ExecutionBatchStatus;
  readonly runsCreated: number;
  readonly reason: string | null;
}

const EXECUTION_BATCH_INSERT_KEYS = [
  'projectId',
  'phaseId',
  'featureId',
  'batchId',
  'scopeSnapshot',
  'configSnapshot',
  'budgetSnapshot',
  'status',
  'runsCreated',
  'reason',
] as const;

/**
 * Batch 插入输入校验：恰一个 Feature 范围（scopeSnapshot.featureIds 单成员与
 * featureId 一致）、身份级快照有界、预算快照经权威校验、初始状态 queued、
 * runsCreated ≥1（首次派发即占用一次 Run 名额，不出现零计数批次）。
 */
export function validateExecutionBatchInsertInput(
  value: unknown,
  operation: string,
): ValidatedExecutionBatchInsertInput {
  const context: ValidationContext = { operation, entity: { type: 'execution_batch' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, EXECUTION_BATCH_INSERT_KEYS, context, 'input');
  const scopeSnapshot = requireBoundedSnapshot(object.scopeSnapshot, context, 'scopeSnapshot');
  const featureIds = (scopeSnapshot as { featureIds?: unknown }).featureIds;
  if (
    !Array.isArray(featureIds) ||
    featureIds.length !== 1 ||
    featureIds[0] !== object.featureId
  ) {
    throw validationError(
      context,
      'scopeSnapshot.featureIds',
      '必须是恰含一个成员的数组且与 featureId 一致（单 Feature 范围）',
      featureIds,
    );
  }
  const budgetSnapshot = validateExecutionBudgetSnapshot(object.budgetSnapshot, context);
  if (object.status !== 'queued') {
    throw validationError(context, 'status', '创建时必须是 queued', object.status);
  }
  if (
    typeof object.runsCreated !== 'number' ||
    !Number.isSafeInteger(object.runsCreated) ||
    object.runsCreated < 1
  ) {
    throw validationError(context, 'runsCreated', '必须是 ≥1 的安全整数（首派发即计数）', object.runsCreated);
  }
  if (object.reason !== null && typeof object.reason !== 'string') {
    throw validationError(context, 'reason', '必须是字符串或 null', object.reason);
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    phaseId: requireStableIdField(object.phaseId, context, 'phaseId'),
    featureId: requireStableIdField(object.featureId, context, 'featureId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    scopeSnapshot,
    configSnapshot: requireBoundedSnapshot(object.configSnapshot, context, 'configSnapshot'),
    budgetSnapshot,
    status: object.status,
    runsCreated: object.runsCreated,
    reason: object.reason,
  };
}

export interface ValidatedBatchBudgetRevisionInsertInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly version: number;
  readonly budgetSnapshot: ExecutionBudgetSnapshot;
  readonly approvedBy: string;
  readonly reason: string;
}

const BATCH_BUDGET_REVISION_INSERT_KEYS = [
  'projectId',
  'batchId',
  'version',
  'budgetSnapshot',
  'approvedBy',
  'reason',
] as const;

/**
 * 预算修订行插入输入校验：version ≥1（初始授权 version=1 随 Batch 同事务落行）、
 * 非空 approvedBy（可信主体定值，不接受请求输入）与非空 reason（增额/初始授权
 * 必须显式说明）。
 */
export function validateBatchBudgetRevisionInsertInput(
  value: unknown,
  operation: string,
): ValidatedBatchBudgetRevisionInsertInput {
  const context: ValidationContext = { operation, entity: { type: 'batch_budget_revision' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, BATCH_BUDGET_REVISION_INSERT_KEYS, context, 'input');
  if (
    typeof object.version !== 'number' ||
    !Number.isSafeInteger(object.version) ||
    object.version < 1
  ) {
    throw validationError(context, 'version', '必须是 ≥1 的安全整数', object.version);
  }
  if (typeof object.approvedBy !== 'string' || object.approvedBy.length === 0) {
    throw validationError(context, 'approvedBy', '必须是非空字符串（可信主体）', object.approvedBy);
  }
  if (typeof object.reason !== 'string' || object.reason.trim().length === 0) {
    throw validationError(context, 'reason', '必须是非空说明', object.reason);
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    version: object.version,
    budgetSnapshot: validateExecutionBudgetSnapshot(object.budgetSnapshot, context),
    approvedBy: object.approvedBy,
    reason: object.reason,
  };
}

export interface ValidatedExecutionRunInsertInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly purpose: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly configSnapshot: Readonly<Record<string, unknown>>;
  readonly status: ExecutionRunStatus;
  readonly scopeDigest: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly maxAttemptsPerRun: number;
  readonly runTimeLimitMs: number;
  readonly reason: string | null;
}

const EXECUTION_RUN_INSERT_KEYS = [
  'projectId',
  'batchId',
  'featureId',
  'runId',
  'purpose',
  'inputSnapshot',
  'configSnapshot',
  'status',
  'scopeDigest',
  'workKey',
  'dispatchOrdinal',
  'maxAttemptsPerRun',
  'runTimeLimitMs',
  'reason',
] as const;

/**
 * Run 插入输入校验：purpose 非空、派发身份（workKey 非空 + dispatchOrdinal ≥1 +
 * 64hex scopeDigest）、Run 上限（派发时从预算契约冻结）与身份级快照有界。
 */
export function validateExecutionRunInsertInput(
  value: unknown,
  operation: string,
): ValidatedExecutionRunInsertInput {
  const context: ValidationContext = { operation, entity: { type: 'run' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, EXECUTION_RUN_INSERT_KEYS, context, 'input');
  if (typeof object.purpose !== 'string' || object.purpose.length === 0 || object.purpose.length > 64) {
    throw validationError(context, 'purpose', '必须是非空字符串（≤64 字符）', object.purpose);
  }
  if (typeof object.status !== 'string' || !(EXECUTION_RUN_STATUSES as readonly string[]).includes(object.status)) {
    throw validationError(context, 'status', `必须是 ${EXECUTION_RUN_STATUSES.join('/')}`, object.status);
  }
  if (typeof object.scopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(object.scopeDigest)) {
    throw validationError(context, 'scopeDigest', '必须是 64 位小写十六进制 SHA-256', object.scopeDigest);
  }
  if (typeof object.workKey !== 'string' || object.workKey.length === 0 || object.workKey.length > 256) {
    throw validationError(context, 'workKey', '必须是非空字符串（≤256 字符）', object.workKey);
  }
  for (const [field, min] of [
    ['dispatchOrdinal', 1],
    ['maxAttemptsPerRun', 1],
    ['runTimeLimitMs', 1],
  ] as const) {
    const raw = (object as Record<string, unknown>)[field];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) {
      throw validationError(context, field, `必须是 ≥${min} 的安全整数`, raw);
    }
  }
  if (object.reason !== null && typeof object.reason !== 'string') {
    throw validationError(context, 'reason', '必须是字符串或 null', object.reason);
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    featureId: requireStableIdField(object.featureId, context, 'featureId'),
    runId: requireStableIdField(object.runId, context, 'runId'),
    purpose: object.purpose,
    inputSnapshot: requireBoundedSnapshot(object.inputSnapshot, context, 'inputSnapshot'),
    configSnapshot: requireBoundedSnapshot(object.configSnapshot, context, 'configSnapshot'),
    status: object.status as ExecutionRunStatus,
    scopeDigest: object.scopeDigest,
    workKey: object.workKey,
    dispatchOrdinal: object.dispatchOrdinal as number,
    maxAttemptsPerRun: object.maxAttemptsPerRun as number,
    runTimeLimitMs: object.runTimeLimitMs as number,
    reason: object.reason,
  };
}

export interface ValidatedExecutionEventAppendInput {
  readonly projectId: string;
  readonly eventType: typeof EXECUTION_RUN_DISPATCHED_EVENT_TYPE;
  readonly aggregateType: 'run';
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

const EXECUTION_EVENT_APPEND_KEYS = [
  'projectId',
  'eventType',
  'aggregateType',
  'aggregateId',
  'aggregateRevision',
  'payload',
] as const;

/** 执行域事件追加输入校验（白名单单成员；payload 恒 {dispatched:true}）。 */
export function validateExecutionEventAppendInput(
  value: unknown,
  operation: string,
): ValidatedExecutionEventAppendInput {
  const context: ValidationContext = { operation, entity: { type: 'run' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, EXECUTION_EVENT_APPEND_KEYS, context, 'input');
  if (object.eventType !== EXECUTION_RUN_DISPATCHED_EVENT_TYPE) {
    throw validationError(context, 'eventType', `必须是 ${EXECUTION_RUN_DISPATCHED_EVENT_TYPE}`, object.eventType);
  }
  if (object.aggregateType !== 'run') {
    throw validationError(context, 'aggregateType', '必须是 run', object.aggregateType);
  }
  if (
    typeof object.aggregateRevision !== 'number' ||
    !Number.isSafeInteger(object.aggregateRevision) ||
    object.aggregateRevision < 1
  ) {
    throw validationError(context, 'aggregateRevision', '必须是 ≥1 的安全整数', object.aggregateRevision);
  }
  if (!isPlainObject(object.payload) || object.payload.dispatched !== true) {
    throw validationError(context, 'payload', '必须是 {dispatched:true}（脱敏事件固定形状）', object.payload);
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
    aggregateType: 'run',
    aggregateId: requireStableIdField(object.aggregateId, context, 'aggregateId'),
    aggregateRevision: object.aggregateRevision,
    payload: { dispatched: true },
  };
}

/** 持久行读取的统一 corrupt 包装（JSON 列损坏/枚举漂移 fail-closed）。 */
export function executionCorruptError(
  operation: string,
  entity: StorageEntityRef,
  reason: string,
  cause?: unknown,
): StorageError {
  return new StorageError('corrupt', operation, `${operation}: ${reason}`, {
    entity,
    ...(cause === undefined ? {} : { cause }),
  });
}

/* ------------------------------------------------------------------ *
 * P03-3 / F-006 Task 尝试预算预占与分类记账（迁移 v11；受信 Core 内部原语）
 *
 * 预占语义：总 Attempt 预占在同一写事务内校验同项目 Batch/Run/Task 归属、有效
 * 控制状态与绝对 deadline，并原子地同时递增 Batch 与 Run 的 attempts_created 及
 * Task 双计数（attempt_counter/code_attempts_used），同时落一条预占账本行；
 * 不允许先提交扣额再另事务创建 Attempt（P03-4 在同事务接入真实 Attempt 创建）。
 * 预占恒记为 code（首次代码执行与代码修复都消耗代码额度）；基础设施失败由
 * 受信 Core 事后单向重分类为 infrastructure（仅退还代码额度，总 Attempt、已预占
 * Runtime 启动与绝对时间不退还）。本原语不经命令面暴露，客户端/模型无自报入口。
 * ------------------------------------------------------------------ */

/** Task 尝试记账分类：预占恒为 code；infrastructure 仅受信 Core 重分类可达。 */
export const TASK_ATTEMPT_CLASSIFICATIONS = ['code', 'infrastructure'] as const;
export type TaskAttemptClassification = (typeof TASK_ATTEMPT_CLASSIFICATIONS)[number];

/** 受信分类主体定值（DDL CHECK 同源；预占/重分类原语内部固定，不接受请求输入）。 */
export const TASK_ATTEMPT_CLASSIFIED_BY_CORE = 'core';

/** Task 尝试预占账本记录（迁移 v11 task_attempt_reservations 行的应用侧形态）。 */
export interface TaskAttemptReservationRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly batchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptKey: string;
  readonly classification: TaskAttemptClassification;
  readonly classifiedBy: typeof TASK_ATTEMPT_CLASSIFIED_BY_CORE;
  readonly reason: string | null;
}

/** Task 预算双计数的持久读取形态（剩余额度 = caps 与计数合并计算）。 */
export interface TaskExecutionCountersRecord {
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptCounter: number;
  readonly codeAttemptsUsed: number;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
}

export interface ValidatedTaskAttemptReservationInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptKey: string;
  /** 总 Attempt 上限（executionLimits.maxAttemptsPerTask；受信 Core 事务外解析后传入；
   *  null = 未配置。与 Task 副本中的 maxCodeAttempts 同时生效，见 resolveTaskAttemptCaps）。 */
  readonly maxAttemptsPerTask: number | null;
}

const TASK_ATTEMPT_RESERVATION_KEYS = [
  'projectId',
  'batchId',
  'runId',
  'taskId',
  'attemptKey',
  'maxAttemptsPerTask',
] as const;

function requireAttemptKey(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim().length === 0) {
    throw validationError(context, field, '必须是非空非空白字符串（≤128 字符；受信 Core 生成的预占身份）', value);
  }
  return value;
}

/**
 * 预占输入校验：预占身份为受信 Core 生成的稳定键；maxAttemptsPerTask 可选
 * （1..100，与 settings executionLimits 同源；缺省/null = 未配置总上限）；
 * classification/owner/lease 等执行域字段不是预占请求字段（分类只能走受信
 * 重分类原语；owner/fencing 属 P03-4）。
 */
export function validateTaskAttemptReservationInput(
  value: unknown,
  operation: string,
): ValidatedTaskAttemptReservationInput {
  const context: ValidationContext = { operation, entity: { type: 'task_attempt_reservation' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, TASK_ATTEMPT_RESERVATION_KEYS, context, 'input');
  const rawCap = object.maxAttemptsPerTask;
  let maxAttemptsPerTask: number | null = null;
  if (rawCap !== undefined && rawCap !== null) {
    if (
      typeof rawCap !== 'number' ||
      !Number.isInteger(rawCap) ||
      rawCap < TASK_MAX_ATTEMPTS_PER_TASK_MIN ||
      rawCap > TASK_MAX_ATTEMPTS_PER_TASK_MAX
    ) {
      throw validationError(
        context,
        'maxAttemptsPerTask',
        `必须是 ${TASK_MAX_ATTEMPTS_PER_TASK_MIN}..${TASK_MAX_ATTEMPTS_PER_TASK_MAX} 的整数或 null（未配置）`,
        rawCap,
      );
    }
    maxAttemptsPerTask = rawCap;
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    runId: requireStableIdField(object.runId, context, 'runId'),
    taskId: requireStableIdField(object.taskId, context, 'taskId'),
    attemptKey: requireAttemptKey(object.attemptKey, context, 'attemptKey'),
    maxAttemptsPerTask,
  };
}

export interface ValidatedTaskAttemptReclassifyInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptKey: string;
  readonly reason: string;
}

const TASK_ATTEMPT_RECLASSIFY_KEYS = ['projectId', 'taskId', 'attemptKey', 'reason'] as const;

/**
 * 重分类输入校验：仅接受同项目 Task + 预占身份 + 非空理由（审计）；分类主体
 * 恒为受信 Core（classifiedBy 定值，不接受请求输入），方向恒为 code→
 * infrastructure（单向，不可回调为代码额度）。
 */
export function validateTaskAttemptReclassifyInput(
  value: unknown,
  operation: string,
): ValidatedTaskAttemptReclassifyInput {
  const context: ValidationContext = { operation, entity: { type: 'task_attempt_reservation' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, TASK_ATTEMPT_RECLASSIFY_KEYS, context, 'input');
  if (typeof object.reason !== 'string' || object.reason.trim().length === 0 || object.reason.length > 512) {
    throw validationError(context, 'reason', '必须是非空说明（≤512 字符；受信 Core 分类审计理由）', object.reason);
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    taskId: requireStableIdField(object.taskId, context, 'taskId'),
    attemptKey: requireAttemptKey(object.attemptKey, context, 'attemptKey'),
    reason: object.reason,
  };
}
