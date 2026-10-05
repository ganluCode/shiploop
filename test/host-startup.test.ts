/**
 * F-006 Host 启动入口验收（真实临时数据根 / 真实锁 / 真实监听 / 真实子进程）。
 *
 * 覆盖（F-006 验收点，契约 §11 启动顺序、§5.2 发布时机、§13.2/T23 覆盖零容忍）：
 * - 入口顺序：输入检查 → 规范根 → OS 锁 → openCoreApplication（含 Schema 检查）
 *   → 127.0.0.1 端口 0 绑定 → 地址核验 → 新实例 + 新凭据 → 原子发现发布 → ready；
 *   发现端口等于套接字实际分配端口，listenAddress 恰为 127.0.0.1；
 * - 绑定地址覆盖零容忍：启动选项、环境变量、argv 三个通道的 0.0.0.0 / :: /
 *   非回环 IP / 域名覆盖尝试均被 bind_address_override_rejected 拒绝且零文件副作用；
 * - 失败路径：高版本 Schema 拒写（原库不变、无发现/凭据、释锁）、发现目标可疑
 *   不覆盖（关闭监听/Core 并按逆序释锁，不发布 ready）；
 * - 每次成功启动都是新 hostInstanceId 与新凭据；能力目录不装配 Pi/模型执行；
 * - runHostStartEntry/parseHostStartArgv：受控 argv、脱敏输出（无凭据）、
 *   输入错误退出码 2、解析失败零 I/O；
 * - 真实子进程：两候选竞争唯一持锁者（败者 owner_unknown 不打开写库）、
 *   SIGKILL 后 OS 释锁并可获全新实例、argv/env 覆盖拒绝 exit 2 且无副作用。
 *
 * F-007 边界：握手/status 认证路由已装配（test/host-http-transport.test.ts 专项
 * 验收）；stop 路由在 F-008 接线前返回 501 unsupported，不触发任何停止行为。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acquireWriterLock,
  createHostFileStore,
  isHostProtocolError,
  parseHostStartArgv,
  resolveCanonicalDataRoot,
  runHostStartEntry,
  startHost,
  type HostStartEntryIo,
  type HostStartOptions,
  type RunningHost,
} from '../packages/host/src/index.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/index.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { createIsolatedHostEnvironment } from './helpers/host/index.ts';
import { loopbackRequest } from './helpers/host/http-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_ENTRY_CHILD = fileURLToPath(new URL('./helpers/host/host-entry-child.ts', import.meta.url));

/** 空能力目录：不装配任何 runtime/Pi/模型执行（fail-closed 语义）。 */
const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function baseOptions(dataRoot: string): HostStartOptions {
  return { dataRoot, capabilityCatalog: EMPTY_CATALOG, env: {} };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function readToken(canonicalRoot: string): string {
  return readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
}

/** 关闭运行中的 Host；断言失败路径也必须调用（finally）。 */
async function closeQuietly(host: RunningHost | undefined): Promise<void> {
  if (host !== undefined) {
    await host.close();
  }
}

describe('F-006 启动装配（in-process，真实锁/Core/监听）', () => {
  it('合法启动：回环随机端口、原子发现、0600 凭据、占位 404，close 后释锁', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-happy-' });
    let host: RunningHost | undefined;
    try {
      const { canonicalRoot, dataRootIdentity } = env.dataRoot('happy');
      host = await startHost(baseOptions(canonicalRoot));
      expect(host.lifecycleState).toBe('ready');
      expect(host.listenAddress).toBe('127.0.0.1');
      expect(host.port).toBeGreaterThanOrEqual(1);
      expect(host.port).toBeLessThanOrEqual(65_535);
      expect(host.pid).toBe(process.pid);
      expect(host.dataRootIdentity).toBe(dataRootIdentity);

      const store = createHostFileStore({ canonicalRoot });
      const discovery = store.readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(host.hostInstanceId);
      expect(discovery.port).toBe(host.port);
      expect(discovery.listenAddress).toBe('127.0.0.1');
      expect(discovery.pid).toBe(process.pid);
      expect(discovery.dataRootIdentity).toBe(dataRootIdentity);
      expect(discovery.startedAt).toBe(host.startedAt);
      expect(modeOf(join(canonicalRoot, 'host'))).toBe(0o700);
      expect(modeOf(join(canonicalRoot, 'host', 'discovery.json'))).toBe(0o600);
      expect(modeOf(join(canonicalRoot, 'host', 'auth.token'))).toBe(0o600);

      const token = readToken(canonicalRoot);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      env.evidence.registerSecret(token);

      // F-007 真实认证传输面：未认证一律 401 unauthorized（子原因不可区分），
      // 无 CORS 头、无凭据回显；合法 Bearer 握手返回真实实例。
      const response = await loopbackRequest({ port: host.port, method: 'GET', path: '/v1/host/status' });
      expect(response.statusCode).toBe(401);
      const body = response.json() as { error: { code: string; operation: string } };
      expect(body.error.code).toBe('unauthorized');
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.bodyText).not.toContain(token);
      const handshake = await loopbackRequest({
        port: host.port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: {
          schemaVersion: 1,
          protocolVersion: 1,
          hostInstanceId: host.hostInstanceId,
          dataRootIdentity: host.dataRootIdentity,
        },
      });
      expect(handshake.statusCode).toBe(200);
      expect((handshake.json() as { hostInstanceId: string }).hostInstanceId).toBe(host.hostInstanceId);
      expect(handshake.bodyText).not.toContain(token);

      env.evidence.record('host.started', {
        pid: host.pid,
        hostInstanceId: host.hostInstanceId,
        port: host.port,
        listenAddress: host.listenAddress,
        lifecycleState: host.lifecycleState,
      });

      await host.close();
      expect(host.lifecycleState).toBe('stopping');
      host = undefined;
      // close 已关闭 Core 并释放 OS 锁：新候选可立即获锁。
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.lock_reacquired', { pid: process.pid });
    } finally {
      await closeQuietly(host);
      await env.dispose();
    }
  });

  it('默认根由注入用户目录按 P01 规则推导（0700），不读真实 HOME', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-default-' });
    let host: RunningHost | undefined;
    try {
      const home = join(env.sandboxRoot, 'home');
      host = await startHost({ userHomeDir: home, capabilityCatalog: EMPTY_CATALOG, env: {} });
      const expected = realpathSync(join(home, 'Library', 'Application Support', 'shiploop'));
      expect(host.canonicalRoot).toBe(expected);
      expect(modeOf(expected)).toBe(0o700);
      expect(existsSync(join(expected, 'host', 'discovery.json'))).toBe(true);
      await host.close();
      host = undefined;
    } finally {
      await closeQuietly(host);
      await env.dispose();
    }
  });

  it('dataRoot 与 userHomeDir 同时提供 → invalid_input（根来源歧义，零 I/O）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-ambiguous-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'ambiguous');
      await expect(
        startHost({ dataRoot: fresh, userHomeDir: env.sandboxRoot, capabilityCatalog: EMPTY_CATALOG, env: {} }),
      ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'invalid_input'));
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  const BIND_OVERRIDE_OPTION_KEYS = [
    'bind',
    'bindAddress',
    'host',
    'hostname',
    'address',
    'listen',
    'listenAddress',
    'port',
  ] as const;
  const BIND_OVERRIDE_VALUES = ['0.0.0.0', '::', '192.168.1.10', 'public.example.com'] as const;

  it.each(BIND_OVERRIDE_OPTION_KEYS)('启动选项监听覆盖零容忍：选项 %s', async (key) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-opt-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', `opt-${key}`);
      const forged = { ...baseOptions(fresh), [key]: '0.0.0.0' } as unknown as HostStartOptions;
      await expect(startHost(forged)).rejects.toSatisfy((error: unknown) =>
        isHostProtocolError(error, 'bind_address_override_rejected'),
      );
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it.each(BIND_OVERRIDE_VALUES)('启动选项监听覆盖值被拒：%s', async (value) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-val-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'opt-value');
      const forged = { ...baseOptions(fresh), listen: value } as unknown as HostStartOptions;
      await expect(startHost(forged)).rejects.toSatisfy((error: unknown) =>
        isHostProtocolError(error, 'bind_address_override_rejected'),
      );
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  const BIND_OVERRIDE_ENVS = [
    'SHIPLOOP_HOST_BIND',
    'SHIPLOOP_HOST_HOST',
    'SHIPLOOP_HOST_PORT',
    'SHIPLOOP_HOST_LISTEN_ADDRESS',
  ] as const;

  it.each(BIND_OVERRIDE_ENVS)('环境变量监听覆盖零容忍：%s', async (name) => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-env-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', `env-${name}`);
      await expect(
        startHost({ ...baseOptions(fresh), env: { [name]: '0.0.0.0' } }),
      ).rejects.toSatisfy((error: unknown) => {
        if (!isHostProtocolError(error, 'bind_address_override_rejected')) {
          return false;
        }
        // details 只含变量名，绝不回显覆盖值。
        expect(JSON.stringify(error.details ?? {})).not.toContain('0.0.0.0');
        return true;
      });
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('未知启动选项键 → invalid_input（零 I/O）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-unknown-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'unknown-key');
      const forged = { ...baseOptions(fresh), frobnicate: true } as unknown as HostStartOptions;
      await expect(startHost(forged)).rejects.toSatisfy((error: unknown) =>
        isHostProtocolError(error, 'invalid_input'),
      );
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('能力目录缺失/形态非法 → invalid_input（不静默补默认 runtime）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-catalog-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'catalog');
      await expect(
        startHost({ dataRoot: fresh, capabilityCatalog: {} as never, env: {} }),
      ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'invalid_input'));
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('非 macOS 平台 → unsupported_platform（不创建数据根、不降级）', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-platform-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'platform');
      await expect(
        startHost({ ...baseOptions(fresh), platform: 'linux' }),
      ).rejects.toSatisfy((error: unknown) => isHostProtocolError(error, 'unsupported_platform'));
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('未知高版本 Schema 拒写：原库不变、无发现/凭据、锁释放，不伪装就绪', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-schema-' });
    try {
      const { canonicalRoot } = env.dataRoot('schema');
      const seeded = await openCoreApplication({
        dataRoot: canonicalRoot,
        capabilityCatalog: EMPTY_CATALOG,
      });
      seeded.close();
      const dbPath = join(canonicalRoot, 'core.sqlite');
      const raw = new Database(dbPath);
      raw
        .prepare(
          'INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('migration-v99', Date.now(), 99, 'a'.repeat(64), Date.now());
      const migrationsBefore = raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => (row as { version: number }).version);
      const tablesBefore = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      raw.close();

      await expect(startHost(baseOptions(canonicalRoot))).rejects.toSatisfy((error: unknown) => {
        expect(isStorageError(error, 'unsupported_version')).toBe(true);
        expect((error as Error).message).not.toContain(canonicalRoot);
        return true;
      });

      expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
      expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
      const after = new Database(dbPath, { readonly: true });
      const migrationsAfter = after
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => (row as { version: number }).version);
      const tablesAfter = after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      after.close();
      expect(migrationsAfter).toEqual(migrationsBefore);
      expect(tablesAfter).toEqual(tablesBefore);

      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.schema_refused', { migrations: migrationsAfter.length });
    } finally {
      await env.dispose();
    }
  });

  it('发现目标可疑（符号链接）→ 不覆盖、关闭监听/Core、释锁、不发布 ready', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-symlink-' });
    try {
      const { canonicalRoot } = env.dataRoot('publish-fail');
      mkdirSync(join(canonicalRoot, 'host'), { mode: 0o700 });
      const decoy = join(env.sandboxRoot, 'decoy.json');
      writeFileSync(decoy, '{}', 'utf8');
      const discoveryPath = join(canonicalRoot, 'host', 'discovery.json');
      symlinkSync(decoy, discoveryPath);

      await expect(startHost(baseOptions(canonicalRoot))).rejects.toSatisfy((error: unknown) =>
        isHostProtocolError(error, 'unsafe_discovery'),
      );

      // 可疑目标未被覆盖或“修复”；诱饵文件内容不变。
      expect(lstatSync(discoveryPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(decoy, 'utf8')).toBe('{}');
      // 锁已释放（监听/Core 已按逆序关闭）。
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.publish_refused', { outcome: 'symlink_untouched' });
    } finally {
      await env.dispose();
    }
  });

  it('重启获得全新 hostInstanceId 与凭据，发现被原子替换', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-restart-' });
    let host: RunningHost | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('restart');
      host = await startHost(baseOptions(canonicalRoot));
      const firstInstance = host.hostInstanceId;
      const firstToken = readToken(canonicalRoot);
      await host.close();
      host = undefined;

      host = await startHost(baseOptions(canonicalRoot));
      expect(host.hostInstanceId).not.toBe(firstInstance);
      const secondToken = readToken(canonicalRoot);
      expect(secondToken).not.toBe(firstToken);
      expect(secondToken).toMatch(/^[0-9a-f]{64}$/);
      const discovery = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(host.hostInstanceId);
      await host.close();
      host = undefined;
    } finally {
      await closeQuietly(host);
      await env.dispose();
    }
  });
});

describe('F-006 启动入口 argv 与脱敏输出（in-process runHostStartEntry）', () => {
  it('parseHostStartArgv 接受受控参数', () => {
    expect(parseHostStartArgv([])).toEqual({ help: false, dataRoot: undefined });
    expect(parseHostStartArgv(['--data-root', '/tmp/x'])).toEqual({
      help: false,
      dataRoot: '/tmp/x',
    });
    expect(parseHostStartArgv(['--help'])).toEqual({ help: true, dataRoot: undefined });
  });

  const BIND_ARGV_CASES: readonly (readonly string[])[] = [
    ['--bind', '0.0.0.0'],
    ['--bind=0.0.0.0'],
    ['--host', 'public.example.com'],
    ['--hostname', 'public.example.com'],
    ['--address', '::'],
    ['--port', '8080'],
    ['--listen', '127.0.0.1:8080'],
    ['--listen-address', '192.168.1.10'],
  ];
  it.each(BIND_ARGV_CASES.map((args) => ({ args })))('argv 监听覆盖零容忍：$args', ({ args }) => {
    try {
      parseHostStartArgv(args);
      expect.unreachable('应拒绝监听覆盖参数');
    } catch (error) {
      expect(isHostProtocolError(error, 'bind_address_override_rejected')).toBe(true);
    }
  });

  const INVALID_ARGV_CASES: readonly (readonly string[])[] = [
    ['--frobnicate'],
    ['positional'],
    ['--data-root'],
    ['--data-root', 'relative/path'],
    ['--data-root', '/a', '--data-root', '/b'],
  ];
  it.each(INVALID_ARGV_CASES.map((args) => ({ args })))('argv 输入错误：$args', ({ args }) => {
    try {
      parseHostStartArgv(args);
      expect.unreachable('应拒绝非法参数');
    } catch (error) {
      expect(isHostProtocolError(error, 'invalid_input')).toBe(true);
    }
  });

  function captureIo(): { io: HostStartEntryIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      stdout,
      stderr,
    };
  }

  it('--help 输出用法并以 0 结束，不触碰文件系统', async () => {
    const { io, stdout, stderr } = captureIo();
    const outcome = await runHostStartEntry(['node', 'start.js', '--help'], io);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.host).toBeUndefined();
    expect(stdout.join('\n')).toContain('--data-root');
    expect(stdout.join('\n')).toContain('127.0.0.1');
    expect(stderr).toEqual([]);
  });

  it('入口解析失败 → 退出码 2、脱敏 stderr、零文件副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-argfail-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'argfail');
      const { io, stdout, stderr } = captureIo();
      const outcome = await runHostStartEntry(
        ['node', 'start.js', '--data-root', fresh, '--bind', '0.0.0.0'],
        io,
      );
      expect(outcome.exitCode).toBe(2);
      expect(outcome.host).toBeUndefined();
      expect(stdout).toEqual([]);
      const envelope = JSON.parse(stderr.join('\n')) as { ok: boolean; error: { code: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('bind_address_override_rejected');
      expect(existsSync(fresh)).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  it('入口成功：创建数据根、stdout 脱敏 JSON 与发现一致、无凭据外泄', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-entry-' });
    let host: RunningHost | undefined;
    try {
      const fresh = join(env.sandboxRoot, 'data', 'entry-ok');
      const { io, stdout, stderr } = captureIo();
      const outcome = await runHostStartEntry(
        ['node', 'start.js', '--data-root', fresh],
        io,
        { startOptions: { lockTimeoutMs: 5_000 } },
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.host).toBeDefined();
      host = outcome.host as RunningHost;
      expect(stderr).toEqual([]);

      const envelope = JSON.parse(stdout.join('\n')) as {
        ok: boolean;
        command: string;
        result: { hostInstanceId: string; port: number; listenAddress: string };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('host.start');
      expect(envelope.result.hostInstanceId).toBe(host?.hostInstanceId);
      expect(envelope.result.listenAddress).toBe('127.0.0.1');
      expect(envelope.result.port).toBe(host?.port);

      const canonicalRoot = resolveCanonicalDataRoot({ dataRoot: fresh }).canonicalRoot;
      const token = readToken(canonicalRoot);
      env.evidence.registerSecret(token);
      expect(stdout.join('\n')).not.toContain(token);
      const discovery = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(envelope.result.hostInstanceId);
      expect(discovery.port).toBe(envelope.result.port);
      env.evidence.record('host.entry_started', {
        hostInstanceId: envelope.result.hostInstanceId,
        port: envelope.result.port,
      });
      await host.close();
      host = undefined;
    } finally {
      await closeQuietly(host);
      await env.dispose();
    }
  });
});

describe('F-006 真实子进程：单写入者竞争与崩溃恢复', () => {
  it('两候选同步竞争：唯一持锁者发布发现，败者 owner_unknown 不打开写库', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-race-' });
    try {
      const { canonicalRoot } = env.dataRoot('race');
      const spawnCandidate = (label: string) =>
        env.processes.spawn({
          scriptPath: HOST_ENTRY_CHILD,
          config: { argv: ['--data-root', canonicalRoot], lockTimeoutMs: 400 },
          cwd: env.sandboxRoot,
          env: env.childEnv(),
          label,
          requireInside: env.sandboxRoot,
          evidence: env.evidence,
          readyTimeoutMs: 10_000,
        });
      const first = spawnCandidate('candidate-a');
      const second = spawnCandidate('candidate-b');
      await Promise.all([first.waitReady(), second.waitReady()]);
      first.releaseGo();
      second.releaseGo();

      const [messageA, messageB] = await Promise.all([
        first.waitMessage(['host_ready', 'host_start_failed'], 20_000),
        second.waitMessage(['host_ready', 'host_start_failed'], 20_000),
      ]);
      const messages = [messageA, messageB];
      const readyMessage = messages.find((message) => message.kind === 'host_ready');
      const failedMessage = messages.find((message) => message.kind === 'host_start_failed');
      expect(readyMessage).toBeDefined();
      expect(failedMessage).toBeDefined();

      // 败者：owner_unknown（业务拒绝退出码 1），绝不绕过锁/杀进程/另起写入者。
      expect(failedMessage?.exitCode).toBe(1);
      const loserStderr = (failedMessage?.stderrLines as string[]).join('\n');
      expect((JSON.parse(loserStderr) as { error: { code: string } }).error.code).toBe('owner_unknown');
      const [winner, loser] = messageA.kind === 'host_ready' ? [first, second] : [second, first];

      const result = readyMessage?.result as {
        hostInstanceId: string;
        port: number;
        listenAddress: string;
        pid: number;
      };
      expect(result.listenAddress).toBe('127.0.0.1');
      expect(result.pid).toBe(winner?.pid);

      const store = createHostFileStore({ canonicalRoot });
      const discovery = store.readTrustedDiscovery();
      expect(discovery.hostInstanceId).toBe(result.hostInstanceId);
      expect(discovery.port).toBe(result.port);
      expect(discovery.pid).toBe(winner?.pid);

      // 胜者真实监听回环；认证路由未认证一律 401；stdout 无凭据。
      const token = readToken(canonicalRoot);
      env.evidence.registerSecret(token);
      for (const line of readyMessage?.stdoutLines as string[]) {
        expect(line).not.toContain(token);
      }
      const response = await loopbackRequest({ port: result.port, method: 'GET', path: '/v1/host/status' });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { error: { code: string } }).error.code).toBe('unauthorized');
      expect(response.bodyText).not.toContain(token);

      // 败者进程已自行以退出码 1 结束；回收并核验。
      const loserExit = await loser?.verifyStopped({ stepMs: 500 });
      expect(loserExit?.code).toBe(1);
      expect(winner?.isAlive()).toBe(true);
      env.evidence.record('host.race_result', {
        winnerPid: winner?.pid ?? null,
        loserExitCode: loserExit?.code ?? null,
        hostInstanceId: result.hostInstanceId,
        port: result.port,
      });

      // SIGKILL 胜者：OS 释锁；新候选获全新实例与凭据。
      winner?.kill('SIGKILL');
      const killedExit = await winner?.exited;
      expect(killedExit?.signal).toBe('SIGKILL');
      const tokenAfterKill = readToken(canonicalRoot);

      const third = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', canonicalRoot], lockTimeoutMs: 2_000 },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'candidate-c',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
        readyTimeoutMs: 10_000,
      });
      await third.waitReady();
      third.releaseGo();
      const restarted = await third.waitMessage('host_ready', 20_000);
      const restartedResult = restarted.result as { hostInstanceId: string; port: number };
      expect(restartedResult.hostInstanceId).not.toBe(result.hostInstanceId);
      const restartedToken = readToken(canonicalRoot);
      env.evidence.registerSecret(restartedToken);
      expect(restartedToken).not.toBe(tokenAfterKill);

      const stopped = await third.verifyStopped({ stepMs: 1_000 });
      expect(stopped.code).toBe(0);
      // close 后锁可再获（写入者与锁生命周期绑定）。
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      lock.releaseAfterWritesClosed();
      env.evidence.record('host.restarted', {
        hostInstanceId: restartedResult.hostInstanceId,
        port: restartedResult.port,
        killedSignal: killedExit?.signal ?? null,
      });
    } finally {
      await env.dispose();
    }
  });

  it('argv 监听覆盖在真实子进程中被拒：exit 2、零文件副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-argv-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'argv-reject');
      const child = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', fresh, '--bind', '0.0.0.0'] },
        cwd: env.sandboxRoot,
        env: env.childEnv(),
        label: 'argv-reject',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
      });
      await child.waitReady();
      child.releaseGo();
      const failed = await child.waitMessage('host_start_failed', 10_000);
      expect(failed.exitCode).toBe(2);
      const stderrText = (failed.stderrLines as string[]).join('\n');
      expect((JSON.parse(stderrText) as { error: { code: string } }).error.code).toBe(
        'bind_address_override_rejected',
      );
      const exit = await child.verifyStopped({ stepMs: 500 });
      expect(exit.code).toBe(2);
      expect(existsSync(fresh)).toBe(false);
      env.evidence.record('host.argv_rejected', { exitCode: exit.code });
    } finally {
      await env.dispose();
    }
  });

  it('env 监听覆盖在真实子进程中被拒：exit 2、零文件副作用', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-f006-envrej-' });
    try {
      const fresh = join(env.sandboxRoot, 'data', 'env-reject');
      const child = env.processes.spawn({
        scriptPath: HOST_ENTRY_CHILD,
        config: { argv: ['--data-root', fresh] },
        cwd: env.sandboxRoot,
        env: env.childEnv({ SHIPLOOP_HOST_BIND: '0.0.0.0' }),
        label: 'env-reject',
        requireInside: env.sandboxRoot,
        evidence: env.evidence,
      });
      await child.waitReady();
      child.releaseGo();
      const failed = await child.waitMessage('host_start_failed', 10_000);
      expect(failed.exitCode).toBe(2);
      const exit = await child.verifyStopped({ stepMs: 500 });
      expect(exit.code).toBe(2);
      expect(existsSync(fresh)).toBe(false);
      env.evidence.record('host.env_rejected', { exitCode: exit.code });
    } finally {
      await env.dispose();
    }
  });
});
