import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteRunDispatchSettlement } from '../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { createWorkStartupRecovery } from '../../../packages/core/src/application/work-startup-recovery.ts';
import { openProcessRecoveryFixture } from '../../helpers/process-recovery-matrix.ts';
import { withProcessMatrix } from '../../helpers/process-matrix.ts';
import { BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';

type Fixture = Awaited<ReturnType<typeof openProcessRecoveryFixture>>;
const budgets = (f: Fixture) => f.query('SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');
function expectState(f: Fixture, state: string, leases: number) {
  expect(f.query('SELECT state FROM run_dispatch_claims')).toEqual({ state });
  expect(f.query('SELECT state FROM execution_slot_claims')).toEqual({ state });
  expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: leases });
}
function unstarted(f: Fixture) {
  f.session.database.prepare('DELETE FROM sessions').run();
  f.session.database.prepare("UPDATE attempts SET status = 'preparing', execution_stage = 'preflight', started_at = NULL").run();
}
function resume(f: Fixture) {
  const run = f.query('SELECT revision FROM runs WHERE id = ?', f.runId) as { revision: number };
  const workspace = f.query('SELECT id, revision FROM managed_workspaces') as { id: string; revision: number };
  return f.session.transactWrite('test.explicit-resume', () => createSqliteExecutionAccess(f.session, { nowUtcMs: () => NOW + 90_000 })
    .resumeExecutionInTransaction({ projectId: f.projectId, targetKind: 'run', targetId: f.runId,
      expectedRevision: run.revision, workspace: { workspaceId: workspace.id, revision: workspace.revision } }));
}

describe.skipIf(process.platform !== 'darwin')('P04-9 F-007 crash windows', () => {
  it('[case:claim-before-launch] claim 提交后未授权启动可核对释放，保留父预算与通过证据', async () => {
    const f = await openProcessRecoveryFixture(false);
    try {
      unstarted(f);
      f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-2'").run();
      const before = budgets(f);
      const stop = { recoverStop: async () => { throw new Error('unstarted must not signal processes'); } };
      expect((await f.recover(stop)).state.status).toBe('complete');
      expectState(f, 'released', 0);
      const claim = f.query('SELECT * FROM run_dispatch_claims');
      expect((await f.recover(stop)).state.status).toBe('complete');
      expect(f.query('SELECT * FROM run_dispatch_claims')).toEqual(claim);
      expect(budgets(f)).toEqual(before);
      expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'passed' });
    } finally { f.close(); }
  }, 20_000);

  it('[case:authorized-without-receipt] 授权启动后无进程回执，租约过期与反复重启不证明停止', async () => {
    const f = await openProcessRecoveryFixture();
    try {
      f.advance(90_000);
      for (let restart = 0; restart < 2; restart++) {
        const result = await f.recover({ recoverStop: async () => { throw new Error('no durable identity to signal'); } });
        expect(result.state.status).toBe('blocked');
        expect(result.evidence.gaps).toContain('process_identity_missing');
        expectState(f, 'quarantined', 3);
        expect(f.query('SELECT execution_version FROM tasks WHERE id = ?', 't-1')).toEqual({ execution_version: 2 });
      }
    } finally { f.close(); }
  }, 20_000);

  it('[case:recorded-with-missing-workspace] 已有停止观察但持久工作区关联丢失，重启不能漏掉仍隔离的组', async () => {
    const f = await openProcessRecoveryFixture();
    try {
      expect((await f.recover()).state.status).toBe('blocked');
      f.session.database.prepare('DELETE FROM managed_workspaces').run();
      f.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'restart_recovery' WHERE id = ?").run(f.runId);
      expect((await f.recover()).state.status).toBe('blocked');
      expectState(f, 'quarantined', 3);
    } finally { f.close(); }
  }, 20_000);

  it('[case:terminal-receipt-before-dispatch-settlement] 已停止并保留的终态 Attempt 只释放遗留消费者，不改写通过或提交事实', async () => {
    const f = await openProcessRecoveryFixture();
    try {
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      f.session.database.prepare("UPDATE attempts SET status = 'succeeded', ended_at = ?, code_ref = ?, exit_code = 0").run(NOW, f.requirementArtifactId);
      f.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-1'").run();
      f.session.database.prepare("UPDATE managed_workspaces SET status = 'retained'").run();
      const attempts = f.session.database.prepare('SELECT * FROM attempts').all();
      const tasks = f.session.database.prepare('SELECT * FROM tasks ORDER BY id').all();
      const before = budgets(f);
      const startup = createWorkStartupRecovery({ store: createSqliteWorkStartupRecoveryStore(f.session, { nowUtcMs: () => NOW }),
        process: {}, publishEvidence: async () => { throw new Error('terminal facts must be preserved'); } });
      expect((await startup.recover()).status).toBe('complete');
      expectState(f, 'released', 0);
      expect(f.session.database.prepare('SELECT * FROM attempts').all()).toEqual(attempts);
      expect(f.session.database.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasks);
      expect(budgets(f)).toEqual(before);
    } finally { f.close(); }
  }, 20_000);

  it.each(['dispatch-link', 'legacy-resource-group'])('[case:corrupt-%s] 持久关联缺失时 fail-closed 保留认领和资源', async fault => {
    const f = await openProcessRecoveryFixture(false);
    try {
      unstarted(f);
      if (fault === 'dispatch-link') {
        // Deliberate on-disk corruption: normal command paths cannot mutate immutable receipts.
        f.session.database.exec('DROP TRIGGER task_claim_receipts_immutable_update');
        f.session.database.prepare("UPDATE task_claim_receipts SET receipt = json_remove(receipt, '$.dispatch')").run();
      } else {
        f.session.database.prepare("DELETE FROM workspace_leases WHERE resource_kind = 'workspace'").run();
      }
      const result = await f.recover();
      expect(result.state.status).toBe('blocked');
      expect(f.query('SELECT state FROM run_dispatch_claims')).toEqual({ state: 'quarantined' });
      expect(f.query('SELECT state FROM execution_slot_claims')).toEqual({ state: 'quarantined' });
      expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
    } finally { f.close(); }
  }, 20_000);

  it.each(['valid', 'missing-receipt'])('[case:legacy-three-leases-%s] v33 前的三组租约仍需原 claim 回执与未启动/现场核对', async mode => {
    const f = await openProcessRecoveryFixture(false);
    try {
      unstarted(f);
      f.session.database.exec('DROP TRIGGER task_claim_receipts_immutable_update');
      f.session.database.prepare("UPDATE task_claim_receipts SET receipt = json_remove(receipt, '$.dispatch')").run();
      f.session.database.prepare('DELETE FROM execution_slot_claims').run();
      f.session.database.prepare('DELETE FROM run_dispatch_claims').run();
      if (mode === 'missing-receipt') {
        f.session.database.exec('DROP TRIGGER task_claim_receipts_immutable_delete');
        f.session.database.prepare('DELETE FROM task_claim_receipts').run();
        expect((await f.recover()).state.status).toBe('blocked');
        expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 3 });
        expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
      } else {
        expect((await f.recover()).state.status).toBe('complete');
        expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 0 });
        expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'retained' });
      }
    } finally { f.close(); }
  }, 20_000);

  it('[case:reconciliation-rollback] 槽位释放故障使整组恢复回滚，下一次重启复用停止证据并安全释放', async () => {
    const f = await openProcessRecoveryFixture(false);
    try {
      unstarted(f);
      const before = budgets(f);
      f.session.database.exec(`CREATE TRIGGER fail_recovery_release BEFORE UPDATE OF state ON execution_slot_claims
        WHEN NEW.state = 'released' BEGIN SELECT RAISE(ABORT, 'injected_recovery_release_fault'); END`);
      expect((await f.recover()).state).toEqual({ status: 'blocked', reason: 'recovery_failed' });
      expectState(f, 'quarantined', 3);
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'interrupted' });
      f.session.database.exec('DROP TRIGGER fail_recovery_release');
      expect((await f.recover()).state.status).toBe('complete');
      expectState(f, 'released', 0);
      expect(budgets(f)).toEqual(before);
    } finally { f.close(); }
  }, 20_000);

  it('[case:snapshot-drift] 异步核对后持久快照变化拒绝释放，取消状态不被恢复重开', async () => {
    const f = await openProcessRecoveryFixture(false);
    try {
      unstarted(f);
      const result = await f.recover(undefined, async () => {
        f.session.database.prepare("UPDATE runs SET status = 'cancelling', revision = revision + 1 WHERE id = ?").run(f.runId);
      });
      expect(result.state).toEqual({ status: 'blocked', reason: 'recovery_failed' });
      expectState(f, 'quarantined', 3);
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'cancelling' });
      expect(() => resume(f)).toThrow();
    } finally { f.close(); }
  }, 20_000);

  it('[case:process-started-before-receipt] 真实进程已写入但回执未落库，不凭无 PID 释放槽位或再派发', async () => {
    const manifest = await withProcessMatrix('p049-missing-process-receipt', async matrix => {
      const f = await openProcessRecoveryFixture();
      try {
        const handle = await matrix.start('stubborn');
        await matrix.writersReady();
        const result = await f.recover();
        expect(result.state.status).toBe('blocked');
        expect(await matrix.members(handle.identity)).not.toEqual([]);
        expectState(f, 'quarantined', 3);
        expect(() => resume(f)).toThrow();
        matrix.resource({ gaps: result.evidence.gaps });
      } finally { f.close(); }
    });
    expect(manifest.processesGone).toBe(true);
  }, 30_000);

  it('[case:result-before-settlement] 结果已到但未结算先停止真实写入组，核对后释放；新代次拒绝旧 owner', async () => {
    const manifest = await withProcessMatrix('p049-result-before-settlement', async matrix => {
      const f = await openProcessRecoveryFixture();
      try {
        const handle = await matrix.start('stubborn', { confirm: async processIdentity => {
          f.session.transactWrite('test.persist-process', () => f.createResources().confirmLaunchInTransaction(f.identity, processIdentity));
        } });
        await matrix.writersReady();
        f.session.database.prepare('UPDATE attempts SET code_ref = ?, exit_code = 0 WHERE id = ?')
          .run(f.requirementArtifactId, f.claimed.receipt.attempt.id);
        const beforeBudget = budgets(f);
        f.advance(90_000);
        const result = await f.recover();
        expect(result.state.status).toBe('complete');
        expect(result.evidence.status).toBe('reconciled');
        expect(await matrix.members(handle.identity)).toEqual([]);
        expectState(f, 'released', 0);
        expect(f.query('SELECT status, code_ref, exit_code FROM attempts'))
          .toEqual({ status: 'interrupted', code_ref: f.requirementArtifactId, exit_code: 0 });
        expect(budgets(f)).toEqual(beforeBudget);
        expect((await f.recover()).state.status).toBe('complete');
        const old = f.claimed.receipt;
        const expected = { claimId: old.dispatch!.claimId, claimVersion: old.dispatch!.claimVersion,
          ownerId: old.attempt.owner, hostInstanceId: old.attempt.hostInstanceId };
        const attemptFence = { attemptId: old.attempt.id, executionVersion: old.attempt.executionVersion,
          ownerId: old.attempt.owner, hostInstanceId: old.attempt.hostInstanceId };
        resume(f);
        const next = f.claimTask('t-2').receipt;
        expect(next.dispatch).toMatchObject({ claimVersion: 2 });
        const before = f.query('SELECT * FROM execution_slot_claims WHERE id = ?', next.dispatch!.slotId);
        const port = createSqliteRunDispatchSettlement(f.session, { nowUtcMs: () => NOW + 90_000 });
        expect(() => f.session.transactWrite('test.late-settle', () => port.settleInTransaction({ projectId: f.projectId, runId: f.runId, expected, attempt: attemptFence })))
          .toThrow(expect.objectContaining({ details: { reason: 'stale_dispatch_identity' } }));
        expect(() => f.session.transactWrite('test.late-renew', () => port.renewInTransaction({ projectId: f.projectId, runId: f.runId, expected, attempt: attemptFence, leaseUntilUtcMs: NOW + 190_000 })))
          .toThrow(expect.objectContaining({ details: { reason: 'stale_dispatch_identity' } }));
        const late = createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 90_000 }).apply({
          ...f.identity, runId: f.runId, taskId: 't-1', notificationId: randomUUID(), kind: 'runtime_completed', exitCode: 0, evidenceRef: f.requirementArtifactId,
        });
        expect(late.disposition).toBe('ignored');
        expect(f.query('SELECT * FROM execution_slot_claims WHERE id = ?', next.dispatch!.slotId)).toEqual(before);
        matrix.resource({ state: result.state, old: old.dispatch, next: next.dispatch });
      } finally { f.close(); }
    });
    expect(manifest.processesGone).toBe(true);
    expect(manifest.removed).toBe(true);
  }, 30_000);
});
