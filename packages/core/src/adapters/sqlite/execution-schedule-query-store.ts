/**
 * P03-4 / F-007 Run 调度与 Attempt/占用审计只读窄端口的 SQLite 装配
 * （adapters 层）。
 *
 * 不变量（与 ports/execution-schedule-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行（readRunScheduleView 内联复用
 *   F-002 的 TaskDagStore 同事务路径：同一快照内取得 Run/Attempt/占用/DAG
 *   视图，并发提交只能被观察为完整前或完整后）；本模块无任何写原语；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成，绝不区分
 *   「不存在」与「属于其他项目」）；持久行损坏为 corrupt（fail-closed）；
 * - 持久 DAG 视图损坏（invalid_graph）时仅降级 dag 视图：Run、Attempt 与
 *   占用事实仍如实返回（与 F-002 createTaskDagService 的降级语义同源，
 *   查询不伪造 ready，也不把存储损坏隐藏成空结果）；
 * - 列表读取沿用计划分页规范：可见范围谓词下推 SQL（visibility 非法形状
 *   为可信装配编程错误 TypeError）、复合排序键排他下界、稳定排序；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import type { AttemptRecord } from '../../ports/attempt-store.js';
import {
  validateAttemptNotificationDiagnosticRecord,
} from '../../ports/execution-schedule-query.js';
import type {
  AttemptNotificationDiagnosticRecord,
  ExecutionListRequest,
  ExecutionRecordPage,
  ExecutionScheduleQueryReadStore,
  RunScheduleOccupancyRow,
  RunScheduleView,
} from '../../ports/execution-schedule-query.js';
import { attemptFromRow, leaseFromRow } from './attempt-store.js';
import type { AttemptRow, LeaseRow } from './attempt-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteTaskDagStore } from './task-dag-store.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ExecutionScheduleQueryStore';

interface DiagnosticRow {
  id: string;
  project_id: string;
  attempt_id: string;
  notification_digest: string;
  reason: string;
  occurred_at: number;
}

function diagnosticFromRow(row: DiagnosticRow): AttemptNotificationDiagnosticRecord {
  try {
    return validateAttemptNotificationDiagnosticRecord({
      id: row.id,
      projectId: row.project_id,
      attemptId: row.attempt_id,
      notificationDigest: row.notification_digest,
      reason: row.reason,
      occurredAtUtcMs: row.occurred_at,
    });
  } catch {
    throw new StorageError('corrupt', `${OPERATION}.read`, 'Invalid stored Attempt notification diagnostic', {
      entity: { type: 'attempt', id: row.attempt_id, projectId: row.project_id },
    });
  }
}

function stableId(operation: string, value: unknown, field: string): string {
  const context: ValidationContext = { operation };
  return validateStableId(value, context, field);
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

/** SQLite 装配：只读一致视图 + 键集分页；不创建 Attempt、不续租、不写事件。 */
export function createSqliteExecutionScheduleQueryStore(
  session: SqliteStorageSession,
): ExecutionScheduleQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteExecutionScheduleQueryStore: session 必须是 SqliteStorageSession');
  }
  const execution = createSqliteExecutionAccess(session);
  const dagStore = createSqliteTaskDagStore(session);

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', operation, 'Storage session is closed');
    }
  }

  function read<T>(operation: string, fn: () => T): T {
    assertOpen(operation);
    return session.database.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  }

  return {
    readRunScheduleView(project: unknown, run: unknown): RunScheduleView | undefined {
      const operation = `${OPERATION}.readRunScheduleView`;
      const projectId = stableId(operation, project, 'projectId');
      const runId = stableId(operation, run, 'runId');
      return read(operation, () => {
        let runRecord;
        try {
          runRecord = execution.getExecutionRunInTransaction(projectId, runId);
        } catch (error) {
          // 跨项目/不存在统一折叠为 undefined（不区分存在性，不泄漏归属）。
          if (
            error instanceof StorageError &&
            (error.kind === 'not_found' || error.kind === 'ownership')
          ) {
            return undefined;
          }
          throw error;
        }
        const attempts = session.database
          .prepare<[string, string], AttemptRow>(
            'SELECT * FROM attempts WHERE project_id = ? AND run_id = ? ORDER BY task_id, number, id',
          )
          .all(projectId, runId)
          .map(attemptFromRow);
        const occupancy: RunScheduleOccupancyRow[] = session.database
          .prepare<[string], LeaseRow & { owner_run_id: string }>(
            `SELECT leases.*, owner.run_id AS owner_run_id FROM workspace_leases AS leases
             JOIN attempts AS owner ON owner.project_id = leases.project_id AND owner.id = leases.owner_id
             WHERE leases.project_id = ? ORDER BY leases.owner_id, leases.resource_key`,
          )
          .all(projectId)
          .map((row) => {
            const { owner_run_id: ownerRunId, ...leaseRow } = row;
            return { lease: leaseFromRow(leaseRow), runId: ownerRunId };
          });
        let dag: RunScheduleView['dag'];
        try {
          dag = dagStore.readTaskDagView(projectId, runId);
        } catch (error) {
          // 与 F-002 createTaskDagService 同一降级语义：持久视图损坏 →
          // dag 缺失（应用层映射 invalid_graph/corrupt_persisted_view）。
          if (
            error instanceof StorageError &&
            error.kind === 'corrupt' &&
            error.details?.reason === 'invalid_graph'
          ) {
            dag = null;
          } else {
            throw error;
          }
        }
        return { run: runRecord, dag, attempts, occupancy };
      });
    },

    readAttemptRecord(project: unknown, attempt: unknown): AttemptRecord | undefined {
      const operation = `${OPERATION}.readAttemptRecord`;
      const projectId = stableId(operation, project, 'projectId');
      const attemptId = stableId(operation, attempt, 'attemptId');
      return read(operation, () => {
        const row = session.database
          .prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?')
          .get(attemptId);
        if (row === undefined || row.project_id !== projectId) {
          return undefined;
        }
        return attemptFromRow(row);
      });
    },

    listTaskAttemptRecords(
      visibility: unknown,
      project: unknown,
      task: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<AttemptRecord> {
      const operation = `${OPERATION}.listTaskAttempts`;
      assertRequest(operation, request);
      // 可见范围形状非法 = 可信装配编程错误（TypeError），不折算客户端错误。
      assertPrincipalVisibility(visibility);
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return read(operation, () => {
        const conditions = [
          'project_id = ?',
          'task_id = ?',
          '(number > ? OR (number = ? AND id > ?))',
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
          .prepare<unknown[], AttemptRow>(
            `SELECT * FROM attempts WHERE ${conditions.join(' AND ')} ORDER BY number, id LIMIT ?`,
          )
          .all(...params);
        const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
        const records = pageRows.map(attemptFromRow);
        const last = records[records.length - 1];
        return {
          records,
          nextKey:
            rows.length > request.limit && last !== undefined
              ? { sort: last.number, id: last.id }
              : null,
        };
      });
    },

    listAttemptDiagnosticRecords(
      visibility: unknown,
      project: unknown,
      attempt: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<AttemptNotificationDiagnosticRecord> {
      const operation = `${OPERATION}.listAttemptDiagnostics`;
      assertRequest(operation, request);
      assertPrincipalVisibility(visibility);
      const projectId = stableId(operation, project, 'projectId');
      const attemptId = stableId(operation, attempt, 'attemptId');
      return read(operation, () => {
        const conditions = [
          'project_id = ?',
          'attempt_id = ?',
          '(occurred_at > ? OR (occurred_at = ? AND id > ?))',
        ];
        const params: unknown[] = [
          projectId,
          attemptId,
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
          .prepare<unknown[], DiagnosticRow>(
            `SELECT * FROM attempt_notification_diagnostics WHERE ${conditions.join(' AND ')} ORDER BY occurred_at, id LIMIT ?`,
          )
          .all(...params);
        const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
        const records = pageRows.map(diagnosticFromRow);
        const last = records[records.length - 1];
        return {
          records,
          nextKey:
            rows.length > request.limit && last !== undefined
              ? { sort: last.occurredAtUtcMs, id: last.id }
              : null,
        };
      });
    },
  };
}
