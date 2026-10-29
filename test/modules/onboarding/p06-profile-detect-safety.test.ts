import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createProjectProfileInspector } from '../../../packages/core/src/adapters/fs/project-profile-inspector.ts';
import { createSqliteProjectProfileStore } from '../../../packages/core/src/adapters/sqlite/project-profile-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createProjectProfileDetectionService } from '../../../packages/core/src/application/project-profile-detection.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import { validateStateEventWire } from '../../../packages/host/src/client/app-wire.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = createLocalOwnerPrincipal();

async function setup(known = true) {
  const sandbox = createTempSandbox('shiploop-profile-safety-');
  cleanups.push(() => sandbox.cleanup());
  const repo = join(sandbox.path, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, known ? 'package.json' : 'unknown.xyz'), known ? '{"name":"fixture"}' : 'unknown');
  execFileSync('git', ['init', '-q', repo]);
  const app = await openCoreApplication({ dataRoot: join(sandbox.path, 'data'), capabilityCatalog: { resolve: () => undefined } });
  cleanups.push(() => app.close());
  const projectId = (await app.projectService.registerRepository({ repositoryPath: repo, displayName: 'Fixture' })).project.id;
  const db = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
  cleanups.push(() => db.close());
  const store = createSqliteProjectProfileStore(db);
  const envelope = () => ({ schemaVersion: 5, commandId: randomUUID(), operation: 'project.profile.detect',
    scope: { kind: 'project', projectId }, issuedAt: new Date().toISOString(), payload: {} });
  const facts = () => ({
    profiles: store.listProjectProfiles(projectId), modules: store.listCapabilityModules(projectId),
    events: db.database.prepare('SELECT * FROM state_events').all(),
    receipts: db.database.prepare('SELECT * FROM command_receipts').all(),
  });
  return { app, db, store, projectId, envelope, facts };
}

it('[case:profile-detect-authorization] rejects missing capability, hidden project and injected paths before inspection', async () => {
  const f = await setup();
  const before = f.facts();
  await expect(f.app.commandService.submit({ ...owner, capabilities: new Set(['project.read']) }, f.envelope()))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.app.commandService.submit({ ...owner, projectScope: { kind: 'allowlist', projectIds: [randomUUID()] } }, f.envelope()))
    .rejects.toMatchObject({ code: 'forbidden' });
  for (const payload of [{ path: '/etc' }, { principalId: 'local-owner' }, { profile: {} }]) {
    expect(() => validateCommandEnvelope({ ...f.envelope(), payload })).toThrow();
  }
  expect(f.facts()).toEqual(before);
});

it('[case:profile-detect-unknown] persists unknown languages only as unconfirmed manual configuration', async () => {
  const f = await setup(false);
  expect(await f.app.commandService.submit(owner, f.envelope())).toMatchObject({ status: 'completed' });
  expect(f.store.getProjectProfile(f.projectId).profile).toMatchObject({ version: 1, status: 'manual_configuration_required', confirmedBy: null, modules: [] });
  expect(f.app.projectProfileService.matchTaskModules(owner, { projectId: f.projectId, directory: '.' }))
    .toMatchObject({ status: 'not_ready' });
  const row = f.db.database.prepare("SELECT * FROM state_events WHERE event_type = 'project_profile.detected'")
    .get() as Record<string, unknown>;
  expect(row).toBeDefined();
  const event = mapStateEvent({ id: row.id, sequence: row.sequence, eventType: row.event_type,
    aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
    projectId: row.project_id, payload: JSON.parse(row.payload as string), occurredAtUtcMs: row.occurred_at });
  expect(() => validateStateEventWire(event)).not.toThrow();
});

it.each(['receipt', 'audit'])('[case:profile-detect-atomic-%s] rolls back candidate, modules, audit and receipt on write failure', async fault => {
  const f = await setup();
  const before = f.facts();
  // Separate connection trigger injects a genuine persistence failure in the default command assembly.
  f.db.database.exec(fault === 'receipt'
    ? `CREATE TRIGGER profile_detect_fault BEFORE INSERT ON command_receipts WHEN NEW.operation = 'project.profile.detect' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
    : `CREATE TRIGGER profile_detect_fault BEFORE INSERT ON state_events WHEN NEW.event_type = 'project_profile.detected' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  try { await expect(f.app.commandService.submit(owner, f.envelope())).rejects.toThrow(); }
  finally { f.db.database.exec('DROP TRIGGER profile_detect_fault'); }
  expect(f.facts()).toEqual(before);
  expect(await f.app.commandService.submit(owner, f.envelope())).toMatchObject({ status: 'completed' });
});

it('[case:profile-detect-race] rechecks binding and rejects stale or competing preparations', async () => {
  const f = await setup(); let current = true;
  const service = createProjectProfileDetectionService({ store: f.store, inspector: createProjectProfileInspector(),
    getBinding: id => f.app.stateStore.getRepositoryBinding(id), bindingIsCurrent: () => current });
  const first = await service.prepare(owner, f.projectId);
  const second = await service.prepare(owner, f.projectId);
  current = false;
  expect(() => service.commit(owner, first)).toThrow('绑定已变更');
  expect(f.store.listProjectProfiles(f.projectId)).toHaveLength(0);
  current = true;
  service.commit(owner, first);
  expect(() => service.commit(owner, second)).toThrow('不能覆盖');
  expect(f.store.listProjectProfiles(f.projectId)).toHaveLength(1);
});

it('[case:profile-detect-command-race] serializes competing command commits and replays the same identity', async () => {
  const f = await setup();
  const input = f.envelope();
  const replay = await Promise.all([f.app.commandService.submit(owner, input), f.app.commandService.submit(owner, input)]);
  expect(replay.map(result => result.replayed).sort()).toEqual([false, true]);
  expect(f.store.listProjectProfiles(f.projectId)).toHaveLength(1);
  const other = await setup();
  const competing = await Promise.allSettled([
    other.app.commandService.submit(owner, other.envelope()), other.app.commandService.submit(owner, other.envelope()),
  ]);
  expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(other.store.listProjectProfiles(other.projectId)).toHaveLength(1);
});
