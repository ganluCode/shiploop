/**
 * P03-2 / F-001：Task 策略副本授权 CAS 编辑命令（task.strategy.update）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针，不以方法调用或日志
 * 代替业务状态）：
 * - 可信主体在无活动执行依据的 Task 上，经既有命令信封与 Task 自身
 *   expectedRevision 提交完整 executionConfig 副本：保存 runtime/provider/model
 *   与适用非敏感参数及凭据引用；configSource/configSourceKey 表达「显式编辑」
 *   实际来源（task_edit/taskEdit），不是动态配置指针；task.strategy.updated
 *   脱敏事件与 completed 回执同一 BEGIN IMMEDIATE 原子提交；
 * - 不动态重读默认路由：项目 modelMap 更新与 Task complexity 更新均不追溯替换
 *   已创建策略；显式编辑只影响目标 Task（其他 Task 副本/来源、已有证据与累计
 *   计数保持不变；planDigest/planStatus/Feature revision 不变）；
 * - 同一写事务重核活动执行输入保护（queued/running/paused/停止未知拒绝；
 *   探测失败 fail-closed 不默认为无活动；暂停不视为安全停止）；保护与
 *   CAS 竞争由 Task 自身 revision + 同事务串行化裁决；生产无 Run/Attempt 表：
 *   以受控测试装配注入探测验证，不创建调度器或 Attempt 表、不宣称已验证
 *   真实 Work 竞争；
 * - 拒绝矩阵：缺 runtime/provider/model、孤立 model 覆盖（不跨来源补字段）、
 *   未知能力（unknown_runtime，含空目录 fail-closed，不伪装支持 Pi/Fake）、
 *   不兼容 provider/model、秘密正文字段（错误不回显秘密）、混入提权字段、
 *   缺能力、跨项目目标、陈旧 revision 均明确拒绝且零业务写入；
 * - 写入边界故障注入整组回滚（原策略/来源/revision/事件保持一致，无成功回执、
 *   不删除历史证据）；幂等重放/异参冲突沿用 P02 §5.5。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../packages/core/src/application/command-service.ts';
import type { ActiveExecutionInputState } from '../../../packages/core/src/application/feature-plan-revise.ts';
import {
  TASK_STRATEGY_EDIT_CONFIG_SOURCE,
  TASK_STRATEGY_EDIT_SOURCE_KEY,
} from '../../../packages/core/src/application/task-strategy-update.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { CommandReceipt, PublicError } from '../../../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture,
  WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from '../../helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH_A = sha256('artifact-source-content');
const HASH_B = sha256('artifact-requirements-content');

/** 编辑后的完整策略副本（含凭据引用；schemaVersion=2 标记）。 */
const EDITED_STRATEGY = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-sonnet-2',
  credentialRef: 'ref://keychain/pi-anthropic',
} as const;

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

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
    /SQL|TRIGGER|injected|stack|sk-live-secret-token/i,
  );
  return error;
}

/** 三 Task 链计划（t-1 ← t-2 ← t-3）；t-1=low、t-2=medium、t-3 无复杂度。 */
function samplePlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: null,
      labels: [],
      sourceRefs: [{ artifactId: artifactIds.src, contentHash: HASH_A }],
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
      {
        id: 't-3',
        title: '任务三',
        acceptance: { criteria: ['任务三验收'] },
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
/** 导入后项目配置更新：modelMap.low → claude-sonnet（已创建 Task 不追溯）。 */
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

interface EditSetup {
  readonly box: CommandsTestFixture;
  readonly harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>>;
  readonly service: CommandService;
  readonly probe: ReturnType<CommandsTestFixture['openProbe']>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly projectBId: string;
  readonly featureId: string;
  readonly settingsRevision: () => number;
  readonly editEnvelope: (
    changes?: Record<string, unknown>,
    taskId?: string,
    executionConfig?: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly counts: () => Record<string, number>;
  readonly taskRow: (taskId: string) => Record<string, unknown> | undefined;
  readonly featureRow: () => Record<string, unknown> | undefined;
  readonly lastEvent: () => Record<string, unknown> | undefined;
  readonly setActiveProbe: (state: ActiveExecutionInputState | (() => ActiveExecutionInputState)) => void;
}

async function setup(options: { withTaskInB?: boolean } = {}): Promise<EditSetup> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p032-f001-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  /** 受控测试装配：Task 活动执行输入探测（生产无 Run/Attempt 表，边界宣告）。 */
  let probeState: ActiveExecutionInputState | (() => ActiveExecutionInputState) = { active: false };
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    taskStrategyEditGuards: {
      activeTaskExecutionInputs: () => (typeof probeState === 'function' ? probeState() : probeState),
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
  let projectSettingsRevision = (projectSettings.result as { revision: number }).revision;

  const phase = await submit({ id: 'phase-1', title: '第一阶段', description: null, labels: [] }, 'phase.create', {
    scope: { kind: 'project', projectId },
  });
  if (phase.status !== 'completed') {
    throw new Error('夹具 Phase 创建失败');
  }

  const artifactSrcId = await seedReadyArtifact(artifactStore, projectId, HASH_A, 'art-src');
  const artifactReqId = await seedReadyArtifact(artifactStore, projectId, HASH_B, 'art-req');

  const imported = await submit(
    { phaseId: 'phase-1', plan: samplePlan({ src: artifactSrcId, req: artifactReqId }) },
    'feature.plan.import',
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) {
    throw new Error('夹具计划导入失败');
  }
  const featureId = (imported.result as { feature: { id: string } }).feature.id;

  // 导入后更新项目默认配置（modelMap.low → claude-sonnet）：已创建 Task 不追溯。
  const settingsUpdated = await submit(
    PROJECT_SETTINGS_PAYLOAD_V2,
    'settings.project.update',
    { scope: { kind: 'project', projectId }, expectedRevision: projectSettingsRevision },
  );
  if (settingsUpdated.status !== 'completed') {
    throw new Error('夹具项目配置更新失败');
  }
  projectSettingsRevision += 1;

  if (options.withTaskInB ?? false) {
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

  const editEnvelope = (
    changes: Record<string, unknown> = {},
    taskId = 't-2',
    executionConfig: Record<string, unknown> = { ...EDITED_STRATEGY },
  ) => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'task.strategy.update' as const,
    scope: { kind: 'project', projectId },
    expectedRevision: 1,
    payload: { taskId, executionConfig },
    ...changes,
  });

  const tableCount = (table: string): number =>
    probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;
  const counts = () => ({ ...probe.counts() }) as Record<string, number>;
  const taskRow = (taskId: string): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId]) as
      | Record<string, unknown>
      | undefined;
  const featureRow = (): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>('SELECT * FROM features WHERE id = ?', [featureId]) as
      | Record<string, unknown>
      | undefined;
  const lastEvent = (): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>(
      'SELECT * FROM state_events ORDER BY sequence DESC LIMIT 1',
    ) as Record<string, unknown> | undefined;

  return {
    box,
    harness,
    service,
    probe,
    owner,
    projectId,
    projectBId,
    featureId,
    settingsRevision: () => projectSettingsRevision,
    editEnvelope,
    counts,
    taskRow,
    featureRow,
    lastEvent,
    setActiveProbe: state => {
      probeState = state;
    },
  };
}

describe('F-001 task.strategy.update 编辑闭环', () => {
  it('完整策略 CAS 编辑：副本/来源/revision 同事务更新，事件与回执原子提交', async () => {
    const s = await setup();
    const before = s.counts();
    const receipt = await s.service.submit(s.owner, s.editEnvelope());
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: 'task.strategy.update',
      scope: { kind: 'project', projectId: s.projectId },
    });
    if (receipt.status !== 'completed' || receipt.result === null) {
      throw new Error('expected completed');
    }
    const task = (receipt.result as { task: Record<string, unknown> }).task;
    expect(task).toMatchObject({
      id: 't-2',
      executionConfig: EDITED_STRATEGY,
      configSource: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
      configSourceKey: TASK_STRATEGY_EDIT_SOURCE_KEY,
      revision: 2,
    });

    // 独立只读探针：目标 Task 行只换策略三列 + revision/updated_at。
    expect(s.taskRow('t-2')).toMatchObject({
      execution_config: JSON.stringify(EDITED_STRATEGY),
      config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
      config_source_key: TASK_STRATEGY_EDIT_SOURCE_KEY,
      revision: 2,
      status: 'pending',
      title: '任务二',
      complexity: 'medium',
    });
    // 脱敏事件：task.strategy.updated，聚合 t-2 自身，payload 恒 {strategyUpdated:true}。
    expect(s.lastEvent()).toMatchObject({
      event_type: 'task.strategy.updated',
      aggregate_type: 'task',
      aggregate_id: 't-2',
      aggregate_revision: 2,
      project_id: s.projectId,
      payload: JSON.stringify({ strategyUpdated: true }),
    });
    // 累计计数：仅新增一条事件与一条回执。
    expect(s.counts()).toEqual({ ...before, state_events: before.state_events + 1, command_receipts: before.command_receipts + 1 });
  });

  it('[case:f008-default-strategy-snapshot] 不动态重读默认路由：modelMap 更新与 complexity 更新均不追溯替换已创建策略；显式编辑只影响目标 Task', async () => {
    const s = await setup();
    const beforeTasks = [s.taskRow('t-1'), s.taskRow('t-2'), s.taskRow('t-3')];
    // 导入后 modelMap.low 已更新为 claude-sonnet（夹具）：三 Task 副本仍是导入时值。
    expect(beforeTasks[0]).toMatchObject({
      execution_config: JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' }),
      config_source: 'project_default',
    });
    expect(beforeTasks[1]).toMatchObject({
      execution_config: JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
      config_source: 'global_default',
    });

    // 显式编辑 t-2。
    expect((await s.service.submit(s.owner, s.editEnvelope())).status).toBe('completed');

    // complexity 更新（经 feature.plan.revise 把 t-1 low→high）不替换既有策略副本。
    const featureRow = s.featureRow()!;
    const revised = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'feature.plan.revise',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: featureRow.revision as number,
      payload: {
        featureId: s.featureId,
        plan: {
          schemaVersion: 1,
          feature: { title: '示例 Feature', labels: [], sourceRefs: [] },
          tasks: [
            {
              id: 't-1',
              title: '任务一',
              complexity: 'high',
              acceptance: { criteria: ['任务一验收'] },
              requirementsRefs: [],
            },
            { id: 't-2', title: '任务二', complexity: 'medium', acceptance: { criteria: ['任务二验收'] }, dependsOn: ['t-1'] },
            { id: 't-3', title: '任务三', acceptance: { criteria: ['任务三验收'] }, dependsOn: ['t-2'], requirementsRefs: [] },
          ],
        },
      },
    });
    expect(revised.status).toBe('completed');

    // t-1：complexity 已改 high、业务内容替换，但策略副本与来源保持导入时值
    //（若按修订时配置重选 high 会命中 defaultStrategy/claude-sonnet，可判别）。
    expect(s.taskRow('t-1')).toMatchObject({
      complexity: 'high',
      revision: 2,
      execution_config: JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' }),
      config_source: 'project_default',
    });
    // t-2：显式编辑结果保持（来源 task_edit，不因复杂度路径回落）。
    expect(s.taskRow('t-2')).toMatchObject({
      revision: 3,
      execution_config: JSON.stringify(EDITED_STRATEGY),
      config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
    });
    // t-3：完全不受影响（revision 仍为 2 = 修订整体替换递增一次）。
    expect(s.taskRow('t-3')).toMatchObject({
      revision: 2,
      execution_config: JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
      config_source: 'global_default',
    });
    // planDigest 与 Feature 事实：策略编辑不触碰（摘要只随实质计划内容变化）。
    expect(s.featureRow()).toMatchObject({ revision: 2, plan_status: 'draft' });
  });

  it('链式编辑与 Task CAS 空间：编辑递增 revision，旧 revision 的后续编辑/标签编辑经 CAS 失效', async () => {
    const s = await setup();
    expect((await s.service.submit(s.owner, s.editEnvelope())).status).toBe('completed');
    // 旧 revision 再编辑：固化 rejected（conflict）。
    const stale = await s.service.submit(s.owner, s.editEnvelope());
    expect(rejectedError(stale).details).toMatchObject({
      reason: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
      entityType: 'task',
    });
    // 新 revision 再编辑成功（revision 3），来源仍是显式编辑。
    const chained = await s.service.submit(
      s.owner,
      s.editEnvelope(
        { expectedRevision: 2 },
        't-2',
        { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      ),
    );
    expect(chained).toMatchObject({ status: 'completed' });
    expect(s.taskRow('t-2')).toMatchObject({
      revision: 3,
      config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE,
      execution_config: JSON.stringify({ schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }),
    });
    // 同 Task 标签编辑共用 Task 自身 CAS 空间：旧 revision 固化 rejected。
    const labelsStale = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 2,
      payload: { entityType: 'task', id: 't-2', labels: ['later'] },
    });
    expect(rejectedError(labelsStale).details).toMatchObject({ reason: 'conflict' });
    const labelsCurrent = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 3,
      payload: { entityType: 'task', id: 't-2', labels: ['later'] },
    });
    expect(labelsCurrent.status).toBe('completed');
  });
});

describe('F-001 拒绝矩阵（零业务写入）', () => {
  it('缺 runtime/provider/model 与孤立 model 覆盖：拒绝且不跨来源补字段', async () => {
    const s = await setup();
    const before = { counts: s.counts(), task: s.taskRow('t-2') };
    for (const [field, executionConfig] of [
      ['payload.executionConfig.runtime', { schemaVersion: 2, provider: 'anthropic', model: 'claude-sonnet' }],
      ['payload.executionConfig.provider', { schemaVersion: 2, runtime: 'pi', model: 'claude-sonnet' }],
      ['payload.executionConfig.model', { schemaVersion: 2, runtime: 'pi', provider: 'anthropic' }],
      // 孤立 model 覆盖：只给 model，不给 runtime/provider —— 绝不从既有副本拼补。
      ['payload.executionConfig.runtime', { schemaVersion: 2, model: 'claude-sonnet' }],
    ] as const) {
      await expectPublicError(
        () => s.service.submit(s.owner, s.editEnvelope({}, 't-2', executionConfig as Record<string, unknown>)),
        { code: 'invalid_input', operation: 'task.strategy.update', field },
      );
    }
    expect(s.counts()).toEqual(before.counts);
    expect(s.taskRow('t-2')).toEqual(before.task);
  });

  it('未知能力：unknown_runtime/incompatible_provider/incompatible_model 拒绝；空目录 fail-closed 不伪装支持 Pi/Fake', async () => {
    const s = await setup();
    const before = { counts: s.counts(), task: s.taskRow('t-2') };
    for (const [reason, executionConfig] of [
      ['unknown_runtime', { schemaVersion: 2, runtime: 'unknown-rt', provider: 'anthropic', model: 'claude-sonnet' }],
      ['incompatible_provider', { schemaVersion: 2, runtime: 'pi', provider: 'openai', model: 'gpt-x' }],
      ['unsupported_model', { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-opus' }],
    ] as const) {
      await expectPublicError(
        () => s.service.submit(s.owner, s.editEnvelope({}, 't-2', executionConfig as Record<string, unknown>)),
        { code: 'invalid_input', operation: 'task.strategy.update', reason },
      );
    }
    expect(s.counts()).toEqual(before.counts);
    expect(s.taskRow('t-2')).toEqual(before.task);

    // 生产目录为空（装配了空目录）：任何 runtime（含 pi/fake）都不得伪装受支持。
    const emptyCatalogService = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(s.harness.session, { nowUtcMs: () => NOW }),
      repositoryInspector: createRepositoryInspector(),
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
      nowUtcMs: () => NOW,
    });
    for (const runtime of ['pi', 'fake']) {
      await expectPublicError(
        () =>
          emptyCatalogService.submit(
            s.owner,
            s.editEnvelope({}, 't-2', {
              schemaVersion: 2,
              runtime,
              provider: 'anthropic',
              model: 'claude-sonnet',
            }),
          ),
        { code: 'invalid_input', operation: 'task.strategy.update', reason: 'unknown_runtime' },
      );
    }
    expect(s.taskRow('t-2')!.config_source).toBe('global_default');
  });

  it('秘密正文字段与非法引用：未知键拒绝，错误不回显秘密正文', async () => {
    const s = await setup();
    const before = { counts: s.counts(), task: s.taskRow('t-2') };
    const secretValue = 'sk-live-secret-token';
    for (const executionConfig of [
      { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', apiKey: secretValue },
      { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', token: secretValue },
      { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', credentialRef: `https://user:${secretValue}@api.example.com` },
    ]) {
      const error = await expectPublicError(
        () => s.service.submit(s.owner, s.editEnvelope({}, 't-2', executionConfig)),
        { code: 'invalid_input', operation: 'task.strategy.update' },
      );
      expect(JSON.stringify(error.toErrorShape())).not.toContain(secretValue);
    }
    expect(s.counts()).toEqual(before.counts);
    expect(s.taskRow('t-2')).toEqual(before.task);
  });

  it('权限扩大与信封纪律：payload 混入 status/planStatus/approval/revision 一律未知键拒绝', async () => {
    const s = await setup();
    const before = { counts: s.counts(), task: s.taskRow('t-2') };
    for (const [key, value] of [
      ['status', 'running'],
      ['planStatus', 'approved'],
      ['approval', { approved: true }],
      ['configSource', 'project_default'],
    ] as const) {
      await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.editEnvelope({ payload: { taskId: 't-2', executionConfig: { ...EDITED_STRATEGY }, [key]: value } }),
          ),
        { code: 'invalid_input', operation: 'task.strategy.update', field: `payload.${key}` },
      );
    }
    expect(s.counts()).toEqual(before.counts);
    expect(s.taskRow('t-2')).toEqual(before.task);
  });

  it('授权：缺能力 forbidden；不可见项目 forbidden（不泄漏存在性）；恰切获准主体可编辑', async () => {
    const s = await setup();
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['plan.labels.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => s.service.submit(noCapability, s.editEnvelope()), {
      code: 'forbidden',
      operation: 'task.strategy.update',
      reason: 'capability_denied',
    });
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['task.strategy.write'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const invisibleError = await expectPublicError(() => s.service.submit(outsider, s.editEnvelope()), {
      code: 'forbidden',
      operation: 'task.strategy.update',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(invisibleError.toErrorShape())).not.toContain(s.projectId);
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['task.strategy.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    expect((await s.service.submit(authorized, s.editEnvelope())).status).toBe('completed');
  });

  it('归属越权：跨项目目标 forbidden、缺失目标 not_found（不泄漏存在性）', async () => {
    const s = await setup({ withTaskInB: true });
    const before = s.counts();
    // 项目 A scope 编辑项目 B 的 Task：ownership → forbidden。
    await expectPublicError(() => s.service.submit(s.owner, s.editEnvelope({}, 't-b1')), {
      code: 'forbidden',
      operation: 'task.strategy.update',
      reason: 'ownership_denied',
    });
    // 不存在的 Task：not_found。
    await expectPublicError(() => s.service.submit(s.owner, s.editEnvelope({}, 't-missing')), {
      code: 'not_found',
      operation: 'task.strategy.update',
    });
    expect(s.counts()).toEqual(before);
    expect(s.taskRow('t-b1')!.config_source).toBe('global_default');
  });

  it('能力目录未装配：命令 unsupported，不冒充能力', async () => {
    const s = await setup();
    const before = s.counts();
    // 同一真实库上另建无目录服务（与生产装配缺口同一形态）。
    const bareService = createCommandService({
      atomicStore: createSqliteAtomicCommandStore(s.harness.session, { nowUtcMs: () => NOW }),
      repositoryInspector: createRepositoryInspector(),
      nowUtcMs: () => NOW,
    });
    await expectPublicError(() => bareService.submit(s.owner, s.editEnvelope()), {
      code: 'unsupported',
      operation: 'task.strategy.update',
    });
    expect(s.counts()).toEqual(before);
  });
});

describe('F-001 活动执行输入保护（同事务重核）', () => {
  it('[case:f008-active-strategy-fence] queued/running/paused/停止未知等活动依据固化 rejected 且零业务写入；暂停不视为安全停止', async () => {
    const s = await setup();
    for (const kind of ['queued', 'running', 'paused', 'stop_unknown'] as const) {
      const before = s.counts();
      s.setActiveProbe({ active: true, evidence: { kind } });
      const receipt = await s.service.submit(s.owner, s.editEnvelope());
      expect(rejectedError(receipt).details).toMatchObject({
        reason: 'active_execution_inputs',
        entityType: 'task',
      });
      expect(s.counts()).toEqual({ ...before, command_receipts: before.command_receipts + 1 });
    }
    // 保护解除后同一 Task 编辑成功（保护不是永久性拒绝）。
    s.setActiveProbe({ active: false });
    expect((await s.service.submit(s.owner, s.editEnvelope())).status).toBe('completed');
    expect(s.taskRow('t-2')).toMatchObject({ revision: 2, config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE });
  });

  it('保护探测失败 fail-closed：异常传播整组回滚、零回执，绝不默认为无活动', async () => {
    const s = await setup();
    const before = s.counts();
    s.setActiveProbe(() => {
      throw new Error('probe storage unavailable');
    });
    await expectPublicError(() => s.service.submit(s.owner, s.editEnvelope()), {
      code: 'internal',
      operation: 'task.strategy.update',
    });
    expect(s.counts()).toEqual(before);
  });

  it('活动建立与策略编辑竞争：探测翻转即拒绝，热改不能越过活动依据', async () => {
    const s = await setup();
    let probeCalls = 0;
    s.setActiveProbe(() => {
      probeCalls += 1;
      // 竞争形态：首次探测无活动，随后活动建立（模拟 Attempt 抢先落库）。
      return probeCalls === 1 ? { active: false } : { active: true, evidence: { kind: 'running' } };
    });
    expect((await s.service.submit(s.owner, s.editEnvelope())).status).toBe('completed');
    const second = await s.service.submit(
      s.owner,
      s.editEnvelope({ expectedRevision: 2 }, 't-2', {
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      }),
    );
    expect(rejectedError(second).details).toMatchObject({ reason: 'active_execution_inputs' });
    expect(s.taskRow('t-2')).toMatchObject({ revision: 2, config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE });
  });
});

describe('F-001 原子性与幂等', () => {
  it.each([
    ['tasksBeforeUpdate' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚，原策略/来源/revision/事件保持一致，撤除后重试成功', async point => {
    const s = await setup();
    const input = s.editEnvelope();
    const before = { counts: s.counts(), task: s.taskRow('t-2') };
    const faultHandle = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'task.strategy.update' });
    expect(s.taskRow('t-2')).toEqual(before.task);
    expect(s.counts()).toEqual(before.counts);
    faultHandle.remove();
    // 撤除故障后相同信封（同一 commandId）重试成功。
    expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
    expect(s.taskRow('t-2')).toMatchObject({ revision: 2, config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE });
  });

  it('同 commandId 同参数重放返回原回执且零新增写入；异参复用 conflict', async () => {
    const s = await setup();
    const input = s.editEnvelope();
    const first = await s.service.submit(s.owner, input);
    expect(first.status).toBe('completed');
    const before = s.counts();
    const replayed = await s.service.submit(s.owner, input);
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(s.counts()).toEqual(before);
    const commandId = (input as { commandId: string }).commandId;
    await expectPublicError(
      () => s.service.submit(s.owner, s.editEnvelope({ commandId }, 't-2', {
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      })),
      { code: 'conflict', operation: 'task.strategy.update', reason: 'idempotency_key_reuse' },
    );
    expect(s.counts()).toEqual(before);
  });

  it('同 revision 竞争编辑经 CAS 裁决仅一个生效（一条事件、一次递增）', async () => {
    const s = await setup();
    const before = s.counts();
    const first = await s.service.submit(s.owner, s.editEnvelope());
    const second = await s.service.submit(
      s.owner,
      s.editEnvelope({}, 't-2', {
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      }),
    );
    expect(first.status).toBe('completed');
    expect(rejectedError(second).details).toMatchObject({
      reason: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(s.taskRow('t-2')).toMatchObject({ revision: 2, config_source: TASK_STRATEGY_EDIT_CONFIG_SOURCE });
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 2,
    });
  });
});
