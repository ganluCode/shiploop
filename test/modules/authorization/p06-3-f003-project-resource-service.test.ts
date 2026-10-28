import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import { validateStateEventWire } from '../../../packages/host/src/client/app-wire.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { describe, expect, it } from 'vitest';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createProjectResourceService } from '../../../packages/core/src/application/project-resource-service.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { resourceFixture, resourceManifest } from '../../helpers/p06-3-resource-fixture.ts';

const owner = createLocalOwnerPrincipal();
async function fixture() {
  const sandbox = createTempSandbox('shiploop-p063-f003-');
  const dbPath = join(sandbox.path, 'state.db');
  const session = openSqliteStorageSession({ path: dbPath });
  try {
    await migrateSqliteStorage(session);
    const state = createSqliteStateStore(session);
    const project = await state.createProject({ displayName: '资源项目' });
    const resources = resourceFixture(session, project.id, sandbox.path);
    const facts = () => ['project_settings', 'state_events'].map(table => session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    return { sandbox, dbPath, session, state, project, ...resources, facts,
      close() { session.close(); sandbox.cleanup(); } };
  } catch (error) { session.close(); sandbox.cleanup(); throw error; }
}

describe('P06-3 F-003 project resource configuration', () => {
  it('[case:persist] persists selected metadata in project settings, retains other settings and reopens', async () => {
    const f = await fixture();
    try {
      await f.state.createProjectSettings(f.project.id, { payload: { schemaVersion: 2, policies: { securityPolicy: { isolation: 'trusted_project' } } } });
      const imported = await f.service.select(owner, f.project.id, 1, await f.request());
      expect(imported.revision).toBe(2);
      expect(imported.resources).toHaveLength(1);
      expect(imported.resources[0]).toMatchObject({ version: '1.0.0', credentialRef: 'credential:local-login', enabled: true, status: 'active' });
      const settings = await f.state.getProjectSettings(f.project.id);
      expect(settings.payload.projectResources?.resources).toEqual(imported.resources);
      expect(settings.payload.policies).toEqual({ securityPolicy: { isolation: 'trusted_project' } });
      expect(settings.revision).toBe(imported.revision);
      const reopened = openSqliteStorageSession({ path: f.dbPath });
      try {
        const other = f.withStore((await import('../../../packages/core/src/adapters/sqlite/project-resource-store.ts')).createSqliteProjectResourceStore(reopened));
        expect(other.getConfiguration(owner, f.project.id)).toEqual(imported);
      } finally { reopened.close(); }
    } finally { f.close(); }
  });

  it('[case:idempotency] keeps identical imports unchanged and rejects same identity with a new version or digest', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      const first = await f.service.importCandidate(owner, f.project.id, 0, req);
      const before = f.facts();
      expect(await f.service.importCandidate(owner, f.project.id, 1, req)).toEqual(first);
      expect(f.facts()).toEqual(before);
      writeFileSync(f.path, JSON.stringify(resourceManifest('2.0.0')));
      await expect(f.service.importCandidate(owner, f.project.id, 1, await f.request())).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'resource_identity_conflict' } });
      const changed = resourceManifest();
      changed.resources[0]!.content.instructions = 'different bytes';
      writeFileSync(f.path, JSON.stringify(changed));
      await expect(f.service.importCandidate(owner, f.project.id, 1, await f.request())).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'resource_identity_conflict' } });
      expect(f.facts()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:source-errors] rejects unknown candidates, missing files, source drift and forged inputs without writes', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      const before = f.facts();
      await expect(f.service.importCandidate(owner, f.project.id, 0, { ...req, candidateId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'unknown_candidate' } });
      await expect(f.service.importCandidate(owner, f.project.id, 0, { ...req, sourceId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'unknown_source' } });
      await expect(f.service.importCandidate(owner, f.project.id, 0, { ...req, principal: 'local-owner' })).rejects.toMatchObject({ kind: 'validation' });
      writeFileSync(f.path, JSON.stringify(resourceManifest('2.0.0')));
      await expect(f.service.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'digest_mismatch' } });
      unlinkSync(f.path);
      await expect(f.service.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'source_missing' } });
      expect(f.facts()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:revoke-enable] enforces CAS, enable/disable and stable absent/repeated revocation errors', async () => {
    const f = await fixture();
    try {
      const imported = await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      const id = imported.resources[0]!.id;
      const before = f.facts();
      await expect(f.service.revoke(owner, f.project.id, 0, id)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'stale_revision' } });
      await expect(f.service.revoke(owner, f.project.id, 1, '33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'resource_not_found' } });
      expect(f.facts()).toEqual(before);
      expect((await f.service.disable(owner, f.project.id, 1, id)).revision).toBe(2);
      expect((await f.service.enable(owner, f.project.id, 2, id)).revision).toBe(3);
      const revoked = await f.service.revoke(owner, f.project.id, 3, id);
      expect(revoked).toMatchObject({ revision: 4, resources: [{ status: 'revoked', enabled: false }] });
      const after = f.facts();
      await expect(f.service.revoke(owner, f.project.id, 4, id)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'already_revoked' } });
      await expect(f.service.enable(owner, f.project.id, 4, id)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'resource_revoked' } });
      await expect(f.service.importCandidate(owner, f.project.id, 4, await f.request())).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'resource_revoked' } });
      expect(f.facts()).toEqual(after);
    } finally { f.close(); }
  });

  it('[case:principal] checks each mutation scope/capability and rejects requested privilege escalation', async () => {
    const f = await fixture();
    try {
      const writer = { principalId: 'agent-resource-writer', capabilities: new Set(['settings.project.write' as const, 'project.read' as const]), projectScope: { kind: 'allowlist' as const, projectIds: [f.project.id] } };
      const reader = { ...writer, capabilities: new Set(['project.read' as const]) };
      const other = await f.state.createProject({ displayName: '其他项目' });
      const req = await f.request();
      const imported = await f.service.importCandidate(writer, f.project.id, 0, req);
      const id = imported.resources[0]!.id;
      const before = f.facts();
      for (const principal of [reader, { ...writer, projectScope: { kind: 'allowlist' as const, projectIds: [other.id] } }]) {
        for (const call of [() => f.service.select(principal, f.project.id, 1, req), () => f.service.importCandidate(principal, f.project.id, 1, req), () => f.service.enable(principal, f.project.id, 1, id), () => f.service.disable(principal, f.project.id, 1, id), () => f.service.revoke(principal, f.project.id, 1, id)]) {
          await expect(call()).rejects.toMatchObject({ code: 'forbidden' });
        }
      }
      expect(() => f.service.getConfiguration(writer, other.id)).toThrow();
      for (const operation of ['owner', 'feature.plan.decide', 'task.passed', 'execution.budget.revise', 'workspace.discard', 'metadata.write']) {
        await expect(f.service.select(writer, f.project.id, 1, { ...req, operations: [operation] })).rejects.toMatchObject({ kind: 'validation' });
      }
      expect(f.facts()).toEqual(before);
      expect([...writer.capabilities]).toEqual(['settings.project.write', 'project.read']);
    } finally { f.close(); }
  });

  it('[case:post-io-recheck] rechecks permission and revision after candidate I/O before committing', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      const writer = { principalId: 'resource-writer', capabilities: new Set(['settings.project.write' as const]), projectScope: { kind: 'allowlist' as const, projectIds: [f.project.id] } };
      let readCount = 0;
      const service = createProjectResourceService({ store: f.store, sources: f.sources, sourceReader: { async read(source) {
        expect(f.session.database.inTransaction).toBe(false);
        const result = await f.reader.read(source);
        if (++readCount === 2) writer.capabilities.clear();
        return result;
      } } });
      await expect(service.importCandidate(writer, f.project.id, 0, req)).rejects.toMatchObject({ code: 'forbidden' });
      expect(f.facts()).toEqual([[], []]);
      let changed = false;
      const racing = createProjectResourceService({ store: f.store, sources: f.sources, sourceReader: { async read(source) {
        const result = await f.reader.read(source);
        if (!changed) { changed = true; await f.state.createProjectSettings(f.project.id, { payload: { schemaVersion: 2 } }); }
        return result;
      } } });
      await expect(racing.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'stale_revision' } });
      expect((await f.state.getProjectSettings(f.project.id)).revision).toBe(1);
      expect(f.service.getConfiguration(owner, f.project.id).resources).toEqual([]);
    } finally { f.close(); }
  });

  it('[case:immutability] freezes resource snapshots and only changes the next snapshot after revocation', async () => {
    const f = await fixture();
    try {
      const first = await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      const snapshot = f.service.snapshotForAttempt(owner, f.project.id);
      const bytes = JSON.stringify(snapshot);
      await f.service.revoke(owner, f.project.id, 1, first.resources[0]!.id);
      expect(JSON.stringify(snapshot)).toBe(bytes);
      expect(Object.isFrozen(snapshot.resources[0]?.capabilities)).toBe(true);
      expect(() => (snapshot.resources as unknown[]).pop()).toThrow();
      expect(f.service.snapshotForAttempt(owner, f.project.id).resources).toHaveLength(0);
      expect(snapshot.operations).not.toContain('feature.plan.decide');
    } finally { f.close(); }
  });

  it('[case:rollback] rolls back settings revision and all audit facts when the audit insert fails', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      f.session.database.exec("CREATE TRIGGER reject_resource_audit BEFORE INSERT ON state_events BEGIN SELECT RAISE(ABORT, 'audit fault'); END");
      await expect(f.service.importCandidate(owner, f.project.id, 0, req)).rejects.toThrow('audit fault');
      expect(f.facts()).toEqual([[], []]);
      f.session.database.exec('DROP TRIGGER reject_resource_audit');
      const first = await f.service.importCandidate(owner, f.project.id, 0, req);
      const before = f.facts();
      f.session.database.exec("CREATE TRIGGER reject_resource_audit BEFORE INSERT ON state_events BEGIN SELECT RAISE(ABORT, 'audit fault'); END");
      await expect(f.service.revoke(owner, f.project.id, 1, first.resources[0]!.id)).rejects.toThrow('audit fault');
      expect(f.facts()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:settings-boundary] rejects generic settings resource injection and preserves the section during ordinary settings edits', async () => {
    const f = await fixture();
    try {
      const first = await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      const settings = await f.state.getProjectSettings(f.project.id);
      const before = f.facts();
      await expect(f.state.updateProjectSettings(f.project.id, { expectedRevision: 1, payload: { ...settings.payload, projectResources: { ...settings.payload.projectResources, resources: [] } } })).rejects.toMatchObject({ kind: 'validation', details: { reason: 'resource_service_required' } });
      expect(f.facts()).toEqual(before);
      await f.state.updateProjectSettings(f.project.id, { expectedRevision: 1, payload: { schemaVersion: 2, policies: { securityPolicy: { isolation: 'trusted_project' } } } });
      expect(f.service.getConfiguration(owner, f.project.id)).toMatchObject({ revision: 2, resources: first.resources });
    } finally { f.close(); }
  });

  it('[case:invalid-manifest] rejects unknown versions and plaintext secrets, and revalidates files before enabling', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      const raw = readFileSync(f.path);
      writeFileSync(f.path, JSON.stringify({ ...resourceManifest(), schemaVersion: 99 }));
      await expect(f.service.importCandidate(owner, f.project.id, 0, { ...req,
        sourceDigest: createHash('sha256').update(readFileSync(f.path)).digest('hex'),
      })).rejects.toMatchObject({ kind: 'validation', details: { reason: 'unsupported_schema_version' } });
      const manifest = resourceManifest();
      manifest.resources[0]!.credentialRef = 'sk-live-SYNTHETIC-ONLY';
      writeFileSync(f.path, JSON.stringify(manifest));
      await expect(f.service.importCandidate(owner, f.project.id, 0, { ...req,
        sourceDigest: createHash('sha256').update(readFileSync(f.path)).digest('hex'),
      })).rejects.toMatchObject({ kind: 'validation', details: { reason: 'plaintext_credential' } });
      expect(f.facts()).toEqual([[], []]);
      writeFileSync(f.path, raw);
      const first = await f.service.importCandidate(owner, f.project.id, 0, req);
      const id = first.resources[0]!.id;
      await f.service.disable(owner, f.project.id, 1, id);
      unlinkSync(f.path);
      const before = f.facts();
      await expect(f.service.enable(owner, f.project.id, 2, id)).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'source_missing' } });
      expect(f.facts()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:process-cas] allows exactly one concurrent process to import at the same SQLite revision', async () => {
    const f = await fixture();
    const environment = createIsolatedHostEnvironment();
    try {
      const req = await f.request();
      const config = { dbPath: f.dbPath, projectId: f.project.id, expectedRevision: 0,
        source: { ...f.source, projectId: f.project.id }, request: req };
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p06-3-resource-race-child.ts', import.meta.url)),
        configs: [config, config],
      });
      expect(results.filter(r => r.result.ok === true)).toHaveLength(1);
      expect(results.filter(r => r.result.ok === false).map(r => r.result)).toMatchObject([
        { errorKind: 'conflict', reason: 'stale_revision' },
      ]);
      expect(results.every(r => r.exit.code === 0)).toBe(true);
      const configuration = f.service.getConfiguration(owner, f.project.id);
      expect(configuration).toMatchObject({ revision: 1, resources: [{ id: req.candidateId }] });
      expect(f.facts().map(rows => rows.length)).toEqual([1, 1]);
    } finally { await environment.dispose(); f.close(); }
  });

  it('[case:inflight-attempt] leaves an existing claimed Attempt input and all execution facts unchanged', async () => {
    const active = await openClaimFixture();
    try {
      const claimed = active.store().claimTask(active.input());
      expect(claimed.receipt.attempt.status).toBe('preparing');
      const resources = resourceFixture(active.box.session, active.ids.projectId, active.box.box.root);
      const executionFacts = () => ['attempts', 'runs', 'execution_batches', 'tasks', 'task_attempt_reservations', 'workspace_leases']
        .map(table => active.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      const before = executionFacts();
      const revision = resources.service.getConfiguration(owner, active.ids.projectId).revision;
      const imported = await resources.service.importCandidate(owner, active.ids.projectId, revision, await resources.request());
      const snapshot = resources.service.snapshotForAttempt(owner, active.ids.projectId);
      await resources.service.revoke(owner, active.ids.projectId, imported.revision, imported.resources[0]!.id);
      expect(executionFacts()).toEqual(before);
      expect(snapshot.resources).toHaveLength(1);
      expect(resources.service.snapshotForAttempt(owner, active.ids.projectId).resources).toEqual([]);
    } finally { active.box.close(); }
  });

  it('[case:audit-wire] maps resource summary audit through Core and HostClient and rejects unknown or secret fields', async () => {
    const f = await fixture();
    try {
      await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      const row = f.session.database.prepare(`SELECT id, sequence, event_type AS eventType, aggregate_type AS aggregateType,
        aggregate_id AS aggregateId, aggregate_revision AS aggregateRevision, project_id AS projectId,
        payload, occurred_at AS occurredAtUtcMs FROM state_events ORDER BY sequence LIMIT 1`).get() as Record<string, unknown>;
      row.payload = JSON.parse(String(row.payload));
      const event = mapStateEvent(row);
      expect(event.payload).toMatchObject({ resources: { count: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
      expect(validateStateEventWire(event)).toEqual(event);
      expect(JSON.stringify(event)).not.toContain('credential:local-login');
      expect(JSON.stringify(event)).not.toContain(f.path);
      const bad = { ...event.payload, resources: { count: 1, digest: 'a'.repeat(64), secret: 'SYNTHETIC' } };
      expect(() => mapStateEvent({ ...row, payload: bad })).toThrow();
      expect(() => validateStateEventWire({ ...event, payload: bad })).toThrow();
    } finally { f.close(); }
  });

  it('[case:source-scope-drift] rejects a cross-project source and a source changed during the commit recheck', async () => {
    const f = await fixture();
    try {
      const req = await f.request();
      const foreign = createProjectResourceService({ store: f.store, sourceReader: f.reader,
        sources: { getSource: () => ({ ...f.source, projectId: '33333333-3333-4333-8333-333333333333' }) } });
      await expect(foreign.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'ownership', details: { reason: 'cross_project_reference' } });
      const pinned = createProjectResourceService({ store: f.store, sourceReader: f.reader,
        sources: { getSource: () => ({ ...f.source, projectId: f.project.id, expectedDigest: 'c'.repeat(64) }) } });
      await expect(pinned.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'digest_mismatch' } });
      let reads = 0;
      const drifting = createProjectResourceService({ store: f.store, sources: f.sources, sourceReader: { async read(source) {
        expect(f.session.database.inTransaction).toBe(false);
        if (++reads === 2) writeFileSync(f.path, JSON.stringify(resourceManifest('2.0.0')));
        return f.reader.read(source);
      } } });
      await expect(drifting.importCandidate(owner, f.project.id, 0, req)).rejects.toMatchObject({ kind: 'conflict', details: { reason: 'digest_mismatch' } });
      expect(f.facts()).toEqual([[], []]);
    } finally { f.close(); }
  });

  it('[case:assembly] exposes the service through Core composition and denies unconfigured source directories', async () => {
    const sandbox = createTempSandbox('shiploop-resource-assembly-');
    let app: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
    try {
      const capabilityCatalog = createStaticRuntimeCapabilityCatalog([]);
      app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog });
      const project = await app.stateStore.createProject({ displayName: '组合资源项目' });
      const fixtureSession = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
      const resources = resourceFixture(fixtureSession, project.id, sandbox.path);
      const req = await resources.request().finally(() => fixtureSession.close());
      await expect(app.projectResourceService.importCandidate(owner, project.id, 0, req)).rejects.toMatchObject({ kind: 'not_found', details: { reason: 'unknown_source' } });
      app.close();
      app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog, projectResourceSources: resources.sources });
      const imported = await app.projectResourceService.importCandidate(owner, project.id, 0, req);
      expect(imported.revision).toBe(1);
      const settings = await app.stateStore.getProjectSettings(project.id);
      await expect(app.commandService.submit(owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
        operation: 'settings.project.update', scope: { kind: 'project', projectId: project.id }, expectedRevision: 1,
        payload: { ...settings.payload, projectResources: { ...settings.payload.projectResources, resources: [] } },
      })).rejects.toMatchObject({ code: 'invalid_input' });
      expect(app.projectResourceService.list(owner, project.id)).toEqual(imported);
      await expect(app.configurationService.updateSettings({ kind: 'project', projectId: project.id }, {
        expectedRevision: 1, payload: settings.payload,
      })).rejects.toMatchObject({ kind: 'validation', details: { reason: 'resource_service_required' } });
      app.close();
      app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog });
      expect(app.projectResourceService.list(owner, project.id)).toEqual(imported);
    } finally { app?.close(); sandbox.cleanup(); }
  });

  it('[case:stored-corruption] rejects unknown versions, wrong project, duplicate identities and damaged digests on read', async () => {
    const f = await fixture();
    try {
      await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      const valid = (await f.state.getProjectSettings(f.project.id)).payload;
      const section = valid.projectResources!;
      const malformed = [
        { ...section, schemaVersion: 99 },
        { ...section, projectId: '33333333-3333-4333-8333-333333333333' },
        { ...section, resources: [...section.resources, ...section.resources] },
        { ...section, resources: [{ ...section.resources[0], candidateDigest: 'b'.repeat(64) }] },
        { ...section, resources: [{ ...section.resources[0], status: 'revoked', enabled: true }] },
        { ...section, resources: [{ ...section.resources[0], token: 'SYNTHETIC' }] },
      ];
      for (const projectResources of malformed) {
        f.session.database.prepare('UPDATE project_settings SET payload = ? WHERE project_id = ?')
          .run(JSON.stringify({ ...valid, projectResources }), f.project.id);
        expect(() => f.service.getConfiguration(owner, f.project.id)).toThrowError(expect.objectContaining({ kind: 'corrupt' }));
      }
    } finally { f.close(); }
  });

  it('[case:checksum-fk] leaves historical checksums unchanged and retains project settings foreign keys', async () => {
    const f = await fixture();
    try {
      const before = f.session.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      await f.service.importCandidate(owner, f.project.id, 0, await f.request());
      expect(f.session.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()).toEqual(before);
      expect(before).toEqual(SQLITE_MIGRATIONS.map(({ version, checksum }) => ({ version, checksum })));
      expect(f.session.database.pragma('foreign_key_check')).toEqual([]);
      expect(() => f.session.database.prepare('DELETE FROM projects WHERE id = ?').run(f.project.id)).toThrow();
    } finally { f.close(); }
  });
});
