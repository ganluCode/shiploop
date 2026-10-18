import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { persistVerifiedPassFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import { join } from 'node:path';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { createHash } from 'node:crypto';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';

describe('F-004 atomic Task claim', () => {
  it('commits one preparing Attempt, fencing, cumulative reservations, three gates and a public event', async () => {
    const f = await openClaimFixture();
    try {
      const verify = vi.spyOn(f.authority, 'verify');
      const result = f.store().claimTask(f.input());
      expect(result.replayed).toBe(false);
      expect(verify).not.toHaveBeenCalled();
      expect(f.box.session.database.inTransaction).toBe(false);
      expect(result.receipt.attempt).toMatchObject({ status: 'preparing', executionStage: 'preflight', number: 1,
        executionVersion: 1, sessionId: null, invocationId: null, startedAtUtcMs: null, usageSummary: null });
      expect(result.receipt.leases.map(l => l.resourceKind)).toEqual(['global', 'project', 'workspace']);
      expect(result.receipt.counts).toEqual({ batchAttempts: 1, runAttempts: 1, taskAttempts: 1, codeAttempts: 1 });
      expect(f.box.session.database.prepare('SELECT status, execution_version, attempt_counter FROM tasks').get())
        .toEqual({ status: 'running', execution_version: 1, attempt_counter: 1 });
      expect(f.box.session.database.prepare('SELECT runtime_starts FROM execution_batches').get()).toEqual({ runtime_starts: 0 });
      expect(f.box.session.database.prepare('SELECT * FROM runtime_start_reservations').all()).toEqual([]);
      const row = f.box.session.database.prepare('SELECT * FROM state_events WHERE event_type = ?').get('task.claimed') as Record<string, unknown>;
      expect(mapStateEvent({ id: row.id, sequence: row.sequence, projectId: row.project_id, eventType: row.event_type,
        aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateRevision: row.aggregate_revision,
        payload: JSON.parse(String(row.payload)), occurredAtUtcMs: row.occurred_at } as never))
        .toMatchObject({ type: 'task.claimed', aggregate: { type: 'task', id: 't-1' }, payload: { claimed: true } });
    } finally { f.box.close(); }
  });

  it('replays the immutable receipt after reopen without renewing or debiting, and rejects reused identity', async () => {
    const f = await openClaimFixture();
    try {
      const first = f.store().claimTask(f.input());
      const before = f.snapshot();
      f.box.reopen();
      expect(f.store().claimTask(f.input())).toEqual({ replayed: true, receipt: first.receipt });
      expect(createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 2000 })
        .claimTask(f.input())).toEqual({ replayed: true, receipt: first.receipt });
      expect(f.snapshot()).toEqual(before);
      expect(() => f.store().claimTask({ ...f.input(), owner: 'other' })).toThrow(expect.objectContaining({
        kind: 'conflict', details: { reason: 'claim_key_reused' },
      }));
      expect(f.snapshot()).toEqual(before);
      expect(() => f.box.session.transactWrite('nested', () => f.store().claimTask(f.input()))).toThrow(TypeError);
    } finally { f.box.close(); }
  });

  it.each([
    ['task', "AFTER UPDATE ON tasks WHEN NEW.status = 'running'"],
    ['attempt', 'AFTER INSERT ON attempts'],
    ['budget', 'AFTER INSERT ON task_attempt_reservations'],
    ['resources', 'AFTER INSERT ON workspace_leases'],
    ['event', "AFTER INSERT ON state_events WHEN NEW.event_type = 'task.claimed'"],
    ['receipt', 'AFTER INSERT ON task_claim_receipts'],
  ])('rolls back all durable writes at the %s boundary', async (_, boundary) => {
    const f = await openClaimFixture();
    try {
      const before = f.snapshot();
      f.box.session.database.exec(`CREATE TRIGGER claim_fault ${boundary} BEGIN SELECT RAISE(ABORT, 'injected fault'); END`);
      expect(() => f.store().claimTask(f.input())).toThrow();
      expect(f.snapshot()).toEqual(before);
      f.box.session.database.exec('DROP TRIGGER claim_fault');
      expect(f.store().claimTask(f.input()).receipt.counts.taskAttempts).toBe(1);
    } finally { f.box.close(); }
  });

  it.each([
    ['manual blocker', "UPDATE tasks SET manual_block = 1", 'not_ready'],
    ['approval', "UPDATE features SET plan_status = 'draft'", 'not_ready'],
    ['run control', "UPDATE runs SET status = 'paused'", 'not_ready'],
    ['batch control', "UPDATE execution_batches SET status = 'cancelling'", 'not_ready'],
    ['project', "UPDATE projects SET status = 'archiving'", 'not_ready'],
    ['input', "UPDATE artifacts SET status = 'failed' WHERE id = 't-1-prompt'", 'not_ready'],
    ['input content', "UPDATE artifacts SET content_hash = '" + 'cd'.repeat(32) + "' WHERE id = 't-1-prompt'", 'not_ready'],
    ['input locator', "UPDATE artifacts SET storage_locator = 'replaced/input' WHERE id = 't-1-prompt'", 'not_ready'],
    ['budget', 'UPDATE execution_batches SET attempts_created = 2', 'not_ready'],
    ['run budget', 'UPDATE runs SET attempts_created = 2', 'not_ready'],
    ['task budget', 'UPDATE tasks SET code_attempts_used = 3, attempt_counter = 3', 'not_ready'],
    ['fence', 'UPDATE tasks SET execution_version = 1', 'stale_task'],
    ['revision', 'UPDATE tasks SET revision = revision + 1', 'stale_task'],
    ['binding', 'UPDATE repository_bindings SET revision = revision + 1', 'repository_binding_changed'],
  ])('rechecks %s after an advisory ready query with zero writes', async (_, sql, reason) => {
    const f = await openClaimFixture();
    try {
      expect(f.evaluate().readyTaskIds).toEqual(['t-1']);
      f.box.session.database.exec(sql);
      const before = f.snapshot();
      expect(() => f.store().claimTask(f.input())).toThrow(expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason }) }));
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('rechecks dependency evidence and newly acquired global occupancy', async () => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      const before = f.snapshot();
      expect(() => f.store().claimTask(f.input(1))).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'not_ready' }) }));
      expect(f.snapshot()).toEqual(before);
      f.store().claimTask(f.input());
      const occupied = f.snapshot();
      expect(() => f.store().claimTask({ ...f.input(), claimKey: 'other', expectedRevision: 3, executionVersion: 1 }))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'resource_busy' }) }));
      expect(f.snapshot()).toEqual(occupied);
    } finally { f.box.close(); }
  });

  it.each(['failed', 'skipped', 'cancelled', 'missing_evidence'])('rechecks a formerly valid dependency (%s)', async status => {
    const f = await openClaimFixture([[], ['t-1']]);
    try {
      persistVerifiedPassFixture(f.box, f.ids, 't-1', f.input().inputSnapshot);
      expect(f.evaluate().readyTaskIds).toEqual(['t-2']);
      if (status === 'missing_evidence') f.box.session.database.prepare('DELETE FROM attempts').run();
      else f.box.session.database.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, 't-1');
      const before = f.snapshot();
      expect(() => f.store().claimTask(f.input(1))).toThrow(expect.objectContaining({
        kind: 'conflict', details: expect.objectContaining({ reason: 'not_ready' }),
      }));
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('rechecks the trusted permissions face synchronously inside the transaction', async () => {
    const f = await openClaimFixture();
    try {
      const before = f.snapshot();
      const store = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW,
        permissions: () => {
          expect(f.box.session.database.inTransaction).toBe(true);
          return { grants: ['changed'] };
        },
      });
      expect(() => store.claimTask(f.input())).toThrow(expect.objectContaining({
        kind: 'conflict', details: { reason: 'not_ready', eligibility: 'permissions_changed' },
      }));
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('validates untrusted fields, prepared identities and opaque workspace authority', async () => {
    const f = await openClaimFixture();
    try {
      const input = f.input();
      const before = f.snapshot();
      for (const patch of [{ owner: '' }, { executionVersion: -1 }, { expectedRevision: 1.5 }, { checkpoint: 'trusted' },
        { workspace: { ...f.workspace } }, { leaseUntilUtcMs: NOW }, { inputSnapshot: { ...input.inputSnapshot, schemaVersion: 99 } }]) {
        expect(() => f.store().claimTask({ ...input, ...patch })).toThrow(expect.objectContaining({ kind: 'validation' }));
      }
      for (const snapshot of [{ ...input.inputSnapshot, taskId: 't-other' },
        { ...input.inputSnapshot, digests: { ...input.inputSnapshot.digests, strategyCopyDigest: 'cd'.repeat(32) } },
        { ...input.inputSnapshot, approval: { ...input.inputSnapshot.approval, decisionId: null } }]) {
        expect(() => f.store().claimTask({ ...input, inputSnapshot: snapshot })).toThrow();
      }
      expect(f.snapshot()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('returns bounded structured busy exhaustion and leaves no partial claim', async () => {
    const f = await openClaimFixture();
    const other = openSqliteStorageSession({ path: f.box.box.dbPath, busyTimeoutMs: 5, busyRetryAttempts: 2 });
    try {
      const before = f.snapshot();
      f.box.session.database.exec('BEGIN IMMEDIATE');
      const start = Date.now();
      expect(() => createSqliteTaskClaimStore(other, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }).claimTask(f.input()))
        .toThrow(expect.objectContaining({ kind: 'busy', details: { attempts: 2, busyTimeoutMs: 5 } }));
      expect(Date.now() - start).toBeLessThan(1000);
      f.box.session.database.exec('ROLLBACK');
      expect(f.snapshot()).toEqual(before);
    } finally { if (f.box.session.database.inTransaction) f.box.session.database.exec('ROLLBACK'); other.close(); f.box.close(); }
  });

  it('a replacement Attempt keeps Batch/Run cumulative budgets and rejects old fencing identities', async () => {
    const f = await openClaimFixture();
    try {
      const first = f.store().claimTask(f.input()).receipt;
      const identity = { projectId: first.attempt.projectId, attemptId: first.attempt.id, owner: first.attempt.owner,
        hostInstanceId: first.attempt.hostInstanceId, executionVersion: first.attempt.executionVersion };
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      f.box.session.transactWrite('test.confirm-unstarted-recovery', () => {
        resources.releaseUnstartedInTransaction(identity);
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW }).reclassifyTaskAttemptAsInfrastructureInTransaction({
          projectId: f.box.projectId, taskId: 't-1', attemptKey: first.attempt.id, reason: 'workspace_prepare_failed',
        });
        f.box.session.database.prepare("UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE id = ?").run(NOW, first.attempt.id);
        f.box.session.database.prepare("UPDATE tasks SET status = 'pending' WHERE id = 't-1'").run();
      });
      f.box.reopen();
      const task = f.box.session.database.prepare('SELECT revision FROM tasks').get() as { revision: number };
      const second = f.store().claimTask({ ...f.input(), claimKey: 'replacement', owner: 'owner-2', hostInstanceId: 'host-2',
        expectedRevision: task.revision, executionVersion: 1 }).receipt;
      expect(second.attempt).toMatchObject({ executionVersion: 2, number: 2 });
      expect(second.counts).toEqual({ batchAttempts: 2, runAttempts: 2, taskAttempts: 2, codeAttempts: 1 });
      const before = f.snapshot();
      const newResources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      expect(() => f.box.session.transactWrite('stale-result', () => newResources.beginLaunchInTransaction(identity)))
        .toThrow(expect.objectContaining({ kind: 'ownership', details: { reason: 'stale_execution_identity' } }));
      expect(f.store().claimTask(f.input())).toEqual({ replayed: true, receipt: first });
      expect(f.snapshot()).toEqual(before);
      f.box.session.transactWrite('test.confirm-second-unstarted', () => {
        newResources.releaseUnstartedInTransaction({ projectId: second.attempt.projectId, attemptId: second.attempt.id,
          owner: second.attempt.owner, hostInstanceId: second.attempt.hostInstanceId, executionVersion: 2 });
        f.box.session.database.prepare("UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE id = ?").run(NOW, second.attempt.id);
        f.box.session.database.prepare("UPDATE tasks SET status = 'pending' WHERE id = 't-1'").run();
      });
      const exhausted = f.snapshot();
      const revision = (f.box.session.database.prepare('SELECT revision FROM tasks').get() as { revision: number }).revision;
      expect(() => f.store().claimTask({ ...f.input(), claimKey: 'third', expectedRevision: revision, executionVersion: 2 }))
        .toThrow(expect.objectContaining({ kind: 'conflict', details: { reason: 'not_ready', eligibility: 'budget_exhausted' } }));
      expect(f.snapshot()).toEqual(exhausted);
    } finally { f.box.close(); }
  });

  it('upgrades populated v15 without changing earlier records/checksums, and keeps receipts immutable', async () => {
    const f = await openClaimFixture();
    const predecessor = openSqliteStorageSession({ path: join(f.box.box.root, 'predecessor.db') });
    try {
      const first = f.store().claimTask(f.input()).receipt;
      await migrateSqliteStorage(predecessor, { migrations: SQLITE_MIGRATIONS.slice(0, 15) });
      const tables = (predecessor.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'sqlite_sequence')")
        .all() as { name: string }[]).map(row => row.name);
      predecessor.transactWrite('test.copy-v15-facts', () => {
        predecessor.database.pragma('defer_foreign_keys = ON');
        for (const table of tables) {
          const columns = (predecessor.database.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[])
            .filter(column => column.hidden === 0).map(column => column.name);
          for (const row of f.box.session.database.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Record<string, unknown>[]) {
            predecessor.database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
              .run(...columns.map(column => row[column]));
          }
        }
      });
      const snapshot = () => Object.fromEntries([...tables, 'schema_migrations'].map(table => [table,
        predecessor.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
      const before = snapshot();
      const failedSql = `${SQLITE_MIGRATIONS[15]!.sql}\nINSERT INTO absent VALUES (1);`;
      await expect(migrateSqliteStorage(predecessor, { migrations: [...SQLITE_MIGRATIONS.slice(0, 15),
        { version: 16, sql: failedSql, checksum: createHash('sha256').update(failedSql).digest('hex') }] }))
        .rejects.toMatchObject({ step: 'apply', version: 16 });
      expect(snapshot()).toEqual(before);
      expect(predecessor.database.prepare("SELECT name FROM sqlite_master WHERE name = 'task_claim_receipts'").all()).toEqual([]);
      expect((await migrateSqliteStorage(predecessor)).appliedVersions).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
      before.state_events = before.state_events!.map(row => ({ ...row as Record<string, unknown>, operation_id: null, run_id: null, attempt_id: null, execution_stage: null }));
      before.features = before.features!.map(row => ({ ...row as Record<string, unknown>, delivery_status: 'not_requested' }));
      before.runs = before.runs!.map(row => ({ ...row as Record<string, unknown>, pause_requested_at: null }));
      before.execution_batches = before.execution_batches!.map(row => ({ ...row as Record<string, unknown>, pause_requested_at: null }));
      expect({ ...snapshot(), schema_migrations: predecessor.database.prepare('SELECT * FROM schema_migrations WHERE version <= 15 ORDER BY id').all() })
        .toEqual(before);
      expect((await migrateSqliteStorage(predecessor)).appliedVersions).toEqual([]);
      expect(predecessor.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(createHash('sha256').update(SQLITE_MIGRATIONS.slice(0, 15).map(m => m.checksum).join('\n')).digest('hex'))
        .toBe('d003bbe480aebf02a67e6a152b66b759794476382a91ab4348597f720a09cb1e');
      expect(() => f.box.session.database.prepare('UPDATE task_claim_receipts SET request_digest = ?').run('cd'.repeat(32)))
        .toThrow(/immutable/);
      expect(() => f.box.session.database.prepare('DELETE FROM task_claim_receipts').run()).toThrow(/immutable/);
      expect(f.store().claimTask(f.input()).receipt).toEqual(first);
    } finally { predecessor.close(); f.box.close(); }
  });

  it.each(['same_task', 'different_tasks', 'idempotent'])('real cross-process competition: %s', async scenario => {
    const different = scenario === 'different_tasks';
    const replay = scenario === 'idempotent';
    const f = await openClaimFixture(different ? [[], []] : [[]]);
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-claim-race-' });
    try {
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p03-4/task-claim-race-child.ts', import.meta.url)),
        configs: [0, different ? 1 : 0].map((index, racer) => ({ dbPath: f.box.box.dbPath, root: f.box.box.root,
          path: f.box.box.repoDirA, now: NOW, input: { ...f.input(index), workspace: undefined,
            claimKey: replay ? 'shared-claim' : `racer-${racer}`, owner: replay ? 'shared-owner' : `owner-${racer}` } })),
      });
      expect(results.filter(r => r.result.ok && !r.result.replayed)).toHaveLength(1);
      if (replay) expect(results.filter(r => r.result.replayed)).toHaveLength(1);
      else expect(results.filter(r => !r.result.ok).map(r => r.result.reason)).toEqual([different ? 'resource_busy' : 'stale_task']);
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM task_attempt_reservations').get()).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM workspace_leases').get()).toEqual({ n: 3 });
      expect(f.box.session.database.prepare("SELECT count(*) AS n FROM state_events WHERE event_type = 'task.claimed'").get()).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT attempts_created FROM execution_batches').get()).toEqual({ attempts_created: 1 });
      expect(f.box.session.database.prepare('SELECT attempts_created FROM runs').get()).toEqual({ attempts_created: 1 });
    } finally { await environment.dispose(); f.box.close(); }
  });
});
