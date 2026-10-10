/**
 * F-013 P02-1 整 Feature 真实多进程集成回归（契约 §15 映射、§10.6、§12.4）。
 *
 * 定位：本套件不改任何产品源码，把 F-002 ~ F-012 已交付的能力放进真实多进程
 * 场景做整链回归，并按 §15.1/§15.2 映射 FR-1/FR-2 正常与失败分支；脱敏证据
 * 映射与 not_run 记录见
 * docs/acceptance/evidence-p02-1/f013-regression-evidence.md（文档守护核对）。
 *
 * 覆盖（F-013 验收点 → 用例）：
 * - §15.1 FR-1 正常/失败分支：
 *   · 多 CLI 同步屏障竞争（两个 + 三个多候选）：唯一实际持锁 Host、各成功
 *     连接同一实例、失败候选进程被核验退出（获锁先于 openCoreApplication，
 *     落选者不可能打开写库——F-004 已直接测试锁顺序，此处断言可观察后果：
 *     落选 pid 已消失、唯一 core.sqlite/writer.lock、胜者 pid==发现 pid）、
 *     CLI 退出后 Host 仍存活；
 *   · 规范路径别名与独立数据根；陈旧发现（死端口 + 陈旧 PID 指向无关活进程）；
 *     持锁但发现缺失/损坏（owner_unknown，不产生第二写入者）；崩溃后重新发现；
 *     公开监听覆盖（argv/env × 0.0.0.0/::/非回环 IP/域名）拒绝。
 * - §15.1 FR-2 正常/失败分支：
 *   · token 第三方篡改（错误 token unauthorized）；陈旧 token/旧实例对新 Host
 *     拒绝；假服务（旧实例/数据根不匹配/协议不兼容/错误 schema/畸形响应/302）
 *     与真 Host HTTP 负例（协议 426、实例/数据根 409、Origin/伪造 Host 401）
 *     的返回结果与文件/进程副作用均为拒绝语义；不安全发现权限 unsafe_discovery；
 *   · 同 commandId 停止请求进行中重放（replayed:true，enterQuiesce 仅一次）；
 *     停机未确认（quiesce_not_confirmed）保留锁且 CLI 竞争者不产生第二写入者；
 *     合法 stop 的外部三证据、重启新实例、重开 Core 前序持久数据未损坏。
 * - 停止/重启闭环：CLI stop → stopped 仅在三证据齐备后；重新 start 得到全新
 *   实例；旧身份（实例/凭据）请求被拒绝；测试进程内 Host 场景不适用进程退出
 *   证据（该分支由子进程 Host 用例覆盖，证据文档如实记录）。
 *
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器；所有等待有界，
 * 所有进程退出经 OS 核验，绝不把无法探测当停止。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acquireWriterLock,
  computeStopRequestDigest,
  connectToHost,
  createHostFileStore,
  isHostProtocolError,
  probeDiscoveredHost,
  startHost,
  validateStopResultView,
  type HostDiscoveryRecord,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/index.ts';
import {
  createChildActivityGate,
  createDeferredActivityGate,
  createIsolatedHostEnvironment,
  loopbackRequest,
  writeRawDiscoveryFile,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);
const CLI_DRIVER_CHILD = fileURLToPath(
  new URL('./helpers/host/cli-driver-child.ts', import.meta.url),
);
const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);
const OTHER_INSTANCE = '44444444-4444-4444-8444-444444444444';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

/** 干净树下以 TS 源码运行正式 Host 入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY];
}

// ---------------------------------------------------------------------------
// 公共小工具（与既有套件同一纪律：有界等待、OS 级退出核验、脱敏断言）。
// ---------------------------------------------------------------------------

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

interface ParentCliOptions {
  readonly cliEnv?: Readonly<Record<string, string | undefined>>;
  readonly onCandidateSpawned?: (pid: number | undefined) => void;
  readonly pollIntervalMs?: number;
}

interface CliInvocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: Record<string, unknown> | undefined;
}

/** 测试进程内直接运行生产 CLI 执行层（与 dist/bin.js 同一 runHostCli 路径）。 */
async function runParentCli(
  env: IsolatedHostEnvironment,
  args: readonly string[],
  options: ParentCliOptions = {},
): Promise<CliInvocation> {
  const collected = collectIo();
  const result = await runHostCli({
    args,
    io: collected.io,
    env: options.cliEnv ?? {},
    launch: {
      entryArgv: tsEntryArgv(),
      childEnv: env.childEnv(),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      ...(options.onCandidateSpawned !== undefined
        ? { onCandidateSpawned: options.onCandidateSpawned }
        : {}),
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: collected.stdout(),
    stderr: collected.stderr(),
    envelope: (result.envelope ?? undefined) as Record<string, unknown> | undefined,
  };
}

function expectSuccess(invocation: CliInvocation, command: string): Record<string, unknown> {
  expect(invocation.exitCode, invocation.stderr).toBe(0);
  expect(invocation.envelope, 'JSON 模式 stdout 必须恰好输出一个信封').toBeDefined();
  const envelope = invocation.envelope as Record<string, unknown>;
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function expectFailure(
  invocation: CliInvocation,
  exitCode: number,
  code: string,
): Record<string, unknown> {
  expect(invocation.exitCode, invocation.stderr).toBe(exitCode);
  const envelope = invocation.envelope as Record<string, unknown> | undefined;
  expect(envelope?.ok).toBe(false);
  const error = (envelope as { error?: Record<string, unknown> }).error as Record<string, unknown>;
  expect(error.code).toBe(code);
  return error;
}

/** §10.6 进程退出证据：有界轮询直至 OS 回收（ESRCH），绝不把无法探测当已退出。 */
async function expectProcessGone(pid: number, budgetMs = 10_000): Promise<void> {
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

function expectAlive(pid: number): void {
  process.kill(pid, 0); // 不抛即存活。
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 线上错误体的受控形态：{ error: { code, message, operation, details } }。 */
function wireErrorOf(response: { json(): unknown }): string {
  const parsed = response.json() as { error?: { code?: string } };
  return parsed.error?.code ?? 'undefined';
}

/** 唯一持锁证据：非阻塞获锁必然失败（owner_unknown/owner_active，不区分持有者可核验性）。 */
async function expectLockHeld(canonicalRoot: string): Promise<void> {
  await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toSatisfy(
    (error: unknown) => isHostProtocolError(error, 'owner_unknown') || isHostProtocolError(error, 'owner_active'),
  );
}

async function expectLockAcquirable(canonicalRoot: string): Promise<void> {
  const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 5_000 });
  lock.releaseAfterWritesClosed();
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

function readToken(env: IsolatedHostEnvironment, canonicalRoot: string): string {
  const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
  env.evidence.registerSecret(token);
  return token;
}

function readDiscovery(canonicalRoot: string): HostDiscoveryRecord {
  return createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
}

interface RunningCliHost {
  readonly instanceId: string;
  readonly port: number;
  readonly pid: number;
  readonly token: string;
}

/** 经 CLI start 启动真实 Host 子进程，返回脱敏运行事实（token 只进秘密登记）。 */
async function startHostViaCli(
  env: IsolatedHostEnvironment,
  canonicalRoot: string,
): Promise<RunningCliHost> {
  const invocation = await runParentCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json'], {
    pollIntervalMs: 50,
  });
  const result = expectSuccess(invocation, 'host.start') as { outcome: string; hostInstanceId: string; port: number };
  expect(result.outcome).toBe('started');
  const discovery = readDiscovery(canonicalRoot);
  expect(discovery.hostInstanceId).toBe(result.hostInstanceId);
  expect(discovery.listenAddress).toBe('127.0.0.1');
  expect(discovery.port).toBe(result.port);
  return {
    instanceId: result.hostInstanceId,
    port: result.port,
    pid: discovery.pid,
    token: readToken(env, canonicalRoot),
  };
}

/** 经 CLI stop 停止并核验 §10.6 三证据（进程退出由调用方另行断言子进程 pid）。 */
async function stopHostViaCli(
  env: IsolatedHostEnvironment,
  canonicalRoot: string,
  options: { commandId?: string } = {},
): Promise<Record<string, unknown>> {
  const args = ['host', 'stop', '--data-root', canonicalRoot, '--json'];
  if (options.commandId !== undefined) {
    args.push('--stop-command-id', options.commandId);
  }
  const invocation = await runParentCli(env, args);
  const result = expectSuccess(invocation, 'host.stop');
  expect(result.status).toBe('stopped');
  expect(result.evidence).toEqual({
    processExit: 'confirmed',
    lock: 'acquirable',
    discovery: 'removed',
  });
  return result;
}

/** 尽力停止指定根下的 Host（测试失败路径的清理兜底）；不杀伤任何无关进程。 */
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

interface DriverStartOutcome {
  readonly exitCode: number;
  readonly envelope: Record<string, unknown>;
  readonly result: { outcome: string; hostInstanceId: string; dataRootIdentity: string; port: number };
  readonly candidatePids: readonly number[];
}

/**
 * 以 ready/go 同步屏障在独立真实子进程中运行 CLI（生产执行层 runHostCli）。
 * 返回每个 CLI 的退出码、信封与候选 pid 列表（全部非秘密字段）。
 */
async function raceCliStarts(
  env: IsolatedHostEnvironment,
  dataRootByLabel: readonly { label: string; dataRoot: string }[],
  args: string[] = [],
): Promise<DriverStartOutcome[]> {
  const drivers = dataRootByLabel.map((entry) =>
    env.processes.spawn({
      scriptPath: CLI_DRIVER_CHILD,
      config: {
        args: ['host', 'start', '--data-root', entry.dataRoot, '--json', ...args],
        entryArgv: tsEntryArgv(),
        childEnv: env.childEnv() as Record<string, string>,
        pollIntervalMs: 50,
      },
      cwd: env.sandboxRoot,
      env: env.childEnv(),
      label: entry.label,
      requireInside: env.sandboxRoot,
      evidence: env.evidence,
      readyTimeoutMs: 10_000,
    }),
  );
  try {
    // 同步屏障：两个/三个 CLI 子进程全部就绪后才同时放行。
    await Promise.all(drivers.map((driver) => driver.waitReady()));
    for (const driver of drivers) {
      driver.releaseGo();
    }
    const messages = await Promise.all(
      drivers.map((driver) => driver.waitMessage('cli_result', 40_000)),
    );
    const outcomes: DriverStartOutcome[] = messages.map((message, index) => {
      expect(message.exitCode, `CLI ${dataRootByLabel[index]?.label} 退出码`).toBe(0);
      const envelope = message.envelope as Record<string, unknown>;
      expect(envelope.ok, `CLI ${dataRootByLabel[index]?.label} 信封`).toBe(true);
      const result = envelope.result as DriverStartOutcome['result'];
      return {
        exitCode: message.exitCode as number,
        envelope,
        result,
        candidatePids: (message.candidatePids as number[] | undefined) ?? [],
      };
    });
    // CLI 进程正常退出（客户端退出不停止 Host）：close 后按 CLI 退出码退出。
    for (const driver of drivers) {
      driver.send({ kind: 'close' });
    }
    const exits = await Promise.all(drivers.map((driver) => driver.exited));
    exits.forEach((exit) => {
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
    });
    return outcomes;
  } finally {
    // 驱动子进程已退出；Host 候选由测试按发现/锁证据显式管理。
    for (const driver of drivers) {
      if (driver.isAlive()) {
        await driver.verifyStopped({ stepMs: 1_000 }).catch(() => undefined);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// §15.1 FR-1：多 CLI 同步屏障竞争（唯一持锁 Host / 同一实例 / Host 存活）。
// ---------------------------------------------------------------------------

describe('F-013 FR-1 多 CLI 同步竞争（真实临时数据根 + ready/go 屏障）', () => {
  it('两个 CLI 子进程同时 host start：唯一持锁 Host、各成功连接同一实例、失败候选未打开写库、CLI 退出后 Host 存活', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-race2-' });
    const { canonicalRoot, dataRootIdentity } = env.dataRoot('race');
    let stopped = false;
    try {
      // 竞争前数据根内没有任何写入者产物（获锁后才允许打开 Core）。
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);

      const outcomes = await raceCliStarts(env, [
        { label: 'cli-racer-a', dataRoot: canonicalRoot },
        { label: 'cli-racer-b', dataRoot: canonicalRoot },
      ]);

      // 各成功连接的同一实例（§12.4.3：失败启动者在预算内重新发现胜者）。
      expect(outcomes[0]?.result.hostInstanceId).toBe(outcomes[1]?.result.hostInstanceId);
      expect(outcomes.map((outcome) => outcome.result.dataRootIdentity)).toEqual([
        dataRootIdentity,
        dataRootIdentity,
      ]);
      expect(outcomes.some((outcome) => outcome.result.outcome === 'started')).toBe(true);

      const discovery = readDiscovery(canonicalRoot);
      const hostPid = discovery.pid;
      const instanceId = discovery.hostInstanceId;
      const candidatePids = outcomes.flatMap((outcome) => outcome.candidatePids);
      expect(candidatePids.length, '两个 CLI 都应在发现发布前 spawn 候选').toBeGreaterThanOrEqual(1);
      // 唯一实际持锁 Host：胜者候选 == 发现 pid == 存活进程。
      expect(candidatePids).toContain(hostPid);
      expectAlive(hostPid);
      for (const pid of candidatePids) {
        if (pid !== hostPid) {
          // 失败候选：获锁失败即退出（先于 openCoreApplication），OS 核验消失。
          await expectProcessGone(pid);
        }
      }
      // 失败候选未打开写库的可观察后果：根下恰有一个 core.sqlite 与一个
      // writer.lock，均由胜者创建；胜者即唯一写入者。
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(true);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      expect(fileMode(join(canonicalRoot, 'host'))).toBe(0o700);
      expect(fileMode(join(canonicalRoot, 'host', 'discovery.json'))).toBe(0o600);
      expect(fileMode(join(canonicalRoot, 'host', 'auth.token'))).toBe(0o600);
      expect(fileMode(join(canonicalRoot, 'host', 'writer.lock'))).toBe(0o600);
      // 锁仍被唯一 Host 持有（第二写入者不可能出现）。
      await expectLockHeld(canonicalRoot);

      // CLI 进程（客户端）已退出，Host 仍存活并可被另一客户端认证查询。
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as {
        hostInstanceId: string;
        pid: number;
        lifecycleState: string;
      };
      expect(statusResult.hostInstanceId).toBe(instanceId);
      expect(statusResult.pid).toBe(hostPid);
      expect(statusResult.lifecycleState).toBe('ready');

      // 显式 stop：三证据齐备才 stopped；进程退出与锁释放由外部核验。
      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(hostPid);
      await expectLockAcquirable(canonicalRoot);
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      stopped = true;

      env.evidence.record('f013.fr1_two_cli_race', {
        hostInstanceId: instanceId,
        port: discovery.port,
        winnerPid: hostPid,
        loserPids: candidatePids.filter((pid) => pid !== hostPid),
        candidateCount: candidatePids.length,
        cliExitCodes: outcomes.map((outcome) => outcome.exitCode),
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('三个 CLI 多候选竞争：恰好一个 Host 存活，其余候选全部被核验退出，三方连接同一实例', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-race3-' });
    const { canonicalRoot } = env.dataRoot('race3');
    let stopped = false;
    try {
      const outcomes = await raceCliStarts(env, [
        { label: 'cli-candidate-1', dataRoot: canonicalRoot },
        { label: 'cli-candidate-2', dataRoot: canonicalRoot },
        { label: 'cli-candidate-3', dataRoot: canonicalRoot },
      ]);

      const instanceIds = new Set(outcomes.map((outcome) => outcome.result.hostInstanceId));
      expect(instanceIds.size).toBe(1);
      const instanceId = outcomes[0]?.result.hostInstanceId as string;

      const discovery = readDiscovery(canonicalRoot);
      const hostPid = discovery.pid;
      expect(discovery.hostInstanceId).toBe(instanceId);
      const candidatePids = outcomes.flatMap((outcome) => outcome.candidatePids);
      expect(candidatePids.length).toBeGreaterThanOrEqual(1);
      expect(candidatePids).toContain(hostPid);
      // 唯一存活候选 = Host；其余候选（1 或 2 个）全部被核验退出。
      const loserPids = candidatePids.filter((pid) => pid !== hostPid);
      for (const pid of loserPids) {
        await expectProcessGone(pid);
      }
      expectAlive(hostPid);
      await expectLockHeld(canonicalRoot);

      // 三个 CLI 都成功连接同一实例（already_running 或 started 均为合法竞争结果）。
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as {
        hostInstanceId: string;
        pid: number;
      };
      expect(statusResult.hostInstanceId).toBe(instanceId);
      expect(statusResult.pid).toBe(hostPid);

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(hostPid);
      stopped = true;
      env.evidence.record('f013.fr1_three_cli_race', {
        hostInstanceId: instanceId,
        winnerPid: hostPid,
        loserPids,
        cliExitCodes: outcomes.map((outcome) => outcome.exitCode),
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('规范路径别名与真实路径两个 CLI 同时 start：同一规范根、同一把锁、同一实例', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-alias-' });
    const { canonicalRoot, dataRootIdentity } = env.dataRoot('alias');
    const aliasRoot = join(env.sandboxRoot, 'data', 'alias-link');
    symlinkSync(canonicalRoot, aliasRoot);
    let stopped = false;
    try {
      const outcomes = await raceCliStarts(env, [
        { label: 'cli-real-path', dataRoot: canonicalRoot },
        { label: 'cli-alias-path', dataRoot: aliasRoot },
      ]);

      // realpath 归一：别名与真实路径获得同一数据根身份、同一实例、同一把锁。
      expect(outcomes[0]?.result.hostInstanceId).toBe(outcomes[1]?.result.hostInstanceId);
      expect(new Set(outcomes.map((outcome) => outcome.result.dataRootIdentity)).size).toBe(1);
      expect(outcomes[0]?.result.dataRootIdentity).toBe(dataRootIdentity);

      const discovery = readDiscovery(canonicalRoot);
      const hostPid = discovery.pid;
      const candidatePids = outcomes.flatMap((outcome) => outcome.candidatePids);
      expect(candidatePids).toContain(hostPid);
      for (const pid of candidatePids) {
        if (pid !== hostPid) {
          await expectProcessGone(pid);
        }
      }
      // 锁目标文件只在真实规范根下（别名路径解析到同一文件）。
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      expect(existsSync(join(aliasRoot, 'host', 'writer.lock'))).toBe(true); // 同一文件。
      await expectLockHeld(canonicalRoot);
      // 锁/存储 API 只接受 realpath 固定的规范根：别名输入本身被拒绝（不产生
      // 第二把锁的入口），同一真实根仍竞争同一把锁。
      await expect(acquireWriterLock({ canonicalRoot: aliasRoot, timeoutMs: 0 })).rejects.toSatisfy(
        (lockError: unknown) => isHostProtocolError(lockError, 'invalid_input'),
      );

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(hostPid);
      stopped = true;
      env.evidence.record('f013.fr1_alias_race', {
        hostInstanceId: discovery.hostInstanceId,
        dataRootIdentity,
        winnerPid: hostPid,
        candidateCount: candidatePids.length,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('两个独立数据根并发 start：两个 Host 并存、身份不同、各自持锁、互不干扰', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-tworoots-' });
    const rootA = env.dataRoot('root-a');
    const rootB = env.dataRoot('root-b');
    let stoppedA = false;
    let stoppedB = false;
    try {
      const outcomes = await raceCliStarts(env, [
        { label: 'cli-root-a', dataRoot: rootA.canonicalRoot },
        { label: 'cli-root-b', dataRoot: rootB.canonicalRoot },
      ]);

      // 不同 realpath 是不同数据根：两个 Host 各自启动、身份不同、端口独立。
      expect(outcomes[0]?.result.hostInstanceId).not.toBe(outcomes[1]?.result.hostInstanceId);
      expect(outcomes[0]?.result.dataRootIdentity).not.toBe(outcomes[1]?.result.dataRootIdentity);
      expect(outcomes[0]?.result.dataRootIdentity).toBe(rootA.dataRootIdentity);
      expect(outcomes[1]?.result.dataRootIdentity).toBe(rootB.dataRootIdentity);

      const discoveryA = readDiscovery(rootA.canonicalRoot);
      const discoveryB = readDiscovery(rootB.canonicalRoot);
      expect(discoveryA.pid).not.toBe(discoveryB.pid);
      expectAlive(discoveryA.pid);
      expectAlive(discoveryB.pid);
      // 各自持锁：两个根的锁同时不可获（并存的多写入者、每根唯一）。
      await expectLockHeld(rootA.canonicalRoot);
      await expectLockHeld(rootB.canonicalRoot);

      // 两个 Host 都存活可用，且 status 各自返回本根实例。
      for (const [root, discovery] of [
        [rootA, discoveryA],
        [rootB, discoveryB],
      ] as const) {
        const status = await runParentCli(env, ['host', 'status', '--data-root', root.canonicalRoot, '--json']);
        const statusResult = expectSuccess(status, 'host.status') as { hostInstanceId: string; pid: number };
        expect(statusResult.hostInstanceId).toBe(discovery.hostInstanceId);
        expect(statusResult.pid).toBe(discovery.pid);
      }

      await stopHostViaCli(env, rootA.canonicalRoot);
      await expectProcessGone(discoveryA.pid);
      stoppedA = true;
      // A 停止不影响 B：B 仍持锁存活。
      expectAlive(discoveryB.pid);
      await expectLockHeld(rootB.canonicalRoot);
      await stopHostViaCli(env, rootB.canonicalRoot);
      await expectProcessGone(discoveryB.pid);
      stoppedB = true;

      env.evidence.record('f013.fr1_independent_roots', {
        instanceA: discoveryA.hostInstanceId,
        instanceB: discoveryB.hostInstanceId,
        pidA: discoveryA.pid,
        pidB: discoveryB.pid,
      });
    } finally {
      if (!stoppedA) {
        await stopHostBestEffort(rootA.canonicalRoot);
      }
      if (!stoppedB) {
        await stopHostBestEffort(rootB.canonicalRoot);
      }
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §15.1 FR-1 失败分支：陈旧发现 / 持锁发现失效 / 崩溃重发现 / 监听覆盖。
// ---------------------------------------------------------------------------

describe('F-013 FR-1 失效发现、陈旧 PID、崩溃重发现与旧清理迟到', () => {
  it('持锁但发现缺失：CLI start owner_unknown（退出码 1），不产生第二写入者，原 Host 仍可认证', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-nodisc-' });
    const { canonicalRoot } = env.dataRoot('nodisc');
    let hostPid: number | undefined;
    try {
      const host = await startHostViaCli(env, canonicalRoot);
      hostPid = host.pid;
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      expect(existsSync(discoveryPath)).toBe(true);

      // 第三方移除发现文件（锁仍被原 Host 持有）。
      unlinkSync(discoveryPath);

      let candidatePids: number[] = [];
      const invocation = await runParentCli(
        env,
        ['host', 'start', '--data-root', canonicalRoot, '--start-timeout-ms', '3000', '--json'],
        {
          pollIntervalMs: 50,
          onCandidateSpawned: (pid) => {
            if (pid !== undefined) {
              candidatePids.push(pid);
            }
          },
        },
      );
      expectFailure(invocation, 1, 'owner_unknown');
      // 不绕过锁、不删原 Host 文件：锁仍被持有，凭据仍在，原 Host 存活。
      await expectLockHeld(canonicalRoot);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(true);
      expect(existsSync(discoveryPath)).toBe(false);
      expectAlive(hostPid);
      // CLI 的候选已被有界回收并核验退出，不留未管理进程。
      for (const pid of candidatePids) {
        await expectProcessGone(pid);
      }
      candidatePids = [];

      // 原 Host 仍可认证（发现缺失 ≠ 实例死亡）：直接对其真实端口握手。
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: host.token,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: host.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);

      // 显式 SIGTERM 安全收尾：发现缺席（skipped_discovery_absent）按完成处理。
      process.kill(hostPid, 'SIGTERM');
      await expectProcessGone(hostPid);
      await expectLockAcquirable(canonicalRoot);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);

      env.evidence.record('f013.fr1_lock_held_discovery_missing', {
        hostInstanceId: host.instanceId,
        port: host.port,
        ownerUnknownExitCode: 1,
        lockStillHeld: true,
      });
      hostPid = undefined;
    } finally {
      if (hostPid !== undefined) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('持锁但发现损坏：owner_unknown 且损坏文件不被覆盖；恢复发现后可正常 stop', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-baddisc-' });
    const { canonicalRoot } = env.dataRoot('baddisc');
    let hostPid: number | undefined;
    try {
      const host = await startHostViaCli(env, canonicalRoot);
      hostPid = host.pid;
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      const original = readFileSync(discoveryPath, 'utf8');

      // 第三方损坏发现（文件形态安全、内容不可解析）：锁仍被原 Host 持有。
      writeRawDiscoveryFile(canonicalRoot, '{broken json');

      const invocation = await runParentCli(
        env,
        ['host', 'start', '--data-root', canonicalRoot, '--start-timeout-ms', '3000', '--json'],
        { pollIntervalMs: 50 },
      );
      expectFailure(invocation, 1, 'owner_unknown');
      // 不覆盖可疑位置、不删除损坏文件、不绕过锁。
      expect(readFileSync(discoveryPath, 'utf8')).toBe('{broken json');
      await expectLockHeld(canonicalRoot);
      expectAlive(hostPid);
      // 原 Host 仍可认证（对真实端口直接握手）。
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: host.token,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: host.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);

      // 现场恢复（管理员修复发现文件）后，正常路径立即可用。
      writeRawDiscoveryFile(canonicalRoot, original);
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as { pid: number; lifecycleState: string };
      expect(statusResult.pid).toBe(hostPid);
      expect(statusResult.lifecycleState).toBe('ready');

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(hostPid);
      hostPid = undefined;
      env.evidence.record('f013.fr1_lock_held_discovery_corrupt', {
        hostInstanceId: host.instanceId,
        ownerUnknownExitCode: 1,
        recoveredAndStopped: true,
      });
    } finally {
      if (hostPid !== undefined) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('陈旧 PID 指向无关活进程：CLI start 替换失效发现，无关进程存活，旧凭据被拒绝', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-stalepid-' });
    const { canonicalRoot } = env.dataRoot('stalepid');
    let stopped = false;
    try {
      // 无关活进程：陈旧发现中的 pid 指向它，任何路径都不得终止它。
      const unrelated = env.spawnFixtureChild('ready-listen', { label: 'unrelated-live-pid' });
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

      const invocation = await runParentCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json'], {
        pollIntervalMs: 50,
      });
      const result = expectSuccess(invocation, 'host.start') as { outcome: string; hostInstanceId: string };
      expect(result.outcome).toBe('started');
      expect(result.hostInstanceId).not.toBe(credential.hostInstanceId);

      // 无关进程未被终止（不凭 PID 杀进程）。
      expect(unrelated.isAlive()).toBe(true);
      const discovery = readDiscovery(canonicalRoot);
      expect(discovery.pid).not.toBe(unrelated.pid);

      // 旧凭据不能操作新 Host（新实例只认自己的 Bearer 凭据）。
      await expect(
        probeDiscoveredHost({ discovery, token: credential.token }),
      ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'unauthorized'));

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(discovery.pid);
      stopped = true;
      env.evidence.record('f013.fr1_stale_pid_unrelated_process', {
        newInstance: discovery.hostInstanceId,
        stalePid: unrelated.pid,
        unrelatedStillAlive: true,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('崩溃后重新发现：SIGKILL 释锁，CLI start 换新实例；旧凭据/旧身份均被拒绝', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-crash-' });
    const { canonicalRoot } = env.dataRoot('crash');
    let stopped = false;
    try {
      const crashed = await startHostViaCli(env, canonicalRoot);
      // 实际写入者被 SIGKILL：OS 释放锁（可立即重获证明）。
      process.kill(crashed.pid, 'SIGKILL');
      await expectProcessGone(crashed.pid);
      await expectLockAcquirable(canonicalRoot);

      // 陈旧发现指向死端口：CLI start 获锁新 Host 原子替换失效发现。
      const invocation = await runParentCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json'], {
        pollIntervalMs: 50,
      });
      const result = expectSuccess(invocation, 'host.start') as { outcome: string; hostInstanceId: string };
      expect(result.outcome).toBe('started');

      const discovery = readDiscovery(canonicalRoot);
      expect(discovery.hostInstanceId).not.toBe(crashed.instanceId);
      expect(discovery.pid).not.toBe(crashed.pid);
      expectAlive(discovery.pid);

      // 旧凭据 → unauthorized；旧实例身份 → 409 instance_mismatch。
      const newToken = readToken(env, canonicalRoot);
      await expect(
        probeDiscoveredHost({ discovery, token: crashed.token }),
      ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'unauthorized'));
      const oldIdentity = await loopbackRequest({
        port: discovery.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: newToken,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: crashed.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(oldIdentity.statusCode).toBe(409);
      expect(wireErrorOf(oldIdentity)).toBe('instance_mismatch');

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(discovery.pid);
      stopped = true;
      env.evidence.record('f013.fr1_crash_rediscovery', {
        crashedInstance: crashed.instanceId,
        replacementInstance: discovery.hostInstanceId,
        replacementPid: discovery.pid,
        lockReacquiredAfterCrash: true,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('旧实例清理迟到：核对实例不符即放弃删除，新实例文件原样且 Host 继续服务', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-latecleanup-' });
    const { canonicalRoot } = env.dataRoot('latecleanup');
    let stopped = false;
    try {
      // Host A 崩溃（SIGKILL，无收尾）；Host B 获锁替换发现/凭据。
      const crashedHost = await startHostViaCli(env, canonicalRoot);
      const crashedInstanceId = crashedHost.instanceId;
      process.kill(crashedHost.pid, 'SIGKILL');
      await expectProcessGone(crashedHost.pid);

      const invocation = await runParentCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json'], {
        pollIntervalMs: 50,
      });
      expectSuccess(invocation, 'host.start');
      const newDiscovery = readDiscovery(canonicalRoot);
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      const tokenPath = join(canonicalRoot, 'host', 'auth.token');
      const newDiscoveryBytes = readFileSync(discoveryPath, 'utf8');
      const newTokenBytes = readFileSync(tokenPath, 'utf8');

      // 旧实例 A 的清理回调迟到：核对当前发现实例 ≠ A → 放弃删除（§10.5 第二道防线）。
      const store = createHostFileStore({ canonicalRoot });
      const outcome = store.cleanupInstanceFiles(crashedInstanceId);
      expect(outcome.outcome).toBe('skipped_instance_mismatch');
      expect(outcome.deletedDiscovery).toBe(false);
      expect(outcome.deletedAuthToken).toBe(false);

      // 新实例文件逐字节不变、权限不变，Host B 继续服务。
      expect(readFileSync(discoveryPath, 'utf8')).toBe(newDiscoveryBytes);
      expect(readFileSync(tokenPath, 'utf8')).toBe(newTokenBytes);
      expect(fileMode(discoveryPath)).toBe(0o600);
      expect(fileMode(tokenPath)).toBe(0o600);
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as { pid: number };
      expect(statusResult.pid).toBe(newDiscovery.pid);

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(newDiscovery.pid);
      stopped = true;
      env.evidence.record('f013.fr1_late_old_cleanup', {
        crashedInstance: crashedInstanceId,
        survivingInstance: newDiscovery.hostInstanceId,
        cleanupOutcome: outcome.outcome,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §15.1 T23：公开监听覆盖（配置/env/CLI）拒绝语义与零文件副作用。
// ---------------------------------------------------------------------------

describe('F-013 T23 公开监听覆盖矩阵（argv 与 env，退出码 2 且零副作用）', () => {
  it.each([
    ['0.0.0.0', 'argv'],
    ['::', 'argv'],
    ['10.255.0.7', 'argv'],
    ['example.internal', 'argv'],
    ['0.0.0.0', 'env'],
    ['::', 'env'],
    ['10.255.0.7', 'env'],
    ['example.internal', 'env'],
  ])('监听地址 %s 经 %s 覆盖 → bind_address_override_rejected（退出码 2），值不回显、根不创建', async (value, channel) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-override-' });
    try {
      const absentRoot = join(env.sandboxRoot, 'data', 'absent');
      const invocation =
        channel === 'argv'
          ? await runParentCli(env, [
              'host', 'start', '--data-root', absentRoot, '--bind', value, '--json',
            ])
          : await runParentCli(env, ['host', 'start', '--data-root', absentRoot, '--json'], {
              cliEnv: { SHIPLOOP_HOST_BIND: value },
            });
      expectFailure(invocation, 2, 'bind_address_override_rejected');
      // 覆盖值不回显；解析失败发生在任何 I/O 之前：根目录不被创建。
      expect(invocation.stdout).not.toContain(value);
      expect(invocation.stderr).not.toContain(value);
      expect(existsSync(absentRoot)).toBe(false);

      // 端口覆盖同样拒绝（--port 参数与 SHIPLOOP_HOST_PORT env）。
      const portArg = await runParentCli(env, [
        'host', 'start', '--data-root', absentRoot, '--port', '8080', '--json',
      ]);
      expectFailure(portArg, 2, 'bind_address_override_rejected');
      const portEnv = await runParentCli(env, ['host', 'start', '--data-root', absentRoot, '--json'], {
        cliEnv: { SHIPLOOP_HOST_PORT: '8080' },
      });
      expectFailure(portEnv, 2, 'bind_address_override_rejected');
      expect(existsSync(absentRoot)).toBe(false);
    } finally {
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §15.1 FR-2：认证与停止负例（返回结果与文件/进程副作用均符合拒绝语义）。
// ---------------------------------------------------------------------------

describe('F-013 FR-2 认证负例：token 篡改、假服务、真 Host HTTP 矩阵与不安全发现权限', () => {
  it('第三方篡改 auth.token：CLI status unauthorized（退出码 1），零文件副作用，Host 存活；恢复后可用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-tokentamper-' });
    const { canonicalRoot } = env.dataRoot('tamper');
    let stopped = false;
    try {
      const host = await startHostViaCli(env, canonicalRoot);
      const tokenPath = join(canonicalRoot, 'host', 'auth.token');
      const originalToken = readFileSync(tokenPath, 'utf8');
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      const discoveryBytes = readFileSync(discoveryPath, 'utf8');

      // 第三方以同形态文件篡改凭据（权限保持 0600，形态仍「可信」）。
      const tampered = randomBytes(32).toString('hex');
      env.evidence.registerSecret(tampered);
      writeFileSync(tokenPath, tampered);

      const invocation = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      expectFailure(invocation, 1, 'unauthorized');
      // 拒绝语义：不修文件、不停止 Host；发现原样、Host 仍服务（内存凭据未变）。
      expect(readFileSync(discoveryPath, 'utf8')).toBe(discoveryBytes);
      expect(readFileSync(tokenPath, 'utf8')).toBe(tampered);
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: originalToken,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: host.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);
      expect(invocation.stdout).not.toContain(tampered);
      expect(invocation.stdout).not.toContain(originalToken);

      // 现场恢复后立即可用。
      writeFileSync(tokenPath, originalToken);
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as { pid: number; lifecycleState: string };
      expect(statusResult.pid).toBe(host.pid);
      expect(statusResult.lifecycleState).toBe('ready');

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(host.pid);
      stopped = true;
      env.evidence.record('f013.fr2_token_tamper', {
        hostInstanceId: host.instanceId,
        unauthorizedExitCode: 1,
        hostStillServingAfterReject: true,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  const FAKE_FAULTS: Array<[string, string, number, string]> = [
    ['假服务旧实例', 'stale-instance', 1, 'instance_mismatch'],
    ['假服务数据根不匹配', 'wrong-data-root', 1, 'data_root_mismatch'],
    ['假服务协议不兼容', 'wrong-protocol', 3, 'protocol_incompatible'],
    ['假服务错误 schema 版本', 'wrong-schema', 3, 'unsupported_schema_version'],
    ['假服务畸形响应', 'malformed-json', 3, 'response_malformed'],
  ];
  it.each(FAKE_FAULTS)('%s → %s（退出码 %d），只收到握手且零文件副作用', async (_label, fault, exitCode, code) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-fake-' });
    try {
      const { canonicalRoot } = env.dataRoot(`fake-${fault}`);
      const credential = env.mintHostCredential(canonicalRoot);
      const server = await env.startFakeServer({
        expectedToken: credential.token,
        hostInstanceId: credential.hostInstanceId,
        dataRootIdentity: credential.dataRootIdentity,
        handshakeFault: fault as never,
      });
      env.publishLoopbackDiscovery({
        canonicalRoot,
        port: server.port,
        hostInstanceId: credential.hostInstanceId,
        store: credential.store,
        token: credential.token,
      });

      const invocation = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      expectFailure(invocation, exitCode, code);
      // §12.2：握手失败不另起写入者、不发业务请求、不触碰锁与数据库。
      expect(server.requests.map((request) => request.path)).toEqual(['/v1/host/handshake']);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
      expect(invocation.stdout).not.toContain(credential.token);
      expect(invocation.stderr).not.toContain(credential.token);
    } finally {
      await env.dispose();
    }
  });

  it('假服务 302 重定向 → redirect_rejected（退出码 3），不跟随、不向新地址发凭据、零文件副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-redirect-' });
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

      const invocation = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      expectFailure(invocation, 3, 'redirect_rejected');
      expect(target.requests).toHaveLength(0);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'core.sqlite'))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('真 Host HTTP 负例矩阵：协议 426、实例/数据根 409、Origin/伪造 Host 401，全部零副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-httpneg-' });
    const { canonicalRoot, dataRootIdentity } = env.dataRoot('httpneg');
    let stopped = false;
    try {
      const host = await startHostViaCli(env, canonicalRoot);
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      const tokenPath = join(canonicalRoot, 'host', 'auth.token');
      const dbPath = join(canonicalRoot, 'core.sqlite');
      const before = {
        discovery: readFileSync(discoveryPath, 'utf8'),
        token: readFileSync(tokenPath, 'utf8'),
        dbSize: statSync(dbPath).size,
      };

      const baseBody = {
        schemaVersion: 3,
        protocolVersion: 1,
        hostInstanceId: host.instanceId,
        dataRootIdentity,
      };
      const negatives: Array<{ label: string; expectedStatus: number; expectedCode: string; request: () => Promise<{ statusCode: number; json(): unknown }> }> = [
        {
          label: '协议不兼容（protocolVersion 2）',
          expectedStatus: 426,
          expectedCode: 'protocol_incompatible',
          request: () =>
            loopbackRequest({
              port: host.port,
              method: 'POST',
              path: '/v1/host/handshake',
              token: host.token,
              body: { ...baseBody, protocolVersion: 2 },
            }),
        },
        {
          label: '旧实例身份',
          expectedStatus: 409,
          expectedCode: 'instance_mismatch',
          request: () =>
            loopbackRequest({
              port: host.port,
              method: 'POST',
              path: '/v1/host/handshake',
              token: host.token,
              body: { ...baseBody, hostInstanceId: OTHER_INSTANCE },
            }),
        },
        {
          label: '数据根不匹配',
          expectedStatus: 409,
          expectedCode: 'data_root_mismatch',
          request: () =>
            loopbackRequest({
              port: host.port,
              method: 'POST',
              path: '/v1/host/handshake',
              token: host.token,
              body: { ...baseBody, dataRootIdentity: 'f'.repeat(64) },
            }),
        },
        {
          label: '外部 Origin',
          expectedStatus: 401,
          expectedCode: 'unauthorized',
          request: () =>
            loopbackRequest({
              port: host.port,
              method: 'POST',
              path: '/v1/host/handshake',
              token: host.token,
              body: baseBody,
              headers: { Origin: 'http://127.0.0.1:1' },
            }),
        },
        {
          label: '伪造域名 Host 头',
          expectedStatus: 401,
          expectedCode: 'unauthorized',
          request: () =>
            loopbackRequest({
              port: host.port,
              method: 'POST',
              path: '/v1/host/handshake',
              token: host.token,
              body: baseBody,
              headers: { Host: 'evil.example:8443' },
            }),
        },
      ];
      for (const negative of negatives) {
        const response = await negative.request();
        expect(response.statusCode, negative.label).toBe(negative.expectedStatus);
        expect(wireErrorOf(response), negative.label).toBe(negative.expectedCode);
      }

      // 负例矩阵零副作用：受保护文件与数据库逐字节/大小不变，锁仍被 Host 持有。
      expect(readFileSync(discoveryPath, 'utf8')).toBe(before.discovery);
      expect(readFileSync(tokenPath, 'utf8')).toBe(before.token);
      expect(statSync(dbPath).size).toBe(before.dbSize);
      await expectLockHeld(canonicalRoot);
      expectAlive(host.pid);

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(host.pid);
      stopped = true;
      env.evidence.record('f013.fr2_real_host_http_negatives', {
        hostInstanceId: host.instanceId,
        negativeCount: negatives.length,
        sideEffects: 'none',
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });

  it('不安全发现权限（discovery 0644）：CLI status unsafe_discovery（退出码 2），无进程/文件副作用；恢复后可用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-unsafedisc-' });
    const { canonicalRoot } = env.dataRoot('unsafedisc');
    let stopped = false;
    try {
      const host = await startHostViaCli(env, canonicalRoot);
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      chmodSync(discoveryPath, 0o644);

      const invocation = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      expectFailure(invocation, 2, 'unsafe_discovery');
      // fail-closed：不覆盖「修复」权限，不修文件、不停止 Host。
      expect(fileMode(discoveryPath)).toBe(0o644);
      expectAlive(host.pid);
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: host.token,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: host.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);

      // 现场恢复（权限修复）后立即可用。
      chmodSync(discoveryPath, 0o600);
      const status = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      const statusResult = expectSuccess(status, 'host.status') as { pid: number };
      expect(statusResult.pid).toBe(host.pid);

      await stopHostViaCli(env, canonicalRoot);
      await expectProcessGone(host.pid);
      stopped = true;
      env.evidence.record('f013.fr2_unsafe_discovery_perms', {
        hostInstanceId: host.instanceId,
        unsafeDiscoveryExitCode: 2,
        hostStillServingAfterReject: true,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// §15.1 FR-2 停止分支：同 commandId 重放、停机未确认与停止/重启/数据完好闭环。
// ---------------------------------------------------------------------------

/** 合法 stop 请求体（options 省略 = graceful；digest 由同一规范算法计算）。 */
function stopBody(hostInstanceId: string, commandId: string): Record<string, unknown> {
  return {
    schemaVersion: 3,
    commandId,
    hostInstanceId,
    requestDigest: computeStopRequestDigest(commandId, hostInstanceId, { mode: 'graceful' }),
  };
}

describe('F-013 FR-2 停止幂等、停机未确认与停止/重启闭环', () => {
  it('同 commandId 停止请求进行中重放：回同一进度 replayed:true，enterQuiesce 仅一次；完成后 CLI stop → host_not_found（退出码 3）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-replay-' });
    const { canonicalRoot } = env.dataRoot('replay');
    let host: RunningHost | undefined;
    try {
      // 测试进程内 Host + 可控门控制造确定的「进行中」窗口（生产恒空闲收尾太快）。
      const gate = createDeferredActivityGate();
      host = await startHost({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
        env: {},
        activityGate: gate.gate,
      });
      const token = readToken(env, canonicalRoot);
      const commandId = randomUUID();

      const firstPromise = loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/stop',
        token,
        body: stopBody(host.hostInstanceId, commandId),
        timeoutMs: 12_000,
      });
      // 等待第一次 stop 进入 quiescing 等待（有界）。
      const deadline = Date.now() + 5_000;
      while (gate.pendingAwaits() === 0) {
        if (Date.now() > deadline) {
          throw new Error('stop 未在预算内进入 quiescing 等待');
        }
        await delay(20);
      }

      // 重复 stop：同 commandId 同摘要 → 200 进度重放 replayed:true，零新副作用。
      const replay = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/stop',
        token,
        body: stopBody(host.hostInstanceId, commandId),
        timeoutMs: 12_000,
      });
      expect(replay.statusCode).toBe(200);
      const replayView = validateStopResultView(replay.json(), { expectedCommandId: commandId });
      expect(replayView.replayed).toBe(true);
      expect(replayView.stopState).toBe('quiescing');
      // 幂等语义：不重复进入 quiesce（enterQuiesce 恰一次）。
      expect(gate.stats().enterQuiesceCalls).toBe(1);

      // 放行活动 → 第一次 stop 完成收尾（completed / stopping，非 replayed）。
      gate.confirm();
      const first = await firstPromise;
      expect(first.statusCode).toBe(200);
      const firstView = validateStopResultView(first.json(), { expectedCommandId: commandId });
      expect(firstView.status).toBe('completed');
      expect(firstView.replayed).toBe(false);

      // 收尾完成：发现/凭据按实例删除、锁释放。
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      await expectLockAcquirable(canonicalRoot);

      // 实例生命期结束后的重复 stop：host_not_found（退出码 3），不重启、不新建根。
      const after = await runParentCli(env, ['host', 'stop', '--data-root', canonicalRoot, '--json']);
      expectFailure(after, 3, 'host_not_found');

      await host.close();
      host = undefined;
      env.evidence.record('f013.fr2_stop_replay_idempotent', {
        hostInstanceId: firstView.commandId === commandId ? commandId : commandId,
        replayHttpStatus: replay.statusCode,
        enterQuiesceCalls: gate.stats().enterQuiesceCalls,
        postStopCliExitCode: 3,
      });
    } finally {
      await (host?.close().catch(() => {}) ?? Promise.resolve());
      await env.dispose();
    }
  });

  it('停机未确认（quiesce_not_confirmed）：保留锁与现场，CLI 竞争者不产生第二写入者；活动收尾后同命令续跑完成', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-unconfirmed-' });
    const { canonicalRoot } = env.dataRoot('unconfirmed');
    let host: RunningHost | undefined;
    try {
      // 真实受管子进程充当已接受活动（§10.2 窄活动门控；生产恒空闲不虚构执行取消）。
      const activity = env.spawnFixtureChild('ready-listen', { label: 'stop-activity' });
      await activity.waitReady();
      activity.releaseGo();
      await activity.waitMessage('listening', 10_000);
      const gate = createChildActivityGate();
      gate.track(activity);
      host = await startHost({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
        env: {},
        activityGate: gate.gate,
        quiesceBudgetMs: 300,
      });
      const token = readToken(env, canonicalRoot);
      const commandId = randomUUID();

      // CLI stop：quiesce 未确认 → 409 quiesce_not_confirmed（退出码 1）。
      const stop1 = await runParentCli(env, [
        'host', 'stop', '--data-root', canonicalRoot,
        '--stop-command-id', commandId,
        '--confirm-timeout-ms', '0',
        '--json',
      ]);
      const error = expectFailure(stop1, 1, 'resource_busy');
      expect((error.details as { reasonCode?: string }).reasonCode).toBe('quiesce_not_confirmed');

      // 无法确认情况不得产生第二个写入者：CLI start 竞争者连接同一 quiescing
      // 实例（already_running，零候选 spawn），锁仍不可获。
      const spawned: number[] = [];
      const start2 = await runParentCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json'], {
        pollIntervalMs: 50,
        onCandidateSpawned: (pid) => {
          if (pid !== undefined) {
            spawned.push(pid);
          }
        },
      });
      const startResult = expectSuccess(start2, 'host.start') as { outcome: string; hostInstanceId: string };
      expect(startResult.outcome).toBe('already_running');
      expect(startResult.hostInstanceId).toBe(host.hostInstanceId);
      expect(spawned).toEqual([]);
      await expectLockHeld(canonicalRoot);
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(true);

      // 活动收尾（真实子进程退出核验）后，同 commandId 续跑（replayed:true）完成。
      const activityExit = await activity.verifyStopped({ escalate: false, stepMs: 2_000 });
      expect(activityExit.code).toBe(0);
      const resume = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/stop',
        token,
        body: stopBody(host.hostInstanceId, commandId),
        timeoutMs: 12_000,
      });
      expect(resume.statusCode).toBe(200);
      const resumeView = validateStopResultView(resume.json(), { expectedCommandId: commandId });
      expect(resumeView.status).toBe('completed');
      expect(resumeView.replayed).toBe(true);
      expect(gate.stats().enterQuiesceCalls).toBe(1);

      // 完成判据：发现/凭据按实例删除、writer.lock 保留、锁释放。
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);
      await expectLockAcquirable(canonicalRoot);

      await host.close();
      host = undefined;
      env.evidence.record('f013.fr2_stop_unconfirmed_no_second_writer', {
        hostInstanceId: startResult.hostInstanceId,
        competitorOutcome: 'already_running',
        candidateSpawnCount: spawned.length,
        resumeViewStatus: resumeView.status,
      });
    } finally {
      await (host?.close().catch(() => {}) ?? Promise.resolve());
      await env.dispose();
    }
  });

  it('合法 stop → 进程退出与锁释放 → 重启新实例 → 重开 Core 前序持久数据未损坏，旧身份请求被拒绝', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-restart-' });
    const { canonicalRoot } = env.dataRoot('restart');
    let stopped = false;
    try {
      // 前序持久数据：真实临时 Git 仓库 + P01 Core 注册项目（在 Host 生命周期之外）。
      const repositoryPath = join(env.sandboxRoot, 'repo');
      initGitRepo(repositoryPath);
      writeFileSync(join(repositoryPath, 'README.md'), '# f013\n', 'utf8');
      commitAll(repositoryPath, 'init');
      const seeding = await openCoreApplication({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
      });
      const registration = await seeding.projectService.registerRepository({
        repositoryPath,
        displayName: 'P02-1 回归项目',
        description: 'F-013 多进程回归的持久化数据',
        labels: ['P02-1', ' regression '],
      });
      expect(registration.status).toBe('registered');
      const projectId = registration.project.id;
      const bindingCanonicalPath = registration.binding.canonicalPath;
      await seeding.close();

      // 第一次生命周期：start → status → stop（三证据齐备才 stopped）。
      const first = await startHostViaCli(env, canonicalRoot);
      const status1 = await runParentCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
      expectSuccess(status1, 'host.status');
      await stopHostViaCli(env, canonicalRoot, { commandId: randomUUID() });
      // 合法 stop 的外部证据：进程退出、锁释放、发现/凭据删除、writer.lock 保留。
      await expectProcessGone(first.pid);
      await expectLockAcquirable(canonicalRoot);
      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);

      // 重启得到新实例（新身份、新凭据）。
      const second = await startHostViaCli(env, canonicalRoot);
      expect(second.instanceId).not.toBe(first.instanceId);
      expect(second.token).not.toBe(first.token);

      // 旧身份请求被拒绝：旧 token → 401；旧实例身份 → 409 instance_mismatch。
      const oldTokenHandshake = await loopbackRequest({
        port: second.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: first.token,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: second.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(oldTokenHandshake.statusCode).toBe(401);
      expect(wireErrorOf(oldTokenHandshake)).toBe('unauthorized');
      const oldInstanceHandshake = await loopbackRequest({
        port: second.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token: second.token,
        body: {
          schemaVersion: 3,
          protocolVersion: 1,
          hostInstanceId: first.instanceId,
          dataRootIdentity: createHostFileStore({ canonicalRoot }).dataRootIdentity,
        },
      });
      expect(oldInstanceHandshake.statusCode).toBe(409);
      expect(wireErrorOf(oldInstanceHandshake)).toBe('instance_mismatch');

      await stopHostViaCli(env, canonicalRoot, { commandId: randomUUID() });
      await expectProcessGone(second.pid);
      stopped = true;

      // 重开 Core：前序临时持久数据未损坏（Host 迁移/生命周期未破坏业务行）。
      const reopened = await openCoreApplication({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
      });
      const record = await reopened.projectService.getProject(projectId);
      expect(record.displayName).toBe('P02-1 回归项目');
      expect(record.labels).toEqual(['p02-1', 'regression']);
      expect(record.revision).toBe(1);
      const binding = await reopened.projectService.getRepositoryBinding(projectId);
      expect(binding.canonicalPath).toBe(bindingCanonicalPath);
      expect(binding.repoIdentity).toBe(registration.binding.repoIdentity);
      await reopened.close();

      env.evidence.record('f013.fr2_restart_data_intact', {
        firstInstance: first.instanceId,
        secondInstance: second.instanceId,
        firstPid: first.pid,
        secondPid: second.pid,
        projectId,
        projectRevision: record.revision,
      });
    } finally {
      if (!stopped) {
        await stopHostBestEffort(canonicalRoot);
      }
      await env.dispose();
    }
  });
});
