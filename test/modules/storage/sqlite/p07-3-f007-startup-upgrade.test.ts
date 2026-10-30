import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { assertUpgradeProcessesStopped, openUpgradedSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/startup-upgrade.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { createBackupPackageVerificationService } from '../../../../packages/core/src/adapters/fs/backup-verification.ts';
import type { StopEscalationProbe } from '../../../../packages/core/src/adapters/process/stop-escalation.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { openBindingFixture } from '../../../helpers/p03-6/input-binding-fixture.ts';

async function fixture(action: (root: string) => Promise<void>) {
  const box = createTempSandbox('p07-3-upgrade-fault-');
  try {
    const session = openSqliteStorageSession({ path: join(box.path, 'core.sqlite') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 54) });
      session.database.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES ('project-a', 1, 1, 'preserved')").run();
    } finally { session.close(); }
    await action(box.path);
  } finally { box.cleanup(); }
}
const processIdentity = { launchId: randomUUID(), pid: 999999, processGroupId: 999999, startTime: 'old-start' };
const absent: StopEscalationProbe = {
  readSupervisorRow: async () => null, listGroupMembers: async () => [],
  signalGroup: () => { throw new Error('upgrade must never signal'); }, delay: async () => {},
};
function baseline(db: Database.Database, raw: unknown = processIdentity) {
  const operationId = randomUUID();
  db.prepare("INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status, started_at) VALUES (?, 1, 1, 'project-a', 'baseline', 'running', 1)").run(operationId);
  db.prepare("INSERT INTO baseline_occupancy (id, holder_operation_id, process_identity) VALUES ('global', ?, ?)").run(operationId, raw === null ? null : JSON.stringify(raw));
}

function expectUnchanged(root: string) {
  const db = new Database(join(root, 'core.sqlite'), { readonly: true });
  try {
    expect(db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: 54 });
    expect(db.prepare('SELECT display_name FROM projects WHERE id = ?').get('project-a')).toEqual({ display_name: 'preserved' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('maintenance_occupancy', 'partial_upgrade')").all()).toEqual([]);
  } finally { db.close(); }
}

describe('F-007 upgrade rollback and stop uncertainty', () => {
  it('[case:migration-failure-preserves-package] rolls back failing DDL, retains the verified old package and version/step diagnostics', async () => {
    await fixture(async root => {
      const sql = 'CREATE TABLE partial_upgrade (id TEXT); INSERT INTO missing_table VALUES (1);';
      const bad = { version: 55, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      let failure: unknown;
      try { await openUpgradedSqliteStorage({ path: join(root, 'core.sqlite'), dataRoot: root, migrations: [...SQLITE_MIGRATIONS.slice(0, 54), bad] }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ step: 'apply', fromVersion: 54, toVersion: 55, version: 55 });
      expectUnchanged(root);
      const packagePath = (failure as { packagePath: string }).packagePath;
      expect(existsSync(packagePath)).toBe(true);
      const verification = await createBackupPackageVerificationService({ dataRoot: root }).verify({ packagePath });
      expect(verification.status).toBe('complete');
      expect(verification.manifest?.database.schemaVersion).toBe(54);
      const reopened = await openUpgradedSqliteStorage({ path: join(root, 'core.sqlite'), dataRoot: root });
      reopened.close();
      expect(readdirSync(join(root, 'backups')).filter(name => existsSync(join(root, 'backups', name, 'manifest.json')))).toHaveLength(2);
    });
  });

  it('[case:partial-chain-never-success] reports a later failed step after an earlier committed migration while retaining the original pre-upgrade package', async () => {
    await fixture(async root => {
      const sql = 'CREATE TABLE partial_upgrade (id TEXT); INSERT INTO missing_table VALUES (1);';
      // P07-3 / F-014（迁移 v59）：坏迁移取当前清单末尾的下一版本（清单追加
      // 后仍保持「55 已提交、随后步骤失败」的原始场景语义）。
      const badVersion = SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]!.version + 1;
      const bad = { version: badVersion, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      let failure: unknown;
      try { await openUpgradedSqliteStorage({ path: join(root, 'core.sqlite'), dataRoot: root, migrations: [...SQLITE_MIGRATIONS, bad] }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ step: 'apply', fromVersion: 54, toVersion: badVersion, version: badVersion });
      const db = new Database(join(root, 'core.sqlite'), { readonly: true });
      try {
        expect(db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: badVersion - 1 });
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_upgrade'").all()).toEqual([]);
        expect(db.prepare('SELECT display_name FROM projects').get()).toEqual({ display_name: 'preserved' });
      } finally { db.close(); }
      const packagePath = (failure as { packagePath: string }).packagePath;
      const report = await createBackupPackageVerificationService({ dataRoot: root }).verify({ packagePath });
      expect(report.status).toBe('complete');
      expect(report.manifest?.database.schemaVersion).toBe(54);
    });
  });

  it('[case:backup-io-failure] refuses migration when the package cannot be created', async () => {
    await fixture(async root => {
      writeFileSync(join(root, 'backups'), 'occupied');
      await expect(openUpgradedSqliteStorage({ path: join(root, 'core.sqlite'), dataRoot: root })).rejects.toMatchObject({ step: 'backup', fromVersion: 54 });
      expectUnchanged(root);
      expect(readFileSync(join(root, 'backups'), 'utf8')).toBe('occupied');
    });
  });

  it.each(['unknown', 'timeout', 'reused', 'active', 'missing'] as const)('[case:stop-%s] preserves the old database and makes no backup when stop cannot be confirmed', async kind => {
    await fixture(async root => {
      const db = new Database(join(root, 'core.sqlite'));
      baseline(db, kind === 'missing' ? null : processIdentity); db.close();
      const probe: StopEscalationProbe = { ...absent,
        readSupervisorRow: kind === 'unknown' ? async () => undefined
          : kind === 'timeout' ? () => new Promise(() => {})
          : kind === 'reused' ? async () => ({ ...processIdentity, startTime: 'reused-start', command: `node ${processIdentity.launchId}` })
          : absent.readSupervisorRow,
        listGroupMembers: kind === 'active' ? async () => [1000000] : absent.listGroupMembers,
      };
      await expect(openUpgradedSqliteStorage({ path: join(root, 'core.sqlite'), dataRoot: root, stopProbe: probe, stopBudgetMs: 25 })).rejects.toMatchObject({ kind: 'busy' });
      expectUnchanged(root);
      expect(existsSync(join(root, 'backups'))).toBe(false);
    });
  });

  it('[case:runner-resource-census] rejects unknown or incomplete Runner leases and checks the whole recorded group without mutating execution facts', async () => {
    const f = await openBindingFixture();
    try {
      const bound = f.claimAndLaunch('t-1');
      const attempt = bound.receipt.attempt;
      const resourceIdentity = { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
      await expect(assertUpgradeProcessesStopped(f.session.database, { probe: absent })).rejects.toMatchObject({ details: { reason: 'process_identity_missing' } });
      f.session.transactWrite('test.persist', () => f.createResources().confirmLaunchInTransaction(resourceIdentity, processIdentity));
      const before = f.query('SELECT status, execution_version FROM attempts');
      await expect(assertUpgradeProcessesStopped(f.session.database, { probe: { ...absent, listGroupMembers: async () => [1000000] } })).rejects.toMatchObject({ details: { reason: 'process_group_active' } });
      await assertUpgradeProcessesStopped(f.session.database, { probe: absent });
      expect(f.query('SELECT status, execution_version FROM attempts')).toEqual(before);
      f.session.database.prepare('DELETE FROM workspace_leases WHERE id = (SELECT id FROM workspace_leases LIMIT 1)').run();
      await expect(assertUpgradeProcessesStopped(f.session.database, { probe: absent })).rejects.toMatchObject({ details: { reason: 'runner_census_incomplete' } });
    } finally { f.close(); }
  });

  it('[case:verifier-history-and-limit] checks terminal Verifier groups independently and refuses an incomplete census', async () => {
    const f = await openBindingFixture();
    try {
      const attempt = f.claimAndLaunch('t-1').receipt.attempt;
      f.session.transactWrite('test.persist', () => f.createResources().confirmLaunchInTransaction({ projectId: attempt.projectId, attemptId: attempt.id,
        owner: attempt.owner, hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion }, processIdentity));
      const db = f.session.database;
      db.prepare(`INSERT INTO verification_batches (id, created_at, updated_at, project_id, feature_id, run_id, task_id, attempt_id, execution_version,
        operation, code_digest, policy_digest, environment_summary, check_snapshot, selection, status, started_at, ended_at)
        VALUES ('batch-old', 1, 1, ?, ?, ?, ?, ?, ?, 'test', ?, ?, '{}', '[{}]', '{}', 'passed', 1, 2)`)
        .run(attempt.projectId, attempt.featureId, attempt.runId, attempt.taskId, attempt.id, attempt.executionVersion, 'a'.repeat(64), 'b'.repeat(64));
      const verifier = { ...processIdentity, launchId: randomUUID(), pid: 999998, processGroupId: 999998 };
      db.prepare('INSERT INTO verification_processes (batch_id, check_key, process_identity) VALUES (?, ?, ?)').run('batch-old', 'check-old', JSON.stringify(verifier));
      await expect(assertUpgradeProcessesStopped(db, { probe: { ...absent, listGroupMembers: async group => group === verifier.processGroupId ? [999997] : [] } })).rejects.toMatchObject({ details: { reason: 'process_group_active' } });
      await assertUpgradeProcessesStopped(db, { probe: absent });
      expect(db.prepare('SELECT status FROM verification_batches').get()).toEqual({ status: 'passed' });
      const insert = db.prepare('INSERT INTO verification_processes (batch_id, check_key, process_identity) VALUES (?, ?, ?)');
      db.transaction(() => { for (let index = 0; index < 256; index++) insert.run('batch-old', `check-${index}`, JSON.stringify(verifier)); })();
      await expect(assertUpgradeProcessesStopped(db, { probe: absent })).rejects.toMatchObject({ details: { reason: 'process_census_incomplete' } });
    } finally { f.close(); }
  });

  it('[case:native-session-without-writer] blocks an active native session without a recorded owner group', async () => {
    await fixture(async root => {
      const db = new Database(join(root, 'core.sqlite'));
      try {
        db.prepare("INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type, expected_hash, storage_locator) VALUES ('input', 1, 1, 'project-a', 'input', 'pending', 'application/json', ?, 'input/a')").run('a'.repeat(64));
        db.prepare("INSERT INTO sessions (id, created_at, updated_at, project_id, kind, purpose, runtime, adapter_version, status, input_ref, last_activity_at, started_at) VALUES ('chat', 1, 1, 'project-a', 'chat', 'chat', 'pi', '1', 'started', 'input', 1, 1)").run();
        await expect(assertUpgradeProcessesStopped(db, { probe: absent })).rejects.toMatchObject({ details: { reason: 'native_writer_stop_unknown' } });
      } finally { db.close(); }
      expectUnchanged(root);
    });
  });

  it('[case:baseline-without-occupancy] refuses an active baseline missing its process occupancy', async () => {
    await fixture(async root => {
      const db = new Database(join(root, 'core.sqlite'));
      try {
        db.prepare("INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status) VALUES (?, 1, 1, 'project-a', 'baseline', 'running')").run(randomUUID());
        await expect(assertUpgradeProcessesStopped(db, { probe: absent })).rejects.toMatchObject({ details: { reason: 'baseline_census_incomplete' } });
      } finally { db.close(); }
      expectUnchanged(root);
    });
  });

  it('[case:verified-absence-no-write] rechecks all recorded identities without signalling or changing occupancy', async () => {
    await fixture(async root => {
      const db = new Database(join(root, 'core.sqlite'));
      try {
        baseline(db);
        const before = db.prepare('SELECT * FROM baseline_occupancy').all();
        let observations = 0;
        await assertUpgradeProcessesStopped(db, { probe: { ...absent, listGroupMembers: async () => { observations++; return []; } } });
        expect(observations).toBe(1);
        expect(db.prepare('SELECT * FROM baseline_occupancy').all()).toEqual(before);
      } finally { db.close(); }
    });
  });
});
