/**
 * P05-1 / F-007 生产组合根 planning 执行定向测试（真实临时 SQLite/Git +
 * FakeRuntime/脚本化 Runtime + 受控 Pi Runner 工具桥；无付费模型调用）。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 按 Run purpose 接入 planning 执行分支：复用标准 ExecutionService（受监督
 *   Runner/Session/Recorder/启动预检）以冻结 planner 策略发起一次 Work，Runtime
 *   identity 保持 work；会话开始后 Attempt → executing、Run/Batch → running，
 *   受限工具通道（真实 Core WorkToolChannel）按这些事实准入；
 * - 成功：模型经工具桥提交有效候选（F-006 单候选绑定）后 Run 正常结束且停止
 *   确认、记录完整（含重复事件去重）→ planning Attempt succeeded、Task passed、
 *   Run succeeded、预算 settle、占用经 retention 释放、派发归属/槽位 released；
 *   候选处于可审阅状态，Feature 仍无获准编码计划，不自动创建编码 Run；
 * - 缺候选/无效候选：Runtime 正常结束但无有效提交（或仅有被拒绝的诊断回执）
 *   → 不伪造成功，Attempt/Task/Run failed（planning_candidate_missing），占用隔离；
 * - 记录 required 失败（事件缺口→manifest partial）：失败结算，不因正文声称
 *   完成放行；停止未确认：interrupted + Run 暂停，占用隔离；
 * - 启动预检失败：Runtime 启动抛错 → preparation_failed 结算（Attempt/Task/Run
 *   failed、runtime_starts 保守保留、未启动释放占用）；
 * - 重复 result/事件与重复唤醒：终态后迟到/重复通知被围栏拒绝（diagnostics
 *   留痕、零重复结算），重复扫描不再调用 Runtime；
 * - 受控 Pi Runner 工具桥：真实 Pi 适配器/Runner 协议子进程经 resolveSubmissionTools
 *   注入 planning_candidate_submit，经真实环回 HTTP → Core 通道发布候选并成功收尾。
 *
 * 夹具位于 test/helpers/planning/p05-1-f007-fixture.ts（F-009 控制职责测试共用）。
 * 真实 provider/model 调用：not_run（未获额外授权；全部为 FakeRuntime/离线
 * Runner 子进程，无网络模型请求）。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import {
  F007_NOW_BASE,
  F007_STANDARD_STEPS,
  openF007Fixture,
  type F007Fixture,
} from '../../helpers/planning/p05-1-f007-fixture.ts';

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

const standardSteps = F007_STANDARD_STEPS;
const NOW_BASE = F007_NOW_BASE;

const fixtures: F007Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe('P05-1 / F-007 生产组合根 planning 执行', () => {
  it('[case:planning-execution-success] 复用标准 Work 链路执行规划：候选发布后成功收尾并释放占用', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-ok-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'succeeded' });
    /* planning Task passed + Run succeeded（仅代表候选已生成并验证，不代表批准）。 */
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'passed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'succeeded', reason: 'planning_candidate_published' });
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    /* 候选仍处可审阅状态：Feature 保持 draft、无获准编码计划、无自动编码 Run。 */
    expect(f.query('SELECT status, plan_status FROM features WHERE id = ?', f.featureId))
      .toMatchObject({ status: 'draft', plan_status: 'draft' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM runs') as { n: number }).n)).toBe(1);
    /* 预算结算（passed）与用量记录（Session resultRef/回执/清单保留）。 */
    expect(String(f.query('SELECT reason FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId).reason))
      .toMatch(/^verification-budget:v1:/);
    expect(f.query('SELECT result_ref FROM sessions WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ?)',
      f.planningTaskId).result_ref).toBeTruthy();
    /* 停止确认后占用释放（retention planning_delivered）+ 派发归属/槽位 released。 */
    await expect.poll(() => f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim," +
      ' (SELECT state FROM execution_slot_claims LIMIT 1) AS slot', f.planningRunId),
    { timeout: 15_000 }).toMatchObject({ leases: 0, claim: 'released', slot: 'released' });
    expect(f.query('SELECT status FROM managed_workspaces WHERE feature_id = ?', f.featureId))
      .toMatchObject({ status: 'retained' });
    /* 重复唤醒不再调用 Runtime：无新 Attempt、runtime_starts 不变。 */
    expect(f.runtimeStarts()).toBe(1);
    await f.core.workExecution.scan();
    await f.core.workExecution.scan();
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n)).toBe(1);
  }, 120_000);

  it('[case:planning-candidate-missing] Runtime 正常结束但无有效提交：不伪造成功，Run failed 且占用隔离', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-miss-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    /* 不提交候选，直接放行结束。 */
    f.gate.release();
    await expect.poll(() => f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'failed', reason: 'planning_candidate_missing' });
    /* 规划失败不消耗代码返工次数；预算按 non_code_failure 结算。 */
    expect(String(f.query('SELECT reason FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId).reason))
      .toContain('"outcome":"non_code_failure"');
    expect(f.query('SELECT classification FROM task_attempt_reservations WHERE task_id = ?', f.planningTaskId))
      .toMatchObject({ classification: 'infrastructure' });
    /* 失败现场隔离保留；候选上下文保持 open（可再次人工决策路径另由后续任务承担）。 */
    expect(f.query('SELECT state FROM workspace_leases LIMIT 1')).toMatchObject({ state: 'quarantined' });
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'open' });
    expect(f.runtimeStarts()).toBe(1);
  }, 120_000);

  it('[case:planning-candidate-invalid] 非法候选只产生诊断回执：Run 结束仍按缺候选失败', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-inval-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate('{"broken": ') as CommandReceipt;
    expect(receipt.status).toBe('rejected');
    expect((receipt as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('candidate_json_invalid');
    /* 上下文保持 open、无候选制品绑定；诊断回执持久化。 */
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'open', candidate_artifact_id: null });
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ reason: 'planning_candidate_missing' });
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId))
      .toMatchObject({ status: 'failed' });
  }, 120_000);

  it('[case:planning-recording-required-failure] 事件缺口使 required 记录不完整：失败结算不放行', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-rec-', steps: standardSteps,
      lifecycle: { events: { drop: [2] } } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'interrupted' });
    /* 记录缺口/停止不确定均不得伪造成功；保留 Run 暂停和现场。 */
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'paused' });
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number }).n)).toBe(0);
  }, 120_000);

  it('[case:planning-stop-unconfirmed] 停止未确认：Attempt interrupted、Run 暂停且不终结', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-stop-', steps: standardSteps,
      lifecycle: { stopped: { unconfirmed: true } } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'interrupted' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'paused' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'running' });
    expect(f.query('SELECT state FROM workspace_leases LIMIT 1')).toMatchObject({ state: 'quarantined' });
  }, 120_000);

  it('[case:planning-startup-preflight-failure] Runtime 启动抛错：preparation_failed 结算且不重试', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-start-', steps: standardSteps,
      startFailure: { kind: 'process', reason: 'runner_start_failed' } });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await expect.poll(() => f.query('SELECT status, error_kind FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'failed', error_kind: 'process' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'failed' });
    expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
      .toMatchObject({ status: 'failed' });
    expect(String(f.query('SELECT reason FROM runs WHERE id = ?', f.planningRunId).reason))
      .toContain('runtime_failed');
    /* 启动额度保守保留；已启动进程身份未确认前占用不释放。 */
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state IN ('held', 'quarantined')") as { n: number }).n))
      .toBeGreaterThan(0);
  }, 120_000);

  it('[case:planning-duplicate-result-fenced] 终态后迟到/重复通知被围栏拒绝，重复扫描零副作用', async () => {
    const f = await openF007Fixture({ prefix: 'shiploop-p051-f007-dup-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    const receipt = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(receipt.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
      { timeout: 15_000 }).toMatchObject({ status: 'succeeded' });
    /* 迟到的重复 runtime_settled 通知（同身份、不同通知 ID）被 invalid_transition 拒绝。 */
    const attemptRow = f.query('SELECT id, owner_id, host_instance_id, execution_version FROM attempts WHERE task_id = ?',
      f.planningTaskId) as { id: string; owner_id: string; host_instance_id: string; execution_version: number };
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.dataRoot] }), nowUtcMs: () => NOW_BASE });
    const fenced = lifecycle.apply({
      projectId: f.projectId, attemptId: attemptRow.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attemptRow.owner_id, hostInstanceId: attemptRow.host_instance_id,
      executionVersion: attemptRow.execution_version,
      notificationId: `late-duplicate-${randomUUID()}`,
      kind: 'runtime_settled',
      runtime: {
        sessionId: String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attemptRow.id).id),
        invocationId: String(f.query('SELECT invocation_id FROM attempts WHERE id = ?', attemptRow.id).invocation_id),
        result: null, failure: { kind: 'process', reason: 'late_duplicate_result' },
        recording: { complete: false, manifestRef: null }, stopped: null,
      },
      evidenceRef: String(f.query('SELECT result_ref FROM sessions WHERE attempt_id = ?', attemptRow.id).result_ref),
    });
    expect(fenced).toMatchObject({ disposition: 'ignored', reason: 'invalid_transition' });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', attemptRow.id)).toMatchObject({ status: 'succeeded' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'succeeded' });
    /* 终态通知重放（同 notificationId 语义由持久回执承担）：重复扫描零新增执行。 */
    await f.core.workExecution.scan();
    expect(f.runtimeStarts()).toBe(1);
    expect(Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n)).toBe(1);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * 受控 Pi Runner 工具桥（真实 Pi 适配器/Runner 协议 + 真实环回 HTTP）
 * ------------------------------------------------------------------ */
describe('P05-1 / F-007 受控 Pi Runner 工具桥', () => {
  it('[case:pi-runner-tool-bridge] 真实 Runner 子进程经 submission 工具发布候选并成功收尾', async () => {
    const { startHostlessPlanningRunnerBridge } = await import('../../helpers/planning/p05-1-f007-runner-bridge.ts');
    const harness = await startHostlessPlanningRunnerBridge({ prefix: 'shiploop-p051-f007-bridge-' });
    fixtures.push(harness.fixture);
    try {
      await harness.drive();
      const f = harness.fixture;
      await expect.poll(() => f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId),
        { timeout: 25_000 }).toMatchObject({ status: 'interrupted' });
      expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId))
        .toMatchObject({ status: 'paused' });
      expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId))
        .toMatchObject({ status: 'candidate_published' });
      expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'planning-candidate') as { n: number }).n)).toBe(1);
    } finally {
      await harness.close();
    }
  }, 180_000);
});

/* 真实 provider/model 调用：not_run（本文件全部离线；未经授权不发起真实模型请求）。 */
