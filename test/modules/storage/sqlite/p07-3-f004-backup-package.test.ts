import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteMaintenanceWriteGate } from '../../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createBackupPackageService } from '../../../../packages/core/src/adapters/sqlite/backup-package.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_800_000_000_000;
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const box = createTempSandbox('shiploop-p07-3-f004-');
  try { return await fn(box.path); } finally { box.cleanup(); }
}

function seedArtifact(root: string, projectId: string, artifactId: string, body: Uint8Array, status = 'ready'): void {
  const relative = deriveArtifactFinalRelativePath({ projectId, artifactId });
  const path = join(root, ...relative.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  if (status === 'ready') writeFileSync(path, body);
}

describe('P07-3 F-004 complete backup package', () => {
  it('[case:package-closure-and-snapshot] publishes a manifest bound to the SQLite snapshot and copies only referenced artifact bodies', async () => {
    await withFixture(async root => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session);
        const body = new TextEncoder().encode('project-a body');
        const contentHash = hash(body);
        session.transactWrite('fixture.seed', db => {
          db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]'), ('project-b', ?, 1, ?, 'B', 'active', '[]')").run(NOW, NOW, NOW, NOW);
          db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('artifact-a', ?, 'project-a', 1, ?, 'document', 'ready', 'text/plain', ?, ?, ?, 1, 'documents/a.txt', NULL)").run(NOW, NOW, contentHash, contentHash, body.byteLength);
        });
        seedArtifact(root, 'project-a', 'artifact-a', body);
        const service = createBackupPackageService({
          session,
          dataRoot: root,
          backupRoot: join(root, 'backups'),
          files: createArtifactFileStore({ dataRoot: root }),
          maintenanceGate: createSqliteMaintenanceWriteGate(session),
          nowUtcMs: () => NOW,
        });

        const result = await service.create({ backupId: 'backup-1', owner: 'owner-1', hostInstanceId: 'host-1' });
        const manifest = JSON.parse(readFileSync(join(result.packagePath, 'manifest.json'), 'utf8')) as {
          database: { logicalPath: string; contentDigest: string };
          projects: Array<{ projectId: string }>;
          files: Array<{ logicalPath: string; sha256: string; sizeBytes: number }>;
          nativeRecords: unknown[];
        };
        expect(manifest.database.logicalPath).toBe('core.sqlite');
        expect(manifest.projects.map(project => project.projectId)).toEqual(['project-a', 'project-b']);
        expect(manifest.files).toContainEqual({ logicalPath: 'artifacts/project-a/artifact-a', sha256: contentHash, sizeBytes: body.byteLength, kind: 'document', projectId: 'project-a', sourceDigest: contentHash });
        expect(manifest.nativeRecords).toEqual([]);
        expect(existsSync(join(result.packagePath, 'core.sqlite'))).toBe(true);
        expect(readFileSync(join(result.packagePath, 'artifacts/project-a/artifact-a')).equals(Buffer.from(body))).toBe(true);
        expect(manifest.database.contentDigest).toBe(hash(new Uint8Array(readFileSync(join(result.packagePath, 'core.sqlite')))));
        expect(service.readLastReport()).toMatchObject({ status: 'complete' });
      } finally { session.close(); }
    });
  });

  it('[case:bounded-scan-refuses-over-budget] reports an incomplete package without copying beyond the file budget', async () => {
    await withFixture(async root => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session);
        const body = new TextEncoder().encode('bounded body');
        const contentHash = hash(body);
        session.transactWrite('fixture.seed', db => {
          db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(NOW, NOW);
          db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('artifact-a', ?, 'project-a', 1, ?, 'input', 'ready', 'text/plain', ?, ?, ?, 1, 'input/a.txt', NULL)").run(NOW, NOW, contentHash, contentHash, body.byteLength);
        });
        seedArtifact(root, 'project-a', 'artifact-a', body);
        const service = createBackupPackageService({ session, dataRoot: root, backupRoot: join(root, 'backups'), files: createArtifactFileStore({ dataRoot: root }), maintenanceGate: createSqliteMaintenanceWriteGate(session), limits: { maxFiles: 1 }, nowUtcMs: () => NOW });
        await expect(service.create({ backupId: 'backup-budget', owner: 'owner-1', hostInstanceId: 'host-1' })).rejects.toMatchObject({ reason: 'incomplete' });
        expect(existsSync(join(root, 'backups', 'backup-budget'))).toBe(false);
        expect(service.readLastReport()).toMatchObject({ status: 'incomplete', copiedFiles: 1, reasons: ['backup_budget_exhausted'] });
      } finally { session.close(); }
    });
  });

  it('[case:pending-refuses-publication] writes an incomplete report and preserves an existing package when a required artifact is pending', async () => {
    await withFixture(async root => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session);
        session.transactWrite('fixture.seed', db => {
          db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(NOW, NOW);
          const digest = 'a'.repeat(64);
          db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('artifact-pending', ?, 'project-a', 1, ?, 'input', 'pending', 'text/plain', ?, NULL, NULL, 1, 'input/a.txt', NULL)").run(NOW, NOW, digest);
        });
        const service = createBackupPackageService({ session, dataRoot: root, backupRoot: join(root, 'backups'), files: createArtifactFileStore({ dataRoot: root }), maintenanceGate: createSqliteMaintenanceWriteGate(session), nowUtcMs: () => NOW });
        await expect(service.create({ backupId: 'backup-pending', owner: 'owner-1', hostInstanceId: 'host-1' })).rejects.toMatchObject({ reason: 'incomplete' });
        expect(existsSync(join(root, 'backups', 'backup-pending'))).toBe(false);
        expect(existsSync(join(root, 'backups', 'backup-pending.incomplete.json'))).toBe(true);
        expect(service.readLastReport()).toMatchObject({ status: 'incomplete' });
      } finally { session.close(); }
    });
  });
});
