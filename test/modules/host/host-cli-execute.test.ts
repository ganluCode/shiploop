/**
 * F-012 纵向命令执行层验收（契约 §13 全部 + §10.6 + §12.4）。
 *
 * 这些用例通过 CLI 执行层 runHostCli（非 dist、非源码 cwd 冒烟在
 * scripts/smoke-built-entries.ts 的 smokeCliBin）驱动真实 Host 子进程：
 * - start 走 ensureHostRunning（TS 源码正式入口经测试加载器 hooks 启动），
 *   两次 start 连接同一 hostInstanceId，status 取真实生命周期状态；
 * - status/stop 永不启动 Host（无实例 host_not_found 退出码 3，不创建目录）；
 * - stop 只在取得 §10.6 三证据（进程退出/锁可获/发现移除或替换）后报告
 *   stopped；伪 Host 回 completed 但证据不全 → stop_not_confirmed（退出码 1），
 *   不把 accepted/HTTP completed 当已退出，不杀无关活进程；
 * - 解析失败/监听覆盖在任何 I/O 之前拒绝（退出码 2）；认证拒绝/重定向精确
 *   映射 1/3，且握手失败不发业务请求；输出全部脱敏（不含 token）。
 *
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runHostCli,
  type HostCliIo,
  type HostCliRunResult,
  type HostCliFailureEnvelope,
  type HostCliSuccessEnvelope,
} from '../../../packages/cli/src/host/execute.ts';
import { deriveDefaultDataRoot } from '../../../packages/core/src/index.ts';
import { homedir } from 'node:os';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../../helpers/host/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry.ts', import.meta.url),
);

/** 干净树下以 TS 源码运行正式 Host 入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY];
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function collectIo(): { io: HostCliIo; stdout: () => string; stderr: () => string } {
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

interface CliInvocation {
  readonly result: HostCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  env: IsolatedHostEnvironment,
  args: readonly string[],
  options: {
    platform?: string;
    userHomeDir?: string;
    cliEnv?: Readonly<Record<string, string | undefined>>;
    launch?: boolean;
  } = {},
): Promise<CliInvocation> {
  const collected = collectIo();
  const result = await runHostCli({
    args,
    io: collected.io,
    env: options.cliEnv,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.userHomeDir !== undefined ? { userHomeDir: options.userHomeDir } : {}),
    ...(options.launch === false
      ? {}
      : {
          launch: {
            entryArgv: tsEntryArgv(),
            childEnv: env.childEnv(),
          },
        }),
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

function parseEnvelope(invocation: CliInvocation): Record<string, unknown> {
  // --json 时 stdout 必须恰好是一个可解析 JSON 对象（单行）。
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, unknown>;
}

function failureEnvelope(invocation: CliInvocation): HostCliFailureEnvelope {
  const parsed = parseEnvelope(invocation);
  expect(parsed.ok).toBe(false);
  return parsed as unknown as HostCliFailureEnvelope;
}

function successEnvelope(invocation: CliInvocation): HostCliSuccessEnvelope<Record<string, unknown>> {
  const parsed = parseEnvelope(invocation);
  expect(parsed.ok).toBe(true);
  return parsed as unknown as HostCliSuccessEnvelope<Record<string, unknown>>;
}

function isUuidV4(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** §10.6 进程退出证据：有界轮询直至 OS 回收（ESRCH）。 */
async function assertProcessGone(pid: number, budgetMs = 10_000): Promise<void> {
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

describe('F-012 start/status/stop 纵向闭环（真实 Host 子进程）', () => {
  let env: IsolatedHostEnvironment;

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-vertical-' });
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('start 启动并握手；第二次 start 接同一实例；status 真实状态；stop 取得三证据后 stopped，重启换新实例', async () => {
    const { canonicalRoot } = env.dataRoot('vertical');
    const hostDir = join(canonicalRoot, 'host');

    // 1) start：经启动器 spawn 正式 Host 入口候选并完成握手。
    const first = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(first.result.exitCode, first.stderr).toBe(0);
    const firstEnvelope = successEnvelope(first);
    expect(firstEnvelope.command).toBe('host.start');
    const firstResult = firstEnvelope.result;
    expect(firstResult.outcome).toBe('started');
    expect(isUuidV4(firstResult.hostInstanceId)).toBe(true);
    expect(firstResult.listenAddress).toBe('127.0.0.1');
    expect(Number.isInteger(firstResult.port)).toBe(true);
    expect(firstResult.protocolVersion).toBe(1);
    expect(firstResult.lifecycleState).toBe('ready');
    expect(isSha256Hex(firstResult.dataRootIdentity)).toBe(true);
    const instanceId = firstResult.hostInstanceId as string;
    const port = firstResult.port as number;

    const discoveryFile = join(hostDir, 'discovery.json');
    const tokenFile = join(hostDir, 'auth.token');
    const lockFile = join(hostDir, 'writer.lock');
    const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as {
      hostInstanceId: string;
      port: number;
      listenAddress: string;
      pid: number;
    };
    expect(discovery.hostInstanceId).toBe(instanceId);
    expect(discovery.port).toBe(port);
    expect(discovery.listenAddress).toBe('127.0.0.1');
    const firstPid = discovery.pid;
    const token = readFileSync(tokenFile, 'utf8');
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);

    // CLI 调用（=客户端）结束后 Host 仍存活：第二次 start 直接连接既有实例。
    process.kill(firstPid, 0); // 不抛即存活
    const second = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(second.result.exitCode, second.stderr).toBe(0);
    const secondResult = successEnvelope(second).result;
    expect(secondResult.outcome).toBe('already_running');
    expect(secondResult.hostInstanceId).toBe(instanceId);
    expect(secondResult.port).toBe(port);
    expect(second.result.kind).toBe('success');

    // 2) status：真实生命周期状态，只读零写入。
    const status = await runCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
    expect(status.result.exitCode, status.stderr).toBe(0);
    const statusResult = successEnvelope(status).result;
    expect(statusResult.command).toBeUndefined();
    expect(statusResult.hostInstanceId).toBe(instanceId);
    expect(statusResult.lifecycleState).toBe('ready');
    expect(statusResult.pid).toBe(firstPid);
    expect(statusResult.activities).toEqual({ accepted: 0, quiescing: 0 });
    expect(statusResult.stop).toBeNull();

    // 3) stop：显式 commandId；HTTP completed 不算完成，必须三证据齐备。
    const stopCommandId = randomUUID();
    const stop = await runCli(env, [
      'host', 'stop',
      '--data-root', canonicalRoot,
      '--stop-command-id', stopCommandId,
      '--confirm-timeout-ms', '10000',
      '--json',
    ]);
    expect(stop.result.exitCode, stop.stderr).toBe(0);
    const stopResult = successEnvelope(stop).result;
    expect(successEnvelope(stop).command).toBe('host.stop');
    expect(stopResult.status).toBe('stopped');
    expect(stopResult.commandId).toBe(stopCommandId);
    expect(stopResult.hostInstanceId).toBe(instanceId);
    expect(stopResult.evidence).toEqual({
      processExit: 'confirmed',
      lock: 'acquirable',
      discovery: 'removed',
    });

    // 外部证据：进程退出（可核验回收）、发现/凭据删除、锁文件保留、锁已释放。
    await assertProcessGone(firstPid);
    expect(existsSync(discoveryFile)).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
    expect(existsSync(lockFile)).toBe(true);

    // 4) 停止后锁可获：重新 start 得到全新实例（新身份）。
    const restart = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(restart.result.exitCode, restart.stderr).toBe(0);
    const restartResult = successEnvelope(restart).result;
    expect(restartResult.outcome).toBe('started');
    expect(restartResult.hostInstanceId).not.toBe(instanceId);
    expect(isUuidV4(restartResult.hostInstanceId)).toBe(true);

    const restartPid = (
      JSON.parse(readFileSync(discoveryFile, 'utf8')) as { hostInstanceId: string; pid: number }
    ).pid;
    const restartStop = await runCli(env, ['host', 'stop', '--data-root', canonicalRoot, '--json']);
    expect(restartStop.result.exitCode, restartStop.stderr).toBe(0);
    expect(successEnvelope(restartStop).result.status).toBe('stopped');
    await assertProcessGone(restartPid);
    expect(existsSync(discoveryFile)).toBe(false);
  });

  it('重启 stop 后发现确实移除（上一用例收尾核验）', async () => {
    const { canonicalRoot } = env.dataRoot('vertical2');
    const start = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(start.result.exitCode, start.stderr).toBe(0);
    const stop = await runCli(env, ['host', 'stop', '--data-root', canonicalRoot, '--json']);
    expect(stop.result.exitCode, stop.stderr).toBe(0);
    const result = successEnvelope(stop).result;
    expect(result.status).toBe('stopped');
    expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
    expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
  });

  it('省略 --data-root 时使用注入 HOME 的 P01 默认根，全程不触碰真实 HOME', async () => {
    const sandboxHome = join(env.sandboxRoot, 'home-default');
    const defaultRoot = deriveDefaultDataRoot(sandboxHome);
    const realDefaultRoot = deriveDefaultDataRoot(homedir());
    const start = await runCli(env, ['host', 'start', '--json'], { userHomeDir: sandboxHome });
    expect(start.result.exitCode, start.stderr).toBe(0);
    const started = successEnvelope(start).result;
    expect(started.outcome).toBe('started');
    expect(existsSync(join(defaultRoot, 'host', 'discovery.json'))).toBe(true);
    // 真实用户默认根下不得出现本测试的发现文件（HOME 已重定向）。
    expect(existsSync(join(realDefaultRoot, 'host', 'discovery.json'))).toBe(false);

    const status = await runCli(env, ['host', 'status', '--json'], { userHomeDir: sandboxHome });
    expect(status.result.exitCode, status.stderr).toBe(0);
    expect(successEnvelope(status).result.hostInstanceId).toBe(started.hostInstanceId);

    const stop = await runCli(env, ['host', 'stop', '--json'], { userHomeDir: sandboxHome });
    expect(stop.result.exitCode, stop.stderr).toBe(0);
    expect(successEnvelope(stop).result.status).toBe('stopped');
  });

  it('非 JSON 人类输出：start/status 成功走 stdout，含实例与回环地址', async () => {
    const { canonicalRoot } = env.dataRoot('human');
    try {
      const start = await runCli(env, ['host', 'start', '--data-root', canonicalRoot]);
      expect(start.result.exitCode, start.stderr).toBe(0);
      expect(start.stdout).toContain('127.0.0.1:');
      const instanceId = (JSON.parse(readFileSync(join(canonicalRoot, 'host', 'discovery.json'), 'utf8')) as { hostInstanceId: string }).hostInstanceId;
      expect(start.stdout).toContain(instanceId);
      expect(start.stderr).toBe('');

      const status = await runCli(env, ['host', 'status', '--data-root', canonicalRoot]);
      expect(status.result.exitCode, status.stderr).toBe(0);
      expect(status.stdout).toContain('ready');
      expect(status.stdout).toContain(instanceId);
    } finally {
      await runCli(env, ['host', 'stop', '--data-root', canonicalRoot, '--json']);
    }
  });
});

describe('F-012 status/stop 不启动 Host（§12.4/§13.3）', () => {
  let env: IsolatedHostEnvironment;

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-nolaunch-' });
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('status 无实例 → host_not_found 退出码 3，不创建 host 目录、不启动候选', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'status-absent');
    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', absentRoot, '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(3);
    const envelope = failureEnvelope(invocation);
    expect(envelope.command).toBe('host.status');
    expect(envelope.error.code).toBe('host_not_found');
    expect(existsSync(absentRoot)).toBe(false);
    expect(invocation.stdout).not.toContain('Bearer');
  });

  it('stop 无实例 → host_not_found 退出码 3，不启动候选、不创建根', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'stop-absent');
    const invocation = await runCli(
      env,
      ['host', 'stop', '--data-root', absentRoot, '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(3);
    expect(failureEnvelope(invocation).error.code).toBe('host_not_found');
    expect(existsSync(absentRoot)).toBe(false);
  });

  it('省略 --data-root 时按沙箱 HOME 推导默认根；无实例同样 host_not_found 且不写真实 HOME', async () => {
    const sandboxHome = join(env.sandboxRoot, 'home-alt');
    const invocation = await runCli(env, ['host', 'status', '--json'], {
      launch: false,
      userHomeDir: sandboxHome,
    });
    expect(invocation.result.exitCode).toBe(3);
    expect(failureEnvelope(invocation).error.code).toBe('host_not_found');
  });

  it('非 JSON 形态：错误只走 stderr，stdout 为空，退出码 3', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'human-absent');
    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', absentRoot],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(3);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toContain('host_not_found');
  });
});

describe('F-012 输入拒绝（任何 I/O 之前，退出码 2）', () => {
  let env: IsolatedHostEnvironment;

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-input-' });
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('未知参数：JSON 失败信封走 stdout，人类诊断走 stderr，根目录不被创建', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'bad-args');
    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', absentRoot, '--bogus', '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(2);
    const envelope = failureEnvelope(invocation);
    expect(envelope.command).toBe('host.status');
    expect(envelope.error.code).toBe('invalid_input');
    expect(envelope.error.details).toMatchObject({ reason: 'unknown_argument' });
    expect(invocation.stderr).toContain('invalid_input');
    expect(existsSync(absentRoot)).toBe(false);
  });

  it('顶层未知命令 → command=null 的失败信封（退出码 2）', async () => {
    const invocation = await runCli(env, ['project', '--json'], { launch: false });
    expect(invocation.result.exitCode).toBe(2);
    const envelope = failureEnvelope(invocation);
    expect(envelope.command).toBeNull();
    expect(envelope.error.code).toBe('invalid_input');
  });

  it('监听地址覆盖参数 → bind_address_override_rejected（退出码 2），值不回显、根不创建', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'override');
    const invocation = await runCli(
      env,
      ['host', 'start', '--data-root', absentRoot, '--bind', '0.0.0.0', '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(2);
    expect(failureEnvelope(invocation).error.code).toBe('bind_address_override_rejected');
    expect(invocation.stdout).not.toContain('0.0.0.0');
    expect(existsSync(absentRoot)).toBe(false);
  });

  it('监听地址覆盖环境变量 → bind_address_override_rejected（退出码 2）', async () => {
    const { canonicalRoot } = env.dataRoot('env-override');
    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', canonicalRoot, '--json'],
      { launch: false, cliEnv: { SHIPLOOP_HOST_BIND: '0.0.0.0' } },
    );
    expect(invocation.result.exitCode).toBe(2);
    const envelope = failureEnvelope(invocation);
    expect(envelope.error.code).toBe('bind_address_override_rejected');
    expect(envelope.error.details).toMatchObject({ reason: 'listen_override_env_rejected' });
    expect(invocation.stdout).not.toContain('0.0.0.0');
  });

  it('帮助：--help 与 host stop --help 退出码 0 且输出到 stdout，不发生 I/O', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'help');
    const top = await runCli(env, ['--help'], { launch: false });
    expect(top.result.exitCode).toBe(0);
    expect(top.result.kind).toBe('help');
    expect(top.stdout).toContain('shiploop host <start|status|stop>');
    const stopHelp = await runCli(
      env,
      ['host', 'stop', '--data-root', absentRoot, '--help'],
      { launch: false },
    );
    expect(stopHelp.result.exitCode).toBe(0);
    expect(stopHelp.stdout).toContain('stop_not_confirmed');
    expect(existsSync(absentRoot)).toBe(false);
  });

  it('非 darwin 平台 → unsupported_platform 退出码 1，先于任何文件/网络动作', async () => {
    const absentRoot = join(env.sandboxRoot, 'data', 'linux');
    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', absentRoot, '--json'],
      { launch: false, platform: 'linux' },
    );
    expect(invocation.result.exitCode).toBe(1);
    expect(failureEnvelope(invocation).error.code).toBe('unsupported_platform');
    expect(existsSync(absentRoot)).toBe(false);
  });
});

describe('F-012 伪 Host 负例（真实回环 HTTP，精确错误映射）', () => {
  let env: IsolatedHostEnvironment;

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-fake-' });
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('错误 token：status → unauthorized 退出码 1，伪服务只收到握手、未收到业务请求', async () => {
    const { canonicalRoot } = env.dataRoot('wrong-token');
    const server = await env.startFakeServer({
      expectedToken: '1'.repeat(64),
      hostInstanceId: '00000000-0000-4000-8000-000000000000',
      dataRootIdentity: '0'.repeat(64),
      handshakeFault: 'wrong-token',
    });
    const credential = env.mintHostCredential(canonicalRoot);
    env.publishLoopbackDiscovery({
      canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });

    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', canonicalRoot, '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(1);
    expect(failureEnvelope(invocation).error.code).toBe('unauthorized');
    expect(server.requests.map((request) => request.path)).toEqual(['/v1/host/handshake']);
    expect(invocation.stdout).not.toContain(credential.token);
    expect(invocation.stderr).not.toContain(credential.token);
  });

  it('3xx 重定向：status → redirect_rejected 退出码 3，不跟随、不向新地址发凭据', async () => {
    const { canonicalRoot } = env.dataRoot('redirect');
    const credential = env.mintHostCredential(canonicalRoot);
    const server = await env.startFakeServer({
      expectedToken: credential.token,
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
      handshakeFault: 'redirect',
      redirectTargetUrl: 'http://127.0.0.1:9/',
    });
    env.publishLoopbackDiscovery({
      canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });

    const invocation = await runCli(
      env,
      ['host', 'status', '--data-root', canonicalRoot, '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(3);
    expect(failureEnvelope(invocation).error.code).toBe('redirect_rejected');
    expect(server.requests).toHaveLength(1);
  });

  it('HTTP completed 回执但 §10.6 证据不全 → stop_not_confirmed 退出码 1，不报告 stopped、不杀无关活进程', async () => {
    const { canonicalRoot } = env.dataRoot('unconfirmed');
    // 无关活进程：发现中的 pid 指向它，任何路径都不得终止它。
    const unrelated = env.spawnFixtureChild('ready-listen', { label: 'unrelated-live-pid' });
    await unrelated.waitReady();
    unrelated.releaseGo();
    await unrelated.waitMessage('listening', 10_000);

    const server = await env.startFakeServer({
      expectedToken: '3'.repeat(64),
      hostInstanceId: '00000000-0000-4000-8000-000000000000',
      dataRootIdentity: '0'.repeat(64),
      pidOverride: unrelated.pid,
    });
    const credential = env.mintHostCredential(canonicalRoot);
    env.publishLoopbackDiscovery({
      canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      pid: unrelated.pid,
      store: credential.store,
      token: credential.token,
    });
    // 伪服务握手需要返回与发现一致的实例/数据根身份。
    server.setBehavior({ hostInstanceId: credential.hostInstanceId, dataRootIdentity: credential.dataRootIdentity, expectedToken: credential.token });

    const invocation = await runCli(
      env,
      ['host', 'stop', '--data-root', canonicalRoot, '--confirm-timeout-ms', '0', '--json'],
      { launch: false },
    );
    expect(invocation.result.exitCode).toBe(1);
    const envelope = failureEnvelope(invocation);
    expect(envelope.error.code).toBe('stop_not_confirmed');
    expect(envelope.error.details).toMatchObject({
      reason: 'stop_evidence_incomplete',
      confirmTimeoutMs: 0,
    });
    const evidence = envelope.error.details?.evidence as Record<string, unknown>;
    expect(evidence.processExited).toBe(false);
    expect(evidence.discoveryState).toBe('present');
    // 伪 stop 已送达（200 completed），但 CLI 不把它当已退出。
    expect(server.requests.some((request) => request.path === '/v1/host/stop')).toBe(true);
    expect(unrelated.isAlive()).toBe(true);
    expect(invocation.stdout).not.toContain(credential.token);
  });
});
