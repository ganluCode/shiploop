/**
 * P03-3 / F-005：显式 ExecutionController 启动（真实临时 Git/SQLite/制品资源）。
 *
 * 验收面（.dag_context.json F-005）：
 * 1. start 经现有授权与幂等命令服务，事务外完成有界输入核验，短写事务内重新
 *    检查项目 active、Phase 可执行、批准依据、预览身份、活动执行及预算；输入
 *    漂移返回 preview_stale 且不创建或扣额。
 * 2. 第一次明确授权创建一个单 Feature Batch 和 Run（runsCreated=1）；Batch/Run
 *    快照、accepted 回执及脱敏 state_event 同事务成功或全部回滚，返回真实
 *    Batch/Run ID；Runtime 启动数仍为零，accepted 不改变 Task passed 或
 *    Feature completed。
 * 3. 相同命令完整重放返回相同 Batch/Run 且不再次扣额或唤醒；复用 commandId
 *    但请求摘要不同返回 conflict；新命令争抢活动 Feature 仅一个创建成功。
 * 4. 后续显式重试失败工作通过同一父 Batch 原子增加 dispatchOrdinal 与
 *    runsCreated，仍受父预算；终态 Run 不重开，同 Batch 已成功 workKey 拒绝
 *    再派发。
 * 5. workKey 固定 Feature、用途及有效计划/需求输入身份；成功、失败和取消 Run
 *    均不退还 Run 次数；新 Batch 只能来自新的明确用户授权。
 * 6. 仅在提交后通过窄端口唤醒，事务失败不得唤醒；唤醒丢失或失败不重复创建
 *    Run；无 Scheduler/Runtime 装配时保留 queued/not_ready 可查询原因；基线
 *    占用检查不被内存锁绕过。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../../packages/core/src/application/execution-start.ts';
import { signalRunDispatchAfterCommit } from '../../../../packages/core/src/application/execution-start.ts';
import { createSqliteAtomicCommandStore } from '../../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqlitePlanAccess } from '../../../../packages/core/src/adapters/sqlite/plan-store.ts';
import type { SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineWorkspaceReader } from '../../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createSqliteArtifactStore } from '../../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { isPublicError } from '../../../../packages/core/src/ports/commands.ts';
import type {
  CommandReceipt,
  PublicError,
  WorkAcceptedCommandReceipt,
} from '../../../../packages/core/src/ports/commands.ts';
import { EXECUTION_PREVIEW_OPERATION } from '../../../../packages/core/src/ports/execution-preview.ts';
import { EXECUTION_START_OPERATION } from '../../../../packages/core/src/ports/execution-start.ts';
import type { ExecutionDispatchSignalInput } from '../../../../packages/core/src/ports/execution-start.ts';
import type { RunOutcomeSettlementOutcome, RunOutcomeSettlementRecord } from '../../../../packages/core/src/ports/execution-store.ts';
import { EXECUTION_RUN_DISPATCHED_EVENT_TYPE } from '../../../../packages/core/src/ports/execution-store.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../../packages/core/src/ports/execution-input-prepare.ts';
import { mapStateEvents, PUBLIC_STATE_EVENT_TYPES } from '../../../../packages/core/src/ports/events.ts';
import { commitAll } from '../../../helpers/git-repo.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../../helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '执行启动验收',
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

interface SignalRecord {
  readonly calls: ExecutionDispatchSignalInput[];
}

interface HarnessOptions {
  readonly signal?: 'record' | 'throw';
  readonly withoutStartPort?: boolean;
  /** 预览返回 ready 后、进入写事务前的漂移注入点（模拟准备与提交之间的并发变化）。 */
  readonly afterPrepare?: () => void;
}

interface PreparedHarness {
  readonly box: CommandsTestFixture;
  readonly session: SqliteStorageSession;
  readonly service: CommandService;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly featureId: string;
  readonly signal: SignalRecord;
  readonly submit: (
    payload: Record<string, unknown>,
    operation: string,
    extra?: Record<string, unknown>,
  ) => Promise<CommandReceipt>;
  readonly previewOnce: () => Promise<string>;
  readonly startEnvelope: (changes?: Record<string, unknown>) => Record<string, unknown>;
  readonly startOnce: (changes?: Record<string, unknown>) => Promise<CommandReceipt>;
  readonly rows: () => {
    batches: number;
    runs: number;
    revisions: number;
    events: number;
  };
  readonly batchRow: () => Record<string, unknown> | undefined;
  readonly runRow: () => Record<string, unknown> | undefined;
  readonly settleRunOutcome: (runId: string, outcome: RunOutcomeSettlementOutcome) => RunOutcomeSettlementRecord;
  readonly markRunStatus: (runId: string, status: string) => void;
  readonly seedBaselineOccupancy: () => string;
  readonly commitWorkspaceChange: () => Promise<void>;
  readonly reviseAndReapprove: () => Promise<void>;
}

function seedBaselineOccupancyRaw(session: SqliteStorageSession, projectId: string): string {
  const operationId = randomUUID();
  const now = NOW;
  session.database
    .prepare(
      'INSERT INTO baseline_operations (id, created_at, updated_at, revision, project_id, kind, authorization_id, status) ' +
        "VALUES (?, ?, ?, 1, ?, 'baseline', NULL, 'running')",
    )
    .run(operationId, now, now, projectId);
  session.database
    .prepare(
      "INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at, process_identity) " +
        "VALUES ('global', ?, ?, ?, NULL)",
    )
    .run(operationId, now, now);
  return operationId;
}

function seedActiveRunRaw(session: SqliteStorageSession, projectId: string, featureId: string): string {
  const now = NOW;
  const batchId = randomUUID();
  session.database
    .prepare(
      'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, ' +
        'scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, ' +
        'runtime_starts, no_progress_runs, deadline_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 0, ?)',
    )
    .run(
      batchId,
      now,
      projectId,
      now,
      'phase-1',
      featureId,
      JSON.stringify({ featureIds: [featureId] }),
      JSON.stringify({}),
      'succeeded',
      JSON.stringify({ schemaVersion: 1, batch: VALID_BUDGET.batch, run: VALID_BUDGET.run }),
      VALID_BUDGET.batch.deadlineUtcMs,
    );
  const runId = randomUUID();
  session.database
    .prepare(
      'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, ' +
        'input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, ' +
        'run_time_limit_ms, attempts_created) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 3, 3_600_000, 0)',
    )
    .run(
      runId,
      now,
      projectId,
      now,
      batchId,
      featureId,
      'execute',
      JSON.stringify({}),
      JSON.stringify({}),
      'queued',
      'c'.repeat(64),
      `${featureId}:execute`,
    );
  return runId;
}

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
  }
  fixture = undefined;
});

async function setup(options: HarnessOptions = {}): Promise<PreparedHarness> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p033-f005-' });
  const box = fixture;
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
  const signal: SignalRecord = { calls: [] };
  const signalPort =
    options.signal === undefined
      ? undefined
      : options.signal === 'throw'
        ? {
            signalRunDispatched(): void {
              throw new Error('唤醒端口注入失败');
            },
          }
        : {
            signalRunDispatched(input: ExecutionDispatchSignalInput): void {
              signal.calls.push(input);
            },
          };
  const startPort = createExecutionStartService({
    // 预览包装：ready 结果返回后调用 afterPrepare 注入漂移（仅测试观测点；
    // 生产装配直接使用预览端口）。启动事务内重核必须在无任何提示的情况下
    // 拒绝这些漂移。
    preview: {
      previewExecution: async (projectId: string, payload: Parameters<typeof previewPort.previewExecution>[1]) => {
        const result = await previewPort.previewExecution(projectId, payload);
        if (result.status === 'ready' && options.afterPrepare !== undefined) {
          options.afterPrepare();
        }
        return result;
      },
    },
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  const service: CommandService = createCommandService({
    atomicStore,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    executionPreview: previewPort,
    ...(options.withoutStartPort ? {} : { executionStart: startPort }),
    ...(signalPort === undefined ? {} : { executionDispatchSignal: signalPort }),
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
  const projectScope = { kind: 'project', projectId } as const;

  const globalSettings = await submit(GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') throw new Error('夹具全局配置失败');
  const projectSettings = await submit(PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: projectScope,
  });
  if (projectSettings.status !== 'completed') throw new Error('夹具项目配置失败');

  const phase = await submit(
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
    { phaseId: 'phase-1', plan: samplePlan(artifactIds) },
    'feature.plan.import',
    { scope: projectScope, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) throw new Error('夹具计划导入失败');
  const feature = (imported.result as { feature: { id: string; planDigest: string } }).feature;

  const approve = async (): Promise<void> => {
    const featureRow = harness.session.database
      .prepare('SELECT plan_digest, revision, plan_status FROM features WHERE id = ?')
      .get(feature.id) as { plan_digest: string | null; revision: number; plan_status: string };
    if (featureRow.plan_digest === null) throw new Error('夹具计划摘要缺失');
    const decision = await submit(
      { featureId: feature.id, planDigest: featureRow.plan_digest, decision: 'approve', reason: '执行启动' },
      'feature.plan.decide',
      { scope: projectScope, expectedRevision: featureRow.revision },
    );
    if (decision.status !== 'completed') throw new Error('夹具批准失败');
  };
  await approve();

  const previewOnce = async (): Promise<string> => {
    const receipt = await service.submit(owner, {
      ...envelopeBase,
      commandId: randomUUID(),
      operation: EXECUTION_PREVIEW_OPERATION,
      scope: projectScope,
      payload: { featureIds: [feature.id], budget: VALID_BUDGET },
    });
    if (receipt.status !== 'completed') {
      throw new Error(`夹具预览失败：${JSON.stringify((receipt as { error?: unknown }).error ?? null).slice(0, 300)}`);
    }
    const digest = (receipt.result as { previewDigest: string | null }).previewDigest;
    if (digest === null) throw new Error('夹具预览未返回 ready 摘要');
    return digest;
  };

  const startEnvelope = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: EXECUTION_START_OPERATION,
    scope: projectScope,
    payload: { featureIds: [feature.id], budget: VALID_BUDGET, previewDigest: '0'.repeat(64) },
    ...changes,
  });
  const startOnce = async (changes: Record<string, unknown> = {}): Promise<CommandReceipt> => {
    const payloadChanges = changes.payload as Record<string, unknown> | undefined;
    // 重试形态：{ featureIds, retryBatchId }（无预算/预览摘要；不重算预览）。
    if (payloadChanges !== undefined && 'retryBatchId' in payloadChanges) {
      return service.submit(
        owner,
        startEnvelope({
          ...changes,
          payload: { featureIds: [feature.id], retryBatchId: payloadChanges.retryBatchId },
        }),
      );
    }
    const digest = await previewOnce();
    return service.submit(
      owner,
      startEnvelope({
        ...changes,
        payload: {
          featureIds: [feature.id],
          budget: VALID_BUDGET,
          previewDigest: digest,
          ...(payloadChanges ?? {}),
        },
      }),
    );
  };

  const db = () => harness.session.database;
  const rows = () => ({
    batches: (db().prepare('SELECT COUNT(*) AS n FROM execution_batches').get() as { n: number }).n,
    runs: (db().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
    revisions: (db().prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions').get() as { n: number }).n,
    events: (
      db()
        .prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?')
        .get(EXECUTION_RUN_DISPATCHED_EVENT_TYPE) as { n: number }
    ).n,
  });
  const batchRow = () =>
    db().prepare('SELECT * FROM execution_batches').get() as Record<string, unknown> | undefined;
  const runRow = () => db().prepare('SELECT * FROM runs').get() as Record<string, unknown> | undefined;
  const settleRunOutcome = (runId: string, outcome: RunOutcomeSettlementOutcome): RunOutcomeSettlementRecord =>
    atomicStore.transact('test.trustedCoreSettlement', (tx) => {
      const run = tx.getExecutionRun(projectId, runId);
      return tx.settleExecutionRunOutcome({
        projectId, batchId: run.batchId, runId, resultKey: `result-${runId}`,
        runRevision: run.revision, outcome, reason: null, progressEvidence: null,
      });
    });
  const markRunStatus = (runId: string, status: string): void => {
    db()
      .prepare('UPDATE runs SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?')
      .run(status, nowUtcMs(), runId);
  };
  const seedBaselineOccupancy = (): string => {
    const operationId = randomUUID();
    db()
      .prepare(
        'INSERT INTO baseline_operations (id, created_at, updated_at, revision, project_id, kind, authorization_id, status) ' +
          "VALUES (?, ?, ?, 1, ?, 'baseline', NULL, 'running')",
      )
      .run(operationId, nowUtcMs(), nowUtcMs(), projectId);
    db()
      .prepare(
        "INSERT INTO baseline_occupancy (id, holder_operation_id, acquired_at, heartbeat_at, process_identity) " +
          "VALUES ('global', ?, ?, ?, NULL)",
      )
      .run(operationId, nowUtcMs(), nowUtcMs());
    return operationId;
  };
  const commitWorkspaceChange = async (): Promise<void> => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${box.repoDirA}/late-change.txt`, '提交后漂移\n');
    await commitAll(box.repoDirA, 'F-005 drift commit');
  };
  const reviseAndReapprove = async (): Promise<void> => {
    const featureRow = db()
      .prepare('SELECT revision FROM features WHERE id = ?')
      .get(feature.id) as { revision: number };
    const plan = samplePlan(artifactIds) as {
      tasks: { id: string; acceptance?: { criteria: string[] } }[];
    };
    plan.tasks = plan.tasks.map((task) =>
      task.id === 't-1'
        ? { ...task, acceptance: { criteria: ['任务一验收（修订）'] } }
        : task,
    );
    const revised = await submit(
      { featureId: feature.id, plan },
      'feature.plan.revise',
      { scope: projectScope, expectedRevision: featureRow.revision },
    );
    if (revised.status !== 'completed') {
      throw new Error(`夹具修订失败：${JSON.stringify((revised as { error?: unknown }).error ?? null).slice(0, 300)}`);
    }
    await approve();
  };

  return {
    box,
    session: harness.session,
    service,
    owner,
    projectId,
    featureId: feature.id,
    signal,
    submit,
    previewOnce,
    startEnvelope,
    startOnce,
    rows,
    batchRow,
    runRow,
    settleRunOutcome,
    markRunStatus,
    seedBaselineOccupancy,
    commitWorkspaceChange,
    reviseAndReapprove,
  };
}

function expectPublicError(
  run: (() => Promise<unknown>) | Promise<unknown>,
): Promise<PublicError> {
  const promise = typeof run === 'function' ? run() : run;
  return promise.then(
    (value) => {
      throw new Error(`expected PublicError, got resolved: ${JSON.stringify(value).slice(0, 200)}`);
    },
    (error: unknown) => {
      expect(isPublicError(error)).toBe(true);
      return error as PublicError;
    },
  );
}

function acceptedOf(receipt: CommandReceipt): WorkAcceptedCommandReceipt {
  expect(receipt.status).toBe('accepted');
  return receipt as WorkAcceptedCommandReceipt;
}

/** rejected 回执的错误码与受控 reason（脱敏形态）。 */
function rejectedReasonOf(receipt: CommandReceipt): { code: string; reason: string } {
  expect(receipt.status).toBe('rejected');
  const error = (receipt as unknown as { error: { code: string; details?: { reason?: string } } }).error;
  return { code: error.code, reason: typeof error.details?.reason === 'string' ? error.details.reason : '' };
}

describe('F-008 受信结算后的真实命令重试边界', () => {
  it('[case:no-progress-limit] 失败结算后重试累计无进展；达到上限后拒绝同 Batch 新 Run，不退款或延期', async () => {
    const s = await setup();
    const budget = { batch: { ...VALID_BUDGET.batch, maxRuns: 4, maxNoProgressRuns: 2 }, run: VALID_BUDGET.run };
    const digest = await freshPreviewWithBudget(s, budget);
    const first = acceptedOf(await s.service.submit(s.owner, s.startEnvelope({
      payload: { featureIds: [s.featureId], budget, previewDigest: digest },
    })));
    const before = s.batchRow()!;
    const firstRun = s.runRow()!;
    s.settleRunOutcome(first.runId, 'failed');
    expect(s.batchRow()).toMatchObject({ no_progress_runs: 1, runs_created: 1, status: 'queued' });
    const retry = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(retry.status).toBe('completed');
    const secondRunId = (retry as { result: { runId: string } }).result.runId;
    expect(s.batchRow()).toMatchObject({ no_progress_runs: 1, runs_created: 2 });
    s.settleRunOutcome(secondRunId, 'failed');
    expect(s.batchRow()).toMatchObject({
      no_progress_runs: 2, runs_created: 2, attempts_created: 0, runtime_starts: 0,
      status: 'failed', reason: 'budget_exhausted', deadline_at: before.deadline_at,
      budget_snapshot: before.budget_snapshot, budget_revision: before.budget_revision,
    });
    const stopped = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(rejectedReasonOf(stopped).reason).toBe('batch_not_active');
    expect(s.rows().runs).toBe(2);
    const preserved = s.session.database.prepare('SELECT * FROM runs WHERE id = ?').get(first.runId);
    expect(preserved).toMatchObject({ created_at: firstRun.created_at, started_at: firstRun.started_at, status: 'failed' });
  });

  it('经受信结算 succeeded 后，新的重试命令拒绝 work_key_succeeded，原 Run 终态不倒写', async () => {
    const s = await setup();
    const budget = { batch: { ...VALID_BUDGET.batch, maxNoProgressRuns: 2 }, run: VALID_BUDGET.run };
    const digest = await freshPreviewWithBudget(s, budget);
    const first = acceptedOf(await s.service.submit(s.owner, s.startEnvelope({
      payload: { featureIds: [s.featureId], budget, previewDigest: digest },
    })));
    s.settleRunOutcome(first.runId, 'succeeded');
    const settled = s.runRow();
    const retry = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(rejectedReasonOf(retry).reason).toBe('work_key_succeeded');
    expect(s.rows().runs).toBe(1);
    expect(s.batchRow()).toMatchObject({ runs_created: 1, no_progress_runs: 1 });
    expect(s.runRow()).toEqual(settled);
  });
});

describe('F-005 首次明确授权：原子创建 Batch/Run/回执/事件（验收 2/6）', () => {
  it('创建单 Feature Batch + Run：runsCreated=1、真实 Batch/Run ID、runtime_starts=0、queued+可查询原因、初始预算修订行与脱敏事件同事务', async () => {
    const s = await setup();
    const receipt = await s.startOnce();

    // Work accepted v6：operationId=batchId、真实 UUID、project scope。
    const accepted = acceptedOf(receipt);
    expect(accepted.schemaVersion).toBe(6);
    expect(accepted.operation).toBe(EXECUTION_START_OPERATION);
    expect(accepted.operationId).toBe(accepted.batchId);
    expect(accepted.batchId).toMatch(UUID_V4);
    expect(accepted.runId).toMatch(UUID_V4);
    expect(accepted.scope).toEqual({ kind: 'project', projectId: s.projectId });
    expect(accepted.replayed).toBe(false);

    // 持久行与回执身份一致；runsCreated=1；Runtime 启动数为零。
    const batch = s.batchRow();
    const run = s.runRow();
    expect(batch).toBeDefined();
    expect(run).toBeDefined();
    expect(batch!.id).toBe(accepted.batchId);
    expect(batch!.runs_created).toBe(1);
    expect(batch!.runtime_starts).toBe(0);
    expect(batch!.attempts_created).toBe(0);
    expect(batch!.status).toBe('queued');
    expect(batch!.feature_id).toBe(s.featureId);
    expect(batch!.phase_id).toBe('phase-1');
    expect(batch!.budget_revision).toBe(1);
    expect(batch!.deadline_at).toBe(VALID_BUDGET.batch.deadlineUtcMs);
    expect(run!.id).toBe(accepted.runId);
    expect(run!.batch_id).toBe(accepted.batchId);
    expect(run!.status).toBe('queued');
    expect(run!.dispatch_ordinal).toBe(1);
    expect(run!.attempts_created).toBe(0);
    expect(run!.started_at).toBeNull();
    expect(run!.max_attempts_per_run).toBe(VALID_BUDGET.run.maxAttemptsPerRun);
    expect(run!.run_time_limit_ms).toBe(VALID_BUDGET.run.runTimeLimitMs);
    // 无 Scheduler/Runtime 装配：保留可查询排队原因，不伪造完成。
    expect(run!.reason).toBe('scheduler_not_assembled');
    expect((run!.work_key as string).length).toBe(64);
    expect(run!.scope_digest).toMatch(/^[0-9a-f]{64}$/);
    // 初始预算修订行（version=1、操作者=可信主体）。
    const revision = s.session.database
      .prepare('SELECT * FROM batch_budget_revisions WHERE batch_id = ?')
      .get(accepted.batchId) as Record<string, unknown>;
    expect(revision.version).toBe(1);
    expect(revision.approved_by).toBe('local-owner');
    expect(revision.reason).toBe('initial_authorization');
    // 脱敏事件：execution.run.dispatched、聚合 Run、恒定 payload、白名单成员。
    expect(s.rows().events).toBe(1);
    const eventRow = s.session.database
      .prepare('SELECT * FROM state_events WHERE event_type = ?')
      .get(EXECUTION_RUN_DISPATCHED_EVENT_TYPE) as Record<string, unknown>;
    expect(eventRow.aggregate_type).toBe('run');
    expect(eventRow.aggregate_id).toBe(accepted.runId);
    expect(JSON.parse(eventRow.payload as string)).toEqual({ dispatched: true });
    expect(PUBLIC_STATE_EVENT_TYPES).toContain(EXECUTION_RUN_DISPATCHED_EVENT_TYPE);
    const [publicEvent] = mapStateEvents([
      {
        id: eventRow.id,
        sequence: eventRow.sequence,
        eventType: eventRow.event_type,
        aggregateType: eventRow.aggregate_type,
        aggregateId: eventRow.aggregate_id,
        aggregateRevision: eventRow.aggregate_revision,
        projectId: eventRow.project_id,
        payload: JSON.parse(eventRow.payload as string),
        occurredAtUtcMs: eventRow.occurred_at,
      },
    ]);
    expect(publicEvent.type).toBe(EXECUTION_RUN_DISPATCHED_EVENT_TYPE);
    expect(publicEvent.payload).toEqual({ dispatched: true });

    // accepted 不改变 Task passed 或 Feature completed。
    const taskStatuses = s.session.database
      .prepare('SELECT status FROM tasks WHERE feature_id = ?')
      .all(s.featureId) as { status: string }[];
    expect(taskStatuses.map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
    const featureRow = s.session.database
      .prepare('SELECT status, plan_status FROM features WHERE id = ?')
      .get(s.featureId) as { status: string; plan_status: string };
    expect(featureRow.status).toBe('draft');
    expect(featureRow.plan_status).toBe('approved');
  });

  it('写入集合同事务全部回滚：注入事务失败后零 Batch/零 Run/零修订行/零事件/零回执', async () => {
    const s = await setup();
    const digest = await s.previewOnce();
    const atomic = createSqliteAtomicCommandStore(s.session, { nowUtcMs: () => NOW });
    // 在同一事务内完整写入集合（Batch+初始修订行+Run+事件）后注入失败：整组回滚。
    expect(() =>
      atomic.transact('test.rollback', (transaction) => {
        const batch = transaction.insertExecutionBatch({
          projectId: s.projectId,
          phaseId: 'phase-1',
          featureId: s.featureId,
          batchId: randomUUID(),
          scopeSnapshot: { schemaVersion: 1, featureIds: [s.featureId], previewDigest: digest },
          configSnapshot: { schemaVersion: 1 },
          budgetSnapshot: { schemaVersion: 1, batch: VALID_BUDGET.batch, run: VALID_BUDGET.run },
          status: 'queued',
          runsCreated: 1,
          reason: null,
        });
        transaction.insertBatchBudgetRevision({
          projectId: s.projectId,
          batchId: batch.id,
          version: 1,
          budgetSnapshot: { schemaVersion: 1, batch: VALID_BUDGET.batch, run: VALID_BUDGET.run },
          approvedBy: 'local-owner',
          reason: 'initial_authorization',
        });
        const run = transaction.insertExecutionRun({
          projectId: s.projectId,
          batchId: batch.id,
          featureId: s.featureId,
          runId: randomUUID(),
          purpose: 'execute',
          inputSnapshot: { schemaVersion: 1 },
          configSnapshot: { schemaVersion: 1 },
          status: 'queued',
          scopeDigest: digest,
          workKey: 'b'.repeat(64),
          dispatchOrdinal: 1,
          maxAttemptsPerRun: 3,
          runTimeLimitMs: 3_600_000,
          reason: null,
        });
        transaction.appendExecutionEvent({
          projectId: s.projectId,
          eventType: EXECUTION_RUN_DISPATCHED_EVENT_TYPE,
          aggregateType: 'run',
          aggregateId: run.id,
          aggregateRevision: run.revision,
          payload: { dispatched: true },
        });
        throw new Error('injected transaction failure');
      }),
    ).toThrow('injected transaction failure');
    // 注入事务未留下任何半提交行（零 Batch/零 Run/零修订行/零事件/零回执）。
    expect(s.rows()).toEqual({ batches: 0, runs: 0, revisions: 0, events: 0 });
    const receipts = s.session.database
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
      .get(EXECUTION_START_OPERATION) as { n: number };
    expect(receipts.n).toBe(0);
  });
});

describe('F-005 漂移与前置条件重核（验收 1）', () => {
  it('[case:preview-stale] 摘要不一致：preview_stale 拒绝回执，零创建零扣额', async () => {
    const s = await setup();
    const receipt = await s.service.submit(s.owner, s.startEnvelope());
    expect(receipt.status).toBe('rejected');
    const error = rejectedReasonOf(receipt);
    expect(error.code).toBe('conflict');
    expect(error.reason).toBe('preview_stale');
    expect(s.rows()).toEqual({ batches: 0, runs: 0, revisions: 0, events: 0 });
  });

  it('预览后代码漂移（新提交）：准备阶段判定不可启动 → preview_stale', async () => {
    const s = await setup();
    const staleDigest = await s.previewOnce();
    await s.commitWorkspaceChange();
    const receipt = await s.service.submit(
      s.owner,
      s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: staleDigest } }),
    );
    expect(receipt.status).toBe('rejected');
    expect(rejectedReasonOf(receipt).reason).toBe('preview_stale');
    expect(s.rows().batches).toBe(0);
  });

  it('预览后实质修订（即使重新批准）：旧摘要 preview_stale；新摘要可启动', async () => {
    const s = await setup();
    const staleDigest = await s.previewOnce();
    await s.reviseAndReapprove();
    const stale = await s.service.submit(
      s.owner,
      s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: staleDigest } }),
    );
    expect(stale.status).toBe('rejected');
    expect(rejectedReasonOf(stale).reason).toBe('preview_stale');
    const fresh = await s.startOnce();
    expect(acceptedOf(fresh).status).toBe('accepted');
  });

  it('预算调整后旧摘要失效（previewDigest 含预算）；纯输入面非法结构化拒绝', async () => {
    const s = await setup();
    const staleDigest = await s.previewOnce();
    const changedBudget = {
      batch: { ...VALID_BUDGET.batch, maxRuns: 1 },
      run: VALID_BUDGET.run,
    };
    const stale = await s.service.submit(
      s.owner,
      s.startEnvelope({ payload: { featureIds: [s.featureId], budget: changedBudget, previewDigest: staleDigest } }),
    );
    expect(stale.status).toBe('rejected');
    expect(rejectedReasonOf(stale).reason).toBe('preview_stale');

    // 空范围/多成员/非法摘要/未知键在信封层结构化拒绝（invalid_input）。
    await expectPublicError(
      s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [], budget: VALID_BUDGET, previewDigest: staleDigest } })),
    ).then((error) => {
      expect(error.code).toBe('invalid_input');
      expect(error.details?.reason).toBe('empty_scope');
    });
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({ payload: { featureIds: [s.featureId, 'feature-other'], budget: VALID_BUDGET, previewDigest: staleDigest } }),
      ),
    ).then((error) => {
      expect(error.details?.reason).toBe('feature_not_found');
    });
    await expectPublicError(
      s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: 'not-hex' } })),
    ).then((error) => {
      expect(error.details?.field).toBe('payload.previewDigest');
    });
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: staleDigest, batchId: randomUUID() } }),
      ),
    ).then((error) => {
      expect(error.details?.field).toBe('payload.batchId');
    });
    // 非法预算：事务外深校验拒绝（invalid_budget）。
    await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({
          payload: {
            featureIds: [s.featureId],
            budget: { batch: { ...VALID_BUDGET.batch, maxRuns: 0 }, run: VALID_BUDGET.run },
            previewDigest: staleDigest,
          },
        }),
      ),
    ).then((error) => {
      expect(error.details?.reason).toBe('invalid_budget');
    });
  });

  it('事务内基线占用（准备后出现）：resource_busy 抛出、零写入、零回执（内存锁不可绕过）', async () => {
    let holderOperationId = '';
    const s = await setup({
      afterPrepare: () => {
        // 预览 ready 后、写事务前注入占用：事务内 readBaselineOccupancy 权威重核
        //（不依赖任何内存锁）。
        holderOperationId = seedBaselineOccupancyRaw(s.session, s.projectId);
      },
    });
    const digest = await s.previewOnce();
    const error = await expectPublicError(
      s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } })),
    );
    expect(error.code).toBe('resource_busy');
    expect(error.details?.reason).toBe('baseline_in_progress');
    expect(error.details?.holderOperationId).toBe(holderOperationId);
    expect(s.rows()).toEqual({ batches: 0, runs: 0, revisions: 0, events: 0 });
    const receipts = s.session.database
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
      .get(EXECUTION_START_OPERATION) as { n: number };
    expect(receipts.n).toBe(0);
  });

  it('预览时已阻塞（活动 Run）：准备判定不可启动 → preview_stale，零创建', async () => {
    const s = await setup();
    // 首次启动成功（活动 Run 存在）。
    await s.startOnce();
    // 第二个新命令：准备阶段重算预览 blocked（active_run）→ not_startable →
    // 事务内固化 preview_stale 回执，零创建。
    const receipt = await s.service.submit(s.owner, s.startEnvelope());
    expect(receipt.status).toBe('rejected');
    expect(rejectedReasonOf(receipt).reason).toBe('preview_stale');
    expect(s.rows().runs).toBe(1);
    expect(s.rows().batches).toBe(1);
  });

  it('启动端口未装配：unsupported，不冒充能力', async () => {
    const s = await setup({ withoutStartPort: true });
    const digest = await s.previewOnce();
    const error = await expectPublicError(
      s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } })),
    );
    expect(error.code).toBe('unsupported');
  });
});

describe('F-005 幂等、commandId 复用与活动争抢（验收 3）', () => {
  it('相同命令完整重放：返回相同 Batch/Run，不再次扣额、不重复事件、不唤醒', async () => {
    const s = await setup({ signal: 'record' });
    const digest = await s.previewOnce();
    const envelope = s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } });
    const first = acceptedOf(await s.service.submit(s.owner, envelope));
    const before = s.rows();
    const replayed = acceptedOf(await s.service.submit(s.owner, envelope));
    expect(replayed.batchId).toBe(first.batchId);
    expect(replayed.runId).toBe(first.runId);
    expect(replayed.commandId).toBe(first.commandId);
    expect(replayed.replayed).toBe(true);
    expect(s.rows()).toEqual(before);
    // 唤醒只在首个提交后发生一次；重放不唤醒。
    expect(s.signal.calls).toHaveLength(1);
    expect(s.signal.calls[0]).toMatchObject({
      projectId: s.projectId,
      batchId: first.batchId,
      runId: first.runId,
      featureId: s.featureId,
    });
  });

  it('复用 commandId 但请求摘要不同：conflict idempotency_key_reuse，零副作用', async () => {
    const s = await setup();
    const digest = await s.previewOnce();
    const envelope = s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } });
    await s.service.submit(s.owner, envelope);
    const before = s.rows();
    const error = await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({
          commandId: envelope.commandId,
          payload: { featureIds: [s.featureId], budget: { ...VALID_BUDGET, run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 } }, previewDigest: digest },
        }),
      ),
    );
    expect(error.code).toBe('conflict');
    expect(error.details?.reason).toBe('idempotency_key_reuse');
    expect(s.rows()).toEqual(before);
  });

  it('新命令争抢活动 Feature：仅一个创建成功，后来者事务内拒绝、零回执', async () => {
    let armed = false;
    const s = await setup({
      afterPrepare: () => {
        if (armed) {
          // 准备与写事务之间注入另一命令已创建的活动 Run（竞态窗口）：
          // 事务内活动 Run 权威重核拒绝第二个创建。
          seedActiveRunRaw(s.session, s.projectId, s.featureId);
        }
      },
    });
    const digest = await s.previewOnce();
    armed = true;
    const error = await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } }),
      ),
    );
    expect(error.code).toBe('conflict');
    expect(error.details?.reason).toBe('execution_in_progress');
    // 仅一个创建成功（注入的活动 Run）；后来者零写入零回执（可换 commandId 重试）。
    expect(s.rows().runs).toBe(1);
    expect(s.rows().batches).toBe(1);
    const receipts = s.session.database
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
      .get(EXECUTION_START_OPERATION) as { n: number };
    expect(receipts.n).toBe(0);
  });
});

describe('F-005 同父 Batch 显式重试（验收 4/5）', () => {
  it('失败后显式重试：同一父 Batch、dispatchOrdinal+1、runsCreated=2、预算修订行不新增；重试回执为同步 completed 派发结果', async () => {
    const s = await setup();
    const first = acceptedOf(await s.startOnce());
    // 失败 Run：终态，不重开；重试创建新 Run 行。
    s.markRunStatus(first.runId, 'failed');
    const workKeyBefore = (s.runRow() as { work_key: string }).work_key;
    const retry = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    // 重试回执：completed v5（同事务同步完成的派发结果；同 Batch accepted 唯一
    // ——v10 迁移 operation_id 唯一索引承担，重试不重复占用授权身份）。
    expect(retry.status).toBe('completed');
    expect(retry.schemaVersion).toBe(5);
    expect(retry.operation).toBe(EXECUTION_START_OPERATION);
    const retryResult = (retry as { result: Record<string, unknown> }).result;
    expect(retryResult).toMatchObject({
      schemaVersion: 1,
      dispatched: true,
      batchId: first.batchId,
      featureId: s.featureId,
      dispatchOrdinal: 2,
      runsCreated: 2,
      status: 'queued',
      runtimeExecution: false,
    });
    expect(retryResult.runId as string).toMatch(UUID_V4);
    const retryRunId = retryResult.runId as string;
    expect(retryRunId).not.toBe(first.runId);
    const batch = s.batchRow() as { runs_created: number; runtime_starts: number; budget_revision: number };
    expect(batch.runs_created).toBe(2);
    expect(batch.runtime_starts).toBe(0);
    expect(batch.budget_revision).toBe(1);
    const runs = s.session.database
      .prepare('SELECT id, dispatch_ordinal, status FROM runs WHERE batch_id = ? ORDER BY dispatch_ordinal')
      .all(first.batchId) as { id: string; dispatch_ordinal: number; status: string }[];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: first.runId, dispatch_ordinal: 1, status: 'failed' });
    expect(runs[1]).toMatchObject({ id: retryRunId, dispatch_ordinal: 2, status: 'queued' });
    // workKey 不含代码身份：失败重试后代码可能已有进展，工作身份不变。
    expect((s.session.database.prepare('SELECT work_key FROM runs WHERE id = ?').get(retryRunId) as { work_key: string }).work_key).toBe(workKeyBefore);
    // 成功、失败 Run 均不退还 Run 次数（runs_created 只递增）；预算修订行不新增。
    expect(s.rows().events).toBe(2);
    expect(s.rows().revisions).toBe(1);
    // 重试命令完整重放：同一 completed 回执，不再次扣额/唤醒。
    const replayed = await s.service.submit(
      s.owner,
      s.startEnvelope({
        commandId: (retry as { commandId: string }).commandId,
        payload: { featureIds: [s.featureId], retryBatchId: first.batchId },
      }),
    );
    expect(replayed.status).toBe('completed');
    expect((replayed as { replayed: boolean }).replayed).toBe(true);
    expect((replayed as { result: { runId: string } }).result.runId).toBe(retryRunId);
    expect(s.rows().runs).toBe(2);
  });

  it('重试形态携带预算/摘要即结构化拒绝；已成功 workKey 拒绝再派发；终态 Batch 拒绝重试', async () => {
    const s = await setup();
    const first = acceptedOf(await s.startOnce());
    // 重试形态不得携带新授权依据（budget/previewDigest 均为未知键）。
    const mixed = await expectPublicError(
      s.service.submit(
        s.owner,
        s.startEnvelope({
          payload: {
            featureIds: [s.featureId],
            budget: VALID_BUDGET,
            previewDigest: 'a'.repeat(64),
            retryBatchId: first.batchId,
          },
        }),
      ),
    );
    expect(mixed.code).toBe('invalid_input');
    expect(mixed.details?.field).toBe('payload.budget');

    // 同 Batch 已成功 workKey：拒绝再派发。
    s.markRunStatus(first.runId, 'succeeded');
    const succeeded = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(succeeded.status).toBe('rejected');
    expect(rejectedReasonOf(succeeded).reason).toBe('work_key_succeeded');
    expect(s.rows().runs).toBe(1);

    // 终态 Batch（cancelled）不接受新派发。
    s.session.database
      .prepare('UPDATE execution_batches SET status = ? WHERE id = ?')
      .run('cancelled', first.batchId);
    s.markRunStatus(first.runId, 'cancelled');
    const cancelled = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(cancelled.status).toBe('rejected');
    expect(rejectedReasonOf(cancelled).reason).toBe('batch_not_active');
  });

  it('计划实质修订后 workKey 变化：重试旧 Batch 拒绝 retry_work_key_absent（新工作需新授权）', async () => {
    const s = await setup();
    const first = acceptedOf(await s.startOnce());
    s.markRunStatus(first.runId, 'failed');
    await s.reviseAndReapprove();
    const retry = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(retry.status).toBe('rejected');
    expect(rejectedReasonOf(retry).reason).toBe('retry_work_key_absent');
    expect(s.rows().runs).toBe(1);
  });

  it('父预算 maxRuns=1 耗尽：重试拒绝 budget_exhausted；不退还 Run 次数', async () => {
    const s = await setup();
    const singleRunBudget = { batch: { ...VALID_BUDGET.batch, maxRuns: 1 }, run: VALID_BUDGET.run };
    const digest = await freshPreviewWithBudget(s, singleRunBudget);
    const first = acceptedOf(
      await s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [s.featureId], budget: singleRunBudget, previewDigest: digest } })),
    );
    expect((s.batchRow() as { runs_created: number }).runs_created).toBe(1);
    s.markRunStatus(first.runId, 'failed');
    const retry = await s.startOnce({ payload: { retryBatchId: first.batchId } });
    expect(retry.status).toBe('rejected');
    expect(rejectedReasonOf(retry).reason).toBe('budget_exhausted');
    expect((s.batchRow() as { runs_created: number }).runs_created).toBe(1);
  });
});

async function freshPreviewWithBudget(
  s: PreparedHarness,
  budget: Record<string, unknown>,
): Promise<string> {
  const receipt = await s.service.submit(s.owner, {
    schemaVersion: 5,
    issuedAt: NOW_ISO,
    commandId: randomUUID(),
    operation: EXECUTION_PREVIEW_OPERATION,
    scope: { kind: 'project', projectId: s.projectId },
    payload: { featureIds: [s.featureId], budget },
  });
  if (receipt.status !== 'completed') {
    throw new Error(`预览失败：${JSON.stringify((receipt as { error?: unknown }).error ?? null).slice(0, 300)}`);
  }
  const digest = (receipt.result as { previewDigest: string | null }).previewDigest;
  if (digest === null) throw new Error('预览未返回 ready 摘要');
  return digest;
}

describe('F-005 提交后唤醒窄端口（验收 6）', () => {
  it('无 Scheduler 装配：Run 保留 queued + scheduler_not_assembled；不唤醒、不伪造启动', async () => {
    const s = await setup();
    await s.startOnce();
    expect(s.signal.calls).toHaveLength(0);
    expect((s.runRow() as { reason: string | null }).reason).toBe('scheduler_not_assembled');
    expect((s.batchRow() as { runtime_starts: number }).runtime_starts).toBe(0);
  });

  it('唤醒端口失败被吞掉：命令结果不受影响，持久 queued Run 可核对、无重复创建', async () => {
    const s = await setup({ signal: 'throw' });
    const first = acceptedOf(await s.startOnce());
    expect(first.status).toBe('accepted');
    expect(s.rows().runs).toBe(1);
    // 唤醒失败不产生第二 Run；持久 queued Run 是权威，可从状态核对
    //（装配了唤醒端口时 Run.reason 为 null，状态仍 queued）。
    const run = s.runRow() as { id: string; status: string; reason: string | null };
    expect(run.status).toBe('queued');
    expect(run.id).toBe(first.runId);
    expect(run.reason).toBeNull();
  });

  it('事务失败不得唤醒：冲突路径（活动 Run）不触发信号、零回执', async () => {
    let armed = false;
    const s = await setup({
      signal: 'record',
      afterPrepare: () => {
        if (armed) {
          seedActiveRunRaw(s.session, s.projectId, s.featureId);
        }
      },
    });
    const digest = await s.previewOnce();
    armed = true;
    // 命令在事务内被活动 Run 拒绝（抛出 → 回滚）→ 不唤醒、零回执。
    await expectPublicError(
      s.service.submit(s.owner, s.startEnvelope({ payload: { featureIds: [s.featureId], budget: VALID_BUDGET, previewDigest: digest } })),
    );
    expect(s.signal.calls).toHaveLength(0);
    // 仅注入的抢占 Run；命令零写入（无事件/无修订行/无回执）。
    expect(s.rows()).toEqual({ batches: 1, runs: 1, revisions: 0, events: 0 });
    const receipts = s.session.database
      .prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = ?')
      .get(EXECUTION_START_OPERATION) as { n: number };
    expect(receipts.n).toBe(0);
  });

  it('signalRunDispatchAfterCommit 纯边界：completed/rejected/重放不唤醒', async () => {
    const calls: ExecutionDispatchSignalInput[] = [];
    const signal = {
      signalRunDispatched(input: ExecutionDispatchSignalInput): void {
        calls.push(input);
      },
    };
    const completed = {
      schemaVersion: 5,
      commandId: randomUUID(),
      principalId: 'local-owner',
      operation: EXECUTION_START_OPERATION,
      scope: { kind: 'project', projectId: randomUUID() },
      requestDigest: 'a'.repeat(64),
      status: 'completed',
      result: null,
      resultRef: 'v1.' + 'b'.repeat(32),
      issuedAt: NOW_ISO,
      completedAt: NOW_ISO,
      replayed: false,
    } as unknown as import("../../../../packages/core/src/ports/commands.ts").CommandReceipt;
    signalRunDispatchAfterCommit(signal, completed, 'f-1');
    signalRunDispatchAfterCommit(undefined, completed, 'f-1');
    expect(calls).toHaveLength(0);
    const accepted = {
      schemaVersion: 6,
      commandId: randomUUID(),
      principalId: 'local-owner',
      operation: EXECUTION_START_OPERATION,
      scope: { kind: 'project', projectId: randomUUID() },
      requestDigest: 'a'.repeat(64),
      status: 'accepted',
      operationId: randomUUID(),
      batchId: randomUUID(),
      runId: randomUUID(),
      issuedAt: NOW_ISO,
      completedAt: NOW_ISO,
      replayed: false,
    } as import("../../../../packages/core/src/ports/commands.ts").WorkAcceptedCommandReceipt;
    signalRunDispatchAfterCommit(signal, accepted, 'f-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].featureId).toBe('f-1');
    signalRunDispatchAfterCommit(signal, { ...accepted, replayed: true }, 'f-1');
    expect(calls).toHaveLength(1);
  });
});
