/**
 * P03-3 / F-005 执行域 SQLite 适配器（adapters 层）：迁移 v9 三表
 * （execution_batches/runs/batch_budget_revisions）的同会话同步事务原语，供
 * 原子命令事务在同一 BEGIN IMMEDIATE 内组合使用（ports/execution-store.ts 契约）。
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
 * 本适配器不实现：启动命令编排（application/execution-start）、预算预占/结算
 * （F-006..F-008）、Run 生命周期 CAS（F-008）、查询面（F-010）。
 */
import { randomUUID } from 'node:crypto';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import { validateExecutionBudgetSnapshot } from '../../ports/execution-budget.js';
import type { ExecutionBudgetSnapshot } from '../../ports/execution-budget.js';
import {
  EXECUTION_ACTIVE_STATUSES,
  executionCorruptError,
  validateBatchBudgetRevisionInsertInput,
  validateExecutionBatchInsertInput,
  validateExecutionEventAppendInput,
  validateExecutionRunInsertInput,
} from '../../ports/execution-store.js';
import type {
  BatchBudgetRevisionRecord,
  ExecutionBatchRecord,
  ExecutionBatchStatus,
  RunRecord,
} from '../../ports/execution-store.js';
import type { SqliteStorageSession } from './session.js';

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
}

const SELECT_BATCH =
  'SELECT id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, ' +
  'config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
  'runtime_starts, no_progress_runs, deadline_at, reason FROM execution_batches';
const SELECT_RUN =
  'SELECT id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
  'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, ' +
  'max_attempts_per_run, run_time_limit_ms, attempts_created, reason, started_at, ended_at FROM runs';

const BATCH_STATUS_SET = new Set<string>([
  'queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted',
]);

const ACTIVE_PLACEHOLDERS = EXECUTION_ACTIVE_STATUSES.map(() => '?').join(', ');

export interface SqliteExecutionAccess {
  /** 创建单 Feature 执行批次（初始 queued、runsCreated ≥1；同 Phase 活动唯一兜底）。 */
  insertExecutionBatchInTransaction(input: unknown): ExecutionBatchRecord;
  /** 插入批次预算修订行（初始 version=1 与历史快照；插后不可变）。 */
  insertBatchBudgetRevisionInTransaction(input: unknown): BatchBudgetRevisionRecord;
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
  appendExecutionEventInTransaction(input: unknown): void;
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

  function appendExecutionEventInTransaction(input: unknown): void {
    const operation = 'ExecutionStore.appendExecutionEvent';
    assertOpen(operation);
    assertInTransaction(operation);
    const valid = validateExecutionEventAppendInput(input, operation);
    const db = session.database;
    const timestamp = nowUtcMs();
    const nextSequence = db
      .prepare<[], { next: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM state_events')
      .get();
    db.prepare(
      'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
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
  }

  return {
    insertExecutionBatchInTransaction,
    insertBatchBudgetRevisionInTransaction,
    insertExecutionRunInTransaction,
    getExecutionBatchInTransaction,
    listExecutionRunsForWorkKeyInTransaction,
    getActiveExecutionRunInTransaction,
    getActivePhaseExecutionBatchInTransaction,
    recordExecutionRunDispatchInTransaction,
    appendExecutionEventInTransaction,
  };
}
