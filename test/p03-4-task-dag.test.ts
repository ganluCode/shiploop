import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { openBudgetFixture, BUDGET, NOW } from './helpers/p03-3/budget-fixture.ts';
import { createSqliteTaskDagStore } from '../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createTaskDagService, evaluateTaskDag } from '../packages/core/src/application/task-dag.ts';
import { recordVerifiedPass } from './helpers/p03-4/task-dag-state-fixture.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';

async function fixture(edges = [[], ['t-1'], ['t-2']] as string[][]) {
  const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
  const box = await openBudgetFixture({ ...BUDGET, batch }, edges.map((dependsOn, i) => ({
    id: `t-${i + 1}`, title: `Task ${i + 1}`, acceptance: { criteria: ['verified work'] }, dependsOn,
  })).reverse());
  const ids = await box.start();
  const service = createTaskDagService({ store: createSqliteTaskDagStore(box.session), nowMs: () => NOW });
  return { box, ids, evaluate: () => service.evaluate(ids.projectId, ids.runId) };
}

describe('P03-4 deterministic Task DAG', () => {
  it('selects only the root of a three Task chain without writes or duplicate dispatch', async () => {
    const f = await fixture();
    try {
      const before = f.box.snapshot();
      const result = f.evaluate();
      expect(result.reason).toBe('ready');
      expect(result.readyTaskIds).toEqual(['t-1']);
      expect(result.tasks.map(t => [t.taskId, t.reason])).toEqual([
        ['t-1', 'ready'], ['t-2', 'dependency_pending'], ['t-3', 'dependency_pending'],
      ]);
      expect(f.evaluate()).toEqual(result);
      expect(f.box.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it.each(['failed', 'skipped', 'cancelled', 'passed'])('does not unlock a successor for %s without valid evidence', async status => {
    const f = await fixture();
    try {
      f.box.session.database.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, 't-1');
      const result = f.evaluate();
      expect(result.readyTaskIds).toEqual([]);
      expect(result.reason).toBe('dependency_failed');
      expect(result.tasks.find(t => t.taskId === 't-2')?.reason).toBe('dependency_failed');
    } finally { f.box.close(); }
  });

  it('advances verified chain and hands off without completing or creating Run/Feature', async () => {
    const f = await fixture();
    try {
      recordVerifiedPass(f.box, f.ids, 't-1');
      expect(f.evaluate().readyTaskIds).toEqual(['t-2']);
      recordVerifiedPass(f.box, f.ids, 't-2');
      expect(f.evaluate().readyTaskIds).toEqual(['t-3']);
      recordVerifiedPass(f.box, f.ids, 't-3');
      const before = f.box.snapshot();
      expect(f.evaluate()).toMatchObject({ reason: 'all_passed', handoff: 'feature_final_verification', readyTaskIds: [] });
      expect(f.box.snapshot()).toEqual(before);
      expect(f.box.session.database.prepare('SELECT status FROM runs').get()).toEqual({ status: 'queued' });
      expect(f.box.session.database.prepare('SELECT status FROM features').get()).not.toEqual({ status: 'completed' });
      f.box.reopen();
      expect(createTaskDagService({ store: createSqliteTaskDagStore(f.box.session), nowMs: () => NOW })
        .evaluate(f.ids.projectId, f.ids.runId).reason).toBe('all_passed');
    } finally { f.box.close(); }
  });

  it('orders a fork independently of Task, edge and fact enumeration', async () => {
    const f = await fixture([[], ['t-1'], ['t-1']]);
    try {
      recordVerifiedPass(f.box, f.ids, 't-1');
      const view = createSqliteTaskDagStore(f.box.session).readTaskDagView(f.ids.projectId, f.ids.runId);
      const expected = evaluateTaskDag(view, NOW);
      expect(expected.readyTaskIds).toEqual(['t-2', 't-3']);
      expect(evaluateTaskDag({ ...view, facts: [...view.facts].reverse(), plan: { ...view.plan,
        tasks: [...view.plan.tasks].reverse(), dependencies: [...view.plan.dependencies].reverse() } }, NOW)).toEqual(expected);
      f.box.session.transactWrite('test.dag-consistency', () => expect(f.evaluate()).toEqual(expected));
    } finally { f.box.close(); }
  });

  it.each(['fencing', 'strategy', 'permissions', 'policy', 'missing_artifact', 'model_success'])('rejects invalid pass evidence: %s', async drift => {
    const f = await fixture();
    try {
      const snapshot = recordVerifiedPass(f.box, f.ids, 't-1'), db = f.box.session.database;
      if (drift === 'fencing') db.prepare("UPDATE tasks SET execution_version = 2 WHERE id = 't-1'").run();
      else if (drift === 'missing_artifact') db.prepare("UPDATE artifacts SET status = 'failed' WHERE id = 't-1-manifest'").run();
      else if (drift === 'model_success') db.prepare("UPDATE attempts SET status = 'executing', execution_stage = 'runtime' WHERE task_id = 't-1'").run();
      else {
        db.exec('DROP TRIGGER attempts_input_immutable');
        const changed = { ...snapshot, digests: { ...snapshot.digests }, approval: { ...snapshot.approval } };
        if (drift === 'strategy') changed.digests.strategyCopyDigest = 'cd'.repeat(32);
        if (drift === 'permissions') changed.digests.permissionsDigest = 'cd'.repeat(32);
        if (drift === 'policy') changed.approval.checkPolicyDigest = 'cd'.repeat(32);
        db.prepare('UPDATE attempts SET input_snapshot = ?').run(JSON.stringify(changed));
      }
      expect(f.evaluate().readyTaskIds).toEqual([]);
      expect(f.evaluate().reason).toBe('dependency_failed');
    } finally { f.box.close(); }
  });

  it('manual blocking overrides valid evidence; planning work remains outside coding scope', async () => {
    const f = await fixture();
    try {
      const db = f.box.session.database;
      db.prepare(`INSERT INTO tasks (id, created_at, updated_at, project_id, feature_id, title, acceptance,
        execution_config, config_source, kind) SELECT 'planning-1', created_at, updated_at, project_id, feature_id,
        'Planning', acceptance, execution_config, config_source, 'planning' FROM tasks WHERE id = 't-1'`).run();
      expect(f.evaluate().readyTaskIds).toEqual(['t-1']);
      expect(f.evaluate().tasks.map(t => t.taskId)).not.toContain('planning-1');
      recordVerifiedPass(f.box, f.ids, 't-1');
      db.prepare("UPDATE tasks SET manual_block = 1 WHERE id = 't-1'").run();
      expect(f.evaluate().reason).toBe('waiting_approval');
      expect(f.evaluate().tasks.find(t => t.taskId === 't-2')?.reason).toBe('waiting_approval');
      expect(f.evaluate().readyTaskIds).toEqual([]);
    } finally { f.box.close(); }
  });

  it.each(['deadline', 'run_attempts', 'batch_attempts', 'runtime_starts', 'code_attempts', 'unknown_cost'])('blocks budgets: %s', async dimension => {
    const f = await fixture();
    try {
      const db = f.box.session.database;
      if (dimension === 'run_attempts') db.prepare('UPDATE runs SET attempts_created = max_attempts_per_run').run();
      if (dimension === 'batch_attempts') db.prepare('UPDATE execution_batches SET attempts_created = 2').run();
      if (dimension === 'runtime_starts') db.prepare('UPDATE execution_batches SET runtime_starts = 2').run();
      if (dimension === 'code_attempts') db.prepare("UPDATE tasks SET attempt_counter = 3, code_attempts_used = 3 WHERE id = 't-1'").run();
      const view = createSqliteTaskDagStore(f.box.session).readTaskDagView(f.ids.projectId, f.ids.runId);
      const changed = dimension === 'unknown_cost' ? { ...view, batch: { ...view.batch,
        budgetSnapshot: { ...view.batch.budgetSnapshot, batch: { ...view.batch.budgetSnapshot.batch, maxCostTotal: 10 } } } } : view;
      expect(evaluateTaskDag(changed, dimension === 'deadline' ? view.batch.deadlineAtUtcMs : NOW).reason).toBe('budget_exhausted');
    } finally { f.box.close(); }
  });

  it.each(['held', 'quarantined'])('does not release expired %s occupancy', async state => {
    const f = await fixture();
    try {
      recordVerifiedPass(f.box, f.ids, 't-1');
      f.box.session.database.prepare(`INSERT INTO workspace_leases (id, created_at, updated_at, project_id, resource_key, resource_kind,
        owner_kind, owner_id, host_instance_id, execution_version, lease_until, state)
        VALUES ('lease-1', ?, ?, ?, 'global:execution', 'global', 'attempt', 't-1-attempt', 'host-1', 1, ?, ?)`)
        .run(NOW, NOW, f.ids.projectId, NOW - 1, state);
      expect(f.evaluate().reason).toBe('resource_busy');
      for (const id of ['t-2', 't-3']) recordVerifiedPass(f.box, f.ids, id);
      expect(f.evaluate()).toMatchObject({ reason: 'resource_busy', handoff: null });
    } finally { f.box.close(); }
  });

  it.each(['succeeded', 'failed', 'cancelled', 'paused', 'pausing', 'cancelling', 'interrupted'])('diagnoses unclaimable Run %s', async status => {
    const f = await fixture();
    try {
      f.box.session.database.prepare('UPDATE runs SET status = ?').run(status);
      expect(f.evaluate().reason).toBe(['succeeded', 'failed', 'cancelled'].includes(status) ? 'run_not_active' : 'run_control_blocked');
      expect(f.evaluate().readyTaskIds).toEqual([]);
    } finally { f.box.close(); }
  });

  it('reports missing approval and stable mixed-blocker precedence', async () => {
    const f = await fixture([[], [], []]);
    try {
      const db = f.box.session.database;
      db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't-1'").run();
      db.prepare("UPDATE tasks SET manual_block = 1 WHERE id = 't-2'").run();
      db.prepare("UPDATE tasks SET attempt_counter = 3, code_attempts_used = 3 WHERE id = 't-3'").run();
      expect(f.evaluate().reason).toBe('dependency_failed');
      expect(f.evaluate().tasks.map(t => t.reason)).toEqual(['dependency_failed', 'waiting_approval', 'budget_exhausted']);
      db.prepare("UPDATE approvals SET status = 'superseded'").run();
      expect(f.evaluate().reason).toBe('waiting_approval');
    } finally { f.box.close(); }
  });

  it.each(['missing_node', 'self', 'cycle', 'cross_feature', 'empty_scope', 'damaged_scope', 'input', 'approval', 'widening'])('fails closed on corrupt graph/snapshot: %s', async corruption => {
    const f = await fixture();
    try {
      const db = f.box.session.database;
      if (corruption === 'missing_node') { db.exec('PRAGMA foreign_keys = OFF'); db.prepare("DELETE FROM tasks WHERE id = 't-3'").run(); }
      if (corruption === 'self') { db.exec('PRAGMA ignore_check_constraints = ON'); db.prepare("UPDATE task_dependencies SET depends_on_id = task_id WHERE task_id = 't-2'").run(); }
      if (corruption === 'cycle') db.prepare(`INSERT INTO task_dependencies (id, created_at, updated_at, project_id, feature_id, task_id, depends_on_id)
        VALUES ('cycle-edge', ?, ?, ?, ?, 't-1', 't-3')`).run(NOW, NOW, f.ids.projectId, f.box.featureId);
      if (corruption === 'cross_feature') {
        db.prepare(`INSERT INTO features (id, created_at, updated_at, project_id, phase_id, title)
          SELECT 'foreign-feature', created_at, updated_at, project_id, phase_id, 'Foreign' FROM features LIMIT 1`).run();
        db.prepare(`INSERT INTO tasks (id, created_at, updated_at, project_id, feature_id, title, acceptance, execution_config, config_source)
          SELECT 'foreign-task', created_at, updated_at, project_id, 'foreign-feature', title, acceptance, execution_config, config_source FROM tasks WHERE id = 't-1'`).run();
        db.exec('PRAGMA foreign_keys = OFF');
        db.prepare("UPDATE task_dependencies SET depends_on_id = 'foreign-task' WHERE task_id = 't-2'").run();
      }
      if (['empty_scope', 'damaged_scope', 'approval', 'widening'].includes(corruption)) {
        db.exec('DROP TRIGGER execution_batches_immutable_columns_update');
        const config = JSON.parse((db.prepare('SELECT config_snapshot FROM execution_batches').get() as { config_snapshot: string }).config_snapshot);
        if (corruption === 'empty_scope') config.tasks = [];
        if (corruption === 'damaged_scope') config.tasks = 'corrupt';
        if (corruption === 'approval') config.approval.planDigest = 'cd'.repeat(32);
        if (corruption === 'widening') config.tasks.push({ taskId: 'unexpected-task', digest: 'cd'.repeat(32) });
        db.prepare('UPDATE execution_batches SET config_snapshot = ?').run(JSON.stringify(config));
      }
      if (corruption === 'input') {
        db.exec('DROP TRIGGER runs_immutable_columns_update');
        const input = JSON.parse((db.prepare('SELECT input_snapshot FROM runs').get() as { input_snapshot: string }).input_snapshot);
        input.planDigest = 'cd'.repeat(32);
        db.prepare('UPDATE runs SET input_snapshot = ?').run(JSON.stringify(input));
      }
      expect(f.evaluate()).toMatchObject({ reason: 'invalid_graph', readyTaskIds: [], handoff: null });
      expect(f.evaluate().diagnostic).not.toBeNull();
    } finally { f.box.close(); }
  });

  it('holds one SQLite snapshot across a concurrent blocker commit', async () => {
    const f = await fixture();
    const other = new Database(f.box.box.dbPath);
    const db = f.box.session.database, original = db.prepare.bind(db);
    let changed = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
      if (sql.includes('FROM execution_batches') && !changed) {
        changed = true;
        other.prepare("UPDATE tasks SET manual_block = 1 WHERE id = 't-1'").run();
      }
      return original(sql);
    });
    try {
      expect(f.evaluate().readyTaskIds).toEqual(['t-1']);
      expect(changed).toBe(true);
      expect(f.evaluate().reason).toBe('waiting_approval');
    } finally { spy.mockRestore(); other.close(); f.box.close(); }
  });

  it('diagnoses malformed stored JSON without escaping the result contract', async () => {
    const f = await fixture();
    try {
      const db = f.box.session.database;
      db.exec('DROP TRIGGER execution_batches_immutable_columns_update; PRAGMA ignore_check_constraints = ON');
      db.prepare("UPDATE execution_batches SET scope_snapshot = '{'").run();
      expect(f.evaluate()).toMatchObject({ reason: 'invalid_graph', diagnostic: 'corrupt_persisted_view', readyTaskIds: [], handoff: null });
    } finally { f.box.close(); }
  });

  it('requires current approval policy and Task total-attempt allowance', async () => {
    const f = await fixture();
    try {
      const db = f.box.session.database;
      db.prepare("UPDATE global_settings SET payload = json_set(payload, '$.policies.executionLimits', json(?))")
        .run(JSON.stringify({ maxAttemptsPerTask: 1 }));
      db.prepare("UPDATE tasks SET attempt_counter = 1 WHERE id = 't-1'").run();
      expect(f.evaluate().reason).toBe('budget_exhausted');
      db.prepare("UPDATE global_settings SET payload = json_set(payload, '$.policies.verification', json(?))")
        .run(JSON.stringify({ requireChecksBeforeDone: true }));
      expect(f.evaluate()).toMatchObject({ reason: 'waiting_approval', diagnostic: 'check_policy_changed' });
    } finally { f.box.close(); }
  });

  it('upgrades a populated v14 Task to v15 without changing its previous fields or migration evidence', async () => {
    const sandbox = createTempSandbox('shiploop-f002-upgrade-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 14) });
      const db = session.database;
      db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES ('project-1', ?, ?, 'Old')").run(NOW, NOW);
      db.prepare("INSERT INTO phases (id, project_id, created_at, updated_at, title) VALUES ('phase-1', 'project-1', ?, ?, 'Old')").run(NOW, NOW);
      db.prepare("INSERT INTO features (id, project_id, phase_id, created_at, updated_at, title) VALUES ('feature-1', 'project-1', 'phase-1', ?, ?, 'Old')").run(NOW, NOW);
      db.prepare(`INSERT INTO tasks (id, project_id, feature_id, created_at, updated_at, title, acceptance, execution_config, config_source)
        VALUES ('task-1', 'project-1', 'feature-1', ?, ?, 'Old', '{"criteria":["test"]}', '{"schemaVersion":2}', 'user_override')`).run(NOW, NOW);
      const task = db.prepare<[], Record<string, unknown>>('SELECT * FROM tasks').get();
      const migrations = db.prepare('SELECT * FROM schema_migrations').all();
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([15, 16, 17, 18]);
      expect(db.prepare('SELECT * FROM tasks').get()).toEqual({ ...task, kind: 'coding', manual_block: 0 });
      expect(db.prepare('SELECT * FROM schema_migrations WHERE version <= 14').all()).toEqual(migrations);
      expect(() => db.prepare("UPDATE tasks SET kind = 'runtime'").run()).toThrow();
      expect(() => db.prepare('UPDATE tasks SET manual_block = 1.5').run()).toThrow();
      expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
    } finally { session.close(); sandbox.cleanup(); }
  });

  it('freezes v1-v14 checksums while appending the Task kind/manual block migration', () => {
    expect(SQLITE_MIGRATIONS[14]?.version).toBe(15);
    expect(createHash('sha256').update(SQLITE_MIGRATIONS.slice(0, 14).map(m => m.checksum).join('\n')).digest('hex'))
      .toBe('a40bab7fd76d55e42472425df6057b88b8ff7411c47564d95fef87041294cf96');
  });
});
