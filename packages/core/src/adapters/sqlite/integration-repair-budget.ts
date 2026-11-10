import type { SqliteStorageSession } from './session.js';
import { StorageError } from '../../ports/errors.js';

/** Outstanding and stopped repairs retain their full grant until a trusted refund policy exists. */
export function integrationRepairReservedTokens(session: SqliteStorageSession, projectId: string, batchId: string): number {
  if (!session.isOpen() || !session.database.inTransaction) throw new TypeError('Integration repair budget requires a transaction');
  const rows = session.database.prepare(`SELECT a.max_tokens FROM integration_repair_attempts a
    JOIN runs r ON r.project_id=a.project_id AND r.id=a.run_id WHERE a.project_id=? AND r.batch_id=?`)
    .all(projectId,batchId) as { max_tokens: number }[];
  let sum = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.max_tokens) || row.max_tokens < 1 || !Number.isSafeInteger(sum + row.max_tokens)) {
      throw new StorageError('corrupt','IntegrationRepairBudget','Invalid integration repair reservation');
    }
    sum += row.max_tokens;
  }
  return sum;
}
