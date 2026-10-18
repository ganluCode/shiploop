/**
 * P03-9 / F-010 finalization-only 新 Run（真实临时 Git/SQLite/Artifact，零模型）。
 *
 * 覆盖分配验收标准：
 * - 显式 retryFinal 只在父 Batch 可继续、额度/占用安全时创建受限新 Run，
 *   旧终态 Run/Attempt/证据不变；
 * - Run 创建、runsCreated/dispatchOrdinal、事件与回执同事务；同 commandId
 *   不重复创建，竞争请求不绕过同 Feature 活动 Run 约束；
 * - 零 Runtime 收尾仍消耗 Run 名额，失败/取消/重开不退次数或重置累计计数；
 * - 额度/无进展/deadline/Batch 不可继续均结构化拒绝，不自动增额或建批次；
 * - 真实 SQLite 重开后事实一致，证据失败不创建执行。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUDGET, NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import {
  businessRows,
  historicalRunWorkKey,
  prepareEligibleFixture,
  retryCommandsFor,
  retryPayload,
  row,
  tableRows,
} from '../../../helpers/p03-9/finalization-retry-fixture.ts';
import type { CommandReceipt } from '../../../../packages/core/src/ports/commands.ts';

function completed(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed') throw new Error(`expected completed: ${JSON.stringify(receipt)}`);
  return receipt.result as Record<string, unknown>;
}

function rejectedReason(receipt: CommandReceipt): { reason: string; detail?: string } {
  if (receipt.status !== 'rejected') throw new Error(`expected rejected: ${JSON.stringify(receipt)}`);
  return receipt.error.details as { reason: string; detail?: string };
}

function batchRow(f: Awaited<ReturnType<typeof prepareEligibleFixture>>) {
  return row<{
    status: string; revision: number; runs_created: number; attempts_created: number;
    runtime_starts: number; no_progress_runs: number; budget_snapshot: string;
  }>(f, 'SELECT status, revision, runs_created, attempts_created, runtime_starts, no_progress_runs, budget_snapshot FROM execution_batches WHERE id = ?', f.ids.batchId)!;
}

function runCount(f: Awaited<ReturnType<typeof prepareEligibleFixture>>): number {
  return row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM runs WHERE batch_id = ?', f.ids.batchId)!.n;
}

function dispatchedEvents(f: Awaited<ReturnType<typeof prepareEligibleFixture>>): number {
  return row<{ n: number }>(
    f,
    "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched' AND aggregate_type = 'run'",
  )!.n;
}

function retryBudget(maxRuns = 4) {
  return {
    ...BUDGET,
    batch: {
      ...BUDGET.batch,
      maxRuns,
      maxTotalAttempts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxRuntimeStarts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxNoProgressRuns: Math.max(maxRuns, 1),
    },
  };
}

describe('P03-9 / F-010 finalization-only Run creation', () => {
  it('创建受限新 Run：重开 failed 父 Batch、保留旧终态与累计计数，并同事务写事件/回执', async () => {
    const f = await prepareEligibleFixture();
    try {
      const oldRunBefore = row(f, 'SELECT * FROM runs WHERE id = ?', f.ids.runId);
      const oldInput = JSON.parse(String((oldRunBefore as Record<string, unknown>).input_snapshot));
      const attemptsBefore = tableRows(f, 'SELECT * FROM attempts ORDER BY rowid');
      const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY rowid');
      const verificationsBefore = tableRows(f, 'SELECT * FROM verification_batches ORDER BY rowid');
      const batchBefore = batchRow(f);
      const eventsBefore = dispatchedEvents(f);
      const commands = retryCommandsFor(f);
      const payload = retryPayload(f);

      const receipt = await commands.submit(randomUUID(), payload);
      const result = completed(receipt);
      expect(result).toMatchObject({
        retryFinal: true,
        dispatched: true,
        batchId: f.ids.batchId,
        featureId: f.box.featureId,
        historicalRunId: f.ids.runId,
        workKey: payload.workKey,
        dispatchOrdinal: 2,
        runsCreated: batchBefore.runs_created + 1,
        status: 'queued',
        runtimeStarts: 0,
        attemptsCreated: 0,
      });
      expect(typeof result.finalizationScopeDigest).toBe('string');
      expect(commands.signals).toEqual([{
        projectId: f.box.projectId,
        batchId: f.ids.batchId,
        runId: result.runId,
        featureId: f.box.featureId,
      }]);

      const batchAfter = batchRow(f);
      expect(batchAfter.status).toBe('queued');
      // 重开 failed Batch 与 Run 派发各做一次 revision CAS。
      expect(batchAfter.revision).toBe(batchBefore.revision + 2);
      expect(batchAfter.runs_created).toBe(batchBefore.runs_created + 1);
      expect(batchAfter.attempts_created).toBe(batchBefore.attempts_created);
      expect(batchAfter.runtime_starts).toBe(batchBefore.runtime_starts);
      expect(batchAfter.no_progress_runs).toBe(batchBefore.no_progress_runs);

      const newRun = row<Record<string, unknown>>(f, 'SELECT * FROM runs WHERE id = ?', result.runId)!;
      expect(newRun).toMatchObject({
        batch_id: f.ids.batchId,
        feature_id: f.box.featureId,
        purpose: 'execute',
        status: 'queued',
        work_key: payload.workKey,
        dispatch_ordinal: 2,
      });
      const input = JSON.parse(String(newRun.input_snapshot));
      expect(input.workKey).toBe(payload.workKey);
      expect(input.inputs).toEqual(oldInput.inputs);
      expect(input.finalization).toMatchObject({
        schemaVersion: 1,
        kind: 'finalization-only',
        historicalRunId: f.ids.runId,
        historicalBatchId: f.ids.batchId,
        historicalRunStatus: 'failed',
        historicalRunDispatchOrdinal: 1,
        planDigest: expect.any(String),
        codingTaskIds: [],
        runtimeStarts: 0,
        newAttempts: 0,
        retryPlanDigest: result.finalizationScopeDigest,
      });
      expect(input.finalization.missingSteps.length).toBeGreaterThan(0);
      expect(input.finalization.revalidateTasks).toEqual([]);
      expect(input.finalization.finalVerification).toEqual({ required: false, checkKeys: [] });

      // 旧终态 Run/Attempt/Task/证据行零改写。
      expect(row(f, 'SELECT * FROM runs WHERE id = ?', f.ids.runId)).toEqual(oldRunBefore);
      expect(tableRows(f, 'SELECT * FROM attempts ORDER BY rowid')).toEqual(attemptsBefore);
      expect(tableRows(f, 'SELECT * FROM tasks ORDER BY rowid')).toEqual(tasksBefore);
      expect(tableRows(f, 'SELECT * FROM verification_batches ORDER BY rowid')).toEqual(verificationsBefore);
      expect(dispatchedEvents(f)).toBe(eventsBefore + 1);
      expect(row<{ n: number }>(f, "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched' AND aggregate_id = ?", result.runId)!.n).toBe(1);
      expect(row(f, 'SELECT * FROM command_receipts WHERE command_id = ?', receipt.commandId)).toMatchObject({
        status: 'completed',
        operation: 'execution.retryFinal',
      });
      expect(runCount(f)).toBe(2);
    } finally { f.box.close(); }
  }, 60_000);

  it('相同 commandId 重放返回同一回执，不重复创建 Run/事件/计数', async () => {
    const f = await prepareEligibleFixture();
    try {
      const commands = retryCommandsFor(f);
      const commandId = randomUUID();
      const first = await commands.submit(commandId, retryPayload(f));
      const second = await commands.submit(commandId, retryPayload(f));
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(second.replayed).toBe(true);
      expect(completed(second)).toEqual(completed(first));
      expect(runCount(f)).toBe(2);
      expect(batchRow(f).runs_created).toBe(2);
      expect(dispatchedEvents(f)).toBe(2);
      expect(commands.signals).toHaveLength(1);
    } finally { f.box.close(); }
  }, 60_000);

  it('两个竞争 commandId 只有一个创建 Run，另一个结构化拒绝且不超扣额度', async () => {
    const f = await prepareEligibleFixture({ budget: retryBudget(4) });
    try {
      const commands = retryCommandsFor(f);
      const payload = retryPayload(f);
      const [left, right] = await Promise.all([
        commands.submit(randomUUID(), payload),
        commands.submit(randomUUID(), payload),
      ]);
      const statuses = [left.status, right.status].sort();
      expect(statuses).toEqual(['completed', 'rejected']);
      const rejected = left.status === 'rejected' ? left : right;
      expect(rejectedReason(rejected).reason).toBe('active_run_conflict');
      expect(runCount(f)).toBe(2);
      expect(batchRow(f).runs_created).toBe(2);
      expect(dispatchedEvents(f)).toBe(2);
      expect(commands.signals).toHaveLength(1);
    } finally { f.box.close(); }
  }, 60_000);

  it('额度耗尽、无进展上限与 deadline 到期均结构化拒绝：不重开 Batch、不增额、不写事件', async () => {
    const runs = await prepareEligibleFixture({ budget: retryBudget(1) });
    try {
      const before = batchRow(runs);
      const businessBefore = businessRows(runs);
      const receipt = await retryCommandsFor(runs).submit(randomUUID(), retryPayload(runs));
      expect(rejectedReason(receipt).reason).toBe('budget_exhausted');
      expect(batchRow(runs)).toEqual(before);
      expect(businessRows(runs)).toBe(businessBefore);
      expect(runCount(runs)).toBe(1);
      expect(dispatchedEvents(runs)).toBe(1);
    } finally { runs.box.close(); }

    const progress = await prepareEligibleFixture();
    try {
      progress.box.session.database.prepare('UPDATE execution_batches SET no_progress_runs = 2 WHERE id = ?')
        .run(progress.ids.batchId);
      const before = batchRow(progress);
      const receipt = await retryCommandsFor(progress).submit(randomUUID(), retryPayload(progress));
      expect(rejectedReason(receipt).reason).toBe('budget_exhausted');
      expect(batchRow(progress)).toEqual(before);
      expect(runCount(progress)).toBe(1);
    } finally { progress.box.close(); }

    const deadline = await prepareEligibleFixture();
    try {
      const snapshot = JSON.parse(batchRow(deadline).budget_snapshot);
      snapshot.batch.deadlineUtcMs = NOW - 1;
      deadline.box.session.database.prepare(
        'UPDATE execution_batches SET budget_snapshot = ?, deadline_at = ? WHERE id = ?',
      ).run(JSON.stringify(snapshot), NOW - 1, deadline.ids.batchId);
      const before = batchRow(deadline);
      const receipt = await retryCommandsFor(deadline).submit(randomUUID(), retryPayload(deadline));
      expect(rejectedReason(receipt).reason).toBe('budget_exhausted');
      expect(batchRow(deadline)).toEqual(before);
      expect(runCount(deadline)).toBe(1);
    } finally { deadline.box.close(); }
  }, 60_000);

  it('取消终态或暂停意图的 Batch 拒绝继续；不退款、不重置或新建授权批次', async () => {
    const cancelled = await prepareEligibleFixture({ terminalStatus: 'cancelled' });
    try {
      const before = batchRow(cancelled);
      const businessBefore = businessRows(cancelled);
      const receipt = await retryCommandsFor(cancelled).submit(randomUUID(), retryPayload(cancelled));
      expect(rejectedReason(receipt)).toMatchObject({ reason: 'batch_not_continuable' });
      expect(batchRow(cancelled)).toEqual(before);
      expect(businessRows(cancelled)).toBe(businessBefore);
      expect(runCount(cancelled)).toBe(1);
      expect(dispatchedEvents(cancelled)).toBe(1);
    } finally { cancelled.box.close(); }

    const paused = await prepareEligibleFixture();
    try {
      paused.box.session.database.prepare('UPDATE execution_batches SET pause_requested_at = ? WHERE id = ?')
        .run(NOW, paused.ids.batchId);
      const before = batchRow(paused);
      const receipt = await retryCommandsFor(paused).submit(randomUUID(), retryPayload(paused));
      expect(rejectedReason(receipt)).toMatchObject({ reason: 'batch_not_continuable' });
      expect(batchRow(paused)).toEqual(before);
      expect(runCount(paused)).toBe(1);
    } finally { paused.box.close(); }
  }, 60_000);

  it('失败/重开不退次数：finalization Run 失败后可再创建下一 ordinal，累计计数只增不减', async () => {
    const f = await prepareEligibleFixture({ budget: retryBudget(4) });
    try {
      const commands = retryCommandsFor(f);
      const first = completed(await commands.submit(randomUUID(), retryPayload(f)));
      const firstRunId = String(first.runId);
      const countersAfterFirst = batchRow(f);

      f.box.session.database.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
        .run('failed', NOW + 10, firstRunId);
      f.box.session.database.prepare('UPDATE execution_batches SET status = ?, no_progress_runs = no_progress_runs + 1 WHERE id = ?')
        .run('failed', f.ids.batchId);
      const failedRunBefore = row(f, 'SELECT * FROM runs WHERE id = ?', firstRunId);

      const secondReceipt = await commands.submit(randomUUID(), {
        featureId: f.box.featureId,
        historicalRunId: firstRunId,
        workKey: historicalRunWorkKey(f, firstRunId),
      });
      const second = completed(secondReceipt);
      expect(second).toMatchObject({ dispatchOrdinal: 3, runsCreated: countersAfterFirst.runs_created + 1, retryFinal: true });
      expect(row(f, 'SELECT * FROM runs WHERE id = ?', firstRunId)).toEqual(failedRunBefore);
      const afterSecond = batchRow(f);
      expect(afterSecond.attempts_created).toBe(countersAfterFirst.attempts_created);
      expect(afterSecond.runtime_starts).toBe(countersAfterFirst.runtime_starts);
      expect(afterSecond.no_progress_runs).toBeGreaterThanOrEqual(countersAfterFirst.no_progress_runs);
      expect(afterSecond.runs_created).toBe(countersAfterFirst.runs_created + 1);

      f.box.session.database.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
        .run('cancelled', NOW + 20, second.runId);
      f.box.session.database.prepare('UPDATE execution_batches SET status = ? WHERE id = ?')
        .run('cancelled', f.ids.batchId);
      const rejected = await commands.submit(randomUUID(), {
        featureId: f.box.featureId,
        historicalRunId: String(second.runId),
        workKey: historicalRunWorkKey(f, String(second.runId)),
      });
      expect(rejectedReason(rejected).reason).toBe('batch_not_continuable');
      expect(batchRow(f).runs_created).toBe(afterSecond.runs_created);
      expect(batchRow(f).attempts_created).toBe(afterSecond.attempts_created);
      expect(batchRow(f).runtime_starts).toBe(afterSecond.runtime_starts);
    } finally { f.box.close(); }
  }, 60_000);

  it('真实 SQLite 重开后新 Run/scope/计数/回执/事件仍一致，旧终态保持 failed', async () => {
    const f = await prepareEligibleFixture();
    try {
      const commands = retryCommandsFor(f);
      const receipt = await commands.submit(randomUUID(), retryPayload(f));
      const result = completed(receipt);
      const newRunBefore = row(f, 'SELECT * FROM runs WHERE id = ?', result.runId);
      const batchBefore = batchRow(f);
      f.box.reopen();

      const newRun = row<Record<string, unknown>>(f, 'SELECT * FROM runs WHERE id = ?', result.runId)!;
      const input = JSON.parse(String(newRun.input_snapshot));
      expect(newRun).toEqual(newRunBefore);
      expect(input.finalization.kind).toBe('finalization-only');
      expect(input.finalization.historicalRunId).toBe(f.ids.runId);
      expect(row(f, 'SELECT * FROM execution_batches WHERE id = ?', f.ids.batchId)).toMatchObject({
        status: batchBefore.status,
        revision: batchBefore.revision,
        runs_created: batchBefore.runs_created,
        attempts_created: batchBefore.attempts_created,
        runtime_starts: batchBefore.runtime_starts,
      });
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', f.ids.runId)).toMatchObject({ status: 'failed' });
      expect(row(f, 'SELECT * FROM command_receipts WHERE command_id = ?', receipt.commandId)).toMatchObject({
        status: 'completed',
      });
      const persisted = row<{ result_json: string }>(f, 'SELECT result_json FROM command_receipts WHERE command_id = ?', receipt.commandId)!;
      expect(JSON.parse(persisted.result_json)).toEqual(result);
      expect(row<{ n: number }>(f, "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched' AND aggregate_id = ?", result.runId)!.n).toBe(1);
    } finally { f.box.close(); }
  }, 60_000);

  it('证据/占用判定失败不创建执行、不改历史：遗留租约与错误 workKey 均只返回 rejected', async () => {
    const f = await prepareEligibleFixture();
    try {
      const before = businessRows(f);
      const wrongKey = await retryCommandsFor(f).submit(randomUUID(), {
        ...retryPayload(f),
        workKey: 'f'.repeat(64),
      });
      expect(rejectedReason(wrongKey).reason).toBe('work_key_mismatch');
      expect(businessRows(f)).toBe(before);

      const attempt = row<{ id: string; host_instance_id: string; execution_version: number }>(
        f, 'SELECT id, host_instance_id, execution_version FROM attempts LIMIT 1',
      )!;
      f.box.session.database.prepare(
        `INSERT INTO workspace_leases
          (id, created_at, updated_at, revision, project_id, resource_key, resource_kind, owner_kind,
           owner_id, host_instance_id, execution_version, state, lease_until, process_identity)
         VALUES (?, ?, ?, 1, ?, ?, 'workspace', 'attempt', ?, ?, ?, 'held', ?, NULL)`,
      ).run(randomUUID(), NOW, NOW, f.box.projectId, `f010-lease-${attempt.id}`, attempt.id,
        attempt.host_instance_id, attempt.execution_version, NOW + 60_000);
      const afterLease = businessRows(f);
      const occupied = await retryCommandsFor(f).submit(randomUUID(), retryPayload(f));
      expect(rejectedReason(occupied).reason).toBe('occupancy_unresolved');
      expect(businessRows(f)).toBe(afterLease);
      expect(runCount(f)).toBe(1);
      expect(dispatchedEvents(f)).toBe(1);
    } finally { f.box.close(); }
  }, 60_000);
});
