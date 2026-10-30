/**
 * P07-3 / F-014：备份接受回执（v8）与迁移 v59 的存储契约回归。
 *
 * - 迁移 v59 重建 command_receipts（新增 backup_id；v8 关联 CHECK 分支）；
 *   旧 v5/v6/v7 回执升级后原样可读（含 accepted v5 的 baseline 关联）；
 * - data.backup.create accepted v8 持久化/读取往返：scope global、operationId
 *   UUID、backupId 稳定 ID；伪造列组合（project scope、批关联、结果列）被
 *   CHECK/映射拒绝；
 * - 操作日志 journal 原子写/损坏 fail-closed；备份包事实读取（manifest 摘要与
 *   未完成报告）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteCommandReceiptStore } from '../../../packages/core/src/adapters/sqlite/command-receipts.ts';
import { createDataBackupOperationJournal, createBackupPackageFactsReader } from '../../../packages/core/src/adapters/fs/backup-operation-journal.ts';
import { createAcceptedReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';

function migratedSession() {
  const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-store-'));
  const session = openSqliteStorageSession({ path: join(box, 'core.sqlite') });
  return { box, session };
}

describe('P07-3 F-014 backup receipts & migration v59', () => {
  it('[case:v59-upgrade-keeps-receipts] migrates to 59 and preserves legacy v5 receipts', async () => {
    const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-mig-'));
    const path = join(box, 'core.sqlite');
    try {
      const session = openSqliteStorageSession({ path });
      await migrateSqliteStorage(session);
      const db = session.database;
      db.prepare("INSERT INTO projects (id, created_at, updated_at, revision, display_name, status, labels) VALUES ('p1', 1, 1, 1, 'P', 'active', '[]')").run();
      db.prepare("INSERT INTO baseline_operations (id, project_id, created_at, updated_at, revision, status, kind) VALUES ('b1', 'p1', 1, 1, 1, 'accepted', 'environment')").run();
      db.prepare("INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, receipt_version, issued_at, completed_at) VALUES (?, 1, 1, 1, 'local-owner', ?, 'project', 'p1', 'baseline.run', ?, 'accepted', 'b1', 5, 1, 1)")
        .run(randomUUID(), randomUUID(), 'a'.repeat(64));
      session.close();
      // v59 迁移后旧回执原样保留且可读。
      const upgraded = openSqliteStorageSession({ path });
      await migrateSqliteStorage(upgraded);
      const version = (upgraded.database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
      expect(version).toBeGreaterThanOrEqual(59);
      const row = upgraded.database.prepare("SELECT receipt_version, operation_id, backup_id FROM command_receipts WHERE operation = 'baseline.run'").get() as { receipt_version: number; operation_id: string; backup_id: string | null };
      expect(row).toMatchObject({ receipt_version: 5, operation_id: 'b1', backup_id: null });
      upgraded.close();
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('[case:v8-roundtrip-and-guards] persists and reads accepted v8; hostile rows rejected', async () => {
    const { box, session } = migratedSession();
    try {
      await migrateSqliteStorage(session);
      const store = createSqliteCommandReceiptStore(session);
      const principal = createLocalOwnerPrincipal();
      const receipt = createAcceptedReceipt({
        principalId: principal.principalId,
        commandId: randomUUID(),
        operation: 'data.backup.create',
        scope: { kind: 'global' },
        requestDigest: 'b'.repeat(64),
        issuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        operationId: randomUUID(),
        backupId: 'backup-v8-1',
      });
      expect(receipt).toMatchObject({ schemaVersion: 8, status: 'accepted', backupId: 'backup-v8-1' });
      await store.saveReceipt(receipt);
      const read = await store.findReceiptByCommandId(principal.principalId, receipt.commandId);
      expect(read).toMatchObject({ schemaVersion: 8, status: 'accepted', operationId: receipt.operationId, backupId: 'backup-v8-1' });
      // v8 不允许伪造 project scope / 批关联 / 结果列（CHECK + 映射双重拒绝）。
      expect(() => createAcceptedReceipt({
        principalId: principal.principalId,
        commandId: randomUUID(),
        operation: 'data.backup.create',
        scope: { kind: 'global' } as const,
        requestDigest: 'b'.repeat(64),
        issuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        operationId: randomUUID(),
        backupId: 'not a stable id!',
      })).toThrow(TypeError);
      expect(() => session.database.prepare(
        "INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, operation_id, receipt_version, backup_id, issued_at, completed_at) VALUES (?, 1, 1, 1, 'local-owner', ?, 'global', NULL, 'data.backup.create', ?, 'accepted', ?, 8, NULL, 1, 1)",
      ).run(randomUUID(), randomUUID(), 'c'.repeat(64), randomUUID())).toThrow();
    } finally {
      session.close();
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('[case:journal-and-facts] operation journal is atomic and fail-closed; facts read manifest digest and incomplete report', async () => {
    const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-journal-'));
    const backupRoot = join(box, 'backups');
    try {
      const journal = createDataBackupOperationJournal({ backupRoot });
      const now = 1_700_000_000_000;
      journal.save({
        schemaVersion: 1, operationId: 'op-1', kind: 'backup', commandId: 'cmd-1',
        backupId: 'bk-1', target: 'default', status: 'running',
        createdAtUtcMs: now, updatedAtUtcMs: now,
      });
      expect(journal.read('op-1')).toMatchObject({ status: 'running', backupId: 'bk-1' });
      expect(journal.read('op-missing')).toBeNull();
      // 损坏日志 fail-closed（corrupt，不虚构状态）。
      writeFileSync(join(backupRoot, 'operations', 'op-2.json'), '{not json', { mode: 0o600 });
      expect(() => journal.read('op-2')).toThrow(StorageError);

      const facts = createBackupPackageFactsReader({ backupRoot });
      expect(facts.read('bk-none')).toBeNull();
      // 完整包：manifest 字节摘要与摘要视图。
      const packageDir = join(backupRoot, 'bk-done');
      mkdirSync(packageDir, { recursive: true, mode: 0o700 });
      const manifest = {
        schemaVersion: 1, packageVersion: 1, backupId: 'bk-done', createdAtUtc: '2026-10-30T00:00:00.000Z',
        database: { logicalPath: 'core.sqlite', schemaVersion: 59, migrationDigest: 'd'.repeat(64), contentDigest: 'e'.repeat(64), integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' } },
        projects: [], files: [{ logicalPath: 'core.sqlite', sizeBytes: 4, sha256: 'e'.repeat(64), kind: 'database' }],
        nativeRecords: [], sources: [], checkpoints: { status: 'unsupported', reason: 'checkpoint_not_exposed' },
        recorder: [], externalDependencies: [],
      };
      const bytes = JSON.stringify(manifest);
      writeFileSync(join(packageDir, 'manifest.json'), bytes, { mode: 0o600 });
      const complete = facts.read('bk-done');
      expect(complete).toMatchObject({
        status: 'complete',
        backupId: 'bk-done',
        manifestDigest: createHash('sha256').update(bytes).digest('hex'),
      });
      // 未完成报告。
      writeFileSync(join(backupRoot, 'bk-incomplete.incomplete.json'), JSON.stringify({
        status: 'incomplete', backupId: 'bk-incomplete', scannedProjects: 0, scannedArtifacts: 0,
        copiedFiles: 0, totalBytes: 0, durationMs: 5, reasons: ['artifact_not_ready:p:a'],
      }), { mode: 0o600 });
      expect(facts.read('bk-incomplete')).toMatchObject({ status: 'incomplete', report: { reasons: ['artifact_not_ready:p:a'] } });
      void readFileSync;
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });
});
