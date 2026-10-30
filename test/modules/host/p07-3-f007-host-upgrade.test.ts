import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as migrator from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import * as backupPackages from '../../../packages/core/src/adapters/sqlite/backup-package.ts';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { realStopProbe } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { computeBaselinePlanDigest } from '../../../packages/core/src/ports/baseline.ts';
import { initGitRepo } from '../../helpers/git-repo.ts';
import { startHost } from '../../../packages/host/src/runtime/host-startup.ts';
import { acquireWriterLock } from '../../../packages/host/src/locking/writer-lock.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const catalog = createStaticRuntimeCapabilityCatalog([]);
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });
async function seed(root: string, version: number, body = true) {
  const session = openSqliteStorageSession({ path: join(root, 'core.sqlite') });
  try {
    await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, version) });
    const bytes = Buffer.from('old project evidence');
    const hash = createHash('sha256').update(bytes).digest('hex');
    session.database.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES ('project-a', 1, 1, 'old project')").run();
    session.database.prepare("INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type, expected_hash, content_hash, size_bytes, storage_locator) VALUES ('artifact-a', 1, 1, 'project-a', 'document', 'ready', 'text/plain', ?, ?, ?, 'documents/a')").run(hash, hash, bytes.length);
    if (body) {
      const path = join(root, deriveArtifactFinalRelativePath({ projectId: 'project-a', artifactId: 'artifact-a' }));
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    }
  } finally { session.close(); }
}
function packages(root: string): string[] {
  const path = join(root, 'backups');
  return existsSync(path) ? readdirSync(path).filter(name => existsSync(join(path, name, 'manifest.json'))) : [];
}
function version(root: string): number {
  const db = new Database(join(root, 'core.sqlite'), { readonly: true });
  try { return Number((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v); } finally { db.close(); }
}

describe('F-007 default Host upgrade', () => {
  it('[case:old-schema-associated-backup] upgrades v1 with its body in a verified pre-upgrade package and does not back up again on reopen', async () => {
    const box = createTempSandbox('p07-3-upgrade-');
    try {
      await seed(box.path, 1);
      const host = await startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} });
      try { expect(host.lifecycleState).toBe('ready'); } finally { await host.close(); }
      expect(version(box.path)).toBe(SQLITE_MIGRATIONS.length);
      expect(packages(box.path)).toHaveLength(1);
      const pkg = join(box.path, 'backups', packages(box.path)[0]!);
      const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'));
      expect(manifest.database.schemaVersion).toBe(1);
      expect(readFileSync(join(pkg, 'artifacts/project-a/artifact-a'), 'utf8')).toBe('old project evidence');
      const oldDb = new Database(join(pkg, 'core.sqlite'), { readonly: true });
      try { expect(oldDb.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 }); } finally { oldDb.close(); }
      const reopened = await startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} });
      await reopened.close();
      expect(packages(box.path)).toHaveLength(1);
    } finally { box.cleanup(); }
  });

  it('[case:missing-body-blocks-upgrade] missing body preserves old schema and business rows, releases lock and never publishes discovery', async () => {
    const box = createTempSandbox('p07-3-upgrade-missing-');
    try {
      await seed(box.path, 1, false);
      let unexpected: Awaited<ReturnType<typeof startHost>> | undefined;
      try {
        await expect(startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} }).then(host => { unexpected = host; return host; })).rejects.toThrow();
      } finally { await unexpected?.close(); }
      expect(version(box.path)).toBe(1);
      expect(packages(box.path)).toEqual([]);
      expect(existsSync(join(box.path, 'host/discovery.json'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
    } finally { box.cleanup(); }
  });

  it.each([14, 18, 20, 31, 32, 49, 53, 54])('[case:old-schema-v%s] upgrades the real historical schema with no reads of future tables/columns', async oldVersion => {
    const box = createTempSandbox('p07-3-upgrade-compat-');
    try {
      await seed(box.path, oldVersion);
      const host = await startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} });
      await host.close();
      expect(version(box.path)).toBe(SQLITE_MIGRATIONS.length);
      expect(packages(box.path)).toHaveLength(1);
      const manifest = JSON.parse(readFileSync(join(box.path, 'backups', packages(box.path)[0]!, 'manifest.json'), 'utf8'));
      expect(manifest.database.schemaVersion).toBe(oldVersion);
      expect(manifest.projects[0].projectId).toBe('project-a');
    } finally { box.cleanup(); }
  });

  it('[case:empty-schema-no-backup] initializes an empty database without a pre-existing-data backup', async () => {
    const box = createTempSandbox('p07-3-upgrade-empty-');
    try {
      const db = new Database(join(box.path, 'core.sqlite')); db.close();
      const host = await startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} });
      await host.close();
      expect(version(box.path)).toBe(SQLITE_MIGRATIONS.length);
      expect(packages(box.path)).toEqual([]);
    } finally { box.cleanup(); }
  });

  it.each(['higher', 'checksum', 'unknown'] as const)('[case:readonly-reject-%s] rejects unrecognized schema before changing database bytes or journal mode', async kind => {
    const box = createTempSandbox('p07-3-upgrade-reject-');
    try {
      await seed(box.path, 1);
      const db = new Database(join(box.path, 'core.sqlite'));
      if (kind === 'higher') db.prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, 1, ?, ?, 1)').run('future', SQLITE_MIGRATIONS.length + 1, 'a'.repeat(64));
      if (kind === 'checksum') db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('a'.repeat(64));
      if (kind === 'unknown') db.exec('DROP TABLE schema_migrations');
      db.pragma('journal_mode = DELETE'); db.close();
      const before = readFileSync(join(box.path, 'core.sqlite'));
      await expect(startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} })).rejects.toMatchObject({ kind: kind === 'higher' ? 'unsupported_version' : 'corrupt' });
      expect(readFileSync(join(box.path, 'core.sqlite'))).toEqual(before);
      expect(packages(box.path)).toEqual([]);
      expect(existsSync(join(box.path, 'host/discovery.json'))).toBe(false);
      expect(existsSync(join(box.path, 'host/auth.token'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 }); lock.releaseAfterWritesClosed();
    } finally { box.cleanup(); }
  });

  it('[case:host-migration-failure] retains the pre-upgrade package and original rows without discovery, and releases the writer lock', async () => {
    const box = createTempSandbox('p07-3-host-upgrade-apply-');
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await seed(box.path, 54);
      const sql = 'CREATE TABLE partial_upgrade (id TEXT); INSERT INTO missing_table VALUES (1);';
      const bad = { version: 55, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      const original = migrator.migrateSqliteStorage;
      spy = vi.spyOn(migrator, 'migrateSqliteStorage').mockImplementationOnce(session => original(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 54), bad] }));
      await expect(startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} })).rejects.toMatchObject({ step: 'apply', fromVersion: 54, version: 55 });
      expect(version(box.path)).toBe(54);
      expect(packages(box.path)).toHaveLength(1);
      const db = new Database(join(box.path, 'core.sqlite'), { readonly: true });
      try {
        expect(db.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'old project' });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_upgrade'").all()).toEqual([]);
      } finally { db.close(); }
      expect(existsSync(join(box.path, 'host/discovery.json'))).toBe(false);
      expect(existsSync(join(box.path, 'host/auth.token'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 }); lock.releaseAfterWritesClosed();
    } finally { spy?.mockRestore(); box.cleanup(); }
  });

  it('[case:host-backup-recheck-failure] refuses a published package whose body fails independent verification while holding the writer lock', async () => {
    const box = createTempSandbox('p07-3-host-upgrade-backup-');
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await seed(box.path, 54);
      const original = backupPackages.createBackupPackageService;
      spy = vi.spyOn(backupPackages, 'createBackupPackageService').mockImplementationOnce(options => {
        const service = original(options);
        return { ...service, async create(input) {
          await expect(acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 })).rejects.toThrow();
          const result = await service.create(input);
          writeFileSync(join(result.packagePath, 'artifacts/project-a/artifact-a'), 'tampered');
          return result;
        } };
      });
      await expect(startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} })).rejects.toMatchObject({ step: 'backup', fromVersion: 54 });
      expect(version(box.path)).toBe(54);
      expect(existsSync(join(box.path, 'host/discovery.json'))).toBe(false);
      expect(existsSync(join(box.path, 'host/auth.token'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 }); lock.releaseAfterWritesClosed();
    } finally { spy?.mockRestore(); box.cleanup(); }
  });

  it('[case:orphan-writer-blocks-host] keeps the schema unchanged after the recorded parent exits while its real child writes, and upgrades only after group absence', async () => {
    const box = createTempSandbox('p07-3-upgrade-orphan-');
    const launchId = randomUUID();
    const parent = spawn(process.execPath, [fileURLToPath(new URL('../../helpers/storage/upgrade-writer.mjs', import.meta.url)), box.path, launchId], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(parent, 'exit');
    let groupId: number | undefined;
    try {
      const [ready] = await once(parent, 'message');
      groupId = Number(ready.groupId);
      const row = await realStopProbe.readSupervisorRow(groupId);
      expect(row).toBeTruthy();
      const processIdentity = { launchId, pid: groupId, processGroupId: groupId, startTime: row!.startTime };
      await seed(box.path, 4);
      const repository = join(box.path, 'external-repository');
      initGitRepo(repository);
      const inspected = await createRepositoryInspector().inspect(repository);
      const db = new Database(join(box.path, 'core.sqlite'));
      const operationId = randomUUID();
      const authorizationId = randomUUID();
      const plan = { checks: [{ checkKey: 'node-version', kind: 'command' as const, argv: ['node', '--version'], timeoutMs: 1000, required: true }] };
      const planDigest = computeBaselinePlanDigest(plan);
      db.prepare("INSERT INTO repository_bindings (id, created_at, updated_at, project_id, canonical_path, git_common_dir, repo_identity) VALUES ('binding', 1, 1, 'project-a', ?, ?, ?)").run(inspected.canonicalPath, inspected.gitCommonDir, inspected.repoIdentity);
      db.prepare("UPDATE projects SET repository_binding_id = 'binding' WHERE id = 'project-a'").run();
      db.prepare("INSERT INTO baseline_authorizations (id, created_at, project_id, repository_binding_id, working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by, authorized_at) VALUES (?, 1, 'project-a', 'binding', ?, 0, ?, ?, ?, 'owner', 1)").run(authorizationId, 'a'.repeat(64), planDigest, planDigest, JSON.stringify(plan));
      db.prepare("INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status, started_at, authorization_id) VALUES (?, 1, 1, 'project-a', 'baseline', 'running', 1, ?)").run(operationId, authorizationId);
      db.prepare("INSERT INTO baseline_occupancy (id, holder_operation_id, process_identity) VALUES ('global', ?, ?)").run(operationId, JSON.stringify(processIdentity));
      db.close();
      parent.send({ type: 'exit-parent' });
      await exited;
      expect(await realStopProbe.readSupervisorRow(groupId)).toBeNull();
      expect((await realStopProbe.listGroupMembers(groupId))!.length).toBeGreaterThan(0);
      expect(readFileSync(join(box.path, 'legacy-writes'), 'utf8').length).toBeGreaterThan(0);
      await expect(startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} })).rejects.toMatchObject({ details: { reason: 'process_group_active' } });
      expect(version(box.path)).toBe(4);
      expect(packages(box.path)).toEqual([]);
      expect(existsSync(join(box.path, 'host/discovery.json'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot: realpathSync(box.path), timeoutMs: 0 }); lock.releaseAfterWritesClosed();
      process.kill(-groupId, 'SIGTERM');
      await expect.poll(async () => (await realStopProbe.listGroupMembers(groupId!))?.length, { timeout: 5000 }).toBe(0);
      const host = await startHost({ dataRoot: box.path, capabilityCatalog: catalog, env: {} });
      await host.close();
      expect(version(box.path)).toBe(SQLITE_MIGRATIONS.length);
      expect(packages(box.path)).toHaveLength(1);
    } finally {
      if (groupId !== undefined) { try { process.kill(-groupId, 'SIGKILL'); } catch { /* already stopped */ } }
      else parent.kill('SIGKILL');
      await exited.catch(() => {});
      box.cleanup();
    }
  }, 15_000);
});
