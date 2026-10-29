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
 * 本模块不实现：启动命令编排（application/execution-start）、预算修订命令编排
 * （application/execution-budget-revise，P03-3 / F-009 起本模块提供其存储原语
 * 与输入校验）、查询面（F-010）；P03-3 / F-006 起本模块
 * 追加 Task 尝试预算预占与分类记账的记录形态与事务原语输入校验；P03-3 / F-007
 * 起追加 Runtime 启动额度预占的记录形态与输入校验（SDK 启动前的受信边界）。
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
  normalizeLabels,
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

/**
 * P03-3 / F-009 批次预算修订事件（仅命令路径修订成功后写入；脱敏 payload 恒为
 * {revised:true}，聚合为目标 Batch 自身，aggregateRevision=修订后 Batch 行 revision）。
 * 不携带预算数值、理由正文或批准主体身份（审计细节在不可变修订行与回执）。
 */
export const EXECUTION_BUDGET_REVISED_EVENT_TYPE = 'execution.budget.revised';

/** P03-9 / F-001 用户暂停意图事件（Run/Batch 各自聚合；payload 恒 {paused:true}）。 */
export const EXECUTION_RUN_PAUSED_EVENT_TYPE = 'execution.run.paused';
export const EXECUTION_BATCH_PAUSED_EVENT_TYPE = 'execution.batch.paused';
/** P03-9 / F-002 取消意图/终态事件（payload 恒 {cancelling:true}/{cancelled:true}）。 */
export const EXECUTION_RUN_CANCELLING_EVENT_TYPE = 'execution.run.cancelling';
export const EXECUTION_RUN_CANCELLED_EVENT_TYPE = 'execution.run.cancelled';
export const EXECUTION_BATCH_CANCELLING_EVENT_TYPE = 'execution.batch.cancelling';
export const EXECUTION_BATCH_CANCELLED_EVENT_TYPE = 'execution.batch.cancelled';
/** P05-5：Feature 范围控制事件（payload 恒为控制意图，不表示验收/交付完成）。 */
export const EXECUTION_FEATURE_PAUSED_EVENT_TYPE = 'execution.feature.paused';
export const EXECUTION_FEATURE_CANCELLING_EVENT_TYPE = 'execution.feature.cancelling';
export const EXECUTION_FEATURE_CANCELLED_EVENT_TYPE = 'execution.feature.cancelled';
export const EXECUTION_FEATURE_RESUMED_EVENT_TYPE = 'execution.feature.resumed';
/** P03-9 / F-008 显式工作流 resume 事件（payload 恒 {resumed:true}）。 */
export const EXECUTION_RUN_RESUMED_EVENT_TYPE = 'execution.run.resumed';
export const EXECUTION_BATCH_RESUMED_EVENT_TYPE = 'execution.batch.resumed';

export const TASK_CLAIMED_EVENT_TYPE = 'task.claimed';
export const ATTEMPT_UPDATED_EVENT_TYPE = 'task.attempt.updated';
export const TASK_APPROVAL_BLOCKED_EVENT_TYPE = 'task.approval.blocked';
export const TASK_APPROVAL_DECIDED_EVENT_TYPE = 'task.approval.decided';

/** 执行域事件白名单（与 ports/events.ts 公开白名单同源）。 */
export const FEATURE_FINALIZED_EVENT_TYPE = 'feature.finalized';
export const FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE = 'feature.finalization_blocked';

export const EXECUTION_EVENT_TYPES = [
  EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
  EXECUTION_BUDGET_REVISED_EVENT_TYPE,
  EXECUTION_RUN_PAUSED_EVENT_TYPE,
  EXECUTION_BATCH_PAUSED_EVENT_TYPE,
  EXECUTION_RUN_CANCELLING_EVENT_TYPE,
  EXECUTION_RUN_CANCELLED_EVENT_TYPE,
  EXECUTION_BATCH_CANCELLING_EVENT_TYPE,
  EXECUTION_BATCH_CANCELLED_EVENT_TYPE,
  EXECUTION_RUN_RESUMED_EVENT_TYPE,
  EXECUTION_BATCH_RESUMED_EVENT_TYPE,
  EXECUTION_FEATURE_PAUSED_EVENT_TYPE,
  EXECUTION_FEATURE_CANCELLING_EVENT_TYPE,
  EXECUTION_FEATURE_CANCELLED_EVENT_TYPE,
  EXECUTION_FEATURE_RESUMED_EVENT_TYPE,
  TASK_CLAIMED_EVENT_TYPE,
  ATTEMPT_UPDATED_EVENT_TYPE,
  TASK_APPROVAL_BLOCKED_EVENT_TYPE,
  TASK_APPROVAL_DECIDED_EVENT_TYPE,
  FEATURE_FINALIZED_EVENT_TYPE,
  FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE,
] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

interface ExecutionEventSpec {
  readonly aggregateType: 'run' | 'execution_batch' | 'task' | 'feature';
  readonly payloadKey:
    | 'dispatched' | 'revised' | 'paused' | 'cancelling' | 'cancelled' | 'resumed'
    | 'claimed' | 'updated' | 'blocked' | 'decided' | 'finalized';
}

const EXECUTION_EVENT_SPECS: Readonly<Record<ExecutionEventType, ExecutionEventSpec>> = Object.freeze({
  [EXECUTION_RUN_DISPATCHED_EVENT_TYPE]: Object.freeze({ aggregateType: 'run', payloadKey: 'dispatched' }),
  [TASK_CLAIMED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', payloadKey: 'claimed' }),
  [ATTEMPT_UPDATED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', payloadKey: 'updated' }),
  [TASK_APPROVAL_BLOCKED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', payloadKey: 'blocked' }),
  [TASK_APPROVAL_DECIDED_EVENT_TYPE]: Object.freeze({ aggregateType: 'task', payloadKey: 'decided' }),
  [FEATURE_FINALIZED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'finalized' }),
  [FEATURE_FINALIZATION_BLOCKED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'blocked' }),
  [EXECUTION_BUDGET_REVISED_EVENT_TYPE]: Object.freeze({ aggregateType: 'execution_batch', payloadKey: 'revised' }),
  [EXECUTION_RUN_PAUSED_EVENT_TYPE]: Object.freeze({ aggregateType: 'run', payloadKey: 'paused' }),
  [EXECUTION_BATCH_PAUSED_EVENT_TYPE]: Object.freeze({ aggregateType: 'execution_batch', payloadKey: 'paused' }),
  [EXECUTION_RUN_CANCELLING_EVENT_TYPE]: Object.freeze({ aggregateType: 'run', payloadKey: 'cancelling' }),
  [EXECUTION_RUN_CANCELLED_EVENT_TYPE]: Object.freeze({ aggregateType: 'run', payloadKey: 'cancelled' }),
  [EXECUTION_BATCH_CANCELLING_EVENT_TYPE]: Object.freeze({ aggregateType: 'execution_batch', payloadKey: 'cancelling' }),
  [EXECUTION_BATCH_CANCELLED_EVENT_TYPE]: Object.freeze({ aggregateType: 'execution_batch', payloadKey: 'cancelled' }),
  [EXECUTION_RUN_RESUMED_EVENT_TYPE]: Object.freeze({ aggregateType: 'run', payloadKey: 'resumed' }),
  [EXECUTION_BATCH_RESUMED_EVENT_TYPE]: Object.freeze({ aggregateType: 'execution_batch', payloadKey: 'resumed' }),
  [EXECUTION_FEATURE_PAUSED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'paused' }),
  [EXECUTION_FEATURE_CANCELLING_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'cancelling' }),
  [EXECUTION_FEATURE_CANCELLED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'cancelled' }),
  [EXECUTION_FEATURE_RESUMED_EVENT_TYPE]: Object.freeze({ aggregateType: 'feature', payloadKey: 'resumed' }),
});

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
  /** P03-9 / F-001：持久暂停意图时刻；NULL 表示未请求（不因 Attempt 收尾清除）。 */
  readonly pauseRequestedAtUtcMs: number | null;
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
  readonly labels: readonly string[];
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
  /** P03-9 / F-001：持久暂停意图时刻；NULL 表示未请求（不因 Attempt 收尾清除）。 */
  readonly pauseRequestedAtUtcMs: number | null;
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

/**
 * 预算修订原语结果（F-009）：修订后的 Batch 当前状态 + 新增不可变修订行 +
 * 修订前事实（上一版本号/预算快照/deadline；供回执与审计携带前后值）。
 */
export interface BatchBudgetRevisionResult {
  readonly batch: ExecutionBatchRecord;
  readonly revision: BatchBudgetRevisionRecord;
  readonly previousBudgetRevision: number;
  readonly previousBudgetSnapshot: ExecutionBudgetSnapshot;
  readonly previousDeadlineAtUtcMs: number;
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

/** P03-9 / F-001 暂停目标与结果（同一短写事务内原子持久化）。 */
export type ExecutionPauseTargetKind = 'run' | 'batch' | 'feature';
export type ExecutionPauseOutcome = 'paused' | 'pausing' | 'already_terminal' | 'interrupted';

export interface ExecutionPauseInput {
  readonly projectId: string;
  readonly targetKind: ExecutionPauseTargetKind;
  readonly targetId: string;
  readonly expectedRevision: number;
}

export interface ExecutionPauseResult {
  readonly outcome: ExecutionPauseOutcome;
  readonly targetKind: ExecutionPauseTargetKind;
  readonly targetId: string;
  readonly status: ExecutionRunStatus;
  readonly revision: number;
  /** true 表示本次事务改变了目标控制状态；terminal/interrupted 不写业务状态。 */
  readonly changed: boolean;
  readonly eventId: string | null;
}

/** P03-9 / F-008 显式 resume 的事务原语输入/输出（同一短写事务内原子生效）。 */
export type ExecutionResumeTargetKind = 'run' | 'batch' | 'feature';
export interface ExecutionResumeInput {
  readonly projectId: string;
  readonly targetKind: ExecutionResumeTargetKind;
  readonly targetId: string;
  readonly expectedRevision: number;
  /** 事务外检查的工作区身份；null 表示尚无受管工作区。 */
  readonly workspace: { readonly workspaceId: string; readonly revision: number } | null;
}
export interface ExecutionResumeResult {
  readonly outcome: 'resumed' | 'already_terminal';
  readonly targetKind: ExecutionResumeTargetKind;
  readonly targetId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status: ExecutionRunStatus;
  readonly revision: number;
  readonly runIds: readonly string[];
  readonly eventId: string | null;
}

/**
 * P03-9 / F-010 retryFinal 重开父 Batch 的当前状态原因（不是新授权，也不
 * 重置累计计数；仅把 finalization 失败后的终态 Batch 重新打开以承载新 Run）。
 */
export const FINALIZATION_RETRY_BATCH_OPEN_REASON = 'finalization_retry' as const;

/** P03-9 / F-010 finalization-only 新 Run 的父 Batch 重开输入/结果。 */
export interface FinalizationRetryBatchOpenInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly expectedRevision: number;
}

export type FinalizationRetryBatchOpenOutcome =
  | 'reopened'
  | 'stale_revision'
  | 'not_continuable';

export interface FinalizationRetryBatchOpenResult {
  readonly outcome: FinalizationRetryBatchOpenOutcome;
  /** 当前权威行（reopened 时为更新后的行；其它结果为未改动的现有行）。 */
  readonly batch: ExecutionBatchRecord;
}

/** P03-9 / F-002 持久停止 operation 阶段；与 Run/Batch 生命周期分离。 */export const EXECUTION_STOP_OPERATION_STATUSES = ['stopping', 'stopped', 'uncertain'] as const;
export type ExecutionStopOperationStatus = (typeof EXECUTION_STOP_OPERATION_STATUSES)[number];

export type ExecutionCancelTargetKind = 'run' | 'batch' | 'feature';
export type ExecutionCancelOutcome = 'cancelled' | 'cancelling' | 'stop_uncertain' | 'already_terminal';

export interface ExecutionCancelInput {
  readonly projectId: string;
  readonly targetKind: ExecutionCancelTargetKind;
  readonly targetId: string;
  readonly expectedRevision: number;
  /** 命令身份：同一 commandId 重放不得创建第二个停止 operation（回执层已拦截，DDL 兜底）。 */
  readonly commandId: string;
}

export interface ExecutionCancelResult {
  readonly outcome: ExecutionCancelOutcome;
  readonly targetKind: ExecutionCancelTargetKind;
  readonly targetId: string;
  readonly status: ExecutionRunStatus;
  readonly revision: number;
  readonly changed: boolean;
  /** 本次取消关联的持久停止 operation；already_terminal 为 null。 */
  readonly stopOperationId: string | null;
  readonly stopStatus: ExecutionStopOperationStatus | null;
  readonly eventId: string | null;
}

export interface ExecutionStopOperationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly commandId: string;
  readonly targetKind: ExecutionCancelTargetKind;
  readonly targetId: string;
  readonly batchId: string;
  /** Feature 目标的持久归属；Run/Batch operation 为 null。 */
  readonly featureId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly status: ExecutionStopOperationStatus;
  readonly requestedAtUtcMs: number;
  readonly settledAtUtcMs: number | null;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  /** P03-9 / F-003：停止证据 Artifact 引用（核验前为 null）。 */
  readonly evidenceRef: string | null;
  readonly stopConfirmed: boolean | null;
  /** true＝观察到强制终止；null＝无法判定；绝不填 false 冒充未升级。 */
  readonly forced: boolean | null;
  readonly checkedAtUtcMs: number | null;
}

/** P03-9 / F-003：停止控制对持久 operation 的唯一结算入参（短事务内）。 */
export interface ExecutionStopSettlementInput {
  readonly projectId: string;
  readonly stopOperationId: string;
  readonly status: 'stopped' | 'uncertain';
  readonly evidenceRef: string;
  readonly stopConfirmed: boolean;
  readonly forced: boolean | null;
  readonly checkedAtUtcMs: number;
}

/** P03-9 / F-003：停止未确认时的保守隔离（仅活动 Attempt 才更新）。 */
export interface InterruptAttemptForStopInput {
  readonly projectId: string;
  readonly attemptId: string;
  /** 停止证据 Artifact 引用，仅作诊断引用，不冒充 Runtime 结算。 */
  readonly diagnosticRef: string;
  readonly timestamp: number;
}

export interface ValidatedExecutionBatchInsertInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  /** 固定成员集合；P04 单 Feature 输入归一化为一个成员。 */
  readonly featureIds: readonly string[];
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
 * Batch 插入输入校验：scopeSnapshot.featureIds 为非空、无重复的固定成员集合，
 * featureId 保留为 P04 兼容锚点且必须属于该集合；身份级快照有界、预算快照经权威校验、
 * 初始状态 queued、runsCreated ≥1（首次派发即占用一次 Run 名额，不出现零计数批次）。
 */
export function validateExecutionBatchInsertInput(
  value: unknown,
  operation: string,
): ValidatedExecutionBatchInsertInput {
  const context: ValidationContext = { operation, entity: { type: 'execution_batch' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, EXECUTION_BATCH_INSERT_KEYS, context, 'input');
  const scopeSnapshot = requireBoundedSnapshot(object.scopeSnapshot, context, 'scopeSnapshot');
  const featureId = requireStableIdField(object.featureId, context, 'featureId');
  const rawFeatureIds = (scopeSnapshot as { featureIds?: unknown }).featureIds;
  if (!Array.isArray(rawFeatureIds) || rawFeatureIds.length === 0) {
    throw validationError(
      context,
      'scopeSnapshot.featureIds',
      '必须是至少包含一个成员的数组',
      rawFeatureIds,
    );
  }
  const featureIds = rawFeatureIds.map((candidate, index) =>
    requireStableIdField(candidate, context, `scopeSnapshot.featureIds[${index}]`),
  );
  if (new Set(featureIds).size !== featureIds.length) {
    throw validationError(context, 'scopeSnapshot.featureIds', '成员不得重复', featureIds);
  }
  if (!featureIds.includes(featureId)) {
    throw validationError(
      context,
      'featureId',
      'P04 兼容锚点必须属于固定成员集合',
      featureId,
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
    featureId,
    featureIds,
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

export interface ValidatedBatchBudgetRevisionInput {
  readonly projectId: string;
  readonly batchId: string;
  /** CAS：调用方持有的当前 Batch budget_revision（过期拒绝，零部分更新）。 */
  readonly expectedBudgetRevision: number;
  /** 修订后的完整预算快照（经权威校验；仅增额或延期）。 */
  readonly budgetSnapshot: ExecutionBudgetSnapshot;
  /** 批准主体（服务端可信身份绑定，不接受请求输入）。 */
  readonly approvedBy: string;
  /** 非空修订理由（审计）。 */
  readonly reason: string;
}

const BATCH_BUDGET_REVISION_KEYS = [
  'projectId',
  'batchId',
  'expectedBudgetRevision',
  'budgetSnapshot',
  'approvedBy',
  'reason',
] as const;

/** 修订理由上限（与决策/结算理由同量级；有界拒绝无界文本）。 */
export const BATCH_BUDGET_REVISION_REASON_MAX_BYTES = 512;

/** 批准主体上限（principal 形态；拒绝无界身份文本）。 */
export const BATCH_BUDGET_REVISION_APPROVED_BY_MAX = 128;

/**
 * 预算修订原语输入校验（F-009）：expectedBudgetRevision ≥1 的 CAS 期望；
 * approvedBy/reason 非空有界（理由 ≤512 字符；tokenUsed/costUsed/outcome/
 * runsCreated/status 等执行域字段都是未知键——修订不携带也不自报用量或状态）。
 */
export function validateBatchBudgetRevisionInput(
  value: unknown,
  operation: string,
): ValidatedBatchBudgetRevisionInput {
  const context: ValidationContext = { operation, entity: { type: 'batch_budget_revision' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, BATCH_BUDGET_REVISION_KEYS, context, 'input');
  if (
    typeof object.expectedBudgetRevision !== 'number' ||
    !Number.isSafeInteger(object.expectedBudgetRevision) ||
    object.expectedBudgetRevision < 1
  ) {
    throw validationError(
      context,
      'expectedBudgetRevision',
      '必须是 ≥1 的安全整数（当前 Batch budget_revision CAS 期望）',
      object.expectedBudgetRevision,
    );
  }
  if (
    typeof object.approvedBy !== 'string' ||
    object.approvedBy.length === 0 ||
    object.approvedBy.length > BATCH_BUDGET_REVISION_APPROVED_BY_MAX
  ) {
    throw validationError(
      context,
      'approvedBy',
      `必须是非空字符串（≤${BATCH_BUDGET_REVISION_APPROVED_BY_MAX} 字符；服务端可信主体）`,
      object.approvedBy,
    );
  }
  if (
    typeof object.reason !== 'string' ||
    object.reason.trim().length === 0 ||
    object.reason.length > BATCH_BUDGET_REVISION_REASON_MAX_BYTES
  ) {
    throw validationError(
      context,
      'reason',
      `必须是非空说明（≤${BATCH_BUDGET_REVISION_REASON_MAX_BYTES} 字符）`,
      object.reason,
    );
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    expectedBudgetRevision: object.expectedBudgetRevision,
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
  readonly labels: string[];
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
  'labels',
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
  const projectId = requireStableIdField(object.projectId, context, 'projectId');
  return {
    projectId,
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    featureId: requireStableIdField(object.featureId, context, 'featureId'),
    runId: requireStableIdField(object.runId, context, 'runId'),
    purpose: object.purpose,
    labels: normalizeLabels(object.labels, { ...context, entity: { type: 'run', projectId } }, 'labels'),
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
  readonly eventType: ExecutionEventType;
  readonly aggregateType: 'run' | 'execution_batch' | 'task' | 'feature';
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

/**
 * 执行域事件追加输入校验（白名单双成员：Run 派发与 Batch 预算修订；payload 为
 * 事件类型冻结的单一脱敏键，聚合类型与事件类型绑定）。
 */
export function validateExecutionEventAppendInput(
  value: unknown,
  operation: string,
): ValidatedExecutionEventAppendInput {
  const context: ValidationContext = { operation, entity: { type: 'run' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, EXECUTION_EVENT_APPEND_KEYS, context, 'input');
  const eventTypeValue = object.eventType;
  if (
    typeof eventTypeValue !== 'string' ||
    !(EXECUTION_EVENT_TYPES as readonly string[]).includes(eventTypeValue)
  ) {
    throw validationError(context, 'eventType', `必须是 ${EXECUTION_EVENT_TYPES.join(' / ')}`, eventTypeValue);
  }
  const eventType = eventTypeValue as ExecutionEventType;
  const spec = EXECUTION_EVENT_SPECS[eventType];
  if (object.aggregateType !== spec.aggregateType) {
    throw validationError(
      context,
      'aggregateType',
      `事件 ${eventType} 的聚合类型必须是 ${spec.aggregateType}`,
      object.aggregateType,
    );
  }
  if (
    typeof object.aggregateRevision !== 'number' ||
    !Number.isSafeInteger(object.aggregateRevision) ||
    object.aggregateRevision < 1
  ) {
    throw validationError(context, 'aggregateRevision', '必须是 ≥1 的安全整数', object.aggregateRevision);
  }
  if (!isPlainObject(object.payload) || object.payload[spec.payloadKey] !== true) {
    throw validationError(
      context,
      'payload',
      `必须是 {${spec.payloadKey}:true}（脱敏事件固定形状）`,
      object.payload,
    );
  }
  const payload: Readonly<Record<string, unknown>> = { [spec.payloadKey]: true };
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    eventType,
    aggregateType: spec.aggregateType,
    aggregateId: requireStableIdField(object.aggregateId, context, 'aggregateId'),
    aggregateRevision: object.aggregateRevision,
    payload,
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

/* ------------------------------------------------------------------ *
 * P03-3 / F-007 Runtime 启动额度预占（迁移 v12；受信 Core 内部原语）
 *
 * 预占语义：SDK 启动前在同一写事务内校验同项目 Batch/Run 归属、有效控制状态
 * 与父 Batch 的 maxRuntimeStarts/绝对 deadline，然后原子递增
 * execution_batches.runtime_starts 并落一条幂等启动身份账本行（设计 04 §6.1
 * 「SDK启动前预占runtimeStart额度，启动失败可保守计数，不盲目退还」）。
 * 仅创建 Run、预览、准备输入或最终检查不增加 runtimeStarts；预占后启动失败
 * 保守保留一次启动计数，不伪造 token/cost 或真实 SDK 已启动事实：账本行
 * 只是预占证据，无用量列、无 sdk_started/outcome/进程列，也无任何退额原语。
 * 本原语不经命令面暴露，客户端/模型无自报入口；Runner、停止管理与会话
 * 记录属后续任务，不在此预支。
 * ------------------------------------------------------------------ */

/** Runtime 启动预占账本记录（迁移 v12 runtime_start_reservations 行的应用侧形态）。 */
export interface RuntimeStartReservationRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly batchId: string;
  readonly runId: string;
  /** 启动身份（受信 Core 生成的稳定键；同身份重放只计一次）。 */
  readonly startKey: string;
}

export interface ValidatedRuntimeStartReservationInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly startKey: string;
}

const RUNTIME_START_RESERVATION_KEYS = ['projectId', 'batchId', 'runId', 'startKey'] as const;

/**
 * Runtime 启动预占输入校验：仅接受同项目 Batch/Run + 启动身份；token/cost 用量、
 * sdkStarted/outcome/runner/进程等执行域字段都是未知键（预占不携带也不自报
 * 实际用量或已启动事实），classification 类记账字段同样拒绝（Runtime 启动无
 * 分类语义）。
 */
export function validateRuntimeStartReservationInput(
  value: unknown,
  operation: string,
): ValidatedRuntimeStartReservationInput {
  const context: ValidationContext = { operation, entity: { type: 'runtime_start_reservation' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, RUNTIME_START_RESERVATION_KEYS, context, 'input');
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    runId: requireStableIdField(object.runId, context, 'runId'),
    startKey: requireStartKey(object.startKey, context, 'startKey'),
  };
}

function requireStartKey(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim().length === 0) {
    throw validationError(context, field, '必须是非空非空白字符串（≤128 字符；受信 Core 生成的启动身份）', value);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * P03-3 / F-008 Run 结果幂等预算结算与连续无进展保护（迁移 v13；受信 Core
 * 内部原语，不经命令面暴露）
 *
 * 结算语义：受信 Core 在同一写事务内一次性记录 Run 终态结果（CAS 于 Run
 * revision 与活动状态）与 Batch 无进展计数：有新有效领域进展才重置
 * no_progress_runs（→0），否则恰好 +1；到 maxNoProgressRuns 后同事务终态化
 * Batch（failed）并持久化 budget_exhausted 原因，阻止同 Batch 新 Run。重复
 * 结果（同 resultKey）或旧 revision（runRevision CAS）不重复结算、不倒写
 * 终态；runs_created/attempts_created/runtime_starts 不因任何结果退还（无退额
 * 列、无退额原语）；绝对 Batch deadline 与 Run 时间依据（started_at/ended_at）
 * 保持不变（v9/v13 触发器保护）。
 *
 * 有效进展类型限定为 Core 可核验的领域事实：new_valid_task_passed（同项目、
 * Batch 单 Feature 范围内、tasks.status='passed' 的持久行——passed 只能由后续
 * Verifier 的受信写入产生，不能由模型自报）。运行成功文本、SDK 正常结束、
 * 心跳、日志、换模型不是进展证据类型（未知键/未知类型在输入面拒绝）；重放
 * 旧成功证据（同 (project,task) 证据已生效）不重置无进展计数（视为无进展）。
 * 本原语不代替后续 Verifier，也不实现完整暂停/取消/恢复流程；token/cost 实际
 * 用量结算属后续任务，结算行无用量列（不伪造用量）。
 * ------------------------------------------------------------------ */

/** 可结算的 Run 终态（与迁移 v13 outcome CHECK 同枚举；不可重开）。 */
export const RUN_OUTCOME_SETTLEMENT_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export type RunOutcomeSettlementOutcome = (typeof RUN_OUTCOME_SETTLEMENT_OUTCOMES)[number];

/** 生效进展类型（与迁移 v13 progress_type CHECK 同枚举）。 */
export const RUN_PROGRESS_EVIDENCE_TYPES = ['new_valid_task_passed'] as const;
export type RunProgressEvidenceType = (typeof RUN_PROGRESS_EVIDENCE_TYPES)[number];

/** Batch 因无进展耗尽而终态化时持久化的受控原因（reason 列定值）。 */
export const RUN_NO_PROGRESS_EXHAUSTION_REASON = 'budget_exhausted';

/** Run 结果结算账本记录（迁移 v13 run_outcome_settlements 行的应用侧形态）。 */
export interface RunOutcomeSettlementRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly batchId: string;
  readonly runId: string;
  /** 幂等结算身份（受信 Core 生成的稳定键；同身份重放只结算一次）。 */
  readonly resultKey: string;
  readonly outcome: RunOutcomeSettlementOutcome;
  /** 生效进展类型：none（无新有效领域进展）或 new_valid_task_passed。 */
  readonly progressType: 'none' | RunProgressEvidenceType;
  /** 进展证据 Task（仅 progressType=new_valid_task_passed 时非空）。 */
  readonly progressTaskId: string | null;
  /** Run 结束时间依据（结算一次性写入；v13 触发器保护不可重写）。 */
  readonly runEndedAtUtcMs: number;
  /** 结算后的 Batch 连续无进展计数终值（审计证据）。 */
  readonly noProgressRunsAfter: number;
  readonly reason: string | null;
}

export interface ValidatedRunOutcomeSettlementInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly resultKey: string;
  /** CAS：调用方持有的当前 Run revision；不匹配（旧 revision）拒绝结算。 */
  readonly runRevision: number;
  readonly outcome: RunOutcomeSettlementOutcome;
  readonly reason: string | null;
  readonly progressEvidence: { readonly type: RunProgressEvidenceType; readonly taskId: string } | null;
}

const RUN_OUTCOME_SETTLEMENT_KEYS = [
  'projectId',
  'batchId',
  'runId',
  'resultKey',
  'runRevision',
  'outcome',
  'reason',
  'progressEvidence',
] as const;

const RUN_PROGRESS_EVIDENCE_KEYS = ['type', 'taskId'] as const;

/**
 * 结算输入校验：仅接受同项目 Batch/Run + 幂等结算身份 + CAS revision + 终态
 * 结果 + 可选进展证据（恰 new_valid_task_passed 形态）。tokenUsed/costUsed/
 * sdkEnded/outputText/logs/modelChanged/progress 等运行事实都是未知键（运行
 * 成功文本、SDK 正常结束、心跳、日志、换模型不是进展证据输入字段，非法输入
 * 在任何 SQL 之前拒绝）；进展证据类型冻结为 RUN_PROGRESS_EVIDENCE_TYPES。
 */
export function validateRunOutcomeSettlementInput(
  value: unknown,
  operation: string,
): ValidatedRunOutcomeSettlementInput {
  const context: ValidationContext = { operation, entity: { type: 'run_outcome_settlement' } };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, RUN_OUTCOME_SETTLEMENT_KEYS, context, 'input');
  if (
    typeof object.resultKey !== 'string' || object.resultKey.length === 0 ||
    object.resultKey.length > 128 || object.resultKey.trim().length === 0
  ) {
    throw validationError(context, 'resultKey', '必须是非空非空白字符串（≤128 字符；受信 Core 生成的结算身份）', object.resultKey);
  }
  if (
    typeof object.runRevision !== 'number' ||
    !Number.isSafeInteger(object.runRevision) ||
    object.runRevision < 1
  ) {
    throw validationError(context, 'runRevision', '必须是 ≥1 的安全整数（当前 Run revision）', object.runRevision);
  }
  if (
    typeof object.outcome !== 'string' ||
    !(RUN_OUTCOME_SETTLEMENT_OUTCOMES as readonly string[]).includes(object.outcome)
  ) {
    throw validationError(
      context,
      'outcome',
      `必须是 ${RUN_OUTCOME_SETTLEMENT_OUTCOMES.join('/')}（可结算终态）`,
      object.outcome,
    );
  }
  if (object.reason !== null && typeof object.reason !== 'string') {
    throw validationError(context, 'reason', '必须是字符串或 null', object.reason);
  }
  if (object.reason !== null && (object.reason.length === 0 || object.reason.trim().length === 0 || object.reason.length > 512)) {
    throw validationError(context, 'reason', '必须是非空说明（≤512 字符）或 null', object.reason);
  }
  let progressEvidence: ValidatedRunOutcomeSettlementInput['progressEvidence'] = null;
  if (object.progressEvidence !== undefined && object.progressEvidence !== null) {
    const evidence = requirePlainObject(object.progressEvidence, context, 'progressEvidence');
    rejectUnknownKeys(evidence, RUN_PROGRESS_EVIDENCE_KEYS, context, 'progressEvidence');
    if (
      typeof evidence.type !== 'string' ||
      !(RUN_PROGRESS_EVIDENCE_TYPES as readonly string[]).includes(evidence.type)
    ) {
      throw validationError(
        context,
        'progressEvidence.type',
        `必须是 ${RUN_PROGRESS_EVIDENCE_TYPES.join('/')}（Core 可核验领域进展类型；运行成功文本/SDK 正常结束/心跳/日志/换模型不是进展）`,
        evidence.type,
      );
    }
    progressEvidence = {
      type: evidence.type as RunProgressEvidenceType,
      taskId: requireStableIdField(evidence.taskId, context, 'progressEvidence.taskId'),
    };
  }
  return {
    projectId: requireStableIdField(object.projectId, context, 'projectId'),
    batchId: requireStableIdField(object.batchId, context, 'batchId'),
    runId: requireStableIdField(object.runId, context, 'runId'),
    resultKey: object.resultKey,
    runRevision: object.runRevision,
    outcome: object.outcome as RunOutcomeSettlementOutcome,
    reason: object.reason,
    progressEvidence,
  };
}
