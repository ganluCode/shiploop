import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';

it('[case:checkpoint-upgrade-rollback] v56 删除意图升级 v57 保留步骤和历史 checksum，失败升级回滚，检查点拒绝损坏形状', async () => {
  const box = createTempSandbox('shiploop-delete-checkpoint-');
  const session = openSqliteStorageSession({ path: join(box.path, 'core.sqlite') });
  try {
    const db = session.database, previous = SQLITE_MIGRATIONS.filter(m => m.version <= 56);
    await migrateSqliteStorage(session, { migrations: previous });
    db.prepare(`INSERT INTO project_delete_operations (id, target_project_id, principal_id, command_id, request_digest, status, manifest_digest, manifest_json, created_at, updated_at)
      VALUES ('op', 'kept', 'owner', 'command', ?, 'intent', ?, '{}', 1, 1)`).run('a'.repeat(64), 'b'.repeat(64));
    db.prepare("INSERT INTO project_delete_steps(operation_id, step) VALUES ('op','artifact_bodies')").run();
    const before = db.prepare('SELECT * FROM project_delete_operations').all();
    const next = SQLITE_MIGRATIONS.find(m => m.version === 57)!;
    const broken = next.sql + '\nSELECT * FROM missing_table;';
    await expect(migrateSqliteStorage(session, { migrations: [...previous, { version: 57, sql: broken, checksum: createHash('sha256').update(broken).digest('hex') }],
      backupPath: join(box.path, 'before-failure.sqlite') })).rejects.toThrow();
    expect(db.prepare('SELECT * FROM project_delete_operations').all()).toEqual(before);
    expect((db.prepare('PRAGMA table_info(project_delete_steps)').all() as { name: string }[]).map(c => c.name)).not.toContain('checkpoint_json');
    await migrateSqliteStorage(session, { backupPath: join(box.path, 'before-success.sqlite') });
    expect(db.prepare('SELECT * FROM project_delete_operations').all()).toEqual(before);
    expect(db.prepare('SELECT checkpoint_json, checkpoint_digest FROM project_delete_steps').get()).toEqual({ checkpoint_json: '{}', checkpoint_digest: createHash('sha256').update('{}').digest('hex') });
    for (const value of ['[]', 'null', '{bad']) expect(() => db.prepare('UPDATE project_delete_steps SET checkpoint_json = ?').run(value)).toThrow();
    expect(() => db.prepare("UPDATE project_delete_steps SET checkpoint_digest = ?").run('z'.repeat(64))).toThrow();
    expect(db.prepare('SELECT checksum FROM schema_migrations WHERE version <= 56 ORDER BY version').all()).toEqual(previous.map(m => ({ checksum: m.checksum })));
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { session.close(); box.cleanup(); }
});
