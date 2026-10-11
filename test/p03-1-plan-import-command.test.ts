/**
 * P03-1 / F-005：单 Feature 计划导入命令（feature.plan.import）纵向切片。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针，不以方法调用或日志
 * 代替业务状态）：
 * - 以 projectId（信封 scope）、phaseId、Phase 聚合 expectedRevision 与合法
 *   三 Task 链导入：Feature + Tasks + 依赖边 + 完整策略副本 + planDigest +
 *   feature.plan.imported 脱敏事件 + completed 回执同一 BEGIN IMMEDIATE 原子
 *   保存为草稿；重开真实库后父子归属、完整 acceptance、依赖及策略来源一致；
 *   不产生 Batch/Run/Attempt 或自动批准；
 * - 同一短写事务重核项目授权、Phase 归属/open 状态/CAS、现有业务 ID、需求/
 *   验收引用（复用 Artifact 受控查询契约：缺失 not_found、跨项目 forbidden、
 *   非可用状态/内容哈希不匹配冲突拒绝）与当前全局/项目配置（策略副本从事务
 *   内读取的当前配置解析，不追溯既有 Task）；
 * - 重复 ID、自依赖、环、跨 Feature 依赖失败不留下 Feature/Task/边或成功
 *   事件；业务/事件/回执三个写入边界故障注入均整组回滚；业务拒绝按 P02
 *   约定固化 rejected 回执，不存在 completed 回执指向半成功计划；
 * - 同 commandId 同参数重放返回相同 ID/摘要且零新增写入，不同参数冲突；
 * - 空 Task 草稿可导入且结果明确不可执行；不声称 Task 通过或 Feature 完成。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import type { CommandService } from '../packages/core/src/application/command-service.ts';
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

interface ImportResultFeature {
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

interface ImportResult {
  readonly feature: ImportResultFeature;
  readonly tasks: readonly { readonly id: string }[];
  readonly validation: {
    readonly taskCount: number;
    readonly dependencyEdgeCount: number;
    readonly executable: boolean;
  };
}

function completedResult(receipt: CommandReceipt): ImportResult {
  if (receipt.status !== 'completed' || receipt.result === null) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as ImportResult;
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
    /SQL|TRIGGER|injected|stack|shiploop-f005/i,
  );
  return error;
}

/** 三 Task 链计划（t-1 ← t-2 ← t-3）；引用两个 ready 制品（按生成 ID）。 */
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

/** 全局 defaultStrategy=claude-sonnet；项目 modelMap.low=claude-sonnet-2。 */
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

async function setup(options: { withSettings?: boolean; withProjectB?: boolean } = {}) {
  const withSettings = options.withSettings ?? true;
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f005-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const artifactStore = createSqliteArtifactStore(harness.session, { nowUtcMs: () => now });
  const service: CommandService = createCommandService({
    atomicStore: store,
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: box.capabilityCatalog,
    nowUtcMs: () => now,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();

  const envelopeBase = {
    schemaVersion: 4,
    issuedAt: NOW_ISO,
  };
  const submit = async (payload: Record<string, unknown>, operation: string, extra: Record<string, unknown> = {}) =>
    service.submit(owner, { ...envelopeBase, commandId: randomUUID(), operation, payload, ...extra });

  const registerInput = {
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'project.register',
    scope: { kind: 'registration' },
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

  if (withSettings) {
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
  }

  const phase = await submit({ id: 'phase-1', title: '第一阶段', description: null, labels: [] }, 'phase.create', {
    scope: { kind: 'project', projectId },
  });
  if (phase.status !== 'completed') {
    throw new Error('夹具 Phase 创建失败');
  }

  const artifactSrcId = await seedReadyArtifact(artifactStore, projectId, HASH_A, 'art-src');
  const artifactReqId = await seedReadyArtifact(artifactStore, projectId, HASH_B, 'art-req');

  let projectBId: string | null = null;
  if (options.withProjectB ?? true) {
    const registerB = await service.submit(owner, {
      ...envelopeBase,
      commandId: randomUUID(),
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: {
        repositoryPath: box.repoDirB,
        displayName: 'Repo B',
        description: null,
        labels: [],
      },
    });
    if (registerB.status !== 'completed' || registerB.result === null) {
      throw new Error('夹具注册项目 B 失败');
    }
    projectBId = (registerB.result as { project: { id: string } }).project.id;
  }

  const importEnvelope = (changes: Record<string, unknown> = {}) => ({
    ...envelopeBase,
    commandId: randomUUID(),
    operation: 'feature.plan.import' as const,
    scope: { kind: 'project', projectId },
    expectedRevision: 1,
    payload: { phaseId: 'phase-1', plan: samplePlan({ src: artifactSrcId, req: artifactReqId }) },
    ...changes,
  });

  const tableCount = (table: string): number =>
    probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;
  const planCounts = () => ({
    features: tableCount('features'),
    tasks: tableCount('tasks'),
    taskDependencies: tableCount('task_dependencies'),
  });

  return {
    box,
    harness,
    service,
    artifactStore,
    probe,
    owner,
    projectId,
    projectBId,
    artifactIds: { src: artifactSrcId, req: artifactReqId } as const,
    importEnvelope,
    planCounts,
    tableCount,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('F-005 feature.plan.import 导入闭环', () => {
  it('合法三 Task 链导入：Feature/Tasks/依赖/策略副本/摘要/事件/回执同事务草稿保存，重开库后一致', async () => {
    const s = await setup();
    const input = s.importEnvelope();
    const receipt = await s.service.submit(s.owner, input);
    expect(receipt).toMatchObject({
      status: 'completed',
      replayed: false,
      operation: 'feature.plan.import',
      scope: { kind: 'project', projectId: s.projectId },
      issuedAt: NOW_ISO,
      completedAt: NOW_ISO,
    });
    const result = completedResult(receipt);
    const feature = result.feature;
    expect(feature.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(feature).toMatchObject({
      projectId: s.projectId,
      phaseId: 'phase-1',
      title: '示例 Feature',
      description: '计划导入描述',
      labels: ['plan'],
      status: 'draft',
      planStatus: 'draft',
      revision: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    expect(feature.sourceRefs).toEqual([{ artifactId: s.artifactIds.src, contentHash: HASH_A }]);
    // planDigest 与 F-001 纯函数一致（同函数同输入）。
    const expectedDigest = validateFeaturePlanInput(samplePlan(s.artifactIds)).planDigest;
    expect(feature.planDigest).toBe(expectedDigest);
    expect(result.tasks).toEqual([{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }]);
    expect(result.validation).toEqual({ taskCount: 3, dependencyEdgeCount: 2, executable: true });

    // 独立只读探针：真实库行与结果一致。
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
    const featureRow = s.probe.selectOne<Record<string, string | number | null>>(
      'SELECT id, project_id, phase_id, title, status, plan_status, plan_digest, labels, source_refs FROM features',
    );
    expect(featureRow).toMatchObject({
      id: feature.id,
      project_id: s.projectId,
      phase_id: 'phase-1',
      title: '示例 Feature',
      status: 'draft',
      plan_status: 'draft',
      plan_digest: expectedDigest,
      labels: JSON.stringify(['plan']),
    });
    const taskRows = s.probe.selectAll<Record<string, string | number | null>>(
      'SELECT id, feature_id, title, complexity, acceptance, requirements_refs, execution_config, config_source, config_source_key, status, revision FROM tasks ORDER BY id',
    );
    expect(taskRows).toHaveLength(3);
    const [t1, t2, t3] = taskRows as (Record<string, string | number | null> | undefined)[];
    expect(t1).toMatchObject({
      id: 't-1',
      feature_id: feature.id,
      title: '任务一',
      complexity: 'low',
      status: 'pending',
      revision: 1,
      acceptance: JSON.stringify({ criteria: ['任务一验收', '任务一第二条验收'] }),
      requirements_refs: JSON.stringify([{ artifactId: s.artifactIds.req }]),
      // 完整策略副本：complexity=low 命中项目 modelMap.low，来源 project_default。
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet-2',
      }),
      config_source: 'project_default',
      config_source_key: 'modelMap.low',
    });
    expect(t2).toMatchObject({
      id: 't-2',
      complexity: 'medium',
      // medium 无 modelMap 条目回退全局 defaultStrategy（整体条目，不跨来源拼接）。
      execution_config: JSON.stringify({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      }),
      config_source: 'global_default',
      config_source_key: 'defaultStrategy',
    });
    expect(t3).toMatchObject({
      id: 't-3',
      complexity: null,
      config_source: 'global_default',
      config_source_key: 'defaultStrategy',
      // 引用按 (artifactId, contentHash) 排序去重后落库（确定性规范化）。
      requirements_refs: JSON.stringify(
        [
          { artifactId: s.artifactIds.req },
          { artifactId: s.artifactIds.src, contentHash: HASH_A },
        ].sort((left, right) =>
          left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0,
        ),
      ),
    });
    const edges = s.probe.selectAll<{ task_id: string; depends_on_id: string }>(
      'SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id',
    );
    expect(edges).toEqual([
      { task_id: 't-2', depends_on_id: 't-1' },
      { task_id: 't-3', depends_on_id: 't-2' },
    ]);

    // 同事务事件：注册/配置×2/phase.created/feature.plan.imported（序号递增）。
    const events = s.probe.stateEvents();
    const importEvent = events[events.length - 1]!;
    expect(importEvent).toMatchObject({
      project_id: s.projectId,
      event_type: 'feature.plan.imported',
      aggregate_type: 'feature',
      aggregate_id: feature.id,
      aggregate_revision: 1,
      payload: '{"imported":true}',
      sequence: events.length,
    });

    // 重开真实 Core 装配：回执可读、库行仍在。
    const reopened = await s.box.openApplication();
    expect(await reopened.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual({
      ...receipt,
      replayed: false,
    });
    expect(
      s.probe.selectOne<{ id: string }>('SELECT id FROM features WHERE id = ?', [feature.id])?.id,
    ).toBe(feature.id);
  });

  it('同 commandId 同参数重放返回相同 ID/摘要且零新增写入；不同参数冲突且零写入', async () => {
    const s = await setup();
    const input = s.importEnvelope();
    const first = await s.service.submit(s.owner, input);
    const firstResult = completedResult(first);
    const before = { ...s.probe.counts(), ...s.planCounts() };
    // 同 commandId 同参数（对象键序不同；stableCanonicalJson 键排序后等价）→ 原结果。
    const replay = await s.service.submit(s.owner, {
      ...input,
      payload: {
        plan: {
          tasks: samplePlan(s.artifactIds).tasks,
          feature: samplePlan(s.artifactIds).feature,
          schemaVersion: 1,
        },
        phaseId: 'phase-1',
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(completedResult(replay).feature.id).toBe(firstResult.feature.id);
    expect(completedResult(replay).feature.planDigest).toBe(firstResult.feature.planDigest);
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
    // 同 commandId 不同参数 → conflict（idempotency_key_reuse），零写入。
    await expectPublicError(
      () =>
        s.service.submit(s.owner, {
          ...input,
          payload: {
            phaseId: 'phase-1',
            plan: { ...samplePlan(s.artifactIds), feature: { title: '另一个标题' } },
          },
        }),
      { code: 'conflict', operation: 'feature.plan.import', reason: 'idempotency_key_reuse' },
    );
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
  });

  it('Phase 聚合 CAS：expectedRevision 不匹配固化 rejected（conflict）且零业务写入', async () => {
    const s = await setup();
    const stale = await s.service.submit(s.owner, s.importEnvelope({ expectedRevision: 2 }));
    const error = rejectedError(stale);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({
      reason: 'conflict',
      entityType: 'phase',
      expectedRevision: 2,
      actualRevision: 1,
    });
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
    // 状态/事件零新增，但业务拒绝回执按 P02 约定持久化。
    const receipts = s.tableCount('command_receipts');
    expect(receipts).toBeGreaterThan(0);
    expect(await s.service.submit(s.owner, s.importEnvelope({ commandId: randomUUID() }))).toMatchObject(
      { status: 'completed', replayed: false },
    );
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });

  it.each(['closed', 'archived'] as const)('%s Phase 拒绝整组导入（rejected，零写入）', async status => {
    const s = await setup();
    s.harness.session.database
      .prepare('UPDATE phases SET status = ?, revision = revision + 1 WHERE id = ?')
      .run(status, 'phase-1');
    const receipt = await s.service.submit(s.owner, s.importEnvelope({ expectedRevision: 2 }));
    const error = rejectedError(receipt);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ reason: 'phase_not_open', entityType: 'phase' });
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
    // 不存在/跨项目 Phase 按公开错误约定拒绝（不泄漏、无回执写业务）。
    await expectPublicError(
      () => s.service.submit(s.owner, s.importEnvelope({ payload: { phaseId: 'phase-x', plan: samplePlan(s.artifactIds) } })),
      { code: 'not_found', operation: 'feature.plan.import' },
    );
  });

  it('重复既有任务 ID 固化 rejected（task_already_exists），不覆盖既有 Task、零新增行', async () => {
    const s = await setup();
    const first = await s.service.submit(s.owner, s.importEnvelope());
    expect(first.status).toBe('completed');
    const before = { ...s.probe.counts(), ...s.planCounts() };
    const duplicate = await s.service.submit(s.owner, s.importEnvelope());
    const error = rejectedError(duplicate);
    expect(error.code).toBe('conflict');
    expect(error.details).toMatchObject({ reason: 'task_already_exists', entityType: 'task' });
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual({
      ...before,
      command_receipts: before.command_receipts! + 1,
    });
    // 既有 Task 不被覆盖。
    expect(
      s.probe.selectOne<{ title: string }>('SELECT title FROM tasks WHERE id = ?', ['t-1'])?.title,
    ).toBe('任务一');
  });

  it('需求/验收引用重核：缺失 not_found、跨项目 forbidden、非可用状态与内容哈希不匹配冲突拒绝', async () => {
    const s = await setup();
    // 缺失引用：不存在制品。
    const missingPlan = {
      ...samplePlan(s.artifactIds),
      tasks: [
        { id: 't-1', title: '任务一', acceptance: { criteria: ['验收'] }, requirementsRefs: [{ artifactId: 'art-missing' }] },
      ],
    };
    await expectPublicError(
      () => s.service.submit(s.owner, s.importEnvelope({ payload: { phaseId: 'phase-1', plan: missingPlan } })),
      { code: 'not_found', operation: 'feature.plan.import' },
    );
    // 跨项目引用：项目 B 的制品对项目 A 不可见（ownership → forbidden）。
    await seedReadyArtifact(s.artifactStore, s.projectBId!, sha256('artifact-b'), 'art-b');
    const crossPlan = {
      ...samplePlan(s.artifactIds),
      tasks: [
        { id: 't-1', title: '任务一', acceptance: { criteria: ['验收'] }, requirementsRefs: [{ artifactId: s.probe.selectOne<{ id: string }>("SELECT id FROM artifacts WHERE kind = 'requirement' AND status = 'ready' AND project_id = ?", [s.projectBId!])!.id }] },
      ],
    };
    await expectPublicError(
      () => s.service.submit(s.owner, s.importEnvelope({ payload: { phaseId: 'phase-1', plan: crossPlan } })),
      { code: 'forbidden', operation: 'feature.plan.import', reason: 'ownership_denied' },
    );
    // 非可用状态：pending 制品不能作为合法输入。
    await s.artifactStore.registerArtifact({
      projectId: s.projectId,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: sha256('pending-artifact'),
      locator: 'artifacts/art-pending.md',
    });
    const pendingPlan = {
      ...samplePlan(s.artifactIds),
      tasks: [
        { id: 't-1', title: '任务一', acceptance: { criteria: ['验收'] }, requirementsRefs: [{ artifactId: s.probe.selectOne<{ id: string }>("SELECT id FROM artifacts WHERE status = 'pending'")!.id }] },
      ],
    };
    const pendingReceipt = await s.service.submit(
      s.owner,
      s.importEnvelope({ payload: { phaseId: 'phase-1', plan: pendingPlan } }),
    );
    expect(rejectedError(pendingReceipt).details).toMatchObject({
      reason: 'artifact_not_usable',
      entityType: 'artifact',
    });
    // 内容哈希不匹配：引用绑定到非当前内容版本。
    const mismatchPlan = {
      ...samplePlan(s.artifactIds),
      feature: { title: 'F', sourceRefs: [{ artifactId: s.artifactIds.src, contentHash: sha256('other') }] },
      tasks: [{ id: 't-1', title: '任务一', acceptance: { criteria: ['验收'] } }],
    };
    const mismatchReceipt = await s.service.submit(
      s.owner,
      s.importEnvelope({ payload: { phaseId: 'phase-1', plan: mismatchPlan } }),
    );
    expect(rejectedError(mismatchReceipt).details).toMatchObject({
      reason: 'artifact_content_hash_mismatch',
      entityType: 'artifact',
    });
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
  });

  it('策略副本来自事务内当前配置：无匹配拒绝整组；配置之后变化不追溯既有 Task', async () => {
    const s = await setup({ withSettings: false });
    // 无任何配置：no_strategy_match 拒绝且零写入。
    await expectPublicError(() => s.service.submit(s.owner, s.importEnvelope()), {
      code: 'invalid_input',
      operation: 'feature.plan.import',
      reason: 'no_strategy_match',
    });
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
    // 建立配置后导入成功；随后更新配置，既有 Task 副本不变、新导入用新配置。
    await s.service.submit(s.owner, {
      schemaVersion: 4,
      commandId: randomUUID(),
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      issuedAt: NOW_ISO,
      payload: GLOBAL_SETTINGS_PAYLOAD,
    });
    await s.service.submit(s.owner, {
      schemaVersion: 4,
      commandId: randomUUID(),
      operation: 'settings.project.create',
      scope: { kind: 'project', projectId: s.projectId },
      issuedAt: NOW_ISO,
      payload: PROJECT_SETTINGS_PAYLOAD,
    });
    const first = completedResult(await s.service.submit(s.owner, s.importEnvelope()));
    const firstModel = s.probe.selectOne<{ execution_config: string }>(
      'SELECT execution_config FROM tasks WHERE id = ?',
      ['t-1'],
    )!.execution_config;
    expect(JSON.parse(firstModel)).toMatchObject({ model: 'claude-sonnet-2' });
    await s.service.submit(s.owner, {
      schemaVersion: 4,
      commandId: randomUUID(),
      operation: 'settings.project.update',
      scope: { kind: 'project', projectId: s.projectId },
      issuedAt: NOW_ISO,
      expectedRevision: 1,
      payload: {
        schemaVersion: 2,
        strategies: {
          modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        },
      },
    });
    const second = completedResult(
      await s.service.submit(
        s.owner,
        s.importEnvelope({
          payload: {
            phaseId: 'phase-1',
            plan: {
              ...samplePlan(s.artifactIds),
              tasks: [
                { id: 'u-1', title: '任务U', complexity: 'low', acceptance: { criteria: ['验收U'] } },
              ],
            },
          },
        }),
      ),
    );
    expect(second.feature.id).not.toBe(first.feature.id);
    expect(
      JSON.parse(
        s.probe.selectOne<{ execution_config: string }>(
          'SELECT execution_config FROM tasks WHERE id = ?',
          ['u-1'],
        )!.execution_config,
      ),
    ).toMatchObject({ model: 'claude-sonnet' });
    // 既有 Task 副本不被追溯改写。
    expect(
      s.probe.selectOne<{ execution_config: string }>(
        'SELECT execution_config FROM tasks WHERE id = ?',
        ['t-1'],
      )!.execution_config,
    ).toBe(firstModel);
  });

  it('计划结构/DAG 负例：自依赖、环、重复计划内 ID、跨 Feature 依赖与提权字段整组拒绝零写入', async () => {
    const s = await setup();
    // 既有 Feature 的任务 t-x（跨 Feature 依赖解析用）。
    const otherFeature = completedResult(
      await s.service.submit(
        s.owner,
        s.importEnvelope({
          payload: {
            phaseId: 'phase-1',
            plan: {
              schemaVersion: 1,
              feature: { title: '既有 Feature' },
              tasks: [{ id: 't-x', title: '既有任务', acceptance: { criteria: ['验收'] } }],
            },
          },
        }),
      ),
    );
    expect(otherFeature.tasks).toEqual([{ id: 't-x' }]);
    const before = { ...s.probe.counts(), ...s.planCounts() };
    const badPlan = (tasks: unknown[], feature: Record<string, unknown> = { title: 'F' }) => ({
      phaseId: 'phase-1',
      plan: { schemaVersion: 1, feature, tasks },
    });
    // 自依赖。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.importEnvelope({ payload: badPlan([{ id: 'a', title: 'A', acceptance: { criteria: ['x'] }, dependsOn: ['a'] }]) }),
        ),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[0].dependsOn[0]' },
    );
    // 环。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.importEnvelope({
            payload: badPlan([
              { id: 'a', title: 'A', acceptance: { criteria: ['x'] }, dependsOn: ['b'] },
              { id: 'b', title: 'B', acceptance: { criteria: ['x'] }, dependsOn: ['a'] },
            ]),
          }),
        ),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks.dependencies' },
    );
    // 计划内重复 ID。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.importEnvelope({
            payload: badPlan([
              { id: 'a', title: 'A', acceptance: { criteria: ['x'] } },
              { id: 'a', title: 'A2', acceptance: { criteria: ['x'] } },
            ]),
          }),
        ),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[1].id' },
    );
    // 跨 Feature 依赖：dependsOn 命中其他 Feature 的既有任务（库内解析精确报错）。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.importEnvelope({
            payload: badPlan([{ id: 'a', title: 'A', acceptance: { criteria: ['x'] }, dependsOn: ['t-x'] }]),
          }),
        ),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[0].dependsOn[0]' },
    );
    // 缺依赖（目标既不在计划内也不在库内）。
    await expectPublicError(
      () =>
        s.service.submit(
          s.owner,
          s.importEnvelope({
            payload: badPlan([{ id: 'a', title: 'A', acceptance: { criteria: ['x'] }, dependsOn: ['nope'] }]),
          }),
        ),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[0].dependsOn[0]' },
    );
    // 缺完整 acceptance（引用/描述不能替代）。
    await expectPublicError(
      () => s.service.submit(s.owner, s.importEnvelope({ payload: badPlan([{ id: 'a', title: 'A' }]) })),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[0].acceptance' },
    );
    // 计划内携带 expectedRevision/executionConfig 等提权/聚合字段：未知键拒绝
    // （rejectUnknownKeys 以容器字段定位，键名进入 reason）。
    for (const forbiddenKey of ['expectedRevision', 'executionConfig', 'configSource', 'revision']) {
      const unknownKeyError = await expectPublicError(
        () =>
          s.service.submit(
            s.owner,
            s.importEnvelope({
              payload: badPlan([{ id: 'a', title: 'A', acceptance: { criteria: ['x'] }, [forbiddenKey]: 1 }]),
            }),
          ),
        { code: 'invalid_input', operation: 'feature.plan.import', field: 'payload.plan.tasks[0]' },
      );
      expect(unknownKeyError.details?.reason).toContain(forbiddenKey);
    }
    // 信封缺 expectedRevision（Phase 聚合 CAS 必填）。
    await expectPublicError(
      () => s.service.submit(s.owner, s.importEnvelope({ expectedRevision: undefined })),
      { code: 'invalid_input', operation: 'feature.plan.import', field: 'expectedRevision' },
    );
    expect({ ...s.probe.counts(), ...s.planCounts() }).toEqual(before);
  });

  it.each([
    ['featuresBeforeInsert' as const],
    ['tasksBeforeInsert' as const],
    ['taskDependenciesBeforeInsert' as const],
    ['stateEventsBeforeInsert' as const],
    ['commandReceiptsBeforeInsert' as const],
  ])('写入故障 %s 整组回滚，撤除后相同信封重试成功', async point => {
    const s = await setup();
    const input = s.importEnvelope();
    const baselineEvents = s.tableCount('state_events');
    const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
    const error = await s.service.submit(s.owner, input).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'internal', operation: 'feature.plan.import' });
    expect(JSON.stringify((error as PublicError).toErrorShape())).not.toMatch(
      /SQL|injected|TRIGGER|shiploop-f005/i,
    );
    // 整组回滚：无孤立 Feature/Task/边/事件/回执。
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
    expect(s.tableCount('state_events')).toBe(baselineEvents);
    fault.remove();
    // 撤除故障后相同信封（同一 commandId）重试成功。
    expect(await s.service.submit(s.owner, input)).toMatchObject({
      status: 'completed',
      replayed: false,
    });
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });

  it('空 Task 草稿可导入且结果明确不可执行；不产生执行实体或自动批准', async () => {
    const s = await setup();
    const emptyPlan = { phaseId: 'phase-1', plan: { schemaVersion: 1, feature: { title: '空草稿' }, tasks: [] } };
    const receipt = await s.service.submit(s.owner, s.importEnvelope({ payload: emptyPlan }));
    const result = completedResult(receipt);
    expect(result.validation).toEqual({ taskCount: 0, dependencyEdgeCount: 0, executable: false });
    expect(result.feature).toMatchObject({ status: 'draft', planStatus: 'draft' });
    expect(JSON.stringify(result)).not.toMatch(/"executable":\s*true|approved|batch|attempt|run/i);
    expect(s.planCounts()).toEqual({ features: 1, tasks: 0, taskDependencies: 0 });
    // 执行域表尚未建立；导入成功不代表 Task 通过或 Feature 完成。
    expect(s.probe.tableExists('runs')).toBe(false);
    expect(s.probe.tableExists('attempts')).toBe(false);
    expect(s.probe.tableExists('execution_batches')).toBe(false);
    expect(
      s.probe.selectOne<{ plan_status: string }>('SELECT plan_status FROM features')?.plan_status,
    ).toBe('draft');
  });

  it('授权：缺 feature.plan.import 能力 forbidden；不可见项目 forbidden；恰切获准主体可导入', async () => {
    const s = await setup();
    const noCapability = s.box.restrictedPrincipal({
      capabilities: ['phase.write'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    await expectPublicError(() => s.service.submit(noCapability, s.importEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.import',
      reason: 'capability_denied',
    });
    const outsider = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.import'],
      projectScope: s.box.scopeAllowlist([randomUUID()]),
    });
    const invisibleError = await expectPublicError(() => s.service.submit(outsider, s.importEnvelope()), {
      code: 'forbidden',
      operation: 'feature.plan.import',
      reason: 'project_not_visible',
    });
    expect(JSON.stringify(invisibleError.toErrorShape())).not.toContain(s.projectId);
    expect(s.planCounts()).toEqual({ features: 0, tasks: 0, taskDependencies: 0 });
    const authorized = s.box.restrictedPrincipal({
      capabilities: ['feature.plan.import'],
      projectScope: s.box.scopeAllowlist([s.projectId]),
    });
    const receipt = await s.service.submit(authorized, s.importEnvelope());
    expect(receipt).toMatchObject({ status: 'completed', replayed: false });
    expect(s.planCounts()).toEqual({ features: 1, tasks: 3, taskDependencies: 2 });
  });
});
