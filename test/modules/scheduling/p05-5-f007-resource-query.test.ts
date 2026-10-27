import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteExecutionControlQueryStore } from '../../../packages/core/src/adapters/sqlite/execution-control-query-store.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { openSlotFixture, type SlotFixture, SLOT_NOW } from '../../helpers/p04-9/slot-fixture.ts';

let active: SlotFixture | undefined;

afterEach(() => {
  active?.close();
  active = undefined;
});

describe('P05-5 F-007 execution resource query', () => {
  it('[case:resource-pagination-and-scope] lists active resources with owner fencing facts, filters by Feature, and keyset-paginates without writes', async () => {
    const fixture = await openSlotFixture();
    active = fixture;
    const access = createSqliteFeatureResourceAccess(fixture.box.session, { nowUtcMs: () => SLOT_NOW });
    fixture.box.session.transactWrite('test.f007.seed-resources', () => {
      access.acquireInTransaction({
        resourceSet: {
          projectId: fixture.projectId,
          resources: [
            { kind: 'worktree_write_exclusive', key: `worktree:${fixture.runA.featureId}` },
            { kind: 'contract', key: 'contract:f007' },
          ],
        },
        owner: { ownerId: fixture.claimA, ownerVersion: 1 },
        leaseUntilUtcMs: SLOT_NOW + 60_000,
      });
      access.acquireInTransaction({
        resourceSet: {
          projectId: fixture.projectId,
          resources: [{ kind: 'feature_code_shared', key: 'feature-code' }],
        },
        owner: { ownerId: fixture.claimB, ownerVersion: 1 },
        leaseUntilUtcMs: SLOT_NOW + 60_000,
      });
    });
    const before = fixture.box.session.database
      .prepare('SELECT * FROM feature_resource_leases ORDER BY id').all();
    const queries = createSqliteExecutionControlQueryStore(fixture.box.session);
    const first = queries.listFeatureResourceRecords(
      fixture.projectId,
      { after: null, limit: 1 },
      { featureId: fixture.runA.featureId },
    );
    expect(first.records).toHaveLength(1);
    expect([`project:${fixture.projectId}:worktree:${fixture.runA.featureId}`, `project:${fixture.projectId}:contract:f007`])
      .toContain(first.records[0]?.lease.resource.key);
    expect(first.records[0]?.lease).toMatchObject({
      ownerId: fixture.claimA,
      ownerVersion: 1,
      state: 'held',
    });
    expect(first.nextKey).not.toBeNull();

    const second = queries.listFeatureResourceRecords(
      fixture.projectId,
      { after: first.nextKey, limit: 1 },
      { featureId: fixture.runA.featureId },
    );
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.lease.resource.key).not.toBe(first.records[0]?.lease.resource.key);
    expect(second.nextKey).toBeNull();
    expect(fixture.box.session.database
      .prepare('SELECT * FROM feature_resource_leases ORDER BY id').all()).toEqual(before);
  });

  it('[case:quarantine-and-corrupt-json] exposes stop verification blocking and rejects corrupt waiting JSON', async () => {
    const fixture = await openSlotFixture();
    active = fixture;
    const access = createSqliteFeatureResourceAccess(fixture.box.session, { nowUtcMs: () => SLOT_NOW });
    fixture.box.session.transactWrite('test.f007.seed-quarantine', () => {
      access.acquireInTransaction({
        resourceSet: {
          projectId: fixture.projectId,
          resources: [{ kind: 'worktree_write_exclusive', key: `worktree:${fixture.runA.featureId}` }],
        },
        owner: { ownerId: fixture.claimA, ownerVersion: 1 },
        leaseUntilUtcMs: SLOT_NOW + 60_000,
      });
      access.quarantineOwnerInTransaction(fixture.projectId, { ownerId: fixture.claimA, ownerVersion: 1 }, {
        code: 'lease_expired_unverified',
      });
    });
    const queries = createSqliteExecutionControlQueryStore(fixture.box.session);
    const quarantined = queries.listFeatureResourceRecords(fixture.projectId, { after: null, limit: 50 }, { featureId: fixture.runA.featureId });
    expect(quarantined.records[0]?.lease).toMatchObject({ state: 'quarantined', waitingReason: { code: 'lease_expired_unverified' } });

    fixture.box.session.database.pragma('ignore_check_constraints = ON');
    fixture.box.session.database.prepare('UPDATE feature_resource_leases SET revision = revision + 1, waiting_reason = ? WHERE owner_id = ?').run('{', fixture.claimA);
    fixture.box.session.database.pragma('ignore_check_constraints = OFF');
    expect(() => queries.listFeatureResourceRecords(fixture.projectId, { after: null, limit: 50 }, { featureId: fixture.runA.featureId }))
      .toThrowError(StorageError);
  });
});
