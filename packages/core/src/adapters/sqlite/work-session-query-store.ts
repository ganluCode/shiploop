/**
 * P03-6 / F-011 Work Session、Runtime 结果、停止证据与最小诊断制品只读窄
 * 端口的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/work-session-query.ts 同一契约）：
 * - 全部读取以 BEGIN DEFERRED 一致读事务执行；本模块无任何写原语——不创建
 *   Attempt、不扣预算、不续租、不写事件、不触发取消或执行；
 * - 跨项目/不存在目标统一 undefined（存在性折叠由应用层完成，绝不区分
 *   「不存在」与「属于其他项目」）；持久行/证据索引损坏 fail-closed
 *   （StorageError corrupt）；
 * - 列表只含 kind='work' 的顶层 Work Session（Chat Session 不混入），可见
 *   范围谓词下推 SQL（visibility 非法形状为可信装配编程错误 TypeError），
 *   复合排序键（Attempt number, Session id）排他下界、稳定排序；
 * - 证据索引只按受控 locator 前缀（sessions/<id>/ 与 attempts/<id>/）精确
 *   匹配（substr 等值比较，不用 LIKE 通配），绝不接受任意路径；
 * - import 本模块无副作用，会话生命周期由调用方管理。
 */
import { StorageError } from '../../ports/errors.js';
import { assertPrincipalVisibility } from '../../ports/queries.js';
import { validateStableId } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';
import {
  validateAttemptNotificationDiagnosticRecord,
} from '../../ports/execution-schedule-query.js';
import type {
  AttemptNotificationDiagnosticRecord,
  ExecutionListRequest,
  ExecutionRecordPage,
} from '../../ports/execution-schedule-query.js';
import {
  WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT,
  WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT,
} from '../../ports/work-session-query.js';
import type {
  WorkSessionAttemptRow,
  WorkSessionDetailView,
  WorkSessionQueryReadStore,
} from '../../ports/work-session-query.js';
import { attemptFromRow, leaseFromRow } from './attempt-store.js';
import type { AttemptRow, LeaseRow } from './attempt-store.js';
import { artifactFromRow } from './artifact-store.js';
import type { ArtifactRow } from './artifact-store.js';
import {
  SESSION_COLUMNS,
  workSessionRecordFromRow,
} from './work-session-store.js';
import type { SessionRow } from './work-session-store.js';
import { transactSqliteConsistentRead, visibilityCondition } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'WorkSessionQueryStore';

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
export function createSqliteWorkSessionQueryStore(
  session: SqliteStorageSession,
): WorkSessionQueryReadStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteWorkSessionQueryStore: session 必须是 SqliteStorageSession');
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

  function readAttemptRow(attemptId: string): AttemptRow | undefined {
    return session.database
      .prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?')
      .get(attemptId);
  }

  function readSessionRowByAttempt(attemptId: string): SessionRow | undefined {
    return session.database
      .prepare<[string], SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE attempt_id = ? AND kind = 'work'`,
      )
      .get(attemptId);
  }

  function listSessionPage(
    operation: string,
    visibility: unknown,
    projectId: string,
    parent: { readonly kind: 'run' | 'task'; readonly id: string },
    request: ExecutionListRequest,
  ): ExecutionRecordPage<WorkSessionAttemptRow> {
    assertRequest(operation, request);
    // 可见范围形状非法 = 可信装配编程错误（TypeError），不折算客户端错误。
    assertPrincipalVisibility(visibility);
    const parentColumn = parent.kind === 'run' ? 'a.run_id' : 'a.task_id';
    const conditions = [
      's.project_id = ?',
      "s.kind = 'work'",
      `${parentColumn} = ?`,
      '(a.number > ? OR (a.number = ? AND s.id > ?))',
    ];
    const params: unknown[] = [
      projectId,
      parent.id,
      request.after?.sort ?? -1,
      request.after?.sort ?? -1,
      request.after?.id ?? '',
    ];
    const visible = visibilityCondition(visibility, 's.project_id');
    if (visible.condition !== undefined) {
      conditions.push(visible.condition);
      params.push(...visible.params);
    }
    params.push(request.limit + 1);
    return read(operation, () => {
      const rows = session.database
        .prepare<unknown[], { session_id: string; attempt_id: string; attempt_number: number }>(
          `SELECT s.id AS session_id, a.id AS attempt_id, a.number AS attempt_number
           FROM sessions AS s JOIN attempts AS a ON a.id = s.attempt_id AND a.project_id = s.project_id
           WHERE ${conditions.join(' AND ')} ORDER BY a.number, s.id LIMIT ?`,
        )
        .all(...params);
      const pageRows = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
      const records = pageRows.map((row) => {
        const sessionRow = session.database
          .prepare<[string], SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
          .get(row.session_id);
        const attemptRow = readAttemptRow(row.attempt_id);
        if (sessionRow === undefined || attemptRow === undefined) {
          throw new StorageError('corrupt', operation, 'Session page row missing after page read', {
            entity: { type: 'work_session', id: row.session_id, projectId },
          });
        }
        return { session: workSessionRecordFromRow(sessionRow), attempt: attemptFromRow(attemptRow) };
      });
      const last = pageRows[pageRows.length - 1];
      return {
        records,
        nextKey:
          rows.length > request.limit && last !== undefined
            ? { sort: last.attempt_number, id: last.session_id }
            : null,
      };
    });
  }

  return {
    readRunRef(project: unknown, run: unknown): { readonly id: string } | undefined {
      const operation = `${OPERATION}.readRunRef`;
      const projectId = stableId(operation, project, 'projectId');
      const runId = stableId(operation, run, 'runId');
      return read(operation, () => {
        const row = session.database
          .prepare<[string], { id: string; project_id: string }>('SELECT id, project_id FROM runs WHERE id = ?')
          .get(runId);
        if (row === undefined || row.project_id !== projectId) {
          return undefined;
        }
        return { id: row.id };
      });
    },

    listRunWorkSessions(
      visibility: unknown,
      project: unknown,
      run: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<WorkSessionAttemptRow> {
      const operation = `${OPERATION}.listRunWorkSessions`;
      const projectId = stableId(operation, project, 'projectId');
      const runId = stableId(operation, run, 'runId');
      return listSessionPage(operation, visibility, projectId, { kind: 'run', id: runId }, request);
    },

    listTaskWorkSessions(
      visibility: unknown,
      project: unknown,
      task: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<WorkSessionAttemptRow> {
      const operation = `${OPERATION}.listTaskWorkSessions`;
      const projectId = stableId(operation, project, 'projectId');
      const taskId = stableId(operation, task, 'taskId');
      return listSessionPage(operation, visibility, projectId, { kind: 'task', id: taskId }, request);
    },

    readWorkSessionDetail(project: unknown, attempt: unknown): WorkSessionDetailView | undefined {
      const operation = `${OPERATION}.readWorkSessionDetail`;
      const projectId = stableId(operation, project, 'projectId');
      const attemptId = stableId(operation, attempt, 'attemptId');
      return read(operation, () => {
        const attemptRow = readAttemptRow(attemptId);
        // 跨项目/不存在统一折叠为 undefined（不区分存在性，不泄漏归属）。
        if (attemptRow === undefined || attemptRow.project_id !== projectId) {
          return undefined;
        }
        const attemptRecord = attemptFromRow(attemptRow);
        const sessionRow = readSessionRowByAttempt(attemptId);
        // 防御纵深：同一读事务内 Session 归属必须与 Attempt 一致。
        if (sessionRow !== undefined && sessionRow.project_id !== projectId) {
          throw new StorageError('corrupt', operation, 'Work session ownership mismatch', {
            entity: { type: 'work_session', id: sessionRow.id, projectId },
          });
        }
        const sessionRecord = sessionRow === undefined ? null : workSessionRecordFromRow(sessionRow);
        const occupancy = session.database
          .prepare<[string, string], LeaseRow>(
            `SELECT * FROM workspace_leases WHERE project_id = ? AND owner_id = ?
             ORDER BY resource_key`,
          )
          .all(projectId, attemptId)
          .map(leaseFromRow);
        // 证据索引：受控 locator 前缀精确匹配（substr 等值，不用 LIKE 通配）。
        const prefixes =
          sessionRecord === null
            ? ([`attempts/${attemptId}/`] as const)
            : ([`sessions/${sessionRecord.id}/`, `attempts/${attemptId}/`] as const);
        const prefixCondition = prefixes
          .map((prefix) => `substr(storage_locator, 1, ${prefix.length}) = ?`)
          .join(' OR ');
        const evidenceRows = session.database
          .prepare<unknown[], ArtifactRow>(
            `SELECT * FROM artifacts WHERE project_id = ? AND (${prefixCondition})
             ORDER BY storage_locator, id LIMIT ?`,
          )
          .all(projectId, ...prefixes, WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT + 1);
        const evidenceContext: ValidationContext = {
          operation,
          entity: { type: 'artifact', projectId },
        };
        const evidenceTruncated = evidenceRows.length > WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT;
        const evidence = evidenceRows
          .slice(0, WORK_SESSION_DETAIL_EVIDENCE_MAX_COUNT)
          .map((row) => artifactFromRow(row, evidenceContext));
        const diagnosticRows = session.database
          .prepare<[string, string, number], DiagnosticRow>(
            `SELECT id, project_id, attempt_id, notification_digest, reason, occurred_at
             FROM attempt_notification_diagnostics WHERE project_id = ? AND attempt_id = ?
             ORDER BY occurred_at, id LIMIT ?`,
          )
          .all(projectId, attemptId, WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT + 1);
        const diagnosticsTruncated = diagnosticRows.length > WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT;
        const diagnostics = diagnosticRows
          .slice(0, WORK_SESSION_DETAIL_DIAGNOSTICS_MAX_COUNT)
          .map(diagnosticFromRow);
        return {
          attempt: attemptRecord,
          session: sessionRecord,
          occupancy,
          evidence,
          evidenceTruncated,
          diagnostics,
          diagnosticsTruncated,
        };
      });
    },
  };
}
