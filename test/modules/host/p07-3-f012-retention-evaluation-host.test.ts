/**
 * P07-3 / F-012 保留评估公开只读路由与保留配置公开接线（真实 Core + HTTP）。
 *
 * 覆盖：
 * - GET /v1/retention/evaluation（retention.evaluation.get）经真实应用传输面
 *   返回完整评估报告：未配置时 policy/thresholds/cleanable 均 not_configured；
 *   经公开 settings.global.create 命令配置保留段后 policy configured、阈值
 *   evaluated（statfs 真实观测临时数据根）、受管扫描真实非负字节；
 * - 保留配置经既有公开配置命令通道（POST /v1/commands）保存并可经
 *   settings.global.get/export 读取（Core/Host 配置通道复用，无新通道）；
 * - 未装配保留评估服务的传输面 501（不冒充观测能力）；
 * - 缺 settings.global.read 能力的受限主体 403；未知查询参数 400；
 * - 评估只读：前后全局配置 revision 不变（评估不产生任何写入）。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  type LifecycleState,
} from '../../../packages/host/src/index.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { CommandReceipt } from '../../../packages/core/src/index.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
  type TestTrustedPrincipal,
} from '../../helpers/p02-2/index.ts';
import { loopbackRequest, type LoopbackResponse } from '../../helpers/host/index.ts';

const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = '5d7a0e1a-5f9a-4a1e-9a11-0a1f2b3c4d5e';
const STUB_ROOT_IDENTITY = 'ab12'.repeat(16);
const STUB_STARTED_AT = '2026-10-29T00:00:00.000Z';
const NOW_ISO = new Date(1_900_000_000_000).toISOString();

let fixture: CommandsTestFixture | undefined;
const fixtures: CommandsTestFixture[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    }
  }
  for (const active of fixtures) {
    active.cleanup();
    expect(active.cleaned).toBe(true);
  }
  fixtures.length = 0;
  fixture = undefined;
});

/** 装配应用路由传输面（与生产同一路由解析/参数纪律；服务来自真实 Core）。 */
async function startAppServer(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
  options: { readonly skipRetention?: boolean } = {},
): Promise<number> {
  let lifecycle: LifecycleState = 'ready';
  const stopController = createHostStopController({
    activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle,
    setLifecycleState: next => {
      lifecycle = next;
    },
    prepareTeardown: () => Promise.resolve(),
    releaseAfterTeardown: () => Promise.resolve(),
  });
  const server = createHostLifecycleServer({
    hostInstanceId: STUB_INSTANCE,
    dataRootIdentity: STUB_ROOT_IDENTITY,
    startedAt: STUB_STARTED_AT,
    pid: 4321,
    authToken: STUB_TOKEN,
    getLifecycleState: () => lifecycle,
    getActivities: () => stopController.getActivities(),
    stop: stopController,
    application: {
      principal,
      commandService: app.commandService,
      queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService,
      onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService,
      baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService,
      ...(options.skipRetention === true ? {} : { retentionEvaluationService: app.retentionEvaluationService }),
      getLifecycleState: () => lifecycle,
    },
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('应用传输面监听地址非法');
  }
  return address.port;
}

function errorOf(response: LoopbackResponse): { code: string; operation?: string; details?: Record<string, unknown> } {
  const body = response.json() as { error?: { code?: string; operation?: string; details?: Record<string, unknown> } };
  if (typeof body.error?.code !== 'string') {
    throw new Error(`响应不是结构化错误体：${response.bodyText.slice(0, 120)}`);
  }
  return body.error as { code: string; operation?: string; details?: Record<string, unknown> };
}

interface EvaluationReport {
  readonly schemaVersion: number;
  readonly operation: string;
  readonly policy: { readonly status: string };
  readonly disk: { readonly status: string };
  readonly thresholds: { readonly status: string };
  readonly cleanable: { readonly status: string };
  readonly referencedRetained: { readonly status: string };
  readonly managedUsage: { readonly areas: readonly { readonly area: string; readonly status: string; readonly bytes?: number }[] };
}

async function setup(options: { readonly skipRetention?: boolean } = {}): Promise<{
  port: number;
  app: CoreApplication;
  post: (body: unknown) => Promise<LoopbackResponse>;
  get: (path: string) => Promise<LoopbackResponse>;
}> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-p73-f012-host-' });
  fixtures.push(fixture);
  const app = await fixture.openApplication();
  const owner = fixture.localOwner();
  const port = await startAppServer(app, owner, options);
  const post = (body: unknown) =>
    loopbackRequest({ port, method: 'POST', path: '/v1/commands', body, token: STUB_TOKEN });
  const get = (path: string) => loopbackRequest({ port, method: 'GET', path, token: STUB_TOKEN });
  return { port, app, post, get };
}

const RETENTION_PAYLOAD = {
  schemaVersion: 2,
  policies: {
    retentionPolicy: {
      evidenceRetentionDays: 14,
      backupRetentionDays: 90,
      maxBackupCount: 3,
      diskMinFreeBytes: 1_048_576,
      diskMinFreePercent: 1,
    },
  },
};

describe('P07-3 / F-012 保留评估公开只读路由', () => {
  it('GET /v1/retention/evaluation：未配置 not_configured；配置后阈值 evaluated 且只读', async () => {
    const { app, post, get } = await setup();
    // 初始：全局配置未创建 → 全维度 not_configured（无默认值注入）。
    const before = await get('/v1/retention/evaluation');
    expect(before.statusCode).toBe(200);
    const beforeReport = before.json() as EvaluationReport;
    expect(beforeReport.schemaVersion).toBe(1);
    expect(beforeReport.operation).toBe('retention.evaluation.get');
    expect(beforeReport.policy.status).toBe('not_configured');
    expect(beforeReport.thresholds.status).toBe('not_configured');
    expect(beforeReport.cleanable.status).toBe('not_configured');
    expect(beforeReport.referencedRetained.status).toBe('not_configured');

    // 经既有公开配置命令通道创建保留段（Core/Host 配置通道复用）。
    const created = await post({
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      issuedAt: NOW_ISO,
      payload: RETENTION_PAYLOAD,
    });
    expect(created.statusCode).toBe(200);
    const receipt = created.json() as CommandReceipt;
    expect(receipt.status).toBe('completed');

    const after = await get('/v1/retention/evaluation');
    expect(after.statusCode).toBe(200);
    const report = after.json() as EvaluationReport;
    expect(report.policy.status).toBe('configured');
    expect(report.disk.status).toBe('observed');
    expect(report.thresholds.status).toBe('evaluated');
    expect(report.thresholds).toHaveProperty('triggers');
    expect(report.cleanable.status).toBe('partial'); // 备份轮换 assessed + 证据引用分析未接线
    expect(report.referencedRetained.status).toBe('partial');
    for (const area of report.managedUsage.areas) {
      expect(['projects', 'staging', 'backups', 'database']).toContain(area.area);
      expect(['observed', 'partial', 'unknown']).toContain(area.status);
      if (area.bytes !== undefined) {
        expect(area.bytes).toBeGreaterThanOrEqual(0);
      }
    }

    // 配置可经既有公开查询通道读取（保留段原样可见）。
    const current = await get('/v1/settings/global');
    expect(current.statusCode).toBe(200);
    const currentBody = current.json() as { payload: { policies?: { retentionPolicy?: unknown } }; revision: number };
    expect(currentBody.payload.policies?.retentionPolicy).toEqual(RETENTION_PAYLOAD.policies.retentionPolicy);
    const exported = await get('/v1/settings/global/export');
    expect(exported.statusCode).toBe(200);
    const exportBody = exported.json() as { current: { policies?: { retentionPolicy?: unknown } } };
    expect(exportBody.current.policies?.retentionPolicy).toEqual(RETENTION_PAYLOAD.policies.retentionPolicy);

    // 评估只读：重复评估不改变全局配置 revision（零写入）。
    await get('/v1/retention/evaluation');
    const afterAgain = await get('/v1/settings/global');
    expect((afterAgain.json() as { revision: number }).revision).toBe(currentBody.revision);
    expect(app.retentionEvaluationService).toBeDefined();
  });

  it('未装配保留评估服务 → 501；未知查询参数 → 400；受限主体 → 403', async () => {
    const { get } = await setup({ skipRetention: true });
    const unsupported = await get('/v1/retention/evaluation');
    expect(unsupported.statusCode).toBe(501);
    expect(errorOf(unsupported).code).toBe('unsupported');

    // 参数纪律：评估不接受任何查询参数。
    const fixture2 = createCommandsTestFixture({ prefix: 'shiploop-p73-f012-host2-' });
    fixtures.push(fixture2);
    const app2 = await fixture2.openApplication();
    const ownerPort = await startAppServer(app2, fixture2.localOwner());
    const badParams = await loopbackRequest({
      port: ownerPort, method: 'GET', path: '/v1/retention/evaluation?limit=5', token: STUB_TOKEN,
    });
    expect(badParams.statusCode).toBe(400);
    expect(errorOf(badParams).details).toMatchObject({ field: 'query.limit', reason: 'unknown_query_parameter' });

    // 缺 settings.global.read 的受限主体不能借评估探测全局磁盘/备份布局。
    const restrictedPort = await startAppServer(app2, fixture2.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'all' },
    }));
    const denied = await loopbackRequest({
      port: restrictedPort, method: 'GET', path: '/v1/retention/evaluation', token: STUB_TOKEN,
    });
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied).code).toBe('forbidden');
  });
});
