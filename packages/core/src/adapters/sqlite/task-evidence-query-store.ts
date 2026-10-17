/**
 * P03-7 / F-013 Task 机器证据、人审事项与有限返工链只读窄端口的 SQLite 装配
 * （adapters 层）。
 *
 * 不变量（与 ports/task-evidence-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不创建
 *   批次/结果、不写人审事项、不改 Attempt/预算、不写事件、不触发执行；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成，绝不区分
 *   「不存在」与「属于其他项目」）；持久行损坏 fail-closed（StorageError
 *   corrupt），不把损坏内容泄漏进错误或折算成空结果；
 * - 机器证据批次按创建时间新→旧有界读取（超限置位 batchesTruncated），
 *   逐检查结果随批次读回；人审事项与返工链沿用键集分页：可见范围谓词下推
 *   SQL（visibility 非法形状为可信装配编程错误 TypeError）、排他下界、稳定
 *   排序（人审 (created_at,id)；返工链 (number,id)）；
 * - 代码资格记账取自 task_attempt_reservations 账本（分类 + 最终结算），
 *   缺失账本为 null，绝不以 Attempt 行数折算代码消耗；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError, type StorageEntityRef } from '../../ports/errors.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { AttemptRecord } from '../../ports/attempt-store.js';
import type { ExecutionListRequest, ExecutionRecordPage } from '../../ports/execution-schedule-query.js';
import type {
  TaskApprovalItemRow,
  TaskAttemptSettlementFacts,
  TaskEvidenceQueryReadStore,
  TaskEvidenceTaskRow,
  TaskReworkAttemptRow,
  TaskReworkRunRow,
  TaskReworkView,
  TaskVerificationBatchView,
  TaskVerificationView,
} from '../../ports/task-evidence-query.js';
import {
  parseTaskAttemptSettlementReason,
  validateTaskAttemptSettlementFacts,
} from '../../ports/task-evidence-query.js';
import { TASK_STATUSES } from '../../ports/plan-store.js';
import { attemptFromRow } from './attempt-store.js';
import type { AttemptRow } from './attempt-store.js';
import {
  taskApprovalItemFromRow,
  type TaskApprovalItemSqlRow,
} from './plan-store.js';
import {
  checkResultRecordFromRow,
  verificationBatchRecordFromRow,
  CHECK_RESULT_COLUMNS,
  VERIFICATION_BATCH_COLUMNS,
  type CheckResultRow,
  type VerificationBatchRow,
} from './verification-store.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'TaskEvidenceQueryStore';

/** 机器证据批次展示上限（超出置 batchesTruncated，不静默丢弃语义）。 */
export const TASK_VERIFICATION_BATCHES_MAX_COUNT = 16;

interface TaskEvidenceTaskSqlRow {
  project_id: string;
  feature_id: string;
  status: string;
  execution_version: number;
  manual_block: number;
  first_passed_at: number | null;
  attempt_counter: number;
  code_attempts_used: number;
  execution_config: string;
}

interface TaskAttemptReservationSqlRow {
  attempt_key: string;
  classification: string;
  reason: string | null;
}

interface ReworkRunSqlRow {
  id: string;
  batch_id: string;
  feature_id: string;
  status: string;
  reason: string | null;
  started_at: number | null;
  ended_at: number | null;
}

function stableId(operation: string, value: unknown, field: string): string {
  const context: ValidationContext = { operation };
  return validateStableId(value, context, field);
}

function corrupt(operation: string, message: string, projectId?: string, id?: string): StorageError {
  return new StorageError('corrupt', operation, message, {
    entity: { type: 'task', ...(id === undefined ? {} : { id }), ...(projectId === undefined ? {} : { projectId }) },
  });
}

function requireCounter(operation: string, value: unknown, field: string, projectId: string, taskId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(operation, `${field} 计数损坏`, projectId, taskId);
  }
  return value;
}

function taskRowFromSql(
  row: TaskEvidenceTaskSqlRow,
  projectId: string,
  taskId: string,
): TaskEvidenceTaskRow {
  const operation = `${OPERATION}.readTask`;
  if (!(TASK_STATUSES as readonly string[]).includes(row.status)) {
    throw corrupt(operation, 'Task 状态损坏', projectId, taskId);
  }
  if (row.manual_block !== 0 && row.manual_block !== 1) {
    throw corrupt(operation, 'Task manualBlock 损坏', projectId, taskId);
  }
  if (typeof row.execution_version !== 'number' || !Number.isSafeInteger(row.execution_version) || row.execution_version < 0) {
    throw corrupt(operation, 'Task executionVersion 损坏', projectId, taskId);
  }
  if (row.first_passed_at !== null && (typeof row.first_passed_at !== 'number' || row.first_passed_at < 1)) {
    throw corrupt(operation, 'Task firstPassedAt 损坏', projectId, taskId);
  }
  let executionConfig: unknown;
  try {
    executionConfig = JSON.parse(row.execution_config);
  } catch {
    throw corrupt(operation, 'Task 策略副本 JSON 损坏', projectId, taskId);
  }
  if (executionConfig === null || typeof executionConfig !== 'object' || Array.isArray(executionConfig)) {
    throw corrupt(operation, 'Task 策略副本不是对象', projectId, taskId);
  }
  return {
    projectId,
    taskId,
    featureId: row.feature_id,
    status: row.status as TaskEvidenceTaskRow['status'],
    executionVersion: row.execution_version,
    manualBlock: row.manual_block === 1,
    firstPassedAtUtcMs: row.first_passed_at,
    attemptCounter: requireCounter(operation, row.attempt_counter, 'attemptCounter', projectId, taskId),
    codeAttemptsUsed: requireCounter(operation, row.code_attempts_used, 'codeAttemptsUsed', projectId, taskId),
    executionConfig: executionConfig as Readonly<Record<string, unknown>>,
  };
}

function settlementFromRow(
  row: TaskAttemptReservationSqlRow,
  projectId: string,
): TaskAttemptSettlementFacts {
  const entity: StorageEntityRef = { type: 'task_attempt_reservation', projectId, id: row.attempt_key };
  if (row.classification !== 'code' && row.classification !== 'infrastructure') {
    throw new StorageError('corrupt', `${OPERATION}.readSettlement`, '代码资格记账分类损坏', { entity });
  }
  const facts = validateTaskAttemptSettlementFacts(
    { classification: row.classification, ...parseTaskAttemptSettlementReason(row.reason) },
    entity,
  );
  return facts;
}

function runRowFromSql(row: ReworkRunSqlRow): TaskReworkRunRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    featureId: row.feature_id,
    status: row.status as TaskReworkRunRow['status'],
    reason: row.reason,
    startedAtUtcMs: row.started_at,
    endedAtUtcMs: row.ended_at,
  };
}

/** 复合排序键排他下界（应用层已解码校验；此处复核为防御纵深）。 */
function assertRequest(operation: string, request: ExecutionListRequest): void {
  if (
    request === null ||
    typeof request !== 'object' ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    (request.after !== null &&
      (typeof request.after !== 'object' ||
        !Number.isSafeInteger(request.after.sort) ||
        request.after.sort < 0 ||
        typeof request.after.id !== 'string' ||
        request.after.id.length === 0))
  ) {
    throw new TypeError(`${operation}: 非法 ExecutionListRequest（可信装配编程错误）`);
  }
}

const TASK_EVIDENCE_TASK_COLUMNS = `project_id, feature_id, status, execution_version, manual_block,
  first_passed_at, attempt_counter, code_attempts_used, execution_config`;

const SETTLEMENT_COLUMNS = 'attempt_key, classification, reason';

const REWORK_RUN_COLUMNS = 'id, batch_id, feature_id, status, reason, started_at, ended_at';

const APPROVAL_ITEM_COLUMNS = `id, created_at, project_id, feature_id, task_id, revision, updated_at, kind,
  description, responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision,
  decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at`;

/** SQLite 装配：只读一致视图 + 键集分页；查询零写入、零事件、零执行触发。 */
export function createSqliteTaskEvidenceQueryStore(
  session: SqliteStorageSession,
): TaskEvidenceQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteTaskEvidenceQueryStore: session 必须是 SqliteStorageSession');
  }

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', operation, 'Storage session is closed');
    }
  }

  function read<T>(operation: string, fn: () => T): T {
    assertOpen(operation);
    return session.database.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  }

  function readTaskRow(
    projectId: string,
    taskId: string,
  ): TaskEvidenceTaskRow | undefined {
    const row = session.database
      .prepare<[string], TaskEvidenceTaskSqlRow>(
        `SELECT ${TASK_EVIDENCE_TASK_COLUMNS} FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (row === undefined || row.project_id !== projectId) {
      return undefined;
    }
    return taskRowFromSql(row, projectId, taskId);
  }

  function readLatestAttempt(
    projectId: string,
    taskId: string,
  ): AttemptRecord | null {
    const row = session.database
      .prepare<[string, string], AttemptRow>(
        'SELECT * FROM attempts WHERE project_id = ? AND task_id = ? ORDER BY number DESC, id DESC LIMIT 1',
      )
      .get(projectId, taskId);
    return row === undefined ? null : attemptFromRow(row);
  }

  function readSettlements(
    projectId: string,
    taskId: string,
    attemptIds: readonly string[],
  ): Record<string, TaskAttemptSettlementFacts> {
    const settlements: Record<string, TaskAttemptSettlementFacts> = {};
    if (attemptIds.length === 0) return settlements;
    const placeholders = attemptIds.map(() => '?').join(', ');
    const rows = session.database
      .prepare<unknown[], TaskAttemptReservationSqlRow>(
        `SELECT ${SETTLEMENT_COLUMNS} FROM task_attempt_reservations
         WHERE project_id = ? AND task_id = ? AND attempt_key IN (${placeholders})`,
      )
      .all(projectId, taskId, ...attemptIds);
    for (const row of rows) {
      settlements[row.attempt_key] = settlementFromRow(row, projectId);
    }
    return settlements;
  }

  return {
    readTaskVerificationView(project: unknown, task: unknown): TaskVerificationView | undefined {
      const operation = `${OPERATION}.readTaskVerificationView`;
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return read(operation, () => {
        const taskRow = readTaskRow(projectId, taskId);
        if (taskRow === undefined) return undefined;
        const batchRows = session.database
          .prepare<[string, string, number], VerificationBatchRow>(
            `SELECT ${VERIFICATION_BATCH_COLUMNS} FROM verification_batches
             WHERE project_id = ? AND task_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(projectId, taskId, TASK_VERIFICATION_BATCHES_MAX_COUNT + 1);
        const truncated = batchRows.length > TASK_VERIFICATION_BATCHES_MAX_COUNT;
        const batches: TaskVerificationBatchView[] = batchRows
          .slice(0, TASK_VERIFICATION_BATCHES_MAX_COUNT)
          .map((batchRow) => {
            const batch = verificationBatchRecordFromRow(batchRow);
            if (batch.taskId !== taskId || batch.projectId !== projectId) {
              throw corrupt(operation, '验证批次归属损坏', projectId, taskId);
            }
            const checks = session.database
              .prepare<[string, string], CheckResultRow>(
                `SELECT ${CHECK_RESULT_COLUMNS} FROM check_results WHERE project_id = ? AND batch_id = ?
                 ORDER BY created_at, id`,
              )
              .all(projectId, batch.id)
              .map(checkResultRecordFromRow);
            return { batch, checks };
          });
        return {
          task: taskRow,
          latestAttempt: readLatestAttempt(projectId, taskId),
          batches,
          batchesTruncated: truncated,
          settlements: readSettlements(
            projectId,
            taskId,
            batches.map((entry) => entry.batch.attemptId),
          ),
        };
      });
    },

    listTaskApprovalItemRows(
      visibility: unknown,
      project: unknown,
      task: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<TaskApprovalItemRow> {
      const operation = `${OPERATION}.listTaskApprovalItemRows`;
      assertRequest(operation, request);
      assertPrincipalVisibility(visibility);
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return read(operation, () => {
        const conditions = [
          'project_id = ?',
          'task_id = ?',
          '(created_at > ? OR (created_at = ? AND id > ?))',
        ];
        const params: unknown[] = [
          projectId,
          taskId,
          request.after?.sort ?? -1,
          request.after?.sort ?? -1,
          request.after?.id ?? '',
        ];
        const visible = visibilityCondition(visibility, 'project_id');
        if (visible.condition !== undefined) {
          conditions.push(visible.condition);
          params.push(...visible.params);
        }
        params.push(request.limit + 1);
        const rows = session.database
          .prepare<unknown[], TaskApprovalItemSqlRow>(
            `SELECT ${APPROVAL_ITEM_COLUMNS} FROM task_approval_items
             WHERE ${conditions.join(' AND ')} ORDER BY created_at, id LIMIT ?`,
          )
          .all(...params);
        const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
        const records = pageRows.map(taskApprovalItemFromRow);
        const last = records[records.length - 1];
        return {
          records,
          nextKey:
            rows.length > request.limit && last !== undefined
              ? { sort: last.createdAtUtcMs, id: last.id }
              : null,
        };
      });
    },

    readTaskReworkView(project: unknown, task: unknown): TaskReworkView | undefined {
      const operation = `${OPERATION}.readTaskReworkView`;
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return read(operation, () => {
        const taskRow = readTaskRow(projectId, taskId);
        if (taskRow === undefined) return undefined;
        const latestAttempt = readLatestAttempt(projectId, taskId);
        let run: TaskReworkRunRow | null = null;
        if (latestAttempt !== null) {
          const row = session.database
            .prepare<[string, string], ReworkRunSqlRow>(
              `SELECT ${REWORK_RUN_COLUMNS} FROM runs WHERE id = ? AND project_id = ?`,
            )
            .get(latestAttempt.runId, projectId);
          if (row === undefined) {
            throw corrupt(operation, 'Attempt 所属 Run 行缺失', projectId, taskId);
          }
          run = runRowFromSql(row);
        }
        return { task: taskRow, latestAttempt, run };
      });
    },

    listTaskReworkAttemptRows(
      visibility: unknown,
      project: unknown,
      task: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<TaskReworkAttemptRow> {
      const operation = `${OPERATION}.listTaskReworkAttemptRows`;
      assertRequest(operation, request);
      assertPrincipalVisibility(visibility);
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return read(operation, () => {
        const conditions = [
          'attempts.project_id = ?',
          'attempts.task_id = ?',
          '(attempts.number > ? OR (attempts.number = ? AND attempts.id > ?))',
        ];
        const params: unknown[] = [
          projectId,
          taskId,
          request.after?.sort ?? -1,
          request.after?.sort ?? -1,
          request.after?.id ?? '',
        ];
        const visible = visibilityCondition(visibility, 'attempts.project_id');
        if (visible.condition !== undefined) {
          conditions.push(visible.condition);
          params.push(...visible.params);
        }
        params.push(request.limit + 1);
        const rows = session.database
          .prepare<unknown[], AttemptRow & { reservation_attempt_key: string | null; reservation_classification: string | null; reservation_reason: string | null }>(
            `SELECT attempts.*, reservations.attempt_key AS reservation_attempt_key,
               reservations.classification AS reservation_classification,
               reservations.reason AS reservation_reason
             FROM attempts
             LEFT JOIN task_attempt_reservations AS reservations
               ON reservations.project_id = attempts.project_id
              AND reservations.task_id = attempts.task_id
              AND reservations.attempt_key = attempts.id
             WHERE ${conditions.join(' AND ')} ORDER BY attempts.number, attempts.id LIMIT ?`,
          )
          .all(...params);
        const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
        const records: TaskReworkAttemptRow[] = pageRows.map((row) => {
          const { reservation_attempt_key: _key, reservation_classification, reservation_reason, ...attemptRow } = row;
          const settlement =
            reservation_classification === null
              ? null
              : settlementFromRow(
                  { attempt_key: attemptRow.id, classification: reservation_classification, reason: reservation_reason },
                  projectId,
                );
          return { attempt: attemptFromRow(attemptRow), settlement };
        });
        const last = records[records.length - 1];
        return {
          records,
          nextKey:
            rows.length > request.limit && last !== undefined
              ? { sort: last.attempt.number, id: last.attempt.id }
              : null,
        };
      });
    },
  };
}
