/**
 * P05-1 / F-010 规划重启核对与显式恢复测试（真实临时 SQLite/Git + 生产组合根
 * + 受控 FakeRuntime；无付费模型调用）。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 启动恢复 gate：planning Run/Attempt/派发认领/工作区进入扫描，fence 增补
 *   输入快照绑定、候选发布与审计水位核对；证据不足保留 interrupted 与诊断，
 *   不新认领、不重复启动 Runtime；
 * - 窗口 A（候选文件已发布但登记未完成）：受管制品核验后幂等补完登记，
 *   重复恢复不二次发布；
 * - 窗口 B（有效候选已登记但 Run 未结束）：runtime-settlement 制品证据完整时
 *   补完 Attempt/Task/Run/预算/Session 终态并释放占用；证据不足（无制品/
 *   取消控制先获胜）保留 interrupted 与诊断；
 * - 窗口 C（Run 已终态但唤醒/观察丢失）：核对 Session 停止/水位后释放仍隔离
 *   的占用与派发归属；
 * - 窗口 D（批准应用已提交但响应丢失）：同 commandId 重放返回原回执，计划
 *   仅应用一次；
 * - 显式 resume：只有没有可复用完成证据的非终态工作在用户显式 resume 后按
 *   政策创建新 Attempt（保留原 Attempt 终态与历史候选；预算/deadline/占用
 *   重新核对）；额度耗尽/输入漂移/候选已发布明确拒绝；
 * - 会话策略：resume 的新 planning Attempt 按 auto 契约降级新会话并记录原因
 *   （绑定证据 recovery 记录），新进程启动记账一次；
 * - 旧 owner 晚到：恢复补完后的迟到派发结算被 stale_dispatch_identity 拒绝。
 *
 * 真实 provider/model 调用：not_run（未获额外授权；全部为 FakeRuntime 离线执行）。
 */
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteRunDispatchSettlement } from '../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import {
  F007_NOW_BASE,
  F007_STANDARD_STEPS,
  openF007ControlFixture,
  type F007Fixture,
} from '../../helpers/planning/p05-1-f007-fixture.ts';

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

const standardSteps = F007_STANDARD_STEPS;
/** 迟到/恢复注入时钟必须晚于已记录事实。 */
const RECOVERY_NOW = F007_NOW_BASE + 1_800_000;
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

interface PlanningAttemptRow {
  readonly id: string; readonly owner_id: string; readonly host_instance_id: string;
  readonly execution_version: number; readonly invocation_id: string; readonly status: string;
}

function latestPlanningAttempt(f: F007Fixture): PlanningAttemptRow {
  return f.query('SELECT id, owner_id, host_instance_id, execution_version, invocation_id, status FROM attempts WHERE task_id = ?\n    ORDER BY created_at DESC, rowid DESC LIMIT 1',
    f.planningTaskId) as unknown as PlanningAttemptRow;
}

function attemptCount(f: F007Fixture): number {
  return Number((f.query('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.planningTaskId) as { n: number }).n);
}

/** 重绑受管工作区现场行到当前 planning Attempt（模拟真实执行期占用归属；
 * 基线列不可 UPDATE，测试直接按 seed 同构重建行）。 */
function rebindManagedWorkspace(f: F007Fixture, attempt: PlanningAttemptRow): void {
  f.session.transactWrite('f010.fixture.rebind-workspace', () => {
    const binding = f.session.database.prepare<[string], {
      id: string; binding_revision: number; repo_identity: string; git_common_dir: string | null;
    }>('SELECT id, binding_revision, repo_identity, git_common_dir FROM repository_bindings WHERE project_id = ?').get(f.projectId)!;
    const prior = f.session.database.prepare<[string, string], {
      canonical_path: string; git_common_dir: string | null; branch: string; base_commit: string; code_digest: string | null;
    }>('SELECT canonical_path, git_common_dir, branch, base_commit, code_digest FROM managed_workspaces WHERE project_id = ? AND feature_id = ?')
      .get(f.projectId, f.featureId)!;
    f.session.database.prepare('DELETE FROM managed_workspaces WHERE project_id = ? AND feature_id = ?').run(f.projectId, f.featureId);
    f.session.database.prepare(
      'INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, ' +
        'repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, ' +
        'branch, base_commit, head_commit, code_digest, status, preparation_operation_id, owner_id, ' +
        'host_instance_id, execution_version, run_id, attempt_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ' +
        '?, ?, NULL, ?, \'ready\', ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), RECOVERY_NOW, f.projectId, RECOVERY_NOW, f.featureId, binding.id, binding.binding_revision,
      binding.repo_identity, prior.canonical_path, prior.git_common_dir ?? binding.git_common_dir,
      prior.branch, prior.base_commit, prior.code_digest,
      randomUUID(), attempt.owner_id, attempt.host_instance_id, attempt.execution_version, f.planningRunId, attempt.id);
  });
}

async function publisherFor(f: F007Fixture) {
  return createArtifactPublisher({
    artifacts: createSqliteArtifactStore(f.session, { nowUtcMs: () => RECOVERY_NOW }),
    files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
    limits: { maxSizeBytes: 1_048_576, timeoutMs: 10_000 }, nowMs: () => RECOVERY_NOW,
  });
}

/** 手动发布候选制品（模拟崩溃窗口 A：文件已发布、登记事务未提交）。 */
async function publishCandidateArtifact(f: F007Fixture, body: string): Promise<{ artifactId: string; contentHash: string }> {
  const publisher = await publisherFor(f);
  const content = Buffer.from(body, 'utf8');
  const published = await publisher.publishArtifact({
    projectId: f.projectId, kind: 'planning-candidate', mediaType: 'application/json',
    expectedHash: createHash('sha256').update(content).digest('hex'),
    locator: `planning/candidates/${f.planningRunId}/${f.candidateId}/${randomUUID()}.json`,
    content: [content],
  });
  return { artifactId: published.artifact.id, contentHash: published.artifact.contentHash! };
}

/** 手动发布 runtime-settlement 制品（模拟崩溃窗口 B：结算制品已发布、生命周期事务未提交）。 */
async function publishSettlementArtifact(f: F007Fixture, attempt: PlanningAttemptRow, sessionId: string): Promise<{ artifactId: string; contentHash: string }> {
  const publisher = await publisherFor(f);
  const body = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'runtime-settlement',
    identity: {
      projectId: f.projectId, attemptId: attempt.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attempt.owner_id, hostInstanceId: attempt.host_instance_id,
      executionVersion: attempt.execution_version, sessionId, invocationId: attempt.invocation_id,
    },
    execution: {
      result: { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 42, usage: null, lastEventSequence: 4 },
      failure: null, classification: null,
    },
    recording: { complete: true, manifestRef: null, failure: null, gaps: [], watermark: 12 },
    stop: { evidence: { schemaVersion: 1, confirmed: true, checkedAtUtcMs: new Date(RECOVERY_NOW).toISOString(), detail: null }, failure: null },
  }), 'utf8');
  const published = await publisher.publishArtifact({
    projectId: f.projectId, kind: 'runtime-settlement', mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `sessions/${sessionId}/runtime-settlement.json`,
    content: [body],
  });
  return { artifactId: published.artifact.id, contentHash: published.artifact.contentHash! };
}

function submitResume(f: F007Fixture): Promise<CommandReceipt> {
  const runRevision = Number(f.query('SELECT revision AS r FROM runs WHERE id = ?', f.planningRunId).r);
  return f.core.commandService.submit(f.box.localOwner(), {
    schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
    operation: 'execution.resume', scope: { kind: 'project', projectId: f.projectId },
    expectedRevision: runRevision, payload: { runId: f.planningRunId, batchId: null },
  });
}

function submitDecide(f: F007Fixture, candidateDigest: string, commandId = randomUUID()): Promise<CommandReceipt> {
  const featureRevision = Number(f.query('SELECT revision AS r FROM features WHERE id = ?', f.featureId).r);
  return f.core.commandService.submit(f.box.localOwner(), {
    schemaVersion: 5, commandId, issuedAt: new Date(F007_NOW_BASE).toISOString(),
    operation: 'planning.candidate.decide', scope: { kind: 'project', projectId: f.projectId },
    expectedRevision: featureRevision,
    payload: { candidateId: f.candidateId, candidateDigest, decision: 'approve', reason: null },
  });
}

function planningEvents(f: F007Fixture, phase: string): { payload: string }[] {
  return f.session.database.prepare(
    "SELECT payload FROM state_events WHERE event_type = 'work.recovery.updated' AND json_extract(payload, '$.kind') = 'planning-startup-recovery' AND json_extract(payload, '$.phase') = ?",
  ).all(phase) as { payload: string }[];
}

describe('P05-1 / F-010 规划重启核对与显式恢复', () => {
  it('[case:planning-window-publication-incomplete-completes-once] 候选文件已发布但登记未完成：核验后补完登记，重复恢复不二次发布', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-wina-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    rebindManagedWorkspace(f, latestPlanningAttempt(f));
    const startsBefore = f.runtimeStarts();

    /* 崩溃窗口 A：制品已发布（Core 受控暂存），登记事务未提交。 */
    const published = await publishCandidateArtifact(f, f.candidateBody());
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId)).toMatchObject({ status: 'open' });

    /* Host 重启：fence → 规划窗口恢复 → 通用核对；证据不足的 Run 结算保留 interrupted。 */
    const state = await f.core.workExecution.recover();
    expect(state).toEqual({ status: 'blocked', reason: 'planning_recovery_required' });
    /* 登记幂等补完：上下文绑定该制品与摘要（一次有效发布）。 */
    expect(f.query('SELECT status, candidate_artifact_id, candidate_content_hash FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published', candidate_artifact_id: published.artifactId, candidate_content_hash: published.contentHash });
    /* Run/Attempt 保留 interrupted 与诊断（settlement 证据不足，不伪造成功）。 */
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId)).toMatchObject({ status: 'interrupted' });
    expect(['interrupted', 'paused']).toContain(String(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId).status));
    const diagnostics = planningEvents(f, 'diagnostic');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(JSON.parse(diagnostics[0]!.payload)).toMatchObject({ window: 'candidate_registered_run_open', status: 'unresolved' });

    /* 重复恢复：登记重放、无第二份制品/第二行登记、无隐藏 Runtime 启动。 */
    const again = await f.core.workExecution.recover();
    expect(again.status).toBe('blocked');
    expect(f.query('SELECT status, candidate_artifact_id FROM planning_contexts WHERE run_id = ?', f.planningRunId))
      .toMatchObject({ status: 'candidate_published', candidate_artifact_id: published.artifactId });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'planning-candidate') as { n: number }).n)).toBe(1);
    expect(attemptCount(f)).toBe(1);
    expect(f.runtimeStarts()).toBe(startsBefore);
    /* 恢复未完成（blocked）时调度扫描不认领、不启动。 */
    await f.core.workExecution.scan();
    expect(attemptCount(f)).toBe(1);
    expect(f.runtimeStarts()).toBe(startsBefore);
  }, 120_000);

  it('[case:planning-window-registered-run-open-settles-once] 候选已登记且结算证据完整：补完 Run 终态并释放占用；批准应用仅一次', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-winb-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const attempt = latestPlanningAttempt(f);
    rebindManagedWorkspace(f, attempt);
    const startsBefore = f.runtimeStarts();

    /* 候选真实登记（保留既有草稿 t-1，避免删除有宿主执行历史的成员），
     * 随后模拟崩溃窗口 B：结算制品已发布、生命周期事务未提交。 */
    const keepDraftBody = f.candidateBody({
      plan: {
        schemaVersion: 1,
        feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
        tasks: [
          { id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] },
          { id: 'p-1', title: '实现规划执行', acceptance: { criteria: ['规划执行可成功收尾'] }, dependsOn: [] },
        ],
      },
    });
    const submitted = await f.submitCandidate(keepDraftBody) as CommandReceipt;
    expect(submitted.status).toBe('completed');
    const candidateDigest = completedResult(submitted).candidateDigest as string;
    const sessionId = String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attempt.id).id);
    const settlement = await publishSettlementArtifact(f, attempt, sessionId);

    const state = await f.core.workExecution.recover();
    expect(state).toEqual({ status: 'complete', reason: null });
    /* Attempt/Task/Run 终态与预算补完；Session 停止 + 审计水位。 */
    expect(f.query('SELECT status, exit_code FROM attempts WHERE id = ?', attempt.id)).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'passed' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'succeeded' });
    expect(f.query('SELECT status, recording_watermark FROM sessions WHERE id = ?', sessionId))
      .toMatchObject({ status: 'stopped', recording_watermark: 12 });
    /* 占用/派发归属/工作区收口（窗口 C 同一事务内完成）。 */
    expect(f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim," +
      " (SELECT status FROM managed_workspaces) AS workspace", f.planningRunId),
    ).toMatchObject({ leases: 0, claim: 'released', workspace: 'retained' });
    expect(f.runtimeStarts()).toBe(startsBefore);

    /* 重复恢复幂等：无新增写入、无第二次结算。 */
    const again = await f.core.workExecution.recover();
    expect(again).toEqual({ status: 'complete', reason: null });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', attempt.id)).toMatchObject({ status: 'succeeded' });
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'released' });

    /* 旧 owner 晚到：恢复补完后的迟到派发结算不复活已释放归属（幂等 no-op）。 */
    const receipt = f.session.database.prepare('SELECT receipt FROM task_claim_receipts WHERE attempt_id = ?')
      .get(attempt.id) as unknown as { receipt: string };
    const dispatch = (JSON.parse(receipt.receipt) as { dispatch?: { claimId: string; claimVersion: number } }).dispatch;
    const port = createSqliteRunDispatchSettlement(f.session, { nowUtcMs: () => RECOVERY_NOW });
    const late = f.session.transactWrite('f010.late-settle', () => port.settleInTransaction({
      projectId: f.projectId, runId: f.planningRunId,
      expected: { claimId: dispatch!.claimId, claimVersion: dispatch!.claimVersion, ownerId: attempt.owner_id, hostInstanceId: attempt.host_instance_id },
      attempt: { attemptId: attempt.id, executionVersion: attempt.execution_version, ownerId: attempt.owner_id, hostInstanceId: attempt.host_instance_id },
    }));
    expect(['replayed', 'retained', 'absent']).toContain(late.decision);
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'released' });

    /* 窗口 D：批准应用提交后响应丢失——同 commandId 同信封重放返回原回执，
     * 计划仅应用一次。 */
    const decideCommandId = randomUUID();
    const decideFeatureRevision = Number(f.query('SELECT revision AS r FROM features WHERE id = ?', f.featureId).r);
    const decideEnvelope = {
      schemaVersion: 5 as const, commandId: decideCommandId, issuedAt: new Date(F007_NOW_BASE).toISOString(),
      operation: 'planning.candidate.decide' as const, scope: { kind: 'project' as const, projectId: f.projectId },
      expectedRevision: decideFeatureRevision,
      payload: { candidateId: f.candidateId, candidateDigest, decision: 'approve', reason: null },
    };
    const approved = await f.core.commandService.submit(f.box.localOwner(), decideEnvelope);
    expect(approved.status).toBe('completed');
    expect(Number((f.query("SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = 'coding'", f.featureId) as { n: number }).n)).toBe(2);
    const retried = await f.core.commandService.submit(f.box.localOwner(), decideEnvelope);
    expect(retried.status).toBe('completed');
    expect(retried.replayed).toBe(true);
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id = ?', f.planningRunId)).toMatchObject({ status: 'applied' });
  }, 120_000);

  it('[case:planning-window-finished-observation-lost-releases] Run 已终态但观察丢失：核对停止/水位后释放仍隔离的占用与归属', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-winc-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const attempt = latestPlanningAttempt(f);
    rebindManagedWorkspace(f, attempt);

    /* 候选登记 + 真实生命周期结算（Attempt/Run succeeded、Session stopped+水位），
     * 但跳过消费者收尾（不 settleDispatch、不 retention）→ 唤醒/观察丢失现场。 */
    const submitted = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(submitted.status).toBe('completed');
    const lifecycle = createSqliteAttemptLifecycleStore(f.session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.box.dataRoot] }),
      nowUtcMs: () => RECOVERY_NOW,
    });
    const applied = lifecycle.apply({
      projectId: f.projectId, attemptId: attempt.id, taskId: f.planningTaskId, runId: f.planningRunId,
      owner: attempt.owner_id, hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version,
      notificationId: 'runtime-settlement', kind: 'runtime_settled',
      runtime: {
        sessionId: String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attempt.id).id),
        invocationId: attempt.invocation_id,
        result: { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 10, usage: null, lastEventSequence: 2 },
        failure: null,
        recording: { mode: 'required', complete: true, manifestRef: String(f.query('SELECT input_ref FROM attempts WHERE id = ?', attempt.id).input_ref), gaps: [] },
        stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(RECOVERY_NOW).toISOString(), detail: null },
      },
      evidenceRef: String(f.query('SELECT input_ref FROM attempts WHERE id = ?', attempt.id).input_ref),
    });
    expect(applied).toMatchObject({ disposition: 'applied', status: 'succeeded' });
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'held' });
    /* 记录器水位（真实流程由 Recorder 在活动推进时写入；此处补齐等价事实）。 */
    f.session.database.prepare('UPDATE sessions SET recording_watermark = 12 WHERE attempt_id = ?').run(attempt.id);

    /* 重启核对：fence 隔离现场 → 规划窗口 C 释放占用/归属 → 幂等。 */
    const state = await f.core.workExecution.recover();
    expect(state).toEqual({ status: 'complete', reason: null });
    expect(f.query(
      "SELECT (SELECT COUNT(*) FROM workspace_leases) AS leases, (SELECT state FROM run_dispatch_claims WHERE run_id = ?) AS claim," +
      " (SELECT state FROM execution_slot_claims LIMIT 1) AS slot, (SELECT status FROM managed_workspaces) AS workspace", f.planningRunId),
    ).toMatchObject({ leases: 0, claim: 'released', slot: 'released', workspace: 'retained' });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', attempt.id)).toMatchObject({ status: 'succeeded' });
    const again = await f.core.workExecution.recover();
    expect(again).toEqual({ status: 'complete', reason: null });
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'released' });
  }, 120_000);

  it('[case:planning-explicit-resume-creates-new-attempt] 无可复用完成证据的非终态工作：显式 resume 后按政策创建新 Attempt 并完成规划', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-resume-', steps: standardSteps, attemptBudget: 2 });
    fixtures.push(f);
    const startsBefore = f.runtimeStarts();
    let firstAttemptId = '';

    /* 模拟「认领已提交、启动前宿主崩溃」：注入只在消费阶段抛错的 planning 消费者
     *（认领事务先行提交；无 Session/invocation/启动预占）。 */
    const crashCore = await f.box.openApplication({
      planningExecution: {
        consumePlanningClaim: async () => { throw new Error('simulated host crash before launch'); },
      },
    });
    try {
      await crashCore.workExecution.scan();
      const first = latestPlanningAttempt(f);
      firstAttemptId = first.id;
      expect(first.status).toBe('preparing');
      expect(f.query('SELECT invocation_id FROM attempts WHERE id = ?', first.id)).toMatchObject({ invocation_id: null });
      expect(f.query('SELECT COUNT(*) AS n FROM sessions') as { n: number }).toMatchObject({ n: 0 });
      rebindManagedWorkspace(f, first);

      const state = await crashCore.workExecution.recover();
      expect(state).toEqual({ status: 'complete', reason: null });
      /* 原 Attempt 保留 interrupted 终态与历史事实；Task 回到 pending、Run paused。 */
      expect(f.query('SELECT status FROM attempts WHERE id = ?', first.id)).toMatchObject({ status: 'interrupted' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', f.planningTaskId)).toMatchObject({ status: 'pending' });
      expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.planningRunId))
        .toMatchObject({ status: 'paused', reason: 'restart_recovery' });
      expect(Number((f.query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number }).n)).toBe(0);
    } finally {
      await crashCore.close();
    }

    /* 显式 resume：解除暂停进入 planning 范围（不重置预算/deadline）。 */
    const resume = await submitResume(f);
    expect(resume.status).toBe('completed');
    expect(completedResult(resume)).toMatchObject({ resumed: true, resumeScope: 'planning', status: 'queued' });

    /* 调度器按既有链路认领新 Attempt（历史 Attempt 已非活动）并启动 Runtime 一次。 */
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    expect(attemptCount(f)).toBe(2);
    const second = latestPlanningAttempt(f);
    expect(second.id).not.toBe(firstAttemptId);
    expect(f.runtimeStarts()).toBe(startsBefore + 1);
    /* 会话策略：auto 无受信来源 → 降级新会话并记录原因（绑定证据 recovery 记录）。 */
    const evidenceLocator = f.session.database.prepare(
      "SELECT storage_locator FROM artifacts WHERE kind = 'execution-input-read-evidence' AND project_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(f.projectId) as { storage_locator: string } | undefined;
    expect(evidenceLocator).toBeDefined();
    const evidenceArtifact = f.session.database.prepare(
      'SELECT id FROM artifacts WHERE storage_locator = ? AND project_id = ?',
    ).get(evidenceLocator!.storage_locator, f.projectId) as { id: string };
    const verifier = createArtifactVerifier({
      artifacts: createSqliteArtifactStore(f.session, { nowUtcMs: () => RECOVERY_NOW }),
      files: createArtifactFileStore({ dataRoot: f.box.dataRoot }),
      limits: { maxReadBytes: 4 * 1024 * 1024 },
    });
    const bindingEvidence = JSON.parse(new TextDecoder().decode(
      (await verifier.readVerifiedContent(f.projectId, evidenceArtifact.id)).content,
    )) as { recovery?: { selectionMode?: string; decision?: string; reasons?: string[] } };
    expect(bindingEvidence.recovery).toMatchObject({ selectionMode: 'auto', decision: 'new' });
    expect(bindingEvidence.recovery?.reasons).toContain('source:missing');
    /* 旧 owner 晚到：新认领代次存在后，旧 Attempt 围栏的迟到结算被拒绝。 */
    const latePort = createSqliteRunDispatchSettlement(f.session, { nowUtcMs: () => RECOVERY_NOW });
    const firstReceipt = f.session.database.prepare('SELECT receipt FROM task_claim_receipts WHERE attempt_id = ?')
      .get(firstAttemptId) as unknown as { receipt: string };
    const firstDispatch = (JSON.parse(firstReceipt.receipt) as { dispatch?: { claimId: string; claimVersion: number } }).dispatch;
    const firstRow = f.session.database.prepare('SELECT owner_id, host_instance_id, execution_version FROM attempts WHERE id = ?')
      .get(firstAttemptId) as { owner_id: string; host_instance_id: string; execution_version: number };
    expect(() => f.session.transactWrite('f010.late-old-owner', () => latePort.settleInTransaction({
      projectId: f.projectId, runId: f.planningRunId,
      expected: { claimId: firstDispatch!.claimId, claimVersion: firstDispatch!.claimVersion, ownerId: firstRow.owner_id, hostInstanceId: firstRow.host_instance_id },
      attempt: { attemptId: firstAttemptId, executionVersion: firstRow.execution_version, ownerId: firstRow.owner_id, hostInstanceId: firstRow.host_instance_id },
    }))).toThrow(expect.objectContaining({ details: { reason: 'stale_dispatch_identity' } }));
    /* 新 Attempt 完成候选提交后 Run 成功收尾（一个逻辑候选仅一次有效发布）。 */
    const submitted = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(submitted.status).toBe('completed');
    f.gate.release();
    await expect.poll(() => f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId),
      { timeout: 15_000 }).toMatchObject({ status: 'succeeded' });
    expect(f.query('SELECT status FROM attempts WHERE id = ?', second.id)).toMatchObject({ status: 'succeeded' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'planning-candidate') as { n: number }).n)).toBe(1);
    /* 原 Attempt 终态与历史候选（无）保留；预算计数未清零。 */
    expect(Number((f.query("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = 'interrupted'", f.planningTaskId) as { n: number }).n)).toBe(1);
    expect(Number((f.query('SELECT attempts_created AS n FROM execution_batches') as { n: number }).n)).toBe(2);
  }, 180_000);

  it('[case:planning-resume-rejections] 额度耗尽、输入漂移与候选已发布上下文明确拒绝 resume', async () => {
    /* 额度耗尽：Run 尝试上限 1 已被中断 Attempt 消耗。 */
    const exhausted = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-quota-', steps: standardSteps });
    fixtures.push(exhausted);
    const quotaCrash = await exhausted.box.openApplication({
      planningExecution: {
        consumePlanningClaim: async () => { throw new Error('simulated host crash before launch'); },
      },
    });
    try {
      await quotaCrash.workExecution.scan();
      rebindManagedWorkspace(exhausted, latestPlanningAttempt(exhausted));
      expect((await quotaCrash.workExecution.recover())).toEqual({ status: 'complete', reason: null });
    } finally {
      await quotaCrash.close();
    }
    const quotaResume = await submitResume(exhausted);
    expect(quotaResume.status).toBe('rejected');
    expect((quotaResume as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('budget_exhausted');
    expect(exhausted.query('SELECT status FROM runs WHERE id = ?', exhausted.planningRunId)).toMatchObject({ status: 'paused' });
    await exhausted.core.workExecution.scan();
    expect(attemptCount(exhausted)).toBe(1);
    expect(exhausted.runtimeStarts()).toBe(0);

    /* 输入漂移：上下文输入摘要与当前规划输入不一致 → resume 后认领被拒。 */
    const drifted = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-drift-', steps: standardSteps, attemptBudget: 2 });
    fixtures.push(drifted);
    const driftCrash = await drifted.box.openApplication({
      planningExecution: {
        consumePlanningClaim: async () => { throw new Error('simulated host crash before launch'); },
      },
    });
    try {
      await driftCrash.workExecution.scan();
      rebindManagedWorkspace(drifted, latestPlanningAttempt(drifted));
      expect((await driftCrash.workExecution.recover())).toEqual({ status: 'complete', reason: null });
    } finally {
      await driftCrash.close();
    }
    drifted.session.database.prepare(
      `UPDATE tasks SET requirements_refs = ?, revision = revision + 1 WHERE id = ?`,
    ).run(JSON.stringify([{
      artifactId: randomUUID(), version: 1, contentHash: 'a'.repeat(64), sizeBytes: 1,
      locator: 'input/drifted-requirements.json', mediaType: 'application/json', purpose: 'requirements', kind: 'input',
    }]), drifted.planningTaskId);
    const driftResume = await submitResume(drifted);
    expect(driftResume.status).toBe('completed');
    await drifted.core.workExecution.scan();
    /* 输入漂移：重新认领被结构化拒绝（准备/认领层任一输入门控），
     * 不创建新 Attempt、不启动 Runtime、不重置预算。 */
    await expect.poll(() => drifted.query('SELECT reason FROM runs WHERE id = ?', drifted.planningRunId) as { reason: string | null },
      { timeout: 15_000 }).toMatchObject({ reason: expect.any(String) });
    const driftReason = String(drifted.query('SELECT reason FROM runs WHERE id = ?', drifted.planningRunId).reason);
    expect(driftReason).not.toBe('restart_recovery');
    expect(attemptCount(drifted)).toBe(1);
    expect(drifted.runtimeStarts()).toBe(0);

    /* 候选已发布（存在待核对完成证据）：恢复证据不足时 resume 被启动恢复门控
     * 拒绝；补齐结算证据并完成后，终态 Run 不重开——均不重跑模型。 */
    const publishedContext = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-pubctx-', steps: standardSteps, attemptBudget: 2 });
    fixtures.push(publishedContext);
    await publishedContext.core.workExecution.scan();
    await publishedContext.waitForExecutingState();
    const attemptC = latestPlanningAttempt(publishedContext);
    rebindManagedWorkspace(publishedContext, attemptC);
    const submittedC = await publishedContext.submitCandidate(publishedContext.candidateBody()) as CommandReceipt;
    expect(submittedC.status).toBe('completed');
    const blockedState = await publishedContext.core.workExecution.recover();
    expect(blockedState).toEqual({ status: 'blocked', reason: 'planning_recovery_required' });
    expect(publishedContext.query('SELECT status FROM planning_contexts WHERE run_id = ?', publishedContext.planningRunId))
      .toMatchObject({ status: 'candidate_published' });
    await expect(submitResume(publishedContext)).rejects.toMatchObject({ details: { reason: 'startup_recovery' } });
    /* 补齐结算证据：新宿主实例重启后恢复补完 Run 终态，resume 因终态被拒绝
     *（不重开 succeeded Run，也不重置预算）。 */
    const sessionIdC = String(publishedContext.query('SELECT id FROM sessions WHERE attempt_id = ?', attemptC.id).id);
    await publishSettlementArtifact(publishedContext, attemptC, sessionIdC);
    const reopenCore = await publishedContext.box.openApplication({});
    try {
      const completedState = await reopenCore.workExecution.recover();
      expect(completedState).toEqual({ status: 'complete', reason: null });
      const runRevisionC = Number(publishedContext.query('SELECT revision AS r FROM runs WHERE id = ?', publishedContext.planningRunId).r);
      const terminalResume = await reopenCore.commandService.submit(publishedContext.box.localOwner(), {
        schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
        operation: 'execution.resume', scope: { kind: 'project', projectId: publishedContext.projectId },
        expectedRevision: runRevisionC, payload: { runId: publishedContext.planningRunId, batchId: null },
      });
      expect(terminalResume.status).toBe('rejected');
      expect((terminalResume as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('already_terminal');
    } finally {
      await reopenCore.close();
    }
    expect(attemptCount(publishedContext)).toBe(1);
    expect(publishedContext.runtimeStarts()).toBe(1);
  }, 180_000);

  it('[case:planning-recovery-uncertain-and-fencing-gaps] 结算证据缺失/控制先获胜保留现场；fence 核对候选发布与水位缺口', async () => {
    const f = await openF007ControlFixture({ prefix: 'shiploop-p051-f010-unc-', steps: standardSteps });
    fixtures.push(f);
    await f.core.workExecution.scan();
    await f.waitForExecutingState();
    const attempt = latestPlanningAttempt(f);
    rebindManagedWorkspace(f, attempt);
    const startsBefore = f.runtimeStarts();

    /* 候选已登记但无 runtime-settlement 制品：停止/结算证据不足。 */
    const submitted = await f.submitCandidate(f.candidateBody()) as CommandReceipt;
    expect(submitted.status).toBe('completed');
    /* fence 增补核对：候选发布制品失效（failed）与审计水位缺失都作为隔离诊断保留。 */
    f.session.database.prepare(
      "UPDATE artifacts SET status = 'failed' WHERE kind = 'planning-candidate' AND project_id = ?",
    ).run(f.projectId);
    const state = await f.core.workExecution.recover();
    expect(state).toEqual({ status: 'blocked', reason: 'planning_recovery_required' });
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId)).toMatchObject({ status: 'interrupted' });
    expect(Number((f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'") as { n: number }).n)).toBe(3);
    expect(f.query('SELECT state FROM run_dispatch_claims WHERE run_id = ?', f.planningRunId)).toMatchObject({ state: 'quarantined' });
    const diagnostics = planningEvents(f, 'diagnostic');
    expect(JSON.parse(diagnostics[0]!.payload)).toMatchObject({ window: 'candidate_registered_run_open', status: 'unresolved' });
    const fenced = f.session.database.prepare(
      "SELECT payload FROM state_events WHERE event_type = 'work.recovery.updated' AND json_extract(payload, '$.phase') = 'fenced' AND attempt_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(attempt.id) as { payload: string };
    const fencedGaps = (JSON.parse(fenced.payload) as { gaps: string[] }).gaps;
    expect(fencedGaps).toContain('planning_candidate_artifact_missing');
    expect(fencedGaps).toContain('planning_recording_watermark_missing');
    expect(f.runtimeStarts()).toBe(startsBefore);
    expect(attemptCount(f)).toBe(1);

    /* 取消控制先获胜：即使存在完整结算制品，也不成功收尾（保留控制状态）。 */
    f.session.database.prepare(
      "UPDATE artifacts SET status = 'ready' WHERE kind = 'planning-candidate' AND project_id = ?",
    ).run(f.projectId);
    const sessionId = String(f.query('SELECT id FROM sessions WHERE attempt_id = ?', attempt.id).id);
    const settlement = await publishSettlementArtifact(f, attempt, sessionId);
    f.session.transactWrite('f010.fixture.control-won', () => {
      f.session.database.prepare(
        "UPDATE runs SET status = 'cancelling', reason = 'user_cancel', revision = revision + 1 WHERE id = ? AND status IN ('interrupted', 'paused')",
      ).run(f.planningRunId);
    });
    const controlState = await f.core.workExecution.recover();
    expect(controlState.status).toBe('blocked');
    expect(f.query('SELECT status FROM attempts WHERE task_id = ?', f.planningTaskId)).toMatchObject({ status: 'interrupted' });
    expect(f.query('SELECT status FROM runs WHERE id = ?', f.planningRunId)).toMatchObject({ status: 'cancelling' });
    expect(Number((f.query('SELECT COUNT(*) AS n FROM artifacts WHERE id = ?', settlement.artifactId) as { n: number }).n)).toBe(1);
  }, 120_000);
});

/* 真实 provider/model 调用：not_run（本文件全部离线；未经授权不发起真实模型请求）。 */
