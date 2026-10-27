import { currentMigrationVersions } from '../../helpers/current-schema.ts';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createSqliteGitOperationQueryStore } from '../../../packages/core/src/adapters/sqlite/git-operation-query-store.ts';
import { createSqliteFeatureDeliveryQueryStore } from '../../../packages/core/src/adapters/sqlite/feature-delivery-query-store.ts';
import { toPublicGitOperationRecord } from '../../../packages/core/src/ports/git-operation-query.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { recordVerifiedPass } from '../../helpers/p03-4/task-dag-state-fixture.ts';

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  recordVerifiedPass(box, ids, ids.taskId);
  const db = box.session.database;
  const binding = db.prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
    .get(box.projectId) as { id: string; repo_identity: string };
  const feature = db.prepare('SELECT revision FROM features WHERE id = ?')
    .get(box.featureId) as { revision: number };
  const intent = (overrides: Record<string, unknown> = {}) => ({
    operationId: randomUUID(), projectId: box.projectId, featureId: box.featureId,
    runId: ids.runId, attemptId: `${ids.taskId}-attempt`, executionVersion: 1,
    operationType: 'task_commit', repositoryBindingId: binding.id, repoIdentity: binding.repo_identity,
    worktreePath: box.box.repoDirA, expectedHead: 'a'.repeat(40), candidateTree: 'b'.repeat(40),
    codeDigest: 'ab'.repeat(32), verificationRefs: [], approvalRefs: [],
    message: 'Controlled task commit', gitIdentity: { name: 'Test', email: 'test@example.com', confirmed: true },
    deliveryPolicyDigest: 'cd'.repeat(32), runtimeSource: null,
    ownerId: 'owner-1', hostInstanceId: 'host-1', expectedFeatureRevision: feature.revision,
    ...overrides,
  });
  const finalize = (operationId: string, overrides: Record<string, unknown> = {}) => ({
    operationId, projectId: box.projectId, expectedRevision: 1, status: 'succeeded',
    actualCommit: 'c'.repeat(40), actualTree: 'b'.repeat(40), exitCode: 0,
    durationMs: 1, reasonCode: null, deliveryStatus: 'not_requested', settledAtUtcMs: NOW,
    ...overrides,
  });
  return { box, db, ids, intent, finalize,
    store: createSqliteGitOperationStore(box.session, { nowUtcMs: () => NOW }) };
}

describe('Task commit persistence', () => {
  it.each(['succeeded', 'no_change', 'failed', 'unknown'])('%s round-trips idempotently without changing Feature delivery', async status => {
    const f = await fixture();
    try {
      f.db.prepare("UPDATE features SET delivery_status = 'pending' WHERE id = ?").run(f.box.featureId);
      const featureBefore = f.db.prepare('SELECT * FROM features WHERE id = ?').get(f.box.featureId);
      const input = f.intent();
      expect(f.store.registerGitOperation(input).created).toBe(true);
      expect(f.store.registerGitOperation(input).created).toBe(false);
      expect(() => f.store.registerGitOperation({ ...input, message: 'changed' }))
        .toThrow(expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason: 'intent_conflict' }) }));
      const terminal = f.finalize(input.operationId, { status,
        actualCommit: status === 'unknown' || status === 'failed' ? null
          : status === 'no_change' ? input.expectedHead : 'c'.repeat(40),
        actualTree: status === 'unknown' || status === 'failed' ? null : input.candidateTree,
        exitCode: status === 'unknown' ? null : 0, durationMs: status === 'unknown' ? null : 1 });
      expect(f.store.finalizeGitOperation(terminal).settled).toBe(true);
      expect(f.store.finalizeGitOperation(terminal).settled).toBe(false);
      expect(f.store.getGitOperation(f.box.projectId, input.operationId))
        .toMatchObject({ status, intent: { operationType: 'task_commit' }, deliveryStatus: 'not_requested',
          receipt: { deliveryStatus: 'not_requested', status } });
      expect(f.db.prepare('SELECT * FROM features WHERE id = ?').get(f.box.featureId)).toEqual(featureBefore);
      expect(f.db.prepare("SELECT count(*) AS n FROM state_events WHERE aggregate_type = 'git_operation'").get()).toEqual({ n: 2 });
      f.box.reopen();
      expect(createSqliteGitOperationStore(f.box.session).getGitOperation(f.box.projectId, input.operationId).status).toBe(status);
    } finally { f.box.close(); }
  });

  it.each(['ownerId', 'hostInstanceId', 'executionVersion', 'attemptId'])('rejects invalid %s', async field => {
    const f = await fixture();
    try {
      const value = field === 'executionVersion' ? 2 : field === 'attemptId' ? null : 'other';
      expect(() => f.store.registerGitOperation(f.intent({ [field]: value }))).toThrow();
      expect(f.db.prepare('SELECT count(*) AS n FROM git_operations').get()).toEqual({ n: 0 });
    } finally { f.box.close(); }
  });

  it.each(['register', 'finalize'])('fences stale Task identity at %s', async phase => {
    const f = await fixture();
    try {
      const input = f.intent();
      if (phase === 'finalize') f.store.registerGitOperation(input);
      f.db.prepare('UPDATE tasks SET execution_version = 2 WHERE id = ?').run(f.ids.taskId);
      expect(() => phase === 'register' ? f.store.registerGitOperation(input)
        : f.store.finalizeGitOperation(f.finalize(input.operationId)))
        .toThrow(expect.objectContaining({ kind: 'conflict', details: { reason: 'stale_task_identity' } }));
      if (phase === 'finalize') expect(f.store.getGitOperation(f.box.projectId, input.operationId).status).toBe('pending');
    } finally { f.box.close(); }
  });

  it('recovers a pending Task intent after reopen and settles it only once', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store.registerGitOperation(input);
      f.box.reopen();
      const store = createSqliteGitOperationStore(f.box.session);
      expect(store.registerGitOperation(input).created).toBe(false);
      expect(store.finalizeGitOperation(f.finalize(input.operationId)).settled).toBe(true);
      expect(store.finalizeGitOperation(f.finalize(input.operationId)).settled).toBe(false);
    } finally { f.box.close(); }
  });

  it('enforces Task attempt, owner/host and current Task fencing against direct SQL inserts', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store.registerGitOperation(input);
      const columns = f.db.pragma('table_info(git_operations)') as { name: string }[];
      for (const replacement of [
        { attempt_id: 'NULL' }, { owner_id: "'other'" }, { host_instance_id: "'other'" },
        { execution_version: '2' }, { operation_type: "'unsupported'" },
      ] as Record<string, string>[]) {
        const expressions = columns.map(({ name }) => name === 'id' ? '?' : replacement[name] ?? name);
        expect(() => f.db.prepare(`INSERT INTO git_operations (${columns.map(c => c.name).join(',')})
          SELECT ${expressions.join(',')} FROM git_operations WHERE id = ?`)
          .run(randomUUID(), input.operationId)).toThrow();
      }
    } finally { f.box.close(); }
  });

  it('isolates Task operations from Feature supersession and delivery projection', async () => {
    const f = await fixture();
    try {
      const feature = f.intent({ operationType: 'feature_final_commit', attemptId: null });
      const task = f.intent();
      f.store.registerGitOperation(feature);
      f.store.registerGitOperation(task);
      const queries = createSqliteGitOperationQueryStore(f.box.session);
      const taskRecord = queries.readGitOperationRecord(f.box.projectId, task.operationId)!;
      expect(toPublicGitOperationRecord(taskRecord).operationType).toBe('task_commit');
      expect(createSqliteFeatureDeliveryQueryStore(f.box.session)
        .readFeatureDeliveryView(f.box.projectId, f.box.featureId)?.gitOperation?.intent.operationId)
        .toBe(feature.operationId);
      expect(() => f.store.finalizeGitOperation(f.finalize(task.operationId, { deliveryStatus: 'succeeded' }))).toThrow();
      f.store.finalizeGitOperation(f.finalize(feature.operationId, { deliveryStatus: 'succeeded' }));
      f.store.finalizeGitOperation(f.finalize(task.operationId));
      expect(f.db.prepare('SELECT delivery_status FROM features WHERE id = ?').get(f.box.featureId))
        .toEqual({ delivery_status: 'succeeded' });
    } finally { f.box.close(); }
  });

  it('does not expose a Task-only operation as final Feature delivery', async () => {
    const f = await fixture();
    try {
      const task = f.intent();
      f.store.registerGitOperation(task);
      f.store.finalizeGitOperation(f.finalize(task.operationId));
      expect(createSqliteFeatureDeliveryQueryStore(f.box.session)
        .readFeatureDeliveryView(f.box.projectId, f.box.featureId)?.gitOperation).toBeNull();
    } finally { f.box.close(); }
  });

  it('rolls back operation receipt and event when settlement event insertion fails', async () => {
    const f = await fixture();
    try {
      const input = f.intent();
      f.store.registerGitOperation(input);
      f.db.exec(`CREATE TRIGGER reject_git_settlement BEFORE INSERT ON state_events
        WHEN NEW.aggregate_type = 'git_operation' BEGIN SELECT RAISE(ABORT, 'test fault'); END;`);
      expect(() => f.store.finalizeGitOperation(f.finalize(input.operationId))).toThrow();
      expect(f.store.getGitOperation(f.box.projectId, input.operationId)).toMatchObject({ status: 'pending', receipt: null, revision: 1 });
    } finally { f.box.close(); }
  });
});

describe('v30 Git operation rebuild', () => {
  it('preserves all historical rows, rowids, indexes, triggers, foreign keys and v1-v29 checksums', async () => {
    const f = await fixture();
    const session = openSqliteStorageSession({ path: join(f.box.box.root, 'v29.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 29) });
      const db = session.database;
      // Copy valid fixture facts into a real v29 schema; foreign_key_check verifies the seed.
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'git_operations')").all() as { name: string }[];
        for (const { name } of tables) {
          const rows = f.db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
          for (const row of rows) {
            const columns = db.pragma(`table_xinfo("${name}")`) as { name: string; hidden: number }[];
            const keys = columns.filter(column => column.hidden === 0).map(column => column.name);
            db.prepare(`INSERT INTO "${name}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
              .run(...keys.map(key => row[key]));
          }
        }
      })();
      db.pragma('foreign_keys = ON');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const oldStore = createSqliteGitOperationStore(session, { nowUtcMs: () => NOW });
      for (const status of ['pending', 'succeeded', 'no_change', 'failed', 'unknown']) {
        const input = f.intent({ operationType: 'feature_final_commit', attemptId: null });
        oldStore.registerGitOperation(input);
        if (status !== 'pending') oldStore.finalizeGitOperation(f.finalize(input.operationId, {
          status, deliveryStatus: status === 'unknown' ? 'pending' : status === 'failed' ? 'failed' : 'succeeded',
          actualCommit: status === 'unknown' || status === 'failed' ? null : status === 'no_change' ? input.expectedHead : 'c'.repeat(40),
          actualTree: status === 'unknown' || status === 'failed' ? null : input.candidateTree,
        }));
      }
      const rows = db.prepare(`SELECT rowid, id, created_at, updated_at, revision, project_id, feature_id, run_id,
        attempt_id, execution_version, operation_type, repository_binding_id, repo_identity, worktree_path,
        expected_head, candidate_tree, code_digest, verification_refs, approval_refs, message, identity_name,
        identity_email, delivery_policy_digest, runtime_source, owner_id, host_instance_id, intent_digest,
        status, actual_commit, actual_tree, exit_code, duration_ms, reason_code, receipt, delivery_status, settled_at
        FROM git_operations ORDER BY rowid`).all();
      db.exec('CREATE TABLE git_operation_refs (operation_id TEXT REFERENCES git_operations(id) ON DELETE RESTRICT)');
      db.exec('INSERT INTO git_operation_refs SELECT id FROM git_operations');
      const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'git_operations' AND type IN ('index', 'trigger') ORDER BY name").all();
      const fks = db.pragma('foreign_key_list(git_operations)');
      const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      expect(SQLITE_MIGRATIONS[29]?.foreignKeysOff).toBe(true);
      const v30 = SQLITE_MIGRATIONS[29]!;
      const faultySql = v30.sql + '\nSELECT * FROM missing_v30_fault_table;';
      await expect(migrateSqliteStorage(session, {
        migrations: [...SQLITE_MIGRATIONS.slice(0, 29), {
          ...v30, sql: faultySql, checksum: createHash('sha256').update(faultySql).digest('hex'),
        }], nowUtcMs: () => NOW - 1,
      })).rejects.toMatchObject({ step: 'apply', version: 30 });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.prepare(`SELECT rowid, id, created_at, updated_at, revision, project_id, feature_id, run_id,
        attempt_id, execution_version, operation_type, repository_binding_id, repo_identity, worktree_path,
        expected_head, candidate_tree, code_digest, verification_refs, approval_refs, message, identity_name,
        identity_email, delivery_policy_digest, runtime_source, owner_id, host_instance_id, intent_digest,
        status, actual_commit, actual_tree, exit_code, duration_ms, reason_code, receipt, delivery_status, settled_at
        FROM git_operations ORDER BY rowid`).all()).toEqual(rows);
      expect(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(history);
      expect(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'git_operations' AND type IN ('index', 'trigger') ORDER BY name").all()).toEqual(objects);
      const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
      expect(result.appliedVersions).toEqual(currentMigrationVersions.filter(version => version >= 30));
      expect(db.prepare(`SELECT rowid, id, created_at, updated_at, revision, project_id, feature_id, run_id,
        attempt_id, execution_version, operation_type, repository_binding_id, repo_identity, worktree_path,
        expected_head, candidate_tree, code_digest, verification_refs, approval_refs, message, identity_name,
        identity_email, delivery_policy_digest, runtime_source, owner_id, host_instance_id, intent_digest,
        status, actual_commit, actual_tree, exit_code, duration_ms, reason_code, receipt, delivery_status, settled_at
        FROM git_operations ORDER BY rowid`).all()).toEqual(rows);
      const postMigrationObjects = db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'git_operations' AND type IN ('index', 'trigger') AND name <> 'git_operations_task_identity_check'").all() as { type: string; name: string }[];
      expect(postMigrationObjects.map(object => `${object.type}:${object.name}`)).toEqual(
        expect.arrayContaining((objects as { type: string; name: string }[]).map(object => `${object.type}:${object.name}`)),
      );
      expect(db.pragma('foreign_key_list(git_operations)')).toEqual(fks);
      expect(db.prepare('SELECT * FROM schema_migrations WHERE version < 30 ORDER BY version').all()).toEqual(history);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM git_operation_refs').get()).toEqual({ n: 5 });
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      const task = f.intent();
      expect(oldStore.registerGitOperation(task).created).toBe(true);
      expect(() => db.prepare('UPDATE git_operations SET message = ? WHERE id = ?').run('changed', task.operationId)).toThrow();
      expect(() => db.prepare('DELETE FROM attempts WHERE id = ?').run(task.attemptId)).toThrow();
      expect(await migrateSqliteStorage(session)).toMatchObject({ appliedVersions: [] });
      for (const migration of SQLITE_MIGRATIONS) expect(migration.checksum)
        .toBe(createHash('sha256').update(migration.sql).digest('hex'));
    } finally { session.close(); f.box.close(); }
  });
});
