import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';

describe('F-005 notification persistence migration', () => {
  it('upgrades populated v16 without changing prior history; failed v17 rolls back and retry is idempotent', async () => {
    const f = await openClaimFixture();
    const path = join(f.box.box.root, 'predecessor.db');
    let session = openSqliteStorageSession({ path });
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      f.box.session.transactWrite('test.populate-runtime-reservation', () => {
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
          projectId: attempt.projectId, batchId: f.ids.batchId, runId: attempt.runId, startKey: attempt.id,
        });
        resources.beginLaunchInTransaction({ projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
          hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion });
      });
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 16) });
      const tables = (session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')")
        .all() as { name: string }[]).map(row => row.name);
      session.transactWrite('test.copy-v16-history', () => {
        session.database.pragma('defer_foreign_keys = ON');
        for (const table of tables) {
          const columns = (session.database.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[])
            .filter(column => column.hidden === 0).map(column => column.name);
          for (const row of f.box.session.database.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Record<string, unknown>[]) {
            session.database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
              .run(...columns.map(column => row[column]));
          }
        }
      });
      const snapshot = () => Object.fromEntries(tables.map(table => [table, session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
      const before = snapshot();
      expect(before.attempts).toHaveLength(1);
      expect(before.workspace_leases).toHaveLength(3);
      expect(before.task_attempt_reservations).toHaveLength(1);
      expect(before.runtime_start_reservations).toHaveLength(1);
      expect(before.task_claim_receipts).toHaveLength(1);
      const migrationsBefore = session.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      const checksum = '97d61457ed41f5136f69a683149aa09941d086f25eecc42421059d1f59e54fdb';
      const migration = SQLITE_MIGRATIONS[16]!;
      const sql = `${migration.sql}\nINSERT INTO absent VALUES (1);`;
      await expect(migrateSqliteStorage(session, { migrations: [...SQLITE_MIGRATIONS.slice(0, 16),
        { version: 17, sql, checksum: createHash('sha256').update(sql).digest('hex') }] })).rejects.toMatchObject({ step: 'apply', version: 17 });
      expect(snapshot()).toEqual(before);
      expect(session.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(migrationsBefore);
      expect(session.database.prepare("SELECT name FROM sqlite_master WHERE name IN ('attempt_notifications', 'attempt_notification_diagnostics')").all()).toEqual([]);
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25]);
      before.state_events = before.state_events!.map(row => ({ ...row as Record<string, unknown>, operation_id: null, run_id: null, attempt_id: null, execution_stage: null }));
      expect(snapshot()).toEqual(before);
      expect(session.database.prepare('SELECT * FROM schema_migrations WHERE version <= 16 ORDER BY version').all()).toEqual(migrationsBefore);
      expect(createHash('sha256').update(SQLITE_MIGRATIONS.slice(0, 16).map(m => m.checksum).join('\n')).digest('hex')).toBe(checksum);
      session.close();
      session = openSqliteStorageSession({ path });
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      expect(snapshot()).toEqual(before);
      expect(session.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { session.close(); f.box.close(); }
  });
});
