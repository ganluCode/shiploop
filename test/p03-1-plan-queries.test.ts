/**
 * P03-1 / F-006：计划授权查询面（Core 应用层直接调用，不经 HTTP）。
 *
 * 验收面（全部基于真实 SQLite/真实命令通道/独立只读探针）：
 * - 详情查询（phases.get / features.get / tasks.get）：按实体 ID 返回真实父级、
 *   标题/描述/标签/revision、需求/验收引用、完整策略副本与来源；Feature 查询含
 *   planDigest、planStatus、不可执行原因与完整同 Feature Task DAG（节点 + 依赖边），
 *   结果字段集冻结、不虚构 Run/Attempt 结果；真实库重开后一致；
 * - 层级列表（phases.list / features.list / tasks.list）：稳定 id 升序、有限
 *   分页、受控游标（绑定数据根 + 项目 + 父级），空列表与末页可识别（nextCursor
 *   null）；分页参数/未知键/超限请求明确拒绝，跨项目/跨父级/跨层级游标一律
 *   invalid_cursor 不当从零读取；可见性先于分页（非法 limit 对不可见项目仍先
 *   forbidden）；
 * - 直接调用 Core 查询也须授权：能力缺失 forbidden；受限主体跨项目实体/策略/
 *   引用不可读，且不可见与不存在的错误完全一致（统一 not_found，不区分存在性）；
 * - 查询只读（持久行/事件/回执计数不变）；一致读视图不得嵌套写事务（TypeError）；
 *   非法 principal 是编程错误（TypeError）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import type { CommandReceipt, PublicError } from '../packages/core/src/ports/commands.ts';
import {
  PLAN_LIST_CURSOR_PREFIX,
  PLAN_LIST_MAX_LIMIT,
} from '../packages/core/src/ports/queries.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const HASH_A = sha256('artifact-source-content');
const HASH_B = sha256('artifact-requirements-content');

const GLOBAL_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
} as const;
const PROJECT_SETTINGS_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
} as const;

let fixture: CommandsTestFixture | undefined;
afterEach(() => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

/** 三 Task 链计划（t-1 ← t-2 ← t-3）；t-1 携带需求/验收引用与来源引用。 */
function threeTaskPlan(artifactIds: { readonly src: string; readonly req: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '示例 Feature',
      description: '计划导入描述',
      labels: ['plan'],
      sourceRefs: [{ artifactId: artifactIds.src, contentHash: HASH_A }],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        description: '任务一描述',
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
      },
    ],
  };
}

interface ImportResult {
  readonly feature: {
    readonly id: string;
    readonly projectId: string;
    readonly phaseId: string;
    readonly planDigest: string;
    readonly planStatus: string;
    readonly revision: number;
  };
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

async function expectPublicError(
  run: () => Promise<unknown>,
  expected: { code: string; operation: string; reason?: string },
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
  return error;
}

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-' });
  const box = fixture;
  const app = await box.openApplication();
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelope = (operation: string, scope: unknown, changes: Record<string, unknown> = {}) => ({
    schemaVersion: 3,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: NOW_ISO,
    ...changes,
  });
  const submit = async (
    operation: string,
    scope: unknown,
    payload: Record<string, unknown>,
    changes: Record<string, unknown> = {},
  ): Promise<CommandReceipt> =>
    app.commandService.submit(owner, envelope(operation, scope, { payload, ...changes }));

  const register = async (repositoryPath: string, displayName: string): Promise<string> => {
    const receipt = await submit('project.register', { kind: 'registration' }, {
      repositoryPath,
      displayName,
      description: null,
      labels: [],
    });
    const result = completedResult(receipt) as unknown as { project: { id: string } };
    return result.project.id;
  };

  const projectIdA = await register(box.repoDirA, '项目 A');
  const projectIdB = await register(box.repoDirB, '项目 B');

  for (const [operation, scope, payload] of [
    ['settings.global.create', { kind: 'global' }, GLOBAL_SETTINGS_PAYLOAD],
    ['settings.project.create', { kind: 'project', projectId: projectIdA }, PROJECT_SETTINGS_PAYLOAD],
  ] as const) {
    const receipt = await submit(operation, scope, payload as Record<string, unknown>);
    if (receipt.status !== 'completed') throw new Error(`夹具配置失败（${operation}）`);
  }

  const createPhase = async (projectId: string, id: string): Promise<void> => {
    const receipt = await submit('phase.create', { kind: 'project', projectId }, {
      id,
      title: `阶段 ${id}`,
      description: null,
      labels: [],
    });
    if (receipt.status !== 'completed') throw new Error(`夹具 Phase 创建失败（${id}）`);
  };
  // 项目 A：phase-1（三 Task 计划）、phase-2（两个 Feature）、phase-3（空）；
  // 项目 B：phase-b（一个单 Task 计划，用于跨项目授权负例）。
  await createPhase(projectIdA, 'phase-1');
  await createPhase(projectIdA, 'phase-2');
  await createPhase(projectIdA, 'phase-3');
  await createPhase(projectIdB, 'phase-b');

  const seedReadyArtifact = async (contentHash: string, locatorName: string): Promise<string> => {
    const record = await app.artifactStore.registerArtifact({
      projectId: projectIdA,
      kind: 'requirement',
      mediaType: 'text/markdown',
      expectedHash: contentHash,
      locator: `artifacts/${locatorName}.md`,
    });
    await app.artifactStore.transitionArtifact(projectIdA, record.id, {
      expectedRevision: record.revision,
      outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
    });
    return record.id;
  };
  const artifactSrcId = await seedReadyArtifact(HASH_A, 'art-src');
  const artifactReqId = await seedReadyArtifact(HASH_B, 'art-req');

  const importPlan = async (
    projectId: string,
    phaseId: string,
    plan: Record<string, unknown>,
  ): Promise<ImportResult> => {
    const receipt = await submit(
      'feature.plan.import',
      { kind: 'project', projectId },
      { phaseId, plan },
      { expectedRevision: 1 },
    );
    return completedResult(receipt);
  };

  const main = await importPlan(
    projectIdA,
    'phase-1',
    threeTaskPlan({ src: artifactSrcId, req: artifactReqId }),
  );
  const emptyDraft = await importPlan(projectIdA, 'phase-3', {
    schemaVersion: 1,
    feature: { title: '空草稿 Feature' },
  });
  // phase-2：两个轻量计划（层级列表分页数据）。
  const featureP1 = await importPlan(projectIdA, 'phase-2', {
    schemaVersion: 1,
    feature: { title: 'phase-2 Feature 1' },
    tasks: [{ id: 'p2-a', title: 'p2-a 任务', acceptance: { criteria: ['p2-a 验收'] } }],
  });
  const featureP2 = await importPlan(projectIdA, 'phase-2', {
    schemaVersion: 1,
    feature: { title: 'phase-2 Feature 2' },
    tasks: [{ id: 'p2-b', title: 'p2-b 任务', acceptance: { criteria: ['p2-b 验收'] } }],
  });
  const featureB = await importPlan(projectIdB, 'phase-b', {
    schemaVersion: 1,
    feature: { title: 'B 项目 Feature' },
    tasks: [{ id: 'b-1', title: 'b-1 任务', acceptance: { criteria: ['b-1 验收'] } }],
  });

  return {
    box,
    app,
    probe,
    owner,
    projectIdA,
    projectIdB,
    artifactIds: { src: artifactSrcId, req: artifactReqId },
    main,
    emptyDraft,
    featureP1,
    featureP2,
    featureB,
  };
}

describe('F-006 计划详情查询（真实父级/策略副本/来源/DAG）', () => {
  it('phases.get / features.get / tasks.get 返回真实父级、元数据、revision、验收/引用、策略副本与来源；重开库后一致', async () => {
    const s = await setup();

    // Phase 详情：真实父级 projectId + 元数据 + revision。
    const phaseDetail = await s.app.queryService.getPhase(s.owner, 'phase-1');
    expect(Object.keys(phaseDetail)).toEqual(['phase']);
    expect(phaseDetail.phase).toMatchObject({
      id: 'phase-1',
      projectId: s.projectIdA,
      title: '阶段 phase-1',
      description: null,
      labels: [],
      status: 'open',
      revision: 1,
    });
    expect(phaseDetail.phase.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Feature 详情：真实父级 phaseId/projectId、来源引用、planDigest/planStatus。
    const featureDetail = await s.app.queryService.getFeature(s.owner, s.main.feature.id);
    expect(Object.keys(featureDetail)).toEqual([
      'feature',
      'validation',
      'notExecutableReasons',
      'tasks',
      'dependencies',
    ]);
    expect(featureDetail.feature).toMatchObject({
      id: s.main.feature.id,
      projectId: s.projectIdA,
      phaseId: 'phase-1',
      title: '示例 Feature',
      description: '计划导入描述',
      labels: ['plan'],
      status: 'draft',
      planStatus: 'draft',
      planDigest: s.main.feature.planDigest,
      sourceRefs: [{ artifactId: s.artifactIds.src, contentHash: HASH_A }],
      revision: 1,
    });
    expect(featureDetail.feature.planDigest).toMatch(/^[0-9a-f]{64}$/);

    // 校验摘要与 F-001/导入回执同源（结构前提，不代表已批准/已执行）。
    expect(featureDetail.validation).toEqual({
      taskCount: 3,
      dependencyEdgeCount: 2,
      executable: true,
    });

    // 完整三 Task DAG：节点按 id 稳定排序 + 依赖边（taskId, dependsOnId）。
    expect(featureDetail.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(featureDetail.dependencies).toEqual([
      { taskId: 't-2', dependsOnId: 't-1' },
      { taskId: 't-3', dependsOnId: 't-2' },
    ]);

    // Task 节点：真实父级、结构化验收、需求/验收引用、完整策略副本与来源。
    const [t1, t2, t3] = featureDetail.tasks;
    expect(t1).toMatchObject({
      id: 't-1',
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
      title: '任务一',
      description: '任务一描述',
      labels: ['core'],
      status: 'pending',
      complexity: 'low',
      acceptance: { criteria: ['任务一验收', '任务一第二条验收'] },
      requirementsRefs: [{ artifactId: s.artifactIds.req }],
      executionConfig: {
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet-2',
      },
      configSource: 'project_default',
      configSourceKey: 'modelMap.low',
      revision: 1,
    });
    // medium 无 modelMap 条目回退全局 defaultStrategy（整体条目）。
    expect(t2).toMatchObject({
      id: 't-2',
      featureId: s.main.feature.id,
      complexity: 'medium',
      requirementsRefs: [],
      executionConfig: { model: 'claude-sonnet' },
      configSource: 'global_default',
      configSourceKey: 'defaultStrategy',
    });
    expect(t3).toMatchObject({
      id: 't-3',
      featureId: s.main.feature.id,
      complexity: null,
      executionConfig: { model: 'claude-sonnet' },
    });

    // Task 详情：同一字段面（真实父级、验收/引用/策略副本/来源）。
    const taskDetail = await s.app.queryService.getTask(s.owner, 't-1');
    expect(Object.keys(taskDetail)).toEqual(['task']);
    expect(taskDetail.task).toEqual(t1);

    // 重开真实库（同一数据根重新装配）后查询一致。
    s.app.close();
    const reopened = await s.box.openApplication();
    try {
      const reopenedFeature = await reopened.queryService.getFeature(s.owner, s.main.feature.id);
      expect(reopenedFeature).toEqual(featureDetail);
      const reopenedTask = await reopened.queryService.getTask(s.owner, 't-2');
      expect(reopenedTask.task).toEqual(t2);
      const reopenedPhase = await reopened.queryService.getPhase(s.owner, 'phase-1');
      expect(reopenedPhase).toEqual(phaseDetail);
    } finally {
      reopened.close();
    }
  });

  it('空草稿 Feature 查询显示不可执行原因 no_tasks；结果字段集冻结，不虚构 Run/Attempt 结果', async () => {
    const s = await setup();
    const detail = await s.app.queryService.getFeature(s.owner, s.emptyDraft.feature.id);
    expect(detail.validation).toEqual({ taskCount: 0, dependencyEdgeCount: 0, executable: false });
    expect(detail.notExecutableReasons).toEqual(['no_tasks', 'plan_not_approved']);
    expect(detail.tasks).toEqual([]);
    expect(detail.dependencies).toEqual([]);
    expect(detail.feature.planStatus).toBe('draft');

    // 三 Task 草稿：结构前提成立但尚未批准（不声称可启动执行，不虚构执行结果）。
    const main = await s.app.queryService.getFeature(s.owner, s.main.feature.id);
    expect(main.validation.executable).toBe(true);
    expect(main.notExecutableReasons).toEqual(['plan_not_approved']);
    for (const detailResult of [detail, main]) {
      for (const record of [
        detailResult.feature,
        ...detailResult.tasks,
      ] as unknown as readonly Record<string, unknown>[]) {
        for (const forbiddenKey of ['run', 'runs', 'attempt', 'attempts', 'batch', 'result', 'executionResult']) {
          expect(Object.keys(record)).not.toContain(forbiddenKey);
        }
      }
    }
  });
});

describe('F-006 层级列表：稳定排序、有限分页与受控游标', () => {
  it('稳定 id 升序键集分页：跨页无重无漏、末页 nextCursor 为 null、空列表可识别', async () => {
    const s = await setup();

    // Phase 层级：3 个 phase，limit=2 → 两页。
    const phasePage1 = await s.app.queryService.listPhases(s.owner, { projectId: s.projectIdA, limit: 2 });
    expect(phasePage1).toMatchObject({ schemaVersion: 3, scope: 'phase-list', limit: 2 });
    expect(phasePage1.records.map((record) => record.id)).toEqual(['phase-1', 'phase-2']);
    expect(phasePage1.nextCursor).toMatch(/^plcur_v1_/);
    const phasePage2 = await s.app.queryService.listPhases(s.owner, {
      projectId: s.projectIdA,
      limit: 2,
      cursor: phasePage1.nextCursor,
    });
    expect(phasePage2.records.map((record) => record.id)).toEqual(['phase-3']);
    expect(phasePage2.nextCursor).toBeNull(); // 末页明确可识别。

    // 默认 limit 一次取全：末页同样 nextCursor=null；空列表 records=[] 且 nextCursor=null。
    const allPhases = await s.app.queryService.listPhases(s.owner, { projectId: s.projectIdA });
    expect(allPhases.records.map((record) => record.id)).toEqual(['phase-1', 'phase-2', 'phase-3']);
    expect(allPhases.limit).toBe(50);
    expect(allPhases.nextCursor).toBeNull();
    const empty = await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.emptyDraft.feature.id,
    });
    expect(empty).toMatchObject({ scope: 'task-list', records: [], nextCursor: null });

    // Feature 层级：phase-2 两个 Feature，稳定 id 升序。
    const featureIds = [s.featureP1.feature.id, s.featureP2.feature.id].sort();
    const featurePage1 = await s.app.queryService.listFeatures(s.owner, {
      projectId: s.projectIdA,
      phaseId: 'phase-2',
      limit: 1,
    });
    expect(featurePage1.records.map((record) => record.id)).toEqual([featureIds[0]]);
    const featurePage2 = await s.app.queryService.listFeatures(s.owner, {
      projectId: s.projectIdA,
      phaseId: 'phase-2',
      limit: 1,
      cursor: featurePage1.nextCursor,
    });
    expect(featurePage2.records.map((record) => record.id)).toEqual([featureIds[1]]);
    expect(featurePage2.nextCursor).toBeNull();

    // Task 层级：t-1/t-2/t-3 跨页无重无漏；重复调用结果确定。
    const taskPage1 = await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
      limit: 2,
    });
    expect(taskPage1.scope).toBe('task-list');
    expect(taskPage1.records.map((record) => record.id)).toEqual(['t-1', 't-2']);
    const taskPage2 = await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
      limit: 2,
      cursor: taskPage1.nextCursor,
    });
    expect(taskPage2.records.map((record) => record.id)).toEqual(['t-3']);
    expect(taskPage2.nextCursor).toBeNull();
    const repeat = await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
      limit: 2,
    });
    expect(repeat).toEqual(taskPage1);

    // 列表记录与详情同源（完整策略副本/引用随记录返回）。
    expect(taskPage1.records[0]).toEqual((await s.app.queryService.getTask(s.owner, 't-1')).task);
  });

  it('分页参数、未知键（含提权字段）与超限请求在任何 SQL 之前明确拒绝', async () => {
    const s = await setup();
    for (const bad of [
      { projectId: s.projectIdA, limit: 0 },
      { projectId: s.projectIdA, limit: -1 },
      { projectId: s.projectIdA, limit: 1.5 },
      { projectId: s.projectIdA, limit: '2' },
      { projectId: s.projectIdA, limit: PLAN_LIST_MAX_LIMIT + 1 },
      { projectId: s.projectIdA, cursor: 42 },
      { projectId: s.projectIdA, cursor: '' },
    ] as const) {
      const error = await expectPublicError(
        () => s.app.queryService.listPhases(s.owner, bad),
        { code: 'invalid_input', operation: 'phases.list' },
      );
      expect(JSON.stringify(error.toErrorShape())).not.toContain(s.projectIdA);
    }
    for (const badInput of [
      { projectId: s.projectIdA, actorId: 'attacker' },
      { projectId: s.projectIdA, principal: { principalId: 'x' } },
      { projectId: s.projectIdA, capabilities: ['project.read'] },
      { projectId: s.projectIdA, scope: { kind: 'all' } },
      { projectId: s.projectIdA, labels: ['x'] },
      {},
    ] as const) {
      await expectPublicError(() => s.app.queryService.listPhases(s.owner, badInput), {
        code: 'invalid_input',
        operation: 'phases.list',
      });
    }
    // 详情/列表的非法实体 ID 形态同样 invalid_input（含任意路径形态）。
    for (const bad of ['../etc/passwd', '/etc/passwd', ' spaces ', 42, null]) {
      await expectPublicError(() => s.app.queryService.getTask(s.owner, bad), {
        code: 'invalid_input',
        operation: 'tasks.get',
      });
    }
    await expectPublicError(
      () => s.app.queryService.listTasks(s.owner, { projectId: s.projectIdA, featureId: '../x' }),
      { code: 'invalid_input', operation: 'tasks.list' },
    );
  });

  it('跨项目/跨父级/跨层级游标与坏游标一律 invalid_cursor，绝不当从零读取', async () => {
    const s = await setup();
    const cursorOfTaskPage = (
      await s.app.queryService.listTasks(s.owner, {
        projectId: s.projectIdA,
        featureId: s.main.feature.id,
        limit: 1,
      })
    ).nextCursor;
    expect(cursorOfTaskPage).toMatch(/^plcur_v1_/);

    // 同一 scope 回传合法（受控游标可续读）。
    const continued = await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
      limit: 5,
      cursor: cursorOfTaskPage,
    });
    expect(continued.records.map((record) => record.id)).toEqual(['t-2', 't-3']);

    // 跨父级：同一 Feature 列表的游标用于另一 Feature。
    await expectPublicError(
      () =>
        s.app.queryService.listTasks(s.owner, {
          projectId: s.projectIdA,
          featureId: s.featureP1.feature.id,
          limit: 5,
          cursor: cursorOfTaskPage,
        }),
      { code: 'invalid_input', operation: 'tasks.list', reason: 'invalid_cursor' },
    );
    // 跨项目：项目 A 的游标用于项目 B 的 Feature。
    await expectPublicError(
      () =>
        s.app.queryService.listTasks(s.owner, {
          projectId: s.projectIdB,
          featureId: s.featureB.feature.id,
          limit: 5,
          cursor: cursorOfTaskPage,
        }),
      { code: 'invalid_input', operation: 'tasks.list', reason: 'invalid_cursor' },
    );
    // 跨层级：Task 列表游标用于 Phase 列表。
    await expectPublicError(
      () =>
        s.app.queryService.listPhases(s.owner, {
          projectId: s.projectIdA,
          limit: 5,
          cursor: cursorOfTaskPage,
        }),
      { code: 'invalid_input', operation: 'phases.list', reason: 'invalid_cursor' },
    );
    // 坏游标/篡改游标：invalid_cursor，不当从零读取。
    for (const badCursor of [
      'not-a-cursor',
      `${PLAN_LIST_CURSOR_PREFIX}!!!`,
      `${PLAN_LIST_CURSOR_PREFIX}${Buffer.from('{"v":9}', 'utf8').toString('base64url')}`,
      `${PLAN_LIST_CURSOR_PREFIX}${Buffer.from('{"v":1}', 'utf8').toString('base64url')}`,
    ] as const) {
      await expectPublicError(
        () =>
          s.app.queryService.listTasks(s.owner, {
            projectId: s.projectIdA,
            featureId: s.main.feature.id,
            cursor: badCursor,
          }),
        { code: 'invalid_input', operation: 'tasks.list', reason: 'invalid_cursor' },
      );
    }
  });
});

describe('F-006 计划查询授权（直接 Core 调用也须授权）', () => {
  it('能力缺失 forbidden；受限主体跨项目详情统一 not_found，不区分存在性且不泄漏策略/引用', async () => {
    const s = await setup();
    const noRead = s.box.restrictedPrincipal({
      capabilities: ['events.read'],
      projectScope: s.box.scopeAllowlist([s.projectIdA]),
    });
    for (const run of [
      () => s.app.queryService.getPhase(noRead, 'phase-1'),
      () => s.app.queryService.getFeature(noRead, s.main.feature.id),
      () => s.app.queryService.getTask(noRead, 't-1'),
      () => s.app.queryService.listPhases(noRead, { projectId: s.projectIdA }),
      () => s.app.queryService.listFeatures(noRead, { projectId: s.projectIdA, phaseId: 'phase-1' }),
      () =>
        s.app.queryService.listTasks(noRead, {
          projectId: s.projectIdA,
          featureId: s.main.feature.id,
        }),
    ]) {
      const error = (await run().catch((caught) => caught)) as PublicError;
      expect(error).toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });
    }

    // 受限主体（仅可见项目 A）：项目 B 的实体与不存在实体错误完全一致（统一 not_found）。
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([s.projectIdA]),
    });
    const hiddenTaskError = (await s.app.queryService
      .getTask(restricted, 'b-1')
      .catch((caught) => caught)) as PublicError;
    const missingTaskError = (await s.app.queryService
      .getTask(restricted, 'no-such-task')
      .catch((caught) => caught)) as PublicError;
    expect(hiddenTaskError).toMatchObject({
      code: 'not_found',
      operation: 'tasks.get',
      details: { reason: 'plan_entity_not_found', entityType: 'task' },
    });
    expect(missingTaskError.toErrorShape()).toEqual(hiddenTaskError.toErrorShape());
    // 不回显实体身份，不泄漏策略副本/引用正文。
    for (const error of [hiddenTaskError, missingTaskError]) {
      const serialized = JSON.stringify(error.toErrorShape());
      expect(serialized).not.toContain('b-1');
      expect(serialized).not.toContain('claude');
      expect(serialized).not.toContain('executionConfig');
    }

    const hiddenFeatureError = (await s.app.queryService
      .getFeature(restricted, s.featureB.feature.id)
      .catch((caught) => caught)) as PublicError;
    const missingFeatureError = (await s.app.queryService
      .getFeature(restricted, randomUUID())
      .catch((caught) => caught)) as PublicError;
    expect(hiddenFeatureError.toErrorShape()).toEqual(missingFeatureError.toErrorShape());
    expect(hiddenFeatureError).toMatchObject({
      code: 'not_found',
      details: { reason: 'plan_entity_not_found', entityType: 'feature' },
    });

    const hiddenPhaseError = (await s.app.queryService
      .getPhase(restricted, 'phase-b')
      .catch((caught) => caught)) as PublicError;
    const missingPhaseError = (await s.app.queryService
      .getPhase(restricted, 'no-such-phase')
      .catch((caught) => caught)) as PublicError;
    expect(hiddenPhaseError.toErrorShape()).toEqual(missingPhaseError.toErrorShape());

    // 受限主体读取可见项目内实体正常（授权读取自身范围）。
    expect((await s.app.queryService.getTask(restricted, 't-1')).task.id).toBe('t-1');
  });

  it('受限主体列表对不可见项目 forbidden；可见性先于分页校验（非法 limit 也先 forbidden）', async () => {
    const s = await setup();
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([s.projectIdA]),
    });
    const forbidden = async (input: Record<string, unknown>): Promise<PublicError> =>
      (await s.app.queryService.listPhases(restricted, input).catch((caught) => caught)) as PublicError;

    // 可见性先于分页：不可见项目 + 非法 limit/cursor → forbidden（不是 invalid_input）。
    for (const input of [
      { projectId: s.projectIdB },
      { projectId: s.projectIdB, limit: PLAN_LIST_MAX_LIMIT + 1 },
      { projectId: s.projectIdB, cursor: 'not-a-cursor' },
      { projectId: randomUUID() },
    ] as const) {
      const error = await forbidden(input);
      expect(error).toMatchObject({
        code: 'forbidden',
        operation: 'phases.list',
        details: { reason: 'project_not_visible', entityType: 'project' },
      });
    }
    // 不可见项目与不存在项目的列表拒绝完全一致（不泄漏存在性）。
    const hidden = await forbidden({ projectId: s.projectIdB });
    const missing = await forbidden({ projectId: randomUUID() });
    expect(hidden.toErrorShape()).toEqual(missing.toErrorShape());

    // 受限主体在可见项目内的层级列表只含本项目实体（可见性谓词先于分页下推）。
    const phases = await s.app.queryService.listPhases(restricted, { projectId: s.projectIdA });
    expect(phases.records.map((record) => record.projectId)).toEqual([
      s.projectIdA,
      s.projectIdA,
      s.projectIdA,
    ]);
    // 子级列表跨项目父级 → 空页（与空父级不可区分）。
    const crossParent = await s.app.queryService.listTasks(restricted, {
      projectId: s.projectIdA,
      featureId: s.featureB.feature.id,
    });
    expect(crossParent.records).toEqual([]);
    expect(crossParent.nextCursor).toBeNull();
  });
});

describe('F-006 查询面纯度与一致读取边界', () => {
  it('查询只读：多轮查询后持久行/事件/回执计数不变', async () => {
    const s = await setup();
    const before = s.probe.counts();
    const eventsBefore = s.probe.stateEvents().length;
    await s.app.queryService.getPhase(s.owner, 'phase-1');
    await s.app.queryService.getFeature(s.owner, s.main.feature.id);
    await s.app.queryService.getTask(s.owner, 't-1');
    await s.app.queryService.listPhases(s.owner, { projectId: s.projectIdA });
    await s.app.queryService.listFeatures(s.owner, { projectId: s.projectIdA, phaseId: 'phase-2' });
    await s.app.queryService.listTasks(s.owner, {
      projectId: s.projectIdA,
      featureId: s.main.feature.id,
    });
    expect(s.probe.counts()).toEqual(before);
    expect(s.probe.stateEvents()).toHaveLength(eventsBefore);
  });

  it('非法 principal 是编程错误（TypeError）；一致读视图不得嵌套写事务（TypeError）', async () => {
    const s = await setup();
    const badPrincipal = {
      principalId: 'local-owner',
      capabilities: ['project.read'], // 数组不是 ReadonlySet
      projectScope: { kind: 'all' },
    };
    await expect(s.app.queryService.getFeature(badPrincipal, s.main.feature.id)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(s.app.queryService.listPhases(badPrincipal, {})).rejects.toBeInstanceOf(TypeError);

    const harness = await s.box.openTransactionalHarness();
    try {
      const queryStore = createSqliteQueryStore(harness.session);
      harness.session.transactWrite('test.nested', () => {
        expect(() => queryStore.readFeaturePlanView(s.main.feature.id)).toThrow(TypeError);
        expect(() => queryStore.readPhaseRecord('phase-1')).toThrow(TypeError);
      });
    } finally {
      harness.close();
    }
  });
});
