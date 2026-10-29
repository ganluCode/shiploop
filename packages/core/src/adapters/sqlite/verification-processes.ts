import type { CommandProcessIdentity } from '../../ports/command-process.js';
import { validateWorkProcessIdentity } from '../../ports/work-resources.js';
import { StorageError } from '../../ports/errors.js';
import type { SqliteStorageSession } from './session.js';

/** All historical checks may have orphan descendants; completed results do not prove absence. */
export function readVerificationProcesses(session: SqliteStorageSession, projectId: string, attemptId: string): readonly CommandProcessIdentity[] {
  const rows = session.database.prepare<[string, string], { process_identity: string }>(`SELECT p.process_identity
    FROM verification_processes p JOIN verification_batches b ON b.id = p.batch_id
    WHERE b.project_id = ? AND b.attempt_id = ? ORDER BY p.batch_id, p.check_key LIMIT 257`).all(projectId, attemptId);
  try {
    if (rows.length > 256) throw new Error('limit');
    return rows.map(row => validateWorkProcessIdentity(JSON.parse(row.process_identity)));
  } catch {
    throw new StorageError('corrupt', 'VerificationStore.processes', 'Verifier process census is incomplete');
  }
}
