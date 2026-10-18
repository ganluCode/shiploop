/**
 * P03-1 / F-007：Phase/Feature/Task 纯标签 CAS 编辑（plan.labels.update）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针，不以方法调用或日志
 * 代替业务状态）：
 * - 三实体标签编辑闭环：只更新目标实体 labels 与自身 revision（连带
 *   updated_at），标签不向父子传播；计划内容、Task 策略、acceptance、引用、
 *   依赖边、planDigest 与 planStatus 不变——真实持久编辑后摘要保持不变
 *   （以持久行重建计划输入重算摘要与存储摘要一致）；
 * - 沿用命令授权、expectedRevision、回执与同事务脱敏事件（payload 恒
 *   {labelsUpdated:true}）：旧 revision 固化 rejected、同 revision 竞争编辑仅
 *   一个生效（含跨进程真实竞争）、同 commandId 重放不再次增加 revision/事件；
 * - 非法标签、跨项目目标、请求混入需求/依赖/状态字段均拒绝且不写业务数据；
 * - approved 语义与活动输入不失效用隔离测试装配验证（直接持久列预置
 *   plan_status='approved'，不增加生产审批/Run 创建入口来制造测试前提）；
 * - 写入故障（业务/事件/回执三个边界）整组回滚，无半成功状态。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import type { CommandService } from '../../../packages/core/src/application/command-service.ts';
import { validateFeaturePlanInput } from '../../../packages/core/src/ports/feature-plan.ts';
import { mapStateEvent } from '../../../packages/core/src/ports/events.ts';
import type { CommandReceipt, PublicError } from '../../../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture,
  runBarrierChildren,
  WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from '../../helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from '../../helpers/host/index.ts';

const NOW = 1_900_200_000_000;
const NOW_ISO = new Date(NOW).toISOString();

let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
afterEach(async () => {
  await environment?.dispose();
  environment = undefined;
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

interface LabelsEditResult {
  readonly entityType: string;
  readonly id: string;
  readonly labels: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
}

function completedResult(receipt: CommandReceipt): LabelsEditResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as LabelsEditResult;
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
    /SQL|TRIGGER|injected|stack|shiploop-f007/i,
  );
  return error;
}

/** 三 Task 链（t-1 ← t-2 ← t-3；空引用草稿合法），带标签便于验证不传播。 */
function samplePlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '计划导入描述',
      labels: ['plan'],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        description: null,
        labels: ['core'],
        complexity: 'low',
        acceptance: { criteria: ['任务一验收', '任务一第二条验收'] },
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
      },
    ],
  };
}

const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f007-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    nowUtcMs: () => now,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();

  const envelopeBase = { schemaVersion: 5, issuedAt: NOW_ISO };
  const submit = async (
    operation: string,
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registered = await submit('project.register', {
    repositoryPath: box.repoDirA,
    displayName: 'Repo A',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registered.status !== 'completed' || registered.result === null) {
    throw new Error('夹具注册失败');
  }
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const registerB = await submit('project.register', {
    repositoryPath: box.repoDirB,
    displayName: 'Repo B',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registerB.status !== 'completed' || registerB.result === null) {
    throw new Error('夹具注册项目 B 失败');
  }
  const projectBId = (registerB.result as { project: { id: string } }).project.id;

  const globalSettings = await submit('settings.global.create', GLOBAL_SETTINGS_PAYLOAD, {
    scope: { kind: 'global' },
  });
  if (globalSettings.status !== 'completed') {
    throw new Error('夹具全局配置失败');
  }
  const phase = await submit(
    'phase.create',
    { id: 'phase-1', title: '第一阶段', description: '阶段说明', labels: [] },
    { scope: { kind: 'project', projectId } },
  );
  if (phase.status !== 'completed') {
    throw new Error('夹具 Phase 创建失败');
  }
  const imported = await submit(
    'feature.plan.import',
    { phaseId: 'phase-1', plan: samplePlan() },
    { scope: { kind: 'project', projectId }, expectedRevision: 1 },
  );
  if (imported.status !== 'completed' || imported.result === null) {
    throw new Error('夹具计划导入失败');
  }
  const featureId = (imported.result as { feature: { id: string } }).feature.id;

  const labelsEnvelope = (
    entityType: string,
    id: string,
    labels: readonly string[],
    expectedRevision: number,
    changes: Record<string, unknown> = {},
  ) => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'plan.labels.update',
    scope: { kind: 'project', projectId },
    expectedRevision,
    payload: { entityType, id, labels },
    ...changes,
  });

  const rowBy = (table: string, id: string): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const planRows = () => ({
    feature: rowBy('features', featureId),
    tasks: ['t-1', 't-2', 't-3'].map(id => rowBy('tasks', id)),
    dependencies: probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM task_dependencies')?.n,
  });
  /** 以持久行重建计划输入并重算摘要（与 F-001 纯校验同一权威路径）。 */
  const digestFromRows = (): string => {
    const feature = rowBy('features', featureId)!;
    const tasks = ['t-1', 't-2', 't-3'].map(id => rowBy('tasks', id)!);
    const edges = probe
      .selectAll<{ task_id: string; depends_on_id: string }>(
        'SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id, depends_on_id',
      )
      ?? [];
    const dependsOnOf = (taskId: string): string[] =>
      edges.filter(edge => edge.task_id === taskId).map(edge => edge.depends_on_id);
    const plan = {
      schemaVersion: 1,
      feature: {
        title: feature.title,
        description: feature.description,
        labels: JSON.parse(feature.labels as string),
        sourceRefs: JSON.parse(feature.source_refs as string),
      },
      tasks: tasks.map(task => {
        const taskId = String(task.id);
        const dependsOn = dependsOnOf(taskId);
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          labels: JSON.parse(task.labels as string),
          complexity: task.complexity,
          acceptance: JSON.parse(task.acceptance as string),
          requirementsRefs: JSON.parse(task.requirements_refs as string),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
        };
      }),
    };
    return validateFeaturePlanInput(plan, { operation: 'test.digestFromRows' }).planDigest;
  };

  return {
    box,
    harness,
    service,
    probe,
    owner,
    projectId,
    projectBId,
    featureId,
    labelsEnvelope,
    rowBy,
    planRows,
    digestFromRows,
    tableCount: (table: string): number =>
      probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('F-007 纯标签 CAS 编辑闭环（层级实体标签编辑）', () => {
  it('三实体标签编辑：只更新目标实体 labels+revision，摘要/计划内容/策略不变，同事务脱敏事件', async () => {
    const s = await setup();
    const digestBefore = s.digestFromRows();
    expect(typeof digestBefore).toBe('string');
    expect(s.rowBy('features', s.featureId)?.plan_digest).toBe(digestBefore);
    const before = s.planRows();
    let lastLabelsCommandId = '';
    let lastLabelsReceipt: CommandReceipt | undefined;

    for (const [entityType, id, labels, expectedLabels] of [
      ['phase', 'phase-1', [' Fast ', 'fast', 'core'], ['fast', 'core']],
      ['feature', s.featureId, ['api'], ['api']],
      ['task', 't-1', ['backend'], ['backend']],
    ] as const) {
      const input = s.labelsEnvelope(entityType, id, labels, 1);
      const receipt = await s.service.submit(s.owner, input);
      expect(receipt).toMatchObject({
        status: 'completed',
        replayed: false,
        operation: 'plan.labels.update',
        scope: { kind: 'project', projectId: s.projectId },
        issuedAt: NOW_ISO,
      });
      // 有界结果只含标签编辑事实（不含计划正文/策略副本/批准语义）。
      expect(Object.keys((receipt as { result: unknown }).result as object).sort()).toEqual([
        'entityType',
        'id',
        'labels',
        'revision',
        'updatedAt',
      ]);
      expect(completedResult(receipt)).toEqual({
        entityType,
        id,
        labels: expectedLabels,
        revision: 2,
        updatedAt: expect.any(String),
      });
      lastLabelsCommandId = input.commandId as string;
      lastLabelsReceipt = receipt;
    }

    // 持久行：各目标实体 labels 规范化保存、revision 递增到 2。
    expect(s.rowBy('phases', 'phase-1')).toMatchObject({
      labels: JSON.stringify(['fast', 'core']),
      revision: 2,
    });
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      labels: JSON.stringify(['api']),
      revision: 2,
    });
    expect(s.rowBy('tasks', 't-1')).toMatchObject({
      labels: JSON.stringify(['backend']),
      revision: 2,
    });
    // 标签不向父子传播：未编辑实体标签与 revision 原样。
    expect(s.rowBy('tasks', 't-2')).toMatchObject({ labels: '[]', revision: 1 });
    expect(s.rowBy('tasks', 't-3')).toMatchObject({ labels: '[]', revision: 1 });

    // 计划内容/Task 策略/状态/引用/依赖不变（逐列对比，排除 labels/revision/updated_at）。
    const stripEdit = (row: Record<string, unknown> | undefined): Record<string, unknown> => {
      const { labels, revision, updated_at, ...rest } = row ?? {};
      void labels;
      void revision;
      void updated_at;
      return rest;
    };
    expect(stripEdit(s.rowBy('features', s.featureId))).toEqual(stripEdit(before.feature));
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      plan_status: 'draft',
      status: 'draft',
      plan_digest: digestBefore,
    });
    for (const index of [0, 1, 2]) {
      expect(stripEdit(s.rowBy('tasks', `t-${index + 1}`))).toEqual(stripEdit(before.tasks[index]));
    }
    expect(s.rowBy('tasks', 't-1')).toMatchObject({
      status: 'pending',
      config_source: 'global_default',
    });
    expect(s.planRows().dependencies).toBe(2);
    expect(stripEdit(s.rowBy('phases', 'phase-1'))).toMatchObject({
      title: '第一阶段',
      description: '阶段说明',
      status: 'open',
    });

    // 真实持久编辑后摘要保持不变（以持久行重建计划输入重算 = 存储摘要）。
    expect(s.digestFromRows()).toBe(digestBefore);

    // 同事务脱敏事件：每个成功编辑恰一条，payload 恒 {labelsUpdated:true}。
    const events = s.probe
      .stateEvents()
      .filter(event =>
        ['phase.labels.updated', 'feature.labels.updated', 'task.labels.updated'].includes(
          event.event_type,
        ),
      );
    expect(events.map(event => event.event_type)).toEqual([
      'phase.labels.updated',
      'feature.labels.updated',
      'task.labels.updated',
    ]);
    for (const event of events) {
      expect(event.payload).toBe('{"labelsUpdated":true}');
      expect(event.aggregate_revision).toBe(2);
    }
    expect(events[0]?.aggregate_id).toBe('phase-1');
    expect(events[1]?.aggregate_id).toBe(s.featureId);
    expect(events[2]?.aggregate_id).toBe('t-1');
    // 事件经公开映射复核（白名单形状、脱敏 payload 一致）。
    expect(
      mapStateEvent({
        id: events[2]!.id,
        sequence: events[2]!.sequence,
        eventType: events[2]!.event_type,
        aggregateType: events[2]!.aggregate_type,
        aggregateId: events[2]!.aggregate_id,
        aggregateRevision: events[2]!.aggregate_revision,
        projectId: events[2]!.project_id,
        payload: JSON.parse(events[2]!.payload as string),
        occurredAtUtcMs: events[2]!.occurred_at,
      }).payload,
    ).toEqual({ labelsUpdated: true });

    // 重开真实库后状态一致、回执可读（真实持久化而非内存态）。
    const reopened = await s.box.openApplication();
    expect(
      await reopened.commandReceiptsService.getReceipt(s.owner, lastLabelsCommandId),
    ).toEqual({ ...(lastLabelsReceipt as CommandReceipt), replayed: false });
    expect(s.rowBy('features', s.featureId)?.plan_digest).toBe(digestBefore);
    expect(s.digestFromRows()).toBe(digestBefore);
  });

  it('approved 语义与活动输入不失效（隔离测试装配预置 approved，不加生产审批入口）', async () => {
    const s = await setup();
    const digestBefore = s.digestFromRows();
    // 隔离测试装配：直接持久列预置 approved（生产无审批/Run 创建入口，不为
    // 测试前提新增入口）。
    s.harness.session.database
      .prepare("UPDATE features SET plan_status = 'approved' WHERE id = ?")
      .run(s.featureId);
    const inputsBefore = ['t-1', 't-2', 't-3'].map(id => {
      const row = s.rowBy('tasks', id)!;
      return {
        acceptance: row.acceptance,
        requirements_refs: row.requirements_refs,
        execution_config: row.execution_config,
        config_source: row.config_source,
        config_source_key: row.config_source_key,
        status: row.status,
      };
    });

    await s.service.submit(s.owner, s.labelsEnvelope('feature', s.featureId, ['approved-plan'], 1));
    await s.service.submit(s.owner, s.labelsEnvelope('task', 't-2', ['active-input'], 1));

    // approved 语义不失效：planStatus 保持 approved，摘要不变。
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      plan_status: 'approved',
      plan_digest: digestBefore,
      revision: 2,
    });
    // 活动输入不失效：验收/引用/策略副本/状态逐列不变。
    expect(
      ['t-1', 't-2', 't-3'].map(id => {
        const row = s.rowBy('tasks', id)!;
        return {
          acceptance: row.acceptance,
          requirements_refs: row.requirements_refs,
          execution_config: row.execution_config,
          config_source: row.config_source,
          config_source_key: row.config_source_key,
          status: row.status,
        };
      }),
    ).toEqual(inputsBefore);
    expect(s.planRows().dependencies).toBe(2);
    expect(s.digestFromRows()).toBe(digestBefore);
  });
});

describe('F-007 元数据 CAS（expectedRevision/竞争/幂等）', () => {
  it('旧 revision 固化 rejected（conflict，携带 expected/actual）且零业务写入', async () => {
    const s = await setup();
    const before = s.probe.counts();
    const stale = await s.service.submit(s.owner, s.labelsEnvelope('phase', 'phase-1', ['x'], 2));
    const error = rejectedError(stale);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({
      reason: 'conflict',
      entityType: 'phase',
      expectedRevision: 2,
      actualRevision: 1,
    });
    // 业务行/事件零变化；rejected 回执按 P02 约定持久化。
    expect(s.rowBy('phases', 'phase-1')).toMatchObject({ labels: '[]', revision: 1 });
    expect(s.probe.counts()).toMatchObject({
      state_events: before.state_events,
      command_receipts: (before.command_receipts ?? 0) + 1,
    });
    // 正确 revision 的编辑仍可进行。
    expect(await s.service.submit(s.owner, s.labelsEnvelope('phase', 'phase-1', ['x'], 1))).toMatchObject(
      { status: 'completed', replayed: false },
    );
  });

  it('同 revision 竞争编辑仅一个生效（CAS 裁决），revision 只增加一次', async () => {
    const s = await setup();
    const first = s.labelsEnvelope('task', 't-2', ['winner'], 1);
    const second = s.labelsEnvelope('task', 't-2', ['loser'], 1);
    const results = await Promise.all([
      s.service.submit(s.owner, first),
      s.service.submit(s.owner, second),
    ]);
    const statuses = results.map(receipt => receipt.status).sort();
    expect(statuses).toEqual(['completed', 'rejected']);
    const winner = results.find(receipt => receipt.status === 'completed')!;
    const loser = results.find(receipt => receipt.status === 'rejected')!;
    expect(completedResult(winner)).toMatchObject({ labels: ['winner'], revision: 2 });
    expect(rejectedError(loser).details).toMatchObject({
      reason: 'conflict',
      entityType: 'task',
      expectedRevision: 1,
      actualRevision: 2,
    });
    // 恰一次生效：revision=2、恰一条事件、标签为胜者值。
    expect(s.rowBy('tasks', 't-2')).toMatchObject({ revision: 2 });
    const events = s.probe.stateEvents().filter(event => event.event_type === 'task.labels.updated');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload as string)).toEqual({ labelsUpdated: true });
  });

  it('同 commandId 重放返回原回执且不再次增加 revision/事件；不同参数 idempotency_key_reuse', async () => {
    const s = await setup();
    const input = s.labelsEnvelope('feature', s.featureId, ['A', 'a', ' A '], 1);
    const first = await s.service.submit(s.owner, input);
    expect(first).toMatchObject({ status: 'completed', replayed: false });
    const before = s.probe.counts();
    // 同 commandId 同参数（键序/大小写/空白/重复标签形态不同但规范化等价）→ 原回执。
    const replay = await s.service.submit(s.owner, {
      ...input,
      payload: { labels: ['a', 'A'], id: s.featureId, entityType: 'feature' },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(s.probe.counts()).toEqual(before);
    expect(s.rowBy('features', s.featureId)).toMatchObject({ revision: 2 });
    // 同 commandId 不同参数 → conflict（idempotency_key_reuse），零写入。
    await expectPublicError(
      () => s.service.submit(s.owner, { ...input, payload: { entityType: 'feature', id: s.featureId, labels: ['other'] } }),
      { code: 'conflict', operation: 'plan.labels.update', reason: 'idempotency_key_reuse' },
    );
    expect(s.probe.counts()).toEqual(before);
    expect(s.rowBy('features', s.featureId)).toMatchObject({ labels: JSON.stringify(['a']) });
  });

  it('跨进程真实竞争：同 revision 两路提交恰一个生效、全部子进程核验退出', async () => {
    const s = await setup();
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f007-race-' });
    const outcomes = await runBarrierChildren(environment, {
      scriptPath: fileURLToPath(new URL('../../helpers/p02-2/atomic-command-child.ts', import.meta.url)),
      configs: [
        s.labelsEnvelope('feature', s.featureId, ['race-x'], 1),
        s.labelsEnvelope('feature', s.featureId, ['race-y'], 1),
      ].map(envelope => ({ dbPath: s.box.dbPath, envelope, now: NOW })),
      readyTimeoutMs: 10_000,
      resultTimeoutMs: 10_000,
    });
    const results = outcomes.map(outcome => outcome.result);
    const receipts = results.map(result => result.receipt as CommandReceipt);
    expect(receipts.map(receipt => receipt.status).sort()).toEqual(['completed', 'rejected']);
    const loser = receipts.find(receipt => receipt.status === 'rejected')!;
    expect(rejectedError(loser).details).toMatchObject({
      reason: 'conflict',
      entityType: 'feature',
      expectedRevision: 1,
      actualRevision: 2,
    });
    // 持久副作用恰一次：revision=2、恰一条标签事件、两条回执。
    expect(s.rowBy('features', s.featureId)).toMatchObject({ revision: 2 });
    expect(
      s.probe.stateEvents().filter(event => event.event_type === 'feature.labels.updated'),
    ).toHaveLength(1);
    expect(s.tableCount('command_receipts')).toBe(7);
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow();
    }
    expect(environment.evidence.serialize()).toContain('child.exit');
  }, 30_000);
});

describe('F-007 拒绝矩阵（非法输入/跨项目/缺能力均不写业务数据）', () => {
  it('非法标签与混入需求/依赖/状态字段 → invalid_input 定位 payload.* 且零写入', async () => {
    const s = await setup();
    const before = s.probe.counts();
    await expectPublicError(
      () => s.service.submit(s.owner, s.labelsEnvelope('task', 't-1', ['  '], 1)),
      { code: 'invalid_input', operation: 'plan.labels.update', field: 'payload.labels[0]' },
    );
    await expectPublicError(
      () => s.service.submit(s.owner, s.labelsEnvelope('task', 't-1', ['x'.repeat(65)], 1)),
      { code: 'invalid_input', operation: 'plan.labels.update', field: 'payload.labels[0]' },
    );
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.labelsEnvelope('task', 't-1', Array.from({ length: 51 }, (_v, i) => `l${i}`), 1),
        ),
      { code: 'invalid_input', operation: 'plan.labels.update', field: 'payload.labels' },
    );
    for (const [key, value] of [
      ['requirementsRefs', []],
      ['dependsOn', ['t-2']],
      ['acceptance', { criteria: ['x'] }],
      ['status', 'passed'],
      ['planStatus', 'approved'],
      ['title', '改标题'],
      ['expectedRevision', 1],
    ] as const) {
      await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.labelsEnvelope('task', 't-1', ['ok'], 1, {
              payload: { entityType: 'task', id: 't-1', labels: ['ok'], [key]: value },
            }),
          ),
        { code: 'invalid_input', operation: 'plan.labels.update', field: `payload.${key}` },
      );
    }
    // 一切非法尝试零业务写入、零事件、零回执。
    expect(s.probe.counts()).toEqual(before);
    expect(s.rowBy('tasks', 't-1')).toMatchObject({ labels: JSON.stringify(['core']), revision: 1 });
  });

  it('跨项目目标/不存在目标/不可见项目/缺能力均拒绝且零写入', async () => {
    const s = await setup();
    const before = s.probe.counts();
    // 跨项目目标：scope 为项目 B，目标属于项目 A → forbidden（ownership_denied）。
    for (const [entityType, id] of [
      ['phase', 'phase-1'],
      ['feature', s.featureId],
      ['task', 't-1'],
    ] as const) {
      await expectPublicError(
        () =>
          s.service.submit(s.owner, {
            ...s.labelsEnvelope(entityType, id, ['x'], 1),
            scope: { kind: 'project', projectId: s.projectBId },
          }),
        { code: 'forbidden', operation: 'plan.labels.update', reason: 'ownership_denied' },
      );
    }
    // 不存在目标 → not_found。
    await expectPublicError(
      () => s.service.submit(s.owner, s.labelsEnvelope('task', 'no-such-task', ['x'], 1)),
      { code: 'not_found', operation: 'plan.labels.update' },
    );
    // 不可见/不存在项目统一 forbidden（project_not_visible，不泄漏存在性）。
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['plan.labels.write'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    await expectPublicError(
      () => s.service.submit(outsider, s.labelsEnvelope('phase', 'phase-1', ['x'], 1)),
      { code: 'forbidden', operation: 'plan.labels.update', reason: 'project_not_visible' },
    );
    await expectPublicError(
      () =>
        s.service.submit(s.owner, {
          ...s.labelsEnvelope('phase', 'phase-1', ['x'], 1),
          scope: { kind: 'project', projectId: randomUUID() },
        }),
      { code: 'forbidden', operation: 'plan.labels.update', reason: 'project_not_visible' },
    );
    // 缺 plan.labels.write 能力 → capability_denied；恰切能力受限主体可编辑。
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(
      () => s.service.submit(noCapability, s.labelsEnvelope('phase', 'phase-1', ['x'], 1)),
      { code: 'forbidden', operation: 'plan.labels.update', reason: 'capability_denied' },
    );
    expect(s.probe.counts()).toEqual(before);
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['plan.labels.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    expect(
      await s.service.submit(authorized, s.labelsEnvelope('phase', 'phase-1', ['scoped'], 1)),
    ).toMatchObject({ status: 'completed', replayed: false });
    expect(s.rowBy('phases', 'phase-1')).toMatchObject({ labels: JSON.stringify(['scoped']), revision: 2 });
  });

  it.each([
    ['featuresBeforeUpdate' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚（无半成功标签编辑），撤除后同信封重试成功', async point => {
    const s = await setup();
    const input = s.labelsEnvelope('feature', s.featureId, ['faulty'], 1);
    const before = s.probe.counts();
    const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'plan.labels.update' });
    expect(JSON.stringify((error as PublicError).toErrorShape())).not.toMatch(
      /SQL|injected|TRIGGER|shiploop-f007/i,
    );
    // 整组回滚：labels/revision/事件/回执全部原样。
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      labels: JSON.stringify(['plan']),
      revision: 1,
    });
    expect(s.probe.counts()).toEqual(before);
    fault.remove();
    expect(await s.service.submit(s.owner, input)).toMatchObject({
      status: 'completed',
      replayed: false,
    });
    expect(s.rowBy('features', s.featureId)).toMatchObject({
      labels: JSON.stringify(['faulty']),
      revision: 2,
    });
    expect(
      s.probe.stateEvents().filter(event => event.event_type === 'feature.labels.updated'),
    ).toHaveLength(1);
  });
});
