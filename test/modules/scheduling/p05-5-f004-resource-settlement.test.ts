import { describe, expect, it } from 'vitest';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { createSqliteRunDispatchSettlement } from '../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { validateFeatureResourceDeclaration } from '../../../packages/core/src/ports/feature-resources.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

type ClaimRow = {
  id: string;
  claim_version: number;
  state: string;
  owner_id: string;
  host_instance_id: string;
};

type AttemptRow = {
  id: string;
  execution_version: number;
  owner_id: string;
  host_instance_id: string;
};

function claimRow(f: Awaited<ReturnType<typeof openClaimFixture>>): ClaimRow {
  return f.box.session.database.prepare(
    "SELECT id, claim_version, state, owner_id, host_instance_id FROM run_dispatch_claims WHERE state IN ('held', 'quarantined')",
  ).get() as ClaimRow;
}

function attemptRow(f: Awaited<ReturnType<typeof openClaimFixture>>): AttemptRow {
  return f.box.session.database.prepare(
    'SELECT id, execution_version, owner_id, host_instance_id FROM attempts WHERE run_id = ?',
  ).get(f.ids.runId) as AttemptRow;
}

function expected(claim: ClaimRow) {
  return { claimId: claim.id, claimVersion: claim.claim_version, ownerId: claim.owner_id, hostInstanceId: claim.host_instance_id };
}

function attemptFence(attempt: AttemptRow) {
  return { attemptId: attempt.id, executionVersion: attempt.execution_version, ownerId: attempt.owner_id, hostInstanceId: attempt.host_instance_id };
}

function settle(f: Awaited<ReturnType<typeof openClaimFixture>>, input: Record<string, unknown>) {
  const access = createSqliteRunDispatchSettlement(f.box.session, { nowUtcMs: () => NOW });
  return f.box.session.transactWrite('test.f004.settle', () => access.settleInTransaction({
    projectId: f.box.projectId, runId: f.ids.runId, ...input,
  }));
}

describe('P05-5 F-004 resource settlement', () => {
  it('[case:dispatch-settlement-releases-feature-resources] normal stop settlement releases feature resources, slot and claim together', async () => {
    const f = await openClaimFixture();
    try {
      const receipt = f.store().claimTask(f.input());
      const claim = claimRow(f);
      const attempt = attemptRow(f);
      f.box.session.database.prepare("UPDATE attempts SET status = 'failed', ended_at = ?, revision = revision + 1 WHERE id = ?")
        .run(NOW, attempt.id);
      f.box.session.database.prepare('DELETE FROM workspace_leases').run();
      f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'user_pause', revision = revision + 1 WHERE id = ?")
        .run(f.ids.runId);

      expect(settle(f, { expected: expected(claim), attempt: attemptFence(attempt) }))
        .toMatchObject({ decision: 'released', changed: true });
      expect(f.box.session.database.prepare("SELECT state FROM feature_resource_leases ORDER BY resource_key").all())
        .toEqual([{ state: 'released' }, { state: 'released' }]);
      expect(f.box.session.database.prepare('SELECT state FROM execution_slot_claims').all()).toEqual([{ state: 'released' }]);
      expect(f.box.session.database.prepare('SELECT state FROM run_dispatch_claims').all()).toEqual([{ state: 'released' }]);
      expect(receipt.receipt.dispatch?.claimId).toBe(claim.id);
    } finally {
      f.box.close();
    }
  });

  it('[case:settlement-rollback-preserves-resource-group] feature resource release failure rolls back every dispatch fact', async () => {
    const f = await openClaimFixture();
    try {
      f.store().claimTask(f.input());
      const claim = claimRow(f);
      const attempt = attemptRow(f);
      f.box.session.database.prepare("UPDATE attempts SET status = 'failed', ended_at = ?, revision = revision + 1 WHERE id = ?")
        .run(NOW, attempt.id);
      f.box.session.database.prepare('DELETE FROM workspace_leases').run();
      f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'user_pause', revision = revision + 1 WHERE id = ?")
        .run(f.ids.runId);
      f.box.session.database.exec(`CREATE TRIGGER f004_fail_feature_release BEFORE UPDATE OF state ON feature_resource_leases
        WHEN NEW.state = 'released' AND OLD.resource_kind = 'worktree_write_exclusive'
        BEGIN SELECT RAISE(ABORT, 'f004_release_failure'); END`);

      expect(() => settle(f, { expected: expected(claim), attempt: attemptFence(attempt) })).toThrow('f004_release_failure');
      expect(f.box.session.database.prepare('SELECT state FROM feature_resource_leases ORDER BY resource_key').all())
        .toEqual([{ state: 'held' }, { state: 'held' }]);
      expect(f.box.session.database.prepare('SELECT state FROM execution_slot_claims').all()).toEqual([{ state: 'held' }]);
      expect(f.box.session.database.prepare('SELECT state FROM run_dispatch_claims').all()).toEqual([{ state: 'held' }]);
    } finally {
      f.box.close();
    }
  });

  it('[case:quarantined-resource-cannot-normal-release] quarantined feature resources reject normal release and retain the original owner', async () => {
    const f = await openClaimFixture();
    try {
      f.store().claimTask(f.input());
      const row = f.box.session.database.prepare(
        'SELECT project_id, resource_kind, resource_key FROM feature_resource_leases ORDER BY resource_key LIMIT 1',
      ).get() as { project_id: string; resource_kind: string; resource_key: string };
      const resource = validateFeatureResourceDeclaration({ projectId: row.project_id, kind: row.resource_kind, key: row.resource_key });
      const access = createSqliteFeatureResourceAccess(f.box.session, { nowUtcMs: () => NOW });
      const owner = { ownerId: claimRow(f).id, ownerVersion: claimRow(f).claim_version };
      f.box.session.transactWrite('test.f004.quarantine', () => access.quarantineInTransaction(owner, resource, {
        code: 'resource_quarantined', resourceKey: resource.key, blockingOwnerId: owner.ownerId, blockingOwnerVersion: owner.ownerVersion,
      }));

      expect(() => f.box.session.transactWrite('test.f004.release-quarantined', () => access.releaseInTransaction(owner, resource)))
        .toThrow();
      expect(f.box.session.database.prepare('SELECT state, owner_id, owner_version FROM feature_resource_leases WHERE resource_key = ?')
        .get(resource.key)).toMatchObject({ state: 'quarantined', owner_id: owner.ownerId, owner_version: owner.ownerVersion });
    } finally {
      f.box.close();
    }
  });
});
