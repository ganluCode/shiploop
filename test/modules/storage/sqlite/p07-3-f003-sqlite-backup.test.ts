import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSqliteBackup } from '../../../../packages/core/src/adapters/sqlite/backup.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const sandbox = createTempSandbox('shiploop-p07-3-f003-');
  try {
    return await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

async function createWalDatabase(root: string): Promise<ReturnType<typeof openSqliteStorageSession>> {
  const session = openSqliteStorageSession({ path: join(root, 'state.db') });
  await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 1) });
  session.transactWrite('fixture.seed', (db) => {
    db.prepare(
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-1', 1, 1, 1, 'WAL project', 'active', '[]')",
    ).run();
  });
  return session;
}

describe('P07-3 F-003 SQLite online backup', () => {
  it('[case:wal-backup-integrity] backs up committed WAL rows and verifies both SQLite integrity checks', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        const result = await createSqliteBackup(session, {
          dataRoot: root,
          operationId: 'backup-operation-1',
        });
        expect(result.relativePath).toBe('backups/backup-operation-1.db');
        expect(existsSync(result.backupPath)).toBe(true);
        expect(result.integrityCheck).toBe('ok');
        expect(result.foreignKeyCheck).toBe('ok');

        const backup = new Database(result.backupPath, { readonly: true, fileMustExist: true });
        try {
          expect(backup.prepare("SELECT display_name FROM projects WHERE id = 'project-1'").get()).toEqual({
            display_name: 'WAL project',
          });
          expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
            version: 1,
          });
          expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
          expect(backup.pragma('foreign_key_check')).toEqual([]);
        } finally {
          backup.close();
        }
      } finally {
        session.close();
      }
    });
  });

  it('[case:target-conflict-preserves] refuses a repeated target and preserves the first verified backup', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        const first = await createSqliteBackup(session, { dataRoot: root, operationId: 'same-operation' });
        const before = readFileSync(first.backupPath);
        await expect(createSqliteBackup(session, { dataRoot: root, operationId: 'same-operation' }))
          .rejects.toMatchObject({ kind: 'conflict' });
        expect(readFileSync(first.backupPath)).toEqual(before);
      } finally {
        session.close();
      }
    });
  });

  it('[case:controlled-target] rejects traversal, source-as-target, and symlink escape', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        await expect(createSqliteBackup(session, {
          dataRoot: root,
          operationId: 'safe-operation',
          relativePath: '../outside.db',
        })).rejects.toMatchObject({ kind: 'validation' });
        await expect(createSqliteBackup(session, {
          dataRoot: root,
          operationId: 'state',
          relativePath: 'state.db',
        })).rejects.toMatchObject({ kind: 'conflict' });

        const outside = createTempSandbox('shiploop-backup-outside-');
        try {
          mkdirSync(join(root, 'backups'));
          symlinkSync(outside.path, join(root, 'backups', 'escape'));
          await expect(createSqliteBackup(session, {
            dataRoot: root,
            operationId: 'backup',
            relativePath: 'backups/escape/backup.db',
          })).rejects.toMatchObject({ kind: 'ownership' });
        } finally {
          outside.cleanup();
        }
      } finally {
        session.close();
      }
    });
  });

  it('[case:concurrent-target] publishes at most one verified snapshot under concurrent attempts', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        const results = await Promise.allSettled([
          createSqliteBackup(session, { dataRoot: root, operationId: 'race' }),
          createSqliteBackup(session, { dataRoot: root, operationId: 'race' }),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(readdirSync(join(root, 'backups'))).toEqual(['race.db']);
        const db = new Database(join(root, 'backups', 'race.db'), { readonly: true });
        try { expect(db.pragma('integrity_check', { simple: true })).toBe('ok'); } finally { db.close(); }
      } finally { session.close(); }
    });
  });

  it('[case:foreign-key-corrupt] rejects a snapshot with foreign key violations without modifying the source', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        session.database.pragma('foreign_keys = OFF');
        session.database.exec('CREATE TABLE parent_probe(id INTEGER PRIMARY KEY); CREATE TABLE child_probe(parent INTEGER REFERENCES parent_probe(id)); INSERT INTO child_probe VALUES (42)');
        const before = session.database.pragma('foreign_key_check');
        expect(before).toHaveLength(1);
        await expect(createSqliteBackup(session, { dataRoot: root, operationId: 'invalid-fk' }))
          .rejects.toMatchObject({ kind: 'corrupt', details: { reason: 'foreign_key_failed' } });
        expect(session.database.pragma('foreign_key_check')).toEqual(before);
        expect(readdirSync(join(root, 'backups'))).toEqual([]);
      } finally { session.close(); }
    });
  });

  it('[case:backup-failure] leaves no published file when the SQLite connection is closed', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      session.close();
      await expect(createSqliteBackup(session, { dataRoot: root, operationId: 'closed' })).rejects.toBeDefined();
      expect(existsSync(join(root, 'backups', 'closed.db'))).toBe(false);
    });
  });

  it('[case:budget-during-backup] stops before publication when the progress budget expires', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        let calls = 0;
        await expect(createSqliteBackup(session, {
          dataRoot: root, operationId: 'expired', maxDurationMs: 10,
          nowUtcMs: () => calls++ === 0 ? 0 : 10,
        })).rejects.toMatchObject({ kind: 'busy', details: { reason: 'budget_exhausted' } });
        expect(readdirSync(join(root, 'backups'))).toEqual([]);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      } finally { session.close(); }
    });
  });

  it('[case:budget-exhausted] rejects an exhausted backup budget without publishing a partial target', async () => {
    await withSandbox(async (root) => {
      const session = await createWalDatabase(root);
      try {
        await expect(createSqliteBackup(session, {
          dataRoot: root,
          operationId: 'budget-operation',
          maxDurationMs: 0,
        })).rejects.toMatchObject({ kind: 'busy' });
        expect(existsSync(join(root, 'backups', 'budget-operation.db'))).toBe(false);
      } finally {
        session.close();
      }
    });
  });
});
