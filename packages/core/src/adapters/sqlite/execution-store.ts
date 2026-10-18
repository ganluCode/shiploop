/**
 * P03-3 / F-005 执行域 SQLite 适配器（adapters 层）：迁移 v9 三表
 * （execution_batches/runs/batch_budget_revisions）的同会话同步事务原语，供
 * 原子命令事务在同一 BEGIN IMMEDIATE 内组合使用（ports/execution-store.ts 契约）。
 * P03-3 / F-006 起追加迁移 v11 的 Task 尝试预算预占与分类记账原语（tasks 双计数列
 * + task_attempt_reservations 账本表；同事务原子生效，详见 reserveTaskAttempt）。
 * P03-3 / F-007 起追加迁移 v12 的 Runtime 启动额度预占原语（SDK 启动前原子递增
 * execution_batches.runtime_starts 并落幂等启动身份账本行，详见 reserveRuntimeStart）。
 *
 * 不变量：
 * - 写原语只允许在写事务内调用（唯一事务由原子命令事务拥有）；事务内不执行
 *   文件流、SDK、Git、网络或长检查；不嵌套事务；
 * - 输入一律 unknown，先经 ports 校验器再持久化：校验失败发生在任何 SQL 之前；
 * - 归属核验在同一事务内以绑定参数查询完成：目标缺失 → not_found；跨项目 →
 *   ownership；迁移 v9 复合外键/条件唯一索引作为防御纵深兜底（SQLITE_CONSTRAINT
 *   原样上抛，由命令服务按公开错误映射折叠，不泄漏 SQL 原文）；
 * - 读取映射对持久 JSON/预算快照重新解析并经权威校验，损坏行以 kind='corrupt'
 *   拒绝（fail-closed），不作为有效记录返回；不泄漏驱动会话或 ORM 类型；
 * - Run 派发计数原语只递增 runs_created/revision/updated_at（单语句条件 UPDATE，
 *   原子递增；终态 Batch 不接受新派发计数）；不可变列由迁移 v9 触发器保护，
 *   本适配器不提供任何覆盖途径；
 * - 时间为注入的 UTC 毫秒；id 由适配器生成 UUID v4；JSON 列只写入经校验的
 *   有界结构化 JSON。
 *
 * 本适配器不实现：启动命令编排（application/execution-start）、预算修订命令编排
 * （application/execution-budget-revise；P03-3 / F-009 起本适配器提供
 * reviseBatchBudget 存储 CAS 原语）、完整 Attempt
 * 生命周期/owner/fencing/进程执行（P03-4）、Runner/停止管理/会话记录（后续任务）。
 * P03-3 / F-010 起提供只读查询面（readExecutionBudgetView / findExecutionBatchRecord /
 * listBatchBudgetRevisionRecords）：一致读视图零写入、零事件、零唤醒，跨项目/
 * 不存在目标统一 undefined（存在性折叠由应用层承担）。
 */
import { randomUUID } from 'node:crypto';
import { ACTIVE_ATTEMPT_STATUSES } from '../../ports/attempt-store.js';
import { CODE_ATTEMPT_SETTLEMENT_PREFIX, validateCodeAttemptSettlement } from '../../ports/code-attempt-budget.js';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import {
  evaluateBatchBudgetRevision,
  evaluateRunBudgetReservation,
  evaluateTaskCodeAttemptReservation,
  resolveTaskAttemptCaps,
  validateExecutionBudgetSnapshot,
} from '../../ports/execution-budget.js';
import type { ExecutionBudgetSnapshot } from '../../ports/execution-budget.js';
import {
  EXECUTION_ACTIVE_STATUSES,
  EXECUTION_BATCH_PAUSED_EVENT_TYPE,
  EXECUTION_RUN_PAUSED_EVENT_TYPE,
  executionCorruptError,
  isExecutionActiveStatus,
  isExecutionTerminalStatus,
  RUN_NO_PROGRESS_EXHAUSTION_REASON,
  TASK_ATTEMPT_CLASSIFIED_BY_CORE,
  validateBatchBudgetRevisionInsertInput,
  validateBatchBudgetRevisionInput,
  validateExecutionBatchInsertInput,
  validateExecutionEventAppendInput,
  validateExecutionRunInsertInput,
  validateRuntimeStartReservationInput,
  validateRunOutcomeSettlementInput,
  validateTaskAttemptReclassifyInput,
  validateTaskAttemptReservationInput,
} from '../../ports/execution-store.js';
import type {
  BatchBudgetRevisionRecord,
  BatchBudgetRevisionResult,
  ExecutionBatchRecord,
  ExecutionBatchStatus,
  ExecutionPauseInput,
  ExecutionPauseResult,
  RunOutcomeSettlementOutcome,
  RunOutcomeSettlementRecord,
  RunRecord,
  RuntimeStartReservationRecord,
  TaskAttemptClassification,
  TaskAttemptReservationRecord,
  TaskExecutionCountersRecord,
} from '../../ports/execution-store.js';
import type {
  ExecutionBudgetQueryReadStore,
  ExecutionBudgetTaskRow,
  ExecutionBudgetView,
} from '../../ports/execution-budget-query.js';
import { TASK_STATUSES } from '../../ports/plan-store.js';
import type { TaskStatus } from '../../ports/plan-store.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import type { PlanListRequest, PlanRecordPage, SettingsScopeSnapshot } from '../../ports/queries.js';
import { parseStoredSettingsPayload } from '../../ports/settings-schema.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';

export interface SqliteExecutionStoreOptions {
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性时间。 */
  readonly nowUtcMs?: () => number;
}

interface ExecutionBatchSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly phase_id: string;
  readonly feature_id: string;
  readonly scope_snapshot: string;
  readonly config_snapshot: string;
  readonly status: string;
  readonly budget_revision: number;
  readonly budget_snapshot: string;
  readonly runs_created: number;
  readonly attempts_created: number;
  readonly runtime_starts: number;
  readonly no_progress_runs: number;
  readonly deadline_at: number;
  readonly reason: string | null;
  readonly pause_requested_at: number | null;
}

interface RunSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly batch_id: string;
  readonly feature_id: string;
  readonly purpose: string;
  readonly input_snapshot: string;
  readonly config_snapshot: string;
  readonly status: string;
  readonly scope_digest: string;
  readonly work_key: string;
  readonly dispatch_ordinal: number;
  readonly max_attempts_per_run: number;
  readonly run_time_limit_ms: number;
  readonly attempts_created: number;
  readonly reason: string | null;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly pause_requested_at: number | null;
}

interface TaskAttemptReservationSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly batch_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt_key: string;
  readonly classification: string;
  readonly classified_by: string;
  readonly reason: string | null;
}

interface RuntimeStartReservationSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly batch_id: string;
  readonly run_id: string;
  readonly start_key: string;
}

interface RunOutcomeSettlementSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly batch_id: string;
  readonly run_id: string;
  readonly result_key: string;
  readonly outcome: string;
  readonly progress_type: string;
  readonly progress_task_id: string | null;
  readonly run_ended_at: number;
  readonly no_progress_runs_after: number;
  readonly reason: string | null;
}

const SELECT_BATCH_SQL =
  'SELECT id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, ' +
  'config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
  'runtime_starts, no_progress_runs, deadline_at, reason, pause_requested_at FROM execution_batches';
const SELECT_RUN_SQL =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
  'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, ' +
  'max_attempts_per_run, run_time_limit_ms, attempts_created, reason, started_at, ended_at, ' +
  'pause_requested_at FROM runs';
const SELECT_RESERVATION =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, run_id, task_id, attempt_key, ' +
  'classification, classified_by, reason FROM task_attempt_reservations';
const SELECT_RUNTIME_START_RESERVATION =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, run_id, start_key ' +
  'FROM runtime_start_reservations';
const SELECT_SETTLEMENT =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, run_id, result_key, outcome, ' +
  'progress_type, progress_task_id, run_ended_at, no_progress_runs_after, reason FROM run_outcome_settlements';
const SELECT_REVISION =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, version, budget_snapshot, ' +
  'deadline_at, approved_by, reason FROM batch_budget_revisions';

/** 迁移 v9 batch_budget_revisions 行（F-010 修订历史分页读取）。 */
interface BatchBudgetRevisionSqlRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly batch_id: string;
  readonly version: number;
  readonly budget_snapshot: string;
  readonly deadline_at: number;
  readonly approved_by: string;
  readonly reason: string;
}

/** tasks 执行计数/策略副本列（F-010 Task 层查询读取）。 */
interface TaskBudgetSqlRow {
  readonly id: string;
  readonly status: string;
  readonly first_passed_at: number | null;
  readonly attempt_counter: number;
  readonly code_attempts_used: number;
  readonly execution_config: string;
}

const BATCH_STATUS_SET = new Set<string>([
  'queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted',
]);

const ACTIVE_PLACEHOLDERS = EXECUTION_ACTIVE_STATUSES.map(() => '?').join(', ');

export interface SqliteExecutionAccess {
  /** 创建单 Feature 执行批次（初始 queued、runsCreated ≥1；同 Phase 活动唯一兜底）。 */
  insertExecutionBatchInTransaction(input: unknown): ExecutionBatchRecord;
  /** 插入批次预算修订行（初始 version=1 与历史快照；插后不可变）。 */
  insertBatchBudgetRevisionInTransaction(input: unknown): BatchBudgetRevisionRecord;
  /**
   * P03-3 / F-009 批次预算显式修订（同事务原子生效）：CAS 于当前
   * budget_revision（过期零部分更新）且仅限活动 Batch；仅增额或延期
   * （evaluateBatchBudgetRevision 单调判定，携带累计用量防御降额到已用值
   * 以下）；一次调用原子更新当前预算（budget_snapshot/budget_revision/
   * deadline_at/revision/updated_at）并追加不可变修订行（version+1），不触碰
   * 累计计数与任何快照列；任一步失败整组回滚。
   */
  reviseBatchBudgetInTransaction(input: unknown): BatchBudgetRevisionResult;
  /** 创建执行 Run（派发身份/上限冻结；同 Feature 活动 Run 唯一兜底）。 */
  insertExecutionRunInTransaction(input: unknown): RunRecord;
  /** 读取目标 Batch（同项目；缺失 not_found、跨项目 ownership）。 */
  getExecutionBatchInTransaction(projectId: string, batchId: string): ExecutionBatchRecord;
  /** 同 Batch 同 workKey 的全部 Run（按 dispatch_ordinal 升序；重派发判定输入）。 */
  listExecutionRunsForWorkKeyInTransaction(
    projectId: string,
    batchId: string,
    workKey: string,
  ): readonly RunRecord[];
  /** 同 Feature 当前活动 Run（迁移 v9 条件唯一索引同源活动集；无则 null）。 */
  getActiveExecutionRunInTransaction(projectId: string, featureId: string): RunRecord | null;
  /** 同 Phase 当前活动 Batch（迁移 v9 条件唯一索引同源活动集；无则 null）。 */
  getActivePhaseExecutionBatchInTransaction(projectId: string, phaseId: string): ExecutionBatchRecord | null;
  /** 派发计数原子递增（runs_created+1/revision+1/updated_at；仅非终态 Batch 命中）。 */
  recordExecutionRunDispatchInTransaction(projectId: string, batchId: string): ExecutionBatchRecord;
  /** 执行域脱敏事件追加（state_events；与公开白名单同形）。 */
  appendExecutionEventInTransaction(input: unknown): string;
  /**
   * P03-9 / F-001：Task 边界暂停意图（同一短写事务内原子持久化）。
   * 目标为 Run 或 Batch；无活动 Attempt 时直接 paused，有活动 Attempt 时
   * pausing（当前 Attempt 仍可完成验证/必要收尾，后续由生命周期收尾为 paused）。
   * 终态只返回 already_terminal，绝不倒写；interrupted 保留既有隔离状态。
   * 不修改预算、deadline、累计计数或代码；CAS 于 expectedRevision。
   */
  requestExecutionPauseInTransaction(input: ExecutionPauseInput): ExecutionPauseResult;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-006 Task 尝试预算预占与分类记账（迁移 v11；受信 Core 内部原语）
   * ---------------------------------------------------------------- */
  /**
   * 总 Attempt 预占（同事务原子生效）：校验同项目 Batch/Run/Task 归属、有效控制
   * 状态与绝对 deadline 后，一次调用同时递增 Batch 与 Run 的 attempts_created 及
   * Task 双计数（attempt_counter/code_attempts_used，预占恒记 code），并落一条
   * 幂等身份账本行；同身份重放返回既有记录不重复调账；任一层额度耗尽拒绝
   * （budget_exhausted）且零写入。P03-4 在同一事务内接入真实 Attempt 创建。
   */
  reserveTaskAttemptInTransaction(input: unknown): TaskAttemptReservationRecord;
  /**
   * 受信 Core 基础设施重分类（单向 code→infrastructure）：仅退还代码额度
   * （code_attempts_used-1），总 Attempt（attempt_counter）、Batch/Run 累计计数、
   * runtime_starts 与绝对时间不退还；重复分类幂等不重复调账。
   */
  reclassifyTaskAttemptAsInfrastructureInTransaction(input: unknown): TaskAttemptReservationRecord;
  settleTaskAttemptBudgetInTransaction(input: unknown): TaskAttemptReservationRecord;
  /** 同项目同 Task 同预占身份的账本行（无则 null）。 */
  getTaskAttemptReservationInTransaction(
    projectId: string,
    taskId: string,
    attemptKey: string,
  ): TaskAttemptReservationRecord | null;
  /** Task 预算双计数的持久读取（缺失 not_found、跨项目 ownership）。 */
  getTaskExecutionCountersInTransaction(projectId: string, taskId: string): TaskExecutionCountersRecord;
  /** 读取目标 Run（缺失 not_found、跨项目 ownership；计数断言与组合事务读取用）。 */
  getExecutionRunInTransaction(projectId: string, runId: string): RunRecord;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-007 Runtime 启动额度预占（迁移 v12；受信 Core 内部原语）
   * ---------------------------------------------------------------- */
  /**
   * Runtime 启动预占（SDK 启动前的受信边界；同事务原子生效）：校验同项目
   * Batch/Run 归属、有效控制状态与父 Batch 的 maxRuntimeStarts/绝对 deadline 后，
   * 一次调用原子递增 execution_batches.runtime_starts 并落一条幂等启动身份账本行；
   * 同身份重放返回既有记录不重复计数；跨 Run 复用同身份 conflict；额度耗尽或
   * deadline 到达拒绝（budget_exhausted）且零写入。启动失败保守保留计数（无退额）。
   */
  reserveRuntimeStartInTransaction(input: unknown): RuntimeStartReservationRecord;
  /** 同项目同 Run 同启动身份的账本行（无则 null）。 */
  getRuntimeStartReservationInTransaction(
    projectId: string,
    runId: string,
    startKey: string,
  ): RuntimeStartReservationRecord | null;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-008 Run 结果结算与连续无进展保护（迁移 v13；受信 Core 内部原语）
   * ---------------------------------------------------------------- */
  /**
   * Run 结果幂等结算（同事务原子生效）：一次性记录 Run 终态（CAS 于 runRevision
   * 与活动状态；不倒写终态、ended_at 一次写入不可重写）与 Batch 无进展计数
   * （新有效领域进展重置为 0，否则恰好 +1；到 maxNoProgressRuns 同事务终态化
   * Batch failed 并持久化 budget_exhausted 原因）；同 resultKey 重放返回既有
   * 记录；runs_created/attempts_created/runtime_starts 不退还（无退额路径）。
   */
  settleExecutionRunOutcomeInTransaction(input: unknown): RunOutcomeSettlementRecord;
  /** 同项目同 Run 同结算身份的账本行（无则 null）。 */
  getRunOutcomeSettlementInTransaction(
    projectId: string,
    runId: string,
    resultKey: string,
  ): RunOutcomeSettlementRecord | null;
  /* ---------------------------------------------------------------- *
   * P03-3 / F-010 只读查询面（一致读视图；零写入零事件零唤醒）
   * ---------------------------------------------------------------- */
  /**
   * 执行预算一致读视图（单一 DEFERRED 读事务）：Batch + 全部 Run + 固定范围
   * Task 计数/策略副本 + 全局/项目当前配置；跨项目/不存在目标统一 undefined。
   */
  readExecutionBudgetView(projectId: unknown, batchId: unknown): ExecutionBudgetView | undefined;
  /** 同项目 Batch 行（修订分页前的存在性/归属把关；无则 undefined）。 */
  findExecutionBatchRecord(projectId: unknown, batchId: unknown): ExecutionBatchRecord | undefined;
  /** 预算修订历史有界分页（版本升序键集；可见范围谓词下推）。 */
  listBatchBudgetRevisionRecords(
    visibility: unknown,
    projectId: unknown,
    batchId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<BatchBudgetRevisionRecord>;
}

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as { code?: unknown }).code as string).startsWith('SQLITE_CONSTRAINT')
  );
}

export function createSqliteExecutionAccess(
  session: SqliteStorageSession,
  options: SqliteExecutionStoreOptions = {},
): SqliteExecutionAccess {
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  // 迁移 v27 之前的库仍可被升级/种子测试读取：缺失暂停意图列时以 NULL 兼容，
  // 不为读取修改 schema；v27 之后正常读取持久值。
  const pauseColumnsPresent = (() => {
    const count = (table: string) => (session.database
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = 'pause_requested_at'`)
      .get(table) ?? { n: 0 }).n;
    return count('runs') === 1 && count('execution_batches') === 1;
  })();
  const SELECT_BATCH = pauseColumnsPresent ? SELECT_BATCH_SQL
    : SELECT_BATCH_SQL.replace('reason, pause_requested_at FROM execution_batches', 'reason, NULL AS pause_requested_at FROM execution_batches');
  const SELECT_RUN = pauseColumnsPresent ? SELECT_RUN_SQL
    : SELECT_RUN_SQL.replace('pause_requested_at FROM runs', 'NULL AS pause_requested_at FROM runs');

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  }

  function assertInTransaction(operation: string): void {
    if (!session.database.inTransaction) {
      throw new TypeError(`${operation}: 执行域原语只允许在写事务内使用`);
    }
  }

  function notFound(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('not_found', operation, `${operation}: ${message}`, { entity });
  }

  function ownership(operation: string, entity: StorageEntityRef, message: string): StorageError {
    return new StorageError('ownership', operation, `${operation}: ${message}`, { entity });
  }

  function parseJsonColumn(text: string, operation: string, reason: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed as Record<string, unknown>;
    } catch (cause) {
      throw executionCorruptError(operation, { type: 'execution_batch' }, '执行域持久 JSON 列损坏', cause);
    }
  }

  function parseBudgetSnapshot(
    text: string,
    operation: string,
    entityType: StorageEntityRef['type'],
  ): ExecutionBudgetSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw executionCorruptError(operation, { type: entityType }, '预算快照 JSON 损坏', cause);
    }
    try {
      return validateExecutionBudgetSnapshot(parsed, { operation, entity: { type: entityType } });
    } catch (cause) {
      throw executionCorruptError(operation, { type: entityType }, '预算快照形态非法', cause);
    }
  }

  function requireBatchStatus(
    status: string,
    operation: string,
    entityType: StorageEntityRef['type'],
  ): ExecutionBatchStatus {
    if (!BATCH_STATUS_SET.has(status)) {
      throw executionCorruptError(operation, { type: entityType }, `执行状态非法（${status}）`);
    }
    return status as ExecutionBatchStatus;
  }

  function batchFromRow(row: ExecutionBatchSqlRow, operation: string): ExecutionBatchRecord {
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
      phaseId: row.phase_id,
      featureId: row.feature_id,
      scopeSnapshot: parseJsonColumn(row.scope_snapshot, operation, 'invalid_scope_snapshot_json'),
      configSnapshot: parseJsonColumn(row.config_snapshot, operation, 'invalid_config_snapshot_json'),
      status: requireBatchStatus(row.status, operation, 'execution_batch'),
      budgetRevision: row.budget_revision,
      budgetSnapshot: parseBudgetSnapshot(row.budget_snapshot, operation, 'execution_batch'),
      runsCreated: row.runs_created,
      attemptsCreated: row.attempts_created,
      runtimeStarts: row.runtime_starts,
      noProgressRuns: row.no_progress_runs,
      deadlineAtUtcMs: row.deadline_at,
      reason: row.reason,
      pauseRequestedAtUtcMs: row.pause_requested_at,
    };
  }

  function runFromRow(row: RunSqlRow, operation: string): RunRecord {
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
      batchId: row.batch_id,
      featureId: row.feature_id,
      purpose: row.purpose,
      inputSnapshot: parseJsonColumn(row.input_snapshot, operation, 'invalid_input_snapshot_json'),
      configSnapshot: parseJsonColumn(row.config_snapshot, operation, 'invalid_config_snapshot_json'),
      status: requireBatchStatus(row.status, operation, 'run'),
      scopeDigest: row.scope_digest,
      workKey: row.work_key,
      dispatchOrdinal: row.dispatch_ordinal,
      maxAttemptsPerRun: row.max_attempts_per_run,
      runTimeLimitMs: row.run_time_limit_ms,
      attemptsCreated: row.attempts_created,
      reason: row.reason,
      startedAtUtcMs: row.started_at,
      endedAtUtcMs: row.ended_at,
      pauseRequestedAtUtcMs: row.pause_requested_at,
    };
  }

  function insertExecutionBatchInTransaction(input: unknown): ExecutionBatchRecord {
    const operation = 'ExecutionStore.insertExecutionBatch';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateExecutionBatchInsertInput(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    // 归属核验（同事务绑定参数）：父 Feature/Phase 缺失或跨项目 → 结构化错误
    // （迁移 v9 复合外键为兜底）。
    const featureRow = db
      .prepare('SELECT project_id, phase_id FROM features WHERE id = ?')
      .get(valid.featureId) as { project_id: string; phase_id: string } | undefined;
    const batchEntity: StorageEntityRef = { type: 'execution_batch', projectId: valid.projectId, id: valid.batchId };
    if (featureRow === undefined) {
      throw notFound(operation, batchEntity, `Feature ${valid.featureId} 不存在`);
    }
    if (featureRow.project_id !== valid.projectId) {
      throw ownership(operation, batchEntity, 'Feature 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (featureRow.phase_id !== valid.phaseId) {
      throw ownership(operation, batchEntity, 'phaseId 与 Feature 所属 Phase 不一致');
    }
    // 同 Phase 活动 Batch 唯一（事务内存在性检查 + 条件唯一索引兜底）。
    const activeStatuses = EXECUTION_ACTIVE_STATUSES as readonly string[];
    const activeBatch = db
      .prepare(
        `SELECT id FROM execution_batches WHERE project_id = ? AND phase_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .get(valid.projectId, valid.phaseId, ...activeStatuses) as { id: string } | undefined;
    if (activeBatch !== undefined) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: 同 Phase 已有活动 Batch（${activeBatch.id}），不创建新批次`,
        { entity: batchEntity, details: { reason: 'active_batch_in_phase' } },
      );
    }
    try {
      db.prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
          'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
          'runtime_starts, no_progress_runs, deadline_at, reason) ' +
          'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, ?, ?)',
      ).run(
        valid.batchId,
        timestamp,
        valid.projectId,
        timestamp,
        valid.phaseId,
        valid.featureId,
        JSON.stringify(valid.scopeSnapshot),
        JSON.stringify(valid.configSnapshot),
        valid.status,
        JSON.stringify(valid.budgetSnapshot),
        valid.runsCreated,
        valid.budgetSnapshot.batch.deadlineUtcMs,
        valid.reason,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 批次写入被 DDL 约束拒绝（范围/预算/活动唯一）`,
          { entity: batchEntity, cause: error },
        );
      }
      throw error;
    }
    const row = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow;
    return batchFromRow(row, operation);
  }

  function insertBatchBudgetRevisionInTransaction(input: unknown): BatchBudgetRevisionRecord {
    const operation = 'ExecutionStore.insertBatchBudgetRevision';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBatchBudgetRevisionInsertInput(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const entity: StorageEntityRef = { type: 'batch_budget_revision', projectId: valid.projectId, id: valid.batchId };
    const batchRow = db
      .prepare('SELECT project_id FROM execution_batches WHERE id = ?')
      .get(valid.batchId) as { project_id: string } | undefined;
    if (batchRow === undefined) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    if (batchRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO batch_budget_revisions (id, created_at, project_id, revision, updated_at, batch_id, ' +
          'version, budget_snapshot, deadline_at, approved_by, reason) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.batchId,
        valid.version,
        JSON.stringify(valid.budgetSnapshot),
        valid.budgetSnapshot.batch.deadlineUtcMs,
        valid.approvedBy,
        valid.reason,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 预算修订写入被 DDL 约束拒绝（修订身份唯一）`,
          { entity, cause: error },
        );
      }
      throw error;
    }
    return {
      id,
      createdAtUtcMs: timestamp,
      projectId: valid.projectId,
      batchId: valid.batchId,
      version: valid.version,
      budgetSnapshot: valid.budgetSnapshot,
      deadlineAtUtcMs: valid.budgetSnapshot.batch.deadlineUtcMs,
      approvedBy: valid.approvedBy,
      reason: valid.reason,
    };
  }

  /* ------------------------------------------------------------ *
   * P03-3 / F-009 批次预算显式修订（短事务 CAS 原语）
   * ------------------------------------------------------------ */

  function reviseBatchBudgetInTransaction(input: unknown): BatchBudgetRevisionResult {
    const operation = 'ExecutionStore.reviseBatchBudget';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateBatchBudgetRevisionInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'execution_batch', projectId: valid.projectId, id: valid.batchId };

    // 1) 归属核验（同事务绑定参数；迁移 v9 复合外键为兕底）：跨项目拒绝。
    const row = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    if (row.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }

    // 2) 预算 CAS（过期 revision 拒绝，零部分更新）与活动集（终态 Batch 不接受
    //    修订——授权关闭，新工作需新授权；paused/interrupted 不是可绕过的终态）。
    if (row.budget_revision !== valid.expectedBudgetRevision) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} budget_revision 已变化（旧 revision 不重复修订）`,
        {
          entity,
          details: {
            reason: 'budget_revision_stale',
            expectedRevision: valid.expectedBudgetRevision,
            actualRevision: row.budget_revision,
          },
        },
      );
    }
    if (!isExecutionActiveStatus(row.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态 ${row.status} 不接受预算修订（授权已关闭）`,
        { entity, details: { reason: 'batch_not_active', status: row.status } },
      );
    }

    // 3) 仅增额或延期（纯函数单调判定；携带累计用量做降额防御）——全部先于
    //    任何写入；违规拒绝且零写入（预算快照已在上面的输入校验中经权威校验）。
    const currentSnapshot = parseBudgetSnapshot(row.budget_snapshot, operation, 'execution_batch');
    const decision = evaluateBatchBudgetRevision({
      current: currentSnapshot,
      proposed: valid.budgetSnapshot,
      usage: {
        runsCreated: row.runs_created,
        attemptsCreated: row.attempts_created,
        runtimeStarts: row.runtime_starts,
        noProgressRuns: row.no_progress_runs,
      },
    });
    if (!decision.allowed) {
      const primary = decision.violations[0];
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: 预算修订仅允许增额或延期（${primary.dimension} ${primary.reason}）`,
        {
          entity,
          details: {
            reason: primary.reason === 'limit_below_used' ? 'limit_below_used' : 'revision_not_increased',
            violations: decision.violations,
          },
        },
      );
    }

    // 4) 同事务原子写入：单语句条件 UPDATE 同时完成 CAS（budget_revision=
    //    expected）与活动集复核，并更新当前预算三列 + 行 revision；随后追加
    //    不可变修订行（version+1）。任一步失败整组回滚（无部分更新）；累计
    //    计数与身份/范围/配置快照列不触碰（迁移 v9 触发器保护不可变列）。
    const timestamp = nowUtcMs();
    const update = db
      .prepare(
        `UPDATE execution_batches SET budget_snapshot = ?, budget_revision = budget_revision + 1, ` +
          `deadline_at = ?, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND budget_revision = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(
        JSON.stringify(valid.budgetSnapshot),
        valid.budgetSnapshot.batch.deadlineUtcMs,
        timestamp,
        valid.batchId,
        valid.projectId,
        valid.expectedBudgetRevision,
        ...(EXECUTION_ACTIVE_STATUSES as readonly string[]),
      );
    if (update.changes !== 1) {
      // 与步骤 2/3 之间的串行化窗口内状态变化：以当前行重判拒绝原因。
      const current = db
        .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
        .get(valid.batchId) as ExecutionBatchSqlRow | undefined;
      if (current === undefined) {
        throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
      }
      if (current.budget_revision !== valid.expectedBudgetRevision) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: Batch ${valid.batchId} budget_revision 已变化（旧 revision 不重复修订）`,
          {
            entity,
            details: {
              reason: 'budget_revision_stale',
              expectedRevision: valid.expectedBudgetRevision,
              actualRevision: current.budget_revision,
            },
          },
        );
      }
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态 ${current.status} 不接受预算修订（授权已关闭）`,
        { entity, details: { reason: 'batch_not_active', status: current.status } },
      );
    }
    const updatedRow = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow;
    const newVersion = valid.expectedBudgetRevision + 1;
    // 追加不可变修订行（同事务）：任何失败（如修订身份唯一冲突）直接传播，
    // 上面的预算 UPDATE 随整组事务回滚——不允许部分更新。
    const revision = insertBatchBudgetRevisionInTransaction({
      projectId: valid.projectId,
      batchId: valid.batchId,
      version: newVersion,
      budgetSnapshot: valid.budgetSnapshot,
      approvedBy: valid.approvedBy,
      reason: valid.reason,
    });
    return {
      batch: batchFromRow(updatedRow, operation),
      revision,
      previousBudgetRevision: row.budget_revision,
      previousBudgetSnapshot: currentSnapshot,
      previousDeadlineAtUtcMs: row.deadline_at,
    };
  }

  function getExecutionBatchInTransaction(projectId: string, batchId: string): ExecutionBatchRecord {
    const operation = 'ExecutionStore.getExecutionBatch';
    assertOpen(operation);
    assertInTransaction(operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'execution_batch', projectId, id: batchId };
    const row = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(batchId) as ExecutionBatchSqlRow | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, `Batch ${batchId} 不存在`);
    }
    if (row.project_id !== projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    return batchFromRow(row, operation);
  }

  function listExecutionRunsForWorkKeyInTransaction(
    projectId: string,
    batchId: string,
    workKey: string,
  ): readonly RunRecord[] {
    const operation = 'ExecutionStore.listExecutionRunsForWorkKey';
    assertOpen(operation);
    assertInTransaction(operation);
    const rows = session.database
      .prepare<[string, string, string], RunSqlRow>(
        `${SELECT_RUN} WHERE project_id = ? AND batch_id = ? AND work_key = ? ORDER BY dispatch_ordinal, id`,
      )
      .all(projectId, batchId, workKey) as RunSqlRow[];
    return rows.map((row) => runFromRow(row, operation));
  }

  function getActiveExecutionRunInTransaction(projectId: string, featureId: string): RunRecord | null {
    const operation = 'ExecutionStore.getActiveExecutionRun';
    assertOpen(operation);
    assertInTransaction(operation);
    const activeStatuses = EXECUTION_ACTIVE_STATUSES as readonly string[];
    const row = session.database
      .prepare<unknown[], RunSqlRow>(
        `${SELECT_RUN} WHERE project_id = ? AND feature_id = ? AND status IN (${ACTIVE_PLACEHOLDERS}) ORDER BY id LIMIT 1`,
      )
      .get(projectId, featureId, ...activeStatuses) as RunSqlRow | undefined;
    return row === undefined ? null : runFromRow(row, operation);
  }

  function getActivePhaseExecutionBatchInTransaction(
    projectId: string,
    phaseId: string,
  ): ExecutionBatchRecord | null {
    const operation = 'ExecutionStore.getActivePhaseExecutionBatch';
    assertOpen(operation);
    assertInTransaction(operation);
    const activeStatuses = EXECUTION_ACTIVE_STATUSES as readonly string[];
    const row = session.database
      .prepare<unknown[], ExecutionBatchSqlRow>(
        `${SELECT_BATCH} WHERE project_id = ? AND phase_id = ? AND status IN (${ACTIVE_PLACEHOLDERS}) ORDER BY id LIMIT 1`,
      )
      .get(projectId, phaseId, ...activeStatuses) as ExecutionBatchSqlRow | undefined;
    return row === undefined ? null : batchFromRow(row, operation);
  }

  function recordExecutionRunDispatchInTransaction(projectId: string, batchId: string): ExecutionBatchRecord {
    const operation = 'ExecutionStore.recordExecutionRunDispatch';
    assertOpen(operation);
    assertInTransaction(operation);
    const db = session.database;
    const entity: StorageEntityRef = { type: 'execution_batch', projectId, id: batchId };
    const timestamp = nowUtcMs();
    // 单语句条件 UPDATE：非终态 Batch 的 runs_created 原子 +1（CAS 于 status
    // 活动集；终态批次不接受新派发计数）。DDL CHECK 非负兜底。
    const result = db
      .prepare(
        `UPDATE execution_batches SET runs_created = runs_created + 1, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(timestamp, batchId, projectId, ...(EXECUTION_ACTIVE_STATUSES as readonly string[]));
    if (result.changes !== 1) {
      const row = db
        .prepare<[string], { project_id: string; status: string }>(
          'SELECT project_id, status FROM execution_batches WHERE id = ?',
        )
        .get(batchId) as { project_id: string; status: string } | undefined;
      if (row === undefined) {
        throw notFound(operation, entity, `Batch ${batchId} 不存在`);
      }
      if (row.project_id !== projectId) {
        throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
      }
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${batchId} 状态 ${row.status} 不接受新派发计数`,
        { entity, details: { reason: 'batch_not_active', status: row.status } },
      );
    }
    const updated = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(batchId) as ExecutionBatchSqlRow;
    return batchFromRow(updated, operation);
  }

  function insertExecutionRunInTransaction(input: unknown): RunRecord {
    const operation = 'ExecutionStore.insertExecutionRun';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateExecutionRunInsertInput(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const entity: StorageEntityRef = { type: 'run', projectId: valid.projectId, id: valid.runId };
    // 归属核验：父 Batch 必须存在且同项目、同 Feature 范围（复合外键兜底）。
    const batchRow = db
      .prepare('SELECT project_id, feature_id FROM execution_batches WHERE id = ?')
      .get(valid.batchId) as { project_id: string; feature_id: string } | undefined;
    if (batchRow === undefined) {
      throw notFound(operation, entity, `父 Batch ${valid.batchId} 不存在`);
    }
    if (batchRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, '父 Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (batchRow.feature_id !== valid.featureId) {
      throw ownership(operation, entity, 'Run 的 Feature 不在父 Batch 的单 Feature 范围内');
    }
    try {
      db.prepare(
        'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
          'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
          'run_time_limit_ms, attempts_created, reason) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      ).run(
        valid.runId,
        timestamp,
        valid.projectId,
        timestamp,
        valid.batchId,
        valid.featureId,
        valid.purpose,
        JSON.stringify(valid.inputSnapshot),
        JSON.stringify(valid.configSnapshot),
        valid.status,
        valid.scopeDigest,
        valid.workKey,
        valid.dispatchOrdinal,
        valid.maxAttemptsPerRun,
        valid.runTimeLimitMs,
        valid.reason,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: Run 写入被 DDL 约束拒绝（派发身份/活动 Run 唯一/范围外键）`,
          { entity, cause: error },
        );
      }
      throw error;
    }
    const row = db
      .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
      .get(valid.runId) as RunSqlRow;
    return runFromRow(row, operation);
  }

  function appendExecutionEventInTransaction(input: unknown): string {
    const operation = 'ExecutionStore.appendExecutionEvent';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateExecutionEventAppendInput(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const nextSequence = db
      .prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events')
      .get();
    const eventId = randomUUID();
    db.prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      eventId,
      timestamp,
      timestamp,
      valid.projectId,
      nextSequence?.next ?? 1,
      valid.eventType,
      valid.aggregateType,
      valid.aggregateId,
      valid.aggregateRevision,
      JSON.stringify(valid.payload),
      timestamp,
    );
    return eventId;
  }

  /* ------------------------------------------------------------ *
   * P03-3 / F-006 Task 尝试预算预占与分类记账（迁移 v11）
   * ------------------------------------------------------------ */

  function reservationFromRow(row: TaskAttemptReservationSqlRow, operation: string): TaskAttemptReservationRecord {
    if (row.classification !== 'code' && row.classification !== 'infrastructure') {
      throw executionCorruptError(
        operation,
        { type: 'task_attempt_reservation', projectId: row.project_id, id: row.id },
        `预占账本分类非法（${row.classification}）`,
      );
    }
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
      batchId: row.batch_id,
      runId: row.run_id,
      taskId: row.task_id,
      attemptKey: row.attempt_key,
      classification: row.classification,
      classifiedBy: row.classified_by as typeof TASK_ATTEMPT_CLASSIFIED_BY_CORE,
      reason: row.reason,
    };
  }

  interface TaskBudgetRow {
    readonly project_id: string;
    readonly feature_id: string;
    readonly execution_config: string;
    readonly attempt_counter: number;
    readonly code_attempts_used: number;
    readonly revision: number;
    readonly updated_at: number;
  }

  /** tasks.execution_config 内的 maxCodeAttempts 提取（快照权威；漂移 corrupt）。 */
  function readTaskMaxCodeAttempts(
    row: TaskBudgetRow,
    taskId: string,
    operation: string,
  ): number | undefined {
    const entity: StorageEntityRef = { type: 'task', projectId: row.project_id, id: taskId };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.execution_config);
    } catch (cause) {
      throw executionCorruptError(operation, entity, 'tasks.execution_config JSON 损坏', cause);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw executionCorruptError(operation, entity, 'tasks.execution_config 不是 JSON 对象');
    }
    const raw = (parsed as Record<string, unknown>).maxCodeAttempts;
    if (raw === undefined) {
      return undefined;
    }
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > 100
    ) {
      throw executionCorruptError(
        operation,
        entity,
        'tasks.execution_config.maxCodeAttempts 形态非法（应为 1..100 整数或缺省）',
      );
    }
    return raw;
  }

  interface ReservationBudgetReason {
    readonly layer: 'batch' | 'run' | 'task';
    readonly dimension: string;
    readonly limit: number;
    readonly used: number | null;
  }

  function budgetExhaustedError(
    operation: string,
    entity: StorageEntityRef,
    reasons: readonly ReservationBudgetReason[],
  ): StorageError {
    return new StorageError(
      'conflict',
      operation,
      `${operation}: 预算额度已耗尽，拒绝新预占（budget_exhausted）`,
      { entity, details: { reason: 'budget_exhausted', reasons } },
    );
  }

  function reserveTaskAttemptInTransaction(input: unknown): TaskAttemptReservationRecord {
    const operation = 'ExecutionStore.reserveTaskAttempt';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateTaskAttemptReservationInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'task_attempt_reservation',
      projectId: valid.projectId,
      id: valid.attemptKey,
    };

    // 1) 归属核验（同事务绑定参数查询；复合外键为兕底）。
    const batchRow = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow | undefined;
    if (batchRow === undefined) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    if (batchRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    const runRow = db
      .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
      .get(valid.runId) as RunSqlRow | undefined;
    if (runRow === undefined) {
      throw notFound(operation, entity, `Run ${valid.runId} 不存在`);
    }
    if (runRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Run 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (runRow.batch_id !== valid.batchId) {
      throw ownership(operation, entity, 'Run 不属于声明的 Batch（预占必须落在当前 Run 上）');
    }
    const taskRow = db
      .prepare<[string], TaskBudgetRow>(
        'SELECT project_id, feature_id, execution_config, attempt_counter, code_attempts_used, revision, updated_at FROM tasks WHERE id = ?',
      )
      .get(valid.taskId) as TaskBudgetRow | undefined;
    if (taskRow === undefined) {
      throw notFound(operation, entity, `Task ${valid.taskId} 不存在`);
    }
    if (taskRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Task 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (taskRow.feature_id !== batchRow.feature_id) {
      throw ownership(operation, entity, 'Task 不在 Batch 的单 Feature 范围内');
    }

    // 2) 幂等身份去重先于控制状态与额度判定：同身份重放返回既有记录（不重复
    //    调账）；跨 Batch/Run 复用同身份为身份冲突。
    const existing = db
      .prepare<[string, string, string], TaskAttemptReservationSqlRow>(
        `${SELECT_RESERVATION} WHERE project_id = ? AND task_id = ? AND attempt_key = ?`,
      )
      .get(valid.projectId, valid.taskId, valid.attemptKey) as TaskAttemptReservationSqlRow | undefined;
    if (existing !== undefined) {
      if (existing.batch_id !== valid.batchId || existing.run_id !== valid.runId) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 预占身份 ${valid.attemptKey} 已被其他 Batch/Run 使用，拒绝重复预占`,
          { entity, details: { reason: 'attempt_key_reused' } },
        );
      }
      return reservationFromRow(existing, operation);
    }

    // 3) 有效控制状态（活动集与迁移 v9 条件唯一索引同源；paused/interrupted
    //    不是可绕过的终态）。
    if (!isExecutionActiveStatus(batchRow.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态 ${batchRow.status} 不接受新预占`,
        { entity, details: { reason: 'batch_not_active', status: batchRow.status } },
      );
    }
    if (!isExecutionActiveStatus(runRow.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} 状态 ${runRow.status} 不接受新预占`,
        { entity, details: { reason: 'run_not_active', status: runRow.status } },
      );
    }

    // 4) 额度判定（全部先于任何写入；耗尽拒绝且零写入，计数不溢出）。
    const now = nowUtcMs();
    const budgetSnapshot = parseBudgetSnapshot(batchRow.budget_snapshot, operation, 'execution_batch');
    const reasons: ReservationBudgetReason[] = [];
    // Batch 层：总 Attempt 上限与绝对 deadline（当前批准预算快照为权威）。
    if (batchRow.attempts_created >= budgetSnapshot.batch.maxTotalAttempts) {
      reasons.push({
        layer: 'batch',
        dimension: 'maxTotalAttempts',
        limit: budgetSnapshot.batch.maxTotalAttempts,
        used: batchRow.attempts_created,
      });
    }
    if (now >= budgetSnapshot.batch.deadlineUtcMs) {
      reasons.push({
        layer: 'batch',
        dimension: 'deadlineUtcMs',
        limit: budgetSnapshot.batch.deadlineUtcMs,
        used: now,
      });
    }
    // Run 层：单 Run 尝试上限与时间上限（未启动时时间维度未知）。
    const runDecision = evaluateRunBudgetReservation(
      { maxAttemptsPerRun: runRow.max_attempts_per_run, runTimeLimitMs: runRow.run_time_limit_ms },
      { attemptsCreated: runRow.attempts_created, startedAtUtcMs: runRow.started_at },
      now,
    );
    for (const reason of runDecision.reasons) {
      reasons.push({
        layer: 'run',
        dimension: reason.dimension,
        limit: reason.limit,
        used: reason.used,
      });
    }
    // Task 层：代码尝试上限（副本 maxCodeAttempts 为权威，缺省含首次共三次）与
    // 总 Attempt 上限（executionLimits.maxAttemptsPerTask 由受信 Core 解析后传入）。
    const caps = resolveTaskAttemptCaps(
      {
        maxCodeAttempts: readTaskMaxCodeAttempts(taskRow, valid.taskId, operation) ?? null,
        maxAttemptsPerTask: valid.maxAttemptsPerTask,
      },
      { operation, entity: { type: 'task', projectId: valid.projectId, id: valid.taskId } },
    );
    const codeDecision = evaluateTaskCodeAttemptReservation(caps, taskRow.code_attempts_used);
    if (!codeDecision.allowed) {
      reasons.push({
        layer: 'task',
        dimension: 'maxCodeAttempts',
        limit: codeDecision.limit,
        used: codeDecision.used,
      });
    }
    if (caps.maxAttemptsPerTask !== null && taskRow.attempt_counter >= caps.maxAttemptsPerTask) {
      reasons.push({
        layer: 'task',
        dimension: 'maxAttemptsPerTask',
        limit: caps.maxAttemptsPerTask,
        used: taskRow.attempt_counter,
      });
    }
    if (reasons.length > 0) {
      throw budgetExhaustedError(operation, entity, reasons);
    }

    // 5) 同事务原子写入：Batch 与 Run 累计计数 + Task 双计数 + 账本行（一次调用
    //    全部生效；后续任何同事务写入失败则整组回滚——不允许先提交扣额再另事务
    //    创建 Attempt）。
    const timestamp = nowUtcMs();
    const batchUpdate = db
      .prepare(
        `UPDATE execution_batches SET attempts_created = attempts_created + 1, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(timestamp, valid.batchId, valid.projectId, ...(EXECUTION_ACTIVE_STATUSES as readonly string[]));
    if (batchUpdate.changes !== 1) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态变化，不接受新预占`,
        { entity, details: { reason: 'batch_not_active' } },
      );
    }
    const runUpdate = db
      .prepare(
        `UPDATE runs SET attempts_created = attempts_created + 1, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND batch_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(timestamp, valid.runId, valid.projectId, valid.batchId, ...(EXECUTION_ACTIVE_STATUSES as readonly string[]));
    if (runUpdate.changes !== 1) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} 状态变化，不接受新预占`,
        { entity, details: { reason: 'run_not_active' } },
      );
    }
    const taskUpdate = db
      .prepare(
        'UPDATE tasks SET attempt_counter = attempt_counter + 1, code_attempts_used = code_attempts_used + 1, ' +
          'revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ?',
      )
      .run(timestamp, valid.taskId, valid.projectId);
    if (taskUpdate.changes !== 1) {
      throw notFound(operation, entity, `Task ${valid.taskId} 不存在`);
    }
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO task_attempt_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, task_id, attempt_key, classification, classified_by, reason) ' +
          "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'code', ?, NULL)",
      ).run(
        id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.batchId,
        valid.runId,
        valid.taskId,
        valid.attemptKey,
        TASK_ATTEMPT_CLASSIFIED_BY_CORE,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 预占账本写入被 DDL 约束拒绝（幂等身份/归属链）`,
          { entity, cause: error },
        );
      }
      throw error;
    }
    const inserted = db
      .prepare<[string], TaskAttemptReservationSqlRow>(`${SELECT_RESERVATION} WHERE id = ?`)
      .get(id) as TaskAttemptReservationSqlRow;
    return reservationFromRow(inserted, operation);
  }

  function reclassifyTaskAttemptAsInfrastructureInTransaction(input: unknown): TaskAttemptReservationRecord {
    const operation = 'ExecutionStore.reclassifyTaskAttemptAsInfrastructure';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateTaskAttemptReclassifyInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'task_attempt_reservation',
      projectId: valid.projectId,
      id: valid.attemptKey,
    };
    const taskRow = db
      .prepare<[string], { project_id: string }>('SELECT project_id FROM tasks WHERE id = ?')
      .get(valid.taskId) as { project_id: string } | undefined;
    if (taskRow === undefined) {
      throw notFound(operation, entity, `Task ${valid.taskId} 不存在`);
    }
    if (taskRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Task 不属于声明的项目（跨项目目标被拒绝）');
    }
    const existing = db
      .prepare<[string, string, string], TaskAttemptReservationSqlRow>(
        `${SELECT_RESERVATION} WHERE project_id = ? AND task_id = ? AND attempt_key = ?`,
      )
      .get(valid.projectId, valid.taskId, valid.attemptKey) as TaskAttemptReservationSqlRow | undefined;
    if (existing === undefined) {
      throw notFound(operation, entity, `预占 ${valid.attemptKey} 不存在（分类对象必须是已预占尝试）`);
    }
    // 重复分类不重复调账：已为 infrastructure 时幂等返回当前记录。
    if (existing.classification === 'infrastructure') {
      return reservationFromRow(existing, operation);
    }
    if (existing.reason?.startsWith(CODE_ATTEMPT_SETTLEMENT_PREFIX)) {
      throw new StorageError('conflict', operation, 'Verification budget already settled',
        { entity, details: { reason: 'attempt_budget_already_settled' } });
    }
    const timestamp = nowUtcMs();
    // 受信单向重分类（code→infrastructure）：账本行分类/理由持久 + 仅退还代码
    // 额度；总 Attempt（attempt_counter）、Batch/Run 累计计数、runtime_starts 与
    // 绝对时间不退还不触碰。分类主体为受信 Core 定值（DDL 拒绝其他主体）。
    const ledgerUpdate = db
      .prepare(
        "UPDATE task_attempt_reservations SET classification = 'infrastructure', reason = ?, " +
          'revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND classification = \'code\'',
      )
      .run(valid.reason, timestamp, existing.id, valid.projectId);
    if (ledgerUpdate.changes !== 1) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: 预占 ${valid.attemptKey} 分类状态变化，重分类失败`,
        { entity, details: { reason: 'classification_conflict' } },
      );
    }
    const taskUpdate = db
      .prepare(
        'UPDATE tasks SET code_attempts_used = code_attempts_used - 1, revision = revision + 1, updated_at = ? ' +
          'WHERE id = ? AND project_id = ? AND code_attempts_used >= 1',
      )
      .run(timestamp, valid.taskId, valid.projectId);
    if (taskUpdate.changes !== 1) {
      // 账本为 code 但 Task 代码计数已为零：持久状态不一致，fail-closed。
      throw executionCorruptError(
        operation,
        entity,
        'Task 代码尝试计数与预占账本不一致（code_attempts_used 已为零但存在 code 预占）',
      );
    }
    const updated = db
      .prepare<[string], TaskAttemptReservationSqlRow>(`${SELECT_RESERVATION} WHERE id = ?`)
      .get(existing.id) as TaskAttemptReservationSqlRow;
    return reservationFromRow(updated, operation);
  }

  function settleTaskAttemptBudgetInTransaction(input: unknown): TaskAttemptReservationRecord {
    const operation = 'ExecutionStore.settleTaskAttemptBudget';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateCodeAttemptSettlement(input, operation);
    const existing = getTaskAttemptReservationInTransaction(valid.projectId, valid.taskId, valid.attemptKey);
    const entity: StorageEntityRef = { type: 'task_attempt_reservation', projectId: valid.projectId, id: valid.attemptKey };
    if (existing === null) throw notFound(operation, entity, 'Attempt reservation not found');
    if (existing.batchId !== valid.batchId || existing.runId !== valid.runId) {
      throw ownership(operation, entity, 'Settlement does not match reserved Run/Batch');
    }
    // Reuse the bounded audit reason field rather than a second budget ledger.
    // The prefix is reserved for final, immutable verification settlements.
    const reason = CODE_ATTEMPT_SETTLEMENT_PREFIX + JSON.stringify({
      outcome: valid.outcome, observationDigest: valid.observationDigest,
    });
    if (existing.reason?.startsWith(CODE_ATTEMPT_SETTLEMENT_PREFIX)) {
      if (existing.reason === reason) return existing;
      throw new StorageError('conflict', operation, 'Conflicting attempt budget settlement',
        { entity, details: { reason: 'attempt_budget_already_settled' } });
    }
    if (valid.outcome !== 'non_code_failure' && existing.classification === 'infrastructure') {
      throw new StorageError('conflict', operation, 'Infrastructure classification cannot become code', { entity });
    }
    if (valid.outcome === 'non_code_failure') {
      reclassifyTaskAttemptAsInfrastructureInTransaction({ projectId: valid.projectId,
        taskId: valid.taskId, attemptKey: valid.attemptKey, reason: 'verification non-code failure' });
    }
    session.database.prepare('UPDATE task_attempt_reservations SET reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(reason, nowUtcMs(), existing.id);
    return getTaskAttemptReservationInTransaction(valid.projectId, valid.taskId, valid.attemptKey)!;
  }

  function getTaskAttemptReservationInTransaction(
    projectId: string,
    taskId: string,
    attemptKey: string,
  ): TaskAttemptReservationRecord | null {
    const operation = 'ExecutionStore.getTaskAttemptReservation';
    assertOpen(operation);
    assertInTransaction(operation);
    const row = session.database
      .prepare<[string, string, string], TaskAttemptReservationSqlRow>(
        `${SELECT_RESERVATION} WHERE project_id = ? AND task_id = ? AND attempt_key = ?`,
      )
      .get(projectId, taskId, attemptKey) as TaskAttemptReservationSqlRow | undefined;
    return row === undefined ? null : reservationFromRow(row, operation);
  }

  function getTaskExecutionCountersInTransaction(
    projectId: string,
    taskId: string,
  ): TaskExecutionCountersRecord {
    const operation = 'ExecutionStore.getTaskExecutionCounters';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'task', projectId, id: taskId };
    const row = session.database
      .prepare<[string], TaskBudgetRow>(
        'SELECT project_id, feature_id, execution_config, attempt_counter, code_attempts_used, revision, updated_at FROM tasks WHERE id = ?',
      )
      .get(taskId) as TaskBudgetRow | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, `Task ${taskId} 不存在`);
    }
    if (row.project_id !== projectId) {
      throw ownership(operation, entity, 'Task 不属于声明的项目（跨项目目标被拒绝）');
    }
    return {
      projectId,
      taskId,
      attemptCounter: row.attempt_counter,
      codeAttemptsUsed: row.code_attempts_used,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
    };
  }

  function getExecutionRunInTransaction(projectId: string, runId: string): RunRecord {
    const operation = 'ExecutionStore.getExecutionRun';
    assertOpen(operation);
    assertInTransaction(operation);
    const entity: StorageEntityRef = { type: 'run', projectId, id: runId };
    const row = session.database
      .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
      .get(runId) as RunSqlRow | undefined;
    if (row === undefined) {
      throw notFound(operation, entity, `Run ${runId} 不存在`);
    }
    if (row.project_id !== projectId) {
      throw ownership(operation, entity, 'Run 不属于声明的项目（跨项目目标被拒绝）');
    }
    return runFromRow(row, operation);
  }

  /* ------------------------------------------------------------ *
   * P03-9 / F-001 Task 边界暂停意图（迁移 v27）
   * ------------------------------------------------------------ */

  function activeAttemptCountForRun(projectId: string, runId: string): number {
    return session.database.prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count FROM attempts WHERE project_id = ? AND run_id = ?
        AND status IN (${ACTIVE_ATTEMPT_STATUSES.map(() => '?').join(', ')})`,
    ).get(projectId, runId, ...ACTIVE_ATTEMPT_STATUSES)!.count;
  }

  function activeAttemptCountForBatch(projectId: string, batchId: string): number {
    return session.database.prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count FROM attempts WHERE project_id = ? AND run_id IN
        (SELECT id FROM runs WHERE project_id = ? AND batch_id = ?)
        AND status IN (${ACTIVE_ATTEMPT_STATUSES.map(() => '?').join(', ')})`,
    ).get(projectId, projectId, batchId, ...ACTIVE_ATTEMPT_STATUSES)!.count;
  }

  function requestExecutionPauseInTransaction(input: ExecutionPauseInput): ExecutionPauseResult {
    const operation = 'ExecutionStore.requestExecutionPause';
    assertOpen(operation);
    assertInTransaction(operation);
    const raw = requirePlainObject(input, { operation }, 'input');
    rejectUnknownKeys(raw, ['projectId', 'targetKind', 'targetId', 'expectedRevision'], { operation }, 'input');
    const projectId = validateStableId(raw.projectId, { operation }, 'projectId');
    const targetId = validateStableId(raw.targetId, { operation }, 'targetId');
    if (raw.targetKind !== 'run' && raw.targetKind !== 'batch') {
      throw new StorageError('validation', operation, 'targetKind 必须是 run 或 batch');
    }
    const targetKind = raw.targetKind;
    if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1) {
      throw new StorageError('validation', operation, 'expectedRevision 必须是 ≥1 的安全整数');
    }
    const expectedRevision = raw.expectedRevision as number;
    const timestamp = nowUtcMs();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new StorageError('validation', operation, 'Invalid pause clock');
    const conflict = (reason: string, extra: Record<string, unknown> = {}): never => {
      throw new StorageError('conflict', operation, `Execution pause rejected: ${reason}`, {
        entity: { type: targetKind === 'run' ? 'run' : 'execution_batch', projectId, id: targetId },
        details: { reason, ...extra },
      });
    };

    if (targetKind === 'run') {
      const run = getExecutionRunInTransaction(projectId, targetId);
      if (isExecutionTerminalStatus(run.status)) {
        return { outcome: 'already_terminal', targetKind, targetId, status: run.status, revision: run.revision,
          changed: false, eventId: null };
      }
      if (run.status === 'cancelling') conflict('control_in_progress', { actualStatus: run.status });
      if (run.status === 'interrupted') {
        return { outcome: 'interrupted', targetKind, targetId, status: run.status, revision: run.revision,
          changed: false, eventId: null };
      }
      if (run.revision !== expectedRevision) {
        conflict('stale_revision', { expectedRevision, actualRevision: run.revision });
      }
      const status = activeAttemptCountForRun(projectId, targetId) > 0 ? 'pausing' : 'paused';
      const changed = session.database.prepare(`UPDATE runs SET status = ?, reason = 'user_pause',
        pause_requested_at = COALESCE(pause_requested_at, ?), revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND revision = ?
          AND status IN ('queued', 'running', 'pausing', 'paused')`)
        .run(status, timestamp, timestamp, projectId, targetId, expectedRevision);
      if (changed.changes !== 1) conflict('stale_revision', { expectedRevision, actualRevision: run.revision });
      const eventId = appendExecutionEventInTransaction({ projectId, eventType: EXECUTION_RUN_PAUSED_EVENT_TYPE,
        aggregateType: 'run', aggregateId: targetId, aggregateRevision: expectedRevision + 1, payload: { paused: true } });
      return { outcome: status, targetKind, targetId, status, revision: expectedRevision + 1, changed: true, eventId };
    }

    const batch = getExecutionBatchInTransaction(projectId, targetId);
    if (isExecutionTerminalStatus(batch.status)) {
      return { outcome: 'already_terminal', targetKind, targetId, status: batch.status, revision: batch.revision,
        changed: false, eventId: null };
    }
    if (batch.status === 'cancelling') conflict('control_in_progress', { actualStatus: batch.status });
    if (batch.status === 'interrupted') {
      return { outcome: 'interrupted', targetKind, targetId, status: batch.status, revision: batch.revision,
        changed: false, eventId: null };
    }
    if (batch.revision !== expectedRevision) {
      conflict('stale_revision', { expectedRevision, actualRevision: batch.revision });
    }
    const status = activeAttemptCountForBatch(projectId, targetId) > 0 ? 'pausing' : 'paused';
    const changed = session.database.prepare(`UPDATE execution_batches SET status = ?, reason = 'user_pause',
      pause_requested_at = COALESCE(pause_requested_at, ?), revision = revision + 1, updated_at = ?
      WHERE project_id = ? AND id = ? AND revision = ?
        AND status IN ('queued', 'running', 'pausing', 'paused')`)
      .run(status, timestamp, timestamp, projectId, targetId, expectedRevision);
    if (changed.changes !== 1) conflict('stale_revision', { expectedRevision, actualRevision: batch.revision });
    const rows = session.database.prepare<[string, string], { id: string; revision: number }>(
      `SELECT id, revision FROM runs WHERE project_id = ? AND batch_id = ?
        AND status IN ('queued', 'running', 'pausing', 'paused')`,
    ).all(projectId, targetId);
    for (const row of rows) {
      const runStatus = activeAttemptCountForRun(projectId, row.id) > 0 ? 'pausing' : 'paused';
      const runChanged = session.database.prepare(`UPDATE runs SET status = ?, reason = 'user_pause',
        pause_requested_at = COALESCE(pause_requested_at, ?), revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND id = ? AND revision = ?
          AND status IN ('queued', 'running', 'pausing', 'paused')`)
        .run(runStatus, timestamp, timestamp, projectId, row.id, row.revision);
      if (runChanged.changes === 1) {
        appendExecutionEventInTransaction({ projectId, eventType: EXECUTION_RUN_PAUSED_EVENT_TYPE,
          aggregateType: 'run', aggregateId: row.id, aggregateRevision: row.revision + 1, payload: { paused: true } });
      }
    }
    const eventId = appendExecutionEventInTransaction({ projectId, eventType: EXECUTION_BATCH_PAUSED_EVENT_TYPE,
      aggregateType: 'execution_batch', aggregateId: targetId, aggregateRevision: expectedRevision + 1, payload: { paused: true } });
    return { outcome: status, targetKind, targetId, status, revision: expectedRevision + 1, changed: true, eventId };
  }

  /* ------------------------------------------------------------ *
   * P03-3 / F-007 Runtime 启动额度预占（迁移 v12）
   * ------------------------------------------------------------ */

  function runtimeStartReservationFromRow(
    row: RuntimeStartReservationSqlRow,
    operation: string,
  ): RuntimeStartReservationRecord {
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
      batchId: row.batch_id,
      runId: row.run_id,
      startKey: row.start_key,
    };
  }

  function reserveRuntimeStartInTransaction(input: unknown): RuntimeStartReservationRecord {
    const operation = 'ExecutionStore.reserveRuntimeStart';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateRuntimeStartReservationInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'runtime_start_reservation',
      projectId: valid.projectId,
      id: valid.startKey,
    };

    // 1) 归属核验（同事务绑定参数查询；复合外键为兕底）：预占只能关联当前获准 Run
    //    ——父 Batch 与 Run 必须存在、同项目，且 Run 属于声明的 Batch。
    const batchRow = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow | undefined;
    if (batchRow === undefined) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    if (batchRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    const runRow = db
      .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
      .get(valid.runId) as RunSqlRow | undefined;
    if (runRow === undefined) {
      throw notFound(operation, entity, `Run ${valid.runId} 不存在`);
    }
    if (runRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Run 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (runRow.batch_id !== valid.batchId) {
      throw ownership(operation, entity, 'Run 不属于声明的 Batch（预占只能关联当前获准 Run）');
    }

    // 2) 幂等身份去重先于控制状态与额度判定：同启动身份重放返回既有记录（不重复
    //    计数）；同身份绑定其他 Batch/Run（过期/跨 Run 身份）拒绝。
    const existing = db
      .prepare<[string, string], RuntimeStartReservationSqlRow>(
        `${SELECT_RUNTIME_START_RESERVATION} WHERE project_id = ? AND start_key = ?`,
      )
      .get(valid.projectId, valid.startKey) as RuntimeStartReservationSqlRow | undefined;
    if (existing !== undefined) {
      if (existing.batch_id !== valid.batchId || existing.run_id !== valid.runId) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 启动身份 ${valid.startKey} 已绑定其他 Batch/Run，拒绝复用（过期身份）`,
          { entity, details: { reason: 'start_key_reused' } },
        );
      }
      return runtimeStartReservationFromRow(existing, operation);
    }

    // 3) 有效控制状态（活动集与迁移 v9 条件唯一索引同源；paused/interrupted
    //    不是可绕过的终态）。仅创建 Run/预览/准备输入/最终检查不进入本边界，
    //    也不增加 runtimeStarts（各自测试面断言）。
    if (!isExecutionActiveStatus(batchRow.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态 ${batchRow.status} 不接受新 Runtime 启动预占`,
        { entity, details: { reason: 'batch_not_active', status: batchRow.status } },
      );
    }
    if (!isExecutionActiveStatus(runRow.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} 状态 ${runRow.status} 不是当前获准 Run，不接受启动预占`,
        { entity, details: { reason: 'run_not_active', status: runRow.status } },
      );
    }

    // 4) 额度判定（全部先于任何写入；耗尽拒绝且零写入，计数不溢出）：父 Batch
    //    启动额度与绝对 deadline（当前批准预算快照为权威；deadline 到达即拒绝
    //    新启动，作为必须受控停止的原因——不清空占用、不假称进程已停止）。
    const now = nowUtcMs();
    const budgetSnapshot = parseBudgetSnapshot(batchRow.budget_snapshot, operation, 'execution_batch');
    const reasons: ReservationBudgetReason[] = [];
    if (batchRow.runtime_starts >= budgetSnapshot.batch.maxRuntimeStarts) {
      reasons.push({
        layer: 'batch',
        dimension: 'maxRuntimeStarts',
        limit: budgetSnapshot.batch.maxRuntimeStarts,
        used: batchRow.runtime_starts,
      });
    }
    if (now >= budgetSnapshot.batch.deadlineUtcMs) {
      reasons.push({
        layer: 'batch',
        dimension: 'deadlineUtcMs',
        limit: budgetSnapshot.batch.deadlineUtcMs,
        used: now,
      });
    }
    if (reasons.length > 0) {
      throw budgetExhaustedError(operation, entity, reasons);
    }

    // 5) 同事务原子写入：父 Batch runtime_starts+1（条件 UPDATE 仅活动态命中）与
    //    账本行插入一次调用全部生效。预占后启动失败保守保留这一次计数（无退额
    //    原语）；账本行不含 token/cost 或 sdk_started 列——不伪造用量或已启动事实。
    const timestamp = nowUtcMs();
    const batchUpdate = db
      .prepare(
        `UPDATE execution_batches SET runtime_starts = runtime_starts + 1, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(timestamp, valid.batchId, valid.projectId, ...(EXECUTION_ACTIVE_STATUSES as readonly string[]));
    if (batchUpdate.changes !== 1) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Batch ${valid.batchId} 状态变化，不接受新启动预占`,
        { entity, details: { reason: 'batch_not_active' } },
      );
    }
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO runtime_start_reservations (id, created_at, project_id, revision, updated_at, batch_id, run_id, start_key) ' +
          'VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
      ).run(id, timestamp, valid.projectId, timestamp, valid.batchId, valid.runId, valid.startKey);
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 启动预占账本写入被 DDL 约束拒绝（幂等启动身份/归属链）`,
          { entity, cause: error },
        );
      }
      throw error;
    }
    const inserted = db
      .prepare<[string], RuntimeStartReservationSqlRow>(`${SELECT_RUNTIME_START_RESERVATION} WHERE id = ?`)
      .get(id) as RuntimeStartReservationSqlRow;
    return runtimeStartReservationFromRow(inserted, operation);
  }

  function getRuntimeStartReservationInTransaction(
    projectId: string,
    runId: string,
    startKey: string,
  ): RuntimeStartReservationRecord | null {
    const operation = 'ExecutionStore.getRuntimeStartReservation';
    assertOpen(operation);
    assertInTransaction(operation);
    const row = session.database
      .prepare<[string, string, string], RuntimeStartReservationSqlRow>(
        `${SELECT_RUNTIME_START_RESERVATION} WHERE project_id = ? AND run_id = ? AND start_key = ?`,
      )
      .get(projectId, runId, startKey) as RuntimeStartReservationSqlRow | undefined;
    return row === undefined ? null : runtimeStartReservationFromRow(row, operation);
  }

  /* ------------------------------------------------------------ *
   * P03-3 / F-008 Run 结果结算与连续无进展保护（迁移 v13）
   * ------------------------------------------------------------ */

  function settlementFromRow(row: RunOutcomeSettlementSqlRow, operation: string): RunOutcomeSettlementRecord {
    const entity: StorageEntityRef = { type: 'run_outcome_settlement', projectId: row.project_id, id: row.id };
    if (
      row.outcome !== 'succeeded' &&
      row.outcome !== 'failed' &&
      row.outcome !== 'cancelled'
    ) {
      throw executionCorruptError(operation, entity, `结算 outcome 非法（${row.outcome}）`);
    }
    if (row.progress_type !== 'none' && row.progress_type !== 'new_valid_task_passed') {
      throw executionCorruptError(operation, entity, `结算进展类型非法（${row.progress_type}）`);
    }
    if ((row.progress_type === 'none') !== (row.progress_task_id === null)) {
      throw executionCorruptError(operation, entity, '结算进展证据形态损坏（none 与 taskId 必须一致）');
    }
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      revision: row.revision,
      updatedAtUtcMs: row.updated_at,
      batchId: row.batch_id,
      runId: row.run_id,
      resultKey: row.result_key,
      outcome: row.outcome as RunOutcomeSettlementOutcome,
      progressType: row.progress_type,
      progressTaskId: row.progress_task_id,
      runEndedAtUtcMs: row.run_ended_at,
      noProgressRunsAfter: row.no_progress_runs_after,
      reason: row.reason,
    };
  }

  function settleExecutionRunOutcomeInTransaction(input: unknown): RunOutcomeSettlementRecord {
    const operation = 'ExecutionStore.settleExecutionRunOutcome';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateRunOutcomeSettlementInput(input, operation);
    const db = session.database;
    const entity: StorageEntityRef = {
      type: 'run_outcome_settlement',
      projectId: valid.projectId,
      id: valid.resultKey,
    };

    // 1) 归属核验（同事务绑定参数查询；复合外键为兜底）：结算只能落在同项目
    //    Batch/Run 且 Run 属于声明 Batch。
    const batchRow = db
      .prepare<[string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ?`)
      .get(valid.batchId) as ExecutionBatchSqlRow | undefined;
    if (batchRow === undefined) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    if (batchRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Batch 不属于声明的项目（跨项目目标被拒绝）');
    }
    const runRow = db
      .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
      .get(valid.runId) as RunSqlRow | undefined;
    if (runRow === undefined) {
      throw notFound(operation, entity, `Run ${valid.runId} 不存在`);
    }
    if (runRow.project_id !== valid.projectId) {
      throw ownership(operation, entity, 'Run 不属于声明的项目（跨项目目标被拒绝）');
    }
    if (runRow.batch_id !== valid.batchId) {
      throw ownership(operation, entity, 'Run 不属于声明的 Batch（结算只能落在声明 Run 上）');
    }

    // 2) 幂等结算去重先于 CAS 与状态判定：同 resultKey 重放返回既有记录（Run/
    //    Batch 已终态仍幂等——不重复调账、不倒写终态）；同身份绑定其他 Batch/Run
    //    （跨 Run 复用结算身份）拒绝。
    const existing = db
      .prepare<[string, string], RunOutcomeSettlementSqlRow>(
        `${SELECT_SETTLEMENT} WHERE project_id = ? AND result_key = ?`,
      )
      .get(valid.projectId, valid.resultKey) as RunOutcomeSettlementSqlRow | undefined;
    if (existing !== undefined) {
      if (existing.batch_id !== valid.batchId || existing.run_id !== valid.runId) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 结算身份 ${valid.resultKey} 已绑定其他 Batch/Run，拒绝复用`,
          { entity, details: { reason: 'result_key_reused' } },
        );
      }
      return settlementFromRow(existing, operation);
    }

    // 3) Run CAS（旧 revision 不重复结算）与终态保护（不倒写终态）。
    if (runRow.revision !== valid.runRevision) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} revision 已变化（旧 revision 不重复结算）`,
        {
          entity,
          details: { reason: 'run_revision_stale', expected: valid.runRevision, actual: runRow.revision },
        },
      );
    }
    if (isExecutionTerminalStatus(runRow.status)) {
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} 已终态（${runRow.status}），不倒写终态`,
        { entity, details: { reason: 'run_already_settled', status: runRow.status } },
      );
    }

    // 4) 进展证据核验（Core 可核验领域事实；fail-closed）：Task 必须存在、同项目、
    //    在 Batch 单 Feature 范围内且 tasks.status='passed'。首次通过必须发生在
    //    Run 创建之后且不晚于结算，元数据修改及已经消费的旧事实不算新进展。
    const timestamp = nowUtcMs();
    let hasNewProgress = false;
    let progressTaskId: string | null = null;
    if (valid.progressEvidence !== null) {
      const taskRow = db
        .prepare<[string], { project_id: string; feature_id: string; status: string; first_passed_at: number | null }>(
          'SELECT project_id, feature_id, status, first_passed_at FROM tasks WHERE id = ?',
        )
        .get(valid.progressEvidence.taskId) as { project_id: string; feature_id: string; status: string; first_passed_at: number | null } | undefined;
      if (taskRow === undefined) {
        throw notFound(operation, entity, `进展证据 Task ${valid.progressEvidence.taskId} 不存在`);
      }
      if (taskRow.project_id !== valid.projectId) {
        throw ownership(operation, entity, '进展证据 Task 不属于声明的项目（跨项目目标被拒绝）');
      }
      if (taskRow.feature_id !== batchRow.feature_id) {
        throw ownership(operation, entity, '进展证据 Task 不在 Batch 的单 Feature 范围内');
      }
      if (taskRow.status !== 'passed') {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 进展证据 Task ${valid.progressEvidence.taskId} 状态 ${taskRow.status} 未通过核验（passed 只能由受信核验产生）`,
          { entity, details: { reason: 'progress_evidence_not_verified', taskId: valid.progressEvidence.taskId, status: taskRow.status } },
        );
      }
      const priorEvidence = db
        .prepare<[string, string], RunOutcomeSettlementSqlRow>(
          `${SELECT_SETTLEMENT} WHERE project_id = ? AND progress_type = 'new_valid_task_passed' AND progress_task_id = ?`,
        )
        .get(valid.projectId, valid.progressEvidence.taskId) as RunOutcomeSettlementSqlRow | undefined;
      if (
        priorEvidence === undefined &&
        taskRow.first_passed_at !== null &&
        taskRow.first_passed_at > runRow.created_at &&
        taskRow.first_passed_at <= timestamp
      ) {
        hasNewProgress = true;
        progressTaskId = valid.progressEvidence.taskId;
      }
    }

    // 5) 无进展计数（有新有效领域进展才重置为 0；否则恰好 +1）与上限终态化
    //    （当前批准预算快照为权威；终态 Batch 不倒写 status/reason）。
    const budgetSnapshot = parseBudgetSnapshot(batchRow.budget_snapshot, operation, 'execution_batch');
    const noProgressAfter = hasNewProgress ? 0 : batchRow.no_progress_runs + 1;
    const shouldTerminalize =
      noProgressAfter >= budgetSnapshot.batch.maxNoProgressRuns &&
      isExecutionActiveStatus(batchRow.status);

    // 6) 同事务原子写入：Run 终态 CAS（revision + 活动集双条件；ended_at 一次
    //    写入，v13 触发器保护不可重写）+ Batch 计数（+上限时终态化 failed 并
    //    持久化 budget_exhausted 原因）+ 结算账本行一次调用全部生效；后续任何
    //    同事务写入失败整组回滚。runs_created/attempts_created/runtime_starts
    //    不退还（无退额路径，不触碰）。
    const runUpdate = db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, reason = ?, revision = revision + 1, updated_at = ? ` +
          `WHERE id = ? AND project_id = ? AND revision = ? AND status IN (${ACTIVE_PLACEHOLDERS})`,
      )
      .run(
        valid.outcome,
        timestamp,
        valid.reason,
        timestamp,
        valid.runId,
        valid.projectId,
        valid.runRevision,
        ...(EXECUTION_ACTIVE_STATUSES as readonly string[]),
      );
    if (runUpdate.changes !== 1) {
      const current = db
        .prepare<[string], RunSqlRow>(`${SELECT_RUN} WHERE id = ?`)
        .get(valid.runId) as RunSqlRow | undefined;
      if (current === undefined) {
        throw notFound(operation, entity, `Run ${valid.runId} 不存在`);
      }
      if (current.revision !== valid.runRevision) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: Run ${valid.runId} revision 已变化（旧 revision 不重复结算）`,
          {
            entity,
            details: { reason: 'run_revision_stale', expected: valid.runRevision, actual: current.revision },
          },
        );
      }
      throw new StorageError(
        'conflict',
        operation,
        `${operation}: Run ${valid.runId} 已终态（${current.status}），不倒写终态`,
        { entity, details: { reason: 'run_already_settled', status: current.status } },
      );
    }
    const batchUpdate = shouldTerminalize
      ? db
          .prepare(
            `UPDATE execution_batches SET no_progress_runs = ?, status = 'failed', reason = ?, revision = revision + 1, updated_at = ? ` +
              'WHERE id = ? AND project_id = ?',
          )
          .run(noProgressAfter, RUN_NO_PROGRESS_EXHAUSTION_REASON, timestamp, valid.batchId, valid.projectId)
      : db
          .prepare(
            'UPDATE execution_batches SET no_progress_runs = ?, revision = revision + 1, updated_at = ? ' +
              'WHERE id = ? AND project_id = ?',
          )
          .run(noProgressAfter, timestamp, valid.batchId, valid.projectId);
    if (batchUpdate.changes !== 1) {
      throw notFound(operation, entity, `Batch ${valid.batchId} 不存在`);
    }
    const id = randomUUID();
    try {
      db.prepare(
        'INSERT INTO run_outcome_settlements (id, created_at, project_id, revision, updated_at, batch_id, run_id, result_key, outcome, progress_type, progress_task_id, run_ended_at, no_progress_runs_after, reason) ' +
          'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        timestamp,
        valid.projectId,
        timestamp,
        valid.batchId,
        valid.runId,
        valid.resultKey,
        valid.outcome,
        hasNewProgress ? 'new_valid_task_passed' : 'none',
        progressTaskId,
        timestamp,
        noProgressAfter,
        valid.reason,
      );
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new StorageError(
          'conflict',
          operation,
          `${operation}: 结算账本写入被 DDL 约束拒绝（幂等结算身份/证据唯一/归属链）`,
          { entity, cause: error },
        );
      }
      throw error;
    }
    const inserted = db
      .prepare<[string], RunOutcomeSettlementSqlRow>(`${SELECT_SETTLEMENT} WHERE id = ?`)
      .get(id) as RunOutcomeSettlementSqlRow;
    return settlementFromRow(inserted, operation);
  }

  function getRunOutcomeSettlementInTransaction(
    projectId: string,
    runId: string,
    resultKey: string,
  ): RunOutcomeSettlementRecord | null {
    const operation = 'ExecutionStore.getRunOutcomeSettlement';
    assertOpen(operation);
    assertInTransaction(operation);
    const row = session.database
      .prepare<[string, string, string], RunOutcomeSettlementSqlRow>(
        `${SELECT_SETTLEMENT} WHERE project_id = ? AND run_id = ? AND result_key = ?`,
      )
      .get(projectId, runId, resultKey) as RunOutcomeSettlementSqlRow | undefined;
    return row === undefined ? null : settlementFromRow(row, operation);
  }

  /* ------------------------------------------------------------ *
   * P03-3 / F-010 只读查询面（一致读视图；零写入零事件零唤醒）
   * ------------------------------------------------------------ */

  function assertNotInTransaction(operation: string): void {
    if (session.database.inTransaction) {
      throw new TypeError(`${operation}: 执行域查询读取不得嵌套在写事务内（编程错误）`);
    }
  }

  function executionReadId(
    operation: string,
    value: unknown,
    field: string,
    entityType: StorageEntityRef['type'],
  ): string {
    return validateStableId(value, { operation, entity: { type: entityType } }, field);
  }

  function revisionFromRow(row: BatchBudgetRevisionSqlRow, operation: string): BatchBudgetRevisionRecord {
    return {
      id: row.id,
      createdAtUtcMs: row.created_at,
      projectId: row.project_id,
      batchId: row.batch_id,
      version: row.version,
      budgetSnapshot: parseBudgetSnapshot(row.budget_snapshot, operation, 'batch_budget_revision'),
      deadlineAtUtcMs: row.deadline_at,
      approvedBy: row.approved_by,
      reason: row.reason,
    };
  }

  function taskBudgetRowFromRow(row: TaskBudgetSqlRow, operation: string): ExecutionBudgetTaskRow {
    if (!(TASK_STATUSES as readonly string[]).includes(row.status)) {
      throw executionCorruptError(operation, { type: 'task', id: row.id }, `Task 状态非法（${row.status}）`);
    }
    let executionConfig: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.execution_config);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      executionConfig = parsed as Record<string, unknown>;
    } catch (cause) {
      throw executionCorruptError(operation, { type: 'task', id: row.id }, 'Task 策略副本 JSON 损坏', cause);
    }
    return {
      taskId: row.id,
      status: row.status as TaskStatus,
      firstPassedAtUtcMs: row.first_passed_at,
      attemptCounter: row.attempt_counter,
      codeAttemptsUsed: row.code_attempts_used,
      executionConfig,
    };
  }

  function readExecutionBudgetView(
    projectId: unknown,
    batchId: unknown,
  ): ExecutionBudgetView | undefined {
    const operation = 'ExecutionStore.readExecutionBudgetView';
    assertOpen(operation);
    assertNotInTransaction(operation);
    const validProjectId = executionReadId(operation, projectId, 'projectId', 'project');
    const validBatchId = executionReadId(operation, batchId, 'batchId', 'execution_batch');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const batchRow = db
        .prepare<[string, string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ? AND project_id = ?`)
        .get(validBatchId, validProjectId) as ExecutionBatchSqlRow | undefined;
      if (batchRow === undefined) {
        return undefined;
      }
      const batch = batchFromRow(batchRow, operation);
      const runRows = db
        .prepare<[string, string], RunSqlRow>(
          `${SELECT_RUN} WHERE batch_id = ? AND project_id = ? ORDER BY dispatch_ordinal, id`,
        )
        .all(validBatchId, validProjectId) as RunSqlRow[];
      const taskRows = db
        .prepare<[string, string], TaskBudgetSqlRow>(
          'SELECT id, status, first_passed_at, attempt_counter, code_attempts_used, execution_config ' +
            'FROM tasks WHERE feature_id = ? AND project_id = ? ORDER BY id',
        )
        .all(batch.featureId, validProjectId) as TaskBudgetSqlRow[];
      const globalRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM global_settings WHERE id = ?',
        )
        .get('global');
      const projectRow = db
        .prepare<[string], { revision: number; payload: string }>(
          'SELECT revision, payload FROM project_settings WHERE project_id = ?',
        )
        .get(validProjectId);
      const settings: {
        global: SettingsScopeSnapshot | null;
        project: SettingsScopeSnapshot | null;
      } = {
        global:
          globalRow === undefined
            ? null
            : {
                scopeRevision: globalRow.revision,
                payload: parseStoredSettingsPayload(globalRow.payload, {
                  operation,
                  entity: { type: 'global_settings', id: 'global' },
                }),
              },
        project:
          projectRow === undefined
            ? null
            : {
                scopeRevision: projectRow.revision,
                payload: parseStoredSettingsPayload(projectRow.payload, {
                  operation,
                  entity: { type: 'project_settings', projectId: validProjectId },
                }),
              },
      };
      return {
        batch,
        runs: runRows.map((row) => runFromRow(row, operation)),
        tasks: taskRows.map((row) => taskBudgetRowFromRow(row, operation)),
        settings,
      };
    });
  }

  function findExecutionBatchRecord(
    projectId: unknown,
    batchId: unknown,
  ): ExecutionBatchRecord | undefined {
    const operation = 'ExecutionStore.findExecutionBatch';
    assertOpen(operation);
    assertNotInTransaction(operation);
    const validProjectId = executionReadId(operation, projectId, 'projectId', 'project');
    const validBatchId = executionReadId(operation, batchId, 'batchId', 'execution_batch');
    return transactSqliteConsistentRead(session, operation, (db) => {
      const row = db
        .prepare<[string, string], ExecutionBatchSqlRow>(`${SELECT_BATCH} WHERE id = ? AND project_id = ?`)
        .get(validBatchId, validProjectId) as ExecutionBatchSqlRow | undefined;
      return row === undefined ? undefined : batchFromRow(row, operation);
    });
  }

  function listBatchBudgetRevisionRecords(
    visibility: unknown,
    projectId: unknown,
    batchId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<BatchBudgetRevisionRecord> {
    const operation = 'ExecutionStore.listBatchBudgetRevisions';
    assertOpen(operation);
    assertNotInTransaction(operation);
    // 可见范围形状非法 = 可信装配编程错误（TypeError），不折算客户端错误。
    assertPrincipalVisibility(visibility);
    if (
      request === null ||
      typeof request !== 'object' ||
      (request.afterId !== null && (typeof request.afterId !== 'string' || request.afterId.length === 0)) ||
      typeof request.limit !== 'number' ||
      !Number.isInteger(request.limit) ||
      request.limit < 1
    ) {
      throw new TypeError(
        'ExecutionStore.listBatchBudgetRevisions: request 必须是 {afterId: string|null, limit: ≥1 整数}（已校验分页形态）',
      );
    }
    const validProjectId = executionReadId(operation, projectId, 'projectId', 'project');
    const validBatchId = executionReadId(operation, batchId, 'batchId', 'execution_batch');
    return transactSqliteConsistentRead(session, operation, (db) => {
      // 键集下界按修订版本解析（UNIQUE(batch_id,version)；游标经应用层绑定
      // Batch/项目，跨批次/跨项目游标已折叠 invalid_cursor；不可解析下界安全
      // 返回空页，绝不当作从零重读）。
      let afterVersion = 0;
      if (request.afterId !== null) {
        const anchor = db
          .prepare<[string, string, string], { version: number }>(
            'SELECT version FROM batch_budget_revisions WHERE id = ? AND batch_id = ? AND project_id = ?',
          )
          .get(request.afterId, validBatchId, validProjectId);
        if (anchor === undefined) {
          return { records: [], nextId: null };
        }
        afterVersion = anchor.version;
      }
      const visible = visibilityCondition(visibility, 'project_id');
      const conditions = ['project_id = ?', 'batch_id = ?', 'version > ?'];
      const params: unknown[] = [validProjectId, validBatchId, afterVersion];
      if (visible.condition !== undefined) {
        conditions.push(visible.condition);
        params.push(...visible.params);
      }
      params.push(request.limit + 1);
      const rows = db
        .prepare<unknown[], BatchBudgetRevisionSqlRow>(
          `${SELECT_REVISION} WHERE ${conditions.join(' AND ')} ORDER BY version LIMIT ?`,
        )
        .all(...params) as BatchBudgetRevisionSqlRow[];
      const hasMore = rows.length > request.limit;
      const pageRows = hasMore ? rows.slice(0, request.limit) : rows;
      return {
        records: pageRows.map((row) => revisionFromRow(row, operation)),
        nextId: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
      };
    });
  }

  return {
    insertExecutionBatchInTransaction,
    insertBatchBudgetRevisionInTransaction,
    reviseBatchBudgetInTransaction,
    insertExecutionRunInTransaction,
    getExecutionBatchInTransaction,
    listExecutionRunsForWorkKeyInTransaction,
    getActiveExecutionRunInTransaction,
    getActivePhaseExecutionBatchInTransaction,
    recordExecutionRunDispatchInTransaction,
    appendExecutionEventInTransaction,
    requestExecutionPauseInTransaction,
    reserveTaskAttemptInTransaction,
    settleTaskAttemptBudgetInTransaction,
    reclassifyTaskAttemptAsInfrastructureInTransaction,
    getTaskAttemptReservationInTransaction,
    getTaskExecutionCountersInTransaction,
    getExecutionRunInTransaction,
    reserveRuntimeStartInTransaction,
    getRuntimeStartReservationInTransaction,
    settleExecutionRunOutcomeInTransaction,
    getRunOutcomeSettlementInTransaction,
    readExecutionBudgetView,
    findExecutionBatchRecord,
    listBatchBudgetRevisionRecords,
  };
}
