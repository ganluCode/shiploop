/**
 * P03-3 / F-004：单 Feature 执行 prepare 预览（真实临时 Git/SQLite/制品资源）。
 *
 * 验收面（.dag_context.json F-004）：
 * 1. 已批准且有待执行工作的 Feature 返回固定单成员范围、计划/代码/Task 策略/
 *    检查/权限/预算摘要及 previewDigest；不自动加入其他 Feature、依赖节点或
 *    Phase 后续新增成员。
 * 2. 空范围或无待执行工作的范围返回 no_work，不创建 Batch/Run、不扣预算、
 *    不调用 Runtime；未批准、项目非 active、Phase 不可执行、存在活动 Run 或
 *    已有基线在途/隔离占用时返回可理解阻塞原因。
 * 3. 跨项目 Feature、非法预算、未支持的有效并发大于一及不安全仓库绑定拒绝；
 *    授权先于仓库或制品 I/O；realpath、仓库身份和必需不可变输入引用复用既有
 *    受控端口。
 * 4. 需求、代码、Task 策略、检查政策、权限或预算实质变化会改变预览身份；纯
 *    标签等无关元数据变化不错误扩大范围或使批准失效。
 * 5. 预览不执行仓库脚本、不安装依赖、不探测真实模型、不加载未选全局资源；
 *    不把预算授权预览宣称为已经具备 Runtime 执行能力。
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../../../../packages/core/src/application/execution-preview.ts';
import { mergeEffectiveSettings } from '../../../../packages/core/src/application/effective-settings.ts';
import { createBaselineWorkspaceReader } from '../../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAtomicCommandStore } from '../../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../../../../packages/core/src/adapters/sqlite/plan-store.ts';
import type { SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { isPublicError } from '../../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PublicError } from '../../../../packages/core/src/ports/commands.ts';
import {
  ACTIVE_EXECUTION_STATUSES,
  EXECUTION_PREVIEW_OPERATION,
  EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES,
  EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION,
  computeExecutionPreviewDigest,
} from '../../../../packages/core/src/ports/execution-preview.ts';
import type { ExecutionPreviewResult } from '../../../../packages/core/src/ports/execution-preview.ts';
import type { RepositoryInspector, RepositoryInspection } from '../../../../packages/core/src/ports/repository-inspector.ts';
import { commitAll } from '../../../helpers/git-repo.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../../helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
    maxNoProgressRuns: 1,
    deadlineUtcMs: NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 },
};

const EDITED_STRATEGY = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-sonnet-2',
  credentialRef: 'ref://keychain/pi-anthropic',
};

function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '执行预览验收',
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
      { id: 't-3', title: '任务三', acceptance: { criteria: ['任务三验收'] }, dependsOn: ['t-2'] },
    ],
  };
}

interface HarnessOptions {
  /** 可变权限读取器（权限身份变化测试注入；缺省生产空集边界宣告）。 */
  readonly permissions?: (input: { projectId: string; featureId: string; taskId: string }) => { grants: string[] };
  /** 不装配执行预览端口（unsupported 测试）。 */
  readonly withoutPreviewPort?: boolean;
}

interface PreparedHarness {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly service: CommandService;
  readonly inspector: CountingInspector;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly artifactIds: { readonly src: string; readonly req: string };
  readonly submit: (
    payload: Record<string, unknown>,
    operation: string,
    extra?: Record<string, unknown>,
  ) => Promise<CommandReceipt>;
  readonly preview: (changes?: Record<string, unknown>) => Record<string, unknown>;
  readonly previewSubmit: (changes?: Record<string, unknown>) => Promise<CommandReceipt>;
  readonly executionRows: () => { batches: number; runs: number };
  readonly eventCountDelta: () => number;
  readonly seedActiveRun: (status: string) => string;
  readonly seedActiveBatchForOtherFeature: (status: string) => Promise<string>;
  readonly seedBaselineOccupancy: () => string;
  readonly importSecondFeature: () => Promise<string>;
}

/** 授权先于仓库 I/O 的观测探针：统计 inspect 调用次数。 */
class CountingInspector implements RepositoryInspector {
  readonly calls: string[] = [];
  private readonly inner: RepositoryInspector;
  constructor(inner: RepositoryInspector) {
    this.inner = inner;
  }
  async inspect(repositoryPath: unknown): Promise<RepositoryInspection> {
    const result = await this.inner.inspect(repositoryPath);
    this.calls.push(result.canonicalPath);
    return result;
  }
}

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

async function setup(options: HarnessOptions = {}): Promise<PreparedHarness> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p033-f004-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const nowUtcMs = (): number => {
    now += 1;
    return now;
  };

  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs });
  const atomicStore = createSqliteAtomicCommandStore(harness.session, { nowUtcMs });
  const countingInspector = new CountingInspector(createRepositoryInspector());
  const previewPort = options.withoutPreviewPort
    ? undefined
    : createExecutionPreviewService({
        views: createSqlitePlanAccess(harness.session, { nowUtcMs }),
        inspector: countingInspector,
        workspace: createBaselineWorkspaceReader(),
        permissions:
          options.permissions === undefined
            ? () => ({ grants: [] })
            : options.permissions,
        nowMs: nowUtcMs,
      });

  const service: CommandService = createCommandService({
    atomicStore,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    ...(previewPort === undefined ? {} : { executionPreview: previewPort }),
    nowUtcMs,
  });
  const owner = box.localOwner();
  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (
    payload: Record<string, unknown>,
    operation: string,
    extra: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) throw new Error('夹具注册失败');
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const globalSettings = await submit(GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') throw new Error('夹具全局配置失败');
  const projectSettings = await submit(PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: { kind: 'project', projectId },
  });
  if (projectSettings.status !== 'completed') throw new Error('夹具项目配置失败');

  const phase = await submit(
    { id: 'phase-1', title: '第一阶段', description: null, labels: [] },
    'phase.create',
    { scope: { kind: 'project', projectId } },
  );
  if (phase.status !== 'completed') throw new Error('夹具 Phase 创建失败');

  const sha256hex = (value: string) =>
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
    { phaseId: 'phase-1', plan: samplePlan(artifactIds) },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) throw new Error('夹具计划导入失败');
  const feature = (imported.result as { feature: { id: string; planDigest: string } }).feature;

  const approve = await submit(
    { featureId: feature.id, planDigest: feature.planDigest, decision: 'approve', reason: '执行预览' },
    'feature.plan.decide',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (approve.status !== 'completed') throw new Error('夹具批准失败');

  const preview = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: EXECUTION_PREVIEW_OPERATION,
    scope: { kind: 'project', projectId },
    payload: { featureIds: [feature.id], budget: VALID_BUDGET },
    ...changes,
  });
  const previewSubmit = async (changes: Record<string, unknown> = {}): Promise<CommandReceipt> =>
    service.submit(owner, preview(changes));

  const db = () => harness.session.database;
  const executionRows = () => ({
    batches: (db().prepare('SELECT COUNT(*) AS n FROM execution_batches').get() as { n: number }).n,
    runs: (db().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
  });
  const eventsAtSetup = (db().prepare('SELECT COUNT(*) AS n FROM state_events').get() as { n: number }).n;
  const eventCountDelta = () =>
    (db().prepare('SELECT COUNT(*) AS n FROM state_events').get() as { n: number }).n - eventsAtSetup;

  const seedBatch = (featureId: string, status: string): string => {
    const batchId = randomUUID();
    db()
      .prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
          'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
          'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 0, ?)',
      )
      .run(
        batchId,
        NOW,
        projectId,
        NOW,
        'phase-1',
        featureId,
        JSON.stringify({ featureIds: [featureId] }),
        JSON.stringify({}),
        status,
        JSON.stringify({
          schemaVersion: 1,
          batch: VALID_BUDGET.batch,
          run: VALID_BUDGET.run,
        }),
        NOW + 3_600_000,
      );
    return batchId;
  };
  const seedActiveRun = (status: string): string => {
    // 父 Batch 置终态，聚焦「同 Feature 活动 Run 唯一」这一独立阻塞原因。
    const batchId = seedBatch(feature.id, 'succeeded');
    const runId = randomUUID();
    db()
      .prepare(
        'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
          'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
          'run_time_limit_ms, attempts_created) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3, 3_600_000, 0)',
      )
      .run(
        runId,
        NOW,
        projectId,
        NOW,
        batchId,
        feature.id,
        'execute',
        JSON.stringify({}),
        JSON.stringify({}),
        status,
        'a'.repeat(64),
        `${feature.id}:execute`,
      );
    return runId;
  };
  const seedActiveBatchForOtherFeature = async (status: string): Promise<string> => {
    const second = await importSecondFeature();
    return seedBatch(second, status);
  };
  const seedBaselineOccupancy = (): string => {
    const operationId = randomUUID();
    db()
      .prepare(
        'INSERT INTO baseline_operations (id, created_at, updated_at, revision, project_id, kind, authorization_id, status) ' +
          "VALUES (?, ?, ?, 1, ?, 'baseline', NULL, 'running')",
      )
      .run(operationId, NOW, NOW, projectId);
    db()
      .prepare(
        "INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at, process_identity) " +
          "VALUES ('global', ?, ?, ?, NULL)",
      )
      .run(operationId, NOW, NOW);
    return operationId;
  };
  const importSecondFeature = async (): Promise<string> => {
    const phaseRevision = (
      harness.session.database
        .prepare('SELECT revision FROM phases WHERE id = ?')
        .get('phase-1') as { revision: number }
    ).revision;
    const plan = samplePlan(artifactIds) as {
      feature: Record<string, unknown>;
      tasks: { id: string; dependsOn?: string[] }[];
    };
    // Task 稳定 ID 全库唯一：第二 Feature 使用不同成员 ID。
    const secondPlan = {
      ...plan,
      feature: { ...plan.feature, title: '第二 Feature' },
      tasks: plan.tasks.map((task) => ({
        ...task,
        id: `s-${task.id.slice(2)}`,
        ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn.map((id) => `s-${id.slice(2)}`) }),
      })),
    };
    const imported2 = await submit(
      { phaseId: 'phase-1', plan: secondPlan },
      'feature.plan.import',
      { scope: { kind: 'project', projectId }, expectedRevision: phaseRevision },
    );
    if (imported2.status !== 'completed' || imported2.result === null) {
      throw new Error(`夹具第二 Feature 导入失败：${JSON.stringify((imported2 as { error?: unknown }).error ?? null).slice(0, 300)}`);
    }
    return (imported2.result as { feature: { id: string } }).feature.id;
  };

  return {
    box,
    session: harness.session,
    service,
    inspector: countingInspector,
    owner,
    projectId,
    featureId: feature.id,
    planDigest: feature.planDigest,
    artifactIds,
    submit,
    preview,
    previewSubmit,
    executionRows,
    eventCountDelta,
    seedActiveRun,
    seedActiveBatchForOtherFeature,
    seedBaselineOccupancy,
    importSecondFeature,
  };
}

function resultOf(receipt: CommandReceipt): ExecutionPreviewResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as unknown as ExecutionPreviewResult;
}

async function expectPublicError(
  run: (() => Promise<unknown>) | Promise<unknown>,
  expected: { readonly code: string; readonly reason?: string },
): Promise<PublicError> {
  const promise = typeof run === 'function' ? run() : run;
  const thrown = (await promise.then(
    (value) => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value).slice(0, 200)}`);
    },
    (error: unknown) => error,
  )) as PublicError;
  expect(isPublicError(thrown)).toBe(true);
  expect(thrown.code).toBe(expected.code);
  if (expected.reason !== undefined) {
    expect(thrown.details?.reason).toBe(expected.reason);
  }
  return thrown;
}

/* ------------------------------------------------------------------ *
 * 验收 1：ready 预览与固定单成员范围
 * ------------------------------------------------------------------ */

describe('F-004 ready 预览（固定范围 + 完整摘要 + previewDigest）', () => {
  it('已批准且有待执行工作的 Feature 返回 ready：单成员范围/各摘要/previewDigest；不创建执行实体', async () => {
    const s = await setup();
    const receipt = await s.previewSubmit();
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: EXECUTION_PREVIEW_OPERATION,
      scope: { kind: 'project', projectId: s.projectId },
    });
    const result = resultOf(receipt);
    expect(result.schemaVersion).toBe(EXECUTION_PREVIEW_RESULT_SCHEMA_VERSION);
    expect(result.status).toBe('ready');
    expect(result.scope.featureIds).toEqual([s.featureId]);
    expect(result.noWorkReason).toBeNull();
    expect(result.blocked).toEqual([]);
    expect(result.runtimeExecution).toBe(false);
    expect(result.previewDigest).toMatch(SHA256_HEX);
    expect(result.generatedAtUtcMs).toBeGreaterThan(0);

    const summary = result.summary!;
    expect(summary.approval).toMatchObject({ planDigest: s.planDigest, decisionId: expect.any(String) });
    expect(summary.approval.checkPolicyDigest).toMatch(SHA256_HEX);
    expect(summary.plan).toMatchObject({ planDigest: s.planDigest, taskCount: 3, pendingTaskIds: ['t-1', 't-2', 't-3'] });
    const head = s.box.gitHead('A');
    expect(summary.code).toEqual({ headCommit: head, hasUncommittedChanges: false, workingTreeDigest: expect.any(String) });
    expect(summary.code.workingTreeDigest).toMatch(SHA256_HEX);
    expect(summary.checkPolicyDigest).toBe(summary.approval.checkPolicyDigest);
    expect(summary.tasks).toHaveLength(3);
    for (const task of summary.tasks) {
      expect(task.taskId).toMatch(/^t-\d$/);
      expect(task.status).toBe('pending');
      expect(task.strategyCopyDigest).toMatch(SHA256_HEX);
      expect(typeof task.strategyConfigSource).toBe('string');
    }
    expect(summary.permissions.tasks).toHaveLength(3);
    for (const entry of summary.permissions.tasks) {
      expect(entry.digest).toMatch(SHA256_HEX);
    }
    expect([...summary.inputs.refs].map((ref) => ref.artifactId).sort()).toEqual(
      [s.artifactIds.src, s.artifactIds.req].sort(),
    );
    for (const ref of summary.inputs.refs) {
      expect(ref.version).toBe(1);
      expect(ref.contentHash).toMatch(SHA256_HEX);
      expect(ref.sizeBytes).toBeGreaterThan(0);
    }
    expect(summary.budget.batch).toEqual(VALID_BUDGET.batch);
    expect(summary.budget.run).toEqual(VALID_BUDGET.run);
    expect(summary.concurrency).toEqual({ maxConcurrentWorks: 1, source: 'default' });

    // 预览身份由摘要成分和所选 Feature 的当前 Phase 身份复算。
    expect(result.previewDigest).toBe(
      computeExecutionPreviewDigest({
        projectId: s.projectId,
        phaseId: 'phase-1',
        featureIds: [s.featureId],
        planDigest: summary.plan.planDigest,
        code: summary.code,
        tasks: summary.tasks.map((task) => ({ taskId: task.taskId, strategyCopyDigest: task.strategyCopyDigest })),
        checkPolicyDigest: summary.checkPolicyDigest,
        permissions: summary.permissions.tasks,
        inputs: summary.inputs.refs,
        budget: summary.budget,
      }),
    );

    // 不创建执行实体、不扣预算、零业务事件；计划实体行不变。
    expect(s.executionRows()).toEqual({ batches: 0, runs: 0 });
    expect(s.eventCountDelta()).toBe(0);
  });

  it('previewDigest 对相同输入确定（两次预览一致），不包含时间成分', async () => {
    const s = await setup();
    const first = resultOf(await s.previewSubmit());
    const second = resultOf(await s.previewSubmit());
    expect(second.previewDigest).toBe(first.previewDigest);
    expect(second.generatedAtUtcMs).toBeGreaterThan(first.generatedAtUtcMs);
  });

  it('相同 commandId 重放复用原回执；不同参数复用 commandId 冲突', async () => {
    const s = await setup();
    const envelope = s.preview();
    const first = await s.service.submit(s.owner, envelope);
    expect(first.status).toBe('completed');
    const replayed = await s.service.submit(s.owner, envelope);
    expect(replayed.status).toBe('completed');
    expect(replayed.replayed).toBe(true);
    expect((replayed as { result: unknown }).result).toEqual((first as { result: unknown }).result);
    const conflict = s.service.submit(s.owner, {
      ...envelope,
      payload: {
        featureIds: [s.featureId],
        budget: { ...VALID_BUDGET, run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 } },
      },
    });
    await expectPublicError(conflict, { code: 'conflict' });
    expect(s.executionRows()).toEqual({ batches: 0, runs: 0 });
  });

  it('Phase 后续新增其他 Feature 不自动进入范围：scope 与 previewDigest 均不变', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    await s.importSecondFeature();
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.scope.featureIds).toEqual([s.featureId]);
    expect(after.previewDigest).toBe(before.previewDigest);
    expect(after.summary!.plan.taskCount).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 2：no_work 与可理解阻塞原因
 * ------------------------------------------------------------------ */

describe('F-004 no_work（不创建 Batch/Run、不扣预算、不调用 Runtime）', () => {
  it('[case:empty-scope] 空范围返回 no_work（empty_scope）：零仓库 I/O、零执行实体', async () => {
    const s = await setup();
    const receipt = await s.previewSubmit({
      payload: { featureIds: [], budget: VALID_BUDGET },
    });
    const result = resultOf(receipt);
    expect(result.status).toBe('no_work');
    expect(result.noWorkReason).toBe('empty_scope');
    expect(result.scope.featureIds).toEqual([]);
    expect(result.previewDigest).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.runtimeExecution).toBe(false);
    expect(s.executionRows()).toEqual({ batches: 0, runs: 0 });
    expect(s.inspector.calls).toHaveLength(0);
  });

  it('[case:no-pending-work] 无待执行工作（全部 Task 已通过）返回 no_work（no_pending_tasks）', async () => {
    const s = await setup();
    s.session.database.prepare("UPDATE tasks SET status = 'passed'").run();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('no_work');
    expect(result.noWorkReason).toBe('no_pending_tasks');
    expect(result.scope.featureIds).toEqual([s.featureId]);
    expect(result.previewDigest).toBeNull();
    expect(s.executionRows()).toEqual({ batches: 0, runs: 0 });
    expect(s.eventCountDelta()).toBe(0);
  });

  it('无待执行工作的判定覆盖 pending 与 failed（failed 仍属待执行返工工作）', async () => {
    const s = await setup();
    s.session.database
      .prepare("UPDATE tasks SET status = 'passed' WHERE id != 't-2'")
      .run();
    s.session.database.prepare("UPDATE tasks SET status = 'failed' WHERE id = 't-2'").run();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('ready');
    expect(EXECUTION_PREVIEW_PENDING_WORK_TASK_STATUSES).toContain('failed');
    expect(result.summary!.plan.pendingTaskIds).toEqual(['t-2']);
  });
});

describe('F-004 可理解阻塞原因（blocked 结果，非错误）', () => {
  it('未批准：plan_approval/not_approved', async () => {
    const s = await setup();
    // 新导入未决策的 Feature。
    const second = await s.importSecondFeature();
    const result = resultOf(await s.previewSubmit({ payload: { featureIds: [second], budget: VALID_BUDGET } }));
    expect(result.status).toBe('blocked');
    expect(result.blocked).toEqual([{ kind: 'plan_approval', reason: 'not_approved' }]);
    expect(result.previewDigest).toBeNull();
    expect(result.runtimeExecution).toBe(false);
  });

  it('项目非 active：project_not_active（携带当前状态）', async () => {
    const s = await setup();
    s.session.database.prepare("UPDATE projects SET status = 'archiving'").run();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toContainEqual({ kind: 'project_not_active', status: 'archiving' });
  });

  it('Phase 不可执行：phase_not_executable（closed/archived）', async () => {
    const s = await setup();
    s.session.database.prepare("UPDATE phases SET status = 'closed'").run();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toContainEqual({ kind: 'phase_not_executable', status: 'closed' });
  });

  it('存在活动 Run：active_run（携带 Run 身份与状态；活动集含 paused/interrupted）', async () => {
    const s = await setup();
    const runId = s.seedActiveRun('running');
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toContainEqual({ kind: 'active_run', runId, status: 'running' });
    expect(ACTIVE_EXECUTION_STATUSES).toContain('paused');
    expect(ACTIVE_EXECUTION_STATUSES).toContain('interrupted');
    expect(ACTIVE_EXECUTION_STATUSES).not.toContain('succeeded');
  });

  it('同 Phase 已有活动 Batch（其他 Feature）：active_batch_in_phase', async () => {
    const s = await setup();
    const batchId = await s.seedActiveBatchForOtherFeature('running');
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toEqual([
      { kind: 'active_batch_in_phase', batchId, featureId: expect.any(String), status: 'running' },
    ]);
  });

  it('已有基线在途/隔离占用：baseline_occupancy（保留占用即可见）', async () => {
    const s = await setup();
    const holderOperationId = s.seedBaselineOccupancy();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toEqual([{ kind: 'baseline_occupancy', holderOperationId }]);
  });

  it('必需不可变输入不可用：required_input_unavailable（not_ready/not_found）', async () => {
    const s = await setup();
    s.session.database
      .prepare('UPDATE artifacts SET status = ? WHERE id = ?')
      .run('pending', s.artifactIds.req);
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    expect(result.blocked).toContainEqual({
      kind: 'required_input_unavailable',
      artifactId: s.artifactIds.req,
      detail: 'not_ready',
    });

    s.session.database.prepare('DELETE FROM artifacts WHERE id = ?').run(s.artifactIds.req);
    const afterDelete = resultOf(await s.previewSubmit());
    expect(afterDelete.blocked).toContainEqual({
      kind: 'required_input_unavailable',
      artifactId: s.artifactIds.req,
      detail: 'not_found',
    });
  });

  it('多个阻塞原因同时列出（确定性顺序，不静默取舍）', async () => {
    const s = await setup();
    s.session.database.prepare("UPDATE phases SET status = 'archived'").run();
    const holderOperationId = s.seedBaselineOccupancy();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('blocked');
    const kinds = result.blocked.map((reason) => reason.kind);
    expect(kinds).toContain('phase_not_executable');
    expect(kinds).toContain('baseline_occupancy');
    expect(result.blocked).toContainEqual({ kind: 'baseline_occupancy', holderOperationId });
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：拒绝矩阵与授权先于仓库/制品 I/O
 * ------------------------------------------------------------------ */

describe('F-004 结构化拒绝（跨项目/非法预算/并发/仓库绑定）', () => {
  it('跨项目 Feature：forbidden ownership_denied', async () => {
    const s = await setup();
    const secondProject = await s.submit(
      { repositoryPath: s.box.repoDirB, displayName: 'Repo B', description: null, labels: [] },
      'project.register',
      { scope: { kind: 'registration' } },
    );
    const otherProjectId = (
      (secondProject as { result: { project: { id: string } } }).result
    ).project.id;
    await expectPublicError(
      s.previewSubmit({ scope: { kind: 'project', projectId: otherProjectId } }),
      { code: 'forbidden', reason: 'ownership_denied' },
    );
  });

  it('目标 Feature 不存在：not_found feature_not_found', async () => {
    const s = await setup();
    await expectPublicError(
      s.previewSubmit({ payload: { featureIds: ['missing-feature'], budget: VALID_BUDGET } }),
      { code: 'not_found', reason: 'feature_not_found' },
    );
  });

  it('多成员范围拒绝（本阶段固定单 Feature，不静默截断）', async () => {
    const s = await setup();
    const second = await s.importSecondFeature();
    await expectPublicError(
      s.previewSubmit({ payload: { featureIds: [s.featureId, second], budget: VALID_BUDGET } }),
      { code: 'invalid_input', reason: 'multi_feature_scope_unsupported' },
    );
  });

  it('非法预算拒绝：必需缺失/非整数/越界/跨层不一致/deadline 已过（字段定位）', async () => {
    const s = await setup();
    const badBudgets: readonly [string, Record<string, unknown>][] = [
      [
        'missing maxRuns',
        {
          batch: {
            maxTotalAttempts: 8,
            maxRuntimeStarts: 8,
            maxNoProgressRuns: 1,
            deadlineUtcMs: NOW + 3_600_000,
          },
          run: VALID_BUDGET.run,
        },
      ],
      [
        'not integer',
        {
          batch: { ...VALID_BUDGET.batch, maxRuns: 1.5 },
          run: VALID_BUDGET.run,
        },
      ],
      [
        'out of range',
        {
          batch: { ...VALID_BUDGET.batch, maxRuns: 0 },
          run: VALID_BUDGET.run,
        },
      ],
      [
        'inconsistent limits',
        {
          batch: { ...VALID_BUDGET.batch, maxRuns: 4, maxTotalAttempts: 8, maxNoProgressRuns: 9 },
          run: VALID_BUDGET.run,
        },
      ],
      [
        'deadline passed',
        { batch: { ...VALID_BUDGET.batch, deadlineUtcMs: NOW - 1 }, run: VALID_BUDGET.run },
      ],
    ];
    for (const [label, budget] of badBudgets) {
      void label;
      const error = await expectPublicError(
        s.previewSubmit({ payload: { featureIds: [s.featureId], budget } }),
        { code: 'invalid_input', reason: 'invalid_budget' },
      );
      expect(typeof error.details?.field).toBe('string');
      expect(s.inspector.calls).toHaveLength(0);
    }
  });

  it('有效并发大于一拒绝：concurrency_not_supported（保存政策≠执行支持）', async () => {
    const s = await setup();
    const updated = await s.submit(
      {
        ...PROJECT_SETTINGS_PAYLOAD,
        policies: { executionLimits: { maxConcurrentWorks: 2 } },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(updated.status).toBe('completed');
    await expectPublicError(s.previewSubmit(), {
      code: 'invalid_input',
      reason: 'concurrency_not_supported',
    });
  });

  it('不安全仓库绑定拒绝：repoIdentity 漂移 binding_identity_mismatch（真实检查 vs 权威绑定行）', async () => {
    const s = await setup();
    const result = resultOf(await s.previewSubmit());
    expect(result.status).toBe('ready');
    // repoIdentity 由公共目录 realpath 派生，同路径替换内容不改变身份；漂移
    // 场景为权威绑定行与当前只读检查结果不一致（换仓/误改绑定）。以真实检查
    // 为准拒绝，不以绑定行冒充当前仓库。
    s.session.database
      .prepare('UPDATE repository_bindings SET repo_identity = ?')
      .run('gitdir-sha256:' + 'f'.repeat(64));
    await expectPublicError(s.previewSubmit(), {
      code: 'conflict',
      reason: 'binding_identity_mismatch',
    });
  });

  it('仓库绑定缺失拒绝：binding_missing', async () => {
    const s = await setup();
    s.session.database
      .prepare('UPDATE projects SET repository_binding_id = NULL')
      .run();
    s.session.database.prepare('DELETE FROM repository_bindings').run();
    await expectPublicError(s.previewSubmit(), { code: 'conflict', reason: 'binding_missing' });
  });

  it('端口未装配：unsupported（不冒充预览能力）', async () => {
    const s = await setup({ withoutPreviewPort: true });
    await expectPublicError(s.previewSubmit(), { code: 'unsupported' });
  });
});

describe('F-004 授权先于仓库或制品 I/O', () => {
  it('缺少执行能力的主体的请求在仓库检查之前拒绝（inspector 零调用）', async () => {
    const s = await setup();
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'all' },
    });
    await expectPublicError(
      s.service.submit(restricted, s.preview()),
      { code: 'forbidden' },
    );
    expect(s.inspector.calls).toHaveLength(0);
  });

  it('信封/预算校验失败先于仓库 I/O（inspector 零调用）', async () => {
    const s = await setup();
    await expectPublicError(
      s.previewSubmit({ payload: { featureIds: [s.featureId], budget: { batch: {}, run: {} } } }),
      { code: 'invalid_input', reason: 'invalid_budget' },
    );
    expect(s.inspector.calls).toHaveLength(0);
  });

  it('blocked 结果不做仓库 I/O；ready 预览恰好一次受控 inspect（realpath/身份复用）', async () => {
    const s = await setup();
    s.seedBaselineOccupancy();
    const blocked = resultOf(await s.previewSubmit());
    expect(blocked.status).toBe('blocked');
    expect(s.inspector.calls).toHaveLength(0);
    s.session.database.prepare('DELETE FROM baseline_occupancy').run();
    s.session.database.prepare('DELETE FROM baseline_operations').run();
    const ready = resultOf(await s.previewSubmit());
    expect(ready.status).toBe('ready');
    expect(s.inspector.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 4：预览身份的实质变化与无关变化
 * ------------------------------------------------------------------ */

describe('F-004 预览身份变化矩阵', () => {
  it('Task 策略实质变化改变 previewDigest（内容身份，非 revision）', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    const edited = await s.submit(
      { taskId: 't-2', executionConfig: EDITED_STRATEGY },
      'task.strategy.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(edited.status).toBe('completed');
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.previewDigest).not.toBe(before.previewDigest);
  });

  it('需求实质修订使批准失效（plan_changed 阻塞）并改变身份；重批后恢复 ready 且摘要是新身份', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    expect(before.status).toBe('ready');
    const revised = await s.submit(
      {
        featureId: s.featureId,
        plan: {
          ...(samplePlan(s.artifactIds) as Record<string, unknown>),
          tasks: (samplePlan(s.artifactIds).tasks as { id: string }[]).map((task) =>
            task.id === 't-3'
              ? { ...task, acceptance: { criteria: ['任务三验收（修订）'] } }
              : task,
          ),
        } as Record<string, unknown>,
      },
      'feature.plan.revise',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(revised.status).toBe('completed');
    const stale = resultOf(await s.previewSubmit());
    expect(stale.status).toBe('blocked');
    expect(stale.blocked).toEqual([{ kind: 'plan_approval', reason: 'plan_changed' }]);

    const row = s.session.database
      .prepare('SELECT plan_digest FROM features WHERE id = ?')
      .get(s.featureId) as { plan_digest: string };
    const reapprove = await s.submit(
      { featureId: s.featureId, planDigest: row.plan_digest, decision: 'approve', reason: '重批' },
      'feature.plan.decide',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 3 },
    );
    expect(reapprove.status).toBe('completed');
    const renewed = resultOf(await s.previewSubmit());
    expect(renewed.status).toBe('ready');
    expect(renewed.previewDigest).not.toBe(before.previewDigest);
  });

  it('检查政策实质变化使批准失效（check_policy_changed）并改变身份', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    expect(before.status).toBe('ready');
    const updated = await s.submit(
      { ...PROJECT_SETTINGS_PAYLOAD, policies: { verification: { requireChecksBeforeDone: true } } },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(updated.status).toBe('completed');
    const blocked = resultOf(await s.previewSubmit());
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked).toEqual([{ kind: 'plan_approval', reason: 'check_policy_changed' }]);

    const row = s.session.database
      .prepare('SELECT plan_digest FROM features WHERE id = ?')
      .get(s.featureId) as { plan_digest: string };
    const reapprove = await s.submit(
      { featureId: s.featureId, planDigest: row.plan_digest, decision: 'approve', reason: '政策重批' },
      'feature.plan.decide',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(reapprove.status).toBe('completed');
    const renewed = resultOf(await s.previewSubmit());
    expect(renewed.status).toBe('ready');
    expect(renewed.previewDigest).not.toBe(before.previewDigest);
  });

  it('预算实质变化改变 previewDigest（预算是授权身份成分）', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    const after = resultOf(
      await s.previewSubmit({
        payload: {
          featureIds: [s.featureId],
          budget: {
            batch: { ...VALID_BUDGET.batch, maxRuns: 3, maxTotalAttempts: 12, maxRuntimeStarts: 12 },
            run: VALID_BUDGET.run,
          },
        },
      }),
    );
    expect(after.status).toBe('ready');
    expect(after.previewDigest).not.toBe(before.previewDigest);
  });

  it('权限面实质变化改变 previewDigest（可信装配读取器）', async () => {
    let grants: string[] = [];
    const s = await setup({
      permissions: () => ({ grants: [...grants] }),
    });
    const before = resultOf(await s.previewSubmit());
    grants = ['repo.write'];
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.previewDigest).not.toBe(before.previewDigest);
  });

  it('代码实质变化改变 previewDigest（真实 Git 提交新 HEAD/新工作区摘要）', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    writeFileSync(join(s.box.repoDirA, 'src', 'new-file.ts'), 'export const next = 2;\n', 'utf-8');
    commitAll(s.box.repoDirA, 'F-004 代码变化', { home: s.box.homeDir });
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.summary!.code.headCommit).not.toBe(before.summary!.code.headCommit);
    expect(after.previewDigest).not.toBe(before.previewDigest);
  });

  it('纯标签编辑不改变 previewDigest、不扩大范围、不使批准失效', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    const labeled = await s.submit(
      { entityType: 'feature', id: s.featureId, labels: ['preview-meta'] },
      'plan.labels.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 2 },
    );
    expect(labeled.status).toBe('completed');
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.scope.featureIds).toEqual([s.featureId]);
    expect(after.previewDigest).toBe(before.previewDigest);
  });

  it('默认 modelMap 更新不改变 previewDigest（策略按副本使用，不重读路由）', async () => {
    const s = await setup();
    const before = resultOf(await s.previewSubmit());
    const updated = await s.submit(
      {
        ...PROJECT_SETTINGS_PAYLOAD,
        strategies: {
          modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
      },
      'settings.project.update',
      { scope: { kind: 'project', projectId: s.projectId }, expectedRevision: 1 },
    );
    expect(updated.status).toBe('completed');
    const after = resultOf(await s.previewSubmit());
    expect(after.status).toBe('ready');
    expect(after.previewDigest).toBe(before.previewDigest);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 5：预览边界（不执行/不安装/不探测模型/不宣称 Runtime 能力）
 * ------------------------------------------------------------------ */

describe('F-004 预览边界与组合装配', () => {
  it('预览不执行仓库脚本、不改工作区：工作区摘要稳定且 git 状态干净', async () => {
    const s = await setup();
    const first = resultOf(await s.previewSubmit());
    writeFileSync(
      join(s.box.repoDirA, 'must-not-run.js'),
      'process.exit(42);\n',
      'utf-8',
    );
    const second = resultOf(await s.previewSubmit());
    expect(second.status).toBe('ready');
    // 未跟踪脚本文件改变了工作区摘要（代码身份如实反映），但脚本从未被执行：
    // 预览成功本身 + 无任何进程/安装痕迹即证据；仓库其余内容不变。
    expect(second.summary!.code.workingTreeDigest).not.toBe(first.summary!.code.workingTreeDigest);
    const { git } = await import("../../../helpers/git-repo.ts");
    const status = git(['status', '--porcelain'], s.box.repoDirA, { home: s.box.homeDir });
    expect(status.trim()).toBe('?? must-not-run.js');
  });

  it('结果内嵌有界（≤ RECEIPT_RESULT_MAX_BYTES），不内联正文/凭据/绝对路径', async () => {
    const s = await setup();
    const receipt = await s.previewSubmit();
    expect(receipt.status).toBe('completed');
    const bytes = Buffer.byteLength(JSON.stringify((receipt as { result: unknown }).result), 'utf8');
    expect(bytes).toBeLessThanOrEqual(16_384);
    const text = JSON.stringify((receipt as { result: unknown }).result);
    expect(text).not.toContain(s.box.repoDirA);
    expect(text).not.toContain('credentialRef');
  });

  it('组合根装配：CoreApplication.executionPreview 可用且命令面接线', async () => {
    const s = await setup();
    const app = await s.box.openApplication();
    expect(typeof app.executionPreview.previewExecution).toBe('function');
    const receipt = await app.commandService.submit(s.owner, s.preview());
    expect(receipt.status).toBe('completed');
    expect(resultOf(receipt).status).toBe('ready');
    app.close();
  });

  it('有效并发缺省为单并发（default 来源），有效合并政策一致', async () => {
    const s = await setup();
    const result = resultOf(await s.previewSubmit());
    expect(result.summary!.concurrency).toEqual({ maxConcurrentWorks: 1, source: 'default' });
    const effective = mergeEffectiveSettings({
      global: null,
      project: null,
    });
    expect(effective.policies.executionLimits?.value.maxConcurrentWorks ?? 1).toBe(1);
  });
});
