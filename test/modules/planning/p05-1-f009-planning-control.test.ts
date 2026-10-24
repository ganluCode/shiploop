/**
 * P05-1 / F-009 规划取消/超时/失败接入既有停止与派发结算路径的控制职责测试
 * （真实临时 SQLite/Git + 生产组合根 + 受控 FakeRuntime；无付费模型调用）。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 启动前取消（Batch 目标）：queued planning Run 原子取消、后续认领/启动被
 *   阻止（run_control_blocked）、Run/Attempt/Runtime 启动计数与 deadline 不变、
 *   不自动生成新规划（再次 planning.start 被活动规划上下文拒绝）；
 * - 工具中取消（Run 目标）：先持久记录控制意图（Run cancelling + stopping
 *   operation），再撤销受限工具 grant（bind/invoke 拒绝 execution_inactive）、
 *   停止 Runtime 并核对停止证据；停止确认后 Attempt/Task cancelled、Run 由停止
 *   核验收尾 cancelled、占用/槽位释放、预算计数不退还；重复取消返回
 *   already_terminal 不倒写；迟到结算请求不复活派发归属；
 * - 停止不确定：Attempt interrupted、停止 operation uncertain、Run 保持
 *   cancelling、占用隔离（quarantine）且派发归属保留，同项目再次规划/编码被
 *   活动控制状态阻止；
 * - 超时（Run 层 parent_deadline）：结构化分类保留（errorKind timeout、
 *   Run reason parent_deadline）、Attempt/Session/诊断制品保留、计数与 deadline
 *   不退还、不自动重规划；
 * - 成功/取消竞争（持久控制版本裁决）：候选已发布后取消意图先提交，迟到的
 *   成功结果降级为 cancelled、不成功收尾 Run（保持 cancelling 由停止路径收尾）、
 *   候选保留为不可审批诊断（approve 被拒 planning_run_not_succeeded）；停止
 *   确认后 Run 收尾 cancelled，重复取消 already_terminal；
 * - 旧结果迟到（失败类）：取消先获胜时迟到失败观察不抛 control_in_progress
 *   回滚 Attempt 事实，Attempt/Task 按观察结算、Run 不被迟到结果改写。
 *
 * 真实 provider/model 调用：not_run（未获额外授权；全部为 FakeRuntime 离线执行）。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import {
  F007_NOW_BASE,
  F007_STANDARD_STEPS,
  openF007ControlFixture,
  type F007Fixture,
} from '../../helpers/planning/p05-1-f007-fixture.ts';

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

const standardSteps = F007_STANDARD_STEPS;
/** 夹具内确定性时钟从 NOW_BASE 起单调递增；迟到结果注入时钟必须晚于已记录事实。 */
const APPLY_NOW = F007_NOW_BASE + 1_800_000;
const SETTLE_NOW = F007_NOW_BASE + 1_800_600;
const fixtures: F007Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || !('result' in receipt)) {
    throw new Error(`Expected a completed receipt, got ${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

function submitCancel(f: F007Fixture, payload: { readonly runId: string | null; readonly batchId: string | null },
  expectedRevision: number): Promise<CommandReceipt> {
  return f.core.commandService.submit(f.box.localOwner(), {
    schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
    operation: 'execution.cancel', scope: { kind: 'project', projectId: f.projectId },
    expectedRevision, payload,
  });
}

function submitPlanningStartAgain(f: F007Fixture): Promise<CommandReceipt> {
  const featureRevision = Number(f.query('SELECT revision AS r FROM features WHERE id = ?', f.featureId).r);
  return f.core.commandService.submit(f.box.localOwner(), {
    schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
    operation: PLANNING_START_OPERATION, scope: { kind: 'project', projectId: f.projectId },
    expectedRevision: featureRevision,
    payload: {
      schemaVersion: 1, projectId: f.projectId, phaseId: 'phase-1', featureId: f.featureId,
      requirementRefs: [], constraints: ['不改变既有公开接口'],
      acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: {
        batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: F007_NOW_BASE + 7_200_000 },
        run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
      },
    },
  });
}

function batchFacts(f: F007Fixture): { readonly runs: number; readonly attempts: number; readonly starts: number; readonly deadline: number } {
  const row = f.query('SELECT runs_created AS runs, attempts_created AS attempts, runtime_starts AS starts, deadline_at AS deadline FROM execution_batches') as {
    runs: number; attempts: number; starts: number; deadline: number;
  };
  return { runs: Number(row.runs), attempts: Number(row.attempts), starts: Number(row.starts), deadline: Number(row.deadline) };
}

/** 模拟已提交的 Run 级取消控制事实（与 requestExecutionCancel 的 cancelling 写入和 stopping operation 同构）。 */
function commitCancelControlState(f: F007Fixture): string {
  const stopOperationId = randomUUID();
  const batchId = String(f.query('SELECT batch_id AS b FROM runs WHERE id = ?', f.planningRunId).b);
  const now = Date.now();
  f.session.transactWrite('f009.fixture.cancel-commit', () => {
    f.session.database.prepare(
      "UPDATE runs SET status = 'cancelling', reason = 'user_cancel', revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND status = 'running'",
    ).run(now, f.projectId, f.planningRunId);
    f.session.database.prepare(
      `INSERT INTO execution_stop_operations (id, created_at, project_id, revision, updated_at, command_id, target_kind, target_id,
        batch_id, run_id, reason, status, requested_at, settled_at)
       VALUES (?, ?, ?, 1, ?, ?, 'run', ?, ?, ?, 'user_cancel', 'stopping', ?, NULL)`,
    ).run(stopOperationId, now, f.projectId, now, `f009-fixture-${randomUUID()}`, f.planningRunId, batchId, f.planningRunId, now);
  });
  return stopOperationId;
}

function readPlanningAttempt(f: F007Fixture): {
  readonly id: string; readonly owner_id: string; readonly host_instance_id: string;
  readonly execution_version: number; readonly invocation_id: string; readonly input_ref: string;
} {
  return f.query('SELECT id, owner_id, host_instance_id, execution_version, invocation_id, input_ref FROM attempts WHERE task_id = ?', f.planningTaskId) as {
    id: string; owner_id: string; host_instance_id: string; execution_version: number; invocation_id: string; input_ref: string;
  };
}

describe('P05-1 / F-009 规划取消、超时与失败的停止/结算控制', () => {
  it('[case:planning-cancel-queued-batch-blocks-startup] 启动前以 Batch 控制命令取消：阻止认领启动且计数不变', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-queue-', steps: standardSteps });
    fixtures.push(f);
    const before = batchFacts(f);
    /* Run 仍 queued、无 Attempt：以既有 Batch 控制命令取消（作用于 planning Run）。 */
    const batchRevision = Number(f.query('SELECT revision AS r FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)', f.planningRunId).r);
    const receipt = await submitCancel(f, { runId: null, batchId: String(f.query('SELECT batch_id AS b FROM runs WHERE id = ?', f.planningRunId).b) }, batchRevision);
    expect(receipt.status).toBe('completed');
    expect(completedResult(receipt)).toMatchObject({
      outcome: 'cancelled', targetKind: 'batch', status: 'cancelled', changed: true, stopStatus: 'stopped',
    });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'cancelled', reason: 'user_cancel' });
    expect(f.query('SELECT status FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)', f.planningRunId))
      .toMatchObject({ status: 'cancelled' });
    expect(f.query('SELECT status FROM execution_stop_operations')).toMatchObject({ status: 'stopped' });

    /* 后续唤醒/扫描不认领、不启动 Runtime；planning Task 保持 pending。 */
    await f.core.workExecution.scan();
    await f.core.workExecution.scan();
    await f.core.workExecution.scan();
    expect(Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n)).toBe(0);
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'pending' });
    expect(f.runtimeStarts()).toBe(0);

    /* 成功/取消均不退还 Run、Attempt、Runtime 启动计数，不重置 deadline。 */
    const after = batchFacts(f);
    expect(after).toEqual(before);
    /* 不自动反复生成新规划：活动规划上下文保持 open，再次 planning.start 被拒。 */
    await expect(submitPlanningStartAgain(f)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'planning_in_progress' } });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM runs') as { n: number }).n)).toBe(1);
  }, 120_000);

  it('[case:planning-cancel-running-stops-and-settles] 工具中取消：控制意图先行、撤销工具 grant、停止核验后安全释放', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-run-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const before = batchFacts(f);

    /* 取消先持久记录控制意图（同一短写事务：cancelling + stopping operation）。 */
    const runRevision = Number(f.query('SELECT revision AS r FROM runs WHERE id = ?', f.planningRunId).r);
    const receipt = await submitCancel(f, { runId: f.planningRunId, batchId: null }, runRevision);
    expect(receipt.status).toBe('completed');
    expect(completedResult(receipt)).toMatchObject({
      outcome: 'cancelling', targetKind: 'run', status: 'cancelling', changed: true, stopStatus: 'stopping',
    });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'cancelling', reason: 'user_cancel' });

    /* 控制意图提交后受限工具 grant 即被撤销：bind/invoke 均拒绝。 */
    let denied: unknown;
    try { f.bindSubmitBridge(); } catch (error) { denied = error; }
    expect(denied).toMatchObject({ code: 'forbidden', details: { reason: 'execution_inactive' } });

    /* 停止 Runtime 并核对停止证据：Attempt/Task cancelled，Run 由停止核验收尾。 */
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'cancelled' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'cancelled' });
    await expect.poll(() => f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId),
      { timeout: 15_000 }).toMatchObject({ status: 'cancelled' });
    expect(f.query('SELECT status, stop_confirmed FROM execution_stop_operations'))
      .toMatchObject({ status: 'stopped', stop_confirmed: 1 });
    /* 停止证据以受管 Artifact 发布（身份、阶段、退出观察与缺口）。 */
    expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'execution_stop_evidence') as { n: number }).n)).toBe(1);
    /* Session/Attempt/上下文事实保留：无候选发布，上下文保持 open。 */
    expect(f.query('SELECT id FROM sessions WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)', f.planningTaskId).id).toBeTruthy();
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'open', candidate_artifact_id: null });

    /* 停止确认后由当前 owner/version 安全结算并释放资源/槽位（停止控制的结算
     * 与 Run 收尾同一事务后，由派发结算入口按持久事实释放）。 */
    await f.core.workExecution.settleDispatch(f.projectId, f.planningRunId);
    expect(f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim," +
      ' (SELECT state FROM execution_slot_claims LIMIT 1) AS slot', f.planningRunId),
    ).toMatchObject({ leases: 0, claim: 'released', slot: 'released' });

    /* 成功/失败/取消均不退还 Run、Attempt 或实际 Runtime 启动计数。 */
    expect(batchFacts(f)).toEqual(before);
    /* 已终态控制返回已有终态且不倒写：重复取消 already_terminal、无新停止 operation。 */
    const afterRevision = Number(f.query('SELECT revision AS r FROM runs WHERE id = ?', f.planningRunId).r);
    const again = await submitCancel(f, { runId: f.planningRunId, batchId: null }, afterRevision);
    expect(completedResult(again)).toMatchObject({ outcome: 'already_terminal', changed: false, stopOperationId: null, stopStatus: null });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM execution_stop_operations') as { n: number }).n)).toBe(1);
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelled' });
    /* 迟到/重复派发结算不复活已释放归属（幂等 replayed/absent，零新写入）。 */
    f.core.workExecution.settleDispatch(f.projectId, f.planningRunId);
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'released' });
    /* 调度器扫描同样按持久事实收尾，不产生新执行。 */
    await f.core.workExecution.scan();
    expect(f.runtimeStarts()).toBe(1);
  }, 120_000);

  it('[case:planning-cancel-stop-uncertain-isolates] 取消后停止不确定：interrupted 事实隔离占用并阻止再次规划', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-unc-', steps: standardSteps,
      lifecycle: { stopped: { unconfirmed: true } } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const before = batchFacts(f);

    const runRevision = Number(f.query('SELECT revision AS r FROM runs WHERE id = ?', f.planningRunId).r);
    const receipt = await submitCancel(f, { runId: f.planningRunId, batchId: null }, runRevision);
    expect(completedResult(receipt)).toMatchObject({ outcome: 'cancelling', stopStatus: 'stopping' });

    /* 停止不确定：Attempt 保留 interrupted 事实，绝不释放占用/倒写终态。 */
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'interrupted' });
    expect(f.query('SELECT status, stop_confirmed FROM execution_stop_operations'))
      .toMatchObject({ status: 'uncertain', stop_confirmed: 0 });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelling' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'running' });
    /* 占用隔离（quarantine）且派发归属/槽位不释放。 */
    expect(Number((f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'") as { n: number }).n)).toBe(3);
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'held' });
    /* 隔离占用与活动控制状态阻止同项目编码/再次规划（共享活动 Run 与占用门控）。 */
    await expect(submitPlanningStartAgain(f)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'execution_in_progress' } });
    /* 取消/不确定停止不退还计数。 */
    expect(batchFacts(f)).toEqual(before);
    expect(Number((f.query('SELECT COUNT(*) AS n FROM runs') as { n: number }).n)).toBe(1);
  }, 120_000);

  it('[case:planning-run-timeout-structured-failure] Run 层超时：结构化分类保留、计数不退还且不自动重规划', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-timeout-', steps: standardSteps,
      runTimeLimitMs: 3_000 });
    fixtures.push(f);
    const before = batchFacts(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();

    /* Run 层时限到期 → parent_deadline：停止确认后按受控观察结算，不伪造成功。 */
    await expect.poll(() => f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 20_000 }).toMatchObject({ status: 'interrupted', error_kind: 'timeout' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'paused', reason: 'parent_deadline' });
    /* Attempt/Session/诊断制品保留；停止确认后占用经 retention 释放，但停止不
     * 确定的现场使派发归属/槽位隔离（stop_unverified），不伪装正常释放。 */
    expect(f.query('SELECT id FROM sessions WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)', f.planningTaskId).id).toBeTruthy();
    expect(f.query('SELECT diagnostic_ref FROM attempts WHERE task_id = ?', f.planningTaskId).diagnostic_ref).toBeTruthy();
    await expect.poll(() => f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim", f.planningRunId),
    { timeout: 15_000 }).toMatchObject({ leases: 0, claim: 'quarantined' });
    /* 不退还计数、不重置 deadline、不自动反复生成新规划。 */
    expect(batchFacts(f)).toEqual({ ...before, starts: before.starts + 1, attempts: before.attempts + 1 });
    await expect(submitPlanningStartAgain(f)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'execution_in_progress' } });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM runs') as { n: number }).n)).toBe(1);
    expect(f.runtimeStarts()).toBe(1);
  }, 120_000);

  it('[case:planning-late-success-after-cancel-control-wins] 候选已发布后取消先获胜：迟到成功降级、候选不可审批、停止确认后收尾', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-race-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    /* 候选先发布（上下文 candidate_published），随后取消意图先于结算提交。 */
    const published = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(published.status).toBe('completed');
    const candidateDigest = completedResult(published).candidateDigest as string;
    const stopOperationId = commitCancelControlState(f);

    /* 迟到的成功结果（无控制事实、停止确认、记录完整）由持久控制版本裁决：不成功收尾。 */
    const attemptRow = readPlanningAttempt(f);
    const sessionId = String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attemptRow.id).id);
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.dataRoot] }),
      nowUtcMs: () => APPLY_NOW,
    });
    const applied = lifecycle.apply({
      projectId: f.projectId, attemptId: attemptRow.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attemptRow.owner_id, hostInstanceId: attemptRow.host_instance_id,
      executionVersion: attemptRow.execution_version,
      notificationId: 'runtime-settlement', kind: 'runtime_settled',
      runtime: {
        sessionId, invocationId: attemptRow.invocation_id,
        result: { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 10, usage: null, lastEventSequence: 2 },
        failure: null,
        recording: { mode: 'required', complete: true, manifestRef: attemptRow.input_ref, gaps: [] },
        stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(APPLY_NOW).toISOString(), detail: null },
      },
      evidenceRef: attemptRow.input_ref,
    });
    expect(applied).toMatchObject({ disposition: 'applied', status: 'cancelled' });
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId)).toMatchObject({ status: 'cancelled' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'cancelled' });
    /* Run 不被迟到成功改写：保持 cancelling，由取消/停止核验路径收尾。 */
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelling' });
    /* 候选保留为不可审批诊断：approve 被拒，不导入任何 coding Task。 */
    const featureRevision = Number(f.query('SELECT revision AS r FROM features WHERE id = ?', f.featureId).r);
    const decide = await f.core.commandService.submit(f.box.localOwner(), {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
      operation: 'planning.candidate.decide', scope: { kind: 'project', projectId: f.projectId },
      expectedRevision: featureRevision,
      payload: { candidateId: f.candidateId, candidateDigest, decision: 'approve', reason: null },
    });
    expect(decide.status).toBe('rejected');
    expect((decide as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('planning_run_not_succeeded');
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    expect(Number((f.query("SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = 'coding'", f.featureId) as { n: number }).n)).toBe(1);
    /* 取消获胜不按 passed 结算预算（保留预占事实，不退还计数）。 */
    expect(String(f.query('SELECT reason FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId).reason))
      .not.toMatch(/^verification-budget:v1:/);

    /* 停止确认后控制路径收尾：释放占用 → settleExecutionStop → Run cancelled。 */
    f.session.transactWrite('f009.fixture.release-occupancy', () => {
      f.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attemptRow.id);
    });
    const atomicStore = createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => SETTLE_NOW });
    atomicStore.transact('f009.fixture.settle-stop', transaction => {
      transaction.settleExecutionStop({
        projectId: f.projectId, stopOperationId, status: 'stopped', evidenceRef: attemptRow.input_ref,
        stopConfirmed: true, forced: null, checkedAtUtcMs: SETTLE_NOW,
      });
    });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelled' });
    /* 已终态控制返回已有终态且不倒写。 */
    const afterRevision = Number(f.query('SELECT revision AS r FROM runs WHERE id = ?', f.planningRunId).r);
    const again = await submitCancel(f, { runId: f.planningRunId, batchId: null }, afterRevision);
    expect(completedResult(again)).toMatchObject({ outcome: 'already_terminal', changed: false });
  }, 120_000);

  it('[case:planning-late-failure-after-cancel-kept] 取消先获胜时迟到失败观察不回滚 Attempt 事实、不改写控制状态', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f009-latefail-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    commitCancelControlState(f);

    /* 迟到的超时/失败观察：此前会因 Run 处于控制状态抛 control_in_progress 并整体
     * 回滚；现在 Attempt/Task 按观察结算，Run 保持 cancelling 由控制路径收尾。 */
    const attemptRow = readPlanningAttempt(f);
    const sessionId = String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attemptRow.id).id);
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.dataRoot] }),
      nowUtcMs: () => APPLY_NOW,
    });
    const applied = lifecycle.apply({
      projectId: f.projectId, attemptId: attemptRow.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attemptRow.owner_id, hostInstanceId: attemptRow.host_instance_id,
      executionVersion: attemptRow.execution_version,
      notificationId: 'runtime-settlement', kind: 'runtime_settled',
      runtime: {
        sessionId, invocationId: attemptRow.invocation_id,
        result: null,
        failure: { kind: 'timeout', reason: 'parent_deadline' },
        recording: { complete: false, manifestRef: null },
        stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(APPLY_NOW).toISOString(), detail: null },
        control: { reason: 'parent_deadline', cancel: 'unobserved' },
      },
      evidenceRef: attemptRow.input_ref,
    });
    expect(applied).toMatchObject({ disposition: 'applied' });
    expect(f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId))
      .toMatchObject({ error_kind: 'timeout' });
    expect(['interrupted', 'failed']).toContain(String(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId).status));
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelling' });
    /* 现场隔离保留；控制状态不被迟到结果倒写。 */
    expect(Number((f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'") as { n: number }).n)).toBe(3);
  }, 120_000);
});

/* 真实 provider/model 调用：not_run（本文件全部离线；未经授权不发起真实模型请求）。 */
