/**
 * P07-3 / F-008：项目归档收尾占用的 SQLite 只读窄访问。
 *
 * 阻塞集合与 Phase 归档（PlanStore.updatePhase）同一纪律，按项目维度聚合：
 * 非终态 Batch/Run、活动 Attempt、held/quarantined 租约与认领、未确认停止，
 * 另加同项目进行中的基线操作（其进程属于"相关进程"）。expiry/租约到期不
 * 证明写入者已停止，一律保持阻塞（fail-closed）；本模块零写入。
 */
import { StorageError } from '../../ports/errors.js';
import { ACTIVE_EXECUTION_STATUSES } from '../../ports/execution-preview.js';
import {
  hasProjectArchiveBlockers,
  type ProjectArchiveBlockers,
  type ProjectLifecycleCloseout,
} from '../../ports/project-lifecycle.js';
import type { ProjectStatus } from '../../ports/state-store.js';
import { validateStableId } from '../../ports/validation.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';
import type { Database } from 'better-sqlite3';

const OPERATION = 'ProjectLifecycle.readProjectArchiveCloseout';
const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'archiving', 'archived', 'deleting'];
const ACTIVE_ATTEMPT_STATUSES = ['preparing', 'executing', 'verifying'] as const;
const ACTIVE_BASELINE_OPERATION_STATUSES = ['accepted', 'running', 'cancelling'] as const;

function count(db: Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare<unknown[], { n: unknown }>(sql).get(...params);
  const value = row?.n;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageError('corrupt', OPERATION, '归档收尾占用计数超出契约形态', {
      details: { reason: 'invalid_blocker_count' },
    });
  }
  return value;
}

function readCloseoutInDatabase(db: Database, projectId: string): ProjectLifecycleCloseout {
  const statusRow = db.prepare<[string], { status: unknown }>('SELECT status FROM projects WHERE id = ?').get(projectId);
  if (statusRow === undefined) {
    throw new StorageError('not_found', OPERATION, `项目 ${projectId} 不存在`, {
      entity: { type: 'project', id: projectId },
    });
  }
  const status = PROJECT_STATUSES.find(candidate => candidate === statusRow.status);
  if (status === undefined) {
    throw new StorageError('corrupt', OPERATION, '项目状态列超出契约枚举', {
      entity: { type: 'project', id: projectId },
      details: { reason: 'unknown_status' },
    });
  }
  const active = (ACTIVE_EXECUTION_STATUSES as readonly string[]).map(() => '?').join(',');
  const activeAttempts = ACTIVE_ATTEMPT_STATUSES.map(() => '?').join(',');
  const activeBaseline = ACTIVE_BASELINE_OPERATION_STATUSES.map(() => '?').join(',');
  const blockers: ProjectArchiveBlockers = {
    activeBatches: count(db,
      `SELECT COUNT(*) AS n FROM execution_batches WHERE project_id = ? AND status IN (${active})`,
      projectId, ...(ACTIVE_EXECUTION_STATUSES as readonly string[])),
    activeRuns: count(db,
      `SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status IN (${active})`,
      projectId, ...(ACTIVE_EXECUTION_STATUSES as readonly string[])),
    activeAttempts: count(db,
      `SELECT COUNT(*) AS n FROM attempts WHERE project_id = ? AND status IN (${activeAttempts})`,
      projectId, ...ACTIVE_ATTEMPT_STATUSES),
    heldWorkspaceLeases: count(db,
      "SELECT COUNT(*) AS n FROM workspace_leases WHERE project_id = ? AND state IN ('held','quarantined')",
      projectId),
    heldDispatchClaims: count(db,
      "SELECT COUNT(*) AS n FROM run_dispatch_claims WHERE project_id = ? AND state IN ('held','quarantined')",
      projectId),
    heldSlotClaims: count(db,
      "SELECT COUNT(*) AS n FROM execution_slot_claims WHERE project_id = ? AND state IN ('held','quarantined')",
      projectId),
    unconfirmedStops: count(db,
      "SELECT COUNT(*) AS n FROM execution_stop_operations WHERE project_id = ? AND (status <> 'stopped' OR stop_confirmed IS NOT 1)",
      projectId),
    activeBaselineOperations: count(db,
      `SELECT COUNT(*) AS n FROM baseline_operations WHERE project_id = ? AND status IN (${activeBaseline})`,
      projectId, ...ACTIVE_BASELINE_OPERATION_STATUSES),
  };
  return {
    projectId,
    status,
    blockers,
    clear: !hasProjectArchiveBlockers(blockers),
  };
}

/** 收尾快照访问：写事务内直接读（BEGIN IMMEDIATE 下权威）；事务外一致读。 */
export function createSqliteProjectLifecycleAccess(session: SqliteStorageSession) {
  return Object.freeze({
    readProjectArchiveCloseout(projectId: string): ProjectLifecycleCloseout {
      const id = validateStableId(projectId, { operation: OPERATION, entity: { type: 'project' } }, 'projectId');
      if (session.database.inTransaction) {
        throw new TypeError(`${OPERATION}: 只读收尾快照不得嵌套在写事务内（编程错误）`);
      }
      return transactSqliteConsistentRead(session, OPERATION, db => readCloseoutInDatabase(db, id));
    },
    readProjectArchiveCloseoutInTransaction(projectId: string): ProjectLifecycleCloseout {
      const id = validateStableId(projectId, { operation: OPERATION, entity: { type: 'project' } }, 'projectId');
      if (!session.database.inTransaction) {
        throw new TypeError(`${OPERATION}: 事务内收尾快照必须位于调用方写事务内（编程错误）`);
      }
      return readCloseoutInDatabase(session.database, id);
    },
  });
}

export type SqliteProjectLifecycleAccess = ReturnType<typeof createSqliteProjectLifecycleAccess>;

/**
 * F-009 复用：项目级活动占用计数（同上完全 fail-closed）；供删除预览清点在
 * 同一只读事务内取同一口径的活动事实，避免两套阻塞定义漂移。
 */
export function readProjectArchiveCloseoutInDatabase(db: Database, projectId: string): ProjectLifecycleCloseout {
  return readCloseoutInDatabase(db, projectId);
}
