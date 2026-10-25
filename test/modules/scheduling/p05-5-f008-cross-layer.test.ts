import { describe, expect, it } from 'vitest';
import { createSqliteRunDispatchSettlement } from '../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

type ClaimRow = {
  id: string;
  claim_version: number;
  owner_id: string;
  host_instance_id: string;
};

type AttemptRow = {
  id: string;
  execution_version: number;
  owner_id: string;
  host_instance_id: string;
};

function identities(f: Awaited<ReturnType<typeof openClaimFixture>>) {
  const claim = f.box.session.database.prepare(
    "SELECT id, claim_version, owner_id, host_instance_id FROM run_dispatch_claims WHERE state = 'held'",
  ).get() as ClaimRow;
  const attempt = f.box.session.database.prepare(
    'SELECT id, execution_version, owner_id, host_instance_id FROM attempts WHERE run_id = ?',
  ).get(f.ids.runId) as AttemptRow;
  return {
    expected: { claimId: claim.id, claimVersion: claim.claim_version, ownerId: claim.owner_id, hostInstanceId: claim.host_instance_id },
    attempt: { attemptId: attempt.id, executionVersion: attempt.execution_version, ownerId: attempt.owner_id, hostInstanceId: attempt.host_instance_id },
  };
}

describe('P05-5 F-008 cross-layer dispatch fencing', () => {
  it('[case:stop-uncertain-quarantines-feature-group] stop uncertainty quarantines Feature resources with claim and slot', async () => {
    const f = await openClaimFixture();
    try {
      f.store().claimTask(f.input());
      const attempt = f.box.session.database.prepare('SELECT id FROM attempts WHERE run_id = ?').get(f.ids.runId) as { id: string };
      f.box.session.database.prepare(
        "UPDATE attempts SET status = 'interrupted', ended_at = ?, execution_stage = 'runtime', revision = revision + 1 WHERE id = ?",
      ).run(NOW, attempt.id);
      f.box.session.database.prepare("UPDATE runs SET status = 'interrupted', revision = revision + 1 WHERE id = ?").run(f.ids.runId);

      const access = createSqliteRunDispatchSettlement(f.box.session, { nowUtcMs: () => NOW });
      const result = f.box.session.transactWrite('test.f008.stop-uncertain', () => access.settleInTransaction({
        projectId: f.ids.projectId,
        runId: f.ids.runId,
        ...identities(f),
      }));

      expect(result).toMatchObject({ decision: 'quarantined', reason: 'run_interrupted' });
      expect(f.box.session.database.prepare('SELECT DISTINCT state FROM feature_resource_leases').all())
        .toEqual([{ state: 'quarantined' }]);
      expect(f.box.session.database.prepare('SELECT state FROM execution_slot_claims').all())
        .toEqual([{ state: 'quarantined' }]);
      expect(f.box.session.database.prepare('SELECT state FROM run_dispatch_claims').all())
        .toEqual([{ state: 'quarantined' }]);
    } finally {
      f.box.close();
    }
  });

  it('[case:expired-renewal-quarantines-feature-group] expired dispatch renewal fences the complete resource group', async () => {
    const f = await openClaimFixture();
    try {
      f.store().claimTask(f.input());
      const identity = identities(f);
      const access = createSqliteRunDispatchSettlement(f.box.session, { nowUtcMs: () => NOW + 2_000 });
      const result = f.box.session.transactWrite('test.f008.expired-renewal', () => access.renewInTransaction({
        projectId: f.ids.projectId,
        runId: f.ids.runId,
        ...identity,
        leaseUntilUtcMs: NOW + 5_000,
      }));

      expect(result).toMatchObject({ decision: 'quarantined', reason: 'slot_lease_expired_unverified' });
      expect(f.box.session.database.prepare('SELECT DISTINCT state FROM feature_resource_leases').all())
        .toEqual([{ state: 'quarantined' }]);
      expect(f.box.session.database.prepare('SELECT state FROM execution_slot_claims').all())
        .toEqual([{ state: 'quarantined' }]);
      expect(f.box.session.database.prepare('SELECT state FROM run_dispatch_claims').all())
        .toEqual([{ state: 'quarantined' }]);
    } finally {
      f.box.close();
    }
  });
});
