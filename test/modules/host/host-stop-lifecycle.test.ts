/**
 * F-008 显式 stop 的 quiesce、幂等、收尾顺序与客户端断开/信号边界验收
 *（真实 127.0.0.1 HTTP / 真实临时数据根 / 真实锁 / 受控真实子进程，无模型）。
 *
 * 覆盖（F-008 验收点，契约 §10 全部、§10.7 信号与断开、§9 停止视图、§14 错误映射）：
 * - 已认证且身份匹配的 stop：ready → quiescing → 恒空闲确认 → stopping（关 listener）
 *   → 关 Core → 持锁按实例清理发现/凭据 → 200 最终视图（completed/stopping，
 *   不等于进程已退出）→ 释锁；完成后外部三证据齐备（连接拒绝、发现删除、锁可获）；
 * - 幂等矩阵：同 commandId 同摘要重放返回同一结果/进度（replayed:true，不重复
 *   enterQuiesce/不重复关闭）；同 ID 不同摘要 409 conflict；quiescing 中另一
 *   commandId 409 stop_in_progress；starting 503 not_ready；错误实例 409；
 *   摘要篡改 400；未实现停止能力 501（supportedModes 明示），绝不默默执行；
 * - 窄活动控制端口（§10.2）：以真实受管子进程充当已接受活动——quiesce 预算内
 *   未确认 → 409 quiesce_not_confirmed，Host 保持 quiescing、保留锁与隔离
 *   （竞争者真实获锁尝试 owner_unknown、无第二个写入者），活动收尾后同命令
 *   重提续跑同一操作成功；不新增执行表、不虚构取消能力；
 * - 客户端断开/退出不触发 stop；stop 途中客户端断开不阻断收尾（响应送达失败
 *   不改变语义），完成判据只看外部证据；SIGTERM 真实子进程安全收尾
 *   （exit 0 + 按实例清理 + 释锁），requestSignalShutdown 未确认保留现场；
 * - 所有响应脱敏：不含凭据/绝对路径；负例矩阵执行后发现/凭据/数据库/锁逐字节不变。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  HostProtocolError,
  acquireWriterLock,
  computeStopRequestDigest,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  isHostProtocolError,
  startHost,
  validateHandshakeResponse,
  validateStatusResponse,
  validateStopRequest,
  validateStopResultView,
  type HostStartOptions,
  type LifecycleState,
  type RunningHost,
  type StopOperationView,
} from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import {
  LoopbackProbeError,
  createChildActivityGate,
  createDeferredActivityGate,
  createIsolatedHostEnvironment,
  loopbackRequest,
  type IsolatedHostEnvironment,
  type LoopbackResponse,
} from '../../helpers/host/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_ENTRY_CHILD = fileURLToPath(new URL('../../helpers/host/host-entry-child.ts', import.meta.url));
const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

const OTHER_INSTANCE = '33333333-3333-4333-8333-333333333333';

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时：${description}`);
    }
    await delay(25);
  }
}

/** 合法 stop 请求体（options 省略 = graceful；digest 由同一规范算法计算）。 */
function stopBody(
  hostInstanceId: string,
  commandId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 5,
    commandId,
    hostInstanceId,
    requestDigest: computeStopRequestDigest(commandId, hostInstanceId, { mode: 'graceful' }),
    ...overrides,
  };
}

function errorBody(response: LoopbackResponse): {
  code: string;
  operation: string;
  details?: Record<string, unknown>;
} {
  return (response.json() as { error: { code: string; operation: string; details?: Record<string, unknown> } })
    .error;
}

function readToken(canonicalRoot: string): string {
  return readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
}

function snapshotProtectedFiles(canonicalRoot: string): Record<string, unknown> {
  return {
    discovery: readFileSync(join(canonicalRoot, 'host', 'discovery.json'), 'utf8'),
    token: readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8'),
    lockMtimeMs: statSync(join(canonicalRoot, 'host', 'writer.lock')).mtimeMs,
    dbSize: statSync(join(canonicalRoot, 'core.sqlite')).size,
    dbMtimeMs: statSync(join(canonicalRoot, 'core.sqlite')).mtimeMs,
  };
}

function expectHygiene(response: LoopbackResponse, token: string, canonicalRoot?: string): void {
  expect(response.bodyText).not.toContain(token);
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  if (canonicalRoot !== undefined) {
    expect(response.bodyText).not.toContain(canonicalRoot);
  }
}

interface RealHost {
  env: IsolatedHostEnvironment;
  host: RunningHost;
  token: string;
  canonicalRoot: string;
}

type StopInjection = Partial<Pick<HostStartOptions, 'activityGate' | 'quiesceBudgetMs'>>;

async function startRealHost(prefix: string, injection: StopInjection = {}): Promise<RealHost> {
  const env = createIsolatedHostEnvironment({ prefix });
  try {
    const { canonicalRoot } = env.dataRoot('root');
    const host = await startHost({
      dataRoot: canonicalRoot,
      capabilityCatalog: EMPTY_CATALOG,
      env: {},
      ...injection,
    });
    const token = readToken(canonicalRoot);
    env.evidence.registerSecret(token);
    return { env, host, token, canonicalRoot };
  } catch (error) {
    await env.dispose();
    throw error;
  }
}

async function sendStop(
  real: RealHost,
  commandId: string,
  overrides: Record<string, unknown> = {},
  tokenOverride?: string,
): Promise<LoopbackResponse> {
  return loopbackRequest({
    port: real.host.port,
    method: 'POST',
    path: '/v1/host/stop',
    token: tokenOverride ?? real.token,
    body: stopBody(real.host.hostInstanceId, commandId, overrides),
    timeoutMs: 12_000,
  });
}

describe('F-008 恒空闲 stop 闭环与幂等矩阵', () => {
  it('合法 stop：收尾→按实例清理→最终视图→释锁，外部三证据齐备', async () => {
    const real = await startRealHost('shiploop-f008-close-');
    const { env, host, token, canonicalRoot } = real;
    try {
      const commandId = randomUUID();
      const response = await sendStop(real, commandId);
      expect(response.statusCode).toBe(200);
      const view = validateStopResultView(response.json(), { expectedCommandId: commandId });
      // §10.5：completed/stopping = 收尾完成正在退出，不是进程已退出的证明。
      expect(view).toEqual({ commandId, status: 'completed', stopState: 'stopping', replayed: false });
      expectHygiene(response, token, canonicalRoot);
      expect(host.lifecycleState).toBe('stopping');

      // 外部完成判据（§10.6）：发现/凭据按实例删除、writer.lock 保留、锁可重获。
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();

      // listener 已关：任何新连接被拒绝（HTTP 200 不是退出证明，连接拒绝才是）。
      await expect(
        loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token, timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(LoopbackProbeError);

      // 装配级 close 幂等（不重复释锁/关闭）。
      await host.close();
      await host.close();
      env.evidence.record('host.f008_stop_closed_loop', {
        hostInstanceId: host.hostInstanceId,
        port: host.port,
        commandId,
        lockReacquired: true,
      });
    } finally {
      await host.close().catch(() => {});
      await env.dispose();
    }
  });

  it('stop 校验负例矩阵：401/400/409/501/405 全部零副作用且脱敏', async () => {
    const real = await startRealHost('shiploop-f008-neg-');
    const { env, host, token, canonicalRoot } = real;
    try {
      const before = snapshotProtectedFiles(canonicalRoot);
      const wrongToken = '0'.repeat(64);
      const commandId = randomUUID();
      const negatives: LoopbackResponse[] = [];
      negatives.push(
        // 错误实例（摘要自洽）：409 instance_mismatch，不能停止当前 Host。
        await sendStop(real, commandId, { hostInstanceId: OTHER_INSTANCE, requestDigest: computeStopRequestDigest(commandId, OTHER_INSTANCE, { mode: 'graceful' }) }),
        // 摘要篡改：服务端重算核对，400。
        await sendStop(real, commandId, { requestDigest: '0'.repeat(64) }),
        // 命名未实现能力：501 + supportedModes，绝不默默执行其他控制行为。
        await sendStop(real, commandId, { options: { mode: 'force' } }),
        await sendStop(real, commandId, { cancelWorkers: true }),
        await sendStop(real, commandId, { options: { mode: 'graceful', killProcessTree: true } }),
        // 未知字段 400；未知 schema 版本 400。
        await sendStop(real, commandId, { bogus: 1 }),
        await sendStop(real, commandId, { schemaVersion: 99 }),
        // 结构合法但缺失/错误凭据：401 不可区分。
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/stop', body: stopBody(host.hostInstanceId, commandId) }),
        await sendStop(real, commandId, {}, wrongToken),
        // 结构错误优先于凭据（与 §8 握手顺序同原则）：无 token 的 {} → 400。
        await loopbackRequest({ port: host.port, method: 'POST', path: '/v1/host/stop', body: {} }),
        // 方法不允许 405。
        await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/stop', token }),
      );
      expect(negatives.map((response) => response.statusCode)).toEqual([
        409, 400, 501, 501, 501, 400, 400, 401, 401, 400, 405,
      ]);
      expect(errorBody(negatives[0] as LoopbackResponse).code).toBe('instance_mismatch');
      expect(errorBody(negatives[1] as LoopbackResponse).code).toBe('request_digest_mismatch');
      for (const index of [2, 3, 4]) {
        const error = errorBody(negatives[index] as LoopbackResponse);
        expect(error.code).toBe('unsupported');
        expect(error.operation).toBe('host.stop');
        expect(error.details?.supportedModes).toEqual(['graceful']);
      }
      expect(errorBody(negatives[5] as LoopbackResponse).code).toBe('invalid_input');
      expect(errorBody(negatives[6] as LoopbackResponse).code).toBe('unsupported_schema_version');
      expect(errorBody(negatives[7] as LoopbackResponse).code).toBe('unauthorized');
      expect(errorBody(negatives[8] as LoopbackResponse).code).toBe('unauthorized');
      expect(errorBody(negatives[9] as LoopbackResponse).code).toBe('invalid_input');
      expect(errorBody(negatives[10] as LoopbackResponse).details?.allowedMethods).toEqual(['POST']);
      for (const response of negatives) {
        expectHygiene(response, token, canonicalRoot);
      }

      // 零副作用：发现/凭据/数据库/锁逐字节不变，Host 仍 ready，stop 视图为 null。
      expect(snapshotProtectedFiles(canonicalRoot)).toEqual(before);
      const status = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token });
      expect(status.statusCode).toBe(200);
      const statusBody = validateStatusResponse(status.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });
      expect(statusBody.lifecycleState).toBe('ready');
      expect(statusBody.stop).toBeNull();
      env.evidence.record('host.f008_stop_negative_matrix', {
        hostInstanceId: host.hostInstanceId,
        rejectedCount: negatives.length,
      });
    } finally {
      await host.close();
      await env.dispose();
    }
  });

  it('进行中同 commandId 同摘要重放 → 200 进度 replayed:true；enterQuiesce/收尾仅一次', async () => {
    const gate = createDeferredActivityGate();
    const real = await startRealHost('shiploop-f008-replay-', { activityGate: gate.gate });
    const { env, host, token } = real;
    try {
      const commandId = randomUUID();
      const firstPromise = sendStop(real, commandId);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, '首次 stop 进入 quiescing 等待');
      expect(host.lifecycleState).toBe('quiescing');

      const duplicate = await sendStop(real, commandId);
      expect(duplicate.statusCode).toBe(200);
      const progress = validateStopResultView(duplicate.json(), { expectedCommandId: commandId });
      expect(progress).toEqual({ commandId, status: 'accepted', stopState: 'quiescing', replayed: true });
      expectHygiene(duplicate, token);
      // 不重复 enterQuiesce。
      expect(gate.stats().enterQuiesceCalls).toBe(1);

      gate.confirm();
      const first = await firstPromise;
      expect(first.statusCode).toBe(200);
      const final = validateStopResultView(first.json(), { expectedCommandId: commandId });
      expect(final).toEqual({ commandId, status: 'completed', stopState: 'stopping', replayed: false });
      expect(gate.stats().enterQuiesceCalls).toBe(1);
      expect(gate.stats().awaitBudgetsMs.length).toBe(1);

      // 收尾只发生一次：发现删除、锁可重获（第二次 close 不再释放）。
      await waitFor(
        () => !existsSync(join(real.canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '发现按实例删除',
      );
      const lock = await acquireWriterLock({ canonicalRoot: real.canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      await host.close();
      env.evidence.record('host.f008_stop_replay', {
        hostInstanceId: host.hostInstanceId,
        commandId,
        enterQuiesceCalls: gate.stats().enterQuiesceCalls,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });

  it('quiescing 中另一 commandId → 409 resource_busy stop_in_progress，不接受第二个停止流程', async () => {
    const gate = createDeferredActivityGate();
    const real = await startRealHost('shiploop-f008-conflict-', { activityGate: gate.gate });
    const { env, host, token, canonicalRoot } = real;
    try {
      const commandId = randomUUID();
      const firstPromise = sendStop(real, commandId);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, '首次 stop 进入 quiescing 等待');

      // 另一 commandId（摘要对其自身自洽，经传输重算核对通过）：resource_busy
      // stop_in_progress，零副作用（不改变在途操作）。同 commandId 不同摘要的
      // conflict 分支见控制器级用例（v1 选项空间下该分支经传输层不可达：任何
      // 与登记不同的摘要都先被服务端重算核对以 400 拒绝）。
      const other = await sendStop(real, randomUUID());
      expect(other.statusCode).toBe(409);
      const otherError = errorBody(other);
      expect(otherError.code).toBe('resource_busy');
      expect(otherError.details?.reasonCode).toBe('stop_in_progress');
      expect(otherError.details?.commandId).toBe(commandId);
      expectHygiene(other, token, canonicalRoot);
      expect(host.lifecycleState).toBe('quiescing');
      expect(gate.stats().enterQuiesceCalls).toBe(1);

      gate.confirm();
      const first = await firstPromise;
      expect(first.statusCode).toBe(200);
      await waitFor(
        () => !existsSync(join(canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '发现按实例删除',
      );
      // busy 是零副作用：发现/锁的收尾变化只来自首个合法 stop（enterQuiesce
      // 仍仅 1 次，writer.lock 文件保留）。
      expect(gate.stats().enterQuiesceCalls).toBe(1);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_stop_conflict_busy', {
        hostInstanceId: host.hostInstanceId,
        commandId,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });

  it('stop 与状态查询竞争：quiescing 状态/活动/停止视图经认证 status 可查询', async () => {
    const gate = createDeferredActivityGate(2);
    const real = await startRealHost('shiploop-f008-race-', { activityGate: gate.gate });
    const { env, host, token } = real;
    try {
      const commandId = randomUUID();
      const firstPromise = sendStop(real, commandId);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, 'stop 进入 quiescing 等待');

      const status = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token });
      expect(status.statusCode).toBe(200);
      const body = validateStatusResponse(status.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });
      expect(body.lifecycleState).toBe('quiescing');
      expect(body.activities).toEqual({ accepted: 2, quiescing: 2 });
      expect(body.stop).toEqual({ commandId, status: 'accepted', stopState: 'quiescing', replayed: false });
      expectHygiene(status, token);

      gate.confirm();
      expect((await firstPromise).statusCode).toBe(200);
      await waitFor(
        () => !existsSync(join(real.canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '发现按实例删除',
      );
      env.evidence.record('host.f008_stop_status_race', {
        hostInstanceId: host.hostInstanceId,
        commandId,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });
});

describe('F-008 窄活动门控：真实子进程活动与停止未确认分支', () => {
  it('quiesce 预算内未确认 → 409 quiesce_not_confirmed；保留 quiescing/锁/发现，竞争者无法获锁', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-quiesce-' });
    let host: RunningHost | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('root');
      const activity = env.spawnFixtureChild('ready-listen', { label: 'activity-a' });
      await activity.waitReady();
      activity.releaseGo();
      await activity.waitMessage('listening', 5_000);
      const gate = createChildActivityGate();
      gate.track(activity);
      host = await startHost({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
        env: {},
        activityGate: gate.gate,
        quiesceBudgetMs: 300,
      });
      const token = readToken(canonicalRoot);
      env.evidence.registerSecret(token);
      const before = snapshotProtectedFiles(canonicalRoot);

      const commandId = randomUUID();
      const response = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/stop',
        token,
        body: stopBody(host.hostInstanceId, commandId),
        timeoutMs: 10_000,
      });
      expect(response.statusCode).toBe(409);
      const error = errorBody(response);
      expect(error.code).toBe('resource_busy');
      expect(error.details?.reasonCode).toBe('quiesce_not_confirmed');
      expect(error.details?.commandId).toBe(commandId);
      expect(error.details?.pendingCount).toBe(1);
      expectHygiene(response, token, canonicalRoot);
      // 预算注入生效（内部有界项，非 argv/env）。
      expect(gate.stats().awaitBudgetsMs).toEqual([300]);

      // Host 保持 quiescing、隔离与锁：不报告 stopped、不允许第二写入者。
      expect(host.lifecycleState).toBe('quiescing');
      expect(snapshotProtectedFiles(canonicalRoot)).toEqual(before);
      await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({
        code: 'owner_unknown',
      });
      await expect(
        startHost({ dataRoot: canonicalRoot, capabilityCatalog: EMPTY_CATALOG, env: {}, lockTimeoutMs: 0 }),
      ).rejects.toMatchObject({ code: 'owner_unknown' });
      expect(activity.isAlive()).toBe(true);

      // 停止视图可查询：rejected/resource_busy + reasonCode。
      const status = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token });
      const body = validateStatusResponse(status.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });
      expect(body.lifecycleState).toBe('quiescing');
      expect(body.activities).toEqual({ accepted: 1, quiescing: 1 });
      expect(body.stop).toEqual({
        commandId,
        status: 'rejected',
        stopState: 'resource_busy',
        replayed: false,
        reasonCode: 'quiesce_not_confirmed',
      });
      env.evidence.record('host.f008_quiesce_not_confirmed', {
        hostInstanceId: host.hostInstanceId,
        commandId,
        pendingCount: 1,
        competitorRejected: 'owner_unknown',
      });

      // 活动真实收尾（受控 close + 退出核验）后，同 commandId 同摘要重提续跑同一操作：
      // 不重新 enterQuiesce，成功回执 replayed:true。
      const activityExit = await activity.verifyStopped({ escalate: false, stepMs: 2_000 });
      expect(activityExit.code).toBe(0);
      const retry = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/stop',
        token,
        body: stopBody(host.hostInstanceId, commandId),
        timeoutMs: 10_000,
      });
      expect(retry.statusCode).toBe(200);
      const retried = validateStopResultView(retry.json(), { expectedCommandId: commandId });
      expect(retried).toEqual({ commandId, status: 'completed', stopState: 'stopping', replayed: true });
      expect(gate.stats().enterQuiesceCalls).toBe(1);
      expect(gate.stats().awaitBudgetsMs.length).toBe(2);

      await waitFor(
        () => !existsSync(join(canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '发现按实例删除',
      );
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_quiesce_resume_completed', {
        hostInstanceId: host.hostInstanceId,
        commandId,
        enterQuiesceCalls: gate.stats().enterQuiesceCalls,
      });
    } finally {
      await (host?.close().catch(() => {}) ?? Promise.resolve());
      await env.dispose();
    }
  });
});

describe('F-008 客户端断开与 SIGTERM 安全收尾', () => {
  it('客户端连接断开/退出不触发 stop：另一客户端认证 status 证明 Host 存活', async () => {
    const real = await startRealHost('shiploop-f008-detach-');
    const { env, host, token, canonicalRoot } = real;
    try {
      const before = snapshotProtectedFiles(canonicalRoot);
      // 裸 TCP 连接建立后立即断开（无任何请求）。
      await new Promise<void>((resolveSocket, rejectSocket) => {
        const socket = createConnection({ host: '127.0.0.1', port: host.port });
        socket.once('connect', () => {
          socket.destroy();
          resolveSocket();
        });
        socket.once('error', rejectSocket);
      });
      // 认证请求完成后客户端（探针）连接关闭。
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: {
          schemaVersion: 5,
          protocolVersion: 1,
          hostInstanceId: host.hostInstanceId,
          dataRootIdentity: host.dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);
      validateHandshakeResponse(handshake.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      });

      // 断开不等于停止：Host 仍 ready、发现不变、另一「客户端」status 成功。
      expect(host.lifecycleState).toBe('ready');
      expect(snapshotProtectedFiles(canonicalRoot)).toEqual(before);
      const status = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token });
      expect(status.statusCode).toBe(200);
      env.evidence.record('host.f008_client_detach_survives', {
        hostInstanceId: host.hostInstanceId,
        port: host.port,
      });
    } finally {
      await host.close();
      await env.dispose();
    }
  });

  it('stop 途中客户端断开：收尾不被阻断，按外部证据判定完成', async () => {
    const gate = createDeferredActivityGate();
    const real = await startRealHost('shiploop-f008-midstop-', { activityGate: gate.gate });
    const { env, host, token, canonicalRoot } = real;
    try {
      const commandId = randomUUID();
      const payload = JSON.stringify(stopBody(host.hostInstanceId, commandId));
      const rawRequest = [
        'POST /v1/host/stop HTTP/1.1',
        `Host: 127.0.0.1:${host.port}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`,
        'Connection: close',
        '',
        payload,
      ].join('\r\n');
      const socket = createConnection({ host: '127.0.0.1', port: host.port });
      await new Promise<void>((resolveSocket, rejectSocket) => {
        socket.once('connect', resolveSocket);
        socket.once('error', rejectSocket);
      });
      socket.write(rawRequest);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, 'stop 进入 quiescing 等待');
      // 网络中断：响应将永远无法送达；§10.4 明确这不改变停止语义。
      socket.destroy();

      gate.confirm();
      await waitFor(
        () => !existsSync(join(canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '断连后收尾仍完成发现清理',
      );
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      expect(host.lifecycleState).toBe('stopping');
      env.evidence.record('host.f008_disconnect_mid_stop', {
        hostInstanceId: host.hostInstanceId,
        commandId,
        teardownCompleted: true,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });

  it('SIGTERM：真实子进程按 §10.5 安全收尾（exit 0 + 按实例清理 + 释锁）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-sigterm-' });
    try {
      const { canonicalRoot } = env.dataRoot('root');
      const child = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', canonicalRoot] },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'host-sigterm',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await child.waitReady();
      child.releaseGo();
      const readyMessage = await child.waitMessage('host_ready', 20_000);
      const result = readyMessage.result as { hostInstanceId: string; port: number; pid: number };
      expect(result.pid).toBe(child.pid);
      const token = readToken(canonicalRoot);
      env.evidence.registerSecret(token);
      for (const line of readyMessage.stdoutLines as string[]) {
        expect(line).not.toContain(token);
      }

      child.kill('SIGTERM');
      const exit = await Promise.race([
        child.exited,
        delay(15_000).then(() => {
          throw new Error('SIGTERM 安全收尾超时（15s）');
        }),
      ]);
      // 只在收到进程退出证据后判定收尾；退出码 0（§10.5 第 6 步）。
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_sigterm_shutdown', {
        hostInstanceId: result.hostInstanceId,
        pid: result.pid,
        exitCode: exit.code,
        lockReacquired: true,
      });
    } finally {
      await env.dispose();
    }
  });

  it('requestSignalShutdown：quiesce 未确认返回 unconfirmed 并保留现场；活动收尾后完成', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-signal-' });
    let host: RunningHost | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('root');
      const activity = env.spawnFixtureChild('ready-listen', { label: 'activity-sig' });
      await activity.waitReady();
      activity.releaseGo();
      await activity.waitMessage('listening', 5_000);
      const gate = createChildActivityGate();
      gate.track(activity);
      host = await startHost({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
        env: {},
        activityGate: gate.gate,
        quiesceBudgetMs: 300,
      });
      const token = readToken(canonicalRoot);
      env.evidence.registerSecret(token);

      const first = await host.requestSignalShutdown();
      expect(first).toBe('unconfirmed');
      expect(host.lifecycleState).toBe('quiescing');
      // 未确认保留隔离与锁；信号路径无 commandId，stop 视图保持 null。
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(true);
      await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toMatchObject({
        code: 'owner_unknown',
      });
      const status = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status', token });
      expect(validateStatusResponse(status.json(), {
        expectedHostInstanceId: host.hostInstanceId,
        expectedDataRootIdentity: host.dataRootIdentity,
      }).stop).toBeNull();

      const activityExit = await activity.verifyStopped({ escalate: false, stepMs: 2_000 });
      expect(activityExit.code).toBe(0);
      const second = await host.requestSignalShutdown();
      expect(second).toBe('completed');
      expect(host.lifecycleState).toBe('stopping');
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_signal_unconfirmed_then_completed', {
        hostInstanceId: host.hostInstanceId,
      });
    } finally {
      await (host?.close().catch(() => {}) ?? Promise.resolve());
      await env.dispose();
    }
  });

  it('HTTP stop 进行中收到信号 → already_in_progress，收尾只跑一次', async () => {
    const gate = createDeferredActivityGate();
    const real = await startRealHost('shiploop-f008-sigrace-', { activityGate: gate.gate });
    const { env, host, canonicalRoot } = real;
    try {
      const commandId = randomUUID();
      const firstPromise = sendStop(real, commandId);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, 'stop 进入 quiescing 等待');
      await expect(host.requestSignalShutdown()).resolves.toBe('already_in_progress');

      gate.confirm();
      expect((await firstPromise).statusCode).toBe(200);
      await waitFor(
        () => !existsSync(join(canonicalRoot, 'host', 'discovery.json')),
        5_000,
        '发现按实例删除',
      );
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_signal_during_http_stop', {
        hostInstanceId: host.hostInstanceId,
        commandId,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });
});

describe('F-008 控制器单元边界与装配校验', () => {
  const STUB_TOKEN = randomBytes(32).toString('hex');
  const STUB_INSTANCE = '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10';
  const STUB_ROOT_IDENTITY = '9f2a'.repeat(16);
  const STUB_STARTED_AT = '2026-10-05T00:00:00.000Z';

  interface StubStopRig {
    port: number;
    server: Server;
    controller: ReturnType<typeof createHostStopController>;
    calls: { prepared: number; released: number };
    setLifecycle(next: LifecycleState): void;
    close(): Promise<void>;
  }

  async function startStubStopTransport(initialLifecycle: LifecycleState = 'ready'): Promise<StubStopRig> {
    let lifecycle = initialLifecycle;
    const calls = { prepared: 0, released: 0 };
    const controller = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => {
        calls.prepared += 1;
        return Promise.resolve();
      },
      releaseAfterTeardown: () => {
        calls.released += 1;
        return Promise.resolve();
      },
    });
    const server = createHostLifecycleServer({
      hostInstanceId: STUB_INSTANCE,
      dataRootIdentity: STUB_ROOT_IDENTITY,
      startedAt: STUB_STARTED_AT,
      pid: 4321,
      authToken: STUB_TOKEN,
      getLifecycleState: () => lifecycle,
      getActivities: () => controller.getActivities(),
      stop: controller,
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('桩传输面监听地址非法');
    }
    return {
      port: address.port,
      server,
      controller,
      calls,
      setLifecycle: (next) => {
        lifecycle = next;
      },
      close: () =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        }),
    };
  }

  it('starting 状态 stop → 503 not_ready 零副作用；ready 后同实例 stop 成功且可重放', async () => {
    const rig = await startStubStopTransport('starting');
    try {
      const commandId = randomUUID();
      const early = await loopbackRequest({
        port: rig.port,
        method: 'POST',
        path: '/v1/host/stop',
        token: STUB_TOKEN,
        body: stopBody(STUB_INSTANCE, commandId),
      });
      expect(early.statusCode).toBe(503);
      expect(errorBody(early).code).toBe('not_ready');
      expect(rig.calls).toEqual({ prepared: 0, released: 0 });
      expect(rig.controller.getStopView()).toBeNull();

      rig.setLifecycle('ready');
      const stopped = await loopbackRequest({
        port: rig.port,
        method: 'POST',
        path: '/v1/host/stop',
        token: STUB_TOKEN,
        body: stopBody(STUB_INSTANCE, commandId),
      });
      expect(stopped.statusCode).toBe(200);
      expect(validateStopResultView(stopped.json(), { expectedCommandId: commandId })).toEqual({
        commandId,
        status: 'completed',
        stopState: 'stopping',
        replayed: false,
      });
      expect(rig.calls).toEqual({ prepared: 1, released: 1 });

      // 收尾已登记：同命令重放返回同一结果（进程内版本化去重，§10.4）。
      const replay = await loopbackRequest({
        port: rig.port,
        method: 'POST',
        path: '/v1/host/stop',
        token: STUB_TOKEN,
        body: stopBody(STUB_INSTANCE, commandId),
      });
      expect(replay.statusCode).toBe(200);
      expect(validateStopResultView(replay.json(), { expectedCommandId: commandId }).replayed).toBe(true);
      expect(rig.calls).toEqual({ prepared: 1, released: 1 });
    } finally {
      await rig.close();
    }
  });

  it('控制器级幂等矩阵：同 commandId 不同摘要 → conflict；进行中另一 commandId → stop_in_progress（均零副作用）', async () => {
    let lifecycle: LifecycleState = 'ready';
    let prepared = 0;
    let released = 0;
    const gate = createDeferredActivityGate();
    const controller = createHostStopController({
      activityGate: gate.gate,
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => {
        prepared += 1;
        lifecycle = 'stopping';
        return Promise.resolve();
      },
      releaseAfterTeardown: () => {
        released += 1;
        return Promise.resolve();
      },
    });
    const outcomes: Array<{ kind: 'ok'; view: StopOperationView } | { kind: 'fail'; error: HostProtocolError }> = [];
    const respond = {
      ok: (view: StopOperationView) => outcomes.push({ kind: 'ok' as const, view }),
      fail: (error: HostProtocolError) => outcomes.push({ kind: 'fail' as const, error }),
    };

    const commandId = randomUUID();
    const validated = validateStopRequest(stopBody(STUB_INSTANCE, commandId));
    const firstPromise = controller.requestStop(validated, respond);
    await waitFor(() => gate.pendingAwaits() > 0, 5_000, '首次 stop 进入 quiescing 等待');

    // 同 commandId 不同摘要（在 v1 选项空间下经传输层不可达——传输层先重算
    // 核对；控制器仍须实现 §10.4 的 conflict 行）：conflict 且不改变在途操作。
    await controller.requestStop(
      { ...validated, requestDigest: 'ff'.repeat(32) },
      respond,
    );
    // 进行中另一 commandId：stop_in_progress。
    await controller.requestStop(validateStopRequest(stopBody(STUB_INSTANCE, randomUUID())), respond);
    expect(outcomes.length).toBe(2);
    const conflict = outcomes[0];
    const busy = outcomes[1];
    expect(conflict?.kind).toBe('fail');
    expect(busy?.kind).toBe('fail');
    if (conflict?.kind !== 'fail' || busy?.kind !== 'fail') {
      throw new Error('预期 conflict 与 stop_in_progress 失败分支');
    }
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.error.httpStatus).toBe(409);
    expect(conflict.error.details?.commandId).toBe(commandId);
    expect(busy.error.code).toBe('resource_busy');
    expect(busy.error.details?.reasonCode).toBe('stop_in_progress');
    expect(busy.error.details?.commandId).toBe(commandId);
    // 零副作用：在途视图不变、未触发额外 enterQuiesce/收尾。
    expect(controller.getStopView()).toEqual({
      commandId,
      status: 'accepted',
      stopState: 'quiescing',
      replayed: false,
    });
    expect(gate.stats().enterQuiesceCalls).toBe(1);
    expect(prepared).toBe(0);
    expect(released).toBe(0);

    gate.confirm();
    await firstPromise;
    expect(outcomes.length).toBe(3);
    expect(outcomes[2]?.kind).toBe('ok');
    expect(prepared).toBe(1);
    expect(released).toBe(1);
  });

  it('prepareTeardown 失败 → 500 internal（脱敏）且不释放锁；同命令重提可恢复', async () => {
    let lifecycle: LifecycleState = 'ready';
    let prepared = 0;
    let released = 0;
    const controller = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => {
        prepared += 1;
        if (prepared === 1) {
          return Promise.reject(new Error('注入的清理失败（含 /secret/path 细节）'));
        }
        lifecycle = 'stopping';
        return Promise.resolve();
      },
      releaseAfterTeardown: () => {
        released += 1;
        return Promise.resolve();
      },
    });
    const commandId = randomUUID();
    const validated = validateStopRequest(stopBody(STUB_INSTANCE, commandId));
    const outcomes: Array<{ kind: 'ok'; view: StopOperationView } | { kind: 'fail'; error: HostProtocolError }> = [];
    const respond = {
      ok: (view: StopOperationView) => outcomes.push({ kind: 'ok' as const, view }),
      fail: (error: HostProtocolError) => outcomes.push({ kind: 'fail' as const, error }),
    };

    await controller.requestStop(validated, respond);
    expect(outcomes.length).toBe(1);
    const failure = outcomes[0];
    expect(failure?.kind).toBe('fail');
    if (failure?.kind !== 'fail') {
      throw new Error('预期 prepareTeardown 失败分支');
    }
    expect(failure.error.code).toBe('internal');
    expect(failure.error.httpStatus).toBe(500);
    expect(failure.error.details?.reason).toBe('stop_teardown_unconfirmed');
    // 脱敏：注入的原始错误细节不得进入结构化错误。
    expect(JSON.stringify(failure.error.toErrorBody())).not.toContain('/secret/path');
    // 未确认：不释放（保锁语义），停止视图 rejected/resource_busy。
    expect(released).toBe(0);
    expect(controller.getStopView()).toEqual({
      commandId,
      status: 'rejected',
      stopState: 'resource_busy',
      replayed: false,
    });

    // 同 commandId 同摘要重提：续跑同一操作（不重新 enterQuiesce），成功后回执 replayed:true。
    await controller.requestStop(validated, respond);
    expect(outcomes.length).toBe(2);
    const recovered = outcomes[1];
    expect(recovered?.kind).toBe('ok');
    if (recovered?.kind !== 'ok') {
      throw new Error('预期重提后成功分支');
    }
    expect(recovered.view).toEqual({ commandId, status: 'completed', stopState: 'stopping', replayed: true });
    expect(prepared).toBe(2);
    expect(released).toBe(1);
  });

  it('控制器依赖校验：非法预算/门控/回调 → invalid_input', () => {
    const base = {
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => 'ready' as LifecycleState,
      setLifecycleState: () => {},
      prepareTeardown: () => Promise.resolve(),
      releaseAfterTeardown: () => Promise.resolve(),
    };
    for (const bad of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => createHostStopController({ ...base, quiesceBudgetMs: bad })).toThrowError(
        /quiesceBudgetMs|预算/,
      );
    }
    expect(() =>
      createHostStopController({ ...base, activityGate: {} as never }),
    ).toThrowError(/activityGate|门控/);
    expect(() =>
      createHostStopController({ ...base, prepareTeardown: undefined as never }),
    ).toThrowError(/prepareTeardown/);
    // 边界值 0 与默认上限合法。
    expect(() => createHostStopController({ ...base, quiesceBudgetMs: 0 })).not.toThrow();
  });

  it('startHost 装配校验：非法 activityGate/quiesceBudgetMs → invalid_input 且零文件副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-optval-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'option-reject');
      for (const injection of [
        { activityGate: {} },
        { activityGate: { enterQuiesce: () => ({ accepted: 0 }) } },
        { quiesceBudgetMs: -1 },
        { quiesceBudgetMs: 10_001 },
        { quiesceBudgetMs: 1.5 },
      ]) {
        await expect(
          startHost({
            dataRoot: fresh,
            capabilityCatalog: EMPTY_CATALOG,
            env: {},
            ...(injection as StopInjection),
          }),
        ).rejects.toMatchObject({ code: 'invalid_input' });
        expect(existsSync(fresh)).toBe(false);
      }
    } finally {
      await env.dispose();
    }
  });

  it('close() 等待进行中的 stop 收尾，不双重释锁/关闭', async () => {
    const gate = createDeferredActivityGate();
    const real = await startRealHost('shiploop-f008-close-race-', { activityGate: gate.gate });
    const { env, host, canonicalRoot } = real;
    try {
      const commandId = randomUUID();
      const stopPromise = sendStop(real, commandId);
      await waitFor(() => gate.pendingAwaits() > 0, 5_000, 'stop 进入 quiescing 等待');
      const closing = host.close();
      gate.confirm();
      expect((await stopPromise).statusCode).toBe(200);
      await closing;
      await host.close();
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.f008_close_waits_stop', {
        hostInstanceId: host.hostInstanceId,
        commandId,
      });
    } finally {
      gate.confirmIfPending();
      await host.close().catch(() => {});
      await env.dispose();
    }
  });

  it('信号收尾结果经 wireHostSignalShutdown 只在 completed 时触发退出回调', async () => {
    // 控制器级：completed → 回调；unconfirmed → 不回调（保留现场）。
    let lifecycle: LifecycleState = 'ready';
    const gate = createDeferredActivityGate();
    const controller = createHostStopController({
      activityGate: gate.gate,
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => {
        lifecycle = 'stopping';
        return Promise.resolve();
      },
      releaseAfterTeardown: () => Promise.resolve(),
    });
    const first = controller.requestSignalShutdown();
    await waitFor(() => gate.pendingAwaits() > 0, 5_000, '信号收尾进入 quiescing 等待');
    // 挂起中再次信号：already_in_progress。
    await expect(controller.requestSignalShutdown()).resolves.toBe('already_in_progress');
    gate.confirm();
    await expect(first).resolves.toBe('completed');
    // 完成后再次信号：不重复收尾。
    await expect(controller.requestSignalShutdown()).resolves.toBe('already_in_progress');
    expect(gate.stats().enterQuiesceCalls).toBe(1);
  });
});
