/**
 * P03-2 / F-002：绑定当前 planDigest 的计划批准/拒绝决策命令
 * （feature.plan.decide）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针与重开查询，不以方法
 * 调用或日志代替业务状态）：
 * - 可信主体提交目标 Feature、当前 planDigest 与 approve/reject 后，同一短写
 *   事务内提交决策记录（主体摘要/decisionActor/UTC 决策时间/适用原因/可查询
 *   状态）、Feature plan_status 与 revision、脱敏事件与 completed 回执；
 *   decisionActor 恒为提交主体 principalId（请求不能伪造身份）；
 * - 批准只确认现有计划：保留全部既有 Task ID、依赖边、完整策略副本与来源，
 *   绝不重建 Task 或按当前默认值覆盖副本；批准使当前计划可作为后续显式执行
 *   授权的依据（planStatus=approved），拒绝不提供该依据（planStatus=draft）；
 *   两种决策都不创建 Batch/Run/Attempt、不调用 Runtime、不启动 Git 或检查进程；
 * - fail-closed 拒绝矩阵：缺审批能力、跨项目请求、缺失目标、失效 planDigest、
 *   空任务不可执行计划、重复竞争决策、陈旧 revision 均明确拒绝且零业务写入；
 *   两个竞争决定最多一个生效，失败不留下半条有效批准；
 * - 幂等：既有 commandId 重放复用原回执并重核当前权限，异参复用 conflict；
 *   持久化故障（Feature 更新/决策记录插入/事件/回执注入点）整组回滚；
 * - 查询能区分当前决定与历史决定（按 planDigest 绑定），不把拒绝显示为已批准
 *   （feature.planStatus 权威）；重开真实库后决策状态一致；
 * - 迁移接续：v5/v6/v7 前序库升级到 v9（P03-3 / F-002 起接续 v9 执行域三表）
 *   保留既有数据、事件水位与历史 checksum，空库全量迁移记录 v1..v9。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
import { mapStateEvent } from '../packages/core/src/ports/events.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import type { TrustedPrincipal } from '../packages/core/src/ports/authorization.js';
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
  return error;
}

/** 三 Task 链计划（t-1 ← t-2 ← t-3）。 */
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

interface DecideSetup {
  readonly box: CommandsTestFixture;
  readonly harness: Awaited<ReturnType<CommandsTestFixture['openTransactionalHarness']>>;
  readonly service: CommandService;
  readonly probe: ReturnType<CommandsTestFixture['openProbe']>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
  readonly projectId: string;
  readonly projectBId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly featureRevision: () => number;
  readonly decideEnvelope: (
    changes?: Record<string, unknown>,
    decision?: 'approve' | 'reject',
    featureId?: string,
    planDigest?: string,
    reason?: string | null,
  ) => Record<string, unknown>;
  readonly counts: () => Record<string, number>;
  readonly tableCount: (table: string) => number;
  readonly featureRow: (featureId?: string) => Record<string, unknown> | undefined;
  readonly lastEvent: () => Record<string, unknown> | undefined;
}

async function setup(options: { withFeatureInB?: boolean } = {}): Promise<DecideSetup> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p032-f002-' });
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
  if (projectSettings.status !== 'completed') {
    throw new Error('夹具项目配置失败');
  }

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
  const importedFeature = (imported.result as { feature: { id: string; planDigest: string } }).feature;
  const featureId = importedFeature.id;
  const planDigest = importedFeature.planDigest;

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

  const decideEnvelope = (
    changes: Record<string, unknown> = {},
    decision: 'approve' | 'reject' = 'approve',
    targetFeatureId: string = featureId,
    digest: string = planDigest,
    reason: string | null = null,
  ) => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'feature.plan.decide' as const,
    scope: { kind: 'project', projectId },
    expectedRevision: 1,
    payload: {
      featureId: targetFeatureId,
      planDigest: digest,
      decision,
      ...(reason === null ? {} : { reason }),
    },
    ...changes,
  });

  const tableCount = (table: string): number =>
    probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;
  const counts = () => ({ ...probe.counts() }) as Record<string, number>;
  const featureRowOf = (targetFeatureId: string = featureId): Record<string, unknown> | undefined =>
    probe.selectOne<Record<string, unknown>>('SELECT * FROM features WHERE id = ?', [targetFeatureId]) as
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
    planDigest,
    featureRevision: () => featureRowOf()?.revision as number,
    decideEnvelope,
    counts,
    tableCount,
    featureRow: featureRowOf,
    lastEvent,
  };
}

describe('F-002 决策闭环（正常路径）', () => {
  it('批准：决策记录/planStatus/revision/事件/回执同一短写事务提交，decisionActor 为提交主体', async () => {
    const s = await setup();
    const before = s.counts();
    const receipt = await s.service.submit(s.owner, s.decideEnvelope({}, 'approve', s.featureId, s.planDigest, '同意执行'));
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: 'feature.plan.decide',
      scope: { kind: 'project', projectId: s.projectId },
    });
    if (receipt.status !== 'completed' || receipt.result === null) {
      throw new Error('expected completed');
    }
    const result = receipt.result as {
      feature: { planStatus: string; revision: number; planDigest: string };
      decision: string;
      approval: { status: string; decisionActor: string; reason: string | null; subjectDigest: string; current: boolean };
    };
    expect(result.feature.planStatus).toBe('approved');
    expect(result.feature.revision).toBe(2);
    expect(result.feature.planDigest).toBe(s.planDigest);
    expect(result.decision).toBe('approve');
    expect(result.approval).toMatchObject({
      status: 'approved',
      decisionActor: 'local-owner',
      reason: '同意执行',
      subjectDigest: s.planDigest,
      current: true,
    });

    // 独立只读探针：决策记录行完整（主体摘要/决策人/UTC 决策时间/原因/状态）。
    expect(s.probe.selectAll('SELECT * FROM approvals')).toEqual([
      expect.objectContaining({
        project_id: s.projectId,
        subject_type: 'feature_plan',
        subject_id: s.featureId,
        subject_digest: s.planDigest,
        status: 'approved',
        decision_actor: 'local-owner',
        reason: '同意执行',
        decided_at: NOW,
        revision: 1,
      }),
    ]);
    // Feature：只更新 plan_status/revision/updated_at；plan_digest 保持。
    expect(s.featureRow()).toMatchObject({
      revision: 2,
      plan_status: 'approved',
      plan_digest: s.planDigest,
      status: 'draft',
    });
    // 脱敏事件：feature.plan.approved，聚合 Feature 自身，payload 恒 {approved:true}。
    expect(s.lastEvent()).toMatchObject({
      event_type: 'feature.plan.approved',
      aggregate_type: 'feature',
      aggregate_id: s.featureId,
      aggregate_revision: 2,
      project_id: s.projectId,
      payload: JSON.stringify({ approved: true }),
    });
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 1,
    });
    expect(s.tableCount('approvals')).toBe(1);
    // 不创建任何执行实体（P03-3 / F-002 起执行域表已由迁移 v9 建立但为空，
    // 能力边界宣告而非查询兜底；attempts 等后续表仍未建立）。
    expect(s.probe.tableExists('execution_batches')).toBe(true);
    expect(s.tableCount('execution_batches')).toBe(0);
    expect(s.probe.tableExists('runs')).toBe(true);
    expect(s.tableCount('runs')).toBe(0);
    expect(s.probe.tableExists('attempts')).toBe(false);
  });

  it('拒绝：记录 rejected、planStatus 落 draft（不提供执行依据）、feature.plan.rejected 事件', async () => {
    const s = await setup();
    const before = s.counts();
    const receipt = await s.service.submit(
      s.owner,
      s.decideEnvelope({}, 'reject', s.featureId, s.planDigest, '需求范围不清'),
    );
    expect(receipt).toMatchObject({ status: 'completed' });
    expect(s.probe.selectAll('SELECT * FROM approvals')).toEqual([
      expect.objectContaining({ status: 'rejected', decision_actor: 'local-owner', reason: '需求范围不清' }),
    ]);
    expect(s.featureRow()).toMatchObject({ revision: 2, plan_status: 'draft', plan_digest: s.planDigest });
    expect(s.lastEvent()).toMatchObject({
      event_type: 'feature.plan.rejected',
      aggregate_type: 'feature',
      aggregate_id: s.featureId,
      aggregate_revision: 2,
      payload: JSON.stringify({ rejected: true }),
    });
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 1,
    });
  });

  it('原因可省略（null 入库）；信封纪律：payload 混入身份/状态字段一律未知键拒绝', async () => {
    const s = await setup();
    const before = s.counts();
    const receipt = await s.service.submit(s.owner, s.decideEnvelope({}, 'approve', s.featureId, s.planDigest));
    expect(receipt.status).toBe('completed');
    expect(s.probe.selectAll('SELECT * FROM approvals')[0]).toMatchObject({ reason: null });
    for (const [key, value] of [
      ['decisionActor', 'attacker'],
      ['actorId', 'attacker'],
      ['principalId', 'attacker'],
      ['status', 'approved'],
      ['planStatus', 'approved'],
      ['revision', 5],
    ] as const) {
      await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.decideEnvelope(
              { payload: { featureId: s.featureId, planDigest: s.planDigest, decision: 'approve', [key]: value } },
            ),
          ),
        { code: 'invalid_input', operation: 'feature.plan.decide', field: `payload.${key}` },
      );
    }
    // 非法 decision / 非法摘要 / 超长原因。
    await expectPublicError(
      () => s.service.submit(s.owner, s.decideEnvelope({}, 'withdraw' as 'approve')),
      { code: 'invalid_input', operation: 'feature.plan.decide', field: 'payload.decision' },
    );
    await expectPublicError(
      () => s.service.submit(s.owner, s.decideEnvelope({}, 'approve', s.featureId, 'not-a-digest')),
      { code: 'invalid_input', operation: 'feature.plan.decide', field: 'payload.planDigest' },
    );
    await expectPublicError(
      () => s.service.submit(s.owner, s.decideEnvelope({}, 'approve', s.featureId, s.planDigest, 'x'.repeat(2001))),
      { code: 'invalid_input', operation: 'feature.plan.decide', field: 'payload.reason' },
    );
    expect(s.tableCount('approvals')).toBe(1);
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 1,
    });
  });
});

describe('F-002 批准保留既有计划（不重建 Task）', () => {
  it('批准前后 Task ID/依赖/完整策略与来源逐字段不变（含编辑过的策略副本）', async () => {
    const s = await setup();
    // 决策前对 t-2 做一次显式策略编辑（task_edit 来源），验证批准不按当前默认值覆盖。
    const edited = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'task.strategy.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      payload: {
        taskId: 't-2',
        executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' },
      },
    });
    expect(edited.status).toBe('completed');

    const tasksBefore = s.probe.selectAll('SELECT * FROM tasks ORDER BY id');
    const depsBefore = s.probe.selectAll('SELECT * FROM task_dependencies ORDER BY task_id, depends_on_id');
    // Task 策略编辑不触碰 Feature 聚合 revision（仍为 1）。
    expect(s.featureRow()).toMatchObject({ revision: 1 });
    const receipt = await s.service.submit(s.owner, s.decideEnvelope({ expectedRevision: 1 }, 'approve'));
    expect(receipt.status).toBe('completed');
    // Task 行逐字段一致（含 revision——批准不触碰 Task 聚合）。
    expect(s.probe.selectAll('SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
    expect(s.probe.selectAll('SELECT * FROM task_dependencies ORDER BY task_id, depends_on_id')).toEqual(depsBefore);
    expect(tasksBefore[1]).toMatchObject({
      config_source: 'task_edit',
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet-2',
      }),
    });
  });
});

describe('F-002 拒绝矩阵（fail-closed 零业务写入）', () => {
  it('缺审批能力 forbidden；不可见项目 forbidden（不泄漏存在性）；恰切获准主体可决策', async () => {
    const s = await setup();
    const before = s.counts();
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['plan.labels.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => s.service.submit(noCapability, s.decideEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.decide',
      reason: 'capability_denied',
    });
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.decide'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const invisibleError = await expectPublicError(() => s.service.submit(outsider, s.decideEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.decide',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(invisibleError.toErrorShape())).not.toContain(s.projectId);
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.decide'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    expect((await s.service.submit(authorized, s.decideEnvelope())).status).toBe('completed');
    expect(s.tableCount('approvals')).toBe(1);
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 1,
    });
  });

  it('跨项目目标 forbidden、缺失目标 not_found（不泄漏存在性）', async () => {
    const s = await setup({ withFeatureInB: true });
    const before = s.counts();
    const featureB = s.probe.selectOne<{ id: string }>(
      'SELECT id FROM features WHERE project_id = ?',
      [s.projectBId],
    )!;
    // 项目 A scope 决策项目 B 的计划：ownership → forbidden。
    await expectPublicError(() => s.service.submit(s.owner, s.decideEnvelope({}, 'approve', featureB.id)), {
      code: 'forbidden',
      operation: 'feature.plan.decide',
      reason: 'ownership_denied',
    });
    await expectPublicError(() => s.service.submit(s.owner, s.decideEnvelope({}, 'approve', 'f-missing')), {
      code: 'not_found',
      operation: 'feature.plan.decide',
    });
    expect(s.tableCount('approvals')).toBe(0);
    expect(s.counts()).toEqual(before);
  });

  it('失效 planDigest：修订后旧摘要决策固化 rejected 且零业务写入', async () => {
    const s = await setup();
    const before = s.counts();
    const staleDigest = s.planDigest;
    // 实质修订改变摘要（planStatus 规则由 F-008 覆盖）。
    const revised = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'feature.plan.revise',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      payload: {
        featureId: s.featureId,
        plan: {
          schemaVersion: 1,
          feature: { title: '示例 Feature', labels: [], sourceRefs: [] },
          tasks: [
            { id: 't-1', title: '任务一', acceptance: { criteria: ['任务一验收'] } },
            { id: 't-2', title: '任务二', acceptance: { criteria: ['任务二验收'] }, dependsOn: ['t-1'] },
            { id: 't-3', title: '任务三', acceptance: { criteria: ['任务三验收'] }, dependsOn: ['t-2'] },
          ],
        },
      },
    });
    expect(revised.status).toBe('completed');
    const newDigest = (s.featureRow()?.plan_digest as string);
    expect(newDigest).not.toBe(staleDigest);
    const afterRevise = s.counts();
    // 旧摘要 + 新 revision：digest_mismatch（先于 CAS）。
    const staleReceipt = await s.service.submit(
      s.owner,
      s.decideEnvelope({ expectedRevision: 2 }, 'approve', s.featureId, staleDigest),
    );
    expect(rejectedError(staleReceipt).details).toMatchObject({
      reason: 'plan_digest_mismatch',
      entityType: 'feature',
    });
    expect(s.tableCount('approvals')).toBe(0);
    expect(s.counts()).toEqual({ ...afterRevise, command_receipts: afterRevise.command_receipts + 1 });
    expect(before.state_events).toBe(afterRevise.state_events - 1);
  });

  it('空任务不可执行计划：批准与拒绝均固化 rejected（no_tasks）且零业务写入', async () => {
    const s = await setup();
    const emptyImported = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'feature.plan.import',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      payload: {
        phaseId: 'phase-1',
        plan: { schemaVersion: 1, feature: { title: '空计划' }, tasks: [] },
      },
    });
    if (emptyImported.status !== 'completed' || emptyImported.result === null) {
      throw new Error('expected empty plan import completed');
    }
    const emptyFeatureId = (emptyImported.result as { feature: { id: string } }).feature.id;
    const emptyDigest = (
      s.probe.selectOne<{ plan_digest: string }>('SELECT plan_digest FROM features WHERE id = ?', [emptyFeatureId])!
    ).plan_digest;
    const before = s.counts();
    for (const decision of ['approve', 'reject'] as const) {
      const receipt = await s.service.submit(
        s.owner,
        s.decideEnvelope({}, decision, emptyFeatureId, emptyDigest),
      );
      expect(rejectedError(receipt).details).toMatchObject({ reason: 'no_tasks', entityType: 'feature' });
    }
    expect(s.tableCount('approvals')).toBe(0);
    expect(s.counts()).toEqual({ ...before, command_receipts: before.command_receipts + 2 });
    expect(s.probe.selectOne<{ plan_status: string }>('SELECT plan_status FROM features WHERE id = ?', [emptyFeatureId]))
      .toMatchObject({ plan_status: 'draft' });
  });

  it('陈旧 revision：无决策摘要上固化 conflict（携带 expected/actual）', async () => {
    const s = await setup();
    const before = s.counts();
    // 纯标签编辑递增 Feature revision（摘要不变、无决策记录）。
    const labels = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'plan.labels.update',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 1,
      payload: { entityType: 'feature', id: s.featureId, labels: ['审批前'] },
    });
    expect(labels.status).toBe('completed');
    const stale = await s.service.submit(s.owner, s.decideEnvelope({ expectedRevision: 1 }));
    expect(rejectedError(stale).details).toMatchObject({
      reason: 'conflict',
      expectedRevision: 1,
      actualRevision: 2,
      entityType: 'feature',
    });
    expect(s.tableCount('approvals')).toBe(0);
    expect(s.counts()).toEqual({ ...before, state_events: before.state_events + 1, command_receipts: before.command_receipts + 2 });
  });

  it('重复竞争决策：同一摘要第二个决定（含反向决定）fail-closed；两个竞争决定最多一个生效', async () => {
    const s = await setup();
    const before = s.counts();
    const first = await s.service.submit(s.owner, s.decideEnvelope());
    expect(first.status).toBe('completed');
    // 竞争决定（同 revision 旧信封）：事务串行化后已见新状态，重复决策拒绝。
    const racing = await s.service.submit(s.owner, s.decideEnvelope());
    expect(rejectedError(racing).details).toMatchObject({
      reason: 'approval_already_decided',
      entityType: 'feature',
    });
    // 反向决定（新 revision）：同摘要仍至多一条决策。
    const opposite = await s.service.submit(s.owner, s.decideEnvelope({ expectedRevision: 2 }, 'reject'));
    expect(rejectedError(opposite).details).toMatchObject({
      reason: 'approval_already_decided',
      entityType: 'feature',
    });
    expect(s.tableCount('approvals')).toBe(1);
    expect(s.featureRow()).toMatchObject({ revision: 2, plan_status: 'approved' });
    expect(s.probe.selectAll('SELECT * FROM approvals')[0]).toMatchObject({ status: 'approved' });
    expect(s.counts()).toEqual({
      ...before,
      state_events: before.state_events + 1,
      command_receipts: before.command_receipts + 3,
    });
  });
});

describe('F-002 原子性与幂等', () => {
  it.each([
    ['featuresBeforeUpdate' as const],
    ['approvalsBeforeInsert' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚：无半条有效批准，撤除后重试成功', async point => {
    const s = await setup();
    const input = s.decideEnvelope();
    const before = { counts: s.counts(), feature: s.featureRow() };
    const faultHandle = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'feature.plan.decide' });
    // 整组回滚：批准状态/事件/成功回执全部不存在，无半条有效批准。
    expect(s.featureRow()).toEqual(before.feature);
    expect(s.tableCount('approvals')).toBe(0);
    expect(s.counts()).toEqual(before.counts);
    faultHandle.remove();
    // 撤除故障后相同信封（同一 commandId）重试成功。
    const retried = await s.service.submit(s.owner, input);
    expect(retried).toMatchObject({ status: 'completed', replayed: false });
    expect(s.featureRow()).toMatchObject({ revision: 2, plan_status: 'approved' });
    expect(s.tableCount('approvals')).toBe(1);
  });

  it('同 commandId 同参数重放返回原回执且零新增写入；异参复用 conflict', async () => {
    const s = await setup();
    const input = s.decideEnvelope();
    const first = await s.service.submit(s.owner, input);
    expect(first.status).toBe('completed');
    const before = s.counts();
    const replayed = await s.service.submit(s.owner, input);
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(s.counts()).toEqual(before);
    const commandId = (input as { commandId: string }).commandId;
    await expectPublicError(
      () => s.service.submit(s.owner, s.decideEnvelope({ commandId }, 'reject')),
      { code: 'conflict', operation: 'feature.plan.decide', reason: 'idempotency_key_reuse' },
    );
    expect(s.counts()).toEqual(before);
  });

  it('重放重核当前权限：能力被撤销的同主体重放被拒绝，不返回原回执', async () => {
    const s = await setup();
    const principalId = 'decide-replay-principal';
    const capable: TrustedPrincipal = Object.freeze({
      principalId,
      capabilities: new Set(['feature.plan.decide' as const]),
      projectScope: Object.freeze({ kind: 'allowlist', projectIds: Object.freeze([s.projectId]) }),
    });
    const input = s.decideEnvelope();
    const first = await s.service.submit(capable, input);
    expect(first.status).toBe('completed');
    const revoked: TrustedPrincipal = Object.freeze({
      principalId,
      capabilities: new Set(['plan.labels.write' as const]),
      projectScope: Object.freeze({ kind: 'allowlist', projectIds: Object.freeze([s.projectId]) }),
    });
    await expectPublicError(() => s.service.submit(revoked, input), {
      code: 'forbidden',
      operation: 'feature.plan.decide',
      reason: 'capability_denied',
    });
    // 权限恢复后同一信封重放返回原回执（复用原决策，不重复决策）。
    const replayed = await s.service.submit(capable, input);
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(s.tableCount('approvals')).toBe(1);
  });
});

describe('F-002 决策查询（当前 vs 历史、不把拒绝显示为已批准、重开一致）', () => {
  it('features.approvals 区分当前决定与历史决定；拒绝绝不显示为已批准', async () => {
    const s = await setup();
    const app = await s.box.openApplication();
    // 初始：无决策。
    const initial = await app.queryService.getFeatureApprovals(s.owner, s.featureId);
    expect(initial.feature).toMatchObject({ id: s.featureId, planStatus: 'draft', planDigest: s.planDigest });
    expect(initial.currentDecision).toBeNull();
    expect(initial.decisions).toEqual([]);

    // 批准 digestA → 修订（digestB，planStatus 回 draft）→ 拒绝 digestB。
    expect((await s.service.submit(s.owner, s.decideEnvelope({}, 'approve'))).status).toBe('completed');
    const digestA = s.planDigest;
    const revised = await s.service.submit(s.owner, {
      schemaVersion: 5,
      issuedAt: NOW_ISO,
      commandId: randomUUID(),
      operation: 'feature.plan.revise',
      scope: { kind: 'project', projectId: s.projectId },
      expectedRevision: 2,
      payload: {
        featureId: s.featureId,
        plan: {
          schemaVersion: 1,
          feature: { title: '示例 Feature', labels: [], sourceRefs: [] },
          tasks: [
            { id: 't-1', title: '任务一', acceptance: { criteria: ['任务一验收'] } },
            { id: 't-2', title: '任务二', acceptance: { criteria: ['任务二验收'] }, dependsOn: ['t-1'] },
            { id: 't-3', title: '任务三', acceptance: { criteria: ['任务三验收'] }, dependsOn: ['t-2'] },
          ],
        },
      },
    });
    expect(revised.status).toBe('completed');
    const digestB = s.featureRow()?.plan_digest as string;
    expect((await s.service.submit(s.owner, s.decideEnvelope({ expectedRevision: 3 }, 'reject', s.featureId, digestB)))
      .status).toBe('completed');

    const result = await app.queryService.getFeatureApprovals(s.owner, s.featureId);
    expect(result.feature).toMatchObject({ planStatus: 'draft', planDigest: digestB });
    expect(result.decisions).toHaveLength(2);
    const historical = result.decisions.find(decision => decision.subjectDigest === digestA);
    const current = result.decisions.find(decision => decision.subjectDigest === digestB);
    expect(historical).toMatchObject({ status: 'approved', current: false, decisionActor: 'local-owner' });
    expect(current).toMatchObject({ status: 'rejected', current: true });
    expect(result.currentDecision).toEqual(current);
    // 不把拒绝显示为已批准：权威 planStatus 为 draft（≠ approved）。
    expect(result.feature.planStatus).not.toBe('approved');

    // 授权与折叠：缺能力 forbidden；不可见/不存在统一 not_found。
    const noRead = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.decide'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => app.queryService.getFeatureApprovals(noRead, s.featureId), {
      code: 'forbidden',
      operation: 'features.approvals',
      reason: 'capability_denied',
    });
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    await expectPublicError(() => app.queryService.getFeatureApprovals(outsider, s.featureId), {
      code: 'not_found',
      operation: 'features.approvals',
    });
    await expectPublicError(() => app.queryService.getFeatureApprovals(s.owner, 'f-missing'), {
      code: 'not_found',
      operation: 'features.approvals',
    });

    // 决策事件经公开事件面映射（mapStateEvent 白名单形状）。
    const approvedEventRow = s.probe.selectOne<Record<string, unknown>>(
      'SELECT * FROM state_events WHERE event_type = ?',
      ['feature.plan.approved'],
    )!;
    expect(mapStateEvent({
      id: approvedEventRow.id,
      sequence: approvedEventRow.sequence,
      eventType: approvedEventRow.event_type,
      aggregateType: approvedEventRow.aggregate_type,
      aggregateId: approvedEventRow.aggregate_id,
      aggregateRevision: approvedEventRow.aggregate_revision,
      projectId: approvedEventRow.project_id,
      payload: JSON.parse(approvedEventRow.payload as string),
      occurredAtUtcMs: approvedEventRow.occurred_at,
    })).toMatchObject({ type: 'feature.plan.approved', payload: { approved: true } });
  });

  it('重开真实库后决策状态一致（真实持久化而非内存态）', async () => {
    const s = await setup();
    expect((await s.service.submit(s.owner, s.decideEnvelope({}, 'reject', s.featureId, s.planDigest, '先不执行')))
      .status).toBe('completed');
    const reopened = await s.box.openApplication();
    const result = await reopened.queryService.getFeatureApprovals(s.owner, s.featureId);
    expect(result.feature).toMatchObject({ planStatus: 'draft', revision: 2 });
    expect(result.currentDecision).toMatchObject({
      status: 'rejected',
      decisionActor: 'local-owner',
      reason: '先不执行',
      current: true,
    });
    expect(result.decisions).toHaveLength(1);
    // 重开后详情查询同样反映批准依据缺失（notExecutableReasons 含 plan_not_approved）。
    const detail = await reopened.queryService.getFeature(s.owner, s.featureId);
    expect(detail.notExecutableReasons).toContain('plan_not_approved');
  });
});

describe('F-002 迁移接续（版本接续 P03-1 v6；不改历史 checksum）', () => {
  it('P02 v5 库升级到 v9：既有数据、事件水位与历史 checksum 逐项保留', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-p032-f002-v5-' });
    fixture = box;
    const session = openSqliteStorageSession({ path: box.dbPath });
    try {
      // 先迁移到 v5（P02 末版）并种入真实数据与事件水位。
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 5), nowUtcMs: () => NOW });
      session.transactWrite('fixture.v5', (db) => {
        db.prepare(
          'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) ' +
            "VALUES ('proj-v5', ?, 1, ?, 'v5 项目', 'active', '既有说明', '[\"keep\"]')",
        ).run(NOW, NOW);
        db.prepare(
          'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
            "VALUES ('ev-v5', ?, 1, ?, 'proj-v5', 1, 'project.registered', 'project', 'proj-v5', 1, ?, ?)",
        ).run(NOW, NOW, JSON.stringify({ registered: true }), NOW);
      });
      const beforeRows = session.database
        .prepare<[], { version: number; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version',
        )
        .all();

      await migrateSqliteStorage(session, { nowUtcMs: () => NOW + 1_000 });

      // v1..v5 记录与 checksum 原样保留；v6/v7/v8/v9 为新增增量。
      const afterRows = session.database
        .prepare<[], { version: number; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(afterRows.slice(0, 5)).toEqual(beforeRows);
      expect(afterRows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(afterRows[5]!.checksum).toBe(SQLITE_MIGRATIONS[5]!.checksum);
      expect(afterRows[6]!.checksum).toBe(SQLITE_MIGRATIONS[6]!.checksum);
      expect(afterRows[7]!.checksum).toBe(SQLITE_MIGRATIONS[7]!.checksum);
      expect(afterRows[8]!.checksum).toBe(SQLITE_MIGRATIONS[8]!.checksum);
      // 既有数据与事件水位保留；approvals 空表就绪。
      expect(
        session.database.prepare<[string], { display_name: string; labels: string }>(
          'SELECT display_name, labels FROM projects WHERE id = ?',
        ).get('proj-v5'),
      ).toMatchObject({ display_name: 'v5 项目', labels: '["keep"]' });
      expect(session.database.prepare<[], { n: number }>('SELECT MAX(sequence) AS n FROM state_events').get()?.n).toBe(1);
      expect(session.database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM approvals').get()?.n).toBe(0);
      expect(
        session.database
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toContain('approvals');
    } finally {
      session.close();
    }
  });

  it('P03-1 v6 库升级到 v9：计划结构与既有 plan_status 逐字段保留', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-p032-f002-v6-' });
    fixture = box;
    const session = openSqliteStorageSession({ path: box.dbPath });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 6), nowUtcMs: () => NOW });
      session.transactWrite('fixture.v6', (db) => {
        db.prepare(
          'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) ' +
            "VALUES ('proj-v6', ?, 1, ?, 'v6 项目', 'active', '[]')",
        ).run(NOW, NOW);
        db.prepare(
          'INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) ' +
            "VALUES ('phase-v6', ?, 'proj-v6', 3, ?, '阶段', 'open', '[]')",
        ).run(NOW, NOW);
        db.prepare(
          'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs, plan_digest) ' +
            "VALUES ('feature-v6', ?, 'proj-v6', 4, ?, 'phase-v6', '特性', 'draft', 'approved', '[]', '[]', ?)",
        ).run(NOW, NOW, 'ab'.repeat(32));
      });
      await migrateSqliteStorage(session, { nowUtcMs: () => NOW + 1_000 });
      const feature = session.database
        .prepare<[string], { revision: number; plan_status: string; plan_digest: string }>(
          'SELECT revision, plan_status, plan_digest FROM features WHERE id = ?',
        )
        .get('feature-v6');
      expect(feature).toEqual({ revision: 4, plan_status: 'approved', plan_digest: 'ab'.repeat(32) });
      expect(session.database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM approvals').get()?.n).toBe(0);
    } finally {
      session.close();
    }
  });

  it('空库全量迁移记录 v1..v9 且 checksum 与迁移清单一致', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-p032-f002-empty-' });
    fixture = box;
    const session = openSqliteStorageSession({ path: box.dbPath });
    try {
      const result = await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(SQLITE_MIGRATIONS.length);
      expect(result.toVersion).toBe(12);
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const rows = session.database
        .prepare<[], { version: number; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(rows.map((row) => row.checksum)).toEqual(SQLITE_MIGRATIONS.map((migration) => migration.checksum));
    } finally {
      session.close();
    }
  });
});
