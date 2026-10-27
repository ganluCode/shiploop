import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../../packages/core/src/ports/errors.ts';
import {
  createSqliteProjectProfileStore,
} from '../../../../packages/core/src/adapters/sqlite/project-profile-store.ts';
import { computeCapabilityModuleDigest } from '../../../../packages/core/src/ports/project-profile-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const PROJECT = 'project-profile-1';
const OTHER_PROJECT = 'project-profile-2';
const NOW = 1_700_400_000_000;
const HASH = 'ab'.repeat(32);

function evidence(id: string) {
  return {
    schemaVersion: 1,
    id,
    detectorId: 'static-detector',
    detectorVersion: '1.0.0',
    source: 'package.json',
    summary: 'detected node project',
    status: 'candidate' as const,
    confirmed: false,
  };
}

function moduleInput(projectId: string, id: string, version: string, dependencies: string[] = []) {
  const module = {
    schemaVersion: 1 as const,
    id,
    version,
    scope: ['language:node'],
    appliesTo: ['src'],
    dependencies,
    contentRef: `artifact:${id}@${version}`,
    status: 'candidate' as const,
  };
  return { projectId, module, digest: computeCapabilityModuleDigest(module) };
}

function profileInput(projectId: string, version: number, moduleId: string, moduleVersion: string) {
  return {
    profile: {
      schemaVersion: 1 as const,
      projectId,
      version,
      revision: `v${version}`,
      status: 'candidate' as const,
      modules: [{
        id: moduleId,
        version: moduleVersion,
        roots: ['.'],
        languages: ['node'],
        frameworks: [],
        capabilityRefs: [`${moduleId}@${moduleVersion}`],
        checkRefs: [],
      }],
      documentRefs: [],
      detectionEvidenceRefs: ['evidence-node'],
      confirmedBy: null,
    },
    evidence: [evidence('evidence-node')],
  };
}

async function withAsyncSandbox(fn: (root: string) => Promise<void>, prefix: string): Promise<void> {
  const sandbox = createTempSandbox(prefix);
  try {
    await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

async function migratedSession(root: string) {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  await migrateSqliteStorage(session);
  session.database.prepare('INSERT INTO projects (id, created_at, updated_at, display_name) VALUES (?, ?, ?, ?)')
    .run(PROJECT, NOW, NOW, 'Profile project');
  session.database.prepare('INSERT INTO projects (id, created_at, updated_at, display_name) VALUES (?, ?, ?, ?)')
    .run(OTHER_PROJECT, NOW, NOW, 'Other project');
  return session;
}

describe('P06-1 ProjectProfile SQLite store', () => {
  it('[case:profile-migration-v48] appends v48 and creates constrained profile/module tables', async () => {
    await withAsyncSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const before = SQLITE_MIGRATIONS.slice(0, 47);
        await migrateSqliteStorage(session, { migrations: before });
        const oldRows = session.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 48) });
        const tables = session.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_profiles', 'capability_modules') ORDER BY name").all() as { name: string }[];
        expect(tables.map((row) => row.name)).toEqual(['capability_modules', 'project_profiles']);
        expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 48 });
        expect(session.database.prepare('SELECT version, checksum FROM schema_migrations WHERE version < 48 ORDER BY version').all()).toEqual(oldRows);
        expect(session.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='project_profiles_project_version_unique'").get()).toBeDefined();
        expect(session.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='capability_modules_project_module_version_unique'").get()).toBeDefined();
      } finally {
        session.close();
      }
    }, 'shiploop-p06-profile-migration-');
  });

  it('[case:profile-reopen-and-version] persists immutable module/profile versions and detection evidence across reopen', async () => {
    await withAsyncSandbox(async (root) => {
      const first = await migratedSession(root);
      const store = createSqliteProjectProfileStore(first, { nowUtcMs: () => NOW });
      try {
        const module = store.createCapabilityModule(moduleInput(PROJECT, 'node', '1.0.0'));
        const profile = store.createProjectProfile(profileInput(PROJECT, 1, 'node', '1.0.0'));
        const secondProfile = store.createProjectProfile(profileInput(PROJECT, 2, 'node', '1.0.0'));
        expect(module.projectId).toBe(PROJECT);
        expect(profile.profile.version).toBe(1);
        expect(secondProfile.profile.version).toBe(2);
        expect(store.listProjectProfiles(PROJECT).map((item) => item.profile.version)).toEqual([1, 2]);
      } finally {
        first.close();
      }
      const reopened = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const store = createSqliteProjectProfileStore(reopened);
        expect(store.getProjectProfile(PROJECT, 1).profile.detectionEvidenceRefs).toEqual(['evidence-node']);
        expect(store.getCapabilityModule(PROJECT, 'node', '1.0.0').digest).toBe(computeCapabilityModuleDigest(moduleInput(PROJECT, 'node', '1.0.0').module));
      } finally {
        reopened.close();
      }
    }, 'shiploop-p06-profile-reopen-');
  });

  it('[case:profile-rejects-invalid-references] rejects duplicate versions, cross-project access, malformed persisted JSON and invalid module references atomically', async () => {
    await withAsyncSandbox(async (root) => {
      const session = await migratedSession(root);
      const store = createSqliteProjectProfileStore(session);
      try {
        store.createCapabilityModule(moduleInput(PROJECT, 'node', '1.0.0'));
        expect(() => store.createCapabilityModule(moduleInput(PROJECT, 'node', '1.0.0'))).toThrowError();
        expect(() => store.createProjectProfile(profileInput(PROJECT, 1, 'missing', '1.0.0'))).toThrowError();
        expect(() => store.getCapabilityModule(OTHER_PROJECT, 'node', '1.0.0')).toThrowError();
        expect(() => store.createProjectProfile({
          profile: { ...profileInput(PROJECT, 3, 'node', '1.0.0').profile, modules: [{
            ...profileInput(PROJECT, 3, 'node', '1.0.0').profile.modules[0],
            capabilityRefs: ['node@1.0.0', 'node@9.9.9'],
          }] },
          evidence: [evidence('evidence-node')],
        })).toThrowError();
        expect(session.database.prepare('SELECT COUNT(*) AS count FROM project_profiles').get()).toEqual({ count: 0 });
        session.database.prepare(`INSERT INTO project_profiles
          (id, created_at, project_id, revision, updated_at, schema_version, version, status, modules, document_refs, detection_refs, detection_evidence, confirmed_by, profile_digest)
          VALUES (?, ?, ?, 1, ?, 1, 3, 'candidate', '[]', '[]', '["evidence-node"]', '[{}]', NULL, ?)`)
          .run('corrupt-profile', NOW, PROJECT, NOW, HASH);
        const corrupt = store.getProjectProfile.bind(store, PROJECT, 3);
        expect(corrupt).toThrowError();
        expect(isStorageError(corruptError(corrupt), 'corrupt')).toBe(true);
        session.database.prepare(`INSERT INTO project_profiles
          (id, created_at, project_id, revision, updated_at, schema_version, version, profile_revision, status, modules, document_refs, detection_refs, detection_evidence, confirmed_by, profile_digest)
          VALUES (?, ?, ?, 1, ?, 99, 4, NULL, 'candidate', '[]', '[]', '[]', '[]', NULL, ?)`)
          .run('unknown-schema-profile', NOW, PROJECT, NOW, HASH);
        const unknownSchema = store.getProjectProfile.bind(store, PROJECT, 4);
        expect(unknownSchema).toThrowError();
        expect(isStorageError(corruptError(unknownSchema), 'corrupt')).toBe(true);
        session.database.prepare(`INSERT INTO project_profiles
          (id, created_at, project_id, revision, updated_at, schema_version, version, profile_revision, status, modules, document_refs, detection_refs, detection_evidence, confirmed_by, profile_digest)
          VALUES (?, ?, ?, 1, ?, 1, 5, NULL, 'candidate', '[]', '[]', '[]', '[]', NULL, ?)`)
          .run('bad-digest-profile', NOW, PROJECT, NOW, HASH);
        const badDigest = store.getProjectProfile.bind(store, PROJECT, 5);
        expect(badDigest).toThrowError();
        expect(isStorageError(corruptError(badDigest), 'corrupt')).toBe(true);
      } finally {
        session.close();
      }
    }, 'shiploop-p06-profile-invalid-');
  });

  it('[case:module-cycle-rejected] rejects circular capability dependencies without leaving a partial module', async () => {
    await withAsyncSandbox(async (root) => {
      const session = await migratedSession(root);
      const store = createSqliteProjectProfileStore(session);
      try {
        expect(() => store.createCapabilityModules([
          moduleInput(PROJECT, 'a', '1.0.0', ['b@1.0.0']),
          moduleInput(PROJECT, 'b', '1.0.0', ['a@1.0.0']),
        ])).toThrowError();
        expect(store.listCapabilityModules(PROJECT)).toEqual([]);
      } finally {
        session.close();
      }
    }, 'shiploop-p06-profile-cycle-');
  });
});

function corruptError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected corruption error');
}
