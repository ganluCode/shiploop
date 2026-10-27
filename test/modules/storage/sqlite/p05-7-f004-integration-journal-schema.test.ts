import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW = 1_700_001_000_000;
async function fixture() {
  const sandbox = createTempSandbox('shiploop-p05-7-journal-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 43), nowUtcMs: () => NOW });
  session.database.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('legacy', ?, ?, 'legacy', 'active', '[]')").run(NOW, NOW);
  return { session, close() { session.close(); sandbox.cleanup(); } };
}

describe('P05-7 F-004 integration observation schema', () => {
  it('[case:integration-journal-upgrade] upgrades v43 without changing existing facts and rejects orphan/corrupt evidence', async () => {
    const f = await fixture();
    try {
      const oldTables = f.session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      const result = await migrateSqliteStorage(f.session, { migrations: SQLITE_MIGRATIONS.slice(0, 44), nowUtcMs: () => NOW + 1 });
      expect(result.appliedVersions).toEqual([44]);
      expect(f.session.database.prepare('SELECT display_name FROM projects WHERE id = ?').get('legacy')).toEqual({ display_name: 'legacy' });
      const tables = f.session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      expect(tables.filter(row => !oldTables.some(old => JSON.stringify(old) === JSON.stringify(row))))
        .toEqual([{ name: 'git_integration_commands' }, { name: 'git_integration_observations' }]);
      const insert = (payload: string, revision = 1) => f.session.database.prepare(`INSERT INTO git_integration_observations
        (id, project_id, operation_id, sequence, operation_revision, observation, created_at) VALUES ('o', 'legacy', 'missing', 1, ?, ?, ?)`).run(revision, payload, NOW);
      expect(() => insert('{}')).toThrow(/FOREIGN KEY/);
      expect(() => insert('[]')).toThrow(/CHECK/);
      expect(() => insert('{}', 0)).toThrow(/CHECK/);
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM git_integration_observations').get()).toEqual({ count: 0 });
      expect((await migrateSqliteStorage(f.session, { migrations: SQLITE_MIGRATIONS.slice(0, 44), nowUtcMs: () => NOW + 2 })).appliedVersions).toEqual([]);
    } finally { f.close(); }
  });

  it('[case:integration-journal-migration-rollback] rolls back all v44 DDL and migration history after an injected failure', async () => {
    const f = await fixture();
    try {
      const sql = `${SQLITE_MIGRATIONS[43]!.sql}\nINSERT INTO absent_table VALUES (1);`;
      await expect(migrateSqliteStorage(f.session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 43),
        { version: 44, sql, checksum: createHash('sha256').update(sql).digest('hex') }], nowUtcMs: () => NOW + 1 })).rejects.toThrow();
      expect(f.session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 43 });
      expect(f.session.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'git_integration_%'").all()).toEqual([]);
      expect(f.session.database.prepare('SELECT display_name FROM projects WHERE id = ?').get('legacy')).toEqual({ display_name: 'legacy' });
    } finally { f.close(); }
  });
});
