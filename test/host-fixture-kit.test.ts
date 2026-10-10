/**
 * F-005 Host/CLI 测试夹具套件自测（夹具能力的真实回归，不是产品实现）。
 *
 * 验收来源：F-005 四条验收标准——
 * 1. 复用 temp-sandbox：数据根、伪凭据、（后续任务的）数据库与进程全部属于
 *    本次临时资源，不读写真实 HOME 或用户项目；
 * 2. 真实 Node 子进程支持 ready/go 同步屏障、有界等待、退出码与真实监听地址
 *    采集；伪服务可返回错误 token、旧实例、错误协议/数据根与畸形响应；
 * 3. 清理只针对自有（本套件实际 spawn 并经 IPC 核验 pid 的）进程；外层超时、
 *    启动失败、断言失败也回收并核验退出，无法探测的进程绝不视为已停止；
 * 4. 自测覆盖屏障超时与子进程异常退出；证据只含 PID/实例/状态/退出码等非秘密
 *    信息，认证头与 token 文件正文永不进入证据。
 *
 * 本文件只使用 test/helpers/host 夹具面与 Host 契约纯函数；不连接真实模型，
 * 不要求 dist，spawn 的真实子进程均带重定向 HOME/TMPDIR 与 IPC 屏障。
 */
import { connect } from 'node:net';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_HOST_CAPABILITIES,
  computeStopRequestDigest,
  isHostProtocolError,
  validateHandshakeResponse,
  validateStatusResponse,
  validateStopResultView,
} from '../packages/host/src/index.ts';
import {
  confirmProcessExit,
  createIsolatedHostEnvironment,
  EvidenceSecretLeakError,
  FixtureProcessError,
  redactRequestHeaders,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';

const FIXED_OLD_INSTANCE = '11111111-1111-4111-8111-111111111111';

let current: IsolatedHostEnvironment | undefined;
function env(): IsolatedHostEnvironment {
  current = createIsolatedHostEnvironment({ prefix: 'shiploop-f005-', stepMs: 120 });
  return current;
}
afterEach(async () => {
  const active = current;
  current = undefined;
  await active?.dispose();
});

async function expectRejectsWithReason<T>(promise: Promise<T>, reason: string): Promise<FixtureProcessError> {
  const error = await promise.then(
    () => {
      throw new Error('promise 应当拒绝');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FixtureProcessError);
  expect((error as FixtureProcessError).reason).toBe(reason);
  return error as FixtureProcessError;
}

type ListeningMessage = { address: string; port: number };

function errorBody(response: { json(): unknown }): { code: string; operation?: string } {
  const body = response.json() as { error: { code: string; operation?: string } };
  return body.error;
}

const HANDSHAKE_BODY = (instanceId: string, dataRootIdentity: string) => ({
  schemaVersion: 3,
  protocolVersion: 1,
  hostInstanceId: instanceId,
  dataRootIdentity,
});

describe('F-005 隔离环境与数据根', () => {
  it('沙箱在系统临时目录中，与真实 HOME/受测仓库/数据根相互独立', () => {
    const box = env();
    const realHome = realpathSync(process.env.HOME ?? '/nonexistent');
    const root = realpathSync(box.sandboxRoot);
    expect(root.startsWith(realHome + '/')).toBe(false);
    const a = box.dataRoot('a');
    const b = box.dataRoot('b');
    expect(a.canonicalRoot).not.toBe(b.canonicalRoot);
    expect(a.dataRootIdentity).not.toBe(b.dataRootIdentity);
  });

  it('子进程 HOME/TMPDIR/cwd 全部重定向到沙箱；HOME 内写入落在临时目录而非真实 HOME', async () => {
    const box = env();
    const child = box.spawnFixtureChild('ready-listen', { label: 'confined' });
    const ready = await child.waitReady(5_000);
    expect(ready.pid).toBe(child.pid);
    const root = realpathSync(box.sandboxRoot);
    for (const observed of [ready.cwd, ready.home, ready.tmpdir]) {
      const real = realpathSync(observed);
      expect(real === root || real.startsWith(root + '/')).toBe(true);
    }
    child.releaseGo();
    await child.waitMessage('listening', 5_000);
    expect(existsSync(join(ready.home, 'fixture-child-marker'))).toBe(true);
    expect(existsSync(join(process.env.HOME ?? '', 'fixture-child-marker'))).toBe(false);
    expect(child.label).toBe('confined');
  });
});

describe('F-005 ready/go 同步屏障与监听地址采集', () => {
  it('go 之前不放行；放行后报告真实 127.0.0.1 监听且两候选端口不同', async () => {
    const box = env();
    const a = box.spawnFixtureChild('ready-listen');
    const b = box.spawnFixtureChild('ready-listen');
    await Promise.all([a.waitReady(5_000), b.waitReady(5_000)]);

    // 未发 go：有界等待必须超时，且子进程仍存活（不是提前失败）。
    await expectRejectsWithReason(a.waitMessage('listening', 150), 'message_timeout');
    expect(a.isAlive()).toBe(true);
    expect(b.isAlive()).toBe(true);

    a.releaseGo();
    b.releaseGo();
    const [la, lb] = (await Promise.all([
      a.waitMessage('listening', 5_000),
      b.waitMessage('listening', 5_000),
    ])) as unknown as [ListeningMessage, ListeningMessage];
    expect(la.address).toBe('127.0.0.1');
    expect(lb.address).toBe('127.0.0.1');
    expect(la.port).toBeGreaterThan(0);
    expect(la.port).not.toBe(lb.port);

    // 证据是真实 TCP：对报告端口实际建连。
    await Promise.all(
      [la.port, lb.port].map(
        (port) =>
          new Promise<void>((done, fail) => {
            const socket = connect({ host: '127.0.0.1', port }, () => {
              socket.end();
              done();
            });
            socket.on('error', (error) => {
              throw error;
            });
          }),
      ),
    );
  });
});

describe('F-005 有界等待、异常退出与身份核验', () => {
  it('屏障超时：never-ready 在预算内失败，外层回收并核验 SIGTERM 退出', async () => {
    const box = env();
    const child = box.spawnFixtureChild('never-ready');
    const started = performance.now();
    await expectRejectsWithReason(child.waitReady(150), 'ready_timeout');
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(child.isAlive()).toBe(true); // 超时不擅自杀进程
    const result = await child.verifyStopped({ stepMs: 200 });
    expect(result.signal).toBe('SIGTERM');
    expect(child.isAlive()).toBe(false);

    // 退出证据由管理器自动记录：PID/信号是非秘密字段，无 stderr、无凭据。
    const exitEvent = box.evidence.events().find((event) => event.type === 'child.exit');
    expect(exitEvent?.fields).toMatchObject({ pid: child.pid, signal: 'SIGTERM' });
  });

  it('断言失败路径：try/finally 的 dispose 仍回收并核验子进程退出', async () => {
    const box = env();
    const child = box.spawnFixtureChild('ready-listen');
    await child.waitReady(5_000);
    child.releaseGo();
    await child.waitMessage('listening', 5_000);
    const pid = child.pid;
    try {
      throw new Error('模拟用例断言失败');
    } catch {
      await box.dispose(); // finally 式回收
      expect(child.isAlive()).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow(); // OS 层已不存在
    }
  });

  it('启动期异常退出：early-exit 携带真实退出码 7，不留下进程', async () => {
    const box = env();
    const child = box.spawnFixtureChild('early-exit');
    const error = await expectRejectsWithReason(child.waitReady(2_000), 'early_exit');
    expect(error.exit).toEqual({ code: 7, signal: null, escalated: [] });
    expect(child.isAlive()).toBe(false);
  });

  it('go 后崩溃：SIGKILL 信号经退出事件核验（不把探测失败当停止）', async () => {
    const box = env();
    const child = box.spawnFixtureChild('crash-after-go');
    await child.waitReady(5_000);
    child.releaseGo();
    const exit = await child.exited;
    expect(exit.signal).toBe('SIGKILL');
    expect(child.isAlive()).toBe(false);
  });

  it('伪造 ready.pid 被判身份不一致；dispose 只杀 spawn 句柄的真实 pid 并核验', async () => {
    const box = env();
    const child = box.spawnFixtureChild('wrong-pid-ready');
    const error = await expectRejectsWithReason(child.waitReady(2_000), 'identity_mismatch');
    expect(error.pid).toBe(child.pid);
    // 真实子进程仍活着且随后由本套件回收；绝不会去 kill 消息中谎报的 pid。
    expect(child.isAlive()).toBe(true);
    const result = await child.verifyStopped({ stepMs: 200 });
    expect(result.code).toBe(0); // 该场景响应 IPC close
  });

  it('无法确认退出的句柄：confirmProcessExit 拒绝 exit_unconfirmed，绝不报 stopped', async () => {
    env();
    const signals: string[] = [];
    const synthetic = {
      pid: 424242,
      isAlive: () => true,
      kill: (signal?: string | number) => {
        signals.push(String(signal));
        return true;
      },
      send: () => {},
      exited: new Promise<never>(() => {}),
    };
    await expect(confirmProcessExit(synthetic, { stepMs: 30 })).rejects.toMatchObject({
      reason: 'exit_unconfirmed',
      pid: 424242,
    });
    // IPC close（不计信号）→ SIGTERM → SIGKILL 全部尝试后仍无法确认。
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('忽略 SIGTERM 的子进程升级到 SIGKILL，退出经核验', async () => {
    const box = env();
    const child = box.spawnFixtureChild('ignore-sigterm');
    await child.waitReady(5_000);
    child.releaseGo();
    await child.waitMessage('listening', 5_000);
    const result = await child.verifyStopped({ stepMs: 80 });
    expect(result.signal).toBe('SIGKILL');
    expect(result.escalated).toContain('SIGKILL');
    expect(child.isAlive()).toBe(false);
  });
});

describe('F-005 伪服务：协议负例矩阵', () => {
  it('合法握手/状态往返通过客户端侧契约校验，能力声明冻结，pid 为伪服务真实进程', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      lifecycleState: 'ready',
    });
    box.publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port: server.port,
      hostInstanceId: cred.hostInstanceId,
    });

    const handshake = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(handshake.statusCode).toBe(200);
    const hs = validateHandshakeResponse(handshake.json(), {
      expectedHostInstanceId: cred.hostInstanceId,
      expectedDataRootIdentity: root.dataRootIdentity,
    });
    expect(hs.lifecycleState).toBe('ready');
    expect(hs.capabilities).toEqual(CURRENT_HOST_CAPABILITIES);

    const status = await server.jsonRequest('GET', '/v1/host/status', { token: cred.token });
    expect(status.statusCode).toBe(200);
    const st = validateStatusResponse(status.json(), {
      expectedHostInstanceId: cred.hostInstanceId,
      expectedDataRootIdentity: root.dataRootIdentity,
    });
    expect(st.activities).toEqual({ accepted: 0, quiescing: 0 });
    expect(st.stop).toBeNull();
    expect(st.pid).toBe(process.pid); // 伪服务运行在测试进程内，pid 必须真实
  });

  it.each([
    ['missing-token', 'missing-token', 401, 'unauthorized'],
    ['wrong-token', 'wrong-token', 401, 'unauthorized'],
  ] as const)('凭据负例 %s：HTTP %s', async (_name, fault, httpStatus, code) => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      handshakeFault: fault,
    });
    const response = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: fault === 'missing-token' ? undefined : cred.token,
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(response.statusCode).toBe(httpStatus);
    expect(errorBody(response).code).toBe(code);
    expect(response.bodyText).not.toContain(cred.token);
  });

  it('外部 Origin、未知路由、错误方法、超大请求体与 GET 带体均被明确拒绝', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
    });
    const withOrigin = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      headers: { Origin: 'https://evil.example' },
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(withOrigin.statusCode).toBe(401);

    const unknown = await server.jsonRequest('GET', '/v1/host/nope', { token: cred.token });
    expect(unknown.statusCode).toBe(404);

    const wrongMethod = await server.jsonRequest('GET', '/v1/host/handshake', { token: cred.token });
    expect(wrongMethod.statusCode).toBe(405);

    const oversized = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      rawBody: JSON.stringify({ padding: 'x'.repeat(17_000) }),
    });
    expect(oversized.statusCode).toBe(413);

    const getWithBody = await server.jsonRequest('GET', '/v1/host/status', {
      token: cred.token,
      rawBody: '{}',
    });
    expect(getWithBody.statusCode).toBe(400);
  });

  it.each([
    ['stale-instance', 'instance_mismatch'],
    ['wrong-protocol', 'protocol_incompatible'],
    ['wrong-schema', 'unsupported_schema_version'],
    ['wrong-data-root', 'data_root_mismatch'],
    ['bad-lifecycle-state', 'response_malformed'],
    ['capability-lie', 'response_malformed'],
  ] as const)('伪服务身份/版本负例 %s 被客户端校验拒绝', async (fault, code) => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      handshakeFault: fault,
    });
    const response = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(response.statusCode).toBe(200); // 伪服务用 200 撒谎，由客户端校验拆穿
    try {
      validateHandshakeResponse(response.json(), {
        expectedHostInstanceId: cred.hostInstanceId,
        expectedDataRootIdentity: root.dataRootIdentity,
      });
      throw new Error('握手响应本应被拒绝');
    } catch (caught) {
      expect(isHostProtocolError(caught, code)).toBe(true);
    }
  });

  it('畸形 JSON 体不可解析；旧实例常量与零身份确实不同于真实值', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      handshakeFault: 'malformed-json',
    });
    const response = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(() => JSON.parse(response.bodyText)).toThrow(SyntaxError);
    expect(FIXED_OLD_INSTANCE).not.toBe(cred.hostInstanceId);
    expect('0'.repeat(64)).not.toBe(root.dataRootIdentity);
  });

  it('3xx 重定向不被跟随，重定向目标收不到任何请求（更收不到凭据）', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const target = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
    });
    const front = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      handshakeFault: 'redirect',
      redirectTargetUrl: target.url,
    });
    const response = await front.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target.url);
    expect(target.requests).toHaveLength(0);
  });

  it('stop 视图：完成/重放/同 ID 不同实例冲突/错误摘要', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
    });
    const instance = cred.hostInstanceId;
    const commandId = '22222222-2222-4222-8222-222222222222';
    const options = { mode: 'graceful' as const };
    const digest = computeStopRequestDigest(commandId, instance, options);
    const stopBody = { schemaVersion: 3, commandId, hostInstanceId: instance, requestDigest: digest, options };

    const first = await server.jsonRequest('POST', '/v1/host/stop', { token: cred.token, body: stopBody });
    expect(first.statusCode).toBe(200);
    const view = validateStopResultView(first.json(), { expectedCommandId: commandId });
    expect(view.replayed).toBe(false);

    const replay = await server.jsonRequest('POST', '/v1/host/stop', { token: cred.token, body: stopBody });
    expect(validateStopResultView(replay.json()).replayed).toBe(true);

    const otherDigest = computeStopRequestDigest(commandId, FIXED_OLD_INSTANCE, options);
    const conflict = await server.jsonRequest('POST', '/v1/host/stop', {
      token: cred.token,
      body: {
        schemaVersion: 3,
        commandId,
        hostInstanceId: FIXED_OLD_INSTANCE,
        requestDigest: otherDigest,
        options,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(errorBody(conflict).code).toBe('instance_mismatch');

    const wrongDigest = await server.jsonRequest('POST', '/v1/host/stop', {
      token: cred.token,
      body: { ...stopBody, requestDigest: 'a'.repeat(64) },
    });
    expect(wrongDigest.statusCode).toBe(400);
  });
});

describe('F-005 脱敏证据', () => {
  it('记录 PID/实例/状态/退出码/路由；认证头、token 字段、受保护路径一律 fail-closed', () => {
    const box = env();
    box.evidence.record('child.exit', { pid: 123, code: 0, signal: null });
    box.evidence.record('http.exchange', {
      path: '/v1/host/status',
      httpStatus: 200,
      instanceId: FIXED_OLD_INSTANCE,
      state: 'ready',
      auth: 'bearer',
    });
    const serialized = box.evidence.serialize();
    expect(serialized).toContain('123');
    expect(serialized).toContain(FIXED_OLD_INSTANCE);
    expect(serialized).toContain('/v1/host/status');

    const token = 'f'.repeat(64);
    box.evidence.registerSecret(token);
    for (const bad of [
      { authorization: `Bearer ${token}` },
      { nested: { header: { authorization: `Bearer ${token}` } } },
      { requestLine: `authorization Bearer ${token}` },
      { token },
    ]) {
      expect(() => box.evidence.record('leak', bad)).toThrow(EvidenceSecretLeakError);
    }
    expect(() => box.evidence.record('home', { path: process.env.HOME ?? '' })).toThrow(EvidenceSecretLeakError);
  });

  it('redactRequestHeaders 只保留分类布尔/枚举，绝不回传 Authorization 原值', () => {
    const secret = 'e'.repeat(64);
    const view = redactRequestHeaders({
      authorization: `Bearer ${secret}`,
      origin: 'https://evil.example',
      host: '127.0.0.1:54321',
      'content-type': 'application/json',
      'content-length': '42',
    });
    expect(view).toEqual({
      host: '127.0.0.1:54321',
      auth: 'bearer',
      originPresent: true,
      contentType: 'application/json',
      contentLength: 42,
    });
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it('伪服务交换证据与 token 文件正文均不含凭据；错误为服务端契约码与正确 operation', async () => {
    const box = env();
    const root = box.dataRoot();
    const cred = box.mintHostCredential(root.canonicalRoot);
    const server = await box.startFakeServer({
      expectedToken: cred.token,
      hostInstanceId: cred.hostInstanceId,
      dataRootIdentity: root.dataRootIdentity,
      handshakeFault: 'wrong-token',
    });
    box.publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port: server.port,
      hostInstanceId: cred.hostInstanceId,
    });
    const rejected = await server.jsonRequest('POST', '/v1/host/handshake', {
      token: cred.token,
      body: HANDSHAKE_BODY(cred.hostInstanceId, root.dataRootIdentity),
    });
    expect(rejected.statusCode).toBe(401);
    expect(errorBody(rejected).code).toBe('unauthorized');
    expect(errorBody(rejected).operation).toBe('host.handshake');

    const tokenFileContents = readFileSync(join(root.canonicalRoot, 'host/auth.token'), 'utf8');
    expect(tokenFileContents.trim()).toBe(cred.token);
    expect(box.evidence.serialize()).not.toContain(cred.token);
    expect(server.requests[0]!.auth).toBe('bearer'); // 分类而非原值
    expect(JSON.stringify(server.requests[0]!)).not.toContain(cred.token);
  });
});
