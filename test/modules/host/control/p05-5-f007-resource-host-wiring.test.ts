import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, startHost, type HostClient } from '../../../../packages/host/src/index.ts';
import type { RunningHost } from '../../../../packages/host/src/runtime/index.ts';
import { createSqliteFeatureResourceAccess } from '../../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { openSlotFixture, type SlotFixture, SLOT_NOW } from '../../../helpers/p04-9/slot-fixture.ts';

let activeHost: RunningHost | undefined;
let activeClient: HostClient | undefined;
let activeFixture: SlotFixture | undefined;

afterEach(async () => {
  activeClient?.close();
  activeClient = undefined;
  await activeHost?.close();
  activeHost = undefined;
  activeFixture?.close();
  activeFixture = undefined;
});

describe('P05-5 F-007 execution resources Host wiring', () => {
  it('[case:host-resource-query] serves project-scoped resource pages through HostClient without exposing paths or changing rows', async () => {
    const fixture = await openSlotFixture();
    activeFixture = fixture;
    fixture.box.session.transactWrite('test.f007.host.reset-claims', () => {
      fixture.box.session.database.prepare('DELETE FROM run_dispatch_claims WHERE project_id = ?').run(fixture.projectId);
    });
    const host = await startHost({
      dataRoot: fixture.box.box.dataRoot,
      capabilityCatalog: fixture.box.box.capabilityCatalog,
      env: {},
    });
    activeHost = host;
    const client = await connectToHost({ canonicalRoot: fixture.box.box.dataRoot });
    activeClient = client;
    const token = readFileSync(join(fixture.box.box.dataRoot, 'host', 'auth.token'), 'utf8');
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    fixture.box.session.transactWrite('test.f007.host.seed-claim', () => {
      fixture.box.session.database.prepare(
        "INSERT INTO run_dispatch_claims (id, created_at, project_id, revision, updated_at, feature_id, run_id, claim_version, origin, owner_id, host_instance_id, acquired_at, lease_until, state) VALUES (?, ?, ?, 1, ?, ?, ?, 1, 'dispatch', ?, ?, ?, ?, 'held')",
      ).run(fixture.claimA, SLOT_NOW, fixture.projectId, SLOT_NOW, fixture.runA.featureId, fixture.runA.runId, 'owner-a', 'host-a', SLOT_NOW, SLOT_NOW + 60_000);
      const access = createSqliteFeatureResourceAccess(fixture.box.session, { nowUtcMs: () => SLOT_NOW });
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
    });
    const before = fixture.box.session.database.prepare('SELECT * FROM feature_resource_leases ORDER BY id').all();
    const first = await client.listExecutionResources(fixture.projectId, { featureId: fixture.runA.featureId, limit: 1 });
    expect(first.scope).toBe('execution-resources');
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ featureId: fixture.runA.featureId, ownerId: fixture.claimA, ownerVersion: 1, state: 'held' });
    expect(first.nextCursor).toMatch(/^plcur_v1_/);
    expect(JSON.stringify(first)).not.toContain(fixture.box.box.dataRoot);

    const second = await client.listExecutionResources(fixture.projectId, {
      featureId: fixture.runA.featureId,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
    expect(fixture.box.session.database.prepare('SELECT * FROM feature_resource_leases ORDER BY id').all()).toEqual(before);
  });
});
