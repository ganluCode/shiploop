import { StorageError } from '../../ports/errors.js';
import type {
  SchedulerBatchCandidate,
  SchedulerBatchCandidatePage,
  SchedulerBatchScanCursor,
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
const BATCH_ACTIVE_STATUSES = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'interrupted'];
const SHA256 = /^[0-9a-f]{64}$/;
const BATCH_CANDIDATE_SQL = `
SELECT r.project_id, b.phase_id, r.batch_id, r.feature_id, r.id AS run_id,
       m.member_ordinal, r.created_at, r.rowid AS rowid
  FROM execution_batches b
  JOIN execution_batch_members m
    ON m.project_id = b.project_id AND m.batch_id = b.id
  JOIN runs r
    ON r.project_id = m.project_id AND r.batch_id = m.batch_id AND r.feature_id = m.feature_id
 WHERE b.project_id = ? AND b.id = ?
   AND b.status IN (${BATCH_ACTIVE_STATUSES.map(() => '?').join(',')})
   AND r.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
   AND (
     ? IS NULL OR m.member_ordinal > ?
     OR (m.member_ordinal = ? AND r.created_at > ?)
     OR (m.member_ordinal = ? AND r.created_at = ? AND r.rowid > ?)
   )
 ORDER BY m.member_ordinal ASC, r.created_at ASC, r.rowid ASC
 LIMIT ?`;

interface ScanRow {
  readonly project_id: string;
  readonly run_id: string;
  readonly rank: number;
  readonly key1: number;
  readonly key2: number;
}

interface BatchCandidateRow {
  readonly project_id: string;
  readonly phase_id: string;
  readonly batch_id: string;
  readonly feature_id: string;
  readonly run_id: string;
  readonly member_ordinal: number;
  readonly created_at: number;
  readonly rowid: number;
}

interface BatchScopeRow {
  readonly project_id: string;
  readonly phase_id: string;
  readonly feature_id: string;
  readonly status: string;
  readonly scope_snapshot: string;
  readonly config_snapshot: string;
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

function corruptBatch(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('corrupt', `${OPERATION}.listBatchCandidates`, 'Invalid fixed Batch candidate projection', {
    details: { reason, ...details },
  });
}

function parseObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return corruptBatch('invalid_json', { field }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return corruptBatch('invalid_json_shape', { field });
  }
  return parsed as Record<string, unknown>;
}

function validateFixedBatchScope(
  db: SqliteStorageSession['database'],
  projectId: string,
  batchId: string,
): { readonly phaseId: string; readonly featureIds: readonly string[]; readonly active: boolean } {
  const batch = db.prepare<[string, string], BatchScopeRow>(
    'SELECT project_id, phase_id, feature_id, status, scope_snapshot, config_snapshot FROM execution_batches WHERE project_id = ? AND id = ?',
  ).get(projectId, batchId);
  // Treat another project's batch as absent, preserving project isolation.
  if (batch === undefined) return { phaseId: '', featureIds: [], active: false };
  const scope = parseObject(batch.scope_snapshot, 'scope_snapshot');
  const featureIds = scope.featureIds;
  if (!Array.isArray(featureIds) || featureIds.length === 0
    || featureIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(featureIds).size !== featureIds.length
    || typeof scope.previewDigest !== 'string' || !SHA256.test(scope.previewDigest)) {
    return corruptBatch('invalid_batch_scope', { batchId });
  }
  const config = parseObject(batch.config_snapshot, 'config_snapshot');
  const approval = config.approval;
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
    return corruptBatch('invalid_authorization_summary', { batchId });
  }
  const approvalObject = approval as Record<string, unknown>;
  if (typeof approvalObject.planDigest !== 'string' || !SHA256.test(approvalObject.planDigest)
    || typeof approvalObject.checkPolicyDigest !== 'string' || !SHA256.test(approvalObject.checkPolicyDigest)) {
    return corruptBatch('invalid_authorization_summary', { batchId });
  }
  if (batch.feature_id !== featureIds[0]) return corruptBatch('invalid_batch_anchor', { batchId });
  const members = db.prepare<[string, string], { project_id: string; phase_id: string; feature_id: string; member_ordinal: number }>(
    'SELECT project_id, phase_id, feature_id, member_ordinal FROM execution_batch_members WHERE project_id = ? AND batch_id = ? ORDER BY member_ordinal ASC',
  ).all(projectId, batchId);
  if (members.length !== featureIds.length || members.some((member, index) =>
    member.project_id !== projectId || member.phase_id !== batch.phase_id || member.feature_id !== featureIds[index]
      || member.member_ordinal !== index + 1)) {
    return corruptBatch('invalid_batch_members', { batchId });
  }
  return { phaseId: batch.phase_id, featureIds, active: BATCH_ACTIVE_STATUSES.includes(batch.status) };
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
    listBatchCandidates(input: {
      projectId: string;
      batchId: string;
      after: SchedulerBatchScanCursor | null;
      limit: number;
    }): SchedulerBatchCandidatePage {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new TypeError('SchedulerStore.listBatchCandidates limit must be in [1, 1000]');
      }
      return read(`${OPERATION}.listBatchCandidates`, () => {
        const scope = validateFixedBatchScope(session.database, input.projectId, input.batchId);
        if (!scope.active) return { candidates: [], hasMore: false, nextCursor: null };
        const after = input.after;
        if (after !== null && (after.projectId !== input.projectId || after.batchId !== input.batchId
          || !Number.isSafeInteger(after.memberOrdinal) || after.memberOrdinal < 1
          || !Number.isSafeInteger(after.createdAt) || after.createdAt < 0
          || !Number.isSafeInteger(after.rowid) || after.rowid < 1
          || typeof after.featureId !== 'string' || typeof after.runId !== 'string')) {
          return corruptBatch('invalid_scan_cursor', { batchId: input.batchId });
        }
        const rows = session.database.prepare<unknown[], BatchCandidateRow>(BATCH_CANDIDATE_SQL).all(
          input.projectId, input.batchId, ...BATCH_ACTIVE_STATUSES, ...ACTIVE_STATUSES,
          after === null ? null : 1,
          after?.memberOrdinal ?? 0,
          after?.memberOrdinal ?? 0,
          after?.createdAt ?? 0,
          after?.memberOrdinal ?? 0,
          after?.createdAt ?? 0,
          after?.rowid ?? 0,
          input.limit + 1,
        ) as BatchCandidateRow[];
        const pageRows = rows.slice(0, input.limit);
        const hasMore = rows.length > input.limit;
        const last = pageRows.at(-1);
        return {
          candidates: pageRows.map((row): SchedulerBatchCandidate => ({
            projectId: row.project_id, phaseId: row.phase_id, batchId: row.batch_id,
            featureId: row.feature_id, runId: row.run_id, source: 'fixed_batch',
          })),
          hasMore,
          nextCursor: hasMore && last !== undefined ? {
            projectId: last.project_id, batchId: last.batch_id, memberOrdinal: last.member_ordinal,
            createdAt: last.created_at, rowid: last.rowid, featureId: last.feature_id, runId: last.run_id,
          } : null,
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
