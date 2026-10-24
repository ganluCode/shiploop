import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';

const NOW = 1_700_000_123_456;
const projectId = 'project-1';
const resourceSet = {
  projectId,
  resources: [
    { kind: 'contract', key: 'contract:core' },
    { kind: 'planning_exclusive', key: 'planning' },
  ],
};

async function openMigrated(version = SQLITE_MIGRATIONS.length) {
  const sandbox = createTempSandbox('shiploop-p055-f002-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db'), busyTimeoutMs: 2_000 });
  await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version), nowUtcMs: () => NOW });
  session.database.prepare(
    "INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES (?, ?, ?, 'Project', 'active', '[]')",
  ).run(projectId, NOW, NOW);
  return { sandbox, session };
}

describe('P05-5 F-002 feature resource SQLite access', () => {
  it('[case:migration-v40] upgrades a v39 database and keeps the resource schema in sync', async () => {
    const first = await openMigrated(39);
    try {
      first.session.database.prepare(
        'INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('legacy-project', NOW, NOW, 'Legacy', 'active', '[]');
      first.session.close();
      const reopened = openSqliteStorageSession({ path: join(first.sandbox.path, 'state.db') });
      try {
        const result = await migrateSqliteStorage(reopened, { nowUtcMs: () => NOW });
        expect(result.fromVersion).toBe(39);
        expect(result.toVersion).toBe(40);
        expect(reopened.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_resource_leases'").get()).toBeTruthy();
        expect(reopened.database.prepare('SELECT display_name FROM projects WHERE id = ?').get('legacy-project')).toEqual({ display_name: 'Legacy' });
      } finally {
        reopened.close();
      }
    } finally {
      first.sandbox.cleanup();
    }
  });

  it('[case:atomic-idempotent-conflict] claims a sorted set atomically and fences conflicts', async () => {
    const f = await openMigrated();
    try {
      const access = createSqliteFeatureResourceAccess(f.session, { nowUtcMs: () => NOW });
      const first = f.session.transactWrite('test.claim', () => access.acquireInTransaction({
        resourceSet,
        owner: { ownerId: 'owner-a', ownerVersion: 1 },
        leaseUntilUtcMs: NOW + 60_000,
      }));
      expect(first).toHaveLength(2);
      expect(first.map((row) => row.resource.key)).toEqual([
        `project:${projectId}:planning`,
        `project:${projectId}:contract:core`,
      ]);
      const replay = f.session.transactWrite('test.replay', () => access.acquireInTransaction({
        resourceSet,
        owner: { ownerId: 'owner-a', ownerVersion: 1 },
        leaseUntilUtcMs: NOW + 120_000,
      }));
      expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id));
      expect(replay.map((row) => row.leaseUntilUtcMs)).toEqual(first.map((row) => row.leaseUntilUtcMs));

      expect(() => f.session.transactWrite('test.conflict', () => access.acquireInTransaction({
        resourceSet,
        owner: { ownerId: 'owner-b', ownerVersion: 1 },
        leaseUntilUtcMs: NOW + 60_000,
      }))).toThrowError(StorageError);
      try {
        f.session.transactWrite('test.conflict-details', () => access.acquireInTransaction({
          resourceSet,
          owner: { ownerId: 'owner-b', ownerVersion: 1 },
          leaseUntilUtcMs: NOW + 60_000,
        }));
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).kind).toBe('conflict');
        expect((error as StorageError).details).toMatchObject({
          resourceKey: `project:${projectId}:planning`,
          waitReason: { code: 'resource_occupied', resourceKey: `project:${projectId}:planning`, blockingOwnerId: 'owner-a', blockingOwnerVersion: 1 },
        });
      }
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM feature_resource_leases').get()).toEqual({ count: 2 });
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });

  it('[case:shared-gate] shared Feature gate allows distinct owners but remains owner/version idempotent', async () => {
    const f = await openMigrated();
    try {
      const access = createSqliteFeatureResourceAccess(f.session, { nowUtcMs: () => NOW });
      const set = { projectId, resources: [{ kind: 'feature_code_shared', key: 'feature-code' }] };
      const a = f.session.transactWrite('test.shared-a', () => access.acquireInTransaction({ resourceSet: set, owner: { ownerId: 'owner-a', ownerVersion: 1 }, leaseUntilUtcMs: NOW + 60_000 }));
      const b = f.session.transactWrite('test.shared-b', () => access.acquireInTransaction({ resourceSet: set, owner: { ownerId: 'owner-b', ownerVersion: 1 }, leaseUntilUtcMs: NOW + 60_000 }));
      const replay = f.session.transactWrite('test.shared-replay', () => access.acquireInTransaction({ resourceSet: set, owner: { ownerId: 'owner-a', ownerVersion: 1 }, leaseUntilUtcMs: NOW + 120_000 }));
      expect(b).toHaveLength(1);
      expect(replay[0]!.id).toBe(a[0]!.id);
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM feature_resource_leases').get()).toEqual({ count: 2 });
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });  it('[case:cross-process-race] 两个独立 SQLite 连接并发认领同一资源时恰好一个成功', async () => {
    const f = await openMigrated();
    const environment = createIsolatedHostEnvironment();
    try {
      const input = (ownerId: string) => ({
        resourceSet: { projectId, resources: [{ kind: 'contract', key: 'contract:core' }] },
        owner: { ownerId, ownerVersion: 1 },
        leaseUntilUtcMs: NOW + 60_000,
      });
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p05-5/feature-resource-race-child.ts', import.meta.url)),
        configs: [
          { dbPath: f.session.path, now: NOW, input: input('owner-a') },
          { dbPath: f.session.path, now: NOW, input: input('owner-b') },
        ],
      });
      const winners = results.filter((result) => result.result.ok === true);
      const losers = results.filter((result) => result.result.ok === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.result).toMatchObject({ errorKind: 'conflict', reason: 'resource_occupied', resourceKey: `project:${projectId}:contract:core` });
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM feature_resource_leases').get()).toEqual({ count: 1 });
    } finally {
      await environment.dispose();
      f.session.close();
      f.sandbox.cleanup();
    }
  });
  it('[case:constraints-and-cas] rejects direct invalid writes and enforces revision/state fencing', async () => {
    const f = await openMigrated();
    try {
      const access = createSqliteFeatureResourceAccess(f.session, { nowUtcMs: () => NOW });
      const [lease] = f.session.transactWrite('test.claim', () => access.acquireInTransaction({
        resourceSet: { projectId, resources: [{ kind: 'contract', key: 'contract:core' }] },
        owner: { ownerId: 'owner-a', ownerVersion: 1 },
        leaseUntilUtcMs: NOW + 60_000,
      }));
      expect(() => f.session.database.prepare(
        "UPDATE feature_resource_leases SET owner_id = 'owner-b' WHERE id = ?",
      ).run(lease.id)).toThrow();
      expect(() => f.session.database.prepare(
        "UPDATE feature_resource_leases SET revision = revision WHERE id = ?",
      ).run(lease.id)).toThrow();
      expect(() => f.session.database.prepare(
        "UPDATE feature_resource_leases SET state = 'held', waiting_reason = '{\"code\":\"resource_occupied\"}' WHERE id = ?",
      ).run(lease.id)).toThrow();
      expect(() => f.session.database.prepare(
        "INSERT INTO feature_resource_leases (id, created_at, project_id, revision, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state) VALUES ('bad', ?, ?, 1, ?, 'project:other:planning', 'planning_exclusive', 'exclusive', 'lease', 'owner', 1, ?, ?, 'held')",
      ).run(NOW, projectId, NOW, NOW, NOW + 1)).toThrow();
    } finally {
      f.session.close();
      f.sandbox.cleanup();
    }
  });
});
