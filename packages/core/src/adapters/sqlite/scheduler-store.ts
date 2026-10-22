import { StorageError } from '../../ports/errors.js';
import type {
  SchedulerPage,
  SchedulerScanCursor,
  SchedulerStore,
} from '../../ports/work-scheduler.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'SchedulerStore';
const CONTINUATION_STATUSES = ['running', 'pausing', 'paused', 'cancelling', 'interrupted'];
const ACTIVE_STATUSES = ['queued', ...CONTINUATION_STATUSES];
const HANDOFF_REASON = 'feature_final_verification_handed_off';

interface ScanRow {
  readonly project_id: string;
  readonly run_id: string;
  readonly rank: number;
  readonly key1: number;
  readonly key2: number;
}

/**
 * 有界补扫视图：
 * - rank 0：已登记派发意图且仍 queued 的 Run，按入队事实 `enqueued_at, rowid` 排序；
 * - rank 1：其余活动 Run：已开始或受控中的续跑 Run，以及未登记意图的 legacy
 *   queued Run，按 Run 不可变 `created_at, rowid` 排序。已有意图但已离开 queued
 *   的 Run（同 Run 下一 Task 串行续跑）必须在此继续被发现，不能因自身意图丢失。
 * 两个来源都是持久事实，游标键不可变，因此分页稳定且不依赖内存唤醒。
 */
const SCAN_SQL = `WITH candidate AS (
  SELECT i.project_id AS project_id, i.run_id AS run_id, 0 AS rank, i.enqueued_at AS key1, i.rowid AS key2
    FROM run_dispatch_intents i
    JOIN runs r ON r.project_id = i.project_id AND r.id = i.run_id
   WHERE r.status = 'queued'
  UNION ALL
  SELECT r.project_id, r.id, 1, r.created_at, r.rowid
    FROM runs r
   WHERE r.status IN (${CONTINUATION_STATUSES.map(() => '?').join(',')})
      OR (r.status = 'queued' AND NOT EXISTS (SELECT 1 FROM run_dispatch_intents i
        WHERE i.project_id = r.project_id AND i.run_id = r.id))
)
SELECT project_id, run_id, rank, key1, key2 FROM candidate
 WHERE ? IS NULL OR rank > ? OR (rank = ? AND (key1 > ? OR (key1 = ? AND key2 > ?)))
 ORDER BY rank ASC, key1 ASC, key2 ASC LIMIT ?`;

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
    listActiveRuns(input: { after: SchedulerScanCursor | null; limit: number }): SchedulerPage {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new TypeError('SchedulerStore.listActiveRuns limit must be in [1, 1000]');
      }
      return read(`${OPERATION}.listActiveRuns`, () => {
        const after = input.after ?? null;
        const rows = session.database.prepare(SCAN_SQL).all(
          ...CONTINUATION_STATUSES,
          after === null ? null : after.rank,
          after?.rank ?? 0,
          after?.rank ?? 0,
          after?.key1 ?? 0,
          after?.key1 ?? 0,
          after?.key2 ?? 0,
          input.limit,
        ) as ScanRow[];
        const last = rows[rows.length - 1];
        return {
          runs: rows.map(row => ({ projectId: row.project_id, runId: row.run_id })),
          hasMore: rows.length === input.limit,
          nextCursor: rows.length === 0 || rows.length < input.limit || last === undefined ? null : {
            projectId: last.project_id,
            runId: last.run_id,
            rank: last.rank,
            key1: last.key1,
            key2: last.key2,
          },
        };
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
