import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import { validateStateEventWire } from '../../../packages/host/src/client/app-wire.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createProjectProfileService } from '../../../packages/core/src/application/project-profile-service.ts';
import { computeCapabilityModuleDigest, type ProjectProfileStore } from '../../../packages/core/src/ports/project-profile-store.ts';
import { createSqliteProjectProfileStore } from '../../../packages/core/src/adapters/sqlite/project-profile-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const PROJECT = '12345678-1234-4123-8234-1234567890ab';
const OTHER_PROJECT = '12345678-1234-4123-8234-1234567890cd';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const NOW = 1_700_500_000_000;

function moduleInput(projectId: string, id: string, version: string, dependencies: string[] = [], appliesTo = ['src']) {
  const module = {
    schemaVersion: 1 as const,
    id,
    version,
    scope: [`capability:${id}`],
    appliesTo,
    dependencies,
    contentRef: `artifact:${id}@${version}`,
    status: 'candidate' as const,
  };
  return { projectId, module, digest: computeCapabilityModuleDigest(module) };
}

function evidence() {
  return {
    schemaVersion: 1 as const,
    id: 'detect-node',
    detectorId: 'static-detector',
    detectorVersion: '1.0.0',
    source: 'package.json',
    summary: 'Node project detected',
    status: 'candidate' as const,
    confirmed: false,
  };
}

function candidate(projectId: string, version = 1) {
  return {
    profile: {
      schemaVersion: 1 as const,
      projectId,
      version,
      revision: `v${version}`,
      status: 'candidate' as const,
      modules: [{
        id: 'language-node', version: '1.0.0', roots: ['.'], languages: ['node'], frameworks: [],
        capabilityRefs: ['language-node@1.0.0'], checkRefs: [],
      }],
      documentRefs: [],
      detectionEvidenceRefs: ['detect-node'],
      confirmedBy: null,
    },
    evidence: [evidence()],
  };
}

async function setup(): Promise<{ cleanup: () => void; session: ReturnType<typeof openSqliteStorageSession>; store: ProjectProfileStore }> {
  const sandbox = createTempSandbox('shiploop-p06-profile-service-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  cleanups.push(() => { session.close(); sandbox.cleanup(); });
  await migrateSqliteStorage(session);
  session.database.prepare('INSERT INTO projects (id, created_at, updated_at, display_name) VALUES (?, ?, ?, ?)')
    .run(PROJECT, NOW, NOW, 'Profile service project');
  const store = createSqliteProjectProfileStore(session, { nowUtcMs: () => NOW });
  store.createCapabilityModules([
    moduleInput(PROJECT, 'language-node', '1.0.0', [], ['.']),
    moduleInput(PROJECT, 'test-vitest', '1.0.0', ['language-node@1.0.0']),
    moduleInput(PROJECT, 'tool-lint', '1.0.0', ['language-node@1.0.0']),
  ]);
  store.createProjectProfile(candidate(PROJECT));
  return { cleanup: sandbox.cleanup, session, store };
}

function snapshot(f: Awaited<ReturnType<typeof setup>>) {
  return {
    profiles: f.session.database.prepare('SELECT * FROM project_profiles ORDER BY version').all(),
    modules: f.session.database.prepare('SELECT * FROM capability_modules ORDER BY id').all(),
    events: f.session.database.prepare('SELECT * FROM state_events ORDER BY sequence').all(),
  };
}

const request = () => ({ projectId: PROJECT, expectedRevision: 1, profile: candidate(PROJECT).profile });

function ref(id: string, roots = ['src'], capabilityRefs = [`${id}@1.0.0`]) {
  return { id, version: '1.0.0', roots, languages: ['node'], frameworks: [], capabilityRefs, checkRefs: [] };
}

// Seed malformed persisted graphs: SQL constraints permit a graph assembled by an old/faulty writer.
function seedModule(f: Awaited<ReturnType<typeof setup>>, id: string, dependencies: string[]) {
  const input = moduleInput(PROJECT, id, '1.0.0', dependencies);
  f.session.database.prepare(`INSERT INTO capability_modules
    (id, created_at, project_id, revision, updated_at, schema_version, module_key, version, scope, applies_to, dependencies, content_ref, digest, status)
    VALUES (?, ?, ?, 1, ?, 1, ?, '1.0.0', '[]', '["src"]', ?, ?, ?, 'candidate')`)
    .run(randomUUID(), NOW, PROJECT, NOW, id, JSON.stringify(dependencies), input.module.contentRef, input.digest);
}

describe('P06-1 ProjectProfile application service', () => {
  it('[case:profile-composition] exposes the authorized service through production assembly without enabling a Runtime', async () => {
    const root = createTempSandbox('shiploop-p06-profile-assembly-');
    const owner = createLocalOwnerPrincipal();
    const options = { dataRoot: root.path, capabilityCatalog: { resolve: () => undefined } };
    try {
      const app = await openCoreApplication(options);
      let projectId: string;
      let saved;
      try {
        projectId = (await app.stateStore.createProject({ displayName: 'Profile assembly' })).id;
        const seed = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
        try {
          const store = createSqliteProjectProfileStore(seed);
          store.createCapabilityModule(moduleInput(projectId, 'language-node', '1.0.0', [], ['.']));
          store.createProjectProfile(candidate(projectId));
        } finally { seed.close(); }
        expect(app.projectProfileService.getCurrent(owner, projectId)).toBeNull();
        saved = app.projectProfileService.confirm(owner, { ...request(), projectId, profile: candidate(projectId).profile });
        expect(app.projectProfileService.matchTaskModules(owner, { projectId, directory: 'src' })).toMatchObject({ status: 'ready', profileVersion: 2 });
      } finally { app.close(); }
      const reopened = await openCoreApplication(options);
      try { expect(reopened.projectProfileService.getCurrent(owner, projectId!)).toEqual(saved); }
      finally { reopened.close(); }
    } finally { root.cleanup(); }
  });

  it('[case:profile-module-content-is-data] never grants module-declared powers and respects descriptor applicability', async () => {
    const f = await setup();
    const module = { ...moduleInput(PROJECT, 'untrusted-guidance', '1.0.0').module,
      scope: ['approval', 'execution.budget.revise', 'credential.read'], contentRef: 'artifact:untrusted-instructions' };
    f.store.createCapabilityModule({ projectId: PROJECT, module, digest: computeCapabilityModuleDigest(module) });
    const owner = createLocalOwnerPrincipal();
    const caps = [...owner.capabilities];
    const service = createProjectProfileService({ store: f.store });
    const saved = service.confirm(owner, { ...request(), profile: { ...request().profile, modules: [ref('untrusted-guidance', ['.'])] } });
    expect([...owner.capabilities]).toEqual(caps);
    expect(service.matchTaskModules(owner, { projectId: PROJECT, directory: 'docs' })).toMatchObject({ status: 'not_ready' });
    expect(service.matchTaskModules(owner, { projectId: PROJECT, directory: './src/unit/' })).toMatchObject({ status: 'ready' });
    const audit = JSON.stringify(f.session.database.prepare('SELECT payload FROM state_events').all());
    expect(audit).not.toContain(module.contentRef);
    expect(audit).not.toContain('credential.read');
    for (const table of ['approvals', 'execution_batches', 'tasks', 'attempts', 'project_settings']) {
      expect(f.session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(() => service.modify(owner, { projectId: PROJECT, expectedRevision: 2, profile: {
      ...saved.profile, modules: [{ ...saved.profile.modules[0], approval: true }],
    } })).toThrowError();
    expect(service.getCurrent(owner, PROJECT)).toEqual(saved);
  });
  it('[case:profile-authority-boundary] refuses cross-project/forged principals and privilege fields without changing state', async () => {
    const f = await setup();
    const service = createProjectProfileService({ store: f.store });
    const before = snapshot(f);
    const reader = { principalId: 'reader', capabilities: new Set(['project.read']), projectScope: { kind: 'all' } };
    const outsider = { principalId: 'outside', capabilities: new Set(['project.read', 'project.metadata.write']), projectScope: { kind: 'allowlist', projectIds: [OTHER_PROJECT] } };
    expect(() => service.confirm(reader, request())).toThrowError(PublicError);
    expect(() => service.confirm(outsider, request())).toThrowError(PublicError);
    expect(() => service.getCurrent(outsider, PROJECT)).toThrowError(PublicError);
    expect(() => service.matchTaskModules(outsider, { projectId: PROJECT, directory: 'src' })).toThrowError(PublicError);
    expect(() => service.confirm({ principalId: 'owner' }, request())).toThrowError(TypeError);
    const owner = createLocalOwnerPrincipal();
    for (const field of ['actorId', 'principal', 'approval', 'passes', 'budget', 'credentials', 'body']) {
      expect(() => service.confirm(owner, { ...request(), [field]: 'SYNTHETIC_SECRET' })).toThrowError();
    }
    expect(() => service.confirm(owner, { ...request(), profile: { ...request().profile, projectId: OTHER_PROJECT } })).toThrowError();
    expect(() => service.confirm(owner, { ...request(), profile: { ...request().profile, status: 'confirmed', confirmedBy: 'forged-actor' } })).toThrowError();
    expect(snapshot(f)).toEqual(before);
    expect(service.getCurrent(reader, PROJECT)).toBeNull();
    expect(service.matchTaskModules(reader, { projectId: PROJECT, directory: 'src' })).toMatchObject({ status: 'not_ready', reason: 'profile_not_confirmed' });
  });

  it('[case:profile-invalid-module-rollback] refuses unknown versions, missing dependencies, cycles and dangling evidence with no mutation', async () => {
    const f = await setup();
    seedModule(f, 'cycle-a', ['cycle-b@1.0.0']);
    seedModule(f, 'cycle-b', ['cycle-a@1.0.0']);
    const service = createProjectProfileService({ store: f.store });
    const owner = createLocalOwnerPrincipal();
    const before = snapshot(f);
    for (const modules of [
      [ref('missing')],
      [{ ...ref('language-node'), version: '9.0.0' }],
      [ref('test-vitest')],
      [ref('cycle-a'), ref('cycle-b')],
    ]) {
      expect(() => service.confirm(owner, { ...request(), profile: { ...request().profile, modules } })).toThrowError();
      expect(snapshot(f)).toEqual(before);
    }
    expect(() => service.confirm(owner, { ...request(), profile: { ...request().profile, detectionEvidenceRefs: ['missing-evidence'] } })).toThrowError();
    expect(snapshot(f)).toEqual(before);
  });

  it('[case:profile-audit-failure-reopen-cas] rolls back a failed audit, fences stale writes across connections and survives reopen', async () => {
    const f = await setup();
    const owner = createLocalOwnerPrincipal();
    const service = createProjectProfileService({ store: f.store });
    const before = snapshot(f);
    f.session.database.exec("CREATE TRIGGER reject_profile_audit BEFORE INSERT ON state_events WHEN NEW.aggregate_type = 'project_profile' BEGIN SELECT RAISE(ABORT, 'audit fault'); END");
    expect(() => service.confirm(owner, request())).toThrowError();
    expect(snapshot(f)).toEqual(before);
    f.session.database.exec('DROP TRIGGER reject_profile_audit');
    const other = openSqliteStorageSession({ path: f.session.path });
    try {
      const competing = createProjectProfileService({ store: createSqliteProjectProfileStore(other) });
      const committed = service.confirm(owner, request());
      expect(() => competing.confirm(owner, request())).toThrowError();
      const stable = snapshot(f);
      expect(() => createSqliteProjectProfileStore(other).updateProjectProfile(PROJECT, {
        profile: { ...committed.profile, version: 3 }, expectedRevision: 1, action: 'modified', actorId: owner.principalId,
      })).toThrowError();
      expect(snapshot(f)).toEqual(stable);
      f.session.close();
      expect(competing.getCurrent(owner, PROJECT)).toEqual(committed);
      expect(createSqliteProjectProfileStore(other).getProjectProfile(PROJECT, 1).detectionEvidence).toEqual([evidence()]);
    } finally { other.close(); }
  });

  it('[case:profile-manual-language] explicitly configures an unknown language without treating detector evidence as confirmation', async () => {
    const f = await setup();
    f.store.createCapabilityModule(moduleInput(PROJECT, 'custom-language', '1.0.0', [], ['custom']));
    const owner = createLocalOwnerPrincipal();
    const service = createProjectProfileService({ store: f.store });
    const manual = service.modify(owner, { ...request(), profile: {
      ...request().profile, modules: [{ ...ref('custom-language', ['custom']), languages: ['unknown-language'] }],
    } });
    expect(manual.profile).toMatchObject({ status: 'confirmed', confirmedBy: owner.principalId });
    expect(manual.detectionEvidence).toEqual([evidence()]);
    expect(service.matchTaskModules(owner, { projectId: PROJECT, directory: 'custom/source', requiredModuleIds: ['custom-language'] })).toMatchObject({
      status: 'ready', modules: [{ id: 'custom-language', version: '1.0.0' }],
    });
  });

  it('[case:profile-scope-and-dependency] refuses unknown scope and incomplete task dependency sets; directory unions are deterministic', async () => {
    const f = await setup();
    const owner = createLocalOwnerPrincipal();
    const service = createProjectProfileService({ store: f.store });
    service.confirm(owner, { ...request(), profile: { ...request().profile, modules: [
      ref('language-node', ['lib']), ref('test-vitest', ['src']),
    ] } });
    for (const directory of [null, 7, {}, '/etc', 'C:/secret', 'src/../etc', 'src\\etc']) {
      expect(() => service.matchTaskModules(owner, { projectId: PROJECT, directory })).toThrowError();
    }
    expect(service.matchTaskModules(owner, { projectId: PROJECT })).toMatchObject({ status: 'not_ready' });
    expect(service.matchTaskModules(owner, { projectId: PROJECT, directory: 'src' })).toMatchObject({ status: 'not_ready', reason: 'module_dependency_missing' });
    const selection = service.matchTaskModules(owner, { projectId: PROJECT, scope: ['src/unit', 'lib/core'] });
    expect(selection).toMatchObject({ status: 'ready', modules: [
      { id: 'language-node', version: '1.0.0' }, { id: 'test-vitest', version: '1.0.0' },
    ] });
    expect(service.matchTaskModules(owner, { projectId: PROJECT, scope: ['lib/core', 'src/unit', 'src/unit'] })).toEqual(selection);
  });
  it('[case:profile-decision-cas-audit] confirms, modifies and rejects immutable versions with CAS and redacted audit', async () => {
    const fixture = await setup();
    try {
      const service = createProjectProfileService({ store: fixture.store });
      const owner = createLocalOwnerPrincipal();
      const confirmed = service.confirm(owner, {
        projectId: PROJECT,
        expectedRevision: 1,
        profile: {
          ...candidate(PROJECT).profile,
          modules: [
            ...candidate(PROJECT).profile.modules,
            { id: 'test-vitest', version: '1.0.0', roots: ['src'], languages: ['node'], frameworks: ['vitest'], capabilityRefs: ['test-vitest@1.0.0'], checkRefs: ['test'] },
          ],
        },
      });
      expect(confirmed.profile).toMatchObject({ version: 2, status: 'confirmed', confirmedBy: owner.principalId });
      expect(service.getCurrent(owner, PROJECT)?.profile.version).toBe(2);

      const modified = service.modify(owner, {
        projectId: PROJECT,
        expectedRevision: 2,
        profile: {
          ...confirmed.profile,
          modules: [...confirmed.profile.modules, {
            id: 'tool-lint', version: '1.0.0', roots: ['src'], languages: ['node'], frameworks: [], capabilityRefs: ['tool-lint@1.0.0'], checkRefs: ['lint'],
          }],
        },
      });
      expect(modified.profile).toMatchObject({ version: 3, status: 'confirmed' });
      const rejected = service.reject(owner, { projectId: PROJECT, expectedRevision: 3 });
      expect(rejected.profile).toMatchObject({ version: 4, status: 'rejected', confirmedBy: null });
      expect(service.getCurrent(owner, PROJECT)?.profile.version).toBe(3);
      expect(fixture.store.listProjectProfiles(PROJECT).map((row) => row.profile.version)).toEqual([1, 2, 3, 4]);

      expect(() => service.modify(owner, {
        projectId: PROJECT,
        expectedRevision: 2,
        profile: confirmed.profile,
      })).toThrowError();
      expect(fixture.store.listProjectProfiles(PROJECT).map((row) => row.profile.version)).toEqual([1, 2, 3, 4]);

      const audit = fixture.session.database.prepare(
        "SELECT event_type, payload FROM state_events WHERE project_id = ? AND aggregate_type = 'project_profile' ORDER BY sequence",
      ).all(PROJECT) as { event_type: string; payload: string }[];
      expect(audit.map((row) => row.event_type)).toEqual([
        'project_profile.confirmed', 'project_profile.modified', 'project_profile.rejected',
      ]);
      expect(JSON.stringify(audit)).not.toContain('artifact:');
      expect(JSON.stringify(audit)).not.toContain('Node project detected');
      expect(fixture.store.getProjectProfile(PROJECT, 1)).toMatchObject({ detectionEvidence: [evidence()] });
      for (const row of fixture.session.database.prepare("SELECT * FROM state_events WHERE aggregate_type = 'project_profile'").all() as Record<string, unknown>[]) {
        const event = mapStateEvent({ id: row.id, sequence: row.sequence, eventType: row.event_type,
          aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
          projectId: row.project_id, payload: JSON.parse(row.payload as string), occurredAtUtcMs: row.occurred_at });
        expect(event.type).toBe(row.event_type);
        expect(validateStateEventWire(event)).toEqual(event);
        for (const extra of [{ token: 'SYNTHETIC_SECRET' }, { actorDigest: 'not-a-hash' }, { action: 'approve' }, { version: 999 }]) {
          expect(() => validateStateEventWire({ ...event, payload: { ...event.payload, ...extra } })).toThrowError();
        }
        expect(() => validateStateEventWire({ ...event, aggregate: { ...event.aggregate, revision: 999 } })).toThrowError();
        expect(() => mapStateEvent({ id: row.id, sequence: row.sequence, eventType: row.event_type,
          aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
          projectId: row.project_id, payload: { ...JSON.parse(row.payload as string), actorId: 'SYNTHETIC_SECRET' }, occurredAtUtcMs: row.occurred_at })).toThrowError();
      }
    } finally {
      fixture.session.close();
      fixture.cleanup();
    }
  });

  it('[case:profile-task-module-selection] returns deterministic versioned modules and explains not-ready requirements', async () => {
    const fixture = await setup();
    try {
      const service = createProjectProfileService({ store: fixture.store });
      const owner = createLocalOwnerPrincipal();
      service.confirm(owner, {
        projectId: PROJECT,
        expectedRevision: 1,
        profile: {
          ...candidate(PROJECT).profile,
          modules: [
            ...candidate(PROJECT).profile.modules,
            { id: 'test-vitest', version: '1.0.0', roots: ['src'], languages: ['node'], frameworks: ['vitest'], capabilityRefs: ['test-vitest@1.0.0'], checkRefs: ['test'] },
          ],
        },
      });
      const selected = service.matchTaskModules(owner, {
        projectId: PROJECT,
        directory: 'src/unit',
        requiredModuleIds: ['test-vitest'],
      });
      expect(selected.status).toBe('ready');
      expect(selected.modules.map((item) => `${item.id}@${item.version}`)).toEqual(['language-node@1.0.0', 'test-vitest@1.0.0']);
      expect(selected.modules.every((item) => item.reason.length > 0)).toBe(true);

      const missing = service.matchTaskModules(owner, {
        projectId: PROJECT,
        directory: 'docs',
        requiredModuleIds: ['test-vitest'],
      });
      expect(missing.status).toBe('not_ready');
      expect(missing.reason).toBe('required_module_not_applicable');
    } finally {
      fixture.session.close();
    }
  });
});
