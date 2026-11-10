import { StorageError } from '../../ports/errors.js';
import type Database from 'better-sqlite3';
import type { RunRecord } from '../../ports/execution-store.js';

/** Read only: pending authorization never substitutes its target SHA for a verified coding baseline. */
export function readRunExecutionBaseline(db: Database.Database, run: RunRecord): {
  repositoryBindingId: string; repositoryBindingRevision: number; baseCommit: string;
} | undefined {
  if (run.inputSnapshot.integrationAuthorization === undefined) return run.inputSnapshot.workspaceBaseline as ReturnType<typeof readRunExecutionBaseline>;
  const row = db.prepare(`SELECT repository_binding_id, binding_revision, base_commit, authorization_digest
    FROM run_execution_baselines WHERE project_id=? AND run_id=? AND feature_id=? AND batch_id=?`)
    .get(run.projectId, run.id, run.featureId, run.batchId) as {
      repository_binding_id: string; binding_revision: number; base_commit: string; authorization_digest: string;
    } | undefined;
  if (!row) return undefined;
  const auth = run.inputSnapshot.integrationAuthorization as { authorizationDigest?: unknown };
  if (row.authorization_digest !== auth.authorizationDigest || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.base_commit)) {
    throw new StorageError('corrupt', 'RunExecutionBaseline.read', 'Invalid frozen coding baseline');
  }
  return { repositoryBindingId: row.repository_binding_id, repositoryBindingRevision: row.binding_revision, baseCommit: row.base_commit };
}
