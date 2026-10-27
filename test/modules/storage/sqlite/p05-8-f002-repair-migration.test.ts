import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_900_000_100_000;
const previous = SQLITE_MIGRATIONS.filter(m => m.version <= 44);
const migration = SQLITE_MIGRATIONS.find(m => m.version === 45)!;

describe('P05-8 F-002 repair authorization migration', () => {
  it('[case:repair-v44-upgrade] v44 upgrade preserves historical facts/checksums and produces an intact backup', async () => {
    const sandbox = createTempSandbox('shiploop-repair-upgrade-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: previous, nowUtcMs: () => NOW });
      session.database.prepare(`INSERT INTO projects
        (id, created_at, revision, updated_at, display_name, status, labels)
        VALUES ('historical-project', ?, 1, ?, '历史项目', 'active', '[]')`).run(NOW, NOW);
      const before = session.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      const result = await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 45), nowUtcMs: () => NOW + 1 });
      expect(result).toMatchObject({ fromVersion: 44, toVersion: 45, appliedVersions: [45] });
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= 44 ORDER BY version').all()).toEqual(before);
      expect(session.database.prepare('SELECT display_name FROM projects WHERE id = ?').get('historical-project')).toEqual({ display_name: '历史项目' });
      expect(session.database.pragma('foreign_key_check')).toEqual([]);
      expect(session.database.pragma('integrity_check', { simple: true })).toBe('ok');
      const backup = new Database(result.backupPath!, { readonly: true });
      try {
        expect(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 44 });
        expect(backup.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      } finally { backup.close(); }
      expect((await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 45), nowUtcMs: () => NOW + 2 })).appliedVersions).toEqual([]);
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'git_agent_repair%' ORDER BY name").all())
        .toEqual([{ name: 'git_agent_repair_attempts' }, { name: 'git_agent_repair_commands' }, { name: 'git_agent_repairs' }]);
    } finally { session.close(); sandbox.cleanup(); }
  });

  it('[case:repair-migration-rollback] failure after creating repair tables rolls back the complete migration and retains v44', async () => {
    const sandbox = createTempSandbox('shiploop-repair-upgrade-fault-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: previous, nowUtcMs: () => NOW });
      const sql = `${migration.sql}\nTHIS IS AN INJECTED DDL FAILURE;`;
      await expect(migrateSqliteStorage(session, { migrations: [...previous, { version: 45, sql,
        checksum: createHash('sha256').update(sql).digest('hex') }], nowUtcMs: () => NOW + 1 }))
        .rejects.toMatchObject({ step: 'apply', version: 45 });
      expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 44 });
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'git_agent_repair%'").all()).toEqual([]);
      expect(session.database.pragma('foreign_key_check')).toEqual([]);
      expect((await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 45), nowUtcMs: () => NOW + 2 })).appliedVersions).toEqual([45]);
    } finally { session.close(); sandbox.cleanup(); }
  });
});
