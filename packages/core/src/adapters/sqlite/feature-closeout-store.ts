import type { FeatureCloseoutKey, FeatureCloseoutRecord, FeatureCloseoutStage, FeatureCloseoutStore } from '../../ports/feature-closeout.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

const operation = 'FeatureCloseout';
const allowed: Record<FeatureCloseoutStage, readonly FeatureCloseoutStage[]> = {
  pending: ['verifying', 'blocked', 'failed'],
  verifying: ['verified', 'repairing', 'failed', 'blocked', 'reconcile_required'],
  verified: ['committing', 'blocked', 'failed'],
  repairing: ['pending', 'failed', 'blocked', 'reconcile_required'],
  committing: ['completed', 'blocked', 'failed', 'reconcile_required'],
  completed: [], failed: [], blocked: [], reconcile_required: [],
};
function reject(reason: string): never {
  throw new StorageError('conflict', operation, 'Feature closeout transition rejected', { details: { reason } });
}
function decode(row: Record<string, unknown>): FeatureCloseoutRecord {
  return { projectId: row.project_id as string, runId: row.run_id as string, featureId: row.feature_id as string,
    inputDigest: row.input_digest as string, stage: row.stage as FeatureCloseoutStage, revision: row.revision as number,
    repairCount: row.repair_count as number, maxRepairs: row.max_repairs as number, owner: row.owner as string,
    evidenceRef: row.evidence_ref as string | null, reason: row.reason as string | null };
}
export function createSqliteFeatureCloseoutStore(session: SqliteStorageSession): FeatureCloseoutStore {
  const read = (projectId: string, runId: string) => {
    validateStableId(projectId, { operation }, 'projectId'); validateStableId(runId, { operation }, 'runId');
    const row = session.database.prepare('SELECT * FROM feature_closeouts WHERE project_id = ? AND run_id = ?').get(projectId, runId);
    return row ? decode(row as Record<string, unknown>) : null;
  };
  return {
    read,
    admit(key: FeatureCloseoutKey, owner: string, maxRepairs: number) {
      for (const field of ['projectId', 'runId', 'featureId'] as const) validateStableId(key[field], { operation }, field);
      validateStableId(owner, { operation }, 'owner');
      if (!/^[a-f0-9]{64}$/.test(key.inputDigest) || !Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) reject('invalid_closeout_input');
      return session.transactWrite(operation + '.admit', () => {
        const previous = read(key.projectId, key.runId);
        if (previous) {
          if (previous.featureId !== key.featureId || previous.inputDigest !== key.inputDigest || previous.maxRepairs !== maxRepairs) reject('closeout_identity_changed');
          return previous;
        }
        session.database.prepare(`INSERT INTO feature_closeouts
          (project_id,run_id,feature_id,input_digest,stage,revision,repair_count,max_repairs,owner)
          VALUES (?,?,?,?,'pending',1,0,?,?)`).run(key.projectId, key.runId, key.featureId, key.inputDigest, maxRepairs, owner);
        return read(key.projectId, key.runId)!;
      });
    },
    transition(current, change) {
      if (!allowed[current.stage]?.includes(change.stage)) reject('invalid_closeout_transition');
      if (change.stage === 'repairing' && current.repairCount >= current.maxRepairs) reject('repair_exhausted');
      if (change.reason != null && !/^[a-z][a-z0-9_.-]{0,127}$/.test(change.reason)) reject('invalid_reason');
      if (change.evidenceRef != null) validateStableId(change.evidenceRef, { operation }, 'evidenceRef');
      return session.transactWrite(operation + '.transition', () => {
        const result = session.database.prepare(`UPDATE feature_closeouts SET stage=?,revision=revision+1,
          repair_count=repair_count+?,evidence_ref=?,reason=?
          WHERE project_id=? AND run_id=? AND feature_id=? AND input_digest=? AND owner=? AND revision=? AND stage=?`).run(
          change.stage, change.stage === 'repairing' ? 1 : 0,
          change.evidenceRef === undefined ? current.evidenceRef : change.evidenceRef, change.reason ?? null,
          current.projectId, current.runId, current.featureId, current.inputDigest, current.owner, current.revision, current.stage);
        if (result.changes !== 1) reject('stale_closeout_receipt');
        return read(current.projectId, current.runId)!;
      });
    },
  };
}
