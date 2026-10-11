/**
 * F-010 连接或启动编排与独立后台 Host 启动器验收（契约 §12.4、§6 owner 诊断）。
 *
 * 覆盖（F-010 验收点）：
 * - 有效已有实例直接连接并返回同一 hostInstanceId，不启动新进程；
 * - 无实例时仅经正式获锁 Host 入口启动：独立 argv 数组 spawn（无 shell）、
 *   detached + stdio ignore + 白名单 env，CLI/客户端进程不打开 SQLite；
 * - 后台 Host 不依赖客户端 stdin/stdio/父进程存活：客户端正常退出与被
 *   SIGKILL（含启动中途）后，Host 仍可被另一客户端认证查询与停止；
 * - 多候选同步竞争：失败启动者在预算内重新发现同一胜者，自有落选候选
 *   被有界回收并核验退出，不留未管理进程；
 * - 陈旧发现（死端口 + 陈旧 PID 指向无关活进程）：仅获锁新 Host 替换失效
 *   发现，无关进程不被终止，旧凭据/旧发现不能操作新 Host；
 * - 锁被占且发现损坏、假服务/认证/协议失败：返回 owner_unknown/对应诊断，
 *   不绕过锁、不删锁、不按 PID 杀进程；
 * - 启动失败（候选退出且锁空闲）与发现延迟（预算耗尽）都有明确错误码，
 *   失败路径无残留候选进程、无半文件；
 * - 选项校验失败（含监听地址覆盖 env、非法预算/argv）零文件副作用。
 *
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acquireWriterLock,
  connectToHost,
  createHostFileStore,
  ensureHostRunning,
  isHostProtocolError,
  probeDiscoveredHost,
  DEFAULT_START_BUDGET_MS,
  type HostProtocolError,
} from '../packages/host/src/index.ts';
import { createIsolatedHostEnvironment, writeRawDiscoveryFile } from './helpers/host/index.ts';
import { loopbackRequest } from './helpers/host/http-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(new URL('./helpers/node-ts-loader/register.mjs', import.meta.url));
const HOST_ENTRY_CHILD = fileURLToPath(new URL('./helpers/host/host-entry-child.ts', import.meta.url));
const DETACHED_HOST_ENTRY = fileURLToPath(new URL('./helpers/host/detached-host-entry.ts', import.meta.url));
const STUB_ENTRY = fileURLToPath(new URL('./helpers/host/stub-entry.ts', import.meta.url));
const LAUNCHER_DRIVER_CHILD = fileURLToPath(new URL('./helpers/host/launcher-driver-child.ts', import.meta.url));

/** 干净树下以 TS 源码运行入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
function tsEntryArgv(script: string, ...extra: string[]): string[] {
  return ['--import', REGISTER_HOOKS, script, ...extra];
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  if (!isHostProtocolError(error)) {
    throw new Error(`期望 HostProtocolError(${code})，实际为 ${String(error)}`);
  }
  expect(error.code, `期望错误码 ${code}，实际 ${error.code}（${error.message}）`).toBe(code);
  return error;
}

async function expectEnsureRejected(
  options: Record<string, unknown>,
  code: string,
): Promise<HostProtocolError> {
  try {
    await ensureHostRunning(options as never);
  } catch (error) {
    return expectProtocolError(error, code);
  }
  throw new Error(`期望 ensureHostRunning 以 ${code} 拒绝`);
}

/** §10.6 进程退出证据：有界轮询直至 OS 回收（ESRCH），绝不把无法探测当已退出。 */
async function assertProcessGone(pid: number, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        alive = false;
      }
    }
    if (!alive) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`进程 ${pid} 在 ${budgetMs}ms 预算内未被回收核验`);
    }
    await delay(50);
  }
}

/** 申请后立即关闭，得到一个没有监听者的回环端口（陈旧发现用）。 */
async function deadLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('无法分配临时回环端口');
  }
  const port = address.port;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  return port;
}

/** 尽力停止指定根下的 Host（测试失败路径的清理兜底）；不杀伤任何进程。 */
async function stopHostBestEffort(canonicalRoot: string): Promise<void> {
  try {
    const client = await connectToHost({ canonicalRoot });
    await client.stop().catch(() => undefined);
    client.close();
  } catch {
    // 没有可连接的 Host。
  }
  try {
    const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
    lock.releaseAfterWritesClosed();
  } catch {
    // 尽力而为：锁仍被持有时不做任何强制动作。
  }
}

describe('F-010 选项校验（拒绝即零副作用）', () => {
  it('冻结默认启动预算为契约 §13.2 的 15 000 ms', () => {
    expect(DEFAULT_START_BUDGET_MS).toBe(15_000);
  });

  const INVALID_OPTIONS: Array<[string, Record<string, unknown>]> = [
    ['未知选项键', { extra: 1 }],
    ['根来源歧义', { userHomeDir: '/tmp/x' }],
    ['startBudgetMs 低于下限', { startBudgetMs: 99 }],
    ['startBudgetMs 高于上限', { startBudgetMs: 60_001 }],
    ['startBudgetMs 非整数', { startBudgetMs: 1.5 }],
    ['pollIntervalMs 低于下限', { pollIntervalMs: 10 }],
    ['pollIntervalMs 高于上限', { pollIntervalMs: 1_001 }],
    ['entryArgv 空数组', { entryArgv: [] }],
    ['entryArgv 空串元素', { entryArgv: ['--import', ''] }],
    ['entryArgv 含 NUL', { entryArgv: ['a\0b'] }],
    ['entryArgv 非数组', { entryArgv: 'start.js' }],
    ['nodeExecutable 为空', { nodeExecutable: '' }],
    ['nodeExecutable 非绝对路径', { nodeExecutable: 'node' }],
    ['childEnv 非对象', { childEnv: 7 }],
    ['onCandidateSpawned 非函数', { onCandidateSpawned: 'hook' }],
  ];
  it.each(INVALID_OPTIONS.map(([label, patch], index) => ({ label, patch, index })))(
    '$label → invalid_input 且不创建数据根',
    async ({ label: _label, patch, index }) => {
      const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-options-' });
      try {
        const target = join(env.sandboxRoot, 'data', `invalid-${index}`);
        const options = { dataRoot: target, ...patch };
        await expectEnsureRejected(options, 'invalid_input');
        expect(existsSync(target)).toBe(false);
      } finally {
        await env.dispose();
      }
    },
  );

  it('相对数据根 → invalid_input（不创建任何目录）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-rel-' });
    try {
      await expectEnsureRejected({ dataRoot: 'relative/path' }, 'invalid_input');
    } finally {
      await env.dispose();
    }
  });

  it('注入子进程 env 含监听覆盖变量 → bind_address_override_rejected，值不回显且无副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-envoverride-' });
    try {
      const target = join(env.sandboxRoot, 'data', 'env-override');
      const error = await expectEnsureRejected(
        { dataRoot: target, childEnv: { PATH: '/usr/bin', SHIPLOOP_HOST_BIND: '0.0.0.0' } },
        'bind_address_override_rejected',
      );
      const body = JSON.stringify(error.toErrorBody());
      expect(body).not.toContain('0.0.0.0');
      expect(body).toContain('SHIPLOOP_HOST_BIND');
      expect(existsSync(target)).toBe(false);
      const portError = await expectEnsureRejected(
        { dataRoot: target, childEnv: { SHIPLOOP_HOST_PORT: '8080' } },
        'bind_address_override_rejected',
      );
      expect(JSON.stringify(portError.toErrorBody())).not.toContain('8080');
      expect(existsSync(target)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('非 darwin 平台 → unsupported_platform 且不创建数据根', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-platform-' });
    try {
      const target = join(env.sandboxRoot, 'data', 'platform');
      await expectEnsureRejected({ dataRoot: target, platform: 'linux' }, 'unsupported_platform');
      expect(existsSync(target)).toBe(false);
    } finally {
      await env.dispose();
    }
  });
});

describe('F-010 连接或启动（真实锁 / 真实进程）', () => {
  it('有效已有实例：直接连接同一 hostInstanceId，不启动任何候选进程', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-running-' });
    try {
      const { canonicalRoot } = env.dataRoot('running');
      const hostChild = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', canonicalRoot] },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'existing-host',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await hostChild.waitReady();
      hostChild.releaseGo();
      const ready = await hostChild.waitMessage('host_ready', 20_000);
      const existing = ready.result as { hostInstanceId: string; port: number };

      const spawned: Array<number | undefined> = [];
      const result = await ensureHostRunning({
        dataRoot: canonicalRoot,
        onCandidateSpawned: (pid: number | undefined) => spawned.push(pid),
      });
      try {
        expect(result.outcome).toBe('already_running');
        expect(result.candidate).toBeUndefined();
        expect(spawned).toEqual([]);
        expect(result.client.hostInstanceId).toBe(existing.hostInstanceId);
        expect(result.client.port).toBe(existing.port);
        const status = await result.client.status();
        expect(status.pid).toBe(hostChild.pid);
        expect(status.lifecycleState).toBe('ready');
      } finally {
        result.client.close();
      }
      env.evidence.record('launcher.already_running', {
        hostInstanceId: existing.hostInstanceId,
        port: existing.port,
        existingPid: hostChild.pid ?? null,
      });
    } finally {
      await env.dispose();
    }
  });

  it('无实例：detached 独立 argv 启动真实 Host，凭据不外泄，客户端 close 后 Host 存活', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-start-' });
    const { canonicalRoot, dataRootIdentity } = env.dataRoot('start');
    let hostStopped = false;
    try {
      const candidatePids: Array<number | undefined> = [];
      const result = await ensureHostRunning({
        dataRoot: canonicalRoot,
        entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
        onCandidateSpawned: (pid: number | undefined) => candidatePids.push(pid),
      });
      expect(result.outcome).toBe('started');
      expect(result.canonicalRoot).toBe(canonicalRoot);
      expect(result.dataRootIdentity).toBe(dataRootIdentity);
      expect(result.candidate?.becameHost).toBe(true);
      expect(result.candidate?.pid).toBe(candidatePids[0]);
      const hostPid = result.candidate?.pid;
      expect(typeof hostPid).toBe('number');

      const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
      env.evidence.registerSecret(token);
      // 结果元数据不含凭据（client 为闭包句柄，不参与序列化）。
      const metadata = JSON.stringify({
        outcome: result.outcome,
        candidate: result.candidate ?? null,
        canonicalRoot: result.canonicalRoot,
        dataRootIdentity: result.dataRootIdentity,
      });
      expect(metadata).not.toContain(token);

      const store = createHostFileStore({ canonicalRoot });
      const discovery = store.readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(result.client.hostInstanceId);
      expect(discovery.port).toBe(result.client.port);
      expect(discovery.pid).toBe(hostPid);

      const status = await result.client.status();
      expect(status.pid).toBe(hostPid);
      expect(status.lifecycleState).toBe('ready');

      // 客户端 close 只释放本地观察资源：Host 存活，第二次连接同一实例。
      result.client.close();
      const second = await ensureHostRunning({ dataRoot: canonicalRoot });
      try {
        expect(second.outcome).toBe('already_running');
        expect(second.client.hostInstanceId).toBe(result.client.hostInstanceId);
      } finally {
        second.client.close();
      }

      // 显式停止：完成判据只看外部三证据（§10.6）。
      const client = await connectToHost({ canonicalRoot });
      const view = await client.stop();
      expect(view.status).toBe('completed');
      client.close();
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
      lock.releaseAfterWritesClosed();
      await expect(connectToHost({ canonicalRoot })).rejects.toSatisfy((error: unknown) =>
        isHostProtocolError(error, 'host_not_found'),
      );
      await assertProcessGone(hostPid as number);
      hostStopped = true;
      env.evidence.record('launcher.start_stop', {
        hostInstanceId: result.client.hostInstanceId,
        port: result.client.port,
        pid: hostPid ?? null,
        lockReacquired: true,
      });
    } finally {
      if (!hostStopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('默认根推导：userHomeDir 注入时启动到 P01 默认数据根', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-defroot-' });
    const home = join(env.sandboxRoot, 'home');
    const expectedRoot = join(home, 'Library', 'Application Support', 'shiploop');
    try {
      const result = await ensureHostRunning({
        userHomeDir: home,
        entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
      });
      try {
        expect(result.outcome).toBe('started');
        expect(result.canonicalRoot).toBe(realpathSync(expectedRoot));
        expect(result.candidate?.becameHost).toBe(true);
      } finally {
        result.client.close();
      }
      await stopHostBestEffort(result.canonicalRoot);
      // stopHostBestEffort 之后必须无实例残留证据。
      await expect(connectToHost({ canonicalRoot: result.canonicalRoot })).rejects.toSatisfy(
        (error: unknown) => isHostProtocolError(error, 'host_not_found'),
      );
    } finally {
      await env.dispose();
    }
  });

  it('两个启动器同步竞争：同一胜者实例，落选候选被有界回收核验', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-race-' });
    const { canonicalRoot } = env.dataRoot('race');
    let hostStopped = false;
    try {
      const spawnedA: Array<number | undefined> = [];
      const spawnedB: Array<number | undefined> = [];
      const [resultA, resultB] = await Promise.all([
        ensureHostRunning({
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
          pollIntervalMs: 50,
          onCandidateSpawned: (pid: number | undefined) => spawnedA.push(pid),
        }),
        ensureHostRunning({
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
          pollIntervalMs: 50,
          onCandidateSpawned: (pid: number | undefined) => spawnedB.push(pid),
        }),
      ]);
      // 两方都连接到同一胜者实例（§12.4.3）。
      expect(resultA.client.hostInstanceId).toBe(resultB.client.hostInstanceId);
      const candidates = [resultA.candidate, resultB.candidate];
      const winners = candidates.filter((candidate) => candidate?.becameHost === true);
      const losers = candidates.filter((candidate) => candidate?.becameHost === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // 落选候选：启动器已核验其退出（自行 owner_unknown 退出或被 SIGTERM 回收），
      // 绝不留下未管理的额外 Host。
      const loser = losers[0];
      expect(loser?.exit).toBeDefined();
      expect(
        loser?.exit?.signal === 'SIGTERM' || loser?.exit?.code === 1 || loser?.exit?.code === 0,
        `落选候选退出形态异常：${JSON.stringify(loser?.exit ?? null)}`,
      ).toBe(true);
      await assertProcessGone(loser?.pid as number);

      const store = createHostFileStore({ canonicalRoot });
      const discovery = store.readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(resultA.client.hostInstanceId);
      expect(discovery.pid).toBe(winners[0]?.pid);

      env.evidence.record('launcher.race', {
        hostInstanceId: resultA.client.hostInstanceId,
        winnerPid: winners[0]?.pid ?? null,
        loserPid: loser?.pid ?? null,
        loserExitCode: loser?.exit?.code ?? null,
        loserExitSignal: loser?.exit?.signal ?? null,
      });
      resultA.client.close();
      resultB.client.close();

      const client = await connectToHost({ canonicalRoot });
      await client.stop();
      client.close();
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
      lock.releaseAfterWritesClosed();
      hostStopped = true;
    } finally {
      if (!hostStopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('陈旧发现（死端口 + 陈旧 PID 指向无关活进程）：获锁新 Host 原子替换，无关进程不被终止', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-stale-' });
    const { canonicalRoot } = env.dataRoot('stale');
    let hostStopped = false;
    try {
      // 无关活进程：发现里的陈旧 pid 指向它，任何路径都不得终止它。
      const unrelated = env.spawnFixtureChild('ready-listen', { label: 'unrelated-by-stander' });
      await unrelated.waitReady();
      unrelated.releaseGo();
      await unrelated.waitMessage('listening', 10_000);

      const deadPort = await deadLoopbackPort();
      const credential = env.mintHostCredential(canonicalRoot);
      env.publishLoopbackDiscovery({
        canonicalRoot,
        port: deadPort,
        hostInstanceId: credential.hostInstanceId,
        pid: unrelated.pid,
        store: credential.store,
        token: credential.token,
      });
      const staleDiscovery = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();

      const result = await ensureHostRunning({
        dataRoot: canonicalRoot,
        entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
      });
      try {
        expect(result.outcome).toBe('started');
        expect(result.client.hostInstanceId).not.toBe(credential.hostInstanceId);
        // 无关进程未被终止（不凭 PID 杀进程）。
        expect(unrelated.isAlive()).toBe(true);

        // 旧凭据不能操作新 Host；旧发现指向的死端口不可达。
        const newDiscovery = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
        await expect(
          probeDiscoveredHost({ discovery: newDiscovery, token: credential.token }),
        ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'unauthorized'));
        await expect(
          probeDiscoveredHost({ discovery: staleDiscovery, token: credential.token }),
        ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'unreachable'));

        env.evidence.record('launcher.stale_replaced', {
          staleInstance: credential.hostInstanceId,
          newInstance: result.client.hostInstanceId,
          stalePid: unrelated.pid,
          unrelatedAlive: unrelated.isAlive(),
        });
      } finally {
        result.client.close();
      }
      await stopHostBestEffort(canonicalRoot);
      hostStopped = true;
    } finally {
      if (!hostStopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('锁被占且发现损坏：owner_unknown，不绕过锁、不覆盖损坏文件、原 Host 仍可认证', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-owner-' });
    const { canonicalRoot } = env.dataRoot('owner-unknown');
    let candidatePid: number | undefined;
    try {
      const hostChild = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', canonicalRoot] },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'lock-owner-host',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await hostChild.waitReady();
      hostChild.releaseGo();
      const ready = await hostChild.waitMessage('host_ready', 20_000);
      const existing = ready.result as { hostInstanceId: string; port: number };
      const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
      env.evidence.registerSecret(token);

      // 第三方损坏发现文件（内容损坏但文件形态安全）：原 Host 仍持有锁。
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      writeRawDiscoveryFile(canonicalRoot, '{broken json');

      const error = await expectEnsureRejected(
        {
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY),
          startBudgetMs: 1_200,
          pollIntervalMs: 100,
          onCandidateSpawned: (pid: number | undefined) => {
            candidatePid = pid;
          },
        },
        'owner_unknown',
      );
      // 脱敏：错误不含凭据与绝对路径。
      const body = JSON.stringify(error.toErrorBody());
      expect(body).not.toContain(token);
      expect(body).not.toContain(canonicalRoot);

      // 不绕过锁：损坏文件原样保留（未被覆盖、未被删除），锁仍被原 Host 持有。
      expect(readFileSync(discoveryPath, 'utf8')).toBe('{broken json');
      await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toSatisfy(
        (lockError: unknown) => isHostProtocolError(lockError, 'owner_unknown'),
      );
      // 原 Host 仍可认证（发现损坏 ≠ 实例死亡）：直接对其真实端口握手。
      const handshake = await loopbackRequest({
        port: existing.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: {
          schemaVersion: 5,
          protocolVersion: 1,
          hostInstanceId: existing.hostInstanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);
      // 自有候选已被回收核验，不留未管理进程。
      expect(candidatePid).toBeDefined();
      await assertProcessGone(candidatePid as number);
      env.evidence.record('launcher.owner_unknown', {
        hostInstanceId: existing.hostInstanceId,
        candidatePid: candidatePid ?? null,
        lockStillHeld: true,
      });
    } finally {
      await env.dispose();
    }
  });

  it('不安全发现（权限过宽）：unsafe_discovery，不启动候选、不触碰锁', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-unsafe-' });
    try {
      const { canonicalRoot } = env.dataRoot('unsafe');
      const deadPort = await deadLoopbackPort();
      const credential = env.mintHostCredential(canonicalRoot);
      env.publishLoopbackDiscovery({
        canonicalRoot,
        port: deadPort,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });
      chmodSync(join(canonicalRoot, 'host', 'discovery.json'), 0o644);

      const spawned: Array<number | undefined> = [];
      await expectEnsureRejected(
        { dataRoot: canonicalRoot, onCandidateSpawned: (pid: number | undefined) => spawned.push(pid) },
        'unsafe_discovery',
      );
      expect(spawned).toEqual([]);
      // 未启动候选、未做锁诊断：host/ 里只有夹具发布的三件（无 writer.lock、无 core.sqlite）。
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
      expect(readdirSync(join(canonicalRoot, 'host')).sort()).toEqual(['auth.token', 'discovery.json']);
    } finally {
      await env.dispose();
    }
  });

  const FAKE_FAULTS: Array<[string, 'wrong-token' | 'wrong-protocol' | 'malformed-json', string]> = [
    ['假服务错误凭据', 'wrong-token', 'unauthorized'],
    ['假服务协议不兼容', 'wrong-protocol', 'protocol_incompatible'],
    ['假服务畸形响应', 'malformed-json', 'response_malformed'],
  ];
  it.each(FAKE_FAULTS)('%s：%s → 对应诊断且不另起写入者', async (_label, fault, code) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-fake-' });
    try {
      const { canonicalRoot } = env.dataRoot(`fake-${fault}`);
      const credential = env.mintHostCredential(canonicalRoot);
      const fake = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
        handshakeFault: fault,
      });
      env.publishLoopbackDiscovery({
        canonicalRoot,
        port: fake.port,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });

      const spawned: Array<number | undefined> = [];
      await expectEnsureRejected(
        { dataRoot: canonicalRoot, onCandidateSpawned: (pid: number | undefined) => spawned.push(pid) },
        code,
      );
      // §12.2：握手失败不自动另起写入者——只有一次握手、无候选、无锁文件、无数据库。
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.path).toBe('/v1/host/handshake');
      expect(spawned).toEqual([]);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('假服务 302 重定向：redirect_rejected，目标服务零请求，不另起写入者', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-redirect-' });
    try {
      const { canonicalRoot } = env.dataRoot('redirect');
      const credential = env.mintHostCredential(canonicalRoot);
      const target = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
      });
      const redirector = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
        handshakeFault: 'redirect',
        redirectTargetUrl: target.url,
      });
      env.publishLoopbackDiscovery({
        canonicalRoot,
        port: redirector.port,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });

      const spawned: Array<number | undefined> = [];
      await expectEnsureRejected(
        { dataRoot: canonicalRoot, onCandidateSpawned: (pid: number | undefined) => spawned.push(pid) },
        'redirect_rejected',
      );
      expect(target.requests).toHaveLength(0);
      expect(spawned).toEqual([]);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('启动失败（候选退出且锁空闲）：internal/start_candidate_failed，无残留进程与半文件', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-failstart-' });
    try {
      const { canonicalRoot } = env.dataRoot('fail-start');
      let candidatePid: number | undefined;
      const error = await expectEnsureRejected(
        {
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(STUB_ENTRY, 'exit3'),
          startBudgetMs: 5_000,
          pollIntervalMs: 50,
          onCandidateSpawned: (pid: number | undefined) => {
            candidatePid = pid;
          },
        },
        'internal',
      );
      expect(error.details?.reason).toBe('start_candidate_failed');
      expect(error.details?.exitCode).toBe(3);
      expect(JSON.stringify(error.toErrorBody())).not.toContain(canonicalRoot);
      // 候选从未发布发现、未打开写库；锁诊断证明锁空闲（可获即释）。
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      expect(candidatePid).toBeDefined();
      await assertProcessGone(candidatePid as number);
      env.evidence.record('launcher.start_failed', {
        candidatePid: candidatePid ?? null,
        exitCode: 3,
        lockFree: true,
      });
    } finally {
      await env.dispose();
    }
  });

  it('发现延迟（候选迟迟不就绪）：start_timeout，候选被有界终止并核验退出', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-timeout-' });
    try {
      const { canonicalRoot } = env.dataRoot('timeout');
      let candidatePid: number | undefined;
      const startedAt = Date.now();
      const error = await expectEnsureRejected(
        {
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(STUB_ENTRY, 'linger'),
          startBudgetMs: 600,
          pollIntervalMs: 50,
          onCandidateSpawned: (pid: number | undefined) => {
            candidatePid = pid;
          },
        },
        'start_timeout',
      );
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(15_000);
      expect(error.details?.startBudgetMs).toBe(600);
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      expect(candidatePid).toBeDefined();
      await assertProcessGone(candidatePid as number);
      env.evidence.record('launcher.start_timeout', {
        candidatePid: candidatePid ?? null,
        startBudgetMs: 600,
        elapsedMs: elapsed,
      });
    } finally {
      await env.dispose();
    }
  });

  it('客户端正常退出后 Host 仍存活：另一客户端可认证查询并显式停止', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-detached-' });
    const { canonicalRoot } = env.dataRoot('detached');
    let hostStopped = false;
    try {
      const driver = env.processes.spawn({
        scriptPath: LAUNCHER_DRIVER_CHILD,
        config: { dataRoot: canonicalRoot, entryArgv: tsEntryArgv(DETACHED_HOST_ENTRY) },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'launcher-driver-exit',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await driver.waitReady();
      driver.releaseGo();
      const spawned = await driver.waitMessage('candidate_spawned', 10_000);
      const hostPid = spawned.pid;
      expect(typeof hostPid).toBe('number');
      const ensured = await driver.waitMessage('ensure_result', 20_000);
      expect(ensured.outcome).toBe('started');
      expect(ensured.becameHost).toBe(true);
      const hostInstanceId = ensured.hostInstanceId as string;
      const port = ensured.port as number;

      // 客户端正常退出（协作 close → 退出码 0）：Host 不随客户端退出。
      const exit = await driver.verifyStopped({ stepMs: 1_000 });
      expect(exit.code).toBe(0);

      const client = await connectToHost({ canonicalRoot });
      try {
        expect(client.hostInstanceId).toBe(hostInstanceId);
        expect(client.port).toBe(port);
        const status = await client.status();
        expect(status.pid).toBe(hostPid);
        expect(status.lifecycleState).toBe('ready');
        const view = await client.stop();
        expect(view.status).toBe('completed');
      } finally {
        client.close();
      }
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
      lock.releaseAfterWritesClosed();
      hostStopped = true;
      env.evidence.record('launcher.parent_exit', {
        hostInstanceId,
        port,
        hostPid: typeof hostPid === 'number' ? hostPid : null,
        driverExitCode: exit.code,
      });
    } finally {
      if (!hostStopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('客户端在启动中途被 SIGKILL：detached 候选仍完成启动，Host 可连接可停止', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-midkill-' });
    const { canonicalRoot } = env.dataRoot('midkill');
    let hostStopped = false;
    try {
      const driver = env.processes.spawn({
        scriptPath: LAUNCHER_DRIVER_CHILD,
        config: {
          dataRoot: canonicalRoot,
          entryArgv: tsEntryArgv(STUB_ENTRY, 'delayed-host'),
          childEnv: env.childEnv({ STUB_HOST_DELAY_MS: '900' }),
          startBudgetMs: 10_000,
          pollIntervalMs: 50,
        },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'launcher-driver-killed',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await driver.waitReady();
      driver.releaseGo();
      // 等候选真正 spawn（延迟启动窗口内）再 SIGKILL 客户端：确定性的中途退出。
      const spawned = await driver.waitMessage('candidate_spawned', 10_000);
      const candidatePid = spawned.pid;
      expect(typeof candidatePid).toBe('number');
      driver.kill('SIGKILL');
      const driverExit = await driver.exited;
      expect(driverExit.signal).toBe('SIGKILL');

      // 候选不依赖父进程存活：在预算内完成启动并发布发现。
      let client: Awaited<ReturnType<typeof connectToHost>> | undefined;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          client = await connectToHost({ canonicalRoot });
          break;
        } catch (error) {
          if (!isHostProtocolError(error, 'host_not_found') && !isHostProtocolError(error, 'unreachable')) {
            throw error;
          }
          await delay(150);
        }
      }
      expect(client, '客户端被杀后 Host 仍应在预算内完成启动').toBeDefined();
      try {
        const status = await client!.status();
        expect(status.pid).toBe(candidatePid);
        const view = await client!.stop();
        expect(view.status).toBe('completed');
      } finally {
        client!.close();
      }
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
      lock.releaseAfterWritesClosed();
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      hostStopped = true;
      env.evidence.record('launcher.mid_start_kill', {
        candidatePid: typeof candidatePid === 'number' ? candidatePid : null,
        driverSignal: driverExit.signal,
      });
    } finally {
      if (!hostStopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });
});
