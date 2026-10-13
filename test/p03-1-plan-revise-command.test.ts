/**
 * P03-1 / F-008：未执行草稿的实质计划修订命令（feature.plan.revise）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针，不以方法调用或日志
 * 代替业务状态）：
 * - 以 projectId（信封 scope）、featureId、Feature 聚合 expectedRevision 与
 *   合法修订计划整体替换：既有 Task 按稳定 ID 保留身份与既有策略副本（不因
 *   当前默认配置或 complexity 编辑自动更换 executionConfig）、新 Task 按创建
 *   策略规则从当前配置复制、被移除成员与旧边删除、planDigest 更新、
 *   feature.plan.revised 脱敏事件与 completed 回执同一 BEGIN IMMEDIATE 原子
 *   提交；修订后仍是草稿，不自动批准或启动执行；
 * - 同一写事务重核草稿可编辑性（非 draft 拒绝）与活动执行输入保护
 *  （queued/running/paused/停止未知等活动依据拒绝；探测失败 fail-closed 不
 *   默认为无活动）；保护条件与 CAS 竞争都由 Feature 聚合 revision + 同事务
 *   串行化裁决；生产无 Run 表：以受控测试装配注入探测验证，不创建假 Run 表、
 *   不宣称已验证真实 Work 竞争；
 * - 实质变化（摘要改变）使旧摘要批准不可继续生效（planStatus 回 draft，
 *   隔离装配预置 approved）；纯标签变化经由修订载荷不失效（摘要不变保持
 *   approved）；
 * - 旧 revision 固化 rejected 且零写入；同 revision 竞争修订/标签编辑仅一个
 *   生效（共用 Feature 聚合 CAS 空间）；修订后 Task revision 递增使并发
 *   Task 标签编辑旧 revision 失效；
 * - 非法计划（环/缺依赖/跨 Feature 依赖）、引用重核（缺失/跨项目/非可用/
 *   哈希不匹配）、新成员 ID 与库内任务冲突、归属越权按公开契约拒绝；
 * - 写入边界故障注入整组回滚（原 Tasks/边/摘要/revision/事件保持一致，无
 *   成功回执、不删除历史证据）；幂等重放/参数冲突沿用 P02 §5.5。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import type { ActiveExecutionInputState } from '../packages/core/src/application/feature-plan-revise.ts';
import { validateFeaturePlanInput } from '../packages/core/src/ports/feature-plan.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture,
  WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH_A = sha256('artifact-source-content');
const HASH_B = sha256('artifact-requirements-content');

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

interface ReviseResultFeature {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly title: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  readonly status: string;
  readonly planStatus: string;
  readonly planDigest: string;
  readonly sourceRefs: readonly { readonly artifactId: string; readonly contentHash?: string }[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ReviseResult {
  readonly feature: ReviseResultFeature;
  readonly tasks: readonly { readonly id: string }[];
  readonly memberChanges: {
    readonly keptTaskCount: number;
    readonly createdTaskCount: number;
    readonly removedTaskCount: number;
  };
  readonly validation: {
    readonly taskCount: number;
    readonly dependencyEdgeCount: number;
    readonly executable: boolean;
  };
}

function completedResult(receipt: CommandReceipt): ReviseResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as ReviseResult;
}

function rejectedError(receipt: CommandReceipt): { code: string; details?: Record<string, unknown> } {
  if (receipt.status !== 'rejected') {
    throw new Error(`expected rejected receipt, got ${receipt.status}`);
  }
  return receipt.error;
}

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { code: string; operation: string; reason?: string; field?: string },
): Promise<PublicError> {
  const error = (await run().then(
    value => {
      throw new Error(`expected PublicError(${expected.code}), got ${JSON.stringify(value)}`);
    },
    (thrown: unknown) => thrown,
  )) as PublicError;
  expect(error).toMatchObject({ code: expected.code, operation: expected.operation });
  if (expected.reason !== undefined) {
    expect(error.details?.reason).toBe(expected.reason);
  }
  if (expected.field !== undefined) {
    expect(error.details?.field).toBe(expected.field);
  }
  expect(JSON.stringify(error.toErrorShape())).not.toMatch(
    /SQL|TRIGGER|injected|stack|shiploop-f008/i,
  );
  return error;
}

/** 三 Task 链计划（t-1 ← t-2 ← t-3）；引用两个 ready 制品。 */
function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '计划导入描述',
      labels: [' Plan ', 'plan'],
      sourceRefs: [{ artifactId: artifactIds.src, contentHash: HASH_A }],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        description: null,
        labels: ['core'],
        complexity: 'low',
        acceptance: { criteria: ['任务一验收', '任务一第二条验收'] },
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收'] },
        dependsOn: ['t-1'],
      },
      {
        id: 't-3',
        title: '任务三',
        acceptance: { criteria: ['任务三验收'] },
        dependsOn: ['t-2'],
        requirementsRefs: [
          { artifactId: artifactIds.req },
          { artifactId: artifactIds.src, contentHash: HASH_A },
        ],
      },
    ],
  };
}

/** 修订计划：保留 t-1（内容不变）与 t-2（改标题+complexity low→high），移除 t-3，新建 t-4。 */
function revisedPlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '修订后的 Feature',
      description: '修订描述',
      labels: ['revised'],
      sourceRefs: [],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        description: null,
        labels: ['core'],
        complexity: 'low',
        acceptance: { criteria: ['任务一验收', '任务一第二条验收'] },
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
      {
        id: 't-2',
        title: '任务二（修订标题）',
        complexity: 'low',
        acceptance: { criteria: ['任务二验收（修订）'] },
        dependsOn: ['t-1'],
      },
      {
        id: 't-4',
        title: '任务四',
        complexity: 'low',
        acceptance: { criteria: ['任务四验收'] },
        dependsOn: ['t-2'],
        requirementsRefs: [{ artifactId: artifactIds.req }],
      },
    ],
  };
}

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
/** 修订前的配置变化：modelMap.low 改为 claude-sonnet（新 Task 用新值，既有 Task 不追溯）。 */
const PROJECT_SETTINGS_PAYLOAD_V2 = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  },
};

async function seedReadyArtifact(
  artifactStore: ReturnType<typeof createSqliteArtifactStore>,
  projectId: string,
  contentHash: string,
  locatorName: string,
): Promise<string> {
  const record = await artifactStore.registerArtifact({
    projectId,
    kind: 'requirement',
    mediaType: 'text/markdown',
    expectedHash: contentHash,
    locator: `artifacts/${locatorName}.md`,
  });
  await artifactStore.transitionArtifact(projectId, record.id, {
    expectedRevision: record.revision,
    outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
  });
  return record.id;
}

interface ReviseSetup {
  readonly box: CommandsTestFixture;
  readonly harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>>;
  readonly service: CommandService;
  readonly artifactStore: ReturnType<typeof createSqliteArtifactStore>;
  readonly probe: ReturnType<CommandsTestFixture['openProbe']>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly projectBId: string;
  readonly artifactIds: { readonly src: string; readonly req: string };
  readonly featureId: string;
  readonly reviseEnvelope: (
    changes?: Record<string, unknown>,
    plan?: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly planCounts: () => { features: number; tasks: number; taskDependencies: number };
  readonly tableCount: (table: string) => number;
  readonly rowBy: (table: 'features' | 'tasks', id: string) => Record<string, unknown> | undefined;
  readonly setActiveProbe: (state: ActiveExecutionInputState | (() => ActiveExecutionInputState)) => void;
  readonly setNow: (value: number) => void;
}

async function setup(options: { withFeatureInB?: boolean } = {}): Promise<ReviseSetup> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f008-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  /** 受控测试装配：活动执行输入探测（F-008 验收要求；生产无 Run 表）。 */
  let probeState: ActiveExecutionInputState | (() => ActiveExecutionInputState) = { active: false };
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    featurePlanReviseGuards: {
      activeExecutionInputs: () => (typeof probeState === 'function' ? probeState() : probeState),
    },
    nowUtcMs: () => now,
  });
  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs: () => now });
  const probe = box.openProbe();
  const owner = box.localOwner();

  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (payload: Record<string, unknown>, operation: string, extra: Record<string, unknown> = {}) =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit(
    { repositoryPath: box.repoDirA, displayName: 'Repo A', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registered.status !== 'completed' || registered.result === null) {
    throw new Error('夹具注册失败');
  }
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const registerB = await submit(
    { repositoryPath: box.repoDirB, displayName: 'Repo B', description: null, labels: [] },
    'project.register',
    { scope: { kind: 'registration' } },
  );
  if (registerB.status !== 'completed' || registerB.result === null) {
    throw new Error('夹具注册项目 B 失败');
  }
  const projectBId = (registerB.result as { project: { id: string } }).project.id;

  const globalSettings = await submit(GLOBAL_SETTINGS_PAYLOAD, 'settings.global.create', {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') {
    throw new Error('夹具全局配置失败');
  }
  const projectSettings = await submit(PROJECT_SETTINGS_PAYLOAD, 'settings.project.create', {
    scope: { kind: 'project', projectId },
  });
  if (projectSettings.status !== 'completed' || projectSettings.result === null) {
    throw new Error('夹具项目配置失败');
  }
  const projectSettingsRevision = (projectSettings.result as { revision: number }).revision;

  const phase = await submit({ id: 'phase-1', title: '第一阶段', description: null, labels: [] }, 'phase.create', {
    scope: { kind: 'project', projectId },
  });
  if (phase.status !== 'completed') {
    throw new Error('夹具 Phase 创建失败');
  }

  const artifactSrcId = await seedReadyArtifact(artifactStore, projectId, HASH_A, 'art-src');
  const artifactReqId = await seedReadyArtifact(artifactStore, projectId, HASH_B, 'art-req');
  const artifactIds = { src: artifactSrcId, req: artifactReqId } as const;

  const imported = await submit(
    { phaseId: 'phase-1', plan: samplePlan(artifactIds) },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) {
    throw new Error('夹具计划导入失败');
  }
  const featureId = (imported.result as { feature: { id: string } }).feature.id;

  // 修订前更新项目配置（modelMap.low → claude-sonnet-3）：验证既有 Task 不追溯、
  // 新 Task 按当前配置复制。
  const settingsUpdated = await submit(
    PROJECT_SETTINGS_PAYLOAD_V2,
    'settings.project.update',
    { scope: { kind: 'project', projectId }, expectedRevision: projectSettingsRevision },
  );
  if (settingsUpdated.status !== 'completed') {
    throw new Error('夹具项目配置更新失败');
  }

  if (options.withFeatureInB ?? false) {
    const phaseB = await submit(
      { id: 'phase-b', title: 'B 阶段', description: null, labels: [] },
      'phase.create',
      { scope: { kind: 'project', projectId: projectBId } },
    );
    if (phaseB.status !== 'completed') {
      throw new Error('夹具项目 B Phase 创建失败');
    }
    const importedB = await submit(
      {
        phaseId: 'phase-b',
        plan: {
          schemaVersion: 1,
          feature: { title: 'B Feature' },
          tasks: [{ id: 't-b1', title: 'B 任务', acceptance: { criteria: ['b'] } }],
        },
      },
      'feature.plan.import',
      { scope: { kind: 'project', projectId: projectBId }, expectedRevision: 1 },
    );
    if (importedB.status !== 'completed') {
      throw new Error('夹具项目 B 计划导入失败');
    }
  }

  const reviseEnvelope = (
    changes: Record<string, unknown> = {},
    plan: Record<string, unknown> = revisedPlan(artifactIds),
  ) => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'feature.plan.revise' as const,
    scope: { kind: 'project', projectId },
    expectedRevision: 1,
    payload: { featureId, plan },
    ...changes,
  });

  const tableCount = (table: string): number =>
    probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;
  const planCounts = () => ({
    features: tableCount('features'),
    tasks: tableCount('tasks'),
    taskDependencies: tableCount('task_dependencies'),
  });
  const rowBy = (table: 'features' | 'tasks', id: string): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE id = ?`,
      [id],
    ) as Record<string, unknown> | undefined;

  return {
    box,
    harness,
    service,
    artifactStore,
    probe,
    owner,
    projectId,
    projectBId,
    artifactIds,
    featureId,
    reviseEnvelope,
    planCounts,
    tableCount,
    rowBy,
    setActiveProbe: state => {
      probeState = state;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('F-008 feature.plan.revise 修订闭环', () => {
  it('保留/新建/移除成员整体替换：既有身份与策略副本保留、新 Task 按当前配置、摘要/事件/回执同事务提交', async () => {
    const s = await setup();
    const input = s.reviseEnvelope();
    const receipt = await s.service.submit(s.owner, input);
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: 'feature.plan.revise',
      scope: { kind: 'project', projectId: s.projectId },
    });
    const result = completedResult(receipt);
    const expectedDigest = validateFeaturePlanInput(revisedPlan(s.artifactIds)).planDigest;
    expect(result.feature).toMatchObject({
      id: s.featureId,
      projectId: s.projectId,
      phaseId: 'phase-1',
      title: '修订后的 Feature',
      description: '修订描述',
      labels: ['revised'],
      status: 'draft',
      planStatus: 'draft',
      planDigest: expectedDigest,
      sourceRefs: [],
      revision: 2,
    });
    expect(result.tasks).toEqual([{ id: 't-1' }, { id: 't-2' }, { id: 't-4' }]);
    expect(result.memberChanges).toEqual({ keptTaskCount: 2, createdTaskCount: 1, removedTaskCount: 1 });
    expect(result.validation).toEqual({ taskCount: 3, dependencyEdgeCount: 2, executable: true });

    // 独立只读探针：成员/边/摘要/事件真实落库。
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
    const featureRow = s.rowBy('features', s.featureId)!;
    expect(featureRow).toMatchObject({
      title: '修订后的 Feature',
      plan_status: 'draft',
      plan_digest: expectedDigest,
      revision: 2,
      labels: JSON.stringify(['revised']),
      source_refs: JSON.stringify([]),
    });
    // t-1（保留、内容不变）：revision 递增一次，创建时间与策略副本不变。
    const t1 = s.rowBy('tasks', 't-1')!;
    expect(t1).toMatchObject({
      feature_id: s.featureId,
      title: '任务一',
      complexity: 'low',
      status: 'pending',
      revision: 2,
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet-2',
      }),
      config_source: 'project_default',
    });
    // t-2（保留、complexity medium→low）：业务内容替换，但既有策略副本不自动
    // 更换——导入时 medium 命中 defaultStrategy（claude-sonnet/global_default），
    // 若按修订时配置重选 low 会得到 claude-sonnet/project_default（来源不同）。
    const t2 = s.rowBy('tasks', 't-2')!;
    expect(t2).toMatchObject({
      title: '任务二（修订标题）',
      complexity: 'low',
      revision: 2,
      acceptance: JSON.stringify({ criteria: ['任务二验收（修订）'] }),
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      }),
      config_source: 'global_default',
    });
    // t-4（新建）：按修订时当前配置复制策略（modelMap.low 已更新为 claude-sonnet）。
    const t4 = s.rowBy('tasks', 't-4')!;
    expect(t4).toMatchObject({
      title: '任务四',
      complexity: 'low',
      status: 'pending',
      revision: 1,
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      }),
      config_source: 'project_default',
    });
    // t-3 被移除；边为修订后的新边集合。
    expect(s.rowBy('tasks', 't-3')).toBeUndefined();
    const edges = s.probe
      .selectAll<{ task_id: string; depends_on_id: string }>(
        'SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id',
      )
      .map(edge => ({ taskId: edge.task_id, dependsOnId: edge.depends_on_id }));
    expect(edges).toEqual([
      { taskId: 't-2', dependsOnId: 't-1' },
      { taskId: 't-4', dependsOnId: 't-2' },
    ]);
    // 同事务脱敏事件（aggregate_revision=修订后聚合 revision）。
    const events = s.probe.selectAll<{
      event_type: string;
      payload: string;
      aggregate_id: string;
      aggregate_revision: number;
    }>('SELECT event_type, payload, aggregate_id, aggregate_revision FROM state_events ORDER BY sequence');
    const revised = events.filter(event => event.event_type === 'feature.plan.revised');
    expect(revised).toHaveLength(1);
    expect(revised[0]).toMatchObject({
      payload: JSON.stringify({ revised: true }),
      aggregate_id: s.featureId,
      aggregate_revision: 2,
    });
    // 历史导入事件证据保留（不删除历史证据）。
    expect(events.some(event => event.event_type === 'feature.plan.imported')).toBe(true);

    // 重开真实库后回执可读、状态一致（真实持久化而非内存态）。
    const reopened = await s.box.openApplication();
    const commandId = (input as { commandId: string }).commandId;
    expect(await reopened.commandReceiptsService.getReceipt(s.owner, commandId)).toEqual({
      ...receipt,
      replayed: false,
    });
    expect(s.rowBy('features', s.featureId)?.plan_digest).toBe(expectedDigest);
    // 修订后仍是草稿；不产生执行实体或自动批准（执行域表由 P03-3 / F-002 迁移
    // v9 建立但为空；attempts 等后续表仍未建立）。
    expect(featureRow.plan_status).toBe('draft');
    expect(s.probe.tableExists('runs')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 0 }]);
    expect(s.probe.tableExists('attempts')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM attempts')).toEqual([{ n: 0 }]);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual([{ n: 0 }]);
    expect(s.probe.tableExists('execution_batches')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM execution_batches')).toEqual([{ n: 0 }]);
    expect(JSON.stringify(result)).not.toMatch(/approved|batch|attempt|"run"/i);
  });

  it('清空全部任务：修订为空草稿合法且明确不可执行，仍是草稿', async () => {
    const s = await setup();
    const emptyPlan = { schemaVersion: 1, feature: { title: '修订后的空草稿', labels: [], sourceRefs: [] }, tasks: [] };
    const receipt = await s.service.submit(s.owner, s.reviseEnvelope({}, emptyPlan));
    const result = completedResult(receipt);
    expect(result.validation).toEqual({ taskCount: 0, dependencyEdgeCount: 0, executable: false });
    expect(result.memberChanges).toEqual({ keptTaskCount: 0, createdTaskCount: 0, removedTaskCount: 3 });
    expect(result.feature).toMatchObject({ planStatus: 'draft', revision: 2 });
    expect(s.planCounts()).toEqual({ features: 1, tasks: 0, taskDependencies: 0 });
  });

  it('旧 revision 固化 rejected（conflict，携带 expected/actual）且零业务写入', async () => {
    const s = await setup();
    const first = await s.service.submit(s.owner, s.reviseEnvelope());
    expect(first.status).toBe('completed');
    const before = { ...s.probe.counts(), ...s.planCounts() };
    const stale = await s.service.submit(s.owner, s.reviseEnvelope({ expectedRevision: 1 }));
    const error = rejectedError(stale);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({
      reason: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
      entityType: 'feature',
    });
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual({
      ...before,
      // 仅新增一条固化 rejected 回执（P02 §5.5 纪律），零业务写入。
      command_receipts: (before.command_receipts ?? 0) + 1,
    });
  });

  it('同 revision 竞争修订经 CAS 裁决仅一个生效', async () => {
    const s = await setup();
    const winner = await s.service.submit(s.owner, s.reviseEnvelope());
    expect(winner.status).toBe('completed');
    const loser = await s.service.submit(
      s.owner,
      s.reviseEnvelope({}, {
        schemaVersion: 1,
        feature: { title: '竞争修订', labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '任务一', acceptance: { criteria: ['a'] } }],
      }),
    );
    expect(rejectedError(loser).details).toMatchObject({ reason: 'conflict', actualRevision: 2 });
    // 赢家的修订结果保持完整（无半成功混合状态）。
    expect(s.rowBy('features', s.featureId)).toMatchObject({ title: '修订后的 Feature', revision: 2 });
    expect(s.planCounts().tasks).toBe(3);
  });

  it('标签编辑与修订共用 Feature 聚合 CAS 空间；修订递增 Task revision 使并发标签编辑旧 revision 失效', async () => {
    const s = await setup();
    // 先修订（Feature rev 2，t-1/t-2 rev 2）。
    expect((await s.service.submit(s.owner, s.reviseEnvelope())).status).toBe('completed');
    // Feature 标签编辑以聚合新 revision 成功。
    const labelsEnvelope = (entityType: string, id: string, revision: number) => ({
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'plan.labels.update' as const,
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: revision,
      issuedAt: NOW_ISO,
      payload: { entityType, id, labels: ['post-revise'] },
    });
    expect((await s.service.submit(s.owner, labelsEnvelope('feature', s.featureId, 2))).status).toBe('completed');
    // 旧 Feature 聚合 revision 的修订被拒绝（标签编辑占用了同一 CAS 空间）。
    const staleRevise = await s.service.submit(s.owner, s.reviseEnvelope({ expectedRevision: 2 }));
    expect(rejectedError(staleRevise).details).toMatchObject({ reason: 'conflict', actualRevision: 3 });
    // Task 标签编辑以修订后的 Task revision 成功；修订前旧 revision 失效。
    expect((await s.service.submit(s.owner, labelsEnvelope('task', 't-1', 2))).status).toBe('completed');
    const staleTaskLabels = await s.service.submit(s.owner, labelsEnvelope('task', 't-2', 1));
    expect(rejectedError(staleTaskLabels).code).toBe('conflict');
  });

  it('活动执行输入保护：queued/running/paused/停止未知等活动依据固化 rejected 且零业务写入', async () => {
    const s = await setup();
    for (const kind of ['queued', 'running', 'paused', 'stop_unknown'] as const) {
      const before = { ...s.probe.counts(), ...s.planCounts() };
      s.setActiveProbe({ active: true, evidence: { kind } });
      const receipt = await s.service.submit(s.owner, s.reviseEnvelope());
      const error = rejectedError(receipt);
      expect(error.code).toBe('conflict');
      expect(error.details).toMatchObject({
        reason: 'active_execution_inputs',
        entityType: 'feature',
      });
      expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual({
        ...before,
        command_receipts: (before.command_receipts ?? 0) + 1,
      });
    }
    // 保护解除后同一 Feature 修订成功（保护不是永久性拒绝）。
    s.setActiveProbe({ active: false });
    expect((await s.service.submit(s.owner, s.reviseEnvelope())).status).toBe('completed');
    expect(s.rowBy('features', s.featureId)).toMatchObject({ revision: 2 });
  });

  it('保护探测失败 fail-closed：异常传播整组回滚、零回执，绝不默认为无活动', async () => {
    const s = await setup();
    const before = { ...s.probe.counts(), ...s.planCounts() };
    s.setActiveProbe(() => {
      throw new Error('probe storage unavailable');
    });
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope()), {
      code: 'internal',
      operation: 'feature.plan.revise',
    });
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
  });

  it('保护条件与 CAS 竞争：先行 start 占用聚合 revision 后，清空探测也不能以旧 CAS 修订', async () => {
    const s = await setup();
    // 受控装配模拟「未来 start/claim」：以同事务命令占用 Feature 聚合 revision
    // （标签编辑是现有唯一会递增 Feature 聚合 revision 的命令；start/claim 随
    // 执行链路引入时必须遵守同一事务与聚合 CAS 契约）。
    s.setActiveProbe({ active: true, evidence: { kind: 'running' } });
    const protected_ = await s.service.submit(s.owner, s.reviseEnvelope());
    expect(rejectedError(protected_).details).toMatchObject({ reason: 'active_execution_inputs' });
    const startClaim = {
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'plan.labels.update' as const,
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { entityType: 'feature', id: s.featureId, labels: ['claimed'] },
    };
    expect((await s.service.submit(s.owner, startClaim)).status).toBe('completed');
    // 探测清空 + 旧 expectedRevision：仍被聚合 CAS 拒绝（两个门条件独立生效）。
    s.setActiveProbe({ active: false });
    const staleAfterClaim = await s.service.submit(s.owner, s.reviseEnvelope({ expectedRevision: 1 }));
    expect(rejectedError(staleAfterClaim).details).toMatchObject({
      reason: 'conflict',
      actualRevision: 2,
    });
    // 以当前 revision 重试成功（CAS 是唯一裁决权威，不永久阻塞）。
    expect((await s.service.submit(s.owner, s.reviseEnvelope({ expectedRevision: 2 }))).status).toBe('completed');
  });

  it('非 draft Feature 不可实质修订（隔离装配预置 running）：固化 rejected 且零写入', async () => {
    const s = await setup();
    s.harness.session.database
      .prepare("UPDATE features SET status = 'running' WHERE id = ?")
      .run(s.featureId);
    const receipt = await s.service.submit(s.owner, s.reviseEnvelope());
    const error = rejectedError(receipt);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({
      reason: 'feature_not_draft',
      entityType: 'feature',
    });
    expect(s.rowBy('features', s.featureId)).toMatchObject({ revision: 1, status: 'running' });
    expect(s.planCounts().tasks).toBe(3);
  });
});

describe('F-008 批准摘要有效性（隔离装配预置 plan_status）', () => {
  it('实质变化使旧摘要批准不可继续生效：planStatus 回 draft、摘要更新', async () => {
    const s = await setup();
    s.harness.session.database
      .prepare("UPDATE features SET plan_status = 'approved' WHERE id = ?")
      .run(s.featureId);
    expect((await s.service.submit(s.owner, s.reviseEnvelope())).status).toBe('completed');
    const expectedDigest = validateFeaturePlanInput(revisedPlan(s.artifactIds)).planDigest;
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      plan_status: 'draft',
      plan_digest: expectedDigest,
      revision: 2,
    });
  });

  it('纯标签变化经由修订载荷不失效：摘要不变，approved 保持', async () => {
    const s = await setup();
    const digestBefore = (s.rowBy('features', s.featureId)?.plan_digest as string) ?? '';
    s.harness.session.database
      .prepare("UPDATE features SET plan_status = 'approved' WHERE id = ?")
      .run(s.featureId);
    // 仅改 Feature/Task 标签：业务执行依据不变 → planDigest 不变 → 批准不失效。
    const labelOnlyPlan = samplePlan(s.artifactIds);
    (labelOnlyPlan.feature as { labels: string[] }).labels = ['approved-plan'];
    const tasks = (labelOnlyPlan as { tasks: { labels?: string[] }[] }).tasks;
    for (const task of tasks) {
      task.labels = ['kept-label'];
    }
    expect((await s.service.submit(s.owner, s.reviseEnvelope({}, labelOnlyPlan))).status).toBe('completed');
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      plan_status: 'approved',
      plan_digest: digestBefore,
      revision: 2,
      labels: JSON.stringify(['approved-plan']),
    });
    expect(s.rowBy('tasks', 't-1')).toMatchObject({ labels: JSON.stringify(['kept-label']), revision: 2 });
  });
});

describe('F-008 拒绝矩阵（非法计划/引用/身份/归属）', () => {
  it('依赖环/缺依赖/跨 Feature 依赖失败：invalid_input 抛出且零业务写入', async () => {
    const s = await setup({ withFeatureInB: true });
    const before = { ...s.probe.counts(), ...s.planCounts() };
    // 环：t-1→t-2→t-1。
    const cyclicPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [] },
      tasks: [
        { id: 't-1', title: '一', acceptance: { criteria: ['a'] }, dependsOn: ['t-2'] },
        { id: 't-2', title: '二', acceptance: { criteria: ['b'] }, dependsOn: ['t-1'] },
      ],
    };
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope({}, cyclicPlan)), {
      code: 'invalid_input',
      operation: 'feature.plan.revise',
      field: 'payload.plan.tasks.dependencies',
    });
    // 缺依赖：目标不在本计划任务集内。
    const missingDepPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] }, dependsOn: ['t-x'] }],
    };
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope({}, missingDepPlan)), {
      code: 'invalid_input',
      operation: 'feature.plan.revise',
      field: 'payload.plan.tasks[0].dependsOn[0]',
    });
    // 跨 Feature 依赖：目标属于项目 B 的 Feature。
    const crossFeaturePlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] }, dependsOn: ['t-b1'] }],
    };
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope({}, crossFeaturePlan)), {
      code: 'invalid_input',
      operation: 'feature.plan.revise',
      field: 'payload.plan.tasks[0].dependsOn[0]',
    });
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
  });

  it('引用重核：缺失 not_found、跨项目 forbidden、非可用/哈希不匹配固化 rejected', async () => {
    const s = await setup();
    const missingRefPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [{ artifactId: 'art-missing' }] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] } }],
    };
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope({}, missingRefPlan)), {
      code: 'not_found',
      operation: 'feature.plan.revise',
    });
    // 跨项目制品：项目 B 的制品不能作为项目 A 的引用（即使 ready）。
    const crossArtifactId = await seedReadyArtifact(s.artifactStore, s.projectBId, HASH_B, 'art-b');
    const crossRefPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [{ artifactId: crossArtifactId }] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] } }],
    };
    await expectPublicError(() => s.service.submit(s.owner, s.reviseEnvelope({}, crossRefPlan)), {
      code: 'forbidden',
      operation: 'feature.plan.revise',
      reason: 'ownership_denied',
    });
    // 非可用制品（未 ready）：固化 rejected。
    const pendingArtifact = await s.artifactStore.registerArtifact({
      projectId: s.projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: HASH_A,
      locator: 'artifacts/pending.md',
    });
    const notUsablePlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [{ artifactId: pendingArtifact.id }] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] } }],
    };
    const notUsable = await s.service.submit(s.owner, s.reviseEnvelope({}, notUsablePlan));
    expect(rejectedError(notUsable).details).toMatchObject({ reason: 'artifact_not_usable' });
    // 内容哈希不匹配：固化 rejected。
    const hashMismatchPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [{ artifactId: s.artifactIds.src, contentHash: '0'.repeat(64) }] },
      tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] } }],
    };
    const mismatch = await s.service.submit(s.owner, s.reviseEnvelope({}, hashMismatchPlan));
    expect(rejectedError(mismatch).details).toMatchObject({ reason: 'artifact_content_hash_mismatch' });
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });

  it('新成员 ID 与库内其他 Feature 任务冲突：固化 rejected 且零写入', async () => {
    const s = await setup({ withFeatureInB: true });
    const clashPlan = {
      schemaVersion: 1,
      feature: { title: 'x', labels: [], sourceRefs: [] },
      tasks: [
        { id: 't-1', title: '一', acceptance: { criteria: ['a'] } },
        { id: 't-b1', title: '与项目 B 冲突', acceptance: { criteria: ['b'] } },
      ],
    };
    const receipt = await s.service.submit(s.owner, s.reviseEnvelope({}, clashPlan));
    expect(rejectedError(receipt).details).toMatchObject({
      reason: 'task_already_exists',
      entityType: 'task',
    });
    expect(s.planCounts()).toEqual({ features: 2, tasks: 4, taskDependencies: 2 });
  });

  it('归属越权：跨项目目标 forbidden、缺失目标 not_found（不泄漏存在性）', async () => {
    const s = await setup({ withFeatureInB: true });
    const featureB = s.probe.selectOne<{ id: string }>(
      'SELECT id FROM features WHERE project_id = ?',
      [s.projectBId],
    );
    // 项目 A scope 修订项目 B 的 Feature：ownership → forbidden。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.reviseEnvelope({ payload: { featureId: featureB!.id, plan: revisedPlan(s.artifactIds) } }),
        ),
      { code: 'forbidden', operation: 'feature.plan.revise', reason: 'ownership_denied' },
    );
    // 不存在的 Feature：not_found。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.reviseEnvelope({ payload: { featureId: 'feature-missing', plan: revisedPlan(s.artifactIds) } }),
        ),
      { code: 'not_found', operation: 'feature.plan.revise' },
    );
    expect(s.planCounts()).toEqual({ features: 2, tasks: 4, taskDependencies: 2 });
  });

  it('payload 混入 planStatus/approval/revision 等字段：invalid_input 定位 payload.<key>', async () => {
    const s = await setup();
    for (const [key, value] of [
      ['planStatus', 'approved'],
      ['approval', { approved: true }],
      ['revision', 2],
    ] as const) {
      await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.reviseEnvelope({ payload: { featureId: s.featureId, plan: revisedPlan(s.artifactIds), [key]: value } }),
          ),
        { code: 'invalid_input', operation: 'feature.plan.revise', field: `payload.${key}` },
      );
    }
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });

  it('授权：缺 feature.plan.revise 能力 forbidden；不可见项目 forbidden；恰切获准主体可修订', async () => {
    const s = await setup();
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.import'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => s.service.submit(noCapability, s.reviseEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.revise',
      reason: 'capability_denied',
    });
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.revise'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const invisibleError = await expectPublicError(() => s.service.submit(outsider, s.reviseEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.revise',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(invisibleError.toErrorShape())).not.toContain(s.projectId);
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.revise'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    expect((await s.service.submit(authorized, s.reviseEnvelope())).status).toBe('completed');
  });
});

describe('F-008 原子性与幂等', () => {
  it.each([
    ['featuresBeforeUpdate' as const],
    ['tasksBeforeUpdate' as const],
    ['tasksBeforeInsert' as const],
    ['taskDependenciesBeforeInsert' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚，原计划/摘要/revision/事件保持一致，撤除后重试成功', async point => {
    const s = await setup();
    const input = s.reviseEnvelope();
    const before = {
      counts: { ...s.probe.counts(), ...s.planCounts() },
      feature: s.rowBy('features', s.featureId),
      tasks: s.probe.selectAll('SELECT * FROM tasks ORDER BY id'),
      edges: s.probe.selectAll('SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id'),
      events: s.tableCount('state_events'),
    };
    // 安装故障触发器（与业务事务同一连接；TEMP 触发器随连接消亡）。
    const faultHandle = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'feature.plan.revise' });
    // 整组回滚：原 Tasks/边/摘要/revision/事件保持一致，无成功回执、不删除历史证据。
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
    expect(s.rowBy('features', s.featureId)).toEqual(before.feature);
    expect(s.probe.selectAll('SELECT * FROM tasks ORDER BY id')).toEqual(before.tasks);
    expect(s.probe.selectAll('SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id')).toEqual(
      before.edges,
    );
    expect(s.tableCount('state_events')).toBe(before.events);
    expect(s.tableCount('command_receipts')).toBe(before.counts.command_receipts);
    faultHandle.remove();
    // 撤除故障后相同信封（同一 commandId）重试成功。
    expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });

  it('同 commandId 同参数重放返回原回执且零新增写入；不同参数 conflict', async () => {
    const s = await setup();
    const input = s.reviseEnvelope();
    const first = await s.service.submit(s.owner, input);
    expect(first.status).toBe('completed');
    const before = { ...s.probe.counts(), ...s.planCounts() };
    const replayed = await s.service.submit(s.owner, input);
    expect(replayed).toEqual({ ...first, replayed: true });
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
    const commandId = (input as { commandId: string }).commandId;
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.reviseEnvelope(
            { commandId },
            {
              schemaVersion: 1,
              feature: { title: '不同参数', labels: [], sourceRefs: [] },
              tasks: [{ id: 't-1', title: '一', acceptance: { criteria: ['a'] } }],
            },
          ),
        ),
      { code: 'conflict', operation: 'feature.plan.revise', reason: 'idempotency_key_reuse' },
    );
  });
});
