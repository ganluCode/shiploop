/**
 * P03-5 / F-011 工作区状态只读查询 SQLite 适配器（fail-closed、单次调用单个
 * BEGIN DEFERRED 一致读事务）。
 *
 * 依据 docs/p03-5-workspace-host-integration-contract.md §4：
 * - 跨项目/不存在统一返回 undefined（存在性折叠由应用层完成）；持久行/回执
 *   缺失或损坏一律 StorageError(corrupt)，绝不静默降级；
 * - operation 回执投影只读白名单字段（command_id/status/result_ref/
 *   result_json 顶层白名单 reason 键）；绝不把回执正文或绝对路径外泄；
 * - 列表键集分页（id 升序 + 排他下界 + limit+1 探测页末）。
 */
import type { Database } from 'better-sqlite3';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';
import { StorageError } from '../../ports/errors.js';
import { mapManagedWorkspaceRow, mapWorkspaceOperationRow } from './workspace.js';
import type { ManagedWorkspaceRecord } from '../../ports/workspace.js';
import type {
  WorkspaceDetailView,
  WorkspaceOperationReceiptView,
  WorkspaceOperationView,
  WorkspaceQueryListRequest,
  WorkspaceQueryPage,
  WorkspaceQueryReadStore,
} from '../../ports/workspace-query.js';

const RECEIPT_RESULT_REASON_KEYS = [
  'reason',
  'missingReason',
  'cancelReason',
  'stopReason',
  'suspensionReason',
  'retryBlockedReason',
] as const;

interface SqlRow {
  [key: string]: unknown;
}

interface ReceiptRow {
  command_id: unknown;
  status: unknown;
  result_ref: unknown;
  result_json: unknown;
}

function failCorrupt(message: string): never {
  throw new StorageError('corrupt', 'WorkspaceQuery', message, { entity: { type: 'workspace' } });
}

/** 从持久回执正文解析白名单 reason（正文必须是 JSON 对象；缺失/未知值折叠为 null；损坏 fail-closed）。 */
function parseReceiptReason(resultJson: unknown): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(resultJson));
  } catch (cause) {
    throw new StorageError('corrupt', 'WorkspaceQuery', 'workspace operation receipt result is invalid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failCorrupt('workspace operation receipt result is not a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  for (const key of RECEIPT_RESULT_REASON_KEYS) {
    const value = body[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

export function createSqliteWorkspaceQueryStore(session: SqliteStorageSession): WorkspaceQueryReadStore {
  const db: Database = session.database;

  function receiptView(receiptId: unknown): WorkspaceOperationReceiptView {
    if (typeof receiptId !== 'string') {
      return failCorrupt('workspace operation receipt pointer is missing');
    }
    const row = db
      .prepare<[string], ReceiptRow>(
        'SELECT command_id, status, result_ref, result_json FROM command_receipts WHERE id = ?',
      )
      .get(receiptId);
    if (!row) {
      return failCorrupt('workspace operation receipt row is missing');
    }
    if (row.status !== 'completed' && row.status !== 'rejected') {
      return failCorrupt('workspace operation receipt has unknown status');
    }
    return {
      commandId: String(row.command_id),
      resultRef: row.result_ref === null ? null : String(row.result_ref),
      status: row.status,
      reason: parseReceiptReason(row.result_json),
    };
  }

  function operationView(row: SqlRow | undefined): WorkspaceOperationView | null {
    if (row === undefined) {
      return null;
    }
    const operation = mapWorkspaceOperationRow(row);
    if (operation === null) {
      return null;
    }
    return { operation, receipt: receiptView(row.receipt_id) };
  }

  function readDetail(projectId: unknown, featureId: unknown): WorkspaceDetailView | undefined {
    const workspaceRow = db
      .prepare<[unknown, unknown], SqlRow>(
        'SELECT * FROM managed_workspaces WHERE project_id = ? AND feature_id = ? ORDER BY id LIMIT 1',
      )
      .get(projectId as never, featureId as never);
    const workspace = mapManagedWorkspaceRow(workspaceRow);
    if (workspace === null) {
      return undefined;
    }
    const preparation = operationView(
      db
        .prepare<[string], SqlRow>('SELECT * FROM workspace_operations WHERE id = ?')
        .get(workspace.preparationOperationId),
    );
    if (preparation === null) {
      return failCorrupt('workspace preparation operation is missing');
    }
    const latest = operationView(
      db
        .prepare<[string], SqlRow>(
          'SELECT * FROM workspace_operations WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        )
        .get(workspace.id),
    );
    if (latest === null) {
      return failCorrupt('workspace latest operation is missing');
    }
    return { workspace, preparation, latest };
  }

  function readOperationView(projectId: unknown, operationId: unknown): WorkspaceOperationView | undefined {
    const row = db
      .prepare<[unknown, unknown], SqlRow>(
        'SELECT * FROM workspace_operations WHERE project_id = ? AND id = ? LIMIT 1',
      )
      .get(projectId as never, operationId as never);
    const view = operationView(row);
    return view === null ? undefined : view;
  }

  function page<T>(rows: readonly SqlRow[], limit: number, map: (row: SqlRow) => T): WorkspaceQueryPage<T> {
    return {
      records: rows.slice(0, limit).map(map),
      nextId: rows.length > limit ? String(rows[limit - 1]!.id) : null,
    };
  }

  function listWorkspaces(
    projectId: unknown,
    featureId: unknown,
    request: WorkspaceQueryListRequest,
  ): WorkspaceQueryPage<ManagedWorkspaceRecord> {
    const rows = (
      featureId === null || featureId === undefined
        ? db
            .prepare<[unknown, string, number], SqlRow>(
              'SELECT * FROM managed_workspaces WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?',
            )
            .all(projectId as never, request.afterId ?? '', request.limit + 1)
        : db
            .prepare<[unknown, unknown, string, number], SqlRow>(
              'SELECT * FROM managed_workspaces WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?',
            )
            .all(projectId as never, featureId as never, request.afterId ?? '', request.limit + 1)
    ) as SqlRow[];
    return page(rows, request.limit, row => {
      const mapped = mapManagedWorkspaceRow(row);
      if (mapped === null) {
        return failCorrupt('workspace list row is empty');
      }
      return mapped;
    });
  }

  function listOperations(
    projectId: unknown,
    featureId: unknown,
    request: WorkspaceQueryListRequest,
  ): WorkspaceQueryPage<WorkspaceOperationView> {
    const rows = (
      featureId === null || featureId === undefined
        ? db
            .prepare<[unknown, string, number], SqlRow>(
              'SELECT * FROM workspace_operations WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?',
            )
            .all(projectId as never, request.afterId ?? '', request.limit + 1)
        : db
            .prepare<[unknown, unknown, string, number], SqlRow>(
              'SELECT * FROM workspace_operations WHERE project_id = ? AND feature_id = ? AND id > ? ORDER BY id LIMIT ?',
            )
            .all(projectId as never, featureId as never, request.afterId ?? '', request.limit + 1)
    ) as SqlRow[];
    return page(rows, request.limit, row => {
      const view = operationView(row);
      if (view === null) {
        return failCorrupt('workspace operation list row is empty');
      }
      return view;
    });
  }

  return {
    readWorkspaceDetail: (projectId, featureId) =>
      transactSqliteConsistentRead(session, 'workspace query detail', () => readDetail(projectId, featureId)),
    readWorkspaceOperationView: (projectId, operationId) =>
      transactSqliteConsistentRead(session, 'workspace query operation', () =>
        readOperationView(projectId, operationId)),
    listWorkspaceRecords: (projectId, featureId, request) =>
      transactSqliteConsistentRead(session, 'workspace query list', () =>
        listWorkspaces(projectId, featureId, request)),
    listWorkspaceOperationViews: (projectId, featureId, request) =>
      transactSqliteConsistentRead(session, 'workspace query operation list', () =>
        listOperations(projectId, featureId, request)),
  };
}
