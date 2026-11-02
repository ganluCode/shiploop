import type { FeatureCloseoutKey, FeatureCloseoutRecord, FeatureCloseoutStore } from '../ports/feature-closeout.js';
import { FeatureCloseoutPreparationError } from '../ports/feature-closeout.js';
import { validateStableId } from '../ports/validation.js';

export interface FeatureCloseoutConsumers {
  /** Recheck approved plan/policy, Task gate, control state and manual holds. */
  authorize(key: FeatureCloseoutKey): Promise<{ allowed: boolean; reason: string }>;
  verify(key: FeatureCloseoutKey): Promise<{ passed: boolean; evidenceRef: string; reason: string }>;
  /** Owns persistent Runtime budget and stop confirmation; never edits Task metadata. */
  repair(key: FeatureCloseoutKey, ordinal: number): Promise<{ stopped: boolean; repaired: boolean }>;
  /** Must recheck code/evidence/approval and use the controlled Git operation service. */
  complete(key: FeatureCloseoutKey, evidenceRef: string): Promise<'completed' | 'blocked' | 'reconcile_required'>;
}

/** All side effects run outside store transactions, after a durable phase transition. */
export function createFeatureCloseoutCoordinator(options: {
  store: FeatureCloseoutStore;
  consumers: FeatureCloseoutConsumers;
  owner: string;
  maxRepairs?: number;
}) {
  const maxRepairs = options.maxRepairs ?? 0;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) throw new TypeError('invalid_closeout_repair_limit');
  const pending = new Map<string, { digest: string; promise: Promise<FeatureCloseoutRecord> }>();
  async function execute(key: FeatureCloseoutKey): Promise<FeatureCloseoutRecord> {
    let row = options.store.admit(key, options.owner, maxRepairs);
    // A different process may still own an external side effect. No lease timeout
    // authorizes stealing it: recovery must first establish durable stop evidence.
    if (row.owner !== options.owner) return row;
    while (row.stage === 'pending' || row.stage === 'verified') {
      const authority = await options.consumers.authorize(key);
      if (!authority.allowed) return options.store.transition(row, { stage: 'blocked', reason: authority.reason });
      if (row.stage === 'verified') {
        if (!row.evidenceRef) return options.store.transition(row, { stage: 'failed', reason: 'verification_evidence_missing' });
        row = options.store.transition(row, { stage: 'committing' });
        try {
          const stage = await options.consumers.complete(key, row.evidenceRef!);
          return options.store.transition(row, { stage });
        } catch {
          return options.store.transition(row, { stage: 'reconcile_required', reason: 'delivery_outcome_unknown' });
        }
      }
      row = options.store.transition(row, { stage: 'verifying' });
      let verified: Awaited<ReturnType<FeatureCloseoutConsumers['verify']>>;
      try { verified = await options.consumers.verify(key); }
      catch (error) { return options.store.transition(row, error instanceof FeatureCloseoutPreparationError
        ? { stage: 'blocked', reason: error.reason }
        : { stage: 'reconcile_required', reason: 'verification_outcome_unknown' }); }
      const after = await options.consumers.authorize(key);
      if (!after.allowed) return options.store.transition(row, { stage: 'blocked', reason: after.reason });
      try { validateStableId(verified.evidenceRef, { operation: 'FeatureCloseout' }, 'evidenceRef'); }
      catch { return options.store.transition(row, { stage: 'failed', reason: 'verification_evidence_missing' }); }
      if (verified.passed) {
        row = options.store.transition(row, { stage: 'verified', evidenceRef: verified.evidenceRef });
        continue;
      }
      if (row.repairCount >= row.maxRepairs) return options.store.transition(row, { stage: 'failed', reason: 'verification_failed' });
      row = options.store.transition(row, { stage: 'repairing', evidenceRef: verified.evidenceRef, reason: verified.reason });
      try {
        const repair = await options.consumers.repair(key, row.repairCount);
        if (!repair.stopped) return options.store.transition(row, { stage: 'reconcile_required', reason: 'repair_stop_unconfirmed' });
        if (!repair.repaired) return options.store.transition(row, { stage: 'failed', reason: 'repair_failed' });
      } catch { return options.store.transition(row, { stage: 'reconcile_required', reason: 'repair_outcome_unknown' }); }
      row = options.store.transition(row, { stage: 'pending', evidenceRef: null });
    }
    return row;
  }
  return {
    execute(key: FeatureCloseoutKey): Promise<FeatureCloseoutRecord> {
      const id = JSON.stringify([key.projectId, key.runId]);
      const active = pending.get(id);
      if (active) {
        if (active.digest !== key.inputDigest) return Promise.reject(new Error('closeout_identity_changed'));
        return active.promise;
      }
      const promise = execute(key).finally(() => { if (pending.get(id)?.promise === promise) pending.delete(id); });
      pending.set(id, { digest: key.inputDigest, promise });
      return promise;
    },
  };
}
