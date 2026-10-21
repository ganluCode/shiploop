/**
 * P03-9 / F-002：Run/Batch 取消意图与终态竞争（真实临时 SQLite）。
 *
 * 验收聚焦：
 * - 合法取消在短事务进入 cancelling（活动执行）或直接 cancelled（无活动且占用
 *   已确认安全），阻止新认领/派发并关联持久停止 operation；
 * - 父进程退出/Runtime 结果不是停止证据：仍有 held/quarantined 占用时只接受请求；
 * - 同 commandId 重放不创建第二个停止 operation；不同 commandId 重复取消复用
 *   同一活动 operation；预算/历史 Attempt 不变；
 * - 完成与取消两种提交顺序均由 revision/非终态 CAS 决定，终态不被迟到覆盖；
 * - queued/running/pausing/paused/interrupted 路径，interrupted 不被释放占用；
 * - Batch 取消传播到活动 Run；迁移 v28 只追加停止 operation 表。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteWorkResourceAccess } from '../../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { PublicError } from '../../../../packages/core/src/ports/commands.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import type { TrustedPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import type { AppCapability, CommandReceipt } from '../../../../packages/core/src/ports/commands.ts';
import type { AttemptRecord } from '../../../../packages/core/src/ports/attempt-store.ts';
import type { WorkResourceIdentity } from '../../../../packages/core/src/ports/work-resources.ts';
import { NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../../helpers/p03-4/task-claim-fixture.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

type Fixture = Awaited<ReturnType<typeof openClaimFixture>>;
type CancelPayload = { readonly runId: string; readonly batchId: null } | { readonly runId: null; readonly batchId: string };

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly revision: number;
  readonly ended_at: number | null;
  readonly pause_requested_at: number | null;
}

interface BatchRow {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly revision: number;
  readonly deadline_at: number;
  readonly budget_revision: number;
  readonly budget_snapshot: string;
  readonly runs_created: number;
  readonly attempts_created: number;
}

interface StopOperationRow {
  readonly id: string;
  readonly project_id: string;
  readonly revision: number;
  readonly command_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly status: string;
  readonly reason: string;
  readonly requested_at: number;
  readonly settled_at: number | null;
}

const readRun = (f: Fixture, runId: string): RunRow =>
  f.box.session.database.prepare('SELECT id, status, reason, revision, ended_at, pause_requested_at FROM runs WHERE id = ?')
    .get(runId) as RunRow;

const readBatch = (f: Fixture, batchId: string): BatchRow =>
  f.box.session.database.prepare(
    'SELECT id, status, reason, revision, deadline_at, budget_revision, budget_snapshot, runs_created, attempts_created ' +
    'FROM execution_batches WHERE id = ?',
  ).get(batchId) as BatchRow;

const readAttempt = (f: Fixture, attemptId: string) =>
  f.box.session.database.prepare('SELECT id, status, revision, ended_at FROM attempts WHERE id = ?')
    .get(attemptId) as { id: string; status: string; revision: number; ended_at: number | null };

const readStopOperations = (f: Fixture): StopOperationRow[] =>
  f.box.session.database.prepare('SELECT * FROM execution_stop_operations ORDER BY created_at, id').all() as StopOperationRow[];

const readLeases = (f: Fixture, attemptId: string) =>
  f.box.session.database.prepare('SELECT resource_key, state, process_identity FROM workspace_leases WHERE owner_id = ? ORDER BY resource_key')
    .all(attemptId) as { resource_key: string; state: string; process_identity: string | null }[];

const cancelEvents = (f: Fixture) =>
  f.box.session.database.prepare(
    "SELECT event_type, aggregate_type, aggregate_id, aggregate_revision FROM state_events " +
    "WHERE event_type LIKE 'execution.run.cancel%' OR event_type LIKE 'execution.batch.cancel%' ORDER BY sequence",
  ).all() as { event_type: string; aggregate_type: string; aggregate_id: string; aggregate_revision: number }[];

const cancelEnvelope = (f: Fixture, payload: CancelPayload, expectedRevision: number, commandId: string = randomUUID()) => ({
  schemaVersion: 5 as const, commandId, issuedAt: new Date(NOW).toISOString(),
  operation: 'execution.cancel', scope: f.box.scope, expectedRevision, payload,
});

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected a completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

const submitCancel = (f: Fixture, payload: CancelPayload, expectedRevision: number, commandId?: string) =>
  f.box.services.commands.submit(f.box.owner, cancelEnvelope(f, payload, expectedRevision, commandId));

const identityOf = (attempt: AttemptRecord): WorkResourceIdentity => ({
  projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
  hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
});

const claimAttempt = (f: Fixture): AttemptRecord => f.store().claimTask(f.input(0)).receipt.attempt;

function expectClaimRejected(f: Fixture, eligibility: string): void {
  try {
    f.store().claimTask({ ...f.input(0), claimKey: randomUUID() });
  } catch (error) {
    const details = (error as { details?: { reason?: string; eligibility?: string } }).details;
    expect(details?.eligibility ?? details?.reason).toBe(eligibility);
    return;
  }
  throw new Error(`预期认领被拒绝（${eligibility}），实际成功`);
}

function insertOtherProject(f: Fixture): void {
  f.box.session.database.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('other-project', ?, 1, ?, 'Other', 'active', '[]')",
  ).run(NOW, NOW);
}

const viewerPrincipal = (): TrustedPrincipal => Object.freeze({
  principalId: 'viewer',
  capabilities: new Set<AppCapability>(),
  projectScope: Object.freeze({ kind: 'all' }) as TrustedPrincipal['projectScope'],
});

describe('P03-9 / F-002 Run/Batch 取消意图与终态竞争', () => {
  it('无活动执行：Run 原子取消、关联已停止 operation、阻止认领且预算/历史不变', async () => {
    const f = await openClaimFixture();
    try {
      const beforeBatch = readBatch(f, f.ids.batchId);
      const receipt = await submitCancel(f, { runId: f.ids.runId, batchId: null }, 1);
      expect(receipt.status).toBe('completed');
      expect(completedResult(receipt)).toMatchObject({
        outcome: 'cancelled', targetKind: 'run', targetId: f.ids.runId,
        status: 'cancelled', changed: true, stopStatus: 'stopped',
      });
      const operationId = completedResult(receipt).stopOperationId as string;
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

      expect(readRun(f, f.ids.runId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', revision: 2, ended_at: NOW,
      });
      expect(readStopOperations(f)).toEqual([expect.objectContaining({
        id: operationId, project_id: f.box.projectId, command_id: receipt.commandId,
        target_kind: 'run', target_id: f.ids.runId, status: 'stopped', reason: 'user_cancel',
        requested_at: NOW, settled_at: NOW,
      })]);
      expect(cancelEvents(f)).toEqual([{
        event_type: 'execution.run.cancelled', aggregate_type: 'run', aggregate_id: f.ids.runId, aggregate_revision: 2,
      }]);

      expect(f.evaluate().reason).toBe('run_not_active');
      expectClaimRejected(f, 'run_not_active');
      const afterBatch = readBatch(f, f.ids.batchId);
      expect(afterBatch).toMatchObject({
        budget_revision: beforeBatch.budget_revision, budget_snapshot: beforeBatch.budget_snapshot,
        deadline_at: beforeBatch.deadline_at, runs_created: beforeBatch.runs_created,
        attempts_created: beforeBatch.attempts_created,
      });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    } finally { f.box.close(); }
  });

  it('父进程已退出但占用仍在：只进入 cancelling，确认占用清空后才 cancelled', async () => {
    const f = await openClaimFixture();
    try {
      const attempt = claimAttempt(f);
      expect(readLeases(f, attempt.id)).toHaveLength(3);
      // “父进程退出/Runtime 结果”不是停止证据：Attempt 已失败但占用仍 held。
      f.box.session.database.prepare("UPDATE attempts SET status = 'failed' WHERE id = ?").run(attempt.id);

      const claimedRevision = readRun(f, f.ids.runId).revision;
      const first = await submitCancel(f, { runId: f.ids.runId, batchId: null }, claimedRevision);
      expect(first).toMatchObject({ status: 'completed' });
      expect(completedResult(first)).toMatchObject({
        outcome: 'cancelling', targetKind: 'run', status: 'cancelling', changed: true, stopStatus: 'stopping',
      });
      const operationId = completedResult(first).stopOperationId as string;
      expect(readRun(f, f.ids.runId)).toMatchObject({
        status: 'cancelling', reason: 'user_cancel', revision: claimedRevision + 1, ended_at: null,
      });
      expect(readLeases(f, attempt.id).every(lease => lease.state === 'held')).toBe(true);
      expect(cancelEvents(f)).toEqual([{
        event_type: 'execution.run.cancelling', aggregate_type: 'run', aggregate_id: f.ids.runId,
        aggregate_revision: claimedRevision + 1,
      }]);
      expect(f.evaluate().reason).toBe('run_control_blocked');

      const second = await submitCancel(f, { runId: f.ids.runId, batchId: null }, claimedRevision + 1);
      expect(completedResult(second)).toMatchObject({
        outcome: 'cancelling', status: 'cancelling', changed: false,
        stopOperationId: operationId, stopStatus: 'stopping',
      });
      expect(readStopOperations(f)).toHaveLength(1);
      expect(cancelEvents(f)).toHaveLength(1);
      expect(readRun(f, f.ids.runId)).toMatchObject({ status: 'cancelling', revision: claimedRevision + 1 });

      // 模拟受控停止核验已确认后释放占用；历史 Attempt 仍保留。
      f.box.session.transactWrite('test.confirm-stop', () => {
        f.box.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
      });
      const third = await submitCancel(f, { runId: f.ids.runId, batchId: null }, claimedRevision + 1);
      expect(completedResult(third)).toMatchObject({
        outcome: 'cancelled', status: 'cancelled', changed: true,
        stopOperationId: operationId, stopStatus: 'stopped',
      });
      expect(readRun(f, f.ids.runId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', revision: claimedRevision + 2, ended_at: NOW,
      });
      expect(readStopOperations(f)).toEqual([expect.objectContaining({
        id: operationId, status: 'stopped', settled_at: NOW, revision: 2,
      })]);
      expect(readAttempt(f, attempt.id)).toMatchObject({ status: 'failed' });
      expect(cancelEvents(f).map(event => event.event_type)).toEqual([
        'execution.run.cancelling', 'execution.run.cancelled',
      ]);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally { f.box.close(); }
  });

  it('interrupted 且占用未确认安全：返回 stop_uncertain、保留状态与占用，不创建 cancelled 事件', async () => {
    const f = await openClaimFixture();
    try {
      const attempt = claimAttempt(f);
      const identity = identityOf(attempt);
      f.box.session.transactWrite('test.interrupt', () => {
        createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW })
          .quarantineInTransaction(identity);
        f.box.session.database.prepare("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(attempt.id);
        f.box.session.database.prepare("UPDATE runs SET status = 'interrupted', reason = 'stop_unconfirmed' WHERE id = ?")
          .run(f.ids.runId);
      });
      const before = readRun(f, f.ids.runId);
      const leasesBefore = readLeases(f, attempt.id);

      const first = await submitCancel(f, { runId: f.ids.runId, batchId: null }, before.revision);
      expect(completedResult(first)).toMatchObject({
        outcome: 'stop_uncertain', targetKind: 'run', status: 'interrupted', changed: false, stopStatus: 'uncertain',
      });
      const operationId = completedResult(first).stopOperationId as string;
      expect(readRun(f, f.ids.runId)).toEqual(before);
      expect(readLeases(f, attempt.id)).toEqual(leasesBefore);
      expect(leasesBefore.every(lease => lease.state === 'quarantined')).toBe(true);
      expect(cancelEvents(f)).toEqual([]);
      expect(readStopOperations(f)).toEqual([expect.objectContaining({
        id: operationId, status: 'uncertain', target_id: f.ids.runId,
      })]);
      expect(f.evaluate().reason).toBe('run_control_blocked');

      const second = await submitCancel(f, { runId: f.ids.runId, batchId: null }, before.revision);
      expect(completedResult(second)).toMatchObject({
        outcome: 'stop_uncertain', status: 'interrupted', stopOperationId: operationId, stopStatus: 'uncertain',
      });
      expect(readStopOperations(f)).toHaveLength(1);
      expect(readLeases(f, attempt.id)).toEqual(leasesBefore);

      const access = createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW });
      expect(() => f.box.session.transactWrite('test.late-success-after-interrupted', () =>
        access.settleExecutionRunOutcomeInTransaction({
          projectId: f.box.projectId, batchId: f.ids.batchId, runId: f.ids.runId,
          resultKey: 'late-interrupted-success', runRevision: before.revision,
          outcome: 'succeeded', reason: 'late', progressEvidence: null,
        }),
      )).toThrow();
      expect(readRun(f, f.ids.runId)).toEqual(before);
    } finally { f.box.close(); }
  });

  it.each(['queued', 'running', 'pausing', 'paused'] as const)(
    '%s 无活动与占用时直接完成取消', async status => {
      const f = await openClaimFixture();
      try {
        f.box.session.database.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, f.ids.runId);
        const receipt = await submitCancel(f, { runId: f.ids.runId, batchId: null }, 1);
        expect(completedResult(receipt)).toMatchObject({
          outcome: 'cancelled', status: 'cancelled', changed: true, stopStatus: 'stopped',
        });
        expect(readRun(f, f.ids.runId)).toMatchObject({
          status: 'cancelled', reason: 'user_cancel', ended_at: NOW,
        });
      } finally { f.box.close(); }
    },
  );

  it('已提交终态不被迟到取消覆盖；同一 commandId 重放与原回执一致', async () => {
    const f = await openClaimFixture();
    try {
      f.box.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ?, reason = 'completed' WHERE id = ?")
        .run(NOW, f.ids.runId);
      const before = readRun(f, f.ids.runId);
      const commandId = randomUUID();
      const receipt = await submitCancel(f, { runId: f.ids.runId, batchId: null }, before.revision, commandId);
      expect(completedResult(receipt)).toMatchObject({
        outcome: 'already_terminal', status: 'succeeded', alreadyTerminal: true, changed: false,
        stopOperationId: null, stopStatus: null,
      });
      expect(readRun(f, f.ids.runId)).toEqual(before);
      expect(readStopOperations(f)).toEqual([]);
      expect(cancelEvents(f)).toEqual([]);

      const replay = await f.box.services.commands.submit(f.box.owner,
        cancelEnvelope(f, { runId: f.ids.runId, batchId: null }, before.revision, commandId));
      expect(replay).toMatchObject({ commandId, status: 'completed', replayed: true, result: completedResult(receipt) });
      expect(readStopOperations(f)).toEqual([]);
      expect(cancelEvents(f)).toEqual([]);
    } finally { f.box.close(); }
  });

  it('同 commandId 重试不创建第二个停止 operation；异摘要/过期 revision/跨项目/无权限均拒绝', async () => {
    const f = await openClaimFixture();
    try {
      const commandId = randomUUID();
      const first = await submitCancel(f, { runId: f.ids.runId, batchId: null }, 1, commandId);
      const operationId = completedResult(first).stopOperationId;
      const eventsAfterFirst = cancelEvents(f);
      const runAfterFirst = readRun(f, f.ids.runId);
      const receiptCount = (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n;

      const replay = await submitCancel(f, { runId: f.ids.runId, batchId: null }, 1, commandId);
      expect(replay).toMatchObject({ status: 'completed', replayed: true, result: completedResult(first) });
      expect(readStopOperations(f)).toHaveLength(1);
      expect(readStopOperations(f)[0]!.id).toBe(operationId);
      expect(readStopOperations(f)[0]!.command_id).toBe(commandId);
      expect(cancelEvents(f)).toEqual(eventsAfterFirst);
      expect(readRun(f, f.ids.runId)).toEqual(runAfterFirst);
      expect((f.box.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n)
        .toBe(receiptCount);

      await expect(submitCancel(f, { batchId: f.ids.batchId, runId: null }, 2, commandId))
        .rejects.toMatchObject({ code: 'conflict', operation: 'execution.cancel' });
      expect(readRun(f, f.ids.runId)).toEqual(runAfterFirst);

      const stale = await submitCancel(f, { runId: f.ids.runId, batchId: null }, 999);
      expect(stale).toMatchObject({
        status: 'rejected',
        error: { code: 'conflict', details: { reason: 'stale_revision', entityType: 'run' } },
      });
      expect(readStopOperations(f)).toHaveLength(1);

      insertOtherProject(f);
      await expect(f.box.services.commands.submit(f.box.owner, {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
        operation: 'execution.cancel', scope: { kind: 'project', projectId: 'other-project' },
        expectedRevision: 1, payload: { runId: f.ids.runId, batchId: null },
      })).rejects.toBeInstanceOf(PublicError);
      await expect(f.box.services.commands.submit(viewerPrincipal(),
        cancelEnvelope(f, { runId: f.ids.runId, batchId: null }, 1)))
        .rejects.toMatchObject({ code: 'forbidden', operation: 'execution.cancel' });
      expect(readStopOperations(f)).toHaveLength(1);
      expect(cancelEvents(f)).toEqual(eventsAfterFirst);
    } finally { f.box.close(); }
  });

  it('Batch 取消传播到活动 Run；活动时不越权完成，占用清空后 Batch/Run 一起 cancelled', async () => {
    const idle = await openClaimFixture();
    try {
      const before = readBatch(idle, idle.ids.batchId);
      const receipt = await submitCancel(idle, { batchId: idle.ids.batchId, runId: null }, 1);
      expect(completedResult(receipt)).toMatchObject({
        outcome: 'cancelled', targetKind: 'batch', targetId: idle.ids.batchId,
        status: 'cancelled', stopStatus: 'stopped',
      });
      expect(readBatch(idle, idle.ids.batchId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', revision: 2,
      });
      expect(readRun(idle, idle.ids.runId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', ended_at: NOW,
      });
      expect(readStopOperations(idle)).toEqual([expect.objectContaining({
        target_kind: 'batch', target_id: idle.ids.batchId, status: 'stopped',
      })]);
      expect(cancelEvents(idle).map(event => event.event_type)).toEqual([
        'execution.run.cancelled', 'execution.batch.cancelled',
      ]);
      expect(idle.evaluate().reason).toBe('run_not_active');
      expect(readBatch(idle, idle.ids.batchId)).toMatchObject({
        budget_revision: before.budget_revision, budget_snapshot: before.budget_snapshot,
        deadline_at: before.deadline_at, runs_created: before.runs_created,
      });
      const runsAfter = idle.box.session.database.prepare('SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?')
        .get(idle.ids.batchId);
      expect(runsAfter).toEqual({ n: 1 });
      const idleRetry = await idle.box.services.commands.submit(idle.box.owner,
        idle.box.retryEnvelope(idle.ids.batchId));
      expect(idleRetry).toMatchObject({
        status: 'rejected', operation: 'execution.start',
        error: { code: 'conflict', details: { reason: 'batch_not_active' } },
      });
    } finally { idle.box.close(); }

    const active = await openClaimFixture();
    try {
      const attempt = claimAttempt(active);
      const claimedRevision = readBatch(active, active.ids.batchId).revision;
      const first = await submitCancel(active, { batchId: active.ids.batchId, runId: null }, claimedRevision);
      expect(completedResult(first)).toMatchObject({
        outcome: 'cancelling', targetKind: 'batch', status: 'cancelling', stopStatus: 'stopping',
      });
      const operationId = completedResult(first).stopOperationId;
      expect(readBatch(active, active.ids.batchId)).toMatchObject({
        status: 'cancelling', reason: 'user_cancel', revision: claimedRevision + 1,
      });
      expect(readRun(active, active.ids.runId)).toMatchObject({
        status: 'cancelling', reason: 'user_cancel', revision: claimedRevision + 1, ended_at: null,
      });
      expect(cancelEvents(active).map(event => event.event_type)).toEqual([
        'execution.run.cancelling', 'execution.batch.cancelling',
      ]);
      expect(active.evaluate().reason).toBe('run_control_blocked');
      // 取消 Batch 后显式重试不得创建新 Run（cancelling 不是可派发状态）。
      const activeRetry = await active.box.services.commands.submit(active.box.owner,
        active.box.retryEnvelope(active.ids.batchId));
      // 具体拒绝原因可能来自取消控制或预览身份重核；关键是不派发新 Run。
      expect(activeRetry).toMatchObject({ status: 'rejected', operation: 'execution.start' });
      expect(active.box.session.database.prepare('SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?')
        .get(active.ids.batchId)).toEqual({ n: 1 });

      active.box.session.transactWrite('test.confirm-stop', () => {
        active.box.session.database.prepare("UPDATE attempts SET status = 'cancelled' WHERE id = ?").run(attempt.id);
        active.box.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
      });
      const second = await submitCancel(active, { batchId: active.ids.batchId, runId: null }, claimedRevision + 1);
      expect(completedResult(second)).toMatchObject({
        outcome: 'cancelled', status: 'cancelled', stopOperationId: operationId, stopStatus: 'stopped',
      });
      expect(readBatch(active, active.ids.batchId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', revision: claimedRevision + 2,
      });
      expect(readRun(active, active.ids.runId)).toMatchObject({
        status: 'cancelled', reason: 'user_cancel', revision: claimedRevision + 2, ended_at: NOW,
      });
      expect(readStopOperations(active)).toHaveLength(1);
      expect(cancelEvents(active).map(event => event.event_type)).toEqual([
        'execution.run.cancelling', 'execution.batch.cancelling',
        'execution.run.cancelled', 'execution.batch.cancelled',
      ]);
    } finally { active.box.close(); }
  });

  it('取消先提交后迟到成功不能覆盖；成功先提交后迟到取消只返回 already_terminal', async () => {
    const cancelledFirst = await openClaimFixture();
    try {
      const cancel = await submitCancel(cancelledFirst, { runId: cancelledFirst.ids.runId, batchId: null }, 1);
      expect(completedResult(cancel)).toMatchObject({ outcome: 'cancelled', status: 'cancelled' });
      const run = readRun(cancelledFirst, cancelledFirst.ids.runId);
      const access = createSqliteExecutionAccess(cancelledFirst.box.session, { nowUtcMs: () => NOW });
      expect(() => cancelledFirst.box.session.transactWrite('test.late-success', () =>
        access.settleExecutionRunOutcomeInTransaction({
          projectId: cancelledFirst.box.projectId, batchId: cancelledFirst.ids.batchId,
          runId: cancelledFirst.ids.runId, resultKey: 'late-success', runRevision: run.revision,
          outcome: 'succeeded', reason: 'late', progressEvidence: null,
        }),
      )).toThrow();
      expect(readRun(cancelledFirst, cancelledFirst.ids.runId)).toEqual(run);
    } finally { cancelledFirst.box.close(); }

    const successFirst = await openClaimFixture();
    try {
      successFirst.box.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?")
        .run(NOW, successFirst.ids.runId);
      const before = readRun(successFirst, successFirst.ids.runId);
      const cancel = await submitCancel(successFirst, { runId: successFirst.ids.runId, batchId: null }, before.revision);
      expect(completedResult(cancel)).toMatchObject({ outcome: 'already_terminal', status: 'succeeded' });
      expect(readRun(successFirst, successFirst.ids.runId)).toEqual(before);
      expect(readStopOperations(successFirst)).toEqual([]);
    } finally { successFirst.box.close(); }
  });

  it('cancelling 已提交时迟到成功被非终态控制状态阻断', async () => {
    const f = await openClaimFixture();
    try {
      const attempt = claimAttempt(f);
      await submitCancel(f, { runId: f.ids.runId, batchId: null }, readRun(f, f.ids.runId).revision);
      const run = readRun(f, f.ids.runId);
      expect(run.status).toBe('cancelling');
      const access = createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW });
      expect(() => f.box.session.transactWrite('test.late-success', () =>
        access.settleExecutionRunOutcomeInTransaction({
          projectId: f.box.projectId, batchId: f.ids.batchId, runId: f.ids.runId,
          resultKey: 'late-success', runRevision: run.revision, outcome: 'succeeded',
          reason: 'late', progressEvidence: null,
        }),
      )).toThrow();
      expect(readRun(f, f.ids.runId)).toEqual(run);
      expect(readAttempt(f, attempt.id)).toMatchObject({ status: 'preparing' });
    } finally { f.box.close(); }
  });

  it('迁移 v28：仅追加停止 operation 表，历史 checksum 稳定，空库与 v27 库可升级', async () => {
    expect(SQLITE_MIGRATIONS.map(migration => migration.version)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    expect(SQLITE_MIGRATIONS[27]?.sql).toContain('CREATE TABLE execution_stop_operations');
    for (const migration of SQLITE_MIGRATIONS.slice(0, 27)) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const empty = createTempSandbox('shiploop-p03-9-cancel-empty-');
    try {
      const session = openSqliteStorageSession({ path: join(empty.path, 'state.db') });
      try {
        const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
        expect(result).toMatchObject({ fromVersion: 0, toVersion: 32 });
        expect(session.database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_stop_operations'",
        ).get()).toEqual({ name: 'execution_stop_operations' });
      } finally { session.close(); }
    } finally { empty.cleanup(); }

    const upgrade = createTempSandbox('shiploop-p03-9-cancel-upgrade-');
    try {
      const session = openSqliteStorageSession({ path: join(upgrade.path, 'state.db') });
      try {
        await migrateSqliteStorage(session, {
          migrations: SQLITE_MIGRATIONS.slice(0, 27), nowUtcMs: () => NOW,
        });
        session.database.prepare(
          "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('p-keep', ?, 1, ?, '保留项目', 'active', '[]')",
        ).run(NOW, NOW);
        const upgraded = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
        expect(upgraded).toMatchObject({ fromVersion: 27, toVersion: 32, appliedVersions: [28, 29, 30, 31, 32] });
        expect(session.database.prepare("SELECT display_name FROM projects WHERE id = 'p-keep'").get())
          .toEqual({ display_name: '保留项目' });
        expect(session.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
          .toEqual({ version: 32 });
      } finally { session.close(); }
    } finally { upgrade.cleanup(); }
  });
});
