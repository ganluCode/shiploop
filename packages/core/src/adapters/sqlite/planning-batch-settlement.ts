/** 规划成功后的 Batch 收尾：与派发释放/启动恢复同一短写事务，不解除资源占用。 */
import type { SqliteStorageSession } from './session.js';

export function closeSucceededPlanningBatchInTransaction(
  session: SqliteStorageSession, projectId: string, batchId: string, timestamp: number,
): void {
  if (!session.database.inTransaction) throw new TypeError('Planning Batch settlement requires a write transaction');
  session.database.prepare(`UPDATE execution_batches SET status = 'succeeded', reason = NULL,
    revision = revision + 1, updated_at = ?
    WHERE id = ? AND project_id = ? AND status IN ('queued', 'running') AND pause_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM runs WHERE batch_id = execution_batches.id AND project_id = execution_batches.project_id)
      AND NOT EXISTS (SELECT 1 FROM runs WHERE batch_id = execution_batches.id AND project_id = execution_batches.project_id
        AND (purpose <> 'plan' OR status <> 'succeeded'))
      AND NOT EXISTS (SELECT 1 FROM run_dispatch_claims dc JOIN runs r ON r.id = dc.run_id AND r.project_id = dc.project_id
        WHERE r.batch_id = execution_batches.id AND dc.state <> 'released')`)
    .run(timestamp, batchId, projectId);
}
