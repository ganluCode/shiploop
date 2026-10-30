import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteMaintenanceWriteGate } from '../../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createBackupPackageService } from '../../../../packages/core/src/adapters/sqlite/backup-package.ts';
import { createBackupPackageVerificationService } from '../../../../packages/core/src/adapters/fs/backup-verification.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_800_000_000_000;
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function withFixture<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const box = createTempSandbox('shiploop-p07-3-f005-');
  try { return await fn(box.path); } finally { box.cleanup(); }
}

function seedArtifact(root: string, projectId: string, artifactId: string, body: Uint8Array): void {
  const relative = deriveArtifactFinalRelativePath({ projectId, artifactId });
  const path = join(root, ...relative.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

async function createPackage(root: string, backupId = 'backup-verify'): Promise<string> {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  await migrateSqliteStorage(session);
  const body = new TextEncoder().encode('verified body');
  const contentHash = hash(body);
  session.transactWrite('fixture.seed', db => {
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason) VALUES ('artifact-a', ?, 'project-a', 1, ?, 'document', 'ready', 'text/plain', ?, ?, ?, 1, 'ignored/locator.txt', NULL)").run(NOW, NOW, contentHash, contentHash, body.byteLength);
  });
  seedArtifact(root, 'project-a', 'artifact-a', body);
  const packageResult = await createBackupPackageService({
    session,
    dataRoot: root,
    backupRoot: join(root, 'backups'),
    files: createArtifactFileStore({ dataRoot: root }),
    maintenanceGate: createSqliteMaintenanceWriteGate(session),
    nowUtcMs: () => NOW,
  }).create({ backupId, owner: 'owner-1', hostInstanceId: 'host-1' });
  session.close();
  return packageResult.packagePath;
}

describe('P07-3 F-005 backup package verification and recovery staging', () => {
  it('[case:verify-and-stage-healthy-package] verifies a real package before copying it into isolated staging', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root);
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const report = await service.verify({ packagePath });
      expect(report.status).toBe('complete');
      expect(report.checks.map(check => check.status)).not.toContain('corrupt');
      const staged = await service.stage({ packagePath, verification: report });
      expect(staged.status).toBe('complete');
      expect(staged.stagingRelativePath).toMatch(/^restore-staging\//);
      expect(existsSync(join(root, staged.stagingRelativePath!, 'core.sqlite'))).toBe(true);
      expect(existsSync(join(root, staged.stagingRelativePath!, 'artifacts/project-a/artifact-a'))).toBe(true);
      expect(existsSync(join(packagePath, 'manifest.json'))).toBe(true);
    });
  });

  it('[case:detects-manifest-and-body-tampering-without-writing-source] reports corruption and leaves the package unchanged', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root);
      const manifestPath = join(packagePath, 'manifest.json');
      const originalManifest = readFileSync(manifestPath);
      const artifactPath = join(packagePath, 'artifacts/project-a/artifact-a');
      writeFileSync(artifactPath, 'tampered');
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const report = await service.verify({ packagePath });
      expect(report.status).toBe('incomplete');
      expect(report.checks.some(check => check.name === 'file-content' && check.status === 'corrupt')).toBe(true);
      expect(readFileSync(manifestPath)).toEqual(originalManifest);
    });
  });

  it('[case:rejects-unsafe-path-and-high-version] rejects untrusted logical paths and unsupported manifest versions', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root);
      const manifestPath = join(packagePath, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      (manifest.files as Array<Record<string, unknown>>)[0]!.logicalPath = '../outside';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const unsafe = await service.verify({ packagePath });
      expect(unsafe.status).toBe('rejected');
      expect(unsafe.checks.some(check => check.status === 'rejected')).toBe(true);

      manifest.schemaVersion = 999;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const highVersion = await service.verify({ packagePath });
      expect(highVersion.status).toBe('rejected');
      expect(highVersion.reasons).toContain('unsupported_manifest_version');
    });
  });

  it('[case:detects-missing-and-unsafe-package-entries] reports missing bodies and rejects symlink entries without touching the source', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root);
      unlinkSync(join(packagePath, 'artifacts/project-a/artifact-a'));
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const missing = await service.verify({ packagePath });
      expect(missing.status).toBe('incomplete');
      expect(missing.checks.some(check => check.status === 'missing')).toBe(true);
    });
    await withFixture(async root => {
      const linkedPackage = await createPackage(root, 'backup-linked');
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'outside');
      unlinkSync(join(linkedPackage, 'artifacts/project-a/artifact-a'));
      symlinkSync(outside, join(linkedPackage, 'artifacts/project-a/artifact-a'));
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const rejected = await service.verify({ packagePath: linkedPackage });
      expect(rejected.status).toBe('rejected');
      expect(readFileSync(outside, 'utf8')).toBe('outside');
    });
  });

  it('[case:detects-database-corruption-and-partial-recorder] does not accept truncated databases or partial recorder evidence', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root);
      const databasePath = join(packagePath, 'core.sqlite');
      writeFileSync(databasePath, readFileSync(databasePath).subarray(0, 128));
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const corrupted = await service.verify({ packagePath });
      expect(corrupted.status).toBe('incomplete');
      expect(corrupted.reasons).toContain('database_size_mismatch');
    });
    await withFixture(async root => {
      const recorderPackage = await createPackage(root, 'backup-recorder');
      const manifestPath = join(recorderPackage, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      (manifest.recorder as Array<Record<string, unknown>>).push({ sessionId: 'session-a', watermark: 1, coverage: 'partial', gaps: ['body_missing'] });
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const service = createBackupPackageVerificationService({ dataRoot: root, nowUtcMs: () => NOW });
      const partial = await service.verify({ packagePath: recorderPackage });
      expect(partial.status).toBe('incomplete');
      expect(partial.reasons).toContain('recorder_coverage_partial');
    });
  });
});
