/**
 * P03-3 / F-010 执行预算只读授权查询（真实临时 SQLite + 真实命令链）。
 *
 * 验收面（.dag_context.json F-010）：
 * 1. 查询从持久状态的一致读视图返回固定 Feature 范围、Batch/Run 身份、各层
 *    上限、已用及剩余额度、绝对 deadline、无进展次数和阻塞原因，数据库重开
 *    前后结果一致。
 * 2. 预算修订记录复用既有有界分页规则，非法分页和跨项目查询拒绝且不泄漏
 *    存在性；查询不扣预算、不发业务事件、不唤醒执行。
 * 3. 未启动或尚无耗时、退出信息、token/cost 时保持空值或明确未知，不填零；
 *    启动预占与已知实际用量分开，accepted/queued 不显示为验收成功。
 * 4. 对预算耗尽、正常剩余、修订后剩余、旧 Run 快照及未知字段分别建立查询
 *    状态断言；输出不含秘密正文、任意文件内容或开发机绝对路径。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { isPublicError } from '../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import {
  EXECUTION_BUDGET_GET_OPERATION,
  EXECUTION_BUDGET_REVISIONS_OPERATION,
} from '../packages/core/src/ports/execution-budget-query.ts';
import { createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const HOUR_MS = 3_600_000;

const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { executionLimits: { maxAttemptsPerTask: 4, maxCodeAttempts: 2 } },
};
const PROJECT_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
};

/** 主验收预算（含可选资源总额上限：用量未知必须保留未知）。 */
const MAIN_BUDGET = {
  batch: {
    maxRuns: 2,
    maxTotalAttempts: 4,
    maxRuntimeStarts: 3,
    maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + 2 * HOUR_MS,
    maxTokenTotal: 1_000,
    maxCostTotal: 12.5,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
};

/** 紧预算（计数维度可经真实预占逐层耗尽）。 */
const TIGHT_BUDGET = {
  batch: {
    maxRuns: 1,
    maxTotalAttempts: 1,
    maxRuntimeStarts: 1,
    maxNoProgressRuns: 1,
    deadlineUtcMs: NOW + 2 * HOUR_MS,
  },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: HOUR_MS },
};

function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '预算查询验收',
      labels: [],
      sourceRefs: [{ artifactId: artifactIds.src }],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        complexity: 'low',
        acceptance: { criteria: ['任务一验收'] },
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收'] },
        dependsOn: ['t-1'],
      },
    ],
  };
}

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { readonly code: string; readonly operation: string; readonly reason?: string },
): Promise<PublicError> {
  const error = (await run().then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
  expect(isPublicError(error)).toBe(true);
  expect(error).toMatchObject({ code: expected.code, operation: expected.operation });
  if (expected.reason !== undefined) {
    expect(error.details?.reason).toBe(expected.reason);
  }
  return error;
}

interface VerticalHarness {
  readonly box: CommandsTestFixture;
  readonly app: Awaited<ReturnType<CommandsTestFixture['openApplication']>>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly projectIdB: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly clock: { value: number };
  readonly session: SqliteStorageSession;
  readonly revise: (
    expectedRevision: number,
    budget: Record<string, unknown>,
    reason: string,
  ) => Promise<CommandReceipt>;
  readonly reserveAttempts: (count: number) => void;
  readonly reserveRuntimeStarts: (count: number) => void;
  readonly close: () => void;
}

let openVertical: VerticalHarness | undefined;
afterEach(() => {
  openVertical?.close();
  openVertical = undefined;
});

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as Record<string, unknown>;
}

async function setup(options: { readonly budget?: Record<string, unknown> } = {}): Promise<VerticalHarness> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p033-f010-' });
  const clock = { value: NOW };
  const nowUtcMs = (): number => clock.value;
  const app = await box.openApplication({ nowUtcMs });
  const owner = box.localOwner();
  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (
    operation: string,
    scope: unknown,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    app.commandService.submit(owner, {
      ...envelopeBase,
      commandId: randomUUID(),
      operation,
      scope,
      payload,
      ...extra,
    });

  const registered = await submit('project.register', { kind: 'registration' }, {
    repositoryPath: box.repoDirA,
    displayName: 'Repo A',
    description: null,
    labels: [],
  });
  const projectId = (completedResult(registered) as { project: { id: string } }).project.id;
  const projectScope = { kind: 'project', projectId } as const;

  // 第二个项目（跨项目查询负例；不建立执行链）。
  const registeredB = await submit('project.register', { kind: 'registration' }, {
    repositoryPath: box.repoDirB,
    displayName: 'Repo B',
    description: null,
    labels: [],
  });
  const projectIdB = (completedResult(registeredB) as { project: { id: string } }).project.id;

  for (const [operation, scope, payload] of [
    ['settings.global.create', { kind: 'global' }, GLOBAL_SETTINGS_PAYLOAD],
    ['settings.project.create', projectScope, PROJECT_SETTINGS_PAYLOAD],
  ] as const) {
    const receipt = await submit(operation, scope, payload as Record<string, unknown>);
    if (receipt.status !== 'completed') throw new Error(`夹具配置失败（${operation}）`);
  }

  const phase = await submit('phase.create', projectScope, {
    id: 'phase-1',
    title: '第一阶段',
    description: null,
    labels: [],
  });
  if (phase.status !== 'completed') throw new Error('夹具 Phase 创建失败');

  const sha256hex = async (value: string): Promise<string> =>
    import('node:crypto').then(({ createHash }) => createHash('sha256').update(value).digest('hex'));
  const seedReady = async (content: string, locatorName: string): Promise<string> => {
    const contentHash = await sha256hex(content);
    const record = await app.artifactStore.registerArtifact({
      projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: contentHash,
      locator: `artifacts/${locatorName}.md`,
    });
    await app.artifactStore.transitionArtifact(projectId, record.id, {
      expectedRevision: record.revision,
      outcome: { status: 'ready', actualHash: contentHash, sizeBytes: Buffer.byteLength(content, 'utf8') },
    });
    return record.id;
  };
  const artifactIds = {
    src: await seedReady('# 来源正文\n', 'art-src'),
    req: await seedReady('# 需求规格正文\n', 'art-req'),
  };

  const imported = await submit('feature.plan.import', projectScope, {
    phaseId: 'phase-1',
    plan: samplePlan(artifactIds),
  }, { expectedRevision: 1 });
  const importResult = completedResult(imported) as {
    feature: { id: string; planDigest: string };
    tasks: readonly { id: string }[];
  };
  const featureId = importResult.feature.id;
  const taskId = importResult.tasks[0]!.id;

  const approvals = await app.queryService.getFeatureApprovals(owner, featureId);
  const featureRevision = approvals.feature.revision;
  const planDigest = approvals.feature.planDigest;
  const decision = await submit('feature.plan.decide', projectScope, {
    featureId,
    planDigest,
    decision: 'approve',
    reason: '预算查询验收',
  }, { expectedRevision: featureRevision });
  if (decision.status !== 'completed') throw new Error('夹具批准失败');

  const budget = options.budget ?? MAIN_BUDGET;
  const previewReceipt = await submit('execution.preview', projectScope, {
    featureIds: [featureId],
    budget,
  });
  if (previewReceipt.status !== 'completed') throw new Error('夹具预览失败');
  const previewDigest = (previewReceipt.result as { previewDigest: string | null }).previewDigest;
  if (previewDigest === null) throw new Error('夹具预览未返回 ready 摘要');
  const started = await submit('execution.start', projectScope, {
    featureIds: [featureId],
    budget,
    previewDigest,
  });
  if (started.status !== 'accepted') throw new Error(`夹具执行启动失败（${started.status}）`);
  const batchId = (started as unknown as { batchId: string }).batchId;
  const runId = (started as unknown as { runId: string }).runId;

  const session = await box.openTransactionalHarness().then((harness) => harness.session);
  const access = createSqliteExecutionAccess(session, { nowUtcMs });
  const reserveAttempts = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      session.transactWrite('test.reserveAttempt', () =>
        access.reserveTaskAttemptInTransaction({
          projectId,
          batchId,
          runId,
          taskId,
          attemptKey: `attempt-${i + 1}`,
          maxAttemptsPerTask: 4,
        }),
      );
    }
  };
  const reserveRuntimeStarts = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      session.transactWrite('test.reserveRuntimeStart', () =>
        access.reserveRuntimeStartInTransaction({
          projectId,
          batchId,
          runId,
          startKey: `start-${i + 1}`,
        }),
      );
    }
  };

  const harness: VerticalHarness = {
    box,
    app,
    owner,
    projectId,
    projectIdB,
    featureId,
    taskId,
    batchId,
    runId,
    clock,
    session,
    revise: (expectedRevision: number, nextBudget: Record<string, unknown>, reason: string) =>
      app.commandService.submit(owner, {
        ...envelopeBase,
        commandId: randomUUID(),
        operation: 'execution.budget.revise',
        scope: projectScope,
        expectedRevision,
        payload: { batchId, budget: nextBudget, reason },
      }),
    reserveAttempts,
    reserveRuntimeStarts,
    close(): void {
      box.cleanup();
    },
  };
  openVertical = harness;
  return harness;
}

describe('F-010 执行预算只读查询（一致读视图/已知与未知字段）', () => {
  it('返回固定 Feature 范围、Batch/Run 身份、各层上限、已用/剩余、绝对 deadline、无进展次数与阻塞原因；数据库重开前后一致', async () => {
    const s = await setup();
    const result = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });

    // 固定 Feature 范围 + Batch 身份。
    expect(result.scope).toBe('execution-budget');
    expect(result.batch).toMatchObject({
      id: s.batchId,
      projectId: s.projectId,
      featureId: s.featureId,
      featureIds: [s.featureId],
      budgetRevision: 1,
      deadlineAtUtcMs: NOW + 2 * HOUR_MS,
    });

    // 各层上限 + 已用/剩余额度 + 绝对 deadline + 无进展次数。
    expect(result.batch.budget.batch.maxRuns).toBe(2);
    expect(result.batch.budget.run).toEqual({ maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS });
    expect(result.batch.dimensions.maxRuns).toEqual({ limit: 2, used: 1, remaining: 1, exhausted: false });
    expect(result.batch.dimensions.maxTotalAttempts).toEqual({ limit: 4, used: 0, remaining: 4, exhausted: false });
    expect(result.batch.dimensions.maxRuntimeStarts).toEqual({ limit: 3, used: 0, remaining: 3, exhausted: false });
    expect(result.batch.dimensions.maxNoProgressRuns).toEqual({ limit: 2, used: 0, remaining: 2, exhausted: false });
    expect(result.batch.dimensions.deadlineUtcMs).toEqual({
      limit: NOW + 2 * HOUR_MS,
      used: NOW,
      remaining: 2 * HOUR_MS,
      exhausted: false,
    });

    // Run 身份与冻结上限。
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      id: s.runId,
      batchId: s.batchId,
      featureId: s.featureId,
      dispatchOrdinal: 1,
      status: 'queued',
      limits: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
      attemptsCreated: 0,
    });
    expect(result.runs[0]!.dimensions.maxAttemptsPerRun).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
      exhausted: false,
    });

    // Task 层（策略副本 maxCodeAttempts=2；总 Attempt 上限来自有效配置 4）。
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      taskId: s.taskId,
      status: 'pending',
      firstPassedAt: null,
      attempts: { used: 0, limit: 4, remaining: 4 },
      codeAttempts: { used: 0, limit: 2, remaining: 2 },
    });
    expect(result.tasks[0]!.caps).toMatchObject({
      maxCodeAttempts: 2,
      maxAttemptsPerTask: 4,
      effectiveMaxCodeAttempts: 2,
    });

    // 阻塞原因：当前仅「未装配调度器」这一持久控制原因（无预算阻塞）。
    expect(result.blockingReasons).toEqual([
      { layer: 'run', layerId: s.runId, reason: 'scheduler_not_assembled' },
    ]);

    // 数据库重开前后结果一致（注入固定时钟）。
    s.app.close();
    const reopened = await s.box.openApplication({ nowUtcMs: () => s.clock.value });
    const again = await reopened.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(again).toEqual(result);
  });

  it('未启动/无耗时/无退出信息/token-cost 未知时保持 null 不填零；启动预占与实际用量分开；accepted/queued 不显示为验收成功', async () => {
    const s = await setup();

    // queued Run + accepted Work 回执绝不显示为验收成功。
    const before = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(before.runs[0]!.status).toBe('queued');
    expect(before.runs[0]!.startedAt).toBeNull();
    expect(before.runs[0]!.endedAt).toBeNull();
    expect(before.runs[0]!.elapsedMs).toBeNull();
    expect(before.runs[0]!.dimensions.runTimeLimitMs).toEqual({
      limit: HOUR_MS,
      used: null,
      remaining: null,
      exhausted: null,
    });
    expect(before.tasks.every((task) => task.status === 'pending' && task.firstPassedAt === null)).toBe(true);
    const beforeJson = JSON.stringify(before);
    expect(beforeJson).not.toContain('succeeded');
    expect(beforeJson).not.toContain('"passed"');

    // token/cost 用量未知：维度保留未知并列入 unconfirmedDimensions，不填零。
    expect(before.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
    expect(before.batch.dimensions.maxTokenTotal).toEqual({ limit: 1_000, used: null, remaining: null, exhausted: null });
    expect(before.batch.dimensions.maxCostTotal).toEqual({ limit: 12.5, used: null, remaining: null, exhausted: null });
    expect(before.batch.unconfirmedDimensions).toEqual(['maxTokenTotal', 'maxCostTotal']);

    // 真实启动预占（F-007 账本）与实际用量分开呈现。
    s.reserveRuntimeStarts(1);
    const after = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(after.batch.runtimeStartsReserved).toBe(1);
    expect(after.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
    expect(after.batch.dimensions.maxRuntimeStarts).toEqual({ limit: 3, used: 1, remaining: 2, exhausted: false });
  });

  it('预算耗尽与 deadline 恰好到达时给出结构化阻塞原因（dimension/limit/used）且剩余额度为零', async () => {
    const s = await setup({ budget: TIGHT_BUDGET });
    s.reserveAttempts(1);
    s.reserveRuntimeStarts(1);

    const result = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(result.batch.dimensions.maxRuns).toEqual({ limit: 1, used: 1, remaining: 0, exhausted: true });
    expect(result.batch.dimensions.maxTotalAttempts).toEqual({ limit: 1, used: 1, remaining: 0, exhausted: true });
    expect(result.batch.dimensions.maxRuntimeStarts).toEqual({ limit: 1, used: 1, remaining: 0, exhausted: true });
    expect(result.batch.dimensions.maxNoProgressRuns).toEqual({ limit: 1, used: 0, remaining: 1, exhausted: false });
    for (const dimension of ['maxRuns', 'maxTotalAttempts', 'maxRuntimeStarts'] as const) {
      expect(result.blockingReasons).toContainEqual({
        layer: 'batch',
        layerId: s.batchId,
        reason: 'counter_exhausted',
        dimension,
        limit: 1,
        used: 1,
      });
    }
    // Run 层：单 Run 尝试上限也已耗尽。
    expect(result.runs[0]!.dimensions.maxAttemptsPerRun).toEqual({ limit: 1, used: 1, remaining: 0, exhausted: true });

    // deadline 恰好到达 → deadline_reached（绝对时间，不填零、不假称已延期）。
    s.clock.value = NOW + 2 * HOUR_MS;
    const reached = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(reached.batch.dimensions.deadlineUtcMs.exhausted).toBe(true);
    expect(reached.batch.dimensions.deadlineUtcMs.remaining).toBe(0);
    expect(reached.blockingReasons).toContainEqual({
      layer: 'batch',
      layerId: s.batchId,
      reason: 'deadline_reached',
      dimension: 'deadlineUtcMs',
      limit: NOW + 2 * HOUR_MS,
      used: NOW + 2 * HOUR_MS,
    });
  });

  it('正常剩余：预算维度均未耗尽（仅持久 not-ready 原因）；任务尝试预占反映在 Task 层计数', async () => {
    const s = await setup();
    s.reserveAttempts(2);
    const result = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(result.batch.dimensions.maxTotalAttempts).toEqual({ limit: 4, used: 2, remaining: 2, exhausted: false });
    expect(result.tasks[0]).toMatchObject({
      attempts: { used: 2, limit: 4, remaining: 2 },
      codeAttempts: { used: 2, limit: 2, remaining: 0 },
    });
    // 代码尝试恰好耗尽 → Task 层 code_attempts_exhausted；但批次预算仍有剩余。
    expect(result.blockingReasons).toContainEqual({
      layer: 'task',
      layerId: s.taskId,
      reason: 'code_attempts_exhausted',
      dimension: 'maxCodeAttempts',
      limit: 2,
      used: 2,
    });
    expect(result.blockingReasons.filter((entry) => entry.layer === 'batch')).toEqual([]);
  });

  it('修订后剩余与旧 Run 快照：新预算版本增额生效、累计用量保留、既有 Run 冻结上限逐字节不变', async () => {
    const s = await setup();
    const revisedBudget = {
      batch: {
        maxRuns: 3,
        maxTotalAttempts: 5,
        maxRuntimeStarts: 4,
        maxNoProgressRuns: 2,
        deadlineUtcMs: NOW + 3 * HOUR_MS,
        maxTokenTotal: 1_000,
        maxCostTotal: 12.5,
      },
      run: { maxAttemptsPerRun: 4, runTimeLimitMs: 2 * HOUR_MS },
    };
    const receipt = await s.revise(1, revisedBudget, '扩大执行预算并延期');
    expect(receipt.status).toBe('completed');

    const result = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    // 修订后剩余（用量不清零）。
    expect(result.batch.budgetRevision).toBe(2);
    expect(result.batch.budget.batch.maxRuns).toBe(3);
    expect(result.batch.dimensions.maxRuns).toEqual({ limit: 3, used: 1, remaining: 2, exhausted: false });
    expect(result.batch.deadlineAtUtcMs).toBe(NOW + 3 * HOUR_MS);

    // 旧 Run 快照：派发时冻结的 Run 上限不随后续修订改变。
    expect(result.batch.budget.run).toEqual({ maxAttemptsPerRun: 4, runTimeLimitMs: 2 * HOUR_MS });
    expect(result.runs[0]!.limits).toEqual({ maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS });
    expect(result.runs[0]!.dimensions.maxAttemptsPerRun.limit).toBe(2);
  });
});

describe('F-010 预算修订记录分页（既有有界分页规则）', () => {
  it('修订记录按版本顺序有界分页，游标续读到末页；总数与版本连续', async () => {
    const s = await setup();
    await s.revise(
      1,
      {
        batch: {
          maxRuns: 3,
          maxTotalAttempts: 5,
          maxRuntimeStarts: 4,
          maxNoProgressRuns: 2,
          deadlineUtcMs: NOW + 3 * HOUR_MS,
          maxTokenTotal: 1_000,
          maxCostTotal: 12.5,
        },
        run: { maxAttemptsPerRun: 3, runTimeLimitMs: 2 * HOUR_MS },
      },
      '增额一次',
    );
    await s.revise(
      2,
      {
        batch: {
          maxRuns: 4,
          maxTotalAttempts: 6,
          maxRuntimeStarts: 5,
          maxNoProgressRuns: 2,
          deadlineUtcMs: NOW + 4 * HOUR_MS,
          maxTokenTotal: 2_000,
          maxCostTotal: 12.5,
        },
        run: { maxAttemptsPerRun: 3, runTimeLimitMs: 2 * HOUR_MS },
      },
      '增额两次',
    );

    const all = await s.app.queryService.listBatchBudgetRevisions(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    expect(all.records.map((record) => record.version)).toEqual([1, 2, 3]);
    expect(all.records[0]).toMatchObject({
      batchId: s.batchId,
      version: 1,
      approvedBy: 'local-owner',
    });
    expect(all.records[0]!.budget.batch.maxRuns).toBe(2);
    expect(all.nextCursor).toBeNull();
    expect(all.limit).toBe(50);

    // 有界分页（limit=1）：每页恰一条，游标续读出相同版本序列。
    const versions: number[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof s.app.queryService.listBatchBudgetRevisions>> =
        await s.app.queryService.listBatchBudgetRevisions(s.owner, {
          projectId: s.projectId,
          batchId: s.batchId,
          limit: 1,
          ...(cursor === null ? {} : { cursor }),
        });
      expect(page.records.length).toBeLessThanOrEqual(1);
      versions.push(...page.records.map((record) => record.version));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 10);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('非法分页（非法 limit/游标/未知键）与跨项目查询拒绝且不泄漏存在性', async () => {
    const s = await setup();
    for (const limit of [0, 201, 1.5, '1']) {
      await expectPublicError(
        () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
          projectId: s.projectId,
          batchId: s.batchId,
          limit,
        }),
        { code: 'invalid_input', operation: EXECUTION_BUDGET_REVISIONS_OPERATION },
      );
    }
    await expectPublicError(
      () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
        projectId: s.projectId,
        batchId: s.batchId,
        cursor: 'plcur_v1_???',
      }),
      { code: 'invalid_input', operation: EXECUTION_BUDGET_REVISIONS_OPERATION, reason: 'invalid_cursor' },
    );
    await expectPublicError(
      () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
        projectId: s.projectId,
        batchId: s.batchId,
        principal: 'attacker',
      }),
      { code: 'invalid_input', operation: EXECUTION_BUDGET_REVISIONS_OPERATION },
    );

    // 跨项目查询与不存在目标折叠为完全相同的 not_found（不泄漏存在性）。
    const crossProject = await expectPublicError(
      () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
        projectId: s.projectIdB,
        batchId: s.batchId,
      }),
      { code: 'not_found', operation: EXECUTION_BUDGET_REVISIONS_OPERATION },
    );
    const missing = await expectPublicError(
      () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
        projectId: s.projectIdB,
        batchId: randomUUID(),
      }),
      { code: 'not_found', operation: EXECUTION_BUDGET_REVISIONS_OPERATION },
    );
    expect(crossProject.details).toEqual(missing.details);

    // 查询面同样拒绝跨项目目标。
    const crossGet = await expectPublicError(
      () => s.app.queryService.getExecutionBudgetStatus(s.owner, {
        projectId: s.projectIdB,
        batchId: s.batchId,
      }),
      { code: 'not_found', operation: EXECUTION_BUDGET_GET_OPERATION },
    );
    const missingGet = await expectPublicError(
      () => s.app.queryService.getExecutionBudgetStatus(s.owner, {
        projectId: s.projectIdB,
        batchId: randomUUID(),
      }),
      { code: 'not_found', operation: EXECUTION_BUDGET_GET_OPERATION },
    );
    expect(crossGet.details).toEqual(missingGet.details);
  });

  it('跨批次游标拒绝（invalid_cursor），查询不扣预算、不发业务事件、不唤醒执行', async () => {
    const s = await setup();
    await s.revise(
      1,
      {
        batch: {
          maxRuns: 3,
          maxTotalAttempts: 5,
          maxRuntimeStarts: 4,
          maxNoProgressRuns: 2,
          deadlineUtcMs: NOW + 3 * HOUR_MS,
          maxTokenTotal: 1_000,
          maxCostTotal: 12.5,
        },
        run: { maxAttemptsPerRun: 3, runTimeLimitMs: 2 * HOUR_MS },
      },
      '增额一次',
    );
    const page = await s.app.queryService.listBatchBudgetRevisions(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
      limit: 1,
    });
    expect(page.nextCursor).not.toBeNull();

    // 用另一目标（同项目另一 Batch 身份）重放游标 → invalid_cursor。
    await expectPublicError(
      () => s.app.queryService.listBatchBudgetRevisions(s.owner, {
        projectId: s.projectId,
        batchId: randomUUID(),
        cursor: page.nextCursor!,
      }),
      { code: 'invalid_input', operation: EXECUTION_BUDGET_REVISIONS_OPERATION, reason: 'invalid_cursor' },
    );

    // 查询前后持久状态逐字节一致：不扣预算、不写事件、不创建任何行。
    const counts = (): Record<string, number> => {
      const table = (name: string): number =>
        (s.session.database.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
      return {
        events: table('state_events'),
        batches: table('execution_batches'),
        runs: table('runs'),
        revisions: table('batch_budget_revisions'),
        reservations: table('task_attempt_reservations'),
        runtimeStarts: table('runtime_start_reservations'),
        settlements: table('run_outcome_settlements'),
      };
    };
    const batchRowBefore = s.session.database
      .prepare('SELECT runs_created, attempts_created, runtime_starts, no_progress_runs, budget_revision, status FROM execution_batches WHERE id = ?')
      .get(s.batchId);
    const before = counts();
    await s.app.queryService.getExecutionBudgetStatus(s.owner, { projectId: s.projectId, batchId: s.batchId });
    await s.app.queryService.listBatchBudgetRevisions(s.owner, { projectId: s.projectId, batchId: s.batchId });
    expect(counts()).toEqual(before);
    expect(
      s.session.database
        .prepare('SELECT runs_created, attempts_created, runtime_starts, no_progress_runs, budget_revision, status FROM execution_batches WHERE id = ?')
        .get(s.batchId),
    ).toEqual(batchRowBefore);
  });
});

describe('F-010 授权、输入与脱敏边界', () => {
  it('缺能力/不可见项目与不存在目标不泄漏存在性；非法输入在读取前拒绝', async () => {
    const s = await setup();
    const noCapability = createRestrictedPrincipal({
      capabilities: [],
      projectScope: { kind: 'all' },
    });
    await expectPublicError(
      () => s.app.queryService.getExecutionBudgetStatus(noCapability, {
        projectId: s.projectId,
        batchId: s.batchId,
      }),
      { code: 'forbidden', operation: EXECUTION_BUDGET_GET_OPERATION },
    );
    const restricted = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: scopeAllowlist([s.projectIdB]),
    });
    const invisible = await expectPublicError(
      () => s.app.queryService.getExecutionBudgetStatus(restricted, {
        projectId: s.projectId,
        batchId: s.batchId,
      }),
      { code: 'forbidden', operation: EXECUTION_BUDGET_GET_OPERATION },
    );
    const invisibleMissing = await expectPublicError(
      () => s.app.queryService.getExecutionBudgetStatus(restricted, {
        projectId: randomUUID(),
        batchId: randomUUID(),
      }),
      { code: 'forbidden', operation: EXECUTION_BUDGET_GET_OPERATION },
    );
    expect(invisible.details).toEqual(invisibleMissing.details);

    for (const input of [
      { projectId: 'not-a-uuid!', batchId: s.batchId },
      { projectId: s.projectId, batchId: 'bad id' },
      { projectId: s.projectId, batchId: s.batchId, status: 'running' },
      { batchId: s.batchId },
    ]) {
      await expectPublicError(
        () => s.app.queryService.getExecutionBudgetStatus(s.owner, input),
        { code: 'invalid_input', operation: EXECUTION_BUDGET_GET_OPERATION },
      );
    }
  });

  it('输出不含秘密正文、任意文件内容或开发机绝对路径', async () => {
    const s = await setup();
    const status = await s.app.queryService.getExecutionBudgetStatus(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    const revisions = await s.app.queryService.listBatchBudgetRevisions(s.owner, {
      projectId: s.projectId,
      batchId: s.batchId,
    });
    const json = JSON.stringify([status, revisions]);
    for (const secret of [
      s.box.root,
      s.box.dataRoot,
      s.box.repoDirA,
      s.box.homeDir,
      '# 来源正文',
      '# 需求规格正文',
      'inputSnapshot',
      'configSnapshot',
      'scopeSnapshot',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toMatch(/\/Users\/|\/var\/folders\/|[A-Za-z]:\\\\/);
  });
});
