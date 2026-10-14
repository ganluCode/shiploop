import { StorageError } from '../../ports/errors.js';
import type { SchedulerPage, SchedulerRunRef, SchedulerStore } from '../../ports/work-scheduler.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'SchedulerStore';
const ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'];
const HANDOFF_REASON = 'feature_final_verification_handed_off';

function assertOpen(session: SqliteStorageSession): void {
  if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
}

/** SQLite is the scheduler truth; this adapter deliberately exposes bounded pages only. */
export function createSqliteSchedulerStore(session: SqliteStorageSession, options: {
  readonly nowUtcMs?: () => number;
} = {}): SchedulerStore {
  const execution = createSqliteExecutionAccess(session);
  const now = options.nowUtcMs ?? Date.now;
  const read = <T>(operation: string, fn: () => T): T => {
    assertOpen(session);
    return session.database.inTransaction ? fn() : transactSqliteConsistentRead(session, operation, fn);
  };
  const write = <T>(operation: string, fn: () => T): T => {
    assertOpen(session);
    return session.transactWrite(operation, fn);
  };
  return {
    listActiveRuns(input: { after: SchedulerRunRef | null; limit: number }): SchedulerPage {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new TypeError('SchedulerStore.listActiveRuns limit must be in [1, 1000]');
      }
      return read(`${OPERATION}.listActiveRuns`, () => {
        const after = input.after;
        const where = after === null ? '' : ' AND (project_id > ? OR (project_id = ? AND id > ?))';
        const args = after === null
          ? [...ACTIVE_STATUSES, input.limit]
          : [...ACTIVE_STATUSES, after.projectId, after.projectId, after.runId, input.limit];
        const rows = session.database.prepare(`SELECT project_id, id FROM runs
          WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})${where}
          ORDER BY project_id ASC, id ASC LIMIT ?`).all(...args) as { project_id: string; id: string }[];
        return { runs: rows.map(row => ({ projectId: row.project_id, runId: row.id })), hasMore: rows.length === input.limit };
      });
    },
    recordRunReason(projectId: string, runId: string, reason: string): void {
      if (reason.length === 0 || reason.length > 512) throw new TypeError('Scheduler reason must be 1..512 characters');
      write(`${OPERATION}.recordRunReason`, () => {
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new TypeError('Invalid scheduler clock');
        session.database.prepare(`UPDATE runs SET reason = ?, updated_at = ?, revision = revision + 1
          WHERE project_id = ? AND id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
            AND (reason IS NULL OR reason <> ?)`).run(reason, timestamp, projectId, runId, ...ACTIVE_STATUSES, reason);
      });
    },
    isFinalVerificationHandoffClaimed(projectId: string, runId: string): boolean {
      return read(`${OPERATION}.isFinalVerificationHandoffClaimed`, () => {
        const row = session.database.prepare<[string, string], { reason: string }>(
          'SELECT reason FROM runs WHERE project_id = ? AND id = ?',
        ).get(projectId, runId);
        return row?.reason === HANDOFF_REASON;
      });
    },
    recordFinalVerificationHandoff(projectId: string, runId: string): boolean {
      return write(`${OPERATION}.claimFinalVerificationHandoff`, () => {
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new TypeError('Invalid scheduler clock');
        const changed = session.database.prepare(`UPDATE runs SET reason = ?, updated_at = ?, revision = revision + 1
          WHERE project_id = ? AND id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
            AND (reason IS NULL OR reason <> ?)`).run(HANDOFF_REASON, timestamp, projectId, runId, ...ACTIVE_STATUSES, HANDOFF_REASON);
        return changed.changes === 1;
      });
    },
    readRun(projectId: string, runId: string) {
      return read(`${OPERATION}.readRun`, () => {
        if (!session.database.inTransaction) throw new Error('readRun must be called inside read transaction');
        return execution.getExecutionRunInTransaction(projectId, runId);
      });
    },
  };
}

export { HANDOFF_REASON };
