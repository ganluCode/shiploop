import {
  ACTIVE_ATTEMPT_STATUSES,
  validateAttemptRecord, validateWorkspaceLeaseRecord,
  type AttemptStore, type AttemptRecord, type WorkspaceLeaseRecord,
} from '../../ports/attempt-store.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';

export interface AttemptRow {
  id: string; created_at: number; updated_at: number; revision: number;
  project_id: string; feature_id: string; run_id: string; task_id: string; number: number;
  owner_id: string; host_instance_id: string; execution_version: number; lease_until: number;
  status: string; execution_stage: string; input_snapshot: string; input_digest: string; input_ref: string;
  session_id: string | null; invocation_id: string | null; code_ref: string | null; error_kind: string | null;
  diagnostic_ref: string | null; started_at: number | null; ended_at: number | null;
  duration_ms: number | null; exit_code: number | null; usage_summary: string | null;
}
export interface LeaseRow {
  id: string; created_at: number; updated_at: number; revision: number; project_id: string;
  resource_key: string; resource_kind: string; owner_kind: string; owner_id: string; host_instance_id: string;
  execution_version: number; state: string; lease_until: number; process_identity: string | null;
}
export function attemptFromRow(row: AttemptRow): AttemptRecord {
  try {
    return validateAttemptRecord({ id: row.id, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
      revision: row.revision, projectId: row.project_id, featureId: row.feature_id, runId: row.run_id, taskId: row.task_id,
      number: row.number, owner: row.owner_id, hostInstanceId: row.host_instance_id, executionVersion: row.execution_version,
      leaseUntilUtcMs: row.lease_until, status: row.status, executionStage: row.execution_stage,
      inputSnapshot: JSON.parse(row.input_snapshot), inputDigest: row.input_digest, inputRef: row.input_ref,
      sessionId: row.session_id, invocationId: row.invocation_id, codeRef: row.code_ref, errorKind: row.error_kind,
      diagnosticRef: row.diagnostic_ref, startedAtUtcMs: row.started_at, endedAtUtcMs: row.ended_at,
      durationMs: row.duration_ms, exitCode: row.exit_code, usageSummary: row.usage_summary === null ? null : JSON.parse(row.usage_summary) });
  } catch {
    throw new StorageError('corrupt', 'AttemptStore.read', 'Invalid stored attempt',
      { entity: { type: 'attempt', id: row.id, projectId: row.project_id } });
  }
}
export function leaseFromRow(row: LeaseRow): WorkspaceLeaseRecord {
  try {
    return validateWorkspaceLeaseRecord({ id: row.id, createdAtUtcMs: row.created_at, updatedAtUtcMs: row.updated_at,
      revision: row.revision, projectId: row.project_id, resourceKey: row.resource_key, resourceKind: row.resource_kind,
      ownerKind: row.owner_kind, owner: row.owner_id, hostInstanceId: row.host_instance_id,
      executionVersion: row.execution_version, state: row.state, leaseUntilUtcMs: row.lease_until,
      processIdentity: row.process_identity === null ? null : JSON.parse(row.process_identity) });
  } catch {
    throw new StorageError('corrupt', 'AttemptStore.read', 'Invalid stored resource occupancy',
      { entity: { type: 'workspace_lease', id: row.id, projectId: row.project_id } });
  }
}

/** Read-only access: no claim, lease expiry/release, budget adjustment or runtime I/O. */
export function createSqliteAttemptAccess(session: SqliteStorageSession): AttemptStore {
  const operation = 'AttemptStore.read';
  function stable(value: unknown, field: string): string { return validateStableId(value, { operation }, field); }
  function read<T>(fn: () => T): T {
    if (!session.isOpen()) throw new StorageError('corrupt', operation, 'Storage session is closed');
    return session.database.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  }
  return {
    getAttempt(project: unknown, attempt: unknown) {
      const projectId = stable(project, 'projectId'), attemptId = stable(attempt, 'attemptId');
      return read(() => {
        const row = session.database.prepare<[string], AttemptRow>('SELECT * FROM attempts WHERE id = ?').get(attemptId);
        if (!row) throw new StorageError('not_found', operation, 'Attempt not found', { entity: { type: 'attempt', id: attemptId, projectId } });
        if (row.project_id !== projectId) throw new StorageError('ownership', operation, 'Attempt belongs to another project');
        return attemptFromRow(row);
      });
    },
    listTaskAttempts(project: unknown, task: unknown) {
      const projectId = stable(project, 'projectId'), taskId = stable(task, 'taskId');
      return read(() => {
        const parent = session.database.prepare<[string], { project_id: string }>('SELECT project_id FROM tasks WHERE id = ?').get(taskId);
        if (!parent) throw new StorageError('not_found', operation, 'Task not found');
        if (parent.project_id !== projectId) throw new StorageError('ownership', operation, 'Task belongs to another project');
        return session.database.prepare<[string, string], AttemptRow>('SELECT * FROM attempts WHERE project_id = ? AND task_id = ? ORDER BY number, id')
          .all(projectId, taskId).map(attemptFromRow);
      });
    },
    listActiveAttempts(project: unknown, targetKind: 'run' | 'batch', target: unknown) {
      const projectId = stable(project, 'projectId'), targetId = stable(target, 'targetId');
      if (targetKind !== 'run' && targetKind !== 'batch') {
        throw new StorageError('validation', operation, 'targetKind 必须是 run 或 batch');
      }
      return read(() => {
        const active = ACTIVE_ATTEMPT_STATUSES.map(() => '?').join(', ');
        const rows = targetKind === 'run'
          ? session.database.prepare<unknown[], AttemptRow>(
            `SELECT * FROM attempts WHERE project_id = ? AND run_id = ? AND status IN (${active}) ORDER BY number, id`,
          ).all(projectId, targetId, ...ACTIVE_ATTEMPT_STATUSES)
          : session.database.prepare<unknown[], AttemptRow>(
            `SELECT a.* FROM attempts a JOIN runs r ON r.project_id = a.project_id AND r.id = a.run_id
              WHERE a.project_id = ? AND r.batch_id = ? AND a.status IN (${active}) ORDER BY a.run_id, a.number, a.id`,
          ).all(projectId, targetId, ...ACTIVE_ATTEMPT_STATUSES);
        return rows.map(attemptFromRow);
      });
    },
    listWorkspaceLeases(project: unknown) {
      const projectId = stable(project, 'projectId');
      return read(() => session.database.prepare<[string], LeaseRow>('SELECT * FROM workspace_leases WHERE project_id = ? ORDER BY resource_key, id')
        .all(projectId).map(leaseFromRow));
    },
    listAttemptsWithLeases(project: unknown, targetKind: 'run' | 'batch', target: unknown) {
      const projectId = stable(project, 'projectId'), targetId = stable(target, 'targetId');
      if (targetKind !== 'run' && targetKind !== 'batch') {
        throw new StorageError('validation', operation, 'targetKind 必须是 run 或 batch');
      }
      return read(() => {
        const rows = targetKind === 'run'
          ? session.database.prepare<[string, string], AttemptRow>(
            `SELECT DISTINCT a.* FROM attempts a JOIN workspace_leases l ON l.project_id = a.project_id AND l.owner_id = a.id
              WHERE a.project_id = ? AND a.run_id = ? ORDER BY a.number, a.id`,
          ).all(projectId, targetId)
          : session.database.prepare<[string, string], AttemptRow>(
            `SELECT DISTINCT a.* FROM attempts a JOIN runs r ON r.project_id = a.project_id AND r.id = a.run_id
              JOIN workspace_leases l ON l.project_id = a.project_id AND l.owner_id = a.id
              WHERE a.project_id = ? AND r.batch_id = ? ORDER BY a.run_id, a.number, a.id`,
          ).all(projectId, targetId);
        return rows.map(attemptFromRow);
      });
    },
  };
}
