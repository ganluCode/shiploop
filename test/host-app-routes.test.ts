/**
 * F-011 Host 应用路由验收（P02-2 契约 §3.2 路由总表、§5 命令/回执、§7 查询、
 * §8 快照、§11.1 装配）——真实 127.0.0.1 HTTP + 真实 SQLite/Git/Core 装配。
 *
 * 覆盖（验收点）：
 * - 注册/项目 CAS/配置写入经 POST /v1/commands 原子提交；重复命令返回同一
 *   回执（replayed:true、同 resultRef、零新增副作用）；resultRef 经授权解析；
 *   completed → 200、业务 rejected → 409/403（响应体仍是回执形状）；
 * - 项目/配置/回执/快照查询路由按冻结字段集返回；分页/标签/有效配置/脱敏导出；
 * - 非法 JSON、超大 body（commands 65 536 / host 16 384 双限额）、未知
 *   Schema/操作、过期命令、非法分页、身份提权字段、错误 token/Host/Origin、
 *   未知方法、未知路由与 quiescing 新变更按契约拒绝且业务状态不变；
 * - Work/Chat/基线等未实现操作 501 unsupported；/v1/events 的完整 SSE 语义
 *   由 F-012 专用测试（host-sse-events.test.ts）覆盖，本文件固定未装配
 *   SSE Hub 的传输面保持 501（防御纵深）；
 *   任意文件读取路由与 path/locator/伪 resultRef 一律不得返回文件内容；
 * - 授权在 Core 应用层：同一 Core 上装配的受限主体 server 跨项目/全局/回执
 *   越权全部拒绝，可见谓词先于分页收窄；
 * - 握手 schemaVersion=2 + §11.3 结构化能力（命令/查询真实清单、F-012 起
 *   events 为 SSE 结构化视图）；旧 v1 握手 400；真实 startHost 端到端接线
 *   local-owner。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  startHost,
  validateHandshakeResponse,
  type LifecycleState,
} from '../packages/host/src/index.ts';
import type { CommandReceipt } from '../packages/core/src/index.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
  type TestTrustedPrincipal,
} from './helpers/p02-2/index.ts';
import { initGitRepo, commitAll } from './helpers/git-repo.ts';
import {
  createIsolatedHostEnvironment,
  loopbackRequest,
  type IsolatedHostEnvironment,
  type LoopbackResponse,
} from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRED_ISO = new Date(NOW - 120_000).toISOString();
const FUTURE_ISO = new Date(NOW + 120_000).toISOString();

const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10';
const STUB_ROOT_IDENTITY = '9f2a'.repeat(16);
const STUB_STARTED_AT = '2026-10-05T00:00:00.000Z';

let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    }
  }
  await environment?.dispose();
  environment = undefined;
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

interface AppServer {
  readonly port: number;
  setLifecycle(next: LifecycleState): void;
}

/** 装配应用路由传输面：真实 Core 窄服务 + 固定可信 principal（测试绑定）。 */
async function startAppServer(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
): Promise<AppServer> {
  let lifecycle: LifecycleState = 'ready';
  const stopController = createHostStopController({
    activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle,
    setLifecycleState: (next) => {
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
  return {
    port: address.port,
    setLifecycle: (next) => {
      lifecycle = next;
    },
  };
}

function errorOf(response: LoopbackResponse): {
  code: string;
  operation?: string;
  details?: Record<string, unknown>;
} {
  const body = response.json() as { error?: { code?: string; operation?: string; details?: Record<string, unknown> } };
  if (typeof body.error?.code !== 'string') {
    throw new Error(`响应不是结构化错误体：${response.bodyText.slice(0, 120)}`);
  }
  return body.error as { code: string; operation?: string; details?: Record<string, unknown> };
}

function receiptOf(response: LoopbackResponse): CommandReceipt {
  const body = response.json() as CommandReceipt;
  if (body === null || typeof body !== 'object' || typeof body.commandId !== 'string') {
    throw new Error('响应不是回执形状');
  }
  return body;
}

async function setup() {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f011-' });
  const box = fixture;
  const app = await box.openApplication();
  const probe = box.openProbe();
  const owner = box.localOwner();
  const server = await startAppServer(app, owner);
  // token 缺省为合法凭据；显式 null 表示不带认证头。
  const post = (path: string, body: unknown, token: string | null = STUB_TOKEN) =>
    loopbackRequest({ port: server.port, method: 'POST', path, body, ...(token === null ? {} : { token }) });
  const get = (path: string, token: string | null = STUB_TOKEN) =>
    loopbackRequest({ port: server.port, method: 'GET', path, ...(token === null ? {} : { token }) });
  const registerEnvelope = (
    repoDir: string,
    name: string,
    options: { payload?: Record<string, unknown>; envelope?: Record<string, unknown> } = {},
  ) => ({
    schemaVersion: 2,
    commandId: randomUUID(),
    operation: 'project.register',
    scope: { kind: 'registration' },
    issuedAt: NOW_ISO,
    payload: {
      repositoryPath: repoDir,
      displayName: name,
      ...(options.payload ?? {}),
    },
    ...(options.envelope ?? {}),
  });
  return { box, app, probe, owner, server, post, get, registerEnvelope };
}

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
};

describe('F-011 命令路由：注册/元数据/配置纵向（真实 HTTP + SQLite + Git）', () => {
  it('注册命令 200 completed：回执/事件/项目原子提交，resultRef 可授权解析', async () => {
    const s = await setup();
    const envelope = s.registerEnvelope(s.box.repoDirA, 'Repo A');
    const response = await s.post('/v1/commands', envelope);
    expect(response.statusCode).toBe(200);
    const receipt = receiptOf(response);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      commandId: envelope.commandId,
      principalId: 'local-owner',
      operation: 'project.register',
      scope: { kind: 'registration' },
      status: 'completed',
      replayed: false,
      issuedAt: NOW_ISO,
    });
    if (receipt.status !== 'completed') throw new Error('expected completed');
    const result = receipt.result as { status: string; project: { id: string; revision: number }; binding: { canonicalPath: string } };
    expect(result.status).toBe('registered');
    // 持久四件套（独立只读连接核对）。
    expect(s.probe.counts()).toMatchObject({
      projects: 1,
      repository_bindings: 1,
      state_events: 1,
      command_receipts: 1,
    });

    // 同信封重发：同一稳定回执，零新增副作用。
    const replay = await s.post('/v1/commands', envelope);
    expect(replay.statusCode).toBe(200);
    const replayed = receiptOf(replay);
    expect(replayed).toMatchObject({ status: 'completed', replayed: true });
    if (replayed.status !== 'completed') throw new Error('expected completed');
    expect(replayed.resultRef).toBe(receipt.resultRef);
    expect(replayed.result).toEqual(receipt.result);
    expect(s.probe.counts()).toMatchObject({ projects: 1, state_events: 1, command_receipts: 1 });

    // 回执与结果引用读取（授权 = 本 principal）。
    const fetched = await s.get(`/v1/receipts/${envelope.commandId}`);
    expect(fetched.statusCode).toBe(200);
    expect(receiptOf(fetched)).toMatchObject({ commandId: envelope.commandId, status: 'completed', replayed: false });
    const resolved = await s.get(`/v1/results/${receipt.resultRef}`);
    expect(resolved.statusCode).toBe(200);
    const resolvedReceipt = receiptOf(resolved);
    if (resolvedReceipt.status !== 'completed') throw new Error('expected completed');
    expect(resolvedReceipt.result).toEqual(receipt.result);
  });

  it('同 commandId 不同参数 → 409 conflict（idempotency_key_reuse），业务不变', async () => {
    const s = await setup();
    const envelope = s.registerEnvelope(s.box.repoDirA, 'Repo A');
    expect((await s.post('/v1/commands', envelope)).statusCode).toBe(200);
    const conflict = await s.post('/v1/commands', {
      ...envelope,
      payload: { repositoryPath: s.box.repoDirA, displayName: 'Renamed' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict)).toMatchObject({
      code: 'conflict',
      operation: 'project.register',
      details: { reason: 'idempotency_key_reuse' },
    });
    expect(s.probe.counts()).toMatchObject({ projects: 1, command_receipts: 1 });
  });

  it('元数据 CAS 更新 200；过期 revision 新命令 409 rejected 回执且对象/事件不变', async () => {
    const s = await setup();
    const registered = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A')));
    if (registered.status !== 'completed') throw new Error('expected completed');
    const project = (registered.result as { project: { id: string; revision: number } }).project;

    const updateEnvelope = {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId: project.id },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { displayName: 'Repo A2', labels: ['core'] },
    };
    const updated = await s.post('/v1/commands', updateEnvelope);
    expect(updated.statusCode).toBe(200);
    expect(receiptOf(updated)).toMatchObject({ status: 'completed', operation: 'project.metadata.update' });
    expect(s.probe.projectRow(project.id)).toMatchObject({ display_name: 'Repo A2', revision: 2 });

    // 过期 revision（新 commandId）：409，响应体为 rejected 回执形状。
    const stale = await s.post('/v1/commands', {
      ...updateEnvelope,
      commandId: randomUUID(),
      payload: { displayName: 'Stale' },
    });
    expect(stale.statusCode).toBe(409);
    const staleReceipt = receiptOf(stale);
    expect(staleReceipt).toMatchObject({ status: 'rejected', replayed: false });
    if (staleReceipt.status !== 'rejected') throw new Error('expected rejected');
    expect(staleReceipt.error.code).toBe('conflict');
    expect(staleReceipt.error.details).toMatchObject({ expectedRevision: 1, actualRevision: 2 });
    expect(s.probe.projectRow(project.id)).toMatchObject({ display_name: 'Repo A2', revision: 2 });
    // 事件恰两条（registered + metadata_updated），拒绝不产生第三条。
    expect(s.probe.counts().state_events).toBe(2);
    // rejected 回执经 GET /v1/receipts 读取仍是同一形状（读取恒 200）。
    const fetched = await s.get(`/v1/receipts/${staleReceipt.commandId}`);
    expect(fetched.statusCode).toBe(200);
    expect(receiptOf(fetched)).toMatchObject({ status: 'rejected', replayed: false });
  });

  it('全局/项目配置创建与 CAS 更新经 HTTP；有效配置/导出/当前值查询一致', async () => {
    const s = await setup();
    const created = await s.post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      issuedAt: NOW_ISO,
      payload: GLOBAL_PAYLOAD,
    });
    expect(created.statusCode).toBe(200);
    expect(receiptOf(created)).toMatchObject({ status: 'completed', operation: 'settings.global.create' });

    const current = await s.get('/v1/settings/global');
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      scope: { kind: 'global' },
      schemaVersion: 2,
      revision: 1,
      payload: GLOBAL_PAYLOAD,
    });

    // CAS 更新。
    const updated = await s.post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'settings.global.update',
      scope: { kind: 'global' },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { ...GLOBAL_PAYLOAD, policies: { executionLimits: { maxConcurrentWorks: 1 } } },
    });
    expect(updated.statusCode).toBe(200);
    const afterUpdate = await s.get('/v1/settings/global');
    expect(afterUpdate.json()).toMatchObject({ revision: 2 });

    // 重复创建（新 commandId）→ 409 rejected already_exists。
    const duplicate = await s.post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      issuedAt: NOW_ISO,
      payload: GLOBAL_PAYLOAD,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(receiptOf(duplicate)).toMatchObject({ status: 'rejected' });

    // 项目配置 + 有效配置 + 导出。
    const registered = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A')));
    if (registered.status !== 'completed') throw new Error('expected completed');
    const projectId = (registered.result as { project: { id: string } }).project.id;
    const projectCreated = await s.post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'settings.project.create',
      scope: { kind: 'project', projectId },
      issuedAt: NOW_ISO,
      payload: { schemaVersion: 2, strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } } },
    });
    expect(projectCreated.statusCode).toBe(200);
    const projectCurrent = await s.get(`/v1/projects/${projectId}/settings`);
    expect(projectCurrent.statusCode).toBe(200);
    expect(projectCurrent.json()).toMatchObject({ scope: { kind: 'project', projectId }, revision: 1 });
    const effective = await s.get(`/v1/projects/${projectId}/settings/effective`);
    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({ configured: true, schemaVersion: 2 });
    const exported = await s.get(`/v1/projects/${projectId}/settings/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ exportFormatVersion: 1 });
    expect(exported.bodyText).not.toContain(STUB_TOKEN);
  });
});

describe('F-011 查询与快照路由', () => {
  it('项目列表分页/标签过滤/标签计数/详情/绑定读取（含分页游标）', async () => {
    const s = await setup();
    const receiptA = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A', { payload: { labels: ['team', 'core'] } })));
    const receiptB = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirB, 'Repo B', { payload: { labels: ['team'] } })));
    if (receiptA.status !== 'completed' || receiptB.status !== 'completed') throw new Error('expected completed');
    const idA = (receiptA.result as { project: { id: string } }).project.id;
    const idB = (receiptB.result as { project: { id: string } }).project.id;

    const page1 = await s.get('/v1/projects?limit=1');
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json() as { records: { id: string }[]; nextCursor: string | null; limit: number; schemaVersion: number; scope: string };
    expect(page1Body).toMatchObject({ schemaVersion: 2, scope: 'project-list', limit: 1 });
    expect(page1Body.records).toHaveLength(1);
    expect(page1Body.nextCursor).not.toBeNull();
    const page2 = await s.get(`/v1/projects?limit=1&cursor=${page1Body.nextCursor}`);
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json() as { records: { id: string }[]; nextCursor: string | null };
    expect(page2Body.records).toHaveLength(1);
    expect(page2Body.records[0]!.id).not.toBe(page1Body.records[0]!.id);
    expect(page2Body.nextCursor).toBeNull();

    // 标签 any/all。
    const any = await s.get('/v1/projects?label=core');
    expect((any.json() as { records: unknown[] }).records).toHaveLength(1);
    const all = await s.get('/v1/projects?label=team&label=core&match=all');
    expect((all.json() as { records: { id: string }[] }).records.map((r) => r.id)).toEqual([idA]);
    const counts = await s.get('/v1/projects/label-counts');
    expect(counts.statusCode).toBe(200);
    expect(counts.json()).toEqual({
      labels: [
        { label: 'core', projectCount: 1 },
        { label: 'team', projectCount: 2 },
      ],
    });

    // 详情与绑定。
    const detail = await s.get(`/v1/projects/${idB}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      project: { id: idB, displayName: 'Repo B', labels: ['team'] },
      binding: { projectId: idB },
    });
    const binding = await s.get(`/v1/projects/${idA}/repository-binding`);
    expect(binding.statusCode).toBe(200);
    expect(binding.json()).toMatchObject({ binding: { projectId: idA } });

    // 未知但合法形态的项目 id → 403 forbidden（不区分不存在/不可见）。
    const missing = await s.get(`/v1/projects/${randomUUID()}`);
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing).code).toBe('forbidden');
    // 非法形态 → 400 且不做任何查询（不泄漏）。
    const invalid = await s.get('/v1/projects/not%20a%20id!');
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid)).toMatchObject({ code: 'invalid_input' });
  });

  it('快照：项目/全局 scope 同一读视图内容 + 水位游标；无配置明确 null/404', async () => {
    const s = await setup();
    const registered = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A')));
    if (registered.status !== 'completed') throw new Error('expected completed');
    const projectId = (registered.result as { project: { id: string } }).project.id;

    const projectSnap = await s.get(`/v1/snapshot?scope=project&projectId=${projectId}`);
    expect(projectSnap.statusCode).toBe(200);
    const snapBody = projectSnap.json() as {
      schemaVersion: number;
      scope: { kind: string; projectId: string };
      project: { id: string };
      binding: { projectId: string } | null;
      settings: unknown;
      effective: { configured: boolean };
      watermark: { sequence: number; cursor: string };
      readAt: string;
    };
    expect(snapBody.schemaVersion).toBe(2);
    expect(snapBody.scope).toEqual({ kind: 'project', projectId });
    expect(snapBody.project.id).toBe(projectId);
    expect(snapBody.binding?.projectId).toBe(projectId);
    expect(snapBody.settings).toBeNull();
    expect(snapBody.effective.configured).toBe(false);
    expect(snapBody.watermark.sequence).toBeGreaterThanOrEqual(1);
    expect(snapBody.watermark.cursor.startsWith('evcur_v1_')).toBe(true);

    const globalSnap = await s.get('/v1/snapshot?scope=global');
    expect(globalSnap.statusCode).toBe(200);
    expect(globalSnap.json()).toMatchObject({ schemaVersion: 2, scope: { kind: 'global' }, settings: null });

    // 无配置当前值 → 404 not_found（与损坏严格区分，不降级为已配置）。
    const unset = await s.get('/v1/settings/global');
    expect(unset.statusCode).toBe(404);
    expect(errorOf(unset).code).toBe('not_found');

    // 未知项目快照 → 403（不区分不存在/不可见）。
    const missingSnap = await s.get(`/v1/snapshot?scope=project&projectId=${randomUUID()}`);
    expect(missingSnap.statusCode).toBe(403);
  });

  it('非法分页/未知查询参数/重复参数/超长查询串 → 400，业务状态不变', async () => {
    const s = await setup();
    const cases: Array<[string, string]> = [
      ['/v1/projects?limit=0', 'limit 下限'],
      ['/v1/projects?limit=201', 'limit 上限'],
      ['/v1/projects?limit=1.5', 'limit 小数'],
      ['/v1/projects?limit=abc', 'limit 非数字'],
      ['/v1/projects?limit=1&limit=2', '重复 limit'],
      ['/v1/projects?unknown=1', '未知参数'],
      ['/v1/projects?cursor=bad%20id', '非法游标'],
      ['/v1/projects?match=some', '非法 match'],
      ['/v1/snapshot', '缺 scope'],
      ['/v1/snapshot?scope=work', '未知 scope'],
      ['/v1/snapshot?scope=global&projectId=x', 'global 带 projectId'],
      [`/v1/snapshot?scope=project`, 'project 缺 projectId'],
      [`/v1/projects?label=${'x'.repeat(8_200)}`, '查询串超限'],
    ];
    for (const [path, label] of cases) {
      const response = await s.get(path);
      expect(response.statusCode, `${label} 应 400`).toBe(400);
      expect(errorOf(response).code, label).toBe('invalid_input');
    }
    expect(s.probe.counts()).toMatchObject({ projects: 0, state_events: 0, command_receipts: 0 });
  });
});

describe('F-011 回执/结果读取与拒绝语义', () => {
  it('未知回执 404；非法 commandId/伪 resultRef/路径形态 400；表外文件路由 404', async () => {
    const s = await setup();
    const receipt = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A')));
    if (receipt.status !== 'completed') throw new Error('expected completed');

    const missingReceipt = await s.get(`/v1/receipts/${randomUUID()}`);
    expect(missingReceipt.statusCode).toBe(404);
    expect(errorOf(missingReceipt)).toMatchObject({ code: 'not_found', operation: 'receipts.get' });

    const invalidCommandId = await s.get('/v1/receipts/not-a-uuid');
    expect(invalidCommandId.statusCode).toBe(400);
    expect(errorOf(invalidCommandId).code).toBe('invalid_input');

    // 合法形态但不存在的 resultRef → 404（不区分不存在与无权）。
    const fakeRef = `v1.${'A'.repeat(43)}`;
    const unknownRef = await s.get(`/v1/results/${fakeRef}`);
    expect(unknownRef.statusCode).toBe(404);
    expect(errorOf(unknownRef).code).toBe('not_found');

    // 伪 resultRef（路径形态/遍历）→ 400/404，绝不返回文件内容。
    for (const path of [
      '/v1/results/..%2F..%2Fetc%2Fpasswd',
      '/v1/results/%2Fetc%2Fpasswd',
      '/v1/results/v1.short',
    ]) {
      const response = await s.get(path);
      expect([400, 404]).toContain(response.statusCode);
      expect(response.bodyText).not.toContain('root:');
    }

    // 表外路径（任意文件读取形态）一律 404 unknown_operation。
    for (const path of ['/v1/files?path=/etc/passwd', '/v1/artifacts/abc/content']) {
      const response = await s.get(path);
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('unknown_operation');
      expect(response.bodyText).not.toContain('root:');
    }
    // 绝对路径/穿越形态的项目 id：路由内参数校验 400 或路由缺失 404，均无文件内容。
    for (const path of ['/v1/projects/..%2F..%2Fetc', '/v1/projects/%2Fetc%2Fpasswd']) {
      const response = await s.get(path);
      expect([400, 403, 404]).toContain(response.statusCode);
      expect(response.bodyText).not.toContain('root:');
    }
  });
});

describe('F-011 传输纪律与版本门禁', () => {
  it('未结束的 chunked 请求超限后立即返回 413，不等待客户端 end', async () => {
    const s = await setup();
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        client = httpRequest({
          hostname: '127.0.0.1', port: s.server.port, method: 'POST',
          path: '/v1/commands',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STUB_TOKEN}` },
        }, response => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
          response.on('error', reject);
        });
        client.on('error', reject);
        client.setTimeout(2000, () => client?.destroy(new Error('超限请求未及时拒绝')));
        client.write('x'.repeat(70_000));
        // Deliberately don't end the request: rejection must not depend on end.
      });
      expect(status).toBe(413);
    } finally {
      client?.destroy();
    }
  });

  it('畸形 JSON/超大 body/错误 content-type/GET 带体/未知方法明确拒绝', async () => {
    const s = await setup();
    const malformed = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/commands',
      token: STUB_TOKEN,
      rawBody: '{oops',
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed)).toMatchObject({ code: 'invalid_input', operation: 'commands.submit' });

    const wrongType = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/commands',
      token: STUB_TOKEN,
      rawBody: '{}',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(wrongType.statusCode).toBe(400);

    const oversized = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/commands',
      token: STUB_TOKEN,
      rawBody: `{"pad":"${'x'.repeat(70_000)}"}`,
    });
    expect(oversized.statusCode).toBe(413);
    expect(errorOf(oversized).code).toBe('request_too_large');

    // /v1/host/* 仍保持 16 384 限额（P02-1 不变）。
    const hostOversized = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/host/handshake',
      token: STUB_TOKEN,
      rawBody: `{"pad":"${'x'.repeat(20_000)}"}`,
    });
    expect(hostOversized.statusCode).toBe(413);

    const getWithBody = await loopbackRequest({
      port: s.server.port,
      method: 'GET',
      path: '/v1/projects',
      token: STUB_TOKEN,
      body: {},
    });
    expect(getWithBody.statusCode).toBe(400);

    const wrongMethod = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/projects',
      token: STUB_TOKEN,
      body: {},
    });
    expect(wrongMethod.statusCode).toBe(405);
    expect(errorOf(wrongMethod).details?.allowedMethods).toEqual(['GET']);

    expect(s.probe.counts()).toMatchObject({ projects: 0, command_receipts: 0 });
  });

  it('错误 token/Origin/Host 头 → 401（子原因不可区分，不回显凭据）', async () => {
    const s = await setup();
    const noToken = await s.get('/v1/projects', null);
    expect(noToken.statusCode).toBe(401);
    const wrongToken = await s.get('/v1/projects', randomBytes(32).toString('hex'));
    expect(wrongToken.statusCode).toBe(401);
    const withOrigin = await loopbackRequest({
      port: s.server.port,
      method: 'GET',
      path: '/v1/projects',
      token: STUB_TOKEN,
      headers: { Origin: 'https://evil.example' },
    });
    expect(withOrigin.statusCode).toBe(401);
    const wrongHost = await loopbackRequest({
      port: s.server.port,
      method: 'GET',
      path: '/v1/projects',
      token: STUB_TOKEN,
      headers: { Host: 'localhost:1' },
    });
    expect(wrongHost.statusCode).toBe(401);
    for (const response of [noToken, wrongToken, withOrigin, wrongHost]) {
      expect(errorOf(response).code).toBe('unauthorized');
      expect(response.bodyText).not.toContain(STUB_TOKEN);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('信封校验顺序：结构 400 先于凭据；版本/未知操作 400/501 在凭据之后', async () => {
    const s = await setup();
    // 结构非法（缺 commandId）且无 token → 400（结构先于凭据，§5.1）。
    const structural = await s.post('/v1/commands', { schemaVersion: 2, operation: 'project.register' }, null);
    expect(structural.statusCode).toBe(400);
    expect(errorOf(structural).code).toBe('invalid_input');
    // 结构合法但旧版 schema 且无 token → 401（版本门禁不越过认证）。
    const legacyNoAuth = await s.post(
      '/v1/commands',
      s.registerEnvelope(s.box.repoDirA, 'Repo A', { envelope: { schemaVersion: 1 } }),
      null,
    );
    expect(legacyNoAuth.statusCode).toBe(401);
    // 认证后旧版 schema → 400 unsupported_schema_version。
    const legacy = await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A', { envelope: { schemaVersion: 1 } }));
    expect(legacy.statusCode).toBe(400);
    expect(errorOf(legacy).code).toBe('unsupported_schema_version');
    // 认证后未知操作（Work/Chat 候选名）→ 501 + 实际实现清单。
    for (const operation of ['work.submit', 'chat.send', 'baseline.run', 'phase.advance']) {
      const response = await s.post('/v1/commands', {
        schemaVersion: 2,
        commandId: randomUUID(),
        operation,
        scope: { kind: 'global' },
        issuedAt: NOW_ISO,
        payload: {},
      });
      expect(response.statusCode, operation).toBe(501);
      const error = errorOf(response);
      expect(error.code).toBe('unsupported');
      expect(error.details?.supportedOperations).toEqual([
        'project.register',
        'project.metadata.update',
        'settings.global.create',
        'settings.global.update',
        'settings.project.create',
        'settings.project.update',
      ]);
    }
    // actorId/principal 提权字段 → 400 invalid_input（未知键，定位字段）。
    const escalation = await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A', { envelope: { actorId: 'root' } }));
    expect(escalation.statusCode).toBe(400);
    expect(errorOf(escalation)).toMatchObject({ code: 'invalid_input', details: { field: 'actorId' } });
    expect(s.probe.counts()).toMatchObject({ projects: 0, command_receipts: 0 });
  });

  it('过期新命令 400 command_expired 不积回执；未来时钟偏差 400；历史回执仍可重放读取', async () => {
    const s = await setup();
    const envelope = s.registerEnvelope(s.box.repoDirA, 'Repo A');
    expect((await s.post('/v1/commands', envelope)).statusCode).toBe(200);

    const expired = await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirB, 'Repo B', { envelope: { issuedAt: EXPIRED_ISO } }));
    expect(expired.statusCode).toBe(400);
    expect(errorOf(expired)).toMatchObject({ code: 'command_expired', operation: 'project.register' });

    const skewed = await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirB, 'Repo B', { envelope: { issuedAt: FUTURE_ISO } }));
    expect(skewed.statusCode).toBe(400);
    expect(errorOf(skewed)).toMatchObject({ code: 'invalid_input', details: { field: 'issuedAt', reason: 'clock_skew' } });

    // 过期/偏差不积回执、不产生副作用；历史回执重放不受影响。
    expect(s.probe.counts()).toMatchObject({ projects: 1, repository_bindings: 1, state_events: 1, command_receipts: 1 });
    const replay = await s.post('/v1/commands', envelope);
    expect(replay.statusCode).toBe(200);
    expect(receiptOf(replay)).toMatchObject({ status: 'completed', replayed: true });
  });

  it('quiescing 拒绝新变更（503 not_ready）且业务不变；只读查询不受影响', async () => {
    const s = await setup();
    expect((await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A'))).statusCode).toBe(200);
    s.server.setLifecycle('quiescing');
    const rejected = await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirB, 'Repo B'));
    expect(rejected.statusCode).toBe(503);
    expect(errorOf(rejected)).toMatchObject({ code: 'not_ready', operation: 'commands.submit' });
    expect(s.probe.counts()).toMatchObject({ projects: 1, command_receipts: 1 });
    const list = await s.get('/v1/projects');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { records: unknown[] }).records).toHaveLength(1);
  });

  it('/v1/events 未装配 SSE Hub 的传输面：认证后 501（防御纵深），未认证 401，非 GET 405', async () => {
    const s = await setup();
    const unauthenticated = await s.get('/v1/events', null);
    expect(unauthenticated.statusCode).toBe(401);
    const subscribed = await s.get('/v1/events');
    expect(subscribed.statusCode).toBe(501);
    expect(errorOf(subscribed)).toMatchObject({ code: 'unsupported', operation: 'events.subscribe' });
    const posted = await s.post('/v1/events', {});
    expect(posted.statusCode).toBe(405);
  });

  it('查询响应体 65 536 预算：超限 500 internal 且不泄漏业务内容', async () => {
    const s = await setup();
    // 7 个项目 × 4 000 码点描述（UTF-8 ≈ 12 KB/个，回执 result 仍在 16 384 B
    // 预算内）≈ 84 KB 列表响应，超过 65 536 B 查询响应预算。
    for (let index = 0; index < 7; index += 1) {
      const repoDir = join(s.box.root, `bulk-repo-${index}`);
      mkdirSync(repoDir, { recursive: true });
      initGitRepo(repoDir);
      writeFileSync(join(repoDir, 'README.md'), `repo ${index}`, 'utf-8');
      commitAll(repoDir, 'init', { home: s.box.homeDir });
      const created = await s.post('/v1/commands', {
        schemaVersion: 2,
        commandId: randomUUID(),
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: NOW_ISO,
        payload: {
          repositoryPath: repoDir,
          displayName: `Bulk ${index}`,
          description: '描'.repeat(4_000),
        },
      });
      expect(created.statusCode).toBe(200);
    }
    const response = await loopbackRequest({
      port: s.server.port,
      method: 'GET',
      path: '/v1/projects?limit=200',
      token: STUB_TOKEN,
      maxResponseBytes: 1_048_576,
    });
    expect(response.statusCode).toBe(500);
    expect(errorOf(response)).toMatchObject({ code: 'internal', details: { reason: 'response_budget_exceeded' } });
    expect(response.bodyText).not.toContain('描');
    // 收窄分页后仍在预算内，数据可读（预算不破坏合法分页）。
    const narrow = await loopbackRequest({
      port: s.server.port,
      method: 'GET',
      path: '/v1/projects?limit=3',
      token: STUB_TOKEN,
      maxResponseBytes: 1_048_576,
    });
    expect(narrow.statusCode).toBe(200);
    expect((narrow.json() as { records: unknown[] }).records).toHaveLength(3);
  });
});

describe('F-011 授权边界（同一 Core 上的受限主体传输面）', () => {
  it('受限主体：跨项目读写/全局配置/他人回执/全局快照全部拒绝，列表先收窄', async () => {
    const s = await setup();
    const receiptA = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirA, 'Repo A', { payload: { labels: ['team'] } })));
    const receiptB = receiptOf(await s.post('/v1/commands', s.registerEnvelope(s.box.repoDirB, 'Repo B', { payload: { labels: ['core'] } })));
    if (receiptA.status !== 'completed' || receiptB.status !== 'completed') throw new Error('expected completed');
    const idA = (receiptA.result as { project: { id: string } }).project.id;
    const idB = (receiptB.result as { project: { id: string } }).project.id;
    await s.post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'settings.global.create',
      scope: { kind: 'global' },
      issuedAt: NOW_ISO,
      payload: GLOBAL_PAYLOAD,
    });

    // 同一 Core 上装配受限主体传输面（仅可信测试装配；身份绝非请求数据）。
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read', 'project.metadata.write', 'receipts.read'],
      projectScope: s.box.scopeAllowlist([idA]),
    });
    const restrictedServer = await startAppServer(s.app, restricted);
    const get = (path: string) =>
      loopbackRequest({ port: restrictedServer.port, method: 'GET', path, token: STUB_TOKEN });
    const post = (path: string, body: unknown) =>
      loopbackRequest({ port: restrictedServer.port, method: 'POST', path, body, token: STUB_TOKEN });

    // 列表/标签计数只含可见项目 A（可见谓词先于分页收窄）。
    const list = await get('/v1/projects');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { records: { id: string }[] }).records.map((r) => r.id)).toEqual([idA]);
    const counts = await get('/v1/projects/label-counts');
    expect(counts.json()).toEqual({ labels: [{ label: 'team', projectCount: 1 }] });

    // 项目 B：读 403、写 403（不积回执）、绑定 403、配置读 403。
    expect((await get(`/v1/projects/${idB}`)).statusCode).toBe(403);
    expect((await get(`/v1/projects/${idB}/repository-binding`)).statusCode).toBe(403);
    const writeB = await post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId: idB },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { displayName: 'Hijack' },
    });
    expect(writeB.statusCode).toBe(403);
    expect(errorOf(writeB).code).toBe('forbidden');
    expect(writeB.bodyText).not.toContain('Repo B');
    expect(s.probe.projectRow(idB)).toMatchObject({ display_name: 'Repo B', revision: 1 });

    // 可见项目 A 的合法编辑仍 200（同一检查不冤枉合法主体）。
    const writeA = await post('/v1/commands', {
      schemaVersion: 2,
      commandId: randomUUID(),
      operation: 'project.metadata.update',
      scope: { kind: 'project', projectId: idA },
      expectedRevision: 1,
      issuedAt: NOW_ISO,
      payload: { labels: ['team', 'restricted-ok'] },
    });
    expect(writeA.statusCode).toBe(200);

    // 全局读独立授权：无 settings.global.read → 403（含快照全局 scope）。
    expect((await get('/v1/settings/global')).statusCode).toBe(403);
    expect((await get('/v1/settings/global/export')).statusCode).toBe(403);
    expect((await get('/v1/snapshot?scope=global')).statusCode).toBe(403);

    // 他人（local-owner）回执/结果引用 → 404（不区分不存在与无权）。
    expect((await get(`/v1/receipts/${receiptA.commandId}`)).statusCode).toBe(404);
    expect((await get(`/v1/results/${receiptA.resultRef}`)).statusCode).toBe(404);
    // 自己提交的命令回执可读（receipts.read + 本 principal）。
    const ownReceipt = receiptOf(writeA);
    const ownFetch = await get(`/v1/receipts/${ownReceipt.commandId}`);
    expect(ownFetch.statusCode).toBe(200);
    expect(receiptOf(ownFetch).commandId).toBe(ownReceipt.commandId);

    // 全局事件不泄漏给项目级主体：项目快照可见、全局事件不可订阅（F-012 前 501）。
    const snapA = await get(`/v1/snapshot?scope=project&projectId=${idA}`);
    expect(snapA.statusCode).toBe(200);
    const snapB = await get(`/v1/snapshot?scope=project&projectId=${idB}`);
    expect(snapB.statusCode).toBe(403);
  });
});

describe('F-011 握手升版与真实 startHost 端到端装配', () => {
  it('握手 schemaVersion=2 + §11.3 能力视图（真实命令/查询清单，F-012 起 events 结构化 SSE 视图）', async () => {
    const s = await setup();
    const handshake = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/host/handshake',
      token: STUB_TOKEN,
      body: {
        schemaVersion: 2,
        protocolVersion: 1,
        hostInstanceId: STUB_INSTANCE,
        dataRootIdentity: STUB_ROOT_IDENTITY,
      },
    });
    expect(handshake.statusCode).toBe(200);
    const validated = validateHandshakeResponse(handshake.json(), {
      expectedHostInstanceId: STUB_INSTANCE,
      expectedDataRootIdentity: STUB_ROOT_IDENTITY,
    });
    expect(validated.schemaVersion).toBe(2);
    expect(validated.capabilities.application).toEqual({
      commands: [
        'project.register',
        'project.metadata.update',
        'settings.global.create',
        'settings.global.update',
        'settings.project.create',
        'settings.project.update',
      ],
      queries: [
        'projects.list',
        'projects.get',
        'projects.binding.get',
        'projects.labelCounts',
        'settings.global.get',
        'settings.global.export',
        'settings.project.get',
        'settings.project.effective',
        'settings.project.export',
        'receipts.get',
        'results.resolve',
        'snapshot.get',
      ],
      events: { transport: 'sse', route: '/v1/events', scopes: ['project', 'global'] },
    });
    // 旧 v1 握手被明确拒绝（Host/CLI 同仓同版发布，不猜测降级）。
    const legacy = await loopbackRequest({
      port: s.server.port,
      method: 'POST',
      path: '/v1/host/handshake',
      token: STUB_TOKEN,
      body: {
        schemaVersion: 1,
        protocolVersion: 1,
        hostInstanceId: STUB_INSTANCE,
        dataRootIdentity: STUB_ROOT_IDENTITY,
      },
    });
    expect(legacy.statusCode).toBe(400);
    expect(errorOf(legacy).code).toBe('unsupported_schema_version');
  });

  it('真实 startHost：生产装配绑定 local-owner，注册/列表/快照经唯一 /v1 路由完成', async () => {
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f011-e2e-' });
    const { canonicalRoot } = environment.dataRoot('root');
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f011-e2e-repo-' });
    const host = await startHost({
      dataRoot: canonicalRoot,
      capabilityCatalog: fixture.capabilityCatalog,
      env: {},
    });
    try {
      const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
      environment.evidence.registerSecret(token);
      const discovery = JSON.parse(
        readFileSync(join(canonicalRoot, 'host', 'discovery.json'), 'utf8'),
      ) as { hostInstanceId: string };
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: {
          schemaVersion: 2,
          protocolVersion: 1,
          hostInstanceId: discovery.hostInstanceId,
          dataRootIdentity: host.dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);

      // 真实时钟下的命令信封（生产装配使用系统时钟）。
      const nowIso = new Date().toISOString();
      const register = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/commands',
        token,
        body: {
          schemaVersion: 2,
          commandId: randomUUID(),
          operation: 'project.register',
          scope: { kind: 'registration' },
          issuedAt: nowIso,
          payload: { repositoryPath: fixture.repoDirA, displayName: 'E2E Repo' },
        },
      });
      expect(register.statusCode).toBe(200);
      const receipt = receiptOf(register);
      expect(receipt).toMatchObject({ status: 'completed', principalId: 'local-owner' });
      if (receipt.status !== 'completed') throw new Error('expected completed');
      const projectId = (receipt.result as { project: { id: string } }).project.id;

      const list = await loopbackRequest({
        port: host.port,
        method: 'GET',
        path: '/v1/projects',
        token,
      });
      expect((list.json() as { records: { id: string }[] }).records.map((r) => r.id)).toEqual([projectId]);

      const snapshot = await loopbackRequest({
        port: host.port,
        method: 'GET',
        path: `/v1/snapshot?scope=project&projectId=${projectId}`,
        token,
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({
        schemaVersion: 2,
        scope: { kind: 'project', projectId },
        project: { id: projectId },
      });
      // 生产 Host 不经 HostClient 之外暴露会话；CLI 断开（连接关闭）后 Host 存活。
      const status = await loopbackRequest({
        port: host.port,
        method: 'GET',
        path: '/v1/host/status',
        token,
      });
      expect(status.statusCode).toBe(200);
    } finally {
      await host.close();
    }
  });
});
