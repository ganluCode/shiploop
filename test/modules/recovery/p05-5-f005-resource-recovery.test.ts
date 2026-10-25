import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_700_000_123_456;
const projectId = 'project-1';

async function openMigrated() {
  const sandbox = createTempSandbox('shiploop-p055-f005-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db'), busyTimeoutMs: 2_000 });
  await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS, nowUtcMs: () => NOW });
  session.database.prepare(
    "INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES (?, ?, ?, 'Project', 'active', '[]')",
  ).run(projectId, NOW, NOW);
  return { sandbox, session };
}

describe('P05-5 F-005 resource expiry recovery', () => {
  it('[case:feature-resource-expiry-quarantines-and-retains] expired Feature resources are quarantined as a group and cannot be reassigned', async () => {
    const f = await openMigrated();
    try {
      let now = NOW;
      const access = createSqliteFeatureResourceAccess(f.session, { nowUtcMs: () => now });
      const resourceSet = {
        projectId,
        resources: [
          { kind: 'contract', key: 'contract:core' },
          { kind: 'worktree', key: 'worktree:feature-1' },
        ],
      };
      const owner = { ownerId: 'dispatch-a', ownerVersion: 1 };
      f.session.transactWrite('test.f005.acquire', () => access.acquireInTransaction({
        resourceSet, owner, leaseUntilUtcMs: NOW + 1,
      }));

      now = NOW + 2;
      expect(f.session.transactWrite('test.f005.expire', () => access.expireInTransaction())).toBe(2);
      expect(f.session.database.prepare('SELECT state, waiting_reason FROM feature_resource_leases ORDER BY resource_key').all())
        .toEqual([
          { state: 'quarantined', waiting_reason: JSON.stringify({
            code: 'lease_expired_unverified', resourceKey: `project:${projectId}:contract:core`,
            blockingOwnerId: owner.ownerId, blockingOwnerVersion: owner.ownerVersion,
          }) },
          { state: 'quarantined', waiting_reason: JSON.stringify({
            code: 'lease_expired_unverified', resourceKey: `project:${projectId}:worktree:feature-1`,
            blockingOwnerId: owner.ownerId, blockingOwnerVersion: owner.ownerVersion,
          }) },
        ]);
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM feature_resource_leases').get()).toEqual({ count: 2 });
      expect(() => f.session.transactWrite('test.f005.reassign', () => access.acquireInTransaction({
        resourceSet, owner: { ownerId: 'dispatch-b', ownerVersion: 1 }, leaseUntilUtcMs: NOW + 60_000,
      }))).toThrowError(StorageError);
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM feature_resource_leases WHERE state = \'released\'').get())
        .toEqual({ count: 0 });
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });
  it('[case:startup-fence-retains-expired-dispatch-resources] startup fencing does not release an unstarted claim whose Feature resource already expired', async () => {
    const f = await openSlotFixture();
    try {
      const featureResources = createSqliteFeatureResourceAccess(f.box.session, { nowUtcMs: f.now });
      f.box.session.transactWrite('test.f005.dispatch-resource', () => featureResources.acquireInTransaction({
        resourceSet: { projectId: f.projectId, resources: [{ kind: 'contract', key: 'contract:recovery' }] },
        owner: { ownerId: f.claimA, ownerVersion: 1 },
        leaseUntilUtcMs: f.now() + 1,
      }));
      f.tick(2);

      const census = createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }).fence();

      expect(census.dispatchBlocked).toBe(true);
      expect(f.claimRows().find(row => row.id === f.claimA)).toMatchObject({ state: 'quarantined' });
      expect(f.box.session.database.prepare(
        'SELECT state, waiting_reason FROM feature_resource_leases WHERE owner_id = ?',
      ).get(f.claimA)).toMatchObject({ state: 'quarantined' });
      expect(f.box.session.database.prepare(
        'SELECT COUNT(*) AS count FROM feature_resource_leases WHERE owner_id = ?',
      ).get(f.claimA)).toEqual({ count: 1 });
    } finally {
      f.close();
    }
  });
});
