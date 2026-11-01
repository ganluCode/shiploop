/**
 * P07-5 / F-007：SQLite 备份、制品一致性与升级/恢复安全边界。
 *
 * 本文件只补 P07-5 相对 P07-3 的安全闭环缺口：损坏 manifest/不完整包必须
 * fail-closed；恢复发布跨进程边界中断后可按持久 intent 续接且重复确认幂等。
 * WAL、公开 Host/CLI、升级前停止核验/迁移回滚及完整纵向事实由索引中的
 * P07-3 回归共同覆盖。
 */
import { observeP07Entry } from '../../helpers/p07-5/entry-observation.ts';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createBackupPackageService } from '../../../packages/core/src/adapters/sqlite/backup-package.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createBackupPackageVerificationService } from '../../../packages/core/src/adapters/fs/backup-verification.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createOfflineRestoreService } from '../../../packages/host/src/runtime/offline-restore.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_800_100_000_000;

function sha256(value: Uint8Array | Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withFixture<T>(action: (root: string) => Promise<T>): Promise<T> {
  const box = createTempSandbox('shiploop-p07-5-f007-');
  try {
    const session = openSqliteStorageSession({ path: join(box.path, 'core.sqlite') });
    try {
      await migrateSqliteStorage(session);
      const body = Buffer.from('F-007 artifact body\n', 'utf8');
      const artifactHash = sha256(body);
      const relative = deriveArtifactFinalRelativePath({ projectId: 'project-f007', artifactId: 'artifact-f007' });
      const artifactPath = join(box.path, relative);
      mkdirSync(join(artifactPath, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(artifactPath, body, { mode: 0o600 });
      session.transactWrite('f007.seed', db => {
        db.prepare(`INSERT INTO projects
          (id, created_at, revision, updated_at, display_name, status, labels)
          VALUES ('project-f007', ?, 1, ?, 'F-007 project', 'active', '[]')`).run(NOW, NOW);
        db.prepare(`INSERT INTO artifacts
          (id, created_at, project_id, revision, updated_at, kind, status, media_type,
           expected_hash, content_hash, size_bytes, version, storage_locator, failure_reason)
          VALUES ('artifact-f007', ?, 'project-f007', 1, ?, 'document', 'ready',
           'text/plain', ?, ?, ?, 1, 'documents/artifact-f007', NULL)`).run(
          NOW, NOW, artifactHash, artifactHash, body.byteLength,
        );
      });
    } finally {
      session.close();
    }
    return await action(box.path);
  } finally {
    observeP07Entry(box.path, join(box.path, 'core.sqlite'));
    box.cleanup();
  }
}

async function createPackage(root: string, backupId: string): Promise<string> {
  const session = openSqliteStorageSession({ path: join(root, 'core.sqlite') });
  try {
    const result = await createBackupPackageService({
      session,
      dataRoot: root,
      backupRoot: join(root, 'backups'),
      files: createArtifactFileStore({ dataRoot: root }),
      maintenanceGate: createSqliteMaintenanceWriteGate(session),
      nowUtcMs: () => NOW,
    }).create({ backupId, owner: 'owner-f007', hostInstanceId: 'host-f007' });
    return result.packagePath;
  } finally {
    session.close();
  }
}

describe('P07-5 F-007 backup and restore safety', () => {
  it('[case:corrupt-manifest-and-incomplete-package-fail-closed] reports concrete corruption or missing facts and never publishes a target', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root, 'backup-f007-corrupt');
      const verifier = createBackupPackageVerificationService({ dataRoot: root });
      const variants = ['manifest-corrupt', 'body-missing'] as const;

      for (const variant of variants) {
        const broken = join(root, variant);
        cpSync(packagePath, broken, { recursive: true });
        if (variant === 'manifest-corrupt') {
          writeFileSync(join(broken, 'manifest.json'), '{"schemaVersion":99}', { mode: 0o600 });
        } else {
          rmSync(join(broken, 'artifacts', 'project-f007', 'artifact-f007'), { force: true });
        }

        const report = await verifier.verify({ packagePath: broken });
        expect(report.status).not.toBe('complete');
        expect(report.reasons.length).toBeGreaterThan(0);
        expect(report.reasons.some(reason =>
          reason.includes('manifest') || reason.includes('missing') || reason.includes('file_') || reason.includes('database_'),
        )).toBe(true);

        const target = join(root, `target-${variant}`);
        mkdirSync(target, { recursive: true, mode: 0o700 });
        const restore = createOfflineRestoreService({ dataRoot: target });
        await expect(restore.prepare({ operationId: `restore-${variant}`, packagePath: broken }))
          .rejects.toThrow('data.restore: backup_not_verified');
        expect(existsSync(join(target, 'core.sqlite'))).toBe(false);
        expect(existsSync(join(target, 'restore-operation.json'))).toBe(false);
      }

      // 破坏副本不能污染唯一有效包；有效包仍能被只读核验。
      expect((await verifier.verify({ packagePath })).status).toBe('complete');
    });
  });

  it('[case:restore-publication-interruption-is-idempotent] resumes a persisted publishing intent without mixing roots or rerunning data', async () => {
    await withFixture(async root => {
      const packagePath = await createPackage(root, 'backup-f007-interrupt');
      const target = join(root, 'restored');
      mkdirSync(target, { recursive: true, mode: 0o700 });
      let interrupted = false;
      const interruptedRestore = createOfflineRestoreService({
        dataRoot: target,
        boundary: async point => {
          if (point === 'after-publish-group' && !interrupted) {
            interrupted = true;
            throw new Error('f007-injected-publication-interruption');
          }
        },
      });

      const preview = await interruptedRestore.prepare({ operationId: 'restore-f007', packagePath });
      await expect(interruptedRestore.confirm({ operationId: 'restore-f007', confirmation: preview.confirmation }))
        .rejects.toThrow('f007-injected-publication-interruption');

      // artifacts 组已发布而数据库尚未发布；intent 是可诊断的 publishing 状态，
      // 目标没有被写入第二个数据库，也没有把源根混入恢复根。
      expect(existsSync(join(target, 'projects', 'project-f007', 'artifacts', 'artifact-f007', 'content'))).toBe(true);
      expect(existsSync(join(target, 'core.sqlite'))).toBe(false);
      const intent = JSON.parse(readFileSync(join(target, 'restore-operation.json'), 'utf8')) as { step: string; operationId: string };
      expect(intent).toMatchObject({ step: 'publishing', operationId: 'restore-f007' });

      const resumed = createOfflineRestoreService({ dataRoot: target });
      const receipt = await resumed.confirm({ operationId: 'restore-f007', confirmation: preview.confirmation });
      expect(receipt).toMatchObject({ status: 'published', operationId: 'restore-f007', cleanup: 'retained' });
      // 同一确认再次执行只核对已发布事实，不新建/覆盖数据库。
      const second = await resumed.confirm({ operationId: 'restore-f007', confirmation: preview.confirmation });
      expect(second).toEqual(receipt);
      expect(existsSync(join(target, 'core.sqlite'))).toBe(true);

      const database = new Database(join(target, 'core.sqlite'), { readonly: true, fileMustExist: true });
      try {
        expect(database.prepare("SELECT display_name FROM projects WHERE id = 'project-f007'").get()).toEqual({ display_name: 'F-007 project' });
        expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        database.close();
      }
      const bodyPath = join(target, 'projects', 'project-f007', 'artifacts', 'artifact-f007', 'content');
      expect(sha256(readFileSync(bodyPath))).toBe(sha256('F-007 artifact body\n'));
    });
  });
});
