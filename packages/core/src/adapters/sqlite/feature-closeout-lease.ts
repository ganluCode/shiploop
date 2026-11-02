import type { FeatureCloseoutKey } from '../../ports/feature-closeout.js';
import type { DispatchSettlementClaimIdentity } from '../../ports/dispatch-settlement.js';
import { deriveFeatureDispatchResourceSet } from '../../ports/feature-resources.js';
import { StorageError } from '../../ports/errors.js';
import { stableStringify } from '../../ports/feature-plan.js';
import { isFinalizationOnlyRun } from '../../ports/finalization-execution.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteRunDispatchSettlement } from './dispatch-settlement.js';
import { createSqliteFeatureResourceAccess } from './feature-resources.js';
import type { SqliteStorageSession } from './session.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';

export interface FeatureCloseoutLease { readonly signal: AbortSignal }

/** Continues the same durable Run claim; never recreates a successful Task's leases. */
export function createSqliteFeatureCloseoutLease(session: SqliteStorageSession, options: {
  ownerId: string; hostInstanceId: string; nowUtcMs?: () => number; leaseMs?: number; heartbeatMs?: number;
}) {
  const now = options.nowUtcMs ?? Date.now;
  const leaseMs = options.leaseMs ?? 60_000, heartbeatMs = options.heartbeatMs ?? 15_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000
    || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0 || heartbeatMs >= leaseMs) throw new TypeError('invalid_closeout_lease_budget');
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: now });
  const dispatch = createSqliteRunDispatchSettlement(session, { nowUtcMs: now });
  const resources = createSqliteFeatureResourceAccess(session, { nowUtcMs: now });
  const tokens = new WeakMap<FeatureCloseoutLease, { key: FeatureCloseoutKey; expected: DispatchSettlementClaimIdentity; abort: AbortController }>();
  function fail(reason: string): never {
    throw new StorageError('conflict', 'FeatureCloseout.lease', 'Feature closeout resources unavailable', { details: { reason } });
  }
  function inspect(key: FeatureCloseoutKey, expected?: DispatchSettlementClaimIdentity, allowExpired = false, transaction?: CommandTransaction): DispatchSettlementClaimIdentity {
    const read = (tx: CommandTransaction) => {
      if (tx.getProject(key.projectId).status !== 'active') fail('closeout_project_not_active');
      const run = tx.getExecutionRun(key.projectId, key.runId);
      const batch = tx.getExecutionBatch(key.projectId, run.batchId);
      if (run.featureId !== key.featureId || !['queued', 'running'].includes(run.status)
        || !['queued', 'running'].includes(batch.status) || run.purpose === 'plan' || isFinalizationOnlyRun(run)) fail('closeout_run_not_active');
      const facts = dispatch.read({ projectId: key.projectId, runId: key.runId });
      const claim = facts.claim, slot = facts.slot;
      if (!claim || !slot || claim.state !== 'held' || slot.state !== 'held'
        || claim.projectId !== key.projectId || claim.runId !== key.runId || claim.featureId !== key.featureId
        || slot.projectId !== key.projectId || slot.runId !== key.runId || slot.featureId !== key.featureId
        || claim.ownerId !== options.ownerId || claim.hostInstanceId !== options.hostInstanceId
        || slot.claimId !== claim.id || slot.claimVersion !== claim.claimVersion
        || slot.ownerId !== options.ownerId || slot.hostInstanceId !== options.hostInstanceId) fail('closeout_claim_not_owned');
      if (expected && (claim.id !== expected.claimId || claim.claimVersion !== expected.claimVersion)) fail('closeout_claim_changed');
      if (facts.pauseRequested || facts.activeAttemptCount !== 0 || facts.retainedLeaseCount !== 0 || facts.stopUncertain) fail('closeout_writers_not_stopped');
      if (!allowExpired && (claim.leaseUntilUtcMs <= now() || slot.leaseUntilUtcMs <= now())) fail('closeout_lease_expired');
      const required = deriveFeatureDispatchResourceSet({ projectId: key.projectId, featureId: key.featureId, purpose: 'code', batch });
      const leases = resources.listOwnerInTransaction(key.projectId, { ownerId: claim.id, ownerVersion: claim.claimVersion });
      if (leases.length !== required.resources.length || required.resources.some(resource => !leases.some(lease =>
        lease.state === 'held' && (allowExpired || lease.leaseUntilUtcMs > now())
        && stableStringify(lease.resource) === stableStringify(resource)))) fail('closeout_feature_resource_missing');
      return { claimId: claim.id, claimVersion: claim.claimVersion, ownerId: claim.ownerId, hostInstanceId: claim.hostInstanceId };
    };
    return transaction ? read(transaction) : atomic.transact('FeatureCloseout.lease.read', read);
  }
  function data(token: FeatureCloseoutLease) {
    const value = tokens.get(token);
    if (!value || value.abort.signal.aborted) fail('closeout_lease_not_current');
    return value;
  }
  function assertCurrent(token: FeatureCloseoutLease, transaction?: CommandTransaction): void {
    const value = data(token);
    try { inspect(value.key, value.expected, false, transaction); }
    catch (error) { value.abort.abort(); throw error; }
  }
  function renew(token: FeatureCloseoutLease): void {
    const value = data(token);
    try {
      inspect(value.key, value.expected, true);
      const result = session.transactWrite('FeatureCloseout.lease.renew', () => {
        const facts = dispatch.read({ projectId: value.key.projectId, runId: value.key.runId });
        if (facts.activeAttemptCount !== 0 || facts.retainedLeaseCount !== 0 || facts.pauseRequested
          || facts.stopUncertain || !['queued', 'running'].includes(facts.runStatus)) fail('closeout_writers_not_stopped');
        // The immutable successful receipt anchors the SAME dispatch generation;
        // it grants no Task launch or Work-lease authority and is never revived.
        const anchor = session.database.prepare(`SELECT a.id,a.owner_id,a.host_instance_id,a.execution_version
          FROM attempts a JOIN task_claim_receipts t ON t.project_id=a.project_id AND t.attempt_id=a.id
          WHERE a.project_id=? AND a.run_id=? AND a.feature_id=? AND a.status='succeeded'
            AND a.owner_id=? AND a.host_instance_id=? AND json_valid(t.receipt)
            AND json_extract(t.receipt,'$.dispatch.claimId')=? AND json_extract(t.receipt,'$.dispatch.claimVersion')=?
          ORDER BY a.rowid DESC LIMIT 1`).get(value.key.projectId, value.key.runId, value.key.featureId,
            value.expected.ownerId, value.expected.hostInstanceId, value.expected.claimId, value.expected.claimVersion) as
              { id: string; owner_id: string; host_instance_id: string; execution_version: number } | undefined;
        if (!anchor) fail('closeout_dispatch_receipt_missing');
        return dispatch.renewInTransaction({ projectId: value.key.projectId, runId: value.key.runId,
          expected: value.expected, leaseUntilUtcMs: now() + leaseMs,
          attempt: { attemptId: anchor.id, executionVersion: anchor.execution_version,
            ownerId: anchor.owner_id, hostInstanceId: anchor.host_instance_id } });
      });
      if (result.decision === 'quarantined') fail('closeout_lease_quarantined');
      assertCurrent(token);
    } catch (error) { value.abort.abort(); throw error; }
  }
  return {
    assertCurrent, renew,
    async run<T>(key: FeatureCloseoutKey, callback: (token: FeatureCloseoutLease) => Promise<T>): Promise<T> {
      const expected = inspect(key);
      const abort = new AbortController(), token: FeatureCloseoutLease = Object.freeze({ signal: abort.signal });
      tokens.set(token, { key, expected, abort });
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        renew(token);
        if (heartbeatMs > 0) {
          timer = setInterval(() => { try { renew(token); } catch { /* signal aborts the supervised Verifier */ } }, heartbeatMs);
          timer.unref();
        }
        return await callback(token);
      } finally {
        if (timer) clearInterval(timer);
        // A timer or callback ending never proves external stop. Durable release
        // stays with the existing Run settlement after verification/completion.
        abort.abort(); tokens.delete(token);
      }
    },
  };
}
