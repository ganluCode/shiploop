import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/index.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { acquireInput, openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';
import { publishPreparedInputFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';

function identity(attempt: { projectId: string; id: string; owner: string; hostInstanceId: string; executionVersion: number }) {
  return { projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
}

function durable(f: Awaited<ReturnType<typeof openClaimFixture>>) {
  return { ...f.snapshot(), ...Object.fromEntries(['run_dispatch_claims', 'execution_slot_claims', 'run_dispatch_intents']
    .map(table => [table, f.box.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])) };
}

describe('P04-9 F-004 atomic dispatch and Task claim', () => {
  it.each([
    ['claim', 'AFTER INSERT ON run_dispatch_claims'],
    ['slot', 'AFTER INSERT ON execution_slot_claims'],
    ['task', "AFTER UPDATE ON tasks WHEN NEW.status = 'running'"],
    ['attempt', 'AFTER INSERT ON attempts'],
    ['budget', 'AFTER INSERT ON task_attempt_reservations'],
    ['resources', 'AFTER INSERT ON workspace_leases'],
    ['event', "AFTER INSERT ON state_events WHEN NEW.event_type = 'task.claimed'"],
    ['receipt', 'AFTER INSERT ON task_claim_receipts'],
  ])('[case:rollback-%s] 故障边界整组回滚，无半个归属、槽位或预算', async (_, boundary) => {
    const f = await openClaimFixture();
    try {
      const before = durable(f);
      f.box.session.database.exec(`CREATE TRIGGER dispatch_fault ${boundary} BEGIN SELECT RAISE(ABORT, 'injected dispatch fault'); END`);
      expect(() => f.store().claimTask(f.input())).toThrow();
      expect(durable(f)).toEqual(before);
    } finally { f.box.close(); }
  });

  it('[case:cross-process-claim] 两个真实消费者竞争同 Run，恰好一份认领、槽位和 Attempt 预占', async () => {
    const f = await openClaimFixture();
    const environment = createIsolatedHostEnvironment();
    try {
      const results = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('../../helpers/p03-4/task-claim-race-child.ts', import.meta.url)),
        configs: [0, 1].map(i => ({ dbPath: f.box.box.dbPath, root: f.box.box.root, path: f.box.box.repoDirA,
          now: NOW, input: { ...f.input(), workspace: undefined, claimKey: `racer-${i}`, owner: `owner-${i}` } })),
      });
      expect(results.filter(r => r.result.ok)).toHaveLength(1);
      const snapshot = durable(f);
      for (const table of ['run_dispatch_claims', 'execution_slot_claims', 'attempts', 'task_attempt_reservations', 'task_claim_receipts']) {
        expect(snapshot[table]).toHaveLength(1);
      }
      expect(snapshot.runtime_start_reservations).toHaveLength(0);
      expect(f.box.session.database.prepare('SELECT attempts_created FROM runs').get()).toEqual({ attempts_created: 1 });
    } finally { await environment.dispose(); f.box.close(); }
  }, 60_000);

  it('[case:reuse-run-slot] 同 Run 后续 Task 复用同一归属和槽位，各自保留 Attempt 和原有额度', async () => {
    const f = await openClaimFixture([[], []]);
    try {
      const first = f.store().claimTask(f.input()).receipt;
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      f.box.session.transactWrite('test.safe-unstarted', () => {
        resources.releaseUnstartedInTransaction(identity(first.attempt));
        f.box.session.database.prepare("UPDATE attempts SET status = 'interrupted', ended_at = ? WHERE id = ?").run(NOW, first.attempt.id);
        f.box.session.database.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(first.attempt.taskId);
      });
      const ready = durable(f);
      for (const patch of [{ claimVersion: 2 }, { slotId: 'stale-slot' }, { claimId: 'stale-claim' }]) {
        expect(() => f.store().claimTask({ ...f.input(1), dispatch: { ...first.dispatch!, ...patch } }))
          .toThrow(expect.objectContaining({ details: { reason: 'stale_dispatch_identity' } }));
        expect(durable(f)).toEqual(ready);
      }
      expect(() => f.store().claimTask({ ...f.input(1), owner: 'stale-owner' }))
        .toThrow(expect.objectContaining({ details: { reason: 'dispatch_owner_mismatch' } }));
      expect(durable(f)).toEqual(ready);
      const second = f.store().claimTask({ ...f.input(1), leaseUntilUtcMs: NOW + 2000, dispatch: first.dispatch }).receipt;
      expect(second.dispatch).toEqual(first.dispatch);
      expect(second.attempt.id).not.toBe(first.attempt.id);
      expect(second.counts).toMatchObject({ batchAttempts: 2, runAttempts: 2, taskAttempts: 1 });
      expect(durable(f).execution_slot_claims).toHaveLength(1);
      expect(durable(f).run_dispatch_claims).toHaveLength(1);
      expect(durable(f).task_attempt_reservations).toHaveLength(2);
      expect(() => f.box.session.transactWrite('test.nested', () => f.store().claimTask(f.input(1)))).toThrow(TypeError);
    } finally { f.box.close(); }
  });

  it.each([
    ['pause', "UPDATE runs SET pause_requested_at = 1900000100000"],
    ['authorization', "UPDATE features SET plan_status = 'draft'"],
    ['owner', 'SELECT 1'],
    ['task-version', 'UPDATE tasks SET execution_version = execution_version + 1'],
    ['slot-released', "UPDATE execution_slot_claims SET state = 'released', released_at = 1900000100000"],
    ['claim-quarantined', "UPDATE run_dispatch_claims SET state = 'quarantined', reason = 'uncertain', settled_at = 1900000100000"],
  ])('[case:launch-drift-%s] 准备后状态漂移拒绝启动并保留回执', async (reason, sql) => {
    const f = await openClaimFixture();
    try {
      const { receipt } = f.store().claimTask(f.input());
      f.box.session.database.exec(sql);
      const before = durable(f);
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      const launchIdentity = { ...identity(receipt.attempt), ...(reason === 'owner' ? { owner: 'changed-owner' } : {}) };
      expect(() => f.box.session.transactWrite('test.drift-launch', () => resources.beginLaunchInTransaction(launchIdentity)))
        .toThrow();
      expect(durable(f)).toEqual(before);
    } finally { f.box.close(); }
  });

  it('[case:expired-receipt] 过期回执仅可重放证据，不能重新授权启动', async () => {
    const f = await openClaimFixture();
    try {
      const first = f.store().claimTask(f.input());
      f.box.reopen();
      const before = durable(f);
      const expired = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 2000 });
      expect(expired.claimTask(f.input())).toEqual({ replayed: true, receipt: first.receipt });
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 2000 });
      const launched = f.box.session.transactWrite('test.expired-launch', () => resources.beginLaunchInTransaction(identity(first.receipt.attempt)));
      expect(launched.authorized).toBe(false);
      expect(durable(f).task_claim_receipts).toEqual(before.task_claim_receipts);
      expect(durable(f).attempts).toEqual(before.attempts);
      expect(durable(f).runtime_start_reservations).toEqual([]);
    } finally { f.box.close(); }
  });
  it('[case:capacity-rolls-back-attempt] 其他 Run 已占唯一槽位时，Task/预算/租约/回执整组回滚', async () => {
    const { maxCostTotal: _cost, maxTokenTotal: _tokens, ...batch } = BUDGET.batch;
    const f = await openSlotFixture({ ...BUDGET, batch });
    try {
      f.box.session.transactWrite('test.other-run-slot', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const db = f.box.session.database;
      const ids = db.prepare<[string], { batchId: string; runId: string }>('SELECT batch_id AS batchId, id AS runId FROM runs WHERE id = ?').get(f.runB.runId)!;
      const inputSnapshot = publishPreparedInputFixture({ ...f.box, featureId: f.runB.featureId }, ids, 't-peer');
      const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root] });
      const workspace = await authority.verify(createSqliteStateAccess(f.box.session).getRepositoryBinding(f.projectId), f.box.box.repoDirA);
      const tables = ['tasks', 'attempts', 'runs', 'execution_batches', 'workspace_leases', 'state_events',
        'task_claim_receipts', 'run_dispatch_claims', 'execution_slot_claims', 'task_attempt_reservations', 'runtime_start_reservations'];
      const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
      const before = snapshot();
      const store = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
      expect(() => store.claimTask({ claimKey: 'capacity-loser', projectId: f.projectId, runId: f.runB.runId,
        taskId: 't-peer', owner: 'owner-b', hostInstanceId: 'host-b', expectedRevision: 1, executionVersion: 0,
        leaseUntilUtcMs: NOW + 1000, inputSnapshot, workspace }))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'execution_slot_unavailable' }) }));
      expect(snapshot()).toEqual(before);
    } finally { f.close(); }
  });

  it('[case:claim-commit-replay] 提交回执持久绑定独立 Run 代次和 Attempt，重放不重复占槽或记账', async () => {
    const f = await openClaimFixture();
    try {
      const first = f.store().claimTask(f.input());
      expect(first.receipt).toMatchObject({ dispatch: { claimVersion: 1, claimId: expect.any(String), slotId: expect.any(String) } });
      expect(f.box.session.database.inTransaction).toBe(false);
      const db = f.box.session.database;
      const rows = () => Object.fromEntries(['run_dispatch_claims', 'execution_slot_claims', 'attempts',
        'task_attempt_reservations', 'runtime_start_reservations', 'task_claim_receipts'].map(table =>
        [table, db.prepare(`SELECT * FROM ${table}`).all()]));
      const before = rows();
      expect(before.run_dispatch_claims).toHaveLength(1);
      expect(before.execution_slot_claims).toHaveLength(1);
      expect(before.task_attempt_reservations).toHaveLength(1);
      expect(before.runtime_start_reservations).toHaveLength(0);
      expect(f.store().claimTask(f.input())).toEqual({ replayed: true, receipt: first.receipt });
      expect(rows()).toEqual(before);
    } finally { f.box.close(); }
  });

  it('[case:slot-required-at-launch] claim 已提交但槽位隔离后禁止启动，保留 Attempt 和归属证据', async () => {
    const f = await openClaimFixture();
    try {
      const { receipt } = f.store().claimTask(f.input());
      f.box.session.database.exec("UPDATE execution_slot_claims SET state = 'quarantined', reason = 'test_uncertain'");
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
      expect(() => f.box.session.transactWrite('test.launch', () => resources.beginLaunchInTransaction(identity(receipt.attempt))))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.box.session.database.prepare('SELECT invocation_id FROM attempts').get()).toEqual({ invocation_id: null });
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM task_claim_receipts').get()).toEqual({ n: 1 });
    } finally { f.box.close(); }
  });
});
