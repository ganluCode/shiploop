/**
 * P03-1 / F-009：计划域命令/查询接入 Host 传输与 HostClient。
 *
 * 验收面（真实 startHost + 真实 HostClient + 真实 SQLite，不经内部方法调用）：
 * - Phase 创建、计划导入、标签编辑、草稿修订均经既有 POST /v1/commands 由
 *   HostClient 公共方法提交（冻结信封/回执/resultRef/有限重试同一命令面）；
 *   completed 回执内嵌结果经客户端线校验器运行时复核；
 * - 层级列表/详情/DAG 查询经既有授权查询模式暴露（/v1/phases、/v1/features、
 *   /v1/tasks），Host 不直接读写 SQLite；分页/游标/体积上限沿用既有实现；
 * - 握手与线消息版本（P03-2 / F-007 升 v5）对旧客户端明确拒绝
 *   （unsupported_schema_version），畸形响应/未知字段/未知版本一律协议错误；
 * - 新事件（phase.created/feature.plan.imported/*.labels.updated/
 *   feature.plan.revised）经 SSE 线校验可读；幂等重放零新增副作用；
 *   CAS 冲突以 rejected 回执明确返回。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  HostProtocolError,
  isHostProtocolError,
  connectToHost,
  startHost,
  validateAppQueryResponse,
  validateStateEventWire,
  validatePhaseCreateResultWire,
  validateFeaturePlanImportResultWire,
  validatePlanLabelsUpdateResultWire,
  validateFeaturePlanReviseResultWire,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import type { CommandReceipt } from '../../../packages/core/src/index.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { openStorageProbe } from '../../helpers/p02-2/storage-probe.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function asCompleted(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'completed' }> {
  expect(receipt.status).toBe('completed');
  if (receipt.status !== 'completed') {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt;
}

function asRejected(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'rejected' }> {
  expect(receipt.status).toBe('rejected');
  if (receipt.status !== 'rejected') {
    throw new Error(`expected rejected receipt, got ${receipt.status}`);
  }
  return receipt;
}

async function rejectionOf(actions: () => unknown): Promise<unknown> {
  try {
    await actions();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};

/** 无引用三 Task 链计划（t-1 ← t-2 ← t-3）；引用/策略语义由 F-005 专项覆盖。 */
function samplePlan(titleSuffix = ''): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: `集成 Feature${titleSuffix}`,
      description: 'F-009 接线描述',
      labels: ['integration'],
      sourceRefs: [],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        complexity: 'low',
        acceptance: { criteria: ['任务一验收'] },
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
        complexity: 'low',
        acceptance: { criteria: ['任务三验收'] },
        dependsOn: ['t-2'],
      },
    ],
  };
}

interface WiredSetup {
  readonly box: CommandsTestFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly port: number;
  /** 注册项目 + 全局配置 + Phase（revision=1），返回 projectId/phaseId。 */
  seedProjectWithPhase(id: string): Promise<{ projectId: string; phaseId: string }>;
  dispose(): Promise<void>;
}

let fixture: CommandsTestFixture | undefined;
let activeHost: RunningHost | undefined;

afterEach(async () => {
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    await host.close();
  }
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

async function setupWired(prefix: string): Promise<WiredSetup> {
  fixture = createCommandsTestFixture({ prefix: `shiploop-f009-${prefix}-` });
  const box = fixture;
  const host = await startHost({
    dataRoot: box.dataRoot,
    capabilityCatalog: box.capabilityCatalog,
    env: {},
  });
  activeHost = host;
  const token = readFileSync(join(box.dataRoot, 'host', 'auth.token'), 'utf8');
  const client = await connectToHost({ canonicalRoot: box.dataRoot });
  const port = host.port;

  const seedProjectWithPhase = async (phaseId: string) => {
    const registered = asCompleted(
      await client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: box.repoDirA,
          displayName: `F-009 ${phaseId}`,
          description: null,
          labels: [],
        },
      }),
    );
    const projectId = (registered.result as { project: { id: string } }).project.id;
    asCompleted(
      await client.submitCommand({
        operation: 'settings.global.create',
        scope: { kind: 'global' },
        payload: GLOBAL_PAYLOAD,
      }),
    );
    asCompleted(
      await client.createPhase({
        projectId,
        id: phaseId,
        title: `阶段 ${phaseId}`,
        description: null,
        labels: [],
      }),
    );
    return { projectId, phaseId };
  };

  return {
    box,
    host,
    client,
    token,
    port,
    seedProjectWithPhase,
    async dispose() {
      client.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. 真实 Host + HostClient 纵向：命令/查询/事件闭环
 * ------------------------------------------------------------------ */

describe('F-009 计划域 HostClient 纵向（真实 Host + SQLite）', () => {
  it('createPhase/importFeaturePlan/updatePlanLabels/reviseFeaturePlan 经 /v1/commands 完成并重放零副作用', async () => {
    const s = await setupWired('vertical');
    try {
      const { projectId, phaseId } = await s.seedProjectWithPhase('phase-main');
      expect(CURRENT_SCHEMA_VERSION).toBe(6);

      // 事件观察：以命令前水位续读（SSE 线校验覆盖新事件类型）。
      const snapshotBefore = await s.client.getSnapshot({ kind: 'project', projectId });
      const observed: { type: string; aggregateType: string; payload: unknown }[] = [];
      const subscription = await s.client.subscribeEvents({
        scope: { kind: 'project', projectId },
        cursor: snapshotBefore.watermark.cursor,
        onEvent: (event) => {
          observed.push({
            type: event.type,
            aggregateType: event.aggregate.type,
            payload: event.payload,
          });
        },
      });

      // 1) 计划导入（Phase 聚合 expectedRevision=1）。
      const importInput = {
        projectId,
        phaseId,
        expectedRevision: 1,
        plan: samplePlan(),
      };
      const imported = asCompleted(await s.client.importFeaturePlan(importInput));
      const importResult = validateFeaturePlanImportResultWire(imported.result);
      const featureId = importResult.feature.id;
      expect(importResult.feature.planStatus).toBe('draft');
      expect(importResult.feature.planDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(importResult.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
      expect(importResult.validation).toEqual({ taskCount: 3, dependencyEdgeCount: 2, executable: true });
      const digestAfterImport = importResult.feature.planDigest;

      // 2) 幂等重放：同 commandId + 同 issuedAt 重建同一信封。
      const replayed = asCompleted(
        await s.client.importFeaturePlan({
          ...importInput,
          commandId: imported.commandId,
        }, { commandId: imported.commandId, issuedAt: imported.issuedAt }),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(imported.resultRef);
      expect(replayed.result).toEqual(imported.result);

      // 3) 标签编辑（Task 自身 revision CAS）：摘要不变。
      const featureDetail = await s.client.getFeature(featureId);
      expect(featureDetail.dependencies).toEqual([
        { taskId: 't-2', dependsOnId: 't-1' },
        { taskId: 't-3', dependsOnId: 't-2' },
      ]);
      expect(featureDetail.notExecutableReasons).toEqual(['plan_not_approved']);
      const labelsEdited = asCompleted(
        await s.client.updatePlanLabels({
          projectId,
          entityType: 'task',
          id: 't-1',
          expectedRevision: 1,
          labels: ['wired'],
        }),
      );
      const labelsResult = validatePlanLabelsUpdateResultWire(labelsEdited.result);
      expect(labelsResult).toMatchObject({ entityType: 'task', id: 't-1', labels: ['wired'], revision: 2 });
      const afterLabels = await s.client.getFeature(featureId);
      expect(afterLabels.feature.planDigest).toBe(digestAfterImport);

      // 4) 实质修订（Feature 聚合 CAS=1 → revision 2）：摘要改变。
      const revised = asCompleted(
        await s.client.reviseFeaturePlan({
          projectId,
          featureId,
          expectedRevision: 1,
          plan: samplePlan('（修订）'),
        }),
      );
      const reviseResult = validateFeaturePlanReviseResultWire(revised.result);
      expect(reviseResult.feature.revision).toBe(2);
      expect(reviseResult.feature.planDigest).not.toBe(digestAfterImport);
      expect(reviseResult.memberChanges).toEqual({ keptTaskCount: 3, createdTaskCount: 0, removedTaskCount: 0 });

      // 5) CAS 冲突：旧 revision 修订 → rejected(conflict)。
      const stale = asRejected(
        await s.client.reviseFeaturePlan({
          projectId,
          featureId,
          expectedRevision: 1,
          plan: samplePlan('（冲突）'),
        }),
      );
      expect(stale.error.code).toBe('conflict');

      // 持久副作用核对（独立只读探针）：重放不增加行数。
      const probe = openStorageProbe(join(s.box.dataRoot, 'core.sqlite'));
      try {
        const planCounts = (table: string) =>
          probe.selectOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;
        expect(planCounts('phases')).toBe(1);
        expect(planCounts('features')).toBe(1);
        expect(planCounts('tasks')).toBe(3);
        expect(planCounts('task_dependencies')).toBe(2);
        expect(probe.counts()).toMatchObject({ state_events: 6, command_receipts: 7 });
      } finally {
        probe.close();
      }

      // 6) 事件读取：水位之后的导入/标签/修订事件按白名单到达且 payload 脱敏
      // 冻结（phase.created 属于水位之前的历史，不在本订阅重复投递）。
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline &&
        !observed.some((event) => event.type === 'feature.plan.revised')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      subscription.close();
      await subscription.ended;
      const types = observed.map((event) => event.type);
      expect(types).toContain('feature.plan.imported');
      expect(types).toContain('task.labels.updated');
      expect(types).toContain('feature.plan.revised');
      expect(types).not.toContain('phase.created');
      const importedEvent = observed.find((event) => event.type === 'feature.plan.imported');
      expect(importedEvent).toMatchObject({
        aggregateType: 'feature',
        payload: { imported: true },
      });
      const labelsEvent = observed.find((event) => event.type === 'task.labels.updated');
      expect(labelsEvent).toMatchObject({ aggregateType: 'task', payload: { labelsUpdated: true } });
      const revisedEvent = observed.find((event) => event.type === 'feature.plan.revised');
      expect(revisedEvent).toMatchObject({ payload: { revised: true } });
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('层级列表/详情/DAG 查询经授权查询路由暴露且分页页末可识别', async () => {
    const s = await setupWired('queries');
    try {
      const { projectId, phaseId } = await s.seedProjectWithPhase('phase-q');
      const imported = asCompleted(
        await s.client.importFeaturePlan({ projectId, phaseId, expectedRevision: 1, plan: samplePlan() }),
      );
      const featureId = (imported.result as { feature: { id: string } }).feature.id;

      // phases.list / phases.get。
      const phases = await s.client.listPhases(projectId);
      expect(phases.scope).toBe('phase-list');
      expect(phases.records.map((phase) => phase.id)).toEqual([phaseId]);
      expect(phases.nextCursor).toBeNull();
      const phaseDetail = await s.client.getPhase(phaseId);
      expect(phaseDetail.phase.projectId).toBe(projectId);
      expect(phaseDetail.phase.revision).toBe(1);

      // features.list / features.get（完整 DAG）。
      const features = await s.client.listFeatures(projectId, phaseId);
      expect(features.scope).toBe('feature-list');
      expect(features.records.map((feature) => feature.id)).toEqual([featureId]);
      const detail = await s.client.getFeature(featureId);
      expect(detail.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
      expect(detail.tasks[0].executionConfig).toEqual({
        schemaVersion: 2,
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-sonnet',
      });
      expect(detail.tasks[0].configSource).toBe('global_default');
      expect(detail.tasks[0].configSourceKey).toBe('defaultStrategy');
      expect(detail.validation).toEqual({ taskCount: 3, dependencyEdgeCount: 2, executable: true });

      // tasks.list 分页：limit=2 → 续读一页；末页 nextCursor=null。
      const firstPage = await s.client.listTasks(projectId, featureId, { limit: 2 });
      expect(firstPage.records.map((task) => task.id)).toEqual(['t-1', 't-2']);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await s.client.listTasks(projectId, featureId, {
        limit: 2,
        cursor: firstPage.nextCursor as string,
      });
      expect(secondPage.records.map((task) => task.id)).toEqual(['t-3']);
      expect(secondPage.nextCursor).toBeNull();

      // tasks.get：策略副本与来源。
      const task = await s.client.getTask('t-2');
      expect(task.task.featureId).toBe(featureId);
      expect(task.task.acceptance.criteria).toEqual(['任务二验收']);
      expect(task.task.configSourceKey).toBe('defaultStrategy');
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('Phase 创建结果经线校验器复核，重放返回原回执', async () => {
    const s = await setupWired('phase');
    try {
      const registered = asCompleted(
        await s.client.submitCommand({
          operation: 'project.register',
          scope: { kind: 'registration' },
          payload: { repositoryPath: s.box.repoDirA, displayName: 'F-009 phase', labels: [] },
        }),
      );
      const projectId = (registered.result as { project: { id: string } }).project.id;
      const input = { projectId, id: 'phase-r', title: '重放阶段', description: null, labels: [] };
      const created = asCompleted(await s.client.createPhase(input));
      const result = validatePhaseCreateResultWire(created.result);
      expect(result.phase).toMatchObject({ id: 'phase-r', projectId, revision: 1 });
      const replayed = asCompleted(
        await s.client.createPhase({ ...input }, { commandId: created.commandId, issuedAt: created.issuedAt }),
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(created.resultRef);
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * B. 版本与路由负例（明确拒绝，不猜测降级）
 * ------------------------------------------------------------------ */

describe('F-009 线消息升级与旧客户端明确拒绝（现为 v5，旧 v4/v3/v2/v1 明确拒绝）', () => {
  it('握手对 v4/v3/v2/v1 明确 400 unsupported_schema_version（不跨越认证暴露版本）', async () => {
    const s = await setupWired('legacy');
    try {
      for (const legacyVersion of [4, 3, 2, 1]) {
        const legacy = await loopbackRequest({
          port: s.port,
          method: 'POST',
          path: '/v1/host/handshake',
          token: s.token,
          body: {
            schemaVersion: legacyVersion,
            protocolVersion: 1,
            hostInstanceId: s.host.hostInstanceId,
            dataRootIdentity: s.host.dataRootIdentity,
          },
        });
        expect(legacy.statusCode, `v${legacyVersion} 握手必须明确拒绝`).toBe(400);
        expect((legacy.json() as { error?: { code?: string } }).error?.code).toBe(
          'unsupported_schema_version',
        );
      }
      // 无 token 的旧版握手先 401（版本门禁不越过认证）。
      const noAuth = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: '/v1/host/handshake',
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: s.host.hostInstanceId,
          dataRootIdentity: s.host.dataRootIdentity,
        },
      });
      expect(noAuth.statusCode).toBe(401);
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('命令信封 schemaVersion=3 在认证后 400 unsupported_schema_version', async () => {
    const s = await setupWired('legacy-cmd');
    try {
      const legacy = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: '/v1/commands',
        token: s.token,
        body: {
          schemaVersion: 3,
          commandId: randomUUID(),
          operation: 'phase.create',
          scope: { kind: 'project', projectId: 'phase-legacy' },
          issuedAt: new Date().toISOString(),
          payload: { title: '旧版本' },
        },
      });
      expect(legacy.statusCode).toBe(400);
      expect((legacy.json() as { error?: { code?: string } }).error?.code).toBe(
        'unsupported_schema_version',
      );
    } finally {
      await s.dispose();
    }
  }, 30_000);

  it('计划查询路由负例：认证/参数白名单/分页/游标/未知路由', async () => {
    const s = await setupWired('negatives');
    try {
      const { projectId } = await s.seedProjectWithPhase('phase-n');
      // 缺 token → 401。
      const unauthenticated = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases?projectId=${projectId}`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      // 缺 projectId → 400 missing_project_id。
      const missingParent = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: '/v1/phases',
        token: s.token,
      });
      expect(missingParent.statusCode).toBe(400);
      expect((missingParent.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'missing_project_id',
      );
      // 未知查询参数 → 400 unknown_query_parameter。
      const unknownParam = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases?projectId=${projectId}&foo=1`,
        token: s.token,
      });
      expect(unknownParam.statusCode).toBe(400);
      expect((unknownParam.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'unknown_query_parameter',
      );
      // limit 非十进制整数文本 → 400 invalid_integer（传输层）。
      const badLimit = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases?projectId=${projectId}&limit=abc`,
        token: s.token,
      });
      expect(badLimit.statusCode).toBe(400);
      expect((badLimit.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'invalid_integer',
      );
      // limit 越界（>200）→ 400 invalid_input（Core 单一权威）。
      const overflowLimit = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases?projectId=${projectId}&limit=201`,
        token: s.token,
      });
      expect(overflowLimit.statusCode).toBe(400);
      // 坏游标 → 400 invalid_cursor（Core），绝不当从零读取。
      const badCursor = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases?projectId=${projectId}&cursor=not-a-plan-cursor`,
        token: s.token,
      });
      expect(badCursor.statusCode).toBe(400);
      expect((badCursor.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'invalid_cursor',
      );
      // 未知详情 ID → 404 not_found（plan_entity_not_found）。
      const missingEntity = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: '/v1/phases/phase-missing',
        token: s.token,
      });
      expect(missingEntity.statusCode).toBe(404);
      expect((missingEntity.json() as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe(
        'plan_entity_not_found',
      );
      // 未冻结的嵌套形态 → 404 unknown_operation。
      const nested = await loopbackRequest({
        port: s.port,
        method: 'GET',
        path: `/v1/phases/phase-n/features`,
        token: s.token,
      });
      expect(nested.statusCode).toBe(404);
      // POST 到查询路由 → 405。
      const wrongMethod = await loopbackRequest({
        port: s.port,
        method: 'POST',
        path: `/v1/phases?projectId=${projectId}`,
        token: s.token,
        body: {},
      });
      expect(wrongMethod.statusCode).toBe(405);
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * C. HostClient 输入零网络拒绝与线校验器负例
 * ------------------------------------------------------------------ */

describe('F-009 HostClient 计划面输入校验（零网络拒绝）', () => {
  it('公共方法拒绝未知键/非法身份/非法标签目标/非法分页', async () => {
    const s = await setupWired('client-input');
    try {
      const { projectId, phaseId } = await s.seedProjectWithPhase('phase-ci');

      expectProtocolError(
        await rejectionOf(() =>
          s.client.createPhase({
            projectId,
            title: 'x',
            description: null,
            labels: [],
            // @ts-expect-error 未知键必须在零网络阶段拒绝
            approvedBy: 'someone',
          }),
        ),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() =>
          s.client.createPhase({ projectId: 'bad id!', title: 'x' }),
        ),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() =>
          s.client.importFeaturePlan({
            projectId,
            phaseId,
            expectedRevision: 0,
            plan: samplePlan(),
          }),
        ),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() =>
          s.client.updatePlanLabels({
            projectId,
            // @ts-expect-error entityType 只允许 phase/feature/task
            entityType: 'plan',
            id: 't-1',
            expectedRevision: 1,
            labels: [],
          }),
        ),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() => s.client.getPhase('bad id!')),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() => s.client.listPhases(projectId, { limit: 0 })),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() => s.client.listPhases(projectId, { cursor: 'evcur_v1_x' })),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() =>
          s.client.listFeatures(projectId, 'bad id!'),
        ),
        'invalid_input',
      );
      expectProtocolError(
        await rejectionOf(() => s.client.listTasks(projectId, 'bad id!', { limit: 201 })),
        'invalid_input',
      );
      expectProtocolError(await rejectionOf(() => s.client.getTask('bad id!')), 'invalid_input');
    } finally {
      await s.dispose();
    }
  }, 30_000);
});

describe('F-009 计划面线校验器（畸形响应/未知版本拒绝）', () => {
  const phaseRecord = {
    id: 'phase-w',
    projectId: 'proj-w',
    title: '阶段',
    description: null,
    labels: [],
    status: 'open',
    revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
  };

  const taskRecord = {
    id: 't-1',
    projectId: 'proj-w',
    featureId: 'feat-w',
    title: '任务一',
    description: null,
    labels: [],
    status: 'draft',
    complexity: 'low',
    acceptance: { criteria: ['验收'] },
    requirementsRefs: [],
    executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'm' },
    configSource: 'global_default',
    configSourceKey: null,
    revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
  };

  const featureRecord = {
    id: 'feat-w',
    projectId: 'proj-w',
    phaseId: 'phase-w',
    title: 'Feature',
    description: null,
    labels: [],
    status: 'draft',
    planStatus: 'draft',
    planDigest: 'a'.repeat(64),
    sourceRefs: [],
    revision: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
  };

  it('phases.list 正例通过；未知版本/未知键/坏 scope/坏游标前缀/坏记录拒绝', async () => {
    const page = validateAppQueryResponse('phases.list', {
      schemaVersion: 5,
      scope: 'phase-list',
      records: [phaseRecord],
      nextCursor: null,
      limit: 50,
    });
    expect(page.records[0].id).toBe('phase-w');

    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('phases.list', {
          schemaVersion: 3,
          scope: 'phase-list',
          records: [],
          nextCursor: null,
          limit: 50,
        }),
      ),
      'unsupported_schema_version',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('phases.list', {
          schemaVersion: 5,
          scope: 'phase-list',
          records: [],
          nextCursor: null,
          limit: 50,
          extra: 1,
        }),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('phases.list', {
          schemaVersion: 5,
          scope: 'project-list',
          records: [],
          nextCursor: null,
          limit: 50,
        }),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('phases.list', {
          schemaVersion: 5,
          scope: 'phase-list',
          records: [],
          nextCursor: 'evcur_v1_x',
          limit: 50,
        }),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('phases.list', {
          schemaVersion: 5,
          scope: 'phase-list',
          records: [{ ...phaseRecord, revision: 'one' }],
          nextCursor: null,
          limit: 50,
        }),
      ),
      'response_malformed',
    );
  });

  it('features.get：完整 DAG 形状通过；缺字段/未知不可执行原因拒绝', async () => {
    const detail = validateAppQueryResponse('features.get', {
      feature: featureRecord,
      validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
      notExecutableReasons: ['plan_not_approved'],
      tasks: [taskRecord],
      dependencies: [],
    });
    expect(detail.feature.id).toBe('feat-w');
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('features.get', {
          feature: featureRecord,
          validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
          notExecutableReasons: ['not_a_reason'],
          tasks: [taskRecord],
          dependencies: [],
        }),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('features.get', {
          feature: featureRecord,
          validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
          notExecutableReasons: [],
          tasks: [taskRecord],
        }),
      ),
      'response_malformed',
    );
  });

  it('tasks.get/phases.get 坏记录拒绝；task 记录坏策略来源/坏引用拒绝', async () => {
    expectProtocolError(
      await rejectionOf(() => validateAppQueryResponse('phases.get', { phase: { ...phaseRecord, labels: 'x' } })),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('tasks.get', {
          task: { ...taskRecord, requirementsRefs: [{ artifactId: 'bad id!' }] },
        }),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateAppQueryResponse('tasks.get', {
          task: { ...taskRecord, executionConfig: 'flat' },
        }),
      ),
      'response_malformed',
    );
    // 正例：完整任务详情。
    const detail = validateAppQueryResponse('tasks.get', { task: taskRecord });
    expect(detail.task.configSource).toBe('global_default');
  });

  it('命令结果校验器：正例通过，缺字段/坏形状拒绝', async () => {
    expect(validatePhaseCreateResultWire({ phase: phaseRecord }).phase.id).toBe('phase-w');
    expectProtocolError(await rejectionOf(() => validatePhaseCreateResultWire({ phase: 'x' })), 'response_malformed');

    const importResult = {
      feature: featureRecord,
      tasks: [{ id: 't-1' }],
      validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
    };
    expect(validateFeaturePlanImportResultWire(importResult).feature.id).toBe('feat-w');
    expectProtocolError(
      await rejectionOf(() => validateFeaturePlanImportResultWire({ ...importResult, validation: null })),
      'response_malformed',
    );

    const labelsResult = {
      entityType: 'task',
      id: 't-1',
      labels: ['a'],
      revision: 2,
      updatedAt: '2026-10-11T00:00:00.000Z',
    };
    expect(validatePlanLabelsUpdateResultWire(labelsResult).revision).toBe(2);
    expectProtocolError(
      await rejectionOf(() => validatePlanLabelsUpdateResultWire({ ...labelsResult, entityType: 'plan' })),
      'response_malformed',
    );

    const reviseResult = {
      feature: featureRecord,
      tasks: [{ id: 't-1' }],
      memberChanges: { keptTaskCount: 1, createdTaskCount: 0, removedTaskCount: 0 },
      validation: { taskCount: 1, dependencyEdgeCount: 0, executable: true },
    };
    expect(validateFeaturePlanReviseResultWire(reviseResult).memberChanges.keptTaskCount).toBe(1);
    expectProtocolError(
      await rejectionOf(() =>
        validateFeaturePlanReviseResultWire({ ...reviseResult, memberChanges: { keptTaskCount: -1 } }),
      ),
      'response_malformed',
    );
  });

  it('事件线校验器：新计划事件 payload 冻结形状（与服务端 mapStateEvent 同源）', async () => {
    const envelope = (type: string, aggregateType: string, payload: unknown) => ({
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: 1,
      type,
      scope: { kind: 'project', projectId: 'proj-w' },
      aggregate: { type: aggregateType, id: 'agg-1', revision: 1 },
      occurredAt: '2026-10-11T00:00:00.000Z',
      payload,
    });
    expect(validateStateEventWire(envelope('feature.plan.imported', 'feature', { imported: true })).type).toBe(
      'feature.plan.imported',
    );
    expect(validateStateEventWire(envelope('phase.labels.updated', 'phase', { labelsUpdated: true })).type).toBe(
      'phase.labels.updated',
    );
    expect(validateStateEventWire(envelope('feature.plan.revised', 'feature', { revised: true })).type).toBe(
      'feature.plan.revised',
    );
    expectProtocolError(
      await rejectionOf(() => validateStateEventWire(envelope('feature.plan.imported', 'feature', { imported: false }))),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateStateEventWire(envelope('feature.plan.revised', 'feature', { revised: true, plan: {} })),
      ),
      'response_malformed',
    );
    expectProtocolError(
      await rejectionOf(() =>
        validateStateEventWire(envelope('task.labels.updated', 'task', { labels: ['leak'] })),
      ),
      'response_malformed',
    );
  });
});
