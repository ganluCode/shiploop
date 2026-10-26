/**
 * P05-1 / F-011：规划上下文/候选授权查询面（Core 应用层直接调用，不经 HTTP）。
 *
 * 验收面（全部基于真实临时 SQLite/真实命令通道/受管 Artifact 文件）：
 * - 详情查询（planning.context.get）：关联 Project/Phase/Feature/Batch/Run/
 *   planning Task/Attempt、输入摘要、候选 Artifact 与 candidateDigest、规划
 *   状态、拒绝原因、应用映射与预算阻塞/停止原因；生成前候选明确
 *   pending_generation，不返回伪造空候选；
 * - 一致读状态区分：queued/running、待审批、拒绝、已应用、失败、取消、待恢复；
 *   planning Run 成功、计划批准、编码可执行三轴独立展示，不互相冒充；
 * - 候选详情（planning.candidate.get）：正文经既有受管 Artifact 完整性核验
 *   读取 + 契约/身份/摘要交叉核对；缺失/损坏 fail-closed（corrupt_state 且
 *   原因明确），拒绝/历史候选正文仍可读（历史保留）；
 * - 列表（planning.contexts.list）：稳定 id 升序、有限分页、受控游标（绑定
 *   数据根 + 项目 [+ Feature 过滤]）；跨项目/跨过滤/坏游标 invalid_cursor；
 *   分页参数/未知键/超限拒绝；
 * - 授权：能力缺失 forbidden；受限主体跨项目目标统一 not_found（不区分存在
 *   性）；列表对不可见项目 forbidden 且可见性先于分页校验；
 * - 只读：多轮查询后持久行计数不变（零写入、零事件、零恢复、零导入）；
 * - 规划历史不是业务 Task：tasks.list/features.get/审批有效性不把 planning
 *   Task 计入业务 Task 或完成数量。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqlitePlanningQueryStore } from '../../../packages/core/src/adapters/sqlite/planning-query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PLAN_LIST_MAX_LIMIT } from '../../../packages/core/src/ports/queries.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createPlanningStartService } from '../../../packages/core/src/application/planning-start.ts';
import { createPlanningQueryService } from '../../../packages/core/src/application/planning-query.ts';
import { createPlanningCandidateDecisionPort } from '../../../packages/core/src/application/planning-candidate-decision.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import type { CommandReceipt, PublicError } from '../../../packages/core/src/ports/commands.ts';
import { openPlanningSubmitFixture, SUBMIT_NOW } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';
import type { PlanningSubmitFixture } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';

let fixture: PlanningSubmitFixture | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const PLANNING_BUDGET = {
  batch: {
    maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1,
    deadlineUtcMs: SUBMIT_NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
};

function completed(value: CommandReceipt): CommandReceipt & { status: 'completed'; result: Record<string, unknown> } {
  if (value.status !== 'completed') throw new Error(`expected completed: ${JSON.stringify(value)}`);
  return value as CommandReceipt & { status: 'completed'; result: Record<string, unknown> };
}

interface QueryRig {
  readonly planning: ReturnType<typeof createPlanningQueryService>;
  readonly queries: ReturnType<typeof createQueryService>;
  readonly commands: ReturnType<typeof createCommandService>;
  submit(operation: string, scope: unknown, payload: Record<string, unknown>, extra?: Record<string, unknown>): Promise<CommandReceipt>;
}

function openQueryRig(f: PlanningSubmitFixture): QueryRig {
  const queryStore = createSqliteQueryStore(f.session, { nowUtcMs: () => SUBMIT_NOW });
  const stateStore = createSqliteStateStore(f.session);
  const commands = createCommandService({
    atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => SUBMIT_NOW }),
    repositoryInspector: createRepositoryInspector(),
    planningStart: createPlanningStartService({ nowMs: () => SUBMIT_NOW }),
    planningCandidateDecision: createPlanningCandidateDecisionPort({
      atomicStore: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => SUBMIT_NOW }),
      verifier: createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 16_000_000 } }),
    }),
    nowUtcMs: () => SUBMIT_NOW,
  });
  const planning = createPlanningQueryService({
    planningReads: createSqlitePlanningQueryStore(f.session, { nowUtcMs: () => SUBMIT_NOW }),
    executionBudgetReads: queryStore,
    artifacts: f.artifacts,
    artifactFiles: f.files,
    dataRootIdentity: computeDataRootIdentity(f.dataRoot),
    nowUtcMs: () => SUBMIT_NOW,
  });
  const queries = createQueryService({
    projectReads: queryStore, snapshots: queryStore, eventReads: queryStore, stateStore,
    configurationService: createConfigurationService({ stateStore, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) }),
    planReads: queryStore, executionBudgetReads: queryStore, scheduleReads: queryStore, workspaceReads: queryStore,
    workSessionReads: queryStore, taskEvidenceReads: queryStore, gitOperationReads: queryStore,
    featureDeliveryReads: queryStore, executionControlReads: queryStore,
    artifacts: createSqliteArtifactStore(f.session, { nowUtcMs: () => SUBMIT_NOW }),
    artifactFiles: f.files,
    dataRootIdentity: computeDataRootIdentity(f.dataRoot),
    nowUtcMs: () => SUBMIT_NOW,
  });
  const submit = async (operation: string, scope: unknown, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    commands.submit(fixture!.binding.principal, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(SUBMIT_NOW).toISOString(),
      operation, scope, payload, ...extra,
    });
  return { planning, queries, commands, submit };
}

function terminalizePlanningRun(f: PlanningSubmitFixture): void {
  f.session.transactWrite('f011.fixture.terminalize', () => {
    f.session.database.prepare("UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE id = ?").run(SUBMIT_NOW, f.attemptId);
    f.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?").run(SUBMIT_NOW, f.runId);
    f.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(f.runId);
  });
}

async function decide(f: PlanningSubmitFixture, rig: QueryRig, candidateDigest: string, decision: 'approve' | 'reject', expectedRevision = 1): Promise<CommandReceipt> {
  return rig.commands.submit(f.binding.principal, {
    schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(SUBMIT_NOW).toISOString(),
    operation: 'planning.candidate.decide',
    scope: { kind: 'project', projectId: f.projectId },
    expectedRevision,
    payload: { candidateId: f.candidateId, candidateDigest, decision, reason: decision === 'reject' ? '需要重新规划' : null },
  });
}

/** 新建 Feature 草稿并启动一次规划（返回 candidateId 与 Feature 信息）。 */
async function startPlanning(
  f: PlanningSubmitFixture,
  rig: QueryRig,
  projectId: string,
  options: { phaseId?: string; withCodingTask?: boolean; feature?: { id: string; revision: number } } = {},
): Promise<{ featureId: string; candidateId: string; planningTaskId: string }> {
  let featureId: string;
  let revision: number;
  const taskId = `c-${randomUUID().slice(0, 8)}`;
  if (options.feature !== undefined) {
    featureId = options.feature.id;
    revision = options.feature.revision;
  } else {
    const imported = completed(await rig.submit('feature.plan.import', { kind: 'project', projectId }, {
      phaseId: options.phaseId ?? 'phase-1',
      plan: {
        schemaVersion: 1,
        feature: { title: `F-011 规划目标 ${randomUUID().slice(0, 8)}`, description: null, labels: [], sourceRefs: [] },
        tasks: options.withCodingTask === false ? [] : [
          { id: taskId, title: '草稿编码任务', acceptance: { criteria: ['可规划'] }, dependsOn: [] },
        ],
      },
    }, { expectedRevision: 1 })) as CommandReceipt & { result: { feature: { id: string; revision: number } } };
    featureId = imported.result.feature.id;
    revision = imported.result.feature.revision;
  }
  const started = await rig.submit(PLANNING_START_OPERATION, { kind: 'project', projectId }, {
    schemaVersion: 1, projectId, phaseId: options.phaseId ?? 'phase-1', featureId,
    requirementRefs: [], constraints: [], acceptance: { criteria: ['候选包含 Task 拆分'] },
    strategy: { approvalMode: 'manual', taskLimit: null },
    budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
  }, { expectedRevision: revision });
  if (started.status !== 'accepted' && started.status !== 'completed') {
    throw new Error(`planning.start failed: ${JSON.stringify(started)}`);
  }
  const accepted = started as CommandReceipt & { runId: string; planningTaskId: string; candidateId: string };
  return { featureId, candidateId: accepted.candidateId, planningTaskId: accepted.planningTaskId };
}

/** 终止一个仅经命令启动（未认领）的规划：上下文/Run/Batch 置取消终态。 */
function cancelStartedPlanning(f: PlanningSubmitFixture, candidateId: string): void {
  f.session.transactWrite('f011.fixture.cancel-started', () => {
    f.session.database.prepare("UPDATE planning_contexts SET status = 'cancelled' WHERE candidate_id = ?").run(candidateId);
    f.session.database.prepare("UPDATE runs SET status = 'cancelled' WHERE id = (SELECT run_id FROM planning_contexts WHERE candidate_id = ?)").run(candidateId);
    f.session.database.prepare("UPDATE execution_batches SET status = 'cancelled' WHERE id = (SELECT batch_id FROM runs WHERE id = (SELECT run_id FROM planning_contexts WHERE candidate_id = ?))").run(candidateId);
  });
}

function artifactFilePath(f: PlanningSubmitFixture, artifactId: string): string {
  return join(f.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId }));
}

async function publicErrorOf(run: () => Promise<unknown>): Promise<PublicError> {
  return (await run().then(
    (value) => {
      throw new Error(`expected PublicError, got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
}

describe('P05-1 / F-011 规划详情与候选详情查询', () => {
  it('[case:planning-detail-pending-candidate] 生成前候选明确 pending_generation，不伪造空候选；关联身份/预算/停止原因齐全', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    const detail = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(detail.scope).toBe('planning-context');
    expect(detail.context).toMatchObject({
      projectId: f.projectId, phaseId: 'phase-1', featureId: f.featureId,
      runId: f.runId, planningTaskId: f.planningTaskId, candidateId: f.candidateId,
      status: 'open', decision: null,
      planningTask: { id: f.planningTaskId, status: 'running', strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
    });
    expect(typeof detail.context.inputDigest).toBe('string');
    expect(detail.context.candidate).toEqual({ state: 'pending_generation' });
    expect(detail.executionState).toBe('running');
    expect(detail.run).toMatchObject({ id: f.runId, status: 'running', reason: 'scheduler_not_assembled', attemptsCreated: 1 });
    expect(typeof detail.run.batchId).toBe('string');
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ id: f.attemptId, status: 'executing' });
    // 三轴分离：Run 未成功、计划未批准、编码不可执行（有 coding Task 但未批准）。
    expect(detail.outcomeAxes).toEqual({
      runSucceeded: false, planApproved: false, codingExecutable: false,
      notExecutableReasons: ['plan_not_approved'],
    });
    // 预算投影复用既有形状：batch 身份与停止/阻塞原因为只读派生。
    expect(detail.budget.batch.id).toBe(detail.run.batchId);
    expect(detail.budget.schemaVersion).toBe(5);
    // 候选查询：生成前显式 pending_generation，不返回正文/摘要。
    const candidate = await rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(candidate.candidate).toEqual({ state: 'pending_generation' });
    expect(candidate.runStatus).toBe('running');
    // 秘密纪律：不携带数据库路径、凭据引用或策略副本原文键。
    const serialized = JSON.stringify(detail) + JSON.stringify(candidate);
    expect(serialized).not.toContain(f.dataRoot);
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain('endpointRef');
    expect(serialized).not.toContain('executionConfig');
  });

  it('[case:planning-published-awaiting-approval] 发布后关联 candidateDigest/Artifact，Run 成功与待审批/编码可执行分轴展示', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    const published = completed(await f.bridge.invoke(f.request()) as CommandReceipt);
    const candidateDigest = published.result.candidateDigest as string;
    const artifactId = (f.planningContext() as { candidate_artifact_id: string }).candidate_artifact_id;

    // Run 运行中：已发布但仍归入 running（Run 成功是独立轴）。
    const during = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(during.context.candidate).toMatchObject({ state: 'published', artifactId, candidateDigest });
    expect(during.executionState).toBe('running');
    expect(during.outcomeAxes.runSucceeded).toBe(false);

    terminalizePlanningRun(f);
    const detail = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(detail.executionState).toBe('awaiting_approval');
    expect(detail.context.status).toBe('candidate_published');
    expect(detail.outcomeAxes).toEqual({
      runSucceeded: true, planApproved: false, codingExecutable: false,
      notExecutableReasons: ['plan_not_approved'],
    });

    // 候选正文：受管 Artifact 完整性核验 + 契约投影。
    const candidate = await rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(candidate.candidate).toMatchObject({
      state: 'published',
      artifact: { artifactId },
      candidateDigest,
    });
    const body = candidate.candidate as Extract<typeof candidate.candidate, { state: 'published' }>;
    expect(body.plan.tasks.map((task) => task.id)).toEqual(['p-1', 'p-2']);
    expect(body.plan.taskCount).toBe(2);
    expect(body.plan.dependencyEdgeCount).toBe(1);
    expect(body.taskVerification[0]).toMatchObject({ taskId: 'p-1', checkRefs: ['unit-core'], moduleRefs: ['core'] });
    const stored = JSON.parse(readFileSync(artifactFilePath(f, artifactId), 'utf8')) as { summary: string };
    expect(body.summary).toBe(stored.summary);
  });

  it('[case:planning-rejected-applied-history] 拒绝保留原因与候选正文，历史上下文与新规划并存', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    const published = completed(await f.bridge.invoke(f.request()) as CommandReceipt);
    terminalizePlanningRun(f);
    const receipt = completed(await decide(f, rig, published.result.candidateDigest as string, 'reject'));
    expect(receipt.result).toMatchObject({ decision: 'reject' });

    const rejected = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(rejected.context.status).toBe('rejected');
    expect(rejected.executionState).toBe('rejected');
    expect(rejected.context.decision).toMatchObject({ decision: 'rejected', reason: '需要重新规划', appliedRevision: null, appliedAt: null });
    // 拒绝后候选正文仍可读（历史保留，不因查询或决策删除）。
    const body = await rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(body.candidate.state).toBe('published');

    // 同 Feature 发起全新规划：旧候选/决策保留，列表含全部历史。
    const restarted = await startPlanning(f, rig, f.projectId, { feature: { id: f.featureId, revision: 1 } });
    expect(restarted.candidateId).not.toBe(f.candidateId);
    expect(restarted.featureId).toBe(f.featureId);
    const list = await rig.planning.listPlanningContexts(f.binding.principal, { projectId: f.projectId, featureId: f.featureId, limit: 10 });
    expect(list.records.map((record) => record.candidateId).sort()).toEqual([f.candidateId, restarted.candidateId].sort());
    const historyRow = list.records.find((record) => record.candidateId === f.candidateId);
    expect(historyRow).toMatchObject({ status: 'rejected', candidateState: 'published', decision: 'rejected' });

    // 批准路径的应用映射：新候选保留既有 Task（避免移除有执行历史的历史 Task）。
    const fresh = await openPlanningSubmitFixture();
    const freshRig = openQueryRig(fresh);
    const freshPublished = completed(await fresh.bridge.invoke(fresh.request({
      candidate: fresh.candidateBody({
        plan: {
          schemaVersion: 1,
          feature: { title: '规划后的交付计划', description: null, labels: [], sourceRefs: [] },
          tasks: [
            { id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] },
            { id: 'p-1', title: '实现候选提交', acceptance: { criteria: ['候选可提交并通过校验'] }, dependsOn: [] },
            { id: 'p-2', title: '回归候选重放', acceptance: { criteria: ['重放不重复发布'] }, dependsOn: ['p-1'] },
          ],
        },
        taskVerification: [{ taskId: 't-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core'] }],
      }),
    })) as CommandReceipt);
    terminalizePlanningRun(fresh);
    completed(await decide(fresh, freshRig, freshPublished.result.candidateDigest as string, 'approve'));
    const applied = await freshRig.planning.getPlanningContext(fresh.binding.principal, { projectId: fresh.projectId, candidateId: fresh.candidateId });
    expect(applied.context.status).toBe('applied');
    expect(applied.executionState).toBe('applied');
    expect(applied.context.decision).toMatchObject({ decision: 'approved', appliedRevision: 2 });
    expect(applied.outcomeAxes.planApproved).toBe(true);
    expect(applied.outcomeAxes.codingExecutable).toBe(true);
    expect(applied.outcomeAxes.notExecutableReasons).toEqual([]);
    fresh.close();
  });

  it('[case:planning-terminal-and-recovery-states] 取消/失败/停止不确定/排队的状态区分来自持久事实', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    const target = (candidateId: string) => rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId });

    // queued：Run 尚未启动。
    f.session.transactWrite('f011.fixture.queued', () => {
      f.session.database.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(f.runId);
      f.session.database.prepare("UPDATE execution_batches SET status = 'queued' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(f.runId);
    });
    expect((await target(f.candidateId)).executionState).toBe('queued');

    // pending_recovery：Attempt interrupted（停止不确定）优先于 running。
    f.session.transactWrite('f011.fixture.interrupted', () => {
      f.session.database.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(f.runId);
      f.session.database.prepare("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(f.attemptId);
    });
    expect((await target(f.candidateId)).executionState).toBe('pending_recovery');

    // failed：Run 失败终态（含结构化原因原样保留）。
    f.session.transactWrite('f011.fixture.failed', () => {
      f.session.database.prepare("UPDATE attempts SET status = 'failed' WHERE id = ?").run(f.attemptId);
      f.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'run_time_limit_exceeded' WHERE id = ?").run(f.runId);
      f.session.database.prepare("UPDATE execution_batches SET status = 'failed' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(f.runId);
    });
    const failed = await target(f.candidateId);
    expect(failed.executionState).toBe('failed');
    expect(failed.run.reason).toBe('run_time_limit_exceeded');

    // cancelled：上下文与 Run 取消终态。
    f.session.transactWrite('f011.fixture.cancelled', () => {
      f.session.database.prepare("UPDATE planning_contexts SET status = 'cancelled' WHERE candidate_id = ?").run(f.candidateId);
      f.session.database.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(f.runId);
      f.session.database.prepare("UPDATE execution_batches SET status = 'cancelled' WHERE id = (SELECT batch_id FROM runs WHERE id = ?)").run(f.runId);
    });
    expect((await target(f.candidateId)).executionState).toBe('cancelled');

    // Run 成功但候选从未发布：无可审批候选归入 failed；runSucceeded 仍独立为 true。
    const other = await startPlanning(f, rig, f.projectId);
    f.session.transactWrite('f011.fixture.succeeded-no-candidate', () => {
      f.session.database.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = (SELECT run_id FROM planning_contexts WHERE candidate_id = ?)").run(SUBMIT_NOW, other.candidateId);
      f.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = (SELECT batch_id FROM runs WHERE id = (SELECT run_id FROM planning_contexts WHERE candidate_id = ?))").run(other.candidateId);
    });
    const noCandidate = await target(other.candidateId);
    expect(noCandidate.executionState).toBe('failed');
    expect(noCandidate.outcomeAxes.runSucceeded).toBe(true);
    expect(noCandidate.context.candidate).toEqual({ state: 'pending_generation' });
  });

  it('[case:planning-attempts-bounded] 详情 Attempt 视图按 number 降序截断并置 attemptsTruncated', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    const row = f.session.database.prepare('SELECT * FROM attempts WHERE id = ?').get(f.attemptId) as Record<string, unknown>;
    const columns = Object.keys(row);
    f.session.transactWrite('f011.fixture.more-attempts', () => {
      const insert = f.session.database.prepare(
        `INSERT INTO attempts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (let number = 2; number <= 25; number += 1) {
        insert.run(...columns.map((column) =>
          column === 'id' ? `f011-extra-${number}`
            : column === 'number' ? number
            : column === 'invocation_id' ? `f011-inv-${number}`
            : column === 'status' ? 'failed'
            : row[column]));
      }
    });
    const detail = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    expect(detail.attemptsTruncated).toBe(true);
    expect(detail.attempts).toHaveLength(20);
    // 最新 20 条（number 6..25），按 number 升序展示。
    expect(detail.attempts[0].number).toBe(6);
    expect(detail.attempts[19].number).toBe(25);
  });
});

describe('P05-1 / F-011 候选正文完整性与损坏负例', () => {
  it('[case:planning-candidate-body-corruption] 缺失/损坏/未就绪/身份漂移明确 corrupt_state，不降级为无候选', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    await f.bridge.invoke(f.request());
    const artifactId = (f.planningContext() as { candidate_artifact_id: string }).candidate_artifact_id;
    const path = artifactFilePath(f, artifactId);
    const read = () => rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });

    // 正文损坏：磁盘内容与登记摘要不一致。
    writeFileSync(path, '{"tampered":true}');
    await expect(publicErrorOf(read)).resolves.toMatchObject({
      code: 'corrupt_state', details: { reason: 'candidate_body_corrupt' },
    });

    // 正文缺失：文件不存在。
    rmSync(path);
    await expect(publicErrorOf(read)).resolves.toMatchObject({
      code: 'corrupt_state', details: { reason: 'candidate_body_missing' },
    });

    // 索引未就绪（登记状态漂移）。
    f.session.database.prepare("UPDATE artifacts SET status = 'pending' WHERE id = ?").run(artifactId);
    await expect(publicErrorOf(read)).resolves.toMatchObject({
      code: 'corrupt_state', details: { reason: 'candidate_artifact_not_ready' },
    });
    f.session.database.prepare("UPDATE artifacts SET status = 'ready' WHERE id = ?").run(artifactId);

    // 制品索引摘要与上下文登记漂移（等效候选身份变化）。
    f.session.database.prepare('UPDATE artifacts SET content_hash = ? WHERE id = ?').run('cd'.repeat(32), artifactId);
    await expect(publicErrorOf(read)).resolves.toMatchObject({
      code: 'corrupt_state', details: { reason: 'candidate_artifact_changed' },
    });
    f.session.database.prepare('UPDATE artifacts SET content_hash = ? WHERE id = ?').run(
      (f.planningContext() as { candidate_content_hash: string }).candidate_content_hash, artifactId);
  });
});

describe('P05-1 / F-011 规划上下文列表：排序、分页与受控游标', () => {
  it('[case:planning-list-pagination] 稳定 id 升序键集分页：跨页无重无漏、末页 nextCursor null、过滤与项目绑定游标', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    // 同项目活动规划互斥：先终止夹具自身的活动规划再追加上下文。
    cancelStartedPlanning(f, f.candidateId);
    const extra1 = await startPlanning(f, rig, f.projectId);
    // 同 Feature 第二次规划（历史保留）：先终止首次规划再重启。
    cancelStartedPlanning(f, extra1.candidateId);
    const extra1again = await startPlanning(f, rig, f.projectId, { feature: { id: extra1.featureId, revision: 1 } });
    const allIds = [f.candidateId, extra1.candidateId, extra1again.candidateId].sort();

    const list = (input: Record<string, unknown>) => rig.planning.listPlanningContexts(f.binding.principal, input);
    // 参考顺序：稳定 id 升序（上下文 id），分页拼接不得重排/重漏。
    const reference = await list({ projectId: f.projectId, limit: 10 });
    expect(reference.records.map((record) => record.candidateId).sort()).toEqual(allIds);
    const referenceIds = reference.records.map((record) => record.id);
    expect([...referenceIds].sort()).toEqual(referenceIds);
    const page1 = await list({ projectId: f.projectId, limit: 2 });
    expect(page1.scope).toBe('planning-context-list');
    expect(page1.records.map((record) => record.id)).toEqual(referenceIds.slice(0, 2));
    expect(page1.nextCursor).toBeTypeOf('string');
    const page2 = await list({ projectId: f.projectId, limit: 2, cursor: page1.nextCursor });
    expect(page2.records.map((record) => record.id)).toEqual(referenceIds.slice(2));
    expect(page2.nextCursor).toBeNull();

    // Feature 过滤：只含目标 Feature 的上下文，游标绑定同一过滤（两上下文
    // 的 context id 顺序不确定，按集合断言）。
    const filteredPage1 = await list({ projectId: f.projectId, featureId: extra1.featureId, limit: 1 });
    expect(filteredPage1.records).toHaveLength(1);
    expect(filteredPage1.nextCursor).toBeTypeOf('string');
    const filteredPage2 = await list({ projectId: f.projectId, featureId: extra1.featureId, limit: 1, cursor: filteredPage1.nextCursor });
    expect(filteredPage2.records).toHaveLength(1);
    expect(filteredPage2.nextCursor).toBeNull();
    expect([...filteredPage1.records, ...filteredPage2.records].map((record) => record.candidateId).sort())
      .toEqual([extra1.candidateId, extra1again.candidateId].sort());
    // 过滤游标回到无过滤请求 → invalid_cursor（绝不当从零读取）。
    await expect(publicErrorOf(() => list({ projectId: f.projectId, cursor: filteredPage1.nextCursor })))
      .resolves.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    // 无过滤游标换到 Feature 过滤请求 → invalid_cursor。
    await expect(publicErrorOf(() => list({ projectId: f.projectId, featureId: extra1.featureId, cursor: page1.nextCursor })))
      .resolves.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });
    // 篡改游标 → invalid_cursor。
    await expect(publicErrorOf(() => list({ projectId: f.projectId, cursor: 'plcur_v1_tampered' })))
      .resolves.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });

    // 分页参数/未知键/超限在任何读取之前拒绝。
    for (const input of [
      { projectId: f.projectId, limit: 0 },
      { projectId: f.projectId, limit: PLAN_LIST_MAX_LIMIT + 1 },
      { projectId: f.projectId, limit: 'x' },
      { projectId: f.projectId, featureId: 42 },
      { projectId: f.projectId, principal: 'escalate' },
      { candidateId: f.candidateId },
    ] as const) {
      await expect(publicErrorOf(() => list(input as Record<string, unknown>)))
        .resolves.toMatchObject({ code: 'invalid_input' });
    }

    // 跨项目游标重放：项目 B 的游标在项目 A 拒绝。
    const registered = completed(await rig.submit('project.register', { kind: 'registration' }, {
      repositoryPath: f.box.repoDirB, displayName: 'F-011 项目 B', description: null, labels: [],
    })) as CommandReceipt & { result: { project: { id: string } } };
    const projectB = registered.result.project.id;
    await rig.submit('phase.create', { kind: 'project', projectId: projectB }, { id: 'phase-b', title: 'B', description: null, labels: [] });
    const planningB1 = await startPlanning(f, rig, projectB, { phaseId: 'phase-b' });
    cancelStartedPlanning(f, planningB1.candidateId);
    const planningB2 = await startPlanning(f, rig, projectB, { phaseId: 'phase-b' });
    const pageB = await rig.planning.listPlanningContexts(f.binding.principal, { projectId: projectB, limit: 1 });
    expect(pageB.nextCursor).toBeTypeOf('string');
    const pageB2 = await rig.planning.listPlanningContexts(f.binding.principal, { projectId: projectB, limit: 1, cursor: pageB.nextCursor });
    // UUID 是稳定分页键而非创建序号；第二页应只包含第一页之外的剩余记录。
    expect(pageB2.records.map((record) => record.candidateId)).toEqual(
      [planningB1.candidateId, planningB2.candidateId].filter((candidateId) => candidateId !== pageB.records[0]!.candidateId),
    );
    await expect(publicErrorOf(() => list({ projectId: f.projectId, cursor: pageB.nextCursor })))
      .resolves.toMatchObject({ code: 'invalid_input', details: { reason: 'invalid_cursor' } });

    // 规划历史不被当作业务 Task：tasks.list 只含 coding Task。
    const tasks = await rig.queries.listTasks(f.binding.principal, { projectId: f.projectId, featureId: f.featureId, limit: 50 });
    expect(tasks.records.map((record) => record.id)).toEqual(['t-1']);
    expect(tasks.records.some((record) => record.id === f.planningTaskId)).toBe(false);
    const featureDetail = await rig.queries.getFeature(f.binding.principal, f.featureId);
    expect(featureDetail.validation.taskCount).toBe(1);
    expect(featureDetail.tasks.some((record) => record.id === f.planningTaskId)).toBe(false);
  });

  it('[case:planning-empty-feature-approval-counts-coding-only] 仅含 planning Task 的空草稿审批有效性仍为 no_tasks', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    cancelStartedPlanning(f, f.candidateId);
    const empty = await startPlanning(f, rig, f.projectId, { withCodingTask: false });
    const approvals = await rig.queries.getFeatureApprovals(f.binding.principal, empty.featureId);
    // planning Task 不计入 taskCount：零业务 Task 的计划仍判 no_tasks（不可执行）。
    expect(approvals.validity.reason).toBe('no_tasks');
    expect(approvals.validity.valid).toBe(false);
    const detail = await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: empty.candidateId });
    expect(detail.outcomeAxes.notExecutableReasons).toEqual(['no_tasks', 'plan_not_approved']);
  });
});

describe('P05-1 / F-011 查询授权与只读纯度', () => {
  it('[case:planning-query-authorization] 能力缺失 forbidden；受限主体跨项目统一 not_found；列表可见性先于分页', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    await f.bridge.invoke(f.request());

    const noRead = f.box.restrictedPrincipal({ capabilities: ['events.read'], projectScope: f.box.scopeAllowlist([f.projectId]) });
    for (const run of [
      () => rig.planning.listPlanningContexts(noRead, { projectId: f.projectId }),
      () => rig.planning.getPlanningContext(noRead, { projectId: f.projectId, candidateId: f.candidateId }),
      () => rig.planning.getPlanningCandidate(noRead, { projectId: f.projectId, candidateId: f.candidateId }),
    ]) {
      await expect(publicErrorOf(run)).resolves.toMatchObject({
        code: 'forbidden', details: { reason: 'capability_denied' },
      });
    }

    // 项目 B（受限主体不可见）：详情与不存在目标错误完全一致，不泄漏存在性。
    const registered = completed(await rig.submit('project.register', { kind: 'registration' }, {
      repositoryPath: f.box.repoDirB, displayName: 'F-011 项目 B', description: null, labels: [],
    })) as CommandReceipt & { result: { project: { id: string } } };
    const projectB = registered.result.project.id;
    await rig.submit('phase.create', { kind: 'project', projectId: projectB }, { id: 'phase-b', title: 'B', description: null, labels: [] });
    const planningB = await startPlanning(f, rig, projectB, { phaseId: 'phase-b' });
    const restricted = f.box.restrictedPrincipal({ capabilities: ['project.read'], projectScope: f.box.scopeAllowlist([f.projectId]) });

    const hidden = await publicErrorOf(() => rig.planning.getPlanningContext(restricted, { projectId: projectB, candidateId: planningB.candidateId }));
    const missing = await publicErrorOf(() => rig.planning.getPlanningContext(restricted, { projectId: projectB, candidateId: randomUUID() }));
    expect(hidden).toMatchObject({ code: 'not_found', details: { reason: 'planning_entity_not_found', entityType: 'planning_context' } });
    expect(hidden.toErrorShape()).toEqual(missing.toErrorShape());
    const serialized = JSON.stringify(hidden.toErrorShape());
    expect(serialized).not.toContain(planningB.candidateId);
    expect(serialized).not.toContain(projectB);

    // 列表：不可见项目 forbidden，且可见性先于分页校验（非法 limit 也先 forbidden）。
    for (const input of [
      { projectId: projectB },
      { projectId: projectB, limit: PLAN_LIST_MAX_LIMIT + 1 },
      { projectId: projectB, cursor: 'not-a-cursor' },
      { projectId: randomUUID() },
    ] as const) {
      await expect(publicErrorOf(() => rig.planning.listPlanningContexts(restricted, input as Record<string, unknown>)))
        .resolves.toMatchObject({ code: 'forbidden', details: { reason: 'project_not_visible' } });
    }

    // 可见项目内正常授权读取。
    const visible = await rig.planning.listPlanningContexts(restricted, { projectId: f.projectId });
    expect(visible.records.map((record) => record.projectId)).toEqual([f.projectId]);
  });

  it('[case:planning-query-readonly] 查询只读：多轮查询后持久行/事件/回执计数不变', async () => {
    const f = fixture = await openPlanningSubmitFixture();
    const rig = openQueryRig(f);
    await f.bridge.invoke(f.request());
    terminalizePlanningRun(f);
    const before = f.snapshot();
    await rig.planning.listPlanningContexts(f.binding.principal, { projectId: f.projectId, limit: 1 });
    await rig.planning.listPlanningContexts(f.binding.principal, { projectId: f.projectId, featureId: f.featureId });
    await rig.planning.getPlanningContext(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    await rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    await rig.planning.getPlanningCandidate(f.binding.principal, { projectId: f.projectId, candidateId: f.candidateId });
    const after = f.snapshot();
    expect(after).toEqual(before);
  });
});
