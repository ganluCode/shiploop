/**
 * P03-3 / F-009 预算显式修订（真实临时 SQLite + 真实授权命令通道）。
 *
 * 验收面（.dag_context.json F-009）：
 * 1. 预算增额或延期必须具备可信主体权限、目标项目归属、expectedRevision 与
 *    非空理由；模型提出的理由或客户端自声明批准不能授予权限。
 * 2. 有效修订在一个短事务内更新当前预算、增加修订身份、保存不可变修订记录并
 *    写脱敏事件与回执；保留此前授权预算及 Run/Task/输入快照，累计计数不清零。
 * 3. 运行中增额可通过明确授权提交；仅增额不自动启动或恢复 Run。额度降低到
 *    已使用值以下、非法 deadline、过期 revision、跨项目及未知字段均拒绝，
 *    失败无部分更新。
 * 4. 相同修订命令重放不产生第二条修订或事件，不同参数复用 commandId 冲突；
 *    真实 SQLite CAS 竞争仅一个成功，审计记录可核对批准主体、时间、理由及
 *    修订前后值。
 * 5. Task 代码尝试上限的显式调整复用前序 Task 策略 CAS 通道并受同样授权与
 *    审计约束；不得通过更新默认配置、换 Run 或热改活动输入静默增额。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../packages/core/src/application/execution-start.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createBaselineWorkspaceReader } from '../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { isPublicError } from '../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import { EXECUTION_BUDGET_REVISED_EVENT_TYPE } from '../packages/core/src/ports/execution-store.ts';
import type { BatchBudgetRevisionResult } from '../packages/core/src/ports/execution-store.ts';
import { evaluateBatchBudgetReservation } from '../packages/core/src/ports/execution-budget.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../packages/core/src/ports/execution-input-prepare.ts';
import { mapStateEvents, PUBLIC_STATE_EVENT_TYPES } from '../packages/core/src/ports/events.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import { createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from './helpers/p02-2/index.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const HOUR_MS = 3_600_000;

const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};
const PROJECT_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
};

const VALID_BUDGET = {
  batch: {
    maxRuns: 2,
    maxTotalAttempts: 8,
    maxRuntimeStarts: 8,
    maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + HOUR_MS,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: HOUR_MS },
};

function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '预算修订验收',
      labels: [],
      sourceRefs: [{ artifactId: artifactIds.src }],
    },
    tasks: [
      { id: 't-1', title: '任务一', complexity: 'low', acceptance: { criteria: ['任务一验收'] } },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收甲', '任务二验收乙'] },
        dependsOn: ['t-1'],
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
    ],
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误但成功返回');
}

function expectPublicError(error: unknown, code: string): PublicError {
  expect(isPublicError(error)).toBe(true);
  const publicError = error as PublicError;
  expect(publicError.code).toBe(code);
  return publicError;
}

function expectStorageConflict(error: unknown, reason: string): StorageError {
  expect(isStorageError(error, 'conflict')).toBe(true);
  const storageError = error as StorageError;
  expect((storageError.details as { reason?: string } | undefined)?.reason).toBe(reason);
  return storageError;
}

/* ------------------------------------------------------------------ *
 * 纵向夹具：真实命令通道（注册/配置/计划/批准/启动一条链）
 * ------------------------------------------------------------------ */

interface VerticalHarness {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly service: CommandService;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly db: SqliteStorageSession['database'];
  readonly revise: (changes?: Record<string, unknown>) => Promise<CommandReceipt>;
  readonly submit: (
    principal: unknown,
    payload: Record<string, unknown>,
    operation: string,
    extra?: Record<string, unknown>,
  ) => Promise<CommandReceipt>;
  readonly close: () => void;
}

async function openVerticalHarness(options: { readonly taskStrategyGuardsActive?: boolean } = {}): Promise<VerticalHarness> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p033-f009-' });
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const nowUtcMs = (): number => {
    now += 1;
    return now;
  };
  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs });
  const atomicStore = createSqliteAtomicCommandStore(harness.session, { nowUtcMs });
  const previewPort = createExecutionPreviewService({
    views: createSqlitePlanAccess(harness.session, { nowUtcMs }),
    inspector: createRepositoryInspector(),
    workspace: createBaselineWorkspaceReader(),
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  const startPort = createExecutionStartService({
    preview: previewPort,
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  const service = createCommandService({
    atomicStore,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    executionPreview: previewPort,
    executionStart: startPort,
    ...(options.taskStrategyGuardsActive === true
      ? {
          taskStrategyEditGuards: {
            activeTaskExecutionInputs: () => ({ active: true, evidence: { kind: 'running' } }),
          },
        }
      : {}),
    nowUtcMs,
  });
  const owner = box.localOwner();
  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (
    principal: unknown,
    payload: Record<string, unknown>,
    operation: string,
    extra: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    service.submit(principal, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    owner,
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) throw new Error('夹具注册失败');
  const projectId = (registered.result as { project: { id: string } }).project.id;
  const projectScope = { kind: 'project', projectId } as const;

  const globalSettings = await submit(owner, GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') throw new Error('夹具全局配置失败');
  const projectSettings = await submit(owner, PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: projectScope,
  });
  if (projectSettings.status !== 'completed') throw new Error('夹具项目配置失败');
  const phase = await submit(
    owner,
    { id: 'phase-1', title: '第一阶段', description: null, labels: [] },
    'phase.create',
    { scope: projectScope },
  );
  if (phase.status !== 'completed') throw new Error('夹具 Phase 创建失败');

  const sha256hex = async (value: string): Promise<string> =>
    import('node:crypto').then(({ createHash }) => createHash('sha256').update(value).digest('hex'));
  const seedReady = async (content: string, locatorName: string): Promise<string> => {
    const contentHash = await sha256hex(content);
    const record = await artifactStore.registerArtifact({
      projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: contentHash,
      locator: `artifacts/${locatorName}.md`,
    });
    await artifactStore.transitionArtifact(projectId, record.id, {
      expectedRevision: record.revision,
      outcome: { status: 'ready', actualHash: contentHash, sizeBytes: Buffer.byteLength(content, 'utf8') },
    });
    return record.id;
  };
  const artifactIds = {
    src: await seedReady('# 来源\n', 'art-src'),
    req: await seedReady('# 需求规格\n', 'art-req'),
  };
  const imported = await submit(
    owner,
    { phaseId: 'phase-1', plan: samplePlan(artifactIds) },
    'feature.plan.import',
    { scope: projectScope, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) throw new Error('夹具计划导入失败');
  const feature = (imported.result as { feature: { id: string; planDigest: string } }).feature;

  const featureRow = harness.session.database
    .prepare('SELECT plan_digest, revision FROM features WHERE id = ?')
    .get(feature.id) as { plan_digest: string; revision: number };
  const decision = await submit(
    owner,
    { featureId: feature.id, planDigest: featureRow.plan_digest, decision: 'approve', reason: '预算修订验收' },
    'feature.plan.decide',
    { scope: projectScope, expectedRevision: featureRow.revision },
  );
  if (decision.status !== 'completed') throw new Error('夹具批准失败');

  const previewReceipt = await service.submit(owner, {
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'execution.preview',
    scope: projectScope,
    payload: { featureIds: [feature.id], budget: VALID_BUDGET },
  });
  if (previewReceipt.status !== 'completed') throw new Error('夹具预览失败');
  const previewDigest = (previewReceipt.result as { previewDigest: string | null }).previewDigest;
  if (previewDigest === null) throw new Error('夹具预览未返回 ready 摘要');
  const started = await service.submit(owner, {
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'execution.start',
    scope: projectScope,
    payload: { featureIds: [feature.id], budget: VALID_BUDGET, previewDigest },
  });
  if (started.status !== 'accepted') throw new Error('夹具执行启动失败');
  const batchId = (started as { batchId: string }).batchId;
  const runId = (started as { runId: string }).runId;

  const revise = (changes: Record<string, unknown> = {}): Promise<CommandReceipt> => {
    const budget = {
      batch: { ...VALID_BUDGET.batch, maxRuns: 4, maxTotalAttempts: 12, deadlineUtcMs: NOW + 2 * HOUR_MS },
      run: { ...VALID_BUDGET.run },
    };
    return service.submit(owner, {
      ...envelopeBase,
      commandId: randomUUID(),
      operation: 'execution.budget.revise',
      scope: projectScope,
      expectedRevision: 1,
      payload: { batchId, budget, reason: '扩大执行预算并延期' },
      ...changes,
    });
  };

  return {
    box,
    session: harness.session,
    service,
    owner,
    projectId,
    featureId: feature.id,
    batchId,
    runId,
    db: harness.session.database,
    revise,
    submit,
    close(): void {
      box.cleanup();
    },
  };
}

let openVertical: VerticalHarness | undefined;
afterEach(() => {
  openVertical?.close();
  openVertical = undefined;
});

async function withVertical(
  options: { readonly taskStrategyGuardsActive?: boolean } = {},
): Promise<VerticalHarness> {
  openVertical = await openVerticalHarness(options);
  return openVertical;
}

/* ------------------------------------------------------------------ *
 * 存储原语夹具：直接种子图（事务原语 + 竞争测试）
 * ------------------------------------------------------------------ */

interface SeedGraph {
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly runId: string;
}

interface SeedOptions {
  readonly batchStatus?: string;
  readonly budget?: Record<string, unknown>;
  readonly counters?: Partial<Record<'runs_created' | 'attempts_created' | 'runtime_starts' | 'no_progress_runs', number>>;
}

const SEED_BUDGET = {
  schemaVersion: 1,
  batch: {
    maxRuns: 4,
    maxTotalAttempts: 8,
    maxRuntimeStarts: 4,
    maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + HOUR_MS,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: HOUR_MS },
};

function seedGraph(db: SqliteStorageSession['database'], options: SeedOptions = {}): SeedGraph {
  const projectId = 'proj-1';
  const phaseId = 'phase-1';
  const featureId = 'feature-1';
  const taskId = 'task-1';
  const batchId = randomUUID();
  const runId = randomUUID();
  const budget = options.budget ?? SEED_BUDGET;
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, ?, 1, ?, '示例项目', 'active', '[]')",
  ).run(projectId, NOW, NOW);
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, ?, 1, ?, '其他项目', 'active', '[]')",
  ).run('proj-2', NOW, NOW);
  db.prepare(
    "INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES (?, ?, ?, 1, ?, '阶段一', 'open', '[]')",
  ).run(phaseId, NOW, projectId, NOW);
  db.prepare(
    'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES (?, ?, ?, 1, ?, ?, ' +
      "'特性一', 'running', 'approved', '[]', '[]')",
  ).run(featureId, NOW, projectId, NOW, phaseId);
  db.prepare(
    'INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status, acceptance, requirements_refs, execution_config, config_source, attempt_counter, code_attempts_used) ' +
      "VALUES (?, ?, ?, 1, ?, ?, '任务一', 'pending', '{\"criteria\":[\"验收\"]}', '[]', ?, 'project_default', 0, 0)",
  ).run(
    taskId,
    NOW,
    projectId,
    NOW,
    featureId,
    JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
  );
  db.prepare(
    'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
      'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
      'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
  ).run(
    batchId,
    NOW,
    projectId,
    NOW,
    phaseId,
    featureId,
    JSON.stringify({ featureIds: [featureId] }),
    JSON.stringify({}),
    options.batchStatus ?? 'running',
    JSON.stringify(budget),
    options.counters?.runs_created ?? 1,
    options.counters?.attempts_created ?? 0,
    options.counters?.runtime_starts ?? 0,
    options.counters?.no_progress_runs ?? 0,
    (budget as { batch: { deadlineUtcMs: number } }).batch.deadlineUtcMs,
  );
  db.prepare(
    'INSERT INTO batch_budget_revisions (id, created_at, project_id, revision, updated_at, batch_id, version, budget_snapshot, deadline_at, approved_by, reason) ' +
      "VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, 'local-owner', 'initial_authorization')",
  ).run(randomUUID(), NOW, projectId, NOW, batchId, JSON.stringify(budget), (budget as { batch: { deadlineUtcMs: number } }).batch.deadlineUtcMs);
  db.prepare(
    'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) ' +
      "VALUES (?, ?, ?, 1, ?, ?, ?, 'execute', '{}', '{}', 'running', ?, ?, 1, 3, ?, 0)",
  ).run(runId, NOW, projectId, NOW, batchId, featureId, 'a'.repeat(64), `${featureId}:execute`, HOUR_MS);
  return { projectId, phaseId, featureId, taskId, batchId, runId };
}

interface PrimitiveHarness {
  readonly session: SqliteStorageSession;
  readonly db: SqliteStorageSession['database'];
  readonly access: ReturnType<typeof createSqliteExecutionAccess>;
  readonly seed: SeedGraph;
  readonly revise: (input?: Record<string, unknown>) => BatchBudgetRevisionResult;
  readonly close: () => void;
}

const INCREASED_BUDGET = {
  schemaVersion: 1,
  batch: {
    maxRuns: 6,
    maxTotalAttempts: 12,
    maxRuntimeStarts: 6,
    maxNoProgressRuns: 3,
    deadlineUtcMs: NOW + 2 * HOUR_MS,
  },
  run: { maxAttemptsPerRun: 4, runTimeLimitMs: 2 * HOUR_MS },
};

let openSandbox: { readonly path: string } | undefined;
afterEach(() => {
  openSandbox = undefined;
});

function openPrimitiveHarness(options: SeedOptions = {}): PrimitiveHarness {
  const sandbox = createTempSandbox('shiploop-p033-f009-primitive-');
  openSandbox = sandbox;
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  migrateSqliteStorage(session);
  const seed = seedGraph(session.database, options);
  const access = createSqliteExecutionAccess(session, { nowUtcMs: () => NOW + 1000 });
  const revise = (input: Record<string, unknown> = {}): BatchBudgetRevisionResult =>
    session.transactWrite('test.reviseBudget', () =>
      access.reviseBatchBudgetInTransaction({
        projectId: seed.projectId,
        batchId: seed.batchId,
        expectedBudgetRevision: 1,
        budgetSnapshot: INCREASED_BUDGET,
        approvedBy: 'local-owner',
        reason: '显式增额与延期',
        ...input,
      }),
    );
  return {
    session,
    db: session.database,
    access,
    seed,
    revise,
    close(): void {
      session.close();
    },
  };
}

function batchRowOf(db: SqliteStorageSession['database'], batchId: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM execution_batches WHERE id = ?').get(batchId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error('batch row missing');
  return row;
}

function revisionRowsOf(db: SqliteStorageSession['database'], batchId: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM batch_budget_revisions WHERE batch_id = ? ORDER BY version')
    .all(batchId) as Record<string, unknown>[];
}

/* ================================================================== *
 * 验收 1+3：授权、归属、输入面与拒绝矩阵（命令通道）
 * ================================================================== */

describe('F-009 预算修订：授权与输入面（命令通道）', () => {
  it('缺少 execution.budget.revise 能力的可信主体被拒绝且零写入（模型理由不授予权限）', async () => {
    const h = await withVertical();
    const noBudgetCapability = createRestrictedPrincipal({
      capabilities: ['project.read', 'execution.start'],
      projectScope: scopeAllowlist([h.projectId]),
    });
    const error = await h
      .submit(
        noBudgetCapability,
        { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '模型认为需要更多尝试' },
        'execution.budget.revise',
        { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: 1 },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectPublicError(error, 'forbidden');
    expect(batchRowOf(h.db, h.batchId).budget_revision).toBe(1);
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(1);
  });

  it('跨项目 scope 或 payload 未知字段（自声明批准/Task 上限字段）在 SQL 之前拒绝', async () => {
    const h = await withVertical();
    const receiptsBefore = (
      h.db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }
    ).n;
    const otherPrincipal = createRestrictedPrincipal({
      capabilities: ['execution.budget.revise'],
      projectScope: scopeAllowlist(['00000000-0000-4000-8000-000000000002']),
    });
    const crossProject = await h
      .submit(
        otherPrincipal,
        { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '跨项目增额' },
        'execution.budget.revise',
        { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: 1 },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectPublicError(crossProject, 'forbidden');

    for (const payload of [
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '理由', approvedBy: 'local-owner' },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '理由', principalId: 'local-owner' },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '理由', maxCodeAttempts: 9 },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '理由', taskMaxCodeAttempts: 9 },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '理由', tokenUsed: 1 },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '' },
      { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '   ' },
      { batchId: h.batchId, budget: { ...VALID_BUDGET } },
      { batchId: h.batchId, reason: '缺预算' },
      { budget: { ...VALID_BUDGET }, reason: '缺批次' },
    ]) {
      const error = await h
        .submit(
          h.owner,
          payload as Record<string, unknown>,
          'execution.budget.revise',
          { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: 1 },
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expectPublicError(error, 'invalid_input');
    }
    // 信封缺失 expectedRevision（更新类命令）同样拒绝。
    const missingRevision = await h.service
      .submit(h.owner, {
        schemaVersion: 5,
        commandId: randomUUID(),
        operation: 'execution.budget.revise',
        scope: { kind: 'project', projectId: h.projectId },
        issuedAt: NOW_ISO,
        payload: { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '缺 CAS' },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectPublicError(missingRevision, 'invalid_input');
    expect(batchRowOf(h.db, h.batchId).budget_revision).toBe(1);
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(1);
    // 全部非法输入零回执（拒绝发生在回执持久化之前）。
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM command_receipts').get() as { n: number }).n,
    ).toBe(receiptsBefore);
  });

  it('非法预算（缺字段/deadline 已过/未知 schemaVersion）拒绝且零 SQL 写入', async () => {
    const h = await withVertical();
    for (const budget of [
      { batch: { maxRuns: 3 }, run: VALID_BUDGET.run },
      { ...VALID_BUDGET, batch: { ...VALID_BUDGET.batch, deadlineUtcMs: NOW - 1 } },
      { ...VALID_BUDGET, schemaVersion: 2 },
    ]) {
      const error = await h
        .submit(
          h.owner,
          { batchId: h.batchId, budget, reason: '非法预算' },
          'execution.budget.revise',
          { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: 1 },
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expectPublicError(error, 'invalid_input');
    }
    expect(batchRowOf(h.db, h.batchId).budget_revision).toBe(1);
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(1);
  });
});

/* ================================================================== *
 * 验收 2+3：短事务原子修订、事件与回执、运行中增额不启动恢复
 * ================================================================== */

describe('F-009 预算修订：短事务原子性与脱敏事件/回执', () => {
  it('有效修订一次提交：当前预算/修订身份/不可变历史行/事件/回执同事务，计数与既有快照不清零', async () => {
    const h = await withVertical();
    const before = batchRowOf(h.db, h.batchId);
    const runsBefore = h.db.prepare('SELECT * FROM runs').all() as Record<string, unknown>[];
    const tasksBefore = h.db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    const receipt = await h.revise();
    expect(receipt.status).toBe('completed');
    if (receipt.status !== 'completed') throw new Error('unreachable');

    const after = batchRowOf(h.db, h.batchId);
    expect(after.budget_revision).toBe(2);
    expect(after.deadline_at).toBe(NOW + 2 * HOUR_MS);
    expect(JSON.parse(after.budget_snapshot as string)).toMatchObject({ batch: { maxRuns: 4, maxTotalAttempts: 12 } });
    // 累计计数不清零；身份/范围/配置快照不变。
    expect(after.runs_created).toBe(before.runs_created);
    expect(after.attempts_created).toBe(before.attempts_created);
    expect(after.runtime_starts).toBe(before.runtime_starts);
    expect(after.no_progress_runs).toBe(before.no_progress_runs);
    expect(after.scope_snapshot).toBe(before.scope_snapshot);
    expect(after.config_snapshot).toBe(before.config_snapshot);
    // Run/Task 快照逐字节不变。
    expect(h.db.prepare('SELECT * FROM runs').all()).toEqual(runsBefore);
    expect(h.db.prepare('SELECT * FROM tasks').all()).toEqual(tasksBefore);

    // 不可变修订历史：v1 初始授权保留 + v2 新行（主体/理由/时间/预算）。
    const rows = revisionRowsOf(h.db, h.batchId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, approved_by: 'local-owner', reason: 'initial_authorization' });
    expect(rows[1]).toMatchObject({ version: 2, approved_by: 'local-owner', reason: '扩大执行预算并延期' });
    expect(JSON.parse(rows[1].budget_snapshot as string)).toMatchObject({ batch: { maxRuns: 4 } });
    expect(rows[1].created_at as number).toBeGreaterThan(0);

    // 脱敏事件：白名单类型、聚合为 Batch、payload 恒 {revised:true}。
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(EXECUTION_BUDGET_REVISED_EVENT_TYPE);
    const eventRows = h.db
      .prepare('SELECT * FROM state_events WHERE event_type = ?')
      .all(EXECUTION_BUDGET_REVISED_EVENT_TYPE) as Record<string, unknown>[];
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      project_id: h.projectId,
      aggregate_type: 'execution_batch',
      aggregate_id: h.batchId,
    });
    expect(JSON.parse(eventRows[0].payload as string)).toEqual({ revised: true });
    const mapped = mapStateEvents([
      {
        id: eventRows[0].id,
        sequence: eventRows[0].sequence,
        eventType: eventRows[0].event_type,
        aggregateType: eventRows[0].aggregate_type,
        aggregateId: eventRows[0].aggregate_id,
        aggregateRevision: eventRows[0].aggregate_revision,
        projectId: eventRows[0].project_id,
        payload: JSON.parse(eventRows[0].payload as string),
        occurredAtUtcMs: eventRows[0].occurred_at,
      },
    ]);
    expect(mapped[0].payload).toEqual({ revised: true });
    expect(mapped[0].type).toBe(EXECUTION_BUDGET_REVISED_EVENT_TYPE);

    // 回执结果可核对修订前后值与批准主体。
    expect(receipt.result).toMatchObject({
      batchId: h.batchId,
      approvedBy: 'local-owner',
      reason: '扩大执行预算并延期',
      previous: { version: 1 },
      revised: { version: 2 },
    });
    const result = receipt.result as {
      previous: { budget: { batch: { maxRuns: number } } };
      revised: { budget: { batch: { maxRuns: number } } };
    };
    expect(result.previous.budget.batch.maxRuns).toBe(2);
    expect(result.revised.budget.batch.maxRuns).toBe(4);
  });

  it('运行中增额：Run 状态/派发身份不变、无新 Run、无新派发事件、runtime_starts 不增（仅增额不自动启动或恢复）', async () => {
    const h = await withVertical();
    const runBefore = h.db.prepare('SELECT * FROM runs WHERE id = ?').get(h.runId) as Record<string, unknown>;
    const eventsBefore = (
      h.db.prepare('SELECT COUNT(*) AS n FROM state_events').get() as { n: number }
    ).n;
    const receipt = await h.revise();
    expect(receipt.status).toBe('completed');
    const runAfter = h.db.prepare('SELECT * FROM runs WHERE id = ?').get(h.runId) as Record<string, unknown>;
    expect(runAfter).toEqual(runBefore);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(1);
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched'").get() as { n: number }).n,
    ).toBe(1);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM state_events').get() as { n: number }).n).toBe(eventsBefore + 1);
    expect(batchRowOf(h.db, h.batchId).runtime_starts).toBe(0);
    // 延期后纯预算判定恢复允许（deadline 维度不再耗尽；不据此自动派发）。
    const batch = batchRowOf(h.db, h.batchId);
    const decision = evaluateBatchBudgetReservation(
      JSON.parse(batch.budget_snapshot as string).batch,
      {
        runsCreated: batch.runs_created as number,
        attemptsCreated: batch.attempts_created as number,
        runtimeStarts: batch.runtime_starts as number,
        noProgressRuns: batch.no_progress_runs as number,
      },
      NOW + 90 * 60 * 1000,
    );
    expect(decision.allowed).toBe(true);
  });

  it('组合事务失败整组回滚：修订行插入失败时批次预算不部分更新', async () => {
    const h = await withVertical();
    const before = batchRowOf(h.db, h.batchId);
    // 预插一条 v2 修订行占位（绕过命令面，模拟同事务后续写入失败）。
    h.db
      .prepare(
        'INSERT INTO batch_budget_revisions (id, created_at, project_id, revision, updated_at, batch_id, version, budget_snapshot, deadline_at, approved_by, reason) ' +
          "VALUES (?, ?, ?, 1, ?, ?, 2, ?, ?, 'local-owner', '占位冲突')",
      )
      .run(randomUUID(), NOW, h.projectId, NOW, h.batchId, JSON.stringify(SEED_BUDGET), NOW + HOUR_MS);
    const error = await h.revise().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeDefined();
    const after = batchRowOf(h.db, h.batchId);
    expect(after.budget_revision).toBe(before.budget_revision);
    expect(after.budget_snapshot).toBe(before.budget_snapshot);
    expect(after.deadline_at).toBe(before.deadline_at);
  });
});

/* ================================================================== *
 * 验收 3：过期 revision、终态批次与单调拒绝
 * ================================================================== */

describe('F-009 预算修订：CAS 与单调拒绝（命令通道固化 rejected）', () => {
  it('过期 expectedRevision 固化 rejected（budget_revision_stale），零业务写入', async () => {
    const h = await withVertical();
    const first = await h.revise();
    expect(first.status).toBe('completed');
    const stale = await h.revise();
    expect(stale.status).toBe('rejected');
    if (stale.status !== 'rejected') throw new Error('unreachable');
    expect(stale.error.code).toBe('conflict');
    expect(stale.error.details).toMatchObject({ reason: 'budget_revision_stale', entityType: 'execution_batch' });
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(2);
    expect(batchRowOf(h.db, h.batchId).budget_revision).toBe(2);
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?').get(EXECUTION_BUDGET_REVISED_EVENT_TYPE) as { n: number }).n,
    ).toBe(1);
  });

  it('额度降低/移除资源上限/缩短 deadline 固化 rejected（revision_not_increased），无部分更新', async () => {
    const h = await withVertical();
    const before = batchRowOf(h.db, h.batchId);
    for (const budget of [
      { ...VALID_BUDGET, batch: { ...VALID_BUDGET.batch, maxRuns: 1, maxNoProgressRuns: 1 } },
      { ...VALID_BUDGET, batch: { ...VALID_BUDGET.batch, deadlineUtcMs: NOW + 1_800_000 } },
      { ...VALID_BUDGET, batch: { ...VALID_BUDGET.batch, maxTokenTotal: 1_000 } },
      { ...VALID_BUDGET, run: { ...VALID_BUDGET.run, maxAttemptsPerRun: 2 } },
    ]) {
      const receipt = await h.revise({ payload: { batchId: h.batchId, budget, reason: '尝试降额' } });
      expect(receipt.status).toBe('rejected');
      if (receipt.status !== 'rejected') throw new Error('unreachable');
      expect(receipt.error.details).toMatchObject({ reason: 'revision_not_increased' });
    }
    expect(batchRowOf(h.db, h.batchId)).toEqual(before);
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(1);
  });

  it('终态 Batch 拒绝修订（batch_not_active）：授权关闭后新工作需新授权', async () => {
    const h = await withVertical();
    h.db.prepare('UPDATE execution_batches SET status = ? WHERE id = ?').run('failed', h.batchId);
    const receipt = await h.revise();
    expect(receipt.status).toBe('rejected');
    if (receipt.status !== 'rejected') throw new Error('unreachable');
    expect(receipt.error.details).toMatchObject({ reason: 'batch_not_active' });
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(1);
    // paused/interrupted 属活动集：可增额（暂停不是终态）。
    h.db.prepare('UPDATE execution_batches SET status = ? WHERE id = ?').run('paused', h.batchId);
    const paused = await h.revise();
    expect(paused.status).toBe('completed');
  });
});

/* ================================================================== *
 * 验收 4：幂等重放、commandId 冲突与真实 SQLite CAS 竞争、审计
 * ================================================================== */

describe('F-009 预算修订：幂等、竞争与审计', () => {
  it('相同命令完整重放返回原回执，不产生第二条修订或事件；不同参数复用 commandId 冲突', async () => {
    const h = await withVertical();
    const budget = {
      batch: { ...VALID_BUDGET.batch, maxRuns: 4, maxTotalAttempts: 12, deadlineUtcMs: NOW + 2 * HOUR_MS },
      run: { ...VALID_BUDGET.run },
    };
    const envelope = {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'execution.budget.revise',
      scope: { kind: 'project', projectId: h.projectId },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { batchId: h.batchId, budget, reason: '扩大执行预算并延期' },
    };
    const first = await h.service.submit(h.owner, envelope);
    expect(first.status).toBe('completed');
    const replayed = await h.service.submit(h.owner, envelope);
    expect(replayed.status).toBe('completed');
    expect((replayed as { replayed?: boolean }).replayed).toBe(true);
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(2);
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?').get(EXECUTION_BUDGET_REVISED_EVENT_TYPE) as { n: number }).n,
    ).toBe(1);

    const conflict = await h.service
      .submit(h.owner, {
        ...envelope,
        payload: { batchId: h.batchId, budget, reason: '不同理由视为不同请求' },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectPublicError(conflict, 'conflict');
    expect(revisionRowsOf(h.db, h.batchId)).toHaveLength(2);
  });

  it('真实 SQLite CAS 竞争仅一个成功：并发写锁拒绝 + 提交后旧 revision 拒绝', () => {
    const harness = openPrimitiveHarness();
    try {
      const path = join(openSandbox!.path, 'state.db');
      const sessionB = openSqliteStorageSession({ path, busyTimeoutMs: 10, busyRetryAttempts: 2 });
      const accessB = createSqliteExecutionAccess(sessionB, { nowUtcMs: () => NOW + 2000 });
      const input = {
        projectId: harness.seed.projectId,
        batchId: harness.seed.batchId,
        expectedBudgetRevision: 1,
        budgetSnapshot: INCREASED_BUDGET,
        approvedBy: 'local-owner',
        reason: '竞争修订 A',
      };
      const inputB = { ...input, reason: '竞争修订 B' };
      // A 持有写事务（未提交）；B 以独立连接尝试同一 CAS → busy（零写入）。
      harness.session.transactWrite('test.raceA', () => {
        harness.access.reviseBatchBudgetInTransaction(input);
        const busy = captureError(() =>
          sessionB.transactWrite('test.raceB', () => accessB.reviseBatchBudgetInTransaction(inputB)),
        );
        expect(isStorageError(busy, 'busy')).toBe(true);
      });
      expect(batchRowOf(harness.db, harness.seed.batchId).budget_revision).toBe(2);
      expect(revisionRowsOf(harness.db, harness.seed.batchId)).toHaveLength(2);
      // B 提交后重试同 expectedBudgetRevision=1 → 旧 revision 拒绝。
      const stale = captureError(() =>
        sessionB.transactWrite('test.raceB2', () => accessB.reviseBatchBudgetInTransaction(inputB)),
      );
      expectStorageConflict(stale, 'budget_revision_stale');
      sessionB.close();
      // 审计可核对批准主体、时间、理由及修订前后值。
      const rows = revisionRowsOf(harness.db, harness.seed.batchId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ version: 2, approved_by: 'local-owner', reason: '竞争修订 A' });
      expect(JSON.parse(rows[0].budget_snapshot as string).batch.maxRuns).toBe(4);
      expect(JSON.parse(rows[1].budget_snapshot as string).batch.maxRuns).toBe(6);
    } finally {
      harness.close();
    }
  });
});

/* ================================================================== *
 * 存储原语：归属、单调、用量下限与防御（事务原语直测）
 * ================================================================== */

describe('F-009 存储原语：归属与防御矩阵', () => {
  it('跨项目 ownership、缺失 not_found、未知键零 SQL', () => {
    const harness = openPrimitiveHarness();
    try {
      try {
        harness.revise({ projectId: 'proj-2' });
        throw new Error('期望 ownership 拒绝');
      } catch (error) {
        expect(isStorageError(error, 'ownership')).toBe(true);
      }
      try {
        harness.revise({ batchId: randomUUID() });
        throw new Error('期望 not_found 拒绝');
      } catch (error) {
        expect(isStorageError(error, 'not_found')).toBe(true);
      }
      try {
        harness.revise({ tokenUsed: 5 });
        throw new Error('期望 validation 拒绝');
      } catch (error) {
        expect(isStorageError(error, 'validation')).toBe(true);
      }
      expect(revisionRowsOf(harness.db, harness.seed.batchId)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('降低到已使用值以下单独拒绝（limit_below_used 防御：计数超上限的持久状态）', () => {
    // 刻意构造 runs_created 超过当前上限的持久状态（防御纵深：即使不一致也不放行）。
    // 提案与当前预算相同（maxRuns=4）：不是降额，但低于已用 5 次 → 单独拒绝。
    const harness = openPrimitiveHarness({
      budget: { ...SEED_BUDGET, batch: { ...SEED_BUDGET.batch, maxRuns: 4 } },
      counters: { runs_created: 5 },
    });
    try {
      const same = captureError(() => harness.revise({ budgetSnapshot: SEED_BUDGET }));
      expectStorageConflict(same, 'limit_below_used');
      expect(revisionRowsOf(harness.db, harness.seed.batchId)).toHaveLength(1);
      expect(batchRowOf(harness.db, harness.seed.batchId).budget_revision).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('修订历史行不可变：UPDATE/DELETE 一律触发器拒绝', () => {
    const harness = openPrimitiveHarness();
    try {
      const row = revisionRowsOf(harness.db, harness.seed.batchId)[0];
      expect(() =>
        harness.db.prepare('UPDATE batch_budget_revisions SET reason = ? WHERE id = ?').run('改写', row.id),
      ).toThrow();
      expect(() => harness.db.prepare('DELETE FROM batch_budget_revisions WHERE id = ?').run(row.id)).toThrow();
    } finally {
      harness.close();
    }
  });
});

/* ================================================================== *
 * 验收 5：Task 代码尝试上限只经 Task 策略 CAS 通道显式调整
 * ================================================================== */

describe('F-009 Task 代码尝试上限：唯一显式通道与不可静默增额', () => {
  it('task.strategy.update 显式提高 maxCodeAttempts：副本更新、事件与回执审计、Task 计数不清零', async () => {
    const h = await withVertical();
    const taskRow = () =>
      h.db.prepare('SELECT * FROM tasks WHERE id = ?').get('t-1') as Record<string, unknown>;
    const before = taskRow();
    const revision = before.revision as number;
    const receipt = await h.submit(
      h.owner,
      {
        taskId: 't-1',
        executionConfig: {
          schemaVersion: 2,
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          maxCodeAttempts: 5,
        },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: revision },
    );
    expect(receipt.status).toBe('completed');
    const after = taskRow();
    expect(JSON.parse(after.execution_config as string)).toMatchObject({ maxCodeAttempts: 5 });
    expect(after.config_source).toBe('task_edit');
    expect(after.attempt_counter).toBe(before.attempt_counter);
    expect(after.code_attempts_used).toBe(before.code_attempts_used);
    expect(
      (h.db.prepare("SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'task.strategy.updated'").get() as { n: number }).n,
    ).toBe(1);
  });

  it('更新默认配置不追溯：settings.global.update 提高 executionLimits.maxCodeAttempts 后 Task 副本逐字节不变', async () => {
    const h = await withVertical();
    const before = h.db.prepare('SELECT execution_config FROM tasks WHERE id = ?').get('t-1') as {
      execution_config: string;
    };
    const globalRow = h.db.prepare('SELECT revision, payload FROM global_settings').get() as {
      revision: number;
      payload: string;
    };
    const updatedPayload = {
      ...JSON.parse(globalRow.payload),
      policies: { executionLimits: { maxCodeAttempts: 9 } },
    };
    const receipt = await h.submit(
      h.owner,
      updatedPayload,
      'settings.global.update',
      { scope: { kind: 'global' }, expectedRevision: globalRow.revision },
    );
    expect(receipt.status).toBe('completed');
    const after = h.db.prepare('SELECT execution_config FROM tasks WHERE id = ?').get('t-1') as {
      execution_config: string;
    };
    expect(after.execution_config).toBe(before.execution_config);
    // 预占仍以 Task 副本为权威（默认值变化不扩大既有 Task 额度）。
    const atomic = createSqliteAtomicCommandStore(h.session, { nowUtcMs: () => NOW + 5000 });
    const reservation = atomic.transact('test.reserveAfterConfigChange', (tx) =>
      tx.reserveTaskAttempt({
        projectId: h.projectId,
        batchId: h.batchId,
        runId: h.runId,
        taskId: 't-1',
        attemptKey: 'after-config-change',
        maxAttemptsPerTask: null,
      }),
    );
    expect(reservation.classification).toBe('code');
  });

  it('换 Run 不清 Task 代码额度：跨 Run 预占累计递增', async () => {
    const h = await withVertical();
    const atomic = createSqliteAtomicCommandStore(h.session, { nowUtcMs: () => NOW + 6000 });
    const counters = () =>
      h.db.prepare('SELECT attempt_counter, code_attempts_used FROM tasks WHERE id = ?').get('t-1') as {
        attempt_counter: number;
        code_attempts_used: number;
      };
    atomic.transact('test.reserve1', (tx) =>
      tx.reserveTaskAttempt({
        projectId: h.projectId,
        batchId: h.batchId,
        runId: h.runId,
        taskId: 't-1',
        attemptKey: 'run1-a1',
        maxAttemptsPerTask: null,
      }),
    );
    expect(counters()).toEqual({ attempt_counter: 1, code_attempts_used: 1 });
    // 旧 Run 终态后同父 Batch 新 Run：Task 双计数继续累计。
    h.db
      .prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
      .run('failed', NOW + 10, h.runId);
    const secondRun = randomUUID();
    h.db
      .prepare(
        'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) ' +
          "VALUES (?, ?, ?, 1, ?, ?, ?, 'execute', '{}', '{}', 'running', ?, ?, 2, 3, ?, 0)",
      )
      .run(secondRun, NOW, h.projectId, NOW, h.batchId, h.featureId, 'b'.repeat(64), `${h.featureId}:execute`, HOUR_MS);
    atomic.transact('test.reserve2', (tx) =>
      tx.reserveTaskAttempt({
        projectId: h.projectId,
        batchId: h.batchId,
        runId: secondRun,
        taskId: 't-1',
        attemptKey: 'run2-a1',
        maxAttemptsPerTask: null,
      }),
    );
    expect(counters()).toEqual({ attempt_counter: 2, code_attempts_used: 2 });
  });

  it('活动执行输入保护：策略热改在活动 Attempt 依据下拒绝（active_execution_inputs）', async () => {
    const h = await withVertical({ taskStrategyGuardsActive: true });
    const revisionRow = h.db.prepare('SELECT revision FROM tasks WHERE id = ?').get('t-1') as {
      revision: number;
    };
    const receipt = await h.submit(
      h.owner,
      {
        taskId: 't-1',
        executionConfig: {
          schemaVersion: 2,
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          maxCodeAttempts: 9,
        },
      },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: revisionRow.revision },
    );
    expect(receipt.status).toBe('rejected');
    if (receipt.status !== 'rejected') throw new Error('unreachable');
    expect(receipt.error.details).toMatchObject({ reason: 'active_execution_inputs' });
    expect(h.db.prepare('SELECT execution_config FROM tasks WHERE id = ?').get('t-1')).toMatchObject({
      execution_config: expect.not.stringContaining('maxCodeAttempts":9'),
    });
  });

  it('预算修订命令不提供 Task 上限调整入口（payload 面冻结）', async () => {
    const h = await withVertical();
    const error = await h
      .submit(
        h.owner,
        { batchId: h.batchId, budget: { ...VALID_BUDGET }, reason: '混入 Task 上限', taskMaxCodeAttempts: 9 },
        'execution.budget.revise',
        { scope: { kind: 'project', projectId: h.projectId }, expectedRevision: 1 },
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expectPublicError(error, 'invalid_input');
    expect((h.db.prepare('SELECT execution_config FROM tasks WHERE id = ?').get('t-1') as { execution_config: string }).execution_config).not.toContain('"maxCodeAttempts":9');
  });
});
