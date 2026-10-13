/**
 * P03-1 / F-004：已注册项目下最小 Phase 创建命令（phase.create）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针，不以方法调用或日志
 * 代替业务状态）：
 * - 可信且获准主体创建含稳定 ID、title、description、labels 的 open Phase；
 *   Phase + phase.created 脱敏事件 + completed 回执同一 BEGIN IMMEDIATE 持久化，
 *   重开数据库后仍可读取；
 * - 沿用命令信封、服务端 requestDigest、能力白名单与事务内权限重核：同
 *   commandId 同参数返回原结果且零新增实体/事件，不同参数冲突；重复业务 ID、
 *   非法元数据、不可见或不存在的项目按既有公开错误约定拒绝；
 * - 请求不能指定可信主体、批准或执行结果（未知键严格拒绝）；新建 Phase 不执行
 *   仓库脚本、不创建执行实体、不实现关闭/重开/归档生命周期；
 * - 写入故障（业务/事件/回执三个边界）整组回滚，不留半成功状态。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import { PHASE_CREATED_EVENT_TYPE, mapStateEvent } from '../packages/core/src/ports/events.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import {
  createCommandsTestFixture,
  WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

let fixture: CommandsTestFixture | undefined;
afterEach(async () => {
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

interface PhaseCreateResult {
  readonly phase: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string | null;
    readonly labels: readonly string[];
    readonly status: string;
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

function completedResult(receipt: CommandReceipt): PhaseCreateResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as PhaseCreateResult;
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
    (value) => {
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
  // 公开错误不回显输入正文、SQL 或堆栈。
  expect(JSON.stringify(error.toErrorShape())).not.toMatch(
    /SQL|TRIGGER|injected|stack|shiploop-f004/i,
  );
  return error;
}

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f004-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    nowUtcMs: () => now,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();

  const registerInput = {
    schemaVersion: 5,
    commandId: randomUUID(),
    operation: 'project.register',
    scope: { kind: 'registration' },
    issuedAt: NOW_ISO,
    payload: {
      repositoryPath: box.repoDirA,
      displayName: 'Repo A',
      description: null,
      labels: [],
    },
  };
  const registered = await service.submit(owner, registerInput);
  if (registered.status !== 'completed' || registered.result === null) {
    throw new Error('夹具注册失败（expected completed project.register）');
  }
  const projectId = (registered.result as { project: { id: string } }).project.id;

  const phaseEnvelope = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5,
    commandId: randomUUID(),
    operation: 'phase.create',
    scope: { kind: 'project', projectId },
    issuedAt: NOW_ISO,
    payload: {
      id: 'phase-1',
      title: '第一阶段',
      description: '阶段说明',
      labels: [' Team ', 'team', 'core'],
    },
    ...changes,
  });

  const phaseCounts = () =>
    probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM phases')?.n ?? -1;
  const executionCounts = () => ({
    baselineOperations: probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_operations',
    )?.n ?? -1,
    baselineCheckResults: probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_check_results',
    )?.n ?? -1,
    baselineAuthorizations: probe.selectOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM baseline_authorizations',
    )?.n ?? -1,
  });

  return {
    box,
    harness,
    service,
    probe,
    owner,
    projectId,
    phaseEnvelope,
    phaseCounts,
    executionCounts,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('F-004 phase.create 创建闭环', () => {
  it('创建 open Phase：Phase + phase.created 脱敏事件 + completed 回执同事务持久化，重开库后可读取', async () => {
    const s = await setup();
    const input = s.phaseEnvelope();
    const receipt = await s.service.submit(s.owner, input);
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: 'phase.create',
      scope: { kind: 'project', projectId: s.projectId },
      issuedAt: NOW_ISO,
      completedAt: NOW_ISO,
    });
    const phase = completedResult(receipt).phase;
    expect(phase).toEqual({
      id: 'phase-1',
      projectId: s.projectId,
      title: '第一阶段',
      description: '阶段说明',
      labels: ['team', 'core'],
      status: 'open',
      revision: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    // 持久状态与结果一致（独立只读探针）：Phase 行 + 事件 + 回执同事务落库。
    expect(s.phaseCounts()).toBe(1);
    const row = s.probe.selectOne<Record<string, string | number | null>>(
      'SELECT id, project_id, title, description, labels, status, revision FROM phases WHERE id = ?',
      ['phase-1'],
    );
    expect(row).toMatchObject({
      id: 'phase-1',
      project_id: s.projectId,
      title: '第一阶段',
      description: '阶段说明',
      labels: JSON.stringify(['team', 'core']),
      status: 'open',
      revision: 1,
    });
    expect(s.probe.counts()).toMatchObject({ state_events: 2, command_receipts: 2 });
    const events = s.probe.stateEvents();
    expect(events).toHaveLength(2);
    const phaseEvent = events[1]!;
    expect(phaseEvent).toMatchObject({
      project_id: s.projectId,
      sequence: 2,
      event_type: PHASE_CREATED_EVENT_TYPE,
      aggregate_type: 'phase',
      aggregate_id: 'phase-1',
      aggregate_revision: 1,
      payload: '{"created":true}',
    });
    // 事件经公开映射复核（白名单形状、scope/aggregate 一致）。
    expect(
      mapStateEvent({
        id: phaseEvent.id,
        sequence: phaseEvent.sequence,
        eventType: phaseEvent.event_type,
        aggregateType: phaseEvent.aggregate_type,
        aggregateId: phaseEvent.aggregate_id,
        aggregateRevision: phaseEvent.aggregate_revision,
        projectId: phaseEvent.project_id,
        payload: JSON.parse(phaseEvent.payload as string),
        occurredAtUtcMs: phaseEvent.occurred_at,
      }),
    ).toEqual({
      schemaVersion: 1,
      eventId: phaseEvent.id,
      sequence: 2,
      type: 'phase.created',
      scope: { kind: 'project', projectId: s.projectId },
      aggregate: { type: 'phase', id: 'phase-1', revision: 1 },
      occurredAt: NOW_ISO,
      payload: { created: true },
    });
    // 重开数据库后仍可读取（真实 Core 装配重新打开同一数据根）。
    const reopened = await s.box.openApplication();
    expect(
      await reopened.commandReceiptsService.getReceipt(s.owner, input.commandId),
    ).toEqual({ ...receipt, replayed: false });
    expect(
      s.probe.selectOne<{ id: string }>('SELECT id FROM phases WHERE id = ?', ['phase-1'])?.id,
    ).toBe('phase-1');
  });

  it('稳定 ID 语义：显式稳定 ID 原样保存并重复拒绝；省略时服务端生成 UUID v4', async () => {
    const s = await setup();
    const explicit = await s.service.submit(s.owner, s.phaseEnvelope());
    expect(completedResult(explicit).phase.id).toBe('phase-1');
    const generated = await s.service.submit(
      s.owner,
      s.phaseEnvelope({
        commandId: randomUUID(),
        payload: { title: '自动 ID 阶段' },
      }),
    );
    const generatedId = completedResult(generated).phase.id;
    expect(generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(s.phaseCounts()).toBe(2);
  });

  it('同 commandId 同参数重放复用原结果且零新增实体/事件；不同参数冲突且零写入', async () => {
    const s = await setup();
    const input = s.phaseEnvelope();
    const first = await s.service.submit(s.owner, input);
    const before = s.probe.counts();
    // 同 commandId 同参数（键序/大小写/空白/重复标签形态不同但规范化后等价）→ 原结果。
    const replay = await s.service.submit(s.owner, {
      ...input,
      payload: {
        labels: ['TEAM', 'team', 'core', 'CORE'],
        description: '阶段说明',
        title: '第一阶段',
        id: 'phase-1',
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(s.probe.counts()).toEqual(before);
    expect(s.phaseCounts()).toBe(1);
    // 同 commandId 不同参数 → conflict（idempotency_key_reuse），零写入。
    await expectPublicError(
      () =>
        s.service.submit(s.owner, {
          ...input,
          payload: { id: 'phase-1', title: '另一个标题' },
        }),
      { code: 'conflict', operation: 'phase.create', reason: 'idempotency_key_reuse' },
    );
    expect(s.probe.counts()).toEqual(before);
    expect(s.phaseCounts()).toBe(1);
  });

  it('重复业务 ID 固化 rejected（conflict），不覆盖既有 Phase、不写事件', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.phaseEnvelope());
    const before = s.probe.counts();
    const duplicateInput = s.phaseEnvelope({ payload: { id: 'phase-1', title: '重复标题' } });
    const duplicate = await s.service.submit(s.owner, duplicateInput);
    const error = rejectedError(duplicate);
    expect(error.code).toBe('conflict');
    expect(error.details?.reason).toBe('phase_already_exists');
    expect(error.details?.entityType).toBe('phase');
    // rejected 回执持久化；业务行与事件零新增，既有 Phase 不被覆盖。
    expect(s.probe.counts()).toEqual({
      ...before,
      command_receipts: (before.command_receipts ?? 0) + 1,
    });
    expect(s.phaseCounts()).toBe(1);
    expect(
      s.probe.selectOne<{ title: string }>('SELECT title FROM phases WHERE id = ?', ['phase-1'])
        ?.title,
    ).toBe('第一阶段');
    // 同 commandId 重放返回同一 rejected 回执。
    expect(await s.service.submit(s.owner, duplicateInput)).toEqual({
      ...duplicate,
      replayed: true,
    });
  });

  it('非法元数据、payload 内提权/执行字段与 expectedRevision 均拒绝且零写入', async () => {
    const s = await setup();
    const expectBaselineCounts = (): void =>
      expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
    // 非法元数据（标题/描述/标签）定位到 payload 字段。
    await expectPublicError(
      () => s.service.submit(s.owner, s.phaseEnvelope({ payload: { id: 'p', title: '   ' } })),
      { code: 'invalid_input', operation: 'phase.create', field: 'payload.title' },
    );
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.phaseEnvelope({ payload: { id: 'p', title: 't', description: 'x'.repeat(10_001) } }),
        ),
      { code: 'invalid_input', operation: 'phase.create', field: 'payload.description' },
    );
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.phaseEnvelope({ payload: { id: 'p', title: 't', labels: ['x'.repeat(65)] } }),
        ),
      { code: 'invalid_input', operation: 'phase.create' },
    );
    // 提权/批准/执行结果/状态字段一律未知键拒绝（请求不能指定可信主体或结果）。
    for (const forbiddenKey of [
      'principalId',
      'capabilities',
      'projectScope',
      'approved',
      'status',
      'revision',
      'expectedRevision',
      'projectId',
      'executionResult',
    ]) {
      await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.phaseEnvelope({ payload: { id: 'p', title: 't', [forbiddenKey]: 'x' } }),
          ),
        { code: 'invalid_input', operation: 'phase.create', field: `payload.${forbiddenKey}` },
      );
    }
    // 创建类命令不允许携带 expectedRevision（信封层拒绝）。
    await expectPublicError(
      () => s.service.submit(s.owner, s.phaseEnvelope({ expectedRevision: 1 })),
      { code: 'invalid_input', operation: 'phase.create', field: 'expectedRevision' },
    );
    expectBaselineCounts();
    expect(s.phaseCounts()).toBe(0);
  });

  it('不可见或不存在的项目统一拒绝；缺 phase.write 能力 forbidden；恰切获准主体可创建', async () => {
    const s = await setup();
    // 不可见项目：有能力也 forbidden（与不存在不可区分，不泄漏 projectId）。
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['phase.write'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const invisibleError = await expectPublicError(
      () => s.service.submit(outsider, s.phaseEnvelope()),
      { code: 'forbidden', operation: 'phase.create', reason: 'project_not_visible' },
    );
    expect(JSON.stringify(invisibleError.toErrorShape())).not.toContain(s.projectId);
    // 缺 phase.write 能力：capability_denied。
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => s.service.submit(noCapability, s.phaseEnvelope()), {
      code: 'forbidden',
      operation: 'phase.create',
      reason: 'capability_denied',
    });
    // 不存在的项目与不可见同样拒绝。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.phaseEnvelope({ scope: { kind: 'project', projectId: randomUUID() } }),
        ),
      { code: 'forbidden', operation: 'phase.create', reason: 'project_not_visible' },
    );
    // 恰切获准的受限主体可创建（能力 + 可见范围）。
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['phase.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    const receipt = await s.service.submit(authorized, s.phaseEnvelope());
    expect(receipt).toMatchObject({ status: 'completed', replayed: false });
    expect(completedResult(receipt).phase.projectId).toBe(s.projectId);
    // 失败尝试零写入；成功恰一次。
    expect(s.phaseCounts()).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 2, command_receipts: 2 });
  });

  it.each([
    ['phasesBeforeInsert' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚，撤除后相同信封重试成功', async point => {
    const s = await setup();
    const input = s.phaseEnvelope();
    const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'phase.create' });
    expect(JSON.stringify((error as PublicError).toErrorShape())).not.toMatch(
      /SQL|injected|TRIGGER|shiploop-f004/i,
    );
    // 整组回滚：无孤立 Phase/事件/回执（注册产物保持不变）。
    expect(s.phaseCounts()).toBe(0);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
    fault.remove();
    // 撤除故障后相同信封（同一 commandId）重试成功：不产生重复副作用语义。
    expect(await s.service.submit(s.owner, input)).toMatchObject({
      status: 'completed',
      replayed: false,
    });
    expect(s.phaseCounts()).toBe(1);
    expect(s.probe.counts()).toMatchObject({ state_events: 2, command_receipts: 2 });
  });

  it('新建 Phase 不执行仓库脚本、不创建执行实体，结果不声称批准或可执行', async () => {
    const s = await setup();
    const receipt = await s.service.submit(s.owner, s.phaseEnvelope());
    const result = completedResult(receipt);
    // 结果只含 Phase 事实；不出现批准/执行/基线语义。
    expect(Object.keys(result)).toEqual(['phase']);
    expect(JSON.stringify(result)).not.toMatch(/approved|approval|executable|batch|attempt/i);
    // 不创建任何执行实体（基线授权/操作/检查均为零）。
    expect(s.executionCounts()).toEqual({
      baselineAuthorizations: 0,
      baselineOperations: 0,
      baselineCheckResults: 0,
    });
    // 执行域表由 P03-3 / F-002 迁移 v9 建立但为空；本命令不创建执行实体
    // （attempts 等后续表仍未建立；计划导入/执行不在本 Feature）。
    expect(s.probe.tableExists('runs')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 0 }]);
    expect(s.probe.tableExists('attempts')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM attempts')).toEqual([{ n: 0 }]);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual([{ n: 0 }]);
    expect(s.probe.tableExists('execution_batches')).toBe(true);
    expect(s.probe.selectAll('SELECT COUNT(*) AS n FROM execution_batches')).toEqual([{ n: 0 }]);
  });
});
