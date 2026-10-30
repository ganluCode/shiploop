import { currentSchemaVersion, currentMigrationVersions } from '../../../helpers/current-schema.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';

it('[case:upgrade-rollback-constraints] v55 支持库追加升级保存旧事实，失败整体回滚，持久结构拒绝非法形状', async () => {
  const box = createTempSandbox('shiploop-delete-upgrade-');
  const session = openSqliteStorageSession({ path: join(box.path, 'core.sqlite') });
  try {
    const previous = SQLITE_MIGRATIONS.filter(m => m.version <= 55);
    await migrateSqliteStorage(session, { migrations: previous });
    const db = session.database;
    db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('kept', 1, 1, '旧项目正文', 'archived', '[]')").run();
    const before = db.prepare('SELECT * FROM projects').all();
    const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    const last = SQLITE_MIGRATIONS.at(-1)!;
    expect(last.version).toBe(56);
    expect(currentSchemaVersion).toBe(last.version);
    expect(currentMigrationVersions).toEqual(SQLITE_MIGRATIONS.map(migration => migration.version));
    const badSql = last.sql + '\nINSERT INTO projects(id) VALUES (NULL);';
    await expect(migrateSqliteStorage(session, {
      migrations: [...previous, { version: 56, sql: badSql, checksum: createHash('sha256').update(badSql).digest('hex') }],
      backupPath: join(box.path, 'before-failed.sqlite'),
    })).rejects.toThrow();
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(before);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(guards);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'project_delete_operations'").get()).toBeUndefined();
    const upgraded = await migrateSqliteStorage(session, { backupPath: join(box.path, 'before-upgrade.sqlite') });
    expect(upgraded.appliedVersions).toEqual([56]);
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(before);
    expect(db.prepare('SELECT checksum FROM schema_migrations WHERE version <= 55 ORDER BY version').all()).toEqual(previous.map(m => ({ checksum: m.checksum })));
    const insert = db.prepare(`INSERT INTO project_delete_operations (id, target_project_id, principal_id, command_id, request_digest, status, manifest_digest, manifest_json, created_at, updated_at)
      VALUES ('op', 'kept', 'owner', 'command', ?, ?, ?, ?, 1, 1)`);
    expect(() => insert.run('a'.repeat(64), 'completed', 'b'.repeat(64), '{}')).toThrow();
    expect(() => insert.run('a'.repeat(64), 'intent', 'b'.repeat(64), '{broken')).toThrow();
    insert.run('a'.repeat(64), 'intent', 'b'.repeat(64), '{}');
    expect(() => db.prepare("UPDATE project_delete_operations SET manifest_json = '{\"changed\":true}' WHERE id = 'op'").run()).toThrow();
    expect(() => db.prepare("INSERT INTO project_delete_steps(operation_id, step) VALUES ('missing', 'artifact_bodies')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO project_delete_steps(operation_id, step, status) VALUES ('op', 'artifact_bodies', 'completed')").run()).toThrow();
    expect(() => db.prepare("DELETE FROM project_delete_operations WHERE id = 'op'").run()).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { session.close(); box.cleanup(); }
});
