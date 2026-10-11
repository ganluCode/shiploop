/**
 * F-006 P02-3 静态接入纵向接线验收（契约 §3.2 路由、§7.2/§7.3 查询、
 * §11.2 HostClient、§11.3 握手能力、§12.1/§12.3 CLI）。
 *
 * 定位：把 F-004 的 OnboardingService（projects.inspect/projects.overview）
 * 与 F-005 的纯面层接入既有 HostClient 与 CLI 执行层（runAppCli，与
 * dist/bin.js 同一路径），在真实回环 HTTP、真实 Host 子进程、真实 SQLite 与
 * 真实 Git 仓库变体上完成「先静态预览、显式 --confirm 后经既有
 * project.register 幂等命令注册」的纵向闭环：
 * - HostClient 新方法只访问 §3.2 正式路由并对响应做运行时校验（畸形/未知
 *   版本 → 协议错误，绝不放行）；非法输入零网络拒绝；
 * - Host 路由复用既有认证/传输纪律：握手能力视图精确集合（线消息 v4，P03-1/F-009 起），
 *   inspect 的 path 是唯一例外（仓库根、经 RepositoryInspector 校验），
 *   永不返回文件内容；负例全部结构化拒绝；
 * - CLI 纵向：有 HEAD/无 HEAD/脏仓库先展示静态事实；无 --confirm 得到
 *   not_run 且零副作用；--confirm 才提交注册并返回真实 projectId，健康
 *   状态独立显示尚未检查（not_run/no_baseline）；同规范路径（含别名）
 *   重复 init 返回既有项目不覆盖元数据；相同 commandId 重试重放原回执、
 *   不同参数 conflict；恶意脚本哨兵不存在、源文件摘要不变；
 * - 两个正常客户端连接同一 Host；客户端中断/Host 重启后注册可查、
 *   同信封重发零新增副作用（先查回执再重试）；CLI 不直接打开 SQLite。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME；所有等待有界。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  ensureHostRunning,
  startHost,
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  type HostClient,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import { openStorageProbe, type StorageProbe } from './helpers/p02-2/storage-probe.ts';
import { createBaselineFixture, digestWorkingTree, type BaselineFixture } from './helpers/p02-3/index.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from './helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  loopbackRequest,
  mintHostCredential,
  publishLoopbackDiscovery,
  type IsolatedHostEnvironment,
  type LoopbackResponse,
} from './helpers/host/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 干净树下以 TS 源码运行正式 Host 入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);

const NOW_ISO = '2026-10-10T00:00:00.000Z';
const COMMIT_A40 = '1f0b9a1c1f0b9a1c1f0b9a1c1f0b9a1c1f0b9a1c';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

interface AppInvocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
}

function parseEnvelope(invocation: AppInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function successResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.result.exitCode, invocation.stderr).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(invocation: AppInvocation, exitCode: number, code: string): EnvelopeShape['error'] {
  expect(invocation.result.exitCode, invocation.stderr).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as EnvelopeShape['error'];
  expect(error?.code).toBe(code);
  return error;
}

/** 幂等用例：第一次 init 信封中的注册 projectId。 */
function firstResultRegistrationIdOf(invocation: AppInvocation): string {
  const result = successResult(invocation, 'project.init');
  return (result.registration as { projectId: string }).projectId;
}

function errorOf(response: LoopbackResponse): { code: string; details?: Record<string, unknown> } {
  const body = response.json() as { error?: { code?: unknown; details?: unknown } };
  if (typeof body.error?.code !== 'string') {
    throw new Error('响应不是结构化错误体');
  }
  return body.error as { code: string; details?: Record<string, unknown> };
}

/* ================================================================== *
 * 一、HostClient 新方法（可编排伪服务 + 真实回环 HTTP）
 * ================================================================== */

interface ScriptedObservation {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly bearerPresent: boolean;
}

interface ScriptedServer {
  readonly port: number;
  readonly requests: ScriptedObservation[];
  setBody(body: unknown, status?: number): void;
  close(): Promise<void>;
}

async function startScriptedServer(
  identity: { hostInstanceId: string; dataRootIdentity: string },
): Promise<ScriptedServer> {
  const requests: ScriptedObservation[] = [];
  let body: unknown = {};
  let status = 200;
  const server: Server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const url = request.url ?? '/';
      const queryIndex = url.indexOf('?');
      const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
      const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
      requests.push({
        method: request.method ?? '',
        path,
        query,
        bearerPresent:
          typeof request.headers.authorization === 'string' &&
          request.headers.authorization.startsWith('Bearer '),
      });
      if (path === HANDSHAKE_ROUTE) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            protocolVersion: CURRENT_PROTOCOL_VERSION,
            hostInstanceId: identity.hostInstanceId,
            dataRootIdentity: identity.dataRootIdentity,
            lifecycleState: 'ready',
            startedAt: NOW_ISO,
            capabilities: CURRENT_HOST_CAPABILITIES,
          }),
        );
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        // 尽力收尾。
      }
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  return {
    port: (server.address() as { port: number }).port,
    requests,
    setBody(next: unknown, nextStatus = 200): void {
      body = next;
      status = nextStatus;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

const INSPECTION_BODY = {
  schemaVersion: 3,
  canonicalPath: '/tmp/some/repo',
  repoIdentity: `gitdir-sha256:${'ab'.repeat(32)}`,
  headCommit: COMMIT_A40,
  hasInitialCommit: true,
  hasUncommittedChanges: false,
  alreadyRegistered: null,
  readAt: NOW_ISO,
} as const;

const OVERVIEW_BODY = {
  schemaVersion: 3,
  project: {
    id: 'prj-f006',
    displayName: '演示项目',
    description: null,
    status: 'active',
    labels: ['alpha'],
    repositoryBindingId: 'bind-1',
    revision: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  binding: {
    id: 'bind-1',
    projectId: 'prj-f006',
    canonicalPath: '/tmp/some/repo',
    gitCommonDir: null,
    repoIdentity: `gitdir-sha256:${'ab'.repeat(32)}`,
    revision: 1,
    bindingRevision: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  registration: { status: 'registered' },
  settings: { configured: false },
  health: {
    status: 'not_run',
    lastBaselineOperationId: null,
    lastCompletedAt: null,
    reasonCode: 'no_baseline',
  },
  readAt: NOW_ISO,
} as const;

describe('F-006 HostClient inspectRepository/getProjectOverview（伪服务 + 真实回环 HTTP）', () => {
  let environment: IsolatedHostEnvironment | undefined;
  let server: ScriptedServer | undefined;
  let client: HostClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
    await environment?.dispose();
    environment = undefined;
  });

  async function setupScripted(): Promise<void> {
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-scripted-' });
    const root = environment.dataRoot('scripted');
    const credential = mintHostCredential(root.canonicalRoot);
    environment.evidence.registerSecret(credential.token);
    server = await startScriptedServer({
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
    });
    publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
    client = await connectToHost({ canonicalRoot: root.canonicalRoot });
  }

  it('inspectRepository：GET /v1/projects/inspect?path=…（Bearer），响应过运行时校验', async () => {
    await setupScripted();
    server!.setBody(INSPECTION_BODY);
    const inspection = await client!.inspectRepository('/tmp/some/repo');
    expect(inspection.schemaVersion).toBe(3);
    expect(inspection.canonicalPath).toBe('/tmp/some/repo');
    expect(inspection.headCommit).toBe(COMMIT_A40);
    expect(inspection.alreadyRegistered).toBeNull();
    const seen = server!.requests.find((request) => request.path === '/v1/projects/inspect');
    expect(seen, '必须访问正式 inspect 路由').toBeDefined();
    expect(seen?.method).toBe('GET');
    expect(seen?.bearerPresent).toBe(true);
    expect(seen?.query.startsWith('path=')).toBe(true);
  });

  it('getProjectOverview：GET /v1/projects/:id/overview（Bearer），响应过运行时校验', async () => {
    await setupScripted();
    server!.setBody(OVERVIEW_BODY);
    const overview = await client!.getProjectOverview('prj-f006');
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('not_run');
    const seen = server!.requests.find(
      (request) => request.path === '/v1/projects/prj-f006/overview',
    );
    expect(seen, '必须访问正式 overview 路由').toBeDefined();
    expect(seen?.method).toBe('GET');
    expect(seen?.bearerPresent).toBe(true);
  });

  it('表驱动：畸形/未知版本响应 → response_malformed / unsupported_schema_version', async () => {
    await setupScripted();
    const inspectCases: ReadonlyArray<{
      name: string;
      body: () => Record<string, unknown>;
      code: string;
    }> = [
      { name: '未知字段', body: () => ({ ...INSPECTION_BODY, extra: 1 }), code: 'response_malformed' },
      {
        name: '线消息 v2',
        body: () => ({ ...INSPECTION_BODY, schemaVersion: 2 }),
        code: 'unsupported_schema_version',
      },
      {
        name: '缺 readAt',
        body: () => {
          const { readAt, ...rest } = INSPECTION_BODY;
          void readAt;
          return rest;
        },
        code: 'response_malformed',
      },
      { name: 'headCommit 非 hex', body: () => ({ ...INSPECTION_BODY, headCommit: 'not-a-commit' }), code: 'response_malformed' },
      {
        name: 'alreadyRegistered 缺 projectId',
        body: () => ({ ...INSPECTION_BODY, alreadyRegistered: {} }),
        code: 'response_malformed',
      },
      { name: '脏标记非布尔', body: () => ({ ...INSPECTION_BODY, hasUncommittedChanges: 'yes' }), code: 'response_malformed' },
    ];
    for (const testCase of inspectCases) {
      server!.setBody(testCase.body());
      await expect(client!.inspectRepository('/tmp/some/repo'), testCase.name).rejects.toMatchObject({
        code: testCase.code,
      });
    }
    const overviewCases: ReadonlyArray<{
      name: string;
      body: () => Record<string, unknown>;
      code: string;
    }> = [
      { name: '健康状态枚举外', body: () => ({ ...OVERVIEW_BODY, health: { ...OVERVIEW_BODY.health, status: 'passed' } }), code: 'response_malformed' },
      { name: '注册状态枚举外', body: () => ({ ...OVERVIEW_BODY, registration: { status: 'ok' } }), code: 'response_malformed' },
      {
        name: '已配置缺 revision',
        body: () => ({ ...OVERVIEW_BODY, settings: { configured: true, schemaVersion: 2 } }),
        code: 'response_malformed',
      },
      {
        name: '线消息 v2',
        body: () => ({ ...OVERVIEW_BODY, schemaVersion: 2 }),
        code: 'unsupported_schema_version',
      },
    ];
    for (const testCase of overviewCases) {
      server!.setBody(testCase.body());
      await expect(client!.getProjectOverview('prj-f006'), testCase.name).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });

  it('非法输入零网络拒绝：相对/空/NUL path、非法 projectId', async () => {
    await setupScripted();
    const requestCountBefore = server!.requests.length;
    for (const bad of ['relative/path', '']) {
      await expect(client!.inspectRepository(bad)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(client!.inspectRepository('/tmp/ok\u0000bad')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(client!.getProjectOverview('not a stable id!')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(server!.requests.length, '非法输入不得产生新网络请求').toBe(requestCountBefore);
  });
});

/* ================================================================== *
 * 二、Host inspect/overview 路由与真实握手能力（真实 SQLite + Git）
 * ================================================================== */

describe('F-006 Host inspect/overview 路由与握手能力（真实 Host + SQLite + Git）', () => {
  let fixture: CommandsTestFixture | undefined;
  let baseline: BaselineFixture | undefined;
  const hosts: RunningHost[] = [];

  afterEach(async () => {
    while (hosts.length > 0) {
      const host = hosts.pop();
      if (host !== undefined) {
        await host.close();
      }
    }
    fixture?.cleanup();
    expect(fixture?.cleaned ?? true).toBe(true);
    fixture = undefined;
    await baseline?.dispose();
    baseline = undefined;
  });

  async function startRealHost(dataRoot: string): Promise<{
    token: string;
    port: number;
    hostInstanceId: string;
    dataRootIdentity: string;
  }> {
    const host = await startHost({
      dataRoot,
      capabilityCatalog: fixture!.capabilityCatalog,
      env: {},
    });
    hosts.push(host);
    const token = readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8');
    fixture!.evidence.registerSecret(token);
    return {
      token,
      port: host.port,
      hostInstanceId: host.hostInstanceId,
      dataRootIdentity: host.dataRootIdentity,
    };
  }

  function registerViaHttp(
    port: number,
    token: string,
    repositoryPath: string,
    displayName: string,
  ): Promise<LoopbackResponse> {
    return loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/commands',
      token,
      body: {
        schemaVersion: 4,
        commandId: randomUUID(),
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: new Date().toISOString(),
        payload: { repositoryPath, displayName },
      },
    });
  }

  it('握手：线消息 v4（P03-1/F-009 起）+ 能力视图精确集合新增 projects.inspect/overview；v3/v2/v1 均被拒', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-routes-' });
    const { port, token, hostInstanceId, dataRootIdentity } = await startRealHost(fixture.dataRoot);
    const handshake = await loopbackRequest({
      port,
      method: 'POST',
      path: HANDSHAKE_ROUTE,
      token,
      body: { schemaVersion: 4, protocolVersion: 1, hostInstanceId, dataRootIdentity },
    });
    expect(handshake.statusCode).toBe(200);
    const body = handshake.json() as {
      schemaVersion: number;
      capabilities: { application: { commands: string[]; queries: string[] } };
    };
    expect(body.schemaVersion).toBe(4);
    expect(body.capabilities.application.queries).toContain('projects.inspect');
    expect(body.capabilities.application.queries).toContain('projects.overview');
    // F-014：基线分页/详情/证据正文三项查询随路由接线进入能力清单。
    expect(body.capabilities.application.queries).toContain('baselines.list');
    expect(body.capabilities.application.queries).toContain('baselines.get');
    expect(body.capabilities.application.queries).toContain('artifacts.get');
    // P03-1 / F-009：计划域六项查询随 /v1/phases|features|tasks 路由接线进入能力清单（17 → 23）。
    expect(body.capabilities.application.queries).toContain('phases.list');
    expect(body.capabilities.application.queries).toContain('tasks.get');
    expect(body.capabilities.application.queries).toHaveLength(23);
    expect(body.capabilities.application.commands).toEqual([
      'project.register',
      'project.metadata.update',
      'settings.global.create',
      'settings.global.update',
      'settings.project.create',
      'settings.project.update',
      // P02-3：基线 preview/run（F-008）与 cancel（F-014）经既有 /v1/commands 路由真实接线。
      'baseline.preview',
      'baseline.run',
      'baseline.cancel',
      // P03-1 / F-004：Phase 创建经既有 /v1/commands 通用路由接线（集合在 v3 内增量扩张）。
      'phase.create',
      // P03-1 / F-005：计划导入经既有 /v1/commands 通用路由接线（v3 内增量扩张，同 F-004 先例）。
      'feature.plan.import',
      // P03-1 / F-007：纯标签 CAS 编辑经既有 /v1/commands 通用路由接线（v3 内增量扩张）。
      'plan.labels.update',
      // P03-1 / F-008：实质计划修订经既有 /v1/commands 通用路由接线（v3 内增量扩张）。
      'feature.plan.revise',
      // P03-2 / F-001：Task 策略副本 CAS 编辑经既有 /v1/commands 通用路由接线
      //（v4 内增量扩张，同 F-004 先例；升版待 F-007 接线任务定案）。
      'task.strategy.update',
      // P03-2 / F-002：计划批准/拒绝决策经既有 /v1/commands 通用路由接线
      //（v4 内增量扩张；决策查询路由与 HostClient 入口属 F-007）。
      'feature.plan.decide',
      // P03-2 / F-006：执行输入制品组准备经既有 /v1/commands 通用路由接线
      //（v4 内增量扩张；HostClient/CLI 入口属 F-007/F-008）。
      'execution.input.prepare',
    ]);
    for (const legacyVersion of [3, 2, 1]) {
      const legacy = await loopbackRequest({
        port,
        method: 'POST',
        path: HANDSHAKE_ROUTE,
        token,
        body: { schemaVersion: legacyVersion, protocolVersion: 1, hostInstanceId, dataRootIdentity },
      });
      expect(legacy.statusCode, `v${legacyVersion} 握手必须明确拒绝`).toBe(400);
      expect(errorOf(legacy).code).toBe('unsupported_schema_version');
    }
  });

  it('inspect：真实 Git 仓库事实（有 HEAD/无 HEAD/脏）+ 注册后 alreadyRegistered（含别名）', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-inspect-' });
    baseline = createBaselineFixture({ prefix: 'shiploop-f006-inspect-repos-' });
    const repos = baseline.repos;
    const { port, token } = await startRealHost(fixture.dataRoot);

    const inspect = async (path: string): Promise<LoopbackResponse> =>
      loopbackRequest({
        port,
        method: 'GET',
        path: `/v1/projects/inspect?path=${encodeURIComponent(path)}`,
        token,
      });

    const head = await inspect(repos.withHead);
    expect(head.statusCode).toBe(200);
    const headBody = head.json() as Record<string, unknown>;
    expect(headBody.schemaVersion).toBe(3);
    expect(headBody.canonicalPath).toBe(repos.withHead);
    expect(headBody.headCommit).toBe(repos.headOf('withHead'));
    expect(headBody.hasInitialCommit).toBe(true);
    expect(headBody.hasUncommittedChanges).toBe(false);
    expect(headBody.alreadyRegistered).toBeNull();

    const noHead = await inspect(repos.noInitialCommit);
    expect(noHead.statusCode).toBe(200);
    const noHeadBody = noHead.json() as Record<string, unknown>;
    expect(noHeadBody.headCommit).toBeNull();
    expect(noHeadBody.hasInitialCommit).toBe(false);

    const dirty = await inspect(repos.dirty);
    expect(dirty.statusCode).toBe(200);
    expect((dirty.json() as Record<string, unknown>).hasUncommittedChanges).toBe(true);

    const register = await registerViaHttp(port, token, repos.withHead, 'Inspect 项目');
    expect(register.statusCode).toBe(200);
    const projectId = (register.json() as { result: { project: { id: string } } }).result.project.id;
    for (const path of [repos.withHead, repos.alias]) {
      const again = await inspect(path);
      expect(again.statusCode).toBe(200);
      expect((again.json() as Record<string, unknown>).alreadyRegistered).toEqual({ projectId });
    }
  });

  it('overview：未知项目 forbidden；注册后 registration 与 health 严格分开（not_run/no_baseline）', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-overview-' });
    baseline = createBaselineFixture({ prefix: 'shiploop-f006-overview-repos-' });
    const { port, token } = await startRealHost(fixture.dataRoot);
    const unknown = await loopbackRequest({
      port,
      method: 'GET',
      path: '/v1/projects/prj-unknown/overview',
      token,
    });
    expect(unknown.statusCode).toBe(403);
    expect(errorOf(unknown).code).toBe('forbidden');

    const register = await registerViaHttp(port, token, baseline.repos.withHead, 'Overview 项目');
    const projectId = (register.json() as { result: { project: { id: string } } }).result.project.id;
    const overview = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/projects/${projectId}/overview`,
      token,
    });
    expect(overview.statusCode).toBe(200);
    const body = overview.json() as {
      schemaVersion: number;
      registration: { status: string };
      settings: { configured: boolean };
      health: { status: string; reasonCode?: string };
    };
    // overview 响应是独立的 onboarding 查询 schema（=3），不是线消息版本。
    expect(body.schemaVersion).toBe(3);
    expect(body.registration.status).toBe('registered');
    expect(body.settings.configured).toBe(false);
    expect(body.health.status).toBe('not_run');
    expect(body.health.reasonCode).toBe('no_baseline');
  });

  it('表驱动安全负例：inspect 不是任意文件读取，非法输入结构化拒绝且不返回文件内容', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f006-negatives-' });
    baseline = createBaselineFixture({ prefix: 'shiploop-f006-negatives-repos-' });
    const repos = baseline.repos;
    const { port, token } = await startRealHost(fixture.dataRoot);
    const secretMarker = 'F006-FILE-CONTENT-MUST-NOT-LEAK';
    const secretFile = join(repos.root, 'secret-file.txt');
    writeFileSync(secretFile, `${secretMarker}\n`, 'utf8');
    const notGit = join(repos.root, 'not-git');
    mkdirSync(notGit, { recursive: true });

    const cases: ReadonlyArray<{ name: string; path: string | null }> = [
      { name: '缺 path 参数', path: null },
      { name: 'path 指向普通文件', path: secretFile },
      { name: 'path 相对路径', path: 'relative/repo' },
      { name: 'path 不存在', path: join(repos.root, 'missing') },
      { name: 'path 非 Git 目录', path: notGit },
      { name: 'path 仓库子目录', path: join(repos.withHead, 'src') },
      { name: 'path 裸仓库', path: repos.origin },
    ];
    for (const testCase of cases) {
      const query = testCase.path === null ? '' : `?path=${encodeURIComponent(testCase.path)}`;
      const response = await loopbackRequest({
        port,
        method: 'GET',
        path: `/v1/projects/inspect${query}`,
        token,
      });
      expect(response.statusCode, testCase.name).toBe(400);
      expect(errorOf(response).code, testCase.name).toBe('invalid_input');
      expect(response.bodyText, `${testCase.name}：不得返回文件内容`).not.toContain(secretMarker);
    }

    const unknownParam = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/projects/inspect?path=${encodeURIComponent(repos.withHead)}&file=1`,
      token,
    });
    expect(unknownParam.statusCode).toBe(400);
    expect(errorOf(unknownParam).details?.field).toBe('query.file');

    const duplicate = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/projects/inspect?path=${encodeURIComponent(repos.withHead)}&path=${encodeURIComponent(repos.dirty)}`,
      token,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(errorOf(duplicate).code).toBe('invalid_input');

    const post = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/projects/inspect',
      token,
      body: { path: repos.withHead },
    });
    expect(post.statusCode).toBe(405);
    expect(errorOf(post).code).toBe('method_not_allowed');

    const unauthenticated = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/projects/inspect?path=${encodeURIComponent(repos.withHead)}`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const fileRoute = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/files?path=${encodeURIComponent(secretFile)}`,
      token,
    });
    expect(fileRoute.statusCode).toBe(404);
    expect(errorOf(fileRoute).code).toBe('unknown_operation');
    expect(fileRoute.bodyText).not.toContain(secretMarker);
  });
});

/* ================================================================== *
 * 三、CLI 纵向（真实 Host 子进程 + SQLite + Git；runAppCli = dist/bin.js 同路径）
 * ================================================================== */

describe('F-006 project init/overview CLI 纵向（真实 Host 子进程 + SQLite + Git）', () => {
  let fixture: BaselineFixture | undefined;
  const usedRoots: string[] = [];

  beforeEach(() => {
    fixture = createBaselineFixture({ prefix: 'shiploop-f006-cli-' });
  });

  afterEach(async () => {
    for (const root of usedRoots) {
      const collected = collectIo();
      try {
        await runHostCli({
          args: ['host', 'stop', '--data-root', root, '--json'],
          io: collected.io as HostCliIo,
          env: {},
        });
      } catch {
        // 尽力收尾；夹具 dispose 兜底回收。
      }
    }
    usedRoots.length = 0;
    await fixture?.dispose();
    fixture = undefined;
  });

  function useRoot(name: string): string {
    const root = fixture!.dataRoot(name);
    usedRoots.push(root);
    return root;
  }

  function probe(root: string): StorageProbe {
    return openStorageProbe(join(root, DATABASE_FILE_NAME));
  }

  function launchOverrides() {
    return {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture!.childEnv(),
      pollIntervalMs: 50,
    };
  }

  async function runApp(args: readonly string[], options: { cwd?: string } = {}): Promise<AppInvocation> {
    const collected = collectIo();
    const result = await runAppCli({
      args,
      io: collected.io,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      launch: launchOverrides(),
    });
    return { result, stdout: collected.stdout(), stderr: collected.stderr() };
  }

  it('预览：有 HEAD/无 HEAD/脏仓库先展示静态事实；无 --confirm → not_run 且零副作用', async () => {
    const repos = fixture!.repos;
    const root = useRoot('preview');
    const dirtyBefore = digestWorkingTree(repos.dirty);
    const maliciousBefore = digestWorkingTree(repos.malicious);

    const cases: ReadonlyArray<{
      name: string;
      args: readonly string[];
      assert: (preview: Record<string, unknown>) => void;
    }> = [
      {
        name: '有 HEAD（相对路径按注入 cwd 解析）',
        args: ['project', 'init', './repos/仓库 with-head', '--data-root', root, '--json'],
        assert: (preview) => {
          expect(preview.headCommit).toBe(repos.headOf('withHead'));
          expect(preview.hasUncommittedChanges).toBe(false);
          expect(preview.alreadyRegisteredProjectId).toBeNull();
        },
      },
      {
        name: '无 HEAD',
        args: ['project', 'init', repos.noInitialCommit, '--data-root', root, '--json'],
        assert: (preview) => {
          expect(preview.headCommit).toBeNull();
          expect(preview.hasInitialCommit).toBe(false);
        },
      },
      {
        name: '脏工作区',
        args: ['project', 'init', repos.dirty, '--data-root', root, '--json'],
        assert: (preview) => {
          expect(preview.hasUncommittedChanges).toBe(true);
        },
      },
    ];
    for (const testCase of cases) {
      const inv = await runApp(testCase.args, { cwd: repos.root });
      expect(inv.result.exitCode, `${testCase.name}: ${inv.stderr}`).toBe(0);
      const envelope = parseEnvelope(inv);
      expect(envelope.ok, testCase.name).toBe(true);
      expect(envelope.command).toBe('project.init');
      const result = envelope.result as Record<string, unknown>;
      const registration = result.registration as { status: string; reason?: string };
      expect(registration.status, testCase.name).toBe('not_run');
      expect(registration.reason, testCase.name).toBe('non_interactive');
      const health = result.health as { status: string; reasonCode?: string };
      expect(health.status, testCase.name).toBe('not_run');
      expect(health.reasonCode).toBe('no_baseline');
      testCase.assert(result.preview as Record<string, unknown>);
    }

    const human = await runApp(['project', 'init', repos.withHead, '--data-root', root], {
      cwd: repos.root,
    });
    expect(human.result.exitCode).toBe(0);
    expect(human.stdout).toContain(repos.withHead);
    expect(human.stdout).toContain('静态预览');
    expect(human.stdout).toContain('not_run');
    expect(human.stdout).toContain('健康状态');
    expect(human.stderr).toContain('--confirm');

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(0);
      expect(probeHandle.counts().repository_bindings).toBe(0);
      expect(probeHandle.counts().state_events).toBe(0);
    } finally {
      probeHandle.close();
    }
    expect(digestWorkingTree(repos.dirty)).toEqual(dirtyBefore);
    expect(digestWorkingTree(repos.malicious)).toEqual(maliciousBefore);
    expect(existsSync(repos.maliciousSentinelPath)).toBe(false);
  });

  it('确认注册：--confirm 才提交，返回真实 projectId；overview 独立显示健康尚未检查；行一致', async () => {
    const repos = fixture!.repos;
    const root = useRoot('confirm');
    const inv = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '确认注册项目',
      '--description',
      '说明文本',
      '--label',
      'alpha',
      '--label',
      'beta',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const result = successResult(inv, 'project.init');
    const registration = result.registration as { status: string; projectId: string };
    expect(registration.status).toBe('registered');
    const projectId = registration.projectId;
    expect(typeof projectId).toBe('string');
    expect(projectId.length).toBeGreaterThan(0);
    const health = result.health as { status: string; reasonCode?: string };
    expect(health.status).toBe('not_run');
    expect(health.reasonCode).toBe('no_baseline');

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().repository_bindings).toBe(1);
      const row = probeHandle.projectRow(projectId);
      expect(row?.display_name).toBe('确认注册项目');
      expect(row?.description).toBe('说明文本');
      expect(JSON.parse(String(row?.labels))).toEqual(['alpha', 'beta']);
    } finally {
      probeHandle.close();
    }

    const overview = await runApp(['project', 'overview', projectId, '--data-root', root, '--json']);
    const overviewResult = successResult(overview, 'project.overview');
    expect((overviewResult.registration as { status: string }).status).toBe('registered');
    const overviewHealth = overviewResult.health as { status: string; reasonCode?: string };
    expect(overviewHealth.status).toBe('not_run');
    expect(overviewHealth.reasonCode).toBe('no_baseline');

    const overviewHuman = await runApp(['project', 'overview', projectId, '--data-root', root]);
    expect(overviewHuman.result.exitCode).toBe(0);
    expect(overviewHuman.stdout).toContain('注册状态：registered');
    expect(overviewHuman.stdout).toContain('健康状态：not_run');
    expect(overviewHuman.stdout).toContain('未检查');
  });

  it('重复 init 同规范路径（含别名）：返回既有项目，不覆盖原名称/说明/标签', async () => {
    const repos = fixture!.repos;
    const root = useRoot('repeat');
    const first = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '原名',
      '--description',
      '原说明',
      '--label',
      'keep',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const firstResult = successResult(first, 'project.init');
    const projectId = (firstResult.registration as { projectId: string }).projectId;

    const second = await runApp([
      'project',
      'init',
      repos.alias,
      '--name',
      '覆盖名',
      '--description',
      '覆盖说明',
      '--label',
      'overwrite',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const secondResult = successResult(second, 'project.init');
    const registration = secondResult.registration as { status: string; projectId: string };
    expect(registration.status).toBe('already_registered');
    expect(registration.projectId).toBe(projectId);

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(1);
      const row = probeHandle.projectRow(projectId);
      expect(row?.display_name).toBe('原名');
      expect(row?.description).toBe('原说明');
      expect(JSON.parse(String(row?.labels))).toEqual(['keep']);
    } finally {
      probeHandle.close();
    }
  });

  it('幂等：相同 commandId 相同参数重放原回执；不同参数 conflict（退出码 1）', async () => {
    const repos = fixture!.repos;
    const root = useRoot('idempotent');
    const commandId = randomUUID();
    const runRegister = (name: string, label: string) =>
      runApp([
        'project',
        'init',
        repos.withHead,
        '--name',
        name,
        '--label',
        label,
        '--confirm',
        '--command-id',
        commandId,
        '--data-root',
        root,
        '--json',
      ]);
    const first = await runRegister('幂等项目', 'idem');
    expect(first.result.exitCode, first.stderr).toBe(0);
    expect(parseEnvelope(first).ok).toBe(true);

    const receiptFirst = await runApp(['receipt', 'get', commandId, '--data-root', root, '--json']);
    const receiptBody = successResult(receiptFirst, 'receipt.get') as unknown as {
      status: string;
      replayed: boolean;
    };
    expect(receiptBody.status).toBe('completed');
    expect(receiptBody.replayed).toBe(false);

    const second = await runRegister('幂等项目', 'idem');
    expect(second.result.exitCode, second.stderr).toBe(0);
    const secondResult = successResult(second, 'project.init');
    // 同信封重试命中服务端摘要重放：返回原回执的业务结果（registered + 同 projectId），
    // 不是新的 already_exists；零新增副作用由下方行数与 replayed 回执证明。
    expect((secondResult.registration as { status: string }).status).toBe('registered');
    expect((secondResult.registration as { projectId: string }).projectId).toBe(
      (firstResultRegistrationIdOf(first) as string),
    );

    // 回执读取返回持久原回执（replayed 标记只在重放提交的响应中出现，由
    // 「两个客户端」用例经直接 submitCommand 断言）；此处核对回执仍可查且行数不变。
    const receiptSecond = await runApp(['receipt', 'get', commandId, '--data-root', root, '--json']);
    const receiptSecondBody = successResult(receiptSecond, 'receipt.get') as unknown as {
      status: string;
    };
    expect(receiptSecondBody.status).toBe('completed');

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().state_events).toBe(1);
    } finally {
      probeHandle.close();
    }

    const conflict = await runRegister('不同参数', 'other');
    const error = failureOf(conflict, 1, 'conflict');
    expect(error?.details?.reason).toBe('idempotency_key_reuse');
    const probeAfter = probe(root);
    try {
      expect(probeAfter.counts().projects).toBe(1);
      expect(probeAfter.counts().state_events).toBe(1);
    } finally {
      probeAfter.close();
    }
  });

  it('恶意仓库：预览与确认注册都不执行脚本（哨兵不存在、源文件摘要不变）', async () => {
    const repos = fixture!.repos;
    const root = useRoot('malicious');
    const before = digestWorkingTree(repos.malicious);
    const preview = await runApp(['project', 'init', repos.malicious, '--data-root', root, '--json']);
    expect(preview.result.exitCode, preview.stderr).toBe(0);
    const confirmed = await runApp([
      'project',
      'init',
      repos.malicious,
      '--name',
      '恶意仓库注册',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const confirmedResult = successResult(confirmed, 'project.init');
    expect((confirmedResult.registration as { status: string }).status).toBe('registered');
    expect(existsSync(repos.maliciousSentinelPath)).toBe(false);
    expect(digestWorkingTree(repos.malicious)).toEqual(before);
    expect(repos.headOf('malicious')).not.toBeNull();
  });

  it('两个客户端 + 客户端中断：A 提交注册后中断，B 查回执/重发同信封不重复创建', async () => {
    const repos = fixture!.repos;
    const root = useRoot('two-clients');
    const ensured = await ensureHostRunning({ dataRoot: root, ...launchOverrides() });
    const clientA = ensured.client;
    const commandId = randomUUID();
    const receiptA = await clientA.submitCommand({
      commandId,
      operation: 'project.register',
      scope: { kind: 'registration' },
      payload: { repositoryPath: repos.withHead, displayName: '双客户端项目' },
    });
    expect(receiptA.status).toBe('completed');
    const projectId = (receiptA as { result: { project: { id: string } } }).result.project.id;
    // 客户端 A 中断（直接关闭）。
    clientA.close();

    const clientB = await connectToHost({ canonicalRoot: root });
    try {
      const receiptB = await clientB.getReceipt(commandId);
      expect(receiptB.commandId).toBe(commandId);
      expect(receiptB.status).toBe('completed');
      const overview = await clientB.getProjectOverview(projectId);
      expect(overview.registration.status).toBe('registered');
      expect(overview.health.status).toBe('not_run');
      const replay = await clientB.submitCommand({
        commandId,
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: { repositoryPath: repos.withHead, displayName: '双客户端项目' },
        issuedAt: receiptB.issuedAt,
      });
      expect(replay.replayed).toBe(true);
      expect((replay as { result: { project: { id: string } } }).result.project.id).toBe(projectId);
    } finally {
      clientB.close();
    }

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().state_events).toBe(1);
    } finally {
      probeHandle.close();
    }
  });

  it('Host 重启：注册回执与 overview 可查，同 commandId 重发零新增副作用', async () => {
    const repos = fixture!.repos;
    const root = useRoot('restart');
    const commandId = randomUUID();
    const first = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '重启项目',
      '--confirm',
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ]);
    const firstResult = successResult(first, 'project.init');
    const projectId = (firstResult.registration as { projectId: string }).projectId;

    const stopIo = collectIo();
    const stopped = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: stopIo.io as HostCliIo,
      env: {},
    });
    expect(stopped.exitCode, stopIo.stdout()).toBe(0);

    const afterRestart = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '重启项目',
      '--confirm',
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ]);
    const restartResult = successResult(afterRestart, 'project.init');
    // 同信封（同 commandId + 原 issuedAt）重发命中重放：返回原回执业务结果，
    // 注册轴保持 registered + 同 projectId；零新增副作用由下方行数证明。
    expect((restartResult.registration as { status: string }).status).toBe('registered');
    expect((restartResult.registration as { projectId: string }).projectId).toBe(projectId);

    const receipt = await runApp(['receipt', 'get', commandId, '--data-root', root, '--json']);
    const receiptBody = successResult(receipt, 'receipt.get') as unknown as { status: string };
    expect(receiptBody.status).toBe('completed');

    const overview = await runApp(['project', 'overview', projectId, '--data-root', root, '--json']);
    const overviewResult = successResult(overview, 'project.overview');
    expect((overviewResult.registration as { status: string }).status).toBe('registered');

    const probeHandle = probe(root);
    try {
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().state_events).toBe(1);
      expect(probeHandle.counts().command_receipts).toBe(1);
    } finally {
      probeHandle.close();
    }
  });

  it('--confirm 缺 --name：在连接 Host 之前以退出码 2 拒绝（注册请求不完整）', async () => {
    const repos = fixture!.repos;
    const root = useRoot('no-name');
    const inv = await runApp([
      'project',
      'init',
      repos.withHead,
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const error = failureOf(inv, 2, 'invalid_input');
    expect(error?.details?.reason).toBe('name_required_for_registration');
    expect(existsSync(join(root, DATABASE_FILE_NAME)), '不得在拒绝前打开/创建状态库').toBe(false);
  });

  it('CLI 不直接打开 SQLite 或写元数据文件（源码扫描：无 sqlite 驱动/Core 导入）', () => {
    const cliSourceRoot = resolve(repoRoot, 'packages/cli/src');
    const forbidden: readonly RegExp[] = [
      /better-sqlite3/,
      /node:sqlite/,
      /DATABASE_FILE_NAME/,
      /from 'shiploop-core/,
      /from "shiploop-core/,
    ];
    const collectFiles = (dir: string): string[] => {
      const files: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          files.push(...collectFiles(full));
        } else if (name.endsWith('.ts')) {
          files.push(full);
        }
      }
      return files;
    };
    const files = collectFiles(cliSourceRoot);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} 不得匹配 ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });
});
