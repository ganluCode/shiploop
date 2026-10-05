/**
 * F-007 Host 认证握手与状态查询传输面验收（真实 127.0.0.1 HTTP，无模型）。
 *
 * 覆盖（F-007 验收点，契约 §7.2 传输规则、§8 握手校验顺序、§9 只读状态、§14 错误映射）：
 * - 合法本机认证握手返回真实 hostInstanceId/protocolVersion/数据根身份/生命周期/
 *   冻结能力；认证 status 只读确认同一实例存活（无写入、无文件变化）；
 * - 缺失/错误/陈旧 token、非 Bearer 方案、URL 携带凭据 → 401（子原因不可区分）；
 *   外部/伪造 Origin、错误/缺失 Host 头 → 401；无 Origin 的合法 CLI 请求可通过；
 * - 错误实例/数据根 → 409；未知 schemaVersion → 400；不兼容 protocolVersion → 426；
 *   校验顺序：传输层 → 结构 → 凭据 → 版本 → 实例 → 数据根（§8 冻结）；
 * - 畸形 JSON、超大请求体（413）、GET 带体、未知路由（404）、方法不允许（405）
 *   均有有限资源占用与明确拒绝；服务端 headersTimeout/requestTimeout 为有界常量；
 * - stop 路由在 F-008 接线前：经完整传输与认证校验后返回 501 unsupported，
 *   绝不触发停止/文件删除/数据库写入；
 * - 所有响应不发 CORS 头、永不含 3xx、不回显凭据/请求体原文/绝对路径；
 * - 负例矩阵执行后零副作用：发现/凭据/数据库/锁文件逐字节不变，合法握手仍成功。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CURRENT_HOST_CAPABILITIES,
  MAX_HTTP_BODY_BYTES,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  createHostFileStore,
  createHostLifecycleServer,
  startHost,
  validateHandshakeResponse,
  validateStatusResponse,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/index.ts';
import { createIsolatedHostEnvironment, loopbackRequest } from './helpers/host/index.ts';
import type { IsolatedHostEnvironment, LoopbackResponse } from './helpers/host/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

/** 伪上下文固定身份（独立传输面矩阵用；真实端到端走 startHost）。 */
const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10';
const OTHER_INSTANCE = '33333333-3333-4333-8333-333333333333';
const STUB_ROOT_IDENTITY = '9f2a'.repeat(16);
const OTHER_ROOT_IDENTITY = 'aaaa'.repeat(16);
const STUB_STARTED_AT = '2026-10-05T00:00:00.000Z';

function handshakeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    hostInstanceId: STUB_INSTANCE,
    dataRootIdentity: STUB_ROOT_IDENTITY,
    ...overrides,
  };
}

interface StubTransport {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

async function startStubTransport(): Promise<StubTransport> {
  const server = createHostLifecycleServer({
    hostInstanceId: STUB_INSTANCE,
    dataRootIdentity: STUB_ROOT_IDENTITY,
    startedAt: STUB_STARTED_AT,
    pid: 4321,
    authToken: STUB_TOKEN,
    getLifecycleState: () => 'ready',
    getActivities: () => ({ accepted: 0, quiescing: 0 }),
    getStopView: () => null,
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('传输面监听地址非法');
  }
  return {
    port: address.port,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

/** 原始 HTTP 报文交换（伪造/缺失 Host 头等探针无法表达的用例）；connection: close 下读至 EOF。 */
function rawExchange(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        socket.destroy();
        rejectExchange(error);
      }
    };
    socket.setTimeout(5_000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      if (!settled) {
        settled = true;
        resolveExchange(Buffer.concat(chunks).toString('utf8'));
      }
    });
    socket.on('timeout', () => fail(new Error('原始报文交换超时')));
    socket.on('error', (error) => fail(error));
    socket.write(rawRequest);
  });
}

function statusOf(rawResponse: string): number {
  const match = /^HTTP\/1\.1 (\d{3})\b/.exec(rawResponse);
  expect(match, rawResponse).not.toBeNull();
  return Number.parseInt((match as RegExpExecArray)[1] as string, 10);
}

function errorBody(response: LoopbackResponse): { code: string; operation: string; message: string } {
  const parsed = response.json() as { error: { code: string; operation: string; message: string } };
  expect(parsed.error).toBeDefined();
  return parsed.error;
}

/** 全部响应的通用传输纪律断言（§7.2/§7.3：JSON、no-store、无 CORS、无 3xx、无凭据）。 */
function expectTransportHygiene(response: LoopbackResponse, secret: string): void {
  // Host 永不发出 3xx（§7.2：客户端绝不跟随重定向）。
  expect(response.statusCode < 300 || response.statusCode >= 400).toBe(true);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  for (const name of Object.keys(response.headers)) {
    expect(name.startsWith('access-control-')).toBe(false);
  }
  expect(response.bodyText).not.toContain(secret);
  expect(response.bodyText).not.toContain('Bearer');
}

describe('F-007 传输面：合法握手与状态（独立监听 + 伪上下文）', () => {
  it('合法握手返回真实身份/版本/数据根/生命周期/冻结能力并通过双向核验', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody(),
      });
      expect(response.statusCode).toBe(200);
      expectTransportHygiene(response, STUB_TOKEN);
      const body = response.json();
      expect(body).toEqual({
        schemaVersion: 1,
        protocolVersion: 1,
        hostInstanceId: STUB_INSTANCE,
        dataRootIdentity: STUB_ROOT_IDENTITY,
        lifecycleState: 'ready',
        startedAt: STUB_STARTED_AT,
        capabilities: CURRENT_HOST_CAPABILITIES,
      });
      // 客户端侧严格校验同样接受（F-009 复用同一纯函数）。
      const validated = validateHandshakeResponse(body, {
        expectedHostInstanceId: STUB_INSTANCE,
        expectedDataRootIdentity: STUB_ROOT_IDENTITY,
      });
      expect(validated.capabilities.events).toBe('unsupported');
      expect(validated.capabilities.projectCommands).toBe('unsupported');
      // 合法 CLI 请求不携带 Origin（§7.2 无 Origin 的本机请求合法）。
    } finally {
      await transport.close();
    }
  });

  it('认证 status 返回真实字段（pid/活动 0/0/stop null）并通过双向核验，可重复调用', async () => {
    const transport = await startStubTransport();
    try {
      for (let round = 0; round < 3; round += 1) {
        const response = await loopbackRequest({
          port: transport.port,
          method: 'GET',
          path: '/v1/host/status',
          token: STUB_TOKEN,
        });
        expect(response.statusCode).toBe(200);
        expectTransportHygiene(response, STUB_TOKEN);
        const body = response.json();
        expect(body).toEqual({
          schemaVersion: 1,
          protocolVersion: 1,
          hostInstanceId: STUB_INSTANCE,
          dataRootIdentity: STUB_ROOT_IDENTITY,
          lifecycleState: 'ready',
          pid: 4321,
          startedAt: STUB_STARTED_AT,
          activities: { accepted: 0, quiescing: 0 },
          stop: null,
        });
        validateStatusResponse(body, {
          expectedHostInstanceId: STUB_INSTANCE,
          expectedDataRootIdentity: STUB_ROOT_IDENTITY,
        });
      }
    } finally {
      await transport.close();
    }
  });

  it('服务端超时为有界内部常量且已装配到 Server（headers < request）', async () => {
    expect(Number.isInteger(SERVER_HEADERS_TIMEOUT_MS)).toBe(true);
    expect(Number.isInteger(SERVER_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(SERVER_HEADERS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(SERVER_HEADERS_TIMEOUT_MS);
    // requestTimeout 必须覆盖 §10 的 10s quiesce 预算（F-008 stop 长请求仍在预算内）。
    expect(SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    const transport = await startStubTransport();
    try {
      expect(transport.server.requestTimeout).toBe(SERVER_REQUEST_TIMEOUT_MS);
      expect(transport.server.headersTimeout).toBe(SERVER_HEADERS_TIMEOUT_MS);
    } finally {
      await transport.close();
    }
  });
});

describe('F-007 传输面：认证与来源负例（401 子原因不可区分）', () => {
  const cases: Array<{
    name: string;
    token?: string;
    headers?: Record<string, string>;
    path?: string;
    body?: unknown;
  }> = [
    { name: '缺失 Authorization 头' },
    { name: '错误 token（等长一字符之差）', token: '0'.repeat(64) },
    { name: '非 Bearer 方案（Basic）', headers: { authorization: `Basic ${'0'.repeat(64)}` } },
    { name: 'Bearer 后无凭据', headers: { authorization: 'Bearer' } },
    { name: 'Bearer 空凭据', headers: { authorization: 'Bearer ' } },
    { name: '外部 Origin', token: STUB_TOKEN, headers: { origin: 'https://evil.example' } },
    { name: '伪造域名 Origin', token: STUB_TOKEN, headers: { origin: 'http://localhost.attacker.example' } },
    { name: 'Origin: null 同样拒绝', token: STUB_TOKEN, headers: { origin: 'null' } },
    {
      name: '凭据只放 URL query（无认证头）',
      path: `/v1/host/handshake?token=${STUB_TOKEN}`,
    },
  ];

  for (const testCase of cases) {
    it(`握手拒绝：${testCase.name}`, async () => {
      const transport = await startStubTransport();
      try {
        const response = await loopbackRequest({
          port: transport.port,
          method: 'POST',
          path: testCase.path ?? '/v1/host/handshake',
          ...(testCase.token !== undefined ? { token: testCase.token } : {}),
          ...(testCase.headers !== undefined ? { headers: testCase.headers } : {}),
          body: handshakeBody(),
        });
        expect(response.statusCode).toBe(401);
        const error = errorBody(response);
        expect(error.code).toBe('unauthorized');
        expect(error.operation).toBe('host.handshake');
        // 子原因不可区分：统一文案，不区分不存在/错误/来源问题。
        expect(error.message).toBe('认证失败');
        expectTransportHygiene(response, STUB_TOKEN);
      } finally {
        await transport.close();
      }
    });
  }

  it('status 拒绝：缺失/错误 token 与 Origin 携带', async () => {
    const transport = await startStubTransport();
    try {
      for (const options of [
        {},
        { token: '0'.repeat(64) },
        { token: STUB_TOKEN, headers: { origin: 'https://evil.example' } },
      ]) {
        const response = await loopbackRequest({
          port: transport.port,
          method: 'GET',
          path: '/v1/host/status',
          ...options,
        });
        expect(response.statusCode).toBe(401);
        expect(errorBody(response).code).toBe('unauthorized');
        expectTransportHygiene(response, STUB_TOKEN);
      }
    } finally {
      await transport.close();
    }
  });

  it('Host 头必须恰为 127.0.0.1:<实际端口>（伪造域名/localhost/错误端口/缺失一律 401）', async () => {
    const transport = await startStubTransport();
    try {
      const bodyText = JSON.stringify(handshakeBody());
      const variants = [
        `Host: localhost:${transport.port}`,
        `Host: 127.0.0.1:${transport.port + 1}`,
        'Host: evil.example',
        'Host: 0.0.0.0',
        null, // 缺失 Host 头
      ];
      for (const hostLine of variants) {
        const lines = [
          'POST /v1/host/handshake HTTP/1.1',
          ...(hostLine === null ? [] : [hostLine]),
          'Content-Type: application/json',
          `Authorization: Bearer ${STUB_TOKEN}`,
          `Content-Length: ${Buffer.byteLength(bodyText)}`,
          '',
          bodyText,
        ];
        const raw = await rawExchange(transport.port, lines.join('\r\n'));
        if (hostLine === null) {
          // HTTP/1.1 缺失 Host：Node 内核在业务处理器之前以 400 拒绝（同为
          // 有界、零副作用的明确拒绝；错误 Host 值才到达处理器 → 401）。
          expect(statusOf(raw)).toBe(400);
          expect(raw).not.toContain(STUB_TOKEN);
          continue;
        }
        expect(statusOf(raw)).toBe(401);
        expect(raw).not.toContain(STUB_TOKEN);
        // 原始报文可能为 chunked/close 分隔；直接定位 JSON 错误体。
        const jsonMatch = /\{.*\}/s.exec(raw);
        expect(jsonMatch, raw).not.toBeNull();
        const parsed = JSON.parse((jsonMatch as RegExpExecArray)[0]) as { error: { code: string } };
        expect(parsed.error.code).toBe('unauthorized');
      }
      // 对照：正确 Host 头可通过认证。
      const okLines = [
        'POST /v1/host/handshake HTTP/1.1',
        `Host: 127.0.0.1:${transport.port}`,
        'Content-Type: application/json',
        `Authorization: Bearer ${STUB_TOKEN}`,
        `Content-Length: ${Buffer.byteLength(bodyText)}`,
        '',
        bodyText,
      ];
      const okRaw = await rawExchange(transport.port, okLines.join('\r\n'));
      expect(statusOf(okRaw)).toBe(200);
    } finally {
      await transport.close();
    }
  });
});

describe('F-007 传输面：版本与身份门禁（§8 顺序）', () => {
  it('未知 schemaVersion → 400 unsupported_schema_version（不降级）', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody({ schemaVersion: 99 }),
      });
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe('unsupported_schema_version');
      expectTransportHygiene(response, STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('不兼容 protocolVersion → 426 protocol_incompatible（details 给支持版本）', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody({ protocolVersion: 99 }),
      });
      expect(response.statusCode).toBe(426);
      const parsed = response.json() as { error: { code: string; details?: { supportedProtocolVersions?: number[] } } };
      expect(parsed.error.code).toBe('protocol_incompatible');
      expect(parsed.error.details?.supportedProtocolVersions).toEqual([1]);
      expectTransportHygiene(response, STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('预期实例不符 → 409 instance_mismatch；数据根身份不符 → 409 data_root_mismatch', async () => {
    const transport = await startStubTransport();
    try {
      const instanceMismatch = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody({ hostInstanceId: OTHER_INSTANCE }),
      });
      expect(instanceMismatch.statusCode).toBe(409);
      expect(errorBody(instanceMismatch).code).toBe('instance_mismatch');

      const rootMismatch = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody({ dataRootIdentity: OTHER_ROOT_IDENTITY }),
      });
      expect(rootMismatch.statusCode).toBe(409);
      expect(errorBody(rootMismatch).code).toBe('data_root_mismatch');
      expectTransportHygiene(instanceMismatch, STUB_TOKEN);
      expectTransportHygiene(rootMismatch, STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('§8 校验顺序：结构错误先于凭据（400），结构合法后才核对凭据（401）', async () => {
    const transport = await startStubTransport();
    try {
      // 结构错误 + 错误 token → invalid_input（结构第 2 步先于凭据第 3 步）。
      const structureFirst = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: '0'.repeat(64),
        body: { schemaVersion: 1, protocolVersion: 1 },
      });
      expect(structureFirst.statusCode).toBe(400);
      expect(errorBody(structureFirst).code).toBe('invalid_input');

      // 结构合法 + 错误 token → 401。
      const credentialNext = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: '0'.repeat(64),
        body: handshakeBody(),
      });
      expect(credentialNext.statusCode).toBe(401);
      expect(errorBody(credentialNext).code).toBe('unauthorized');

      // 结构含未知字段（前向宽容拒绝）→ 400；hostInstanceId 非 UUID → 400。
      for (const body of [handshakeBody({ extra: true }), handshakeBody({ hostInstanceId: 'not-a-uuid' })]) {
        const response = await loopbackRequest({
          port: transport.port,
          method: 'POST',
          path: '/v1/host/handshake',
          token: STUB_TOKEN,
          body,
        });
        expect(response.statusCode).toBe(400);
        expect(errorBody(response).code).toBe('invalid_input');
      }
    } finally {
      await transport.close();
    }
  });
});

describe('F-007 传输面：畸形/超限/未知操作（有限资源占用）', () => {
  it('畸形 JSON → 400 invalid_input，不回显请求体原文', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        rawBody: '{oops',
      });
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe('invalid_input');
      expect(response.bodyText).not.toContain('oops');
      expectTransportHygiene(response, STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('请求体超过 16 384 字节 → 413 request_too_large，连接被关闭', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        rawBody: ' '.repeat(MAX_HTTP_BODY_BYTES + 1),
      });
      expect(response.statusCode).toBe(413);
      expect(errorBody(response).code).toBe('request_too_large');
      expect(response.headers.connection).toBe('close');
      expectTransportHygiene(response, STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('POST content-type 非 application/json → 400 invalid_input', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        rawBody: JSON.stringify(handshakeBody()),
        headers: { 'Content-Type': 'text/plain' },
      });
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe('invalid_input');
    } finally {
      await transport.close();
    }
  });

  it('GET status 携带请求体 → 400 invalid_input', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'GET',
        path: '/v1/host/status',
        token: STUB_TOKEN,
        rawBody: '{}',
      });
      expect(response.statusCode).toBe(400);
      expect(errorBody(response).code).toBe('invalid_input');
    } finally {
      await transport.close();
    }
  });

  it('未知路由与伪健康端点 → 404 unknown_operation（无匿名路由）', async () => {
    const transport = await startStubTransport();
    try {
      for (const path of ['/', '/health', '/v1/host/nope', '/v2/host/status']) {
        const response = await loopbackRequest({
          port: transport.port,
          method: 'GET',
          path,
          token: STUB_TOKEN,
        });
        expect(response.statusCode).toBe(404);
        expect(errorBody(response).code).toBe('unknown_operation');
        expectTransportHygiene(response, STUB_TOKEN);
      }
    } finally {
      await transport.close();
    }
  });

  it('路由存在但方法不允许 → 405 method_not_allowed（错误体明示允许方法）', async () => {
    const transport = await startStubTransport();
    try {
      const getHandshake = await loopbackRequest({
        port: transport.port,
        method: 'GET',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
      });
      expect(getHandshake.statusCode).toBe(405);
      const handshakeError = getHandshake.json() as { error: { code: string; details?: { allowedMethods?: string[] } } };
      expect(handshakeError.error.code).toBe('method_not_allowed');
      expect(handshakeError.error.details?.allowedMethods).toEqual(['POST']);

      const postStatus = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/status',
        token: STUB_TOKEN,
        body: {},
      });
      expect(postStatus.statusCode).toBe(405);
      const statusError = postStatus.json() as { error: { code: string; details?: { allowedMethods?: string[] } } };
      expect(statusError.error.details?.allowedMethods).toEqual(['GET']);

      // HEAD（及任何非 GET 方法）同样 405。
      const headRaw = await rawExchange(
        transport.port,
        [
          'HEAD /v1/host/status HTTP/1.1',
          `Host: 127.0.0.1:${transport.port}`,
          `Authorization: Bearer ${STUB_TOKEN}`,
          '',
          '',
        ].join('\r\n'),
      );
      expect(statusOf(headRaw)).toBe(405);
      expect(headRaw).not.toContain(STUB_TOKEN);
    } finally {
      await transport.close();
    }
  });

  it('未知路由优先于认证：未带 token 的未知路由仍 404（路由存在性不依赖凭据）', async () => {
    const transport = await startStubTransport();
    try {
      const response = await loopbackRequest({
        port: transport.port,
        method: 'GET',
        path: '/v1/host/nope',
      });
      expect(response.statusCode).toBe(404);
      expect(errorBody(response).code).toBe('unknown_operation');
    } finally {
      await transport.close();
    }
  });
});

describe('F-007 传输面：stop 路由临时边界（F-008 前 501）', () => {
  it('认证 stop → 501 unsupported 且零副作用；未认证 stop → 401', async () => {
    const transport = await startStubTransport();
    try {
      const unauthenticated = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/stop',
        body: {},
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(errorBody(unauthenticated).code).toBe('unauthorized');

      const authenticated = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/stop',
        token: STUB_TOKEN,
        body: {},
      });
      expect(authenticated.statusCode).toBe(501);
      const error = errorBody(authenticated);
      expect(error.code).toBe('unsupported');
      expect(error.operation).toBe('host.stop');
      expectTransportHygiene(authenticated, STUB_TOKEN);

      // 501 不是停止：服务仍存活，合法握手仍成功。
      const handshake = await loopbackRequest({
        port: transport.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: STUB_TOKEN,
        body: handshakeBody(),
      });
      expect(handshake.statusCode).toBe(200);
    } finally {
      await transport.close();
    }
  });
});

describe('F-007 端到端：真实 startHost 的认证握手/状态与零副作用', () => {
  function snapshotProtectedFiles(canonicalRoot: string): Record<string, unknown> {
    return {
      discovery: readFileSync(join(canonicalRoot, 'host', 'discovery.json'), 'utf8'),
      token: readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8'),
      lockMtimeMs: statSync(join(canonicalRoot, 'host', 'writer.lock')).mtimeMs,
      dbSize: statSync(join(canonicalRoot, 'core.sqlite')).size,
      dbMtimeMs: statSync(join(canonicalRoot, 'core.sqlite')).mtimeMs,
    };
  }

  async function startRealHost(
    prefix: string,
  ): Promise<{ env: IsolatedHostEnvironment; host: RunningHost; token: string }> {
    const env = createIsolatedHostEnvironment({ prefix });
    try {
      const { canonicalRoot } = env.dataRoot('root');
      const host = await startHost({ dataRoot: canonicalRoot, capabilityCatalog: EMPTY_CATALOG, env: {} });
      const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
      env.evidence.registerSecret(token);
      return { env, host, token };
    } catch (error) {
      await env.dispose();
      throw error;
    }
  }

  it('真实 Host：握手/状态返回与发现一致的实例；客户端断开后 Host 存活', async () => {
    const { env, host, token } = await startRealHost('shiploop-f007-e2e-');
    try {
      const store = createHostFileStore({ canonicalRoot: host.canonicalRoot });
      const discovery = store.readTrustedDiscovery();

      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: {
          schemaVersion: 1,
          protocolVersion: 1,
          hostInstanceId: discovery.hostInstanceId,
          dataRootIdentity: host.dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);
      const validated = validateHandshakeResponse(handshake.json(), {
        expectedHostInstanceId: discovery.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });
      expect(validated.hostInstanceId).toBe(host.hostInstanceId);
      expect(validated.lifecycleState).toBe('ready');
      expect(validated.startedAt).toBe(host.startedAt);

      // 客户端（探针）连接已关闭；另一「客户端」认证 status 证明 Host 存活（§12.3）。
      const status = await loopbackRequest({
        port: host.port,
        method: 'GET',
        path: '/v1/host/status',
        token,
      });
      expect(status.statusCode).toBe(200);
      const statusBody = validateStatusResponse(status.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });
      expect(statusBody.pid).toBe(process.pid);
      expect(statusBody.activities).toEqual({ accepted: 0, quiescing: 0 });
      expect(statusBody.stop).toBeNull();
      // 普通状态 JSON 绝不含凭据。
      expect(status.bodyText).not.toContain(token);
      expect(handshake.bodyText).not.toContain(token);

      env.evidence.record('host.f007_handshake_status', {
        hostInstanceId: host.hostInstanceId,
        port: host.port,
        lifecycleState: statusBody.lifecycleState,
      });
    } finally {
      await host.close();
      await env.dispose();
    }
  });

  it('负例矩阵零副作用：发现/凭据/数据库/锁逐字节不变，合法握手仍成功', async () => {
    const { env, host, token } = await startRealHost('shiploop-f007-sidefx-');
    try {
      const before = snapshotProtectedFiles(host.canonicalRoot);
      const wrongToken = '0'.repeat(64);
      const negatives: LoopbackResponse[] = [];
      negatives.push(
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token: wrongToken, body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity }) }),
        await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token: wrongToken }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, headers: { origin: 'https://evil.example' }, body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, body: handshakeBody({ hostInstanceId: OTHER_INSTANCE, dataRootIdentity: host.dataRootIdentity }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: OTHER_ROOT_IDENTITY }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity, protocolVersion: 99 }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, body: handshakeBody({ hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity, schemaVersion: 99 }) }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, rawBody: '{broken' }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/handshake', token, rawBody: ' '.repeat(MAX_HTTP_BODY_BYTES + 1) }),
        await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/unknown', token }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/status', token, body: {} }),
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/stop', token, body: {} }),
      );
      expect(negatives.map((response) => response.statusCode)).toEqual([
        401, 401, 401, 401, 409, 409, 426, 400, 400, 413, 404, 405, 501,
      ]);
      for (const response of negatives) {
        expectTransportHygiene(response, token);
        expect(response.bodyText).not.toContain(host.canonicalRoot);
      }
      // 不得触发停止、文件删除或数据库写入。
      expect(snapshotProtectedFiles(host.canonicalRoot)).toEqual(before);
      const stillAlive = await loopbackRequest({
        port: host.port,
        method: 'GET',
        path: '/v1/host/status',
        token,
      });
      expect(stillAlive.statusCode).toBe(200);
      expect(host.lifecycleState).toBe('ready');
      env.evidence.record('host.f007_negative_matrix', {
        hostInstanceId: host.hostInstanceId,
        rejectedCount: negatives.length,
      });
    } finally {
      await host.close();
      await env.dispose();
    }
  });

  it('陈旧 token/旧实例：重启后旧凭据 401、旧实例 409，新凭据可握手', async () => {
    const first = await startRealHost('shiploop-f007-stale-');
    const canonicalRoot = first.host.canonicalRoot;
    const oldToken = first.token;
    const oldInstance = first.host.hostInstanceId;
    const rootIdentity = first.host.dataRootIdentity;
    await first.host.close();
    try {
      const second = await startHost({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
        env: {},
      });
      try {
        const newToken = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
        first.env.evidence.registerSecret(newToken);
        expect(newToken).not.toBe(oldToken);
        expect(second.hostInstanceId).not.toBe(oldInstance);

        // 旧凭据对新实例一律无效（§4.1/§4.2）。
        const stale = await loopbackRequest({
          port: second.port,
          method: 'POST',
          path: '/v1/host/handshake',
          token: oldToken,
          body: handshakeBody({ hostInstanceId: oldInstance, dataRootIdentity: rootIdentity }),
        });
        expect(stale.statusCode).toBe(401);
        expect(errorBody(stale).code).toBe('unauthorized');

        // 新凭据 + 旧实例 → 409 instance_mismatch。
        const wrongInstance = await loopbackRequest({
          port: second.port,
          method: 'POST',
          path: '/v1/host/handshake',
          token: newToken,
          body: handshakeBody({ hostInstanceId: oldInstance, dataRootIdentity: rootIdentity }),
        });
        expect(wrongInstance.statusCode).toBe(409);
        expect(errorBody(wrongInstance).code).toBe('instance_mismatch');

        // 新凭据 + 新实例 → 200。
        const valid = await loopbackRequest({
          port: second.port,
          method: 'POST',
          path: '/v1/host/handshake',
          token: newToken,
          body: handshakeBody({ hostInstanceId: second.hostInstanceId, dataRootIdentity: rootIdentity }),
        });
        expect(valid.statusCode).toBe(200);
      } finally {
        await second.close();
      }
    } finally {
      await first.env.dispose();
    }
  });
});
