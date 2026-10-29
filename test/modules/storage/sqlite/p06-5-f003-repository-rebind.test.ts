import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteStateStore } from '../../../../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { mapStateEvent } from '../../../../packages/core/src/ports/events.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

async function withDatabase(fn: (path: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p065-f003-rebind-');
  try {
    const path = join(sandbox.path, 'state.db');
    const setup = openSqliteStorageSession({ path });
    try { await migrateSqliteStorage(setup); } finally { setup.close(); }
    await fn(path);
  } finally { sandbox.cleanup(); }
}

const binding = (canonicalPath: string, repoIdentity = 'gitdir-sha256:' + 'a'.repeat(64)) => ({
  canonicalPath,
  gitCommonDir: `${canonicalPath}/.git`,
  repoIdentity,
});

describe('P06-5 repository binding rebind CAS', () => {
  it('switches the project pointer while preserving old/new immutable facts and one audit event', async () => {
    await withDatabase(async path => {
      const session = openSqliteStorageSession({ path });
      try {
        const store = createSqliteStateStore(session, { nowUtcMs: () => 1_900_000_000_000 });
        const registered = await store.createProjectWithRepositoryBinding(
          { displayName: '移动项目' }, binding('/repo/old'),
        );
        const result = await store.rebindRepository(registered.project.id, {
          expectedRevision: 1, expectedBindingRevision: 1, expectedBindingId: registered.binding.id,
          ...binding('/repo/new', 'gitdir-sha256:' + 'b'.repeat(64)),
        });
        expect(result.previousBinding).toEqual(registered.binding);
        expect(result.binding).toMatchObject({
          projectId: registered.project.id, canonicalPath: '/repo/new', revision: 2, bindingRevision: 2,
        });
        expect(result.project.repositoryBindingId).toBe(result.binding.id);
        expect(result.project.revision).toBe(2);
        expect(result.snapshots.map(snapshot => snapshot.changeKind)).toEqual(['previous', 'current']);
        expect(await store.getRepositoryBinding(registered.project.id)).toEqual(result.binding);
        expect(await store.listRepositoryBindingSnapshots(registered.project.id)).toEqual(result.snapshots);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM repository_bindings').get()).toEqual({ n: 2 });
        const event = session.database.prepare('SELECT * FROM state_events').get() as Record<string, unknown>;
        expect(mapStateEvent({ id: event.id, sequence: event.sequence, eventType: event.event_type,
          aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, aggregateRevision: event.aggregate_revision,
          projectId: event.project_id, payload: JSON.parse(event.payload as string), occurredAtUtcMs: event.occurred_at })).toMatchObject({
          type: 'project.repository_rebound', payload: { rebound: true, bindingId: result.binding.id },
        });
      } finally { session.close(); }
    });
  });

  it('rejects stale, cross-project, and occupied-target requests without writes', async () => {
    await withDatabase(async path => {
      const session = openSqliteStorageSession({ path });
      try {
        const store = createSqliteStateStore(session);
        const a = await store.createProjectWithRepositoryBinding({ displayName: 'A' }, binding('/repo/a'));
        const b = await store.createProjectWithRepositoryBinding({ displayName: 'B' }, binding('/repo/b', 'gitdir-sha256:' + 'c'.repeat(64)));
        const before = session.database.prepare('SELECT COUNT(*) AS n FROM repository_bindings').get();
        await expect(store.rebindRepository(a.project.id, { expectedRevision: 9, ...binding('/repo/new') })).rejects.toMatchObject({ kind: 'conflict' });
        await expect(store.rebindRepository(a.project.id, { expectedRevision: 1, expectedBindingId: b.binding.id, ...binding('/repo/new') })).rejects.toMatchObject({ kind: 'conflict' });
        await expect(store.rebindRepository(a.project.id, { expectedRevision: 1, ...binding('/repo/b') })).rejects.toMatchObject({ kind: 'conflict' });
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM repository_bindings').get()).toEqual(before);
        expect((await store.getProject(a.project.id)).repositoryBindingId).toBe(a.binding.id);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM state_events').get()).toEqual({ n: 0 });
      } finally { session.close(); }
    });
  });

  it('rolls back the new binding, pointer, snapshots, and event when audit persistence fails', async () => {
    await withDatabase(async path => {
      const session = openSqliteStorageSession({ path });
      try {
        const store = createSqliteStateStore(session);
        const registered = await store.createProjectWithRepositoryBinding({ displayName: '故障回滚' }, binding('/repo/old'));
        session.database.exec("CREATE TEMP TRIGGER fail_rebind_event AFTER INSERT ON state_events WHEN NEW.event_type = 'project.repository_rebound' BEGIN SELECT RAISE(ABORT, 'injected rebind failure'); END");
        await expect(store.rebindRepository(registered.project.id, { expectedRevision: 1, ...binding('/repo/new', 'gitdir-sha256:' + 'd'.repeat(64)) })).rejects.toThrow('injected rebind failure');
        expect(await store.getRepositoryBinding(registered.project.id)).toEqual(registered.binding);
        expect((await store.getProject(registered.project.id)).repositoryBindingId).toBe(registered.binding.id);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM repository_bindings').get()).toEqual({ n: 1 });
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM repository_binding_snapshots').get()).toEqual({ n: 0 });
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM state_events').get()).toEqual({ n: 0 });
      } finally { session.close(); }
    });
  });
});
