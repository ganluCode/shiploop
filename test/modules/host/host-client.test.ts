/**
 * F-009 HostClient 验收（契约 §12：发现读取 → 认证握手双向核验 → 业务请求；
 * 不跟重定向、不泄漏凭据、错误精确分类、close 只释放本地观察资源）。
 *
 * 覆盖（F-009 验收点）：
 * - 只连接发现指向的固定 127.0.0.1 端口；握手必须同时满足 HTTP 200、协议版本
 *   在客户端支持集、hostInstanceId === 发现实例、dataRootIdentity === 本地计算值；
 *   握手通过前不发 status/stop（伪服务观察只含一次握手）；
 * - 错误/缺失 token（401）、旧实例、错误数据根、错误协议/schema、能力撒谎、
 *   坏生命周期、畸形 JSON、响应超限、3xx 重定向均被拒绝且有独立错误码；
 *   重定向目标服务器零请求（不向新地址发送 token）；
 * - host_not_found（无发现）、unreachable（发现指向无人监听的端口）、
 *   invalid_discovery / unsafe_discovery（本地文件校验）互不折算；
 * - 请求/响应有有限超时与 16 KiB 体积预算；延迟超过客户端预算有界失败；
 * - close()/超时/断开只释放本地观察资源：close 后 status/stop 本地拒绝、
 *   伪服务从未收到 stop；另一个新客户端仍可认证 status 证明 Host 存活；
 * - 真实 Host 端到端：发现 → 握手 → status → stop（completed/stopping）→
 *   外部证据（连接拒绝、发现/凭据按实例删除、锁可重获）；
 * - 所有客户端输出（视图、错误体、序列化）不含凭据。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  HostProtocolError,
  acquireWriterLock,
  computeStopRequestDigest,
  isHostProtocolError,
  startHost,
  type HandshakeResponse,
  // F-009 公共面（RED 阶段尚不存在）：
  connectToHost,
  probeDiscoveredHost,
  type HostClient,
} from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import {
  createIsolatedHostEnvironment,
  writeRawDiscoveryFile,
  type FakeHostServer,
  type IsolatedHostEnvironment,
  type MintedHostCredential,
} from '../../helpers/host/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

interface FakeHostSetup {
  env: IsolatedHostEnvironment;
  canonicalRoot: string;
  credential: MintedHostCredential;
  server: FakeHostServer;
}

async function setupFakeHost(behavior: Partial<Parameters<IsolatedHostEnvironment['startFakeServer']>[0]> = {}): Promise<FakeHostSetup> {  const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
  try {
    const root = env.dataRoot();
    const credential = env.mintHostCredential(root.canonicalRoot);
    const server = await env.startFakeServer({
      expectedToken: credential.token,
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
      ...behavior,
    });
    env.publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
    return { env, canonicalRoot: root.canonicalRoot, credential, server };
  } catch (error) {
    await env.dispose();
    throw error;
  }
}

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

function expectNoSecretLeak(value: unknown, token: string): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(token);
  expect(serialized?.includes('Bearer')).toBe(false);
}

describe('F-009 HostClient 握手与双向核验（§12.1/§12.2）', () => {
  it('合法发现 + 合法伪服务：握手通过后 status/stop 可用，凭据只经认证头传递', async () => {
    const { env, canonicalRoot, credential, server } = await setupFakeHost();
    try {
      const client = await connectToHost({ canonicalRoot });
      expect(client.hostInstanceId).toBe(credential.hostInstanceId);
      expect(client.dataRootIdentity).toBe(credential.dataRootIdentity);
      expect(client.listenAddress).toBe('127.0.0.1');
      expect(client.port).toBe(server.port);
      expect(client.handshake.lifecycleState).toBe('ready');

      // 握手恰好一次：Bearer 认证、Host 匹配、无 Origin、无查询串携带凭据。
      expect(server.requests).toHaveLength(1);
      const handshakeObservation = server.requests[0]!;
      expect(handshakeObservation.method).toBe('POST');
      expect(handshakeObservation.path).toBe('/v1/host/handshake');
      expect(handshakeObservation.auth).toBe('bearer');
      expect(handshakeObservation.hostMatched).toBe(true);
      expect(handshakeObservation.originPresent).toBe(false);

      const status = await client.status();
      expect(status.hostInstanceId).toBe(credential.hostInstanceId);
      expect(status.activities).toEqual({ accepted: 0, quiescing: 0 });
      expect(status.stop).toBeNull();

      // stop：显式 commandId，摘要由客户端以同一规范算法计算（伪服务会重算核对）。
      const commandId = randomUUID();
      const stopView = await client.stop({ commandId });
      expect(stopView).toMatchObject({
        commandId,
        status: 'completed',
        stopState: 'stopping',
        replayed: false,
      });
      const stopObservation = server.requests.at(-1)!;
      expect(stopObservation.method).toBe('POST');
      expect(stopObservation.path).toBe('/v1/host/stop');
      const stopRequestBody = stopObservation.body as Record<string, unknown>;
      expect(stopRequestBody.requestDigest).toBe(
        computeStopRequestDigest(commandId, credential.hostInstanceId, { mode: 'graceful' }),
      );
      expect(JSON.stringify(stopRequestBody)).not.toContain(credential.token);

      // 同 commandId 重放（§10.4）：同一停止结果，replayed: true。
      const replayed = await client.stop({ commandId });
      expect(replayed.replayed).toBe(true);
      expect(replayed.commandId).toBe(commandId);

      // 所有输出不含凭据。
      for (const output of [client.handshake, status, stopView, replayed]) {
        expectNoSecretLeak(output, credential.token);
      }
      env.evidence.record('host-client.lifecycle-ok', {
        hostInstanceId: client.hostInstanceId,
        port: client.port,
        requestCount: server.requests.length,
      });
      client.close();
    } finally {
      await env.dispose();
    }
  });

  it.each([
    ['wrong-token', 'unauthorized'],
    ['stale-instance', 'instance_mismatch'],
    ['wrong-protocol', 'protocol_incompatible'],
    ['wrong-schema', 'unsupported_schema_version'],
    ['wrong-data-root', 'data_root_mismatch'],
    ['bad-lifecycle-state', 'response_malformed'],
    ['capability-lie', 'response_malformed'],
    ['malformed-json', 'response_malformed'],
  ] as const)('握手负例 %s → %s，且不发送任何后续业务请求', async (fault, expectedCode) => {
    const { env, canonicalRoot, credential, server } = await setupFakeHost({ handshakeFault: fault });
    try {
      const error = await connectToHost({ canonicalRoot }).then(
        () => {
          throw new Error('connectToHost 应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      const protocolError = expectProtocolError(error, expectedCode);
      // 握手通过前不发 status/stop：伪服务只观察到一次握手。
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.path).toBe('/v1/host/handshake');
      // 错误脱敏：不回显凭据，错误体仅受控字段。
      expectNoSecretLeak(protocolError.toErrorBody(), credential.token);
      expectNoSecretLeak(protocolError.message, credential.token);
      env.evidence.record('host-client.handshake-rejected', {
        fault,
        code: protocolError.code,
        requestCount: server.requests.length,
      });
    } finally {
      await env.dispose();
    }
  });

  it('3xx 重定向被拒绝（redirect_rejected），目标地址零请求、零收证', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    try {
      const root = env.dataRoot();
      const credential = env.mintHostCredential(root.canonicalRoot);
      const redirectTarget = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
      });
      const redirecting = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
        handshakeFault: 'redirect',
        redirectTargetUrl: redirectTarget.url,
      });
      env.publishLoopbackDiscovery({
        canonicalRoot: root.canonicalRoot,
        port: redirecting.port,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });

      const error = await connectToHost({ canonicalRoot: root.canonicalRoot }).then(
        () => {
          throw new Error('connectToHost 应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'redirect_rejected');
      // 绝不跟随重定向：目标服务没有收到任何请求（token 未向新地址重发）。
      expect(redirectTarget.requests).toHaveLength(0);
      expect(redirecting.requests).toHaveLength(1);
      env.evidence.record('host-client.redirect-rejected', {
        targetRequests: redirectTarget.requests.length,
      });
    } finally {
      await env.dispose();
    }
  });

  it('发现缺失（host_not_found）与端口不可达（unreachable）是可区分的错误', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    try {
      const root = env.dataRoot();
      // 无任何文件：host_not_found。
      const missing = await connectToHost({ canonicalRoot: root.canonicalRoot }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(missing, 'host_not_found');

      // 发现指向已关闭的端口：unreachable（不得折算成发现不存在）。
      const credential = env.mintHostCredential(root.canonicalRoot);
      const server = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
      });
      env.publishLoopbackDiscovery({
        canonicalRoot: root.canonicalRoot,
        port: server.port,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });
      await server.close();
      const unreachable = await connectToHost({ canonicalRoot: root.canonicalRoot }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(unreachable, 'unreachable');
      env.evidence.record('host-client.error-classes', {
        missing: (missing as HostProtocolError).code,
        unreachable: (unreachable as HostProtocolError).code,
      });
    } finally {
      await env.dispose();
    }
  });

  it('损坏与不安全的发现被本地校验拒绝（invalid/unsafe_discovery），不发生网络连接', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    try {
      const root = env.dataRoot();
      const credential = env.mintHostCredential(root.canonicalRoot);

      writeRawDiscoveryFile(root.canonicalRoot, '{oops');
      const invalid = await connectToHost({ canonicalRoot: root.canonicalRoot }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(invalid, 'invalid_discovery');

      // 权限过宽 → unsafe_discovery（不 chmod「修复」、不信任）。
      const store = credential.store;
      store.publishDiscovery({
        schemaVersion: 1,
        protocolVersion: 1,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
        listenAddress: '127.0.0.1',
        port: 54321,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      chmodSync(join(root.canonicalRoot, 'host', 'discovery.json'), 0o644);
      const unsafe = await connectToHost({ canonicalRoot: root.canonicalRoot }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(unsafe, 'unsafe_discovery');
    } finally {
      await env.dispose();
    }
  });

  it('握手延迟超过客户端预算有界失败（unreachable），预算外不无限等待', async () => {
    const { env, canonicalRoot, server } = await setupFakeHost({ delayMs: 1_000 });
    try {
      const startedAt = Date.now();
      const error = await connectToHost({
        canonicalRoot,
        timeouts: { handshakeMs: 150 },
      }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      const elapsed = Date.now() - startedAt;
      const unreachableError = expectProtocolError(error, 'unreachable');
      expect(elapsed).toBeLessThan(5_000);
      // 连接已建立、在等响应时超时（不是连接失败）。
      expect(unreachableError.details).toMatchObject({ reason: 'request_timeout' });
    } finally {
      await env.dispose();
    }
  });

  it('响应体超过 16 KiB 上限被拒绝（response_malformed），不缓冲无限数据', async () => {
    const { env, canonicalRoot } = await setupFakeHost({ handshakeFault: 'oversized-response' });
    try {
      const error = await connectToHost({ canonicalRoot }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'response_malformed');
    } finally {
      await env.dispose();
    }
  });

  it('会话建立后服务端身份变化：stop 的 instance_mismatch 按 §14 精确映射', async () => {
    const { env, canonicalRoot, server } = await setupFakeHost();
    try {
      const client = await connectToHost({ canonicalRoot });
      // 伪服务换成另一个实例身份（等价于旧发现指向新实例的场景）。
      server.setBehavior({ hostInstanceId: '33333333-3333-4333-8333-333333333333' });
      const error = await client.stop().then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'instance_mismatch');
      client.close();
    } finally {
      await env.dispose();
    }
  });
});

describe('F-009 HostClient 资源语义与输入纪律（§12.3）', () => {
  it('close() 幂等且只释放本地观察资源：之后 status/stop 本地拒绝，Host 仍存活', async () => {
    const { env, canonicalRoot, credential, server } = await setupFakeHost();
    try {
      const client = await connectToHost({ canonicalRoot });
      const requestsBefore = server.requests.length;
      client.close();
      client.close();

      for (const action of [() => client.status(), () => client.stop()]) {
        const error = await action().then(
          () => {
            throw new Error('应被拒绝');
          },
          (rejection: unknown) => rejection,
        );
        expectProtocolError(error, 'invalid_input');
        expect((error as HostProtocolError).details).toMatchObject({ reason: 'client_closed' });
      }
      // close 从未触发 stop：伪服务没有收到任何新请求（尤其没有 stop）。
      expect(server.requests).toHaveLength(requestsBefore);
      expect(server.requests.some((request) => request.path === '/v1/host/stop')).toBe(false);

      // Host 存活能力：另一个新客户端认证 status 成功（§12.3 必测）。
      const second = await connectToHost({ canonicalRoot });
      const status = await second.status();
      expect(status.hostInstanceId).toBe(credential.hostInstanceId);
      second.close();
      env.evidence.record('host-client.close-keeps-host', {
        hostInstanceId: credential.hostInstanceId,
        requestsDuringClosed: server.requests.length - requestsBefore,
      });
    } finally {
      await env.dispose();
    }
  });

  it('stop 的 commandId 在客户端校验：非法 UUID 不发请求', async () => {
    const { env, canonicalRoot, server } = await setupFakeHost();
    try {
      const client = await connectToHost({ canonicalRoot });
      const requestsBefore = server.requests.length;
      const error = await client.stop({ commandId: 'not-a-uuid' }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'invalid_input');
      expect(server.requests).toHaveLength(requestsBefore);
      client.close();
    } finally {
      await env.dispose();
    }
  });

  it.each([
    ['零超时', { timeouts: { handshakeMs: 0 } }],
    ['负超时', { timeouts: { statusMs: -1 } }],
    ['超出上限', { timeouts: { stopMs: 60_001 } }],
    ['非整数', { timeouts: { connectMs: 1.5 } }],
    ['未知超时键', { timeouts: { unknownKey: 100 } }],
    ['未知选项键', { unknownOption: true }],
  ] as const)('选项校验零副作用拒绝：%s', async (_label: string, options: object) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    try {
      const root = env.dataRoot();
      const error = await connectToHost({ canonicalRoot: root.canonicalRoot, ...options }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'invalid_input');
      // 输入校验先于任何文件/网络操作：host/ 目录未被创建。
      expect(existsSync(join(root.canonicalRoot, 'host'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('非 macOS 平台注入被拒绝（unsupported_platform）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    try {
      const root = env.dataRoot();
      const error = await connectToHost({ canonicalRoot: root.canonicalRoot, platform: 'linux' }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(error, 'unsupported_platform');
    } finally {
      await env.dispose();
    }
  });

  it('probeDiscoveredHost 只做握手核验（F-010 owner 诊断端口），恰好一次请求', async () => {
    const { env, credential, server } = await setupFakeHost();
    try {
      const store = credential.store;
      const discovery = store.readTrustedDiscovery();
      const handshake: HandshakeResponse = await probeDiscoveredHost({
        discovery,
        token: credential.token,
      });
      expect(handshake.hostInstanceId).toBe(credential.hostInstanceId);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.path).toBe('/v1/host/handshake');

      const wrongToken = await probeDiscoveredHost({ discovery, token: '0'.repeat(64) }).then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(wrongToken, 'unauthorized');
      expect(server.requests).toHaveLength(2);
      expectNoSecretLeak((wrongToken as HostProtocolError).toErrorBody(), credential.token);
    } finally {
      await env.dispose();
    }
  });
});

describe('F-009 HostClient 真实 Host 端到端', () => {
  it('发现 → 握手 → status → stop；完成判据为外部证据（连接拒绝/发现删除/锁可获）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-host-client-' });
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const root = env.dataRoot();
      host = await startHost({ dataRoot: root.canonicalRoot, capabilityCatalog: EMPTY_CATALOG, env: {} });
      const token = readFileSync(join(root.canonicalRoot, 'host', 'auth.token'), 'utf8');
      env.evidence.registerSecret(token);

      const client = await connectToHost({ canonicalRoot: root.canonicalRoot });
      expect(client.hostInstanceId).toBe(host.hostInstanceId);
      expect(client.port).toBe(host.port);

      const status = await client.status();
      expect(status.pid).toBe(process.pid);
      expect(status.lifecycleState).toBe('ready');
      expectNoSecretLeak(status, token);

      const commandId = randomUUID();
      const view = await client.stop({ commandId });
      // completed/stopping ≠ 进程已退出（§10.5/§10.6）；完成只看外部证据。
      expect(view).toMatchObject({ commandId, status: 'completed', stopState: 'stopping' });

      // 外部三证据：发现/凭据按实例删除、锁可重获、连接拒绝。
      expect(existsSync(join(root.canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(root.canonicalRoot, 'host', 'auth.token'))).toBe(false);
      expect(existsSync(join(root.canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      const lock = await acquireWriterLock({ canonicalRoot: root.canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      const after = await client.status().then(
        () => {
          throw new Error('应被拒绝');
        },
        (rejection: unknown) => rejection,
      );
      expectProtocolError(after, 'unreachable');

      env.evidence.record('host-client.real-host-stop', {
        hostInstanceId: host.hostInstanceId,
        port: host.port,
        stopStatus: view.status,
        lockReacquired: true,
      });
      client.close();
      host = undefined;
    } finally {
      if (host) {
        await host.close();
      }
      await env.dispose();
    }
  });
});
