/**
 * 构建产物入口冒烟检查（fail-closed 工程脚本，非 ShipLoop 业务 Verifier）。
 *
 * 对 core / host / cli 三个包逐一：
 * 1. 校验 package.json 的 exports['.'] 指向 dist 下真实存在的 JS 与 .d.ts 产物；
 * 2. 在独立 Node 子进程中加载构建后的入口，要求 5 秒内以退出码 0 结束
 *    （监听端口或常驻进程会触发超时并判失败）；
 * 3. 将 HOME 与 XDG 数据/配置/缓存目录及 cwd 重定向到系统临时目录下的独立沙箱，
 *    断言加载前后这些目录没有任何文件写入。
 *
 * 该脚本本身为 TypeScript，由根 tsconfig.json 覆盖类型检查；
 * 仅使用可擦除语法，直接以 Node 22 的原生 TypeScript 支持运行。
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['packages/core', 'packages/host', 'packages/cli'] as const;
const LOAD_TIMEOUT_MS = 5000;
const ASSEMBLY_SMOKE_TIMEOUT_MS = 60_000;
const HOST_START_SMOKE_TIMEOUT_MS = 30_000;

type PackageExports = Record<string, { types?: unknown; default?: unknown } | undefined>;

type PackageManifest = {
  name?: unknown;
  exports?: PackageExports;
};

function fail(message: string): never {
  process.stderr.write(`smoke-built-entries: FAIL ${message}\n`);
  process.exit(1);
}

function listFilesRelative(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const walk = (current: string, prefix: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const child = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? walk(child, relative) : [relative];
    });
  return walk(directory, '');
}

/** 有界等待子进程退出（返回真实退出码/信号；超时按失败处理）。 */
function waitChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error('child exit not confirmed within budget'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

/** 有界轮询等待发现文件出现且 pid 属于本次子进程（100ms 间隔）；子进程提前退出立即失败。 */
async function waitForDiscoveryWithin(
  file: string,
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: string | null }>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const early: { exit: { code: number | null; signal: string | null } | null } = { exit: null };
  void exited.then(
    (result) => {
      early.exit = result;
    },
    () => {
      // exited 拒绝（退出核验超时）按仍存活处理，由轮询预算收尾。
    },
  );
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown };
        // SIGKILL 残留的阵旧发现 pid 属于旧实例；必须等到本实例原子替换后的发现。
        if (parsed.pid === child.pid) {
          return;
        }
      } catch {
        // 半写/损坏按未就绪继续等待（原子发布正常不会出现半文件）。
      }
    }
    if (early.exit !== null) {
      const exit = early.exit as { code: number | null; signal: string | null };
      throw new Error(
        `host start entry exited early (code=${String(exit.code)}, signal=${String(exit.signal)})`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('host start entry did not publish discovery within budget');
}

/** 有界 TCP 连接核验（只连 127.0.0.1）。 */
function assertLoopbackConnectable(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = connect({ host: '127.0.0.1', port, family: 4 }, () => {
      socket.end();
      resolveConnect();
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      rejectConnect(new Error('loopback connect timeout'));
    });
    socket.once('error', (error) => {
      rejectConnect(new Error(`loopback connect failed: ${error.message}`));
    });
  });
}

type StartedHostSmoke = {
  child: ChildProcess;
  discovery: {
    schemaVersion: number;
    protocolVersion: number;
    hostInstanceId: string;
    dataRootIdentity: string;
    listenAddress: string;
    port: number;
    pid: number;
    startedAt: string;
  };
  token: string;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
};

/**
 * F-006 构建冒烟：从 dist、非源码 cwd 启动真实 Host，断言回环监听/发现一致/
 * 凭据不外泄，SIGKILL 后 OS 释锁且重启获全新实例，监听覆盖参数被拒（退出码 2）。
 * 输出绝不包含沙箱绝对路径与凭据。
 */
async function smokeHostStartEntry(
  packageRoot: string,
  sandbox: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const startEntry = resolve(packageRoot, 'dist/start.js');
  if (!existsSync(startEntry)) {
    fail('shiploop-host: F-006 start entry missing: dist/start.js');
  }
  const workDir = join(sandbox, 'host-start');
  mkdirSync(workDir, { recursive: true });
  const dataRoot = join(workDir, 'data');
  const discoveryFile = join(dataRoot, 'host', 'discovery.json');
  const tokenFile = join(dataRoot, 'host', 'auth.token');

  const startHost = (): StartedHostSmoke => {
    const child = spawn(process.execPath, [startEntry, '--data-root', dataRoot], {
      cwd: workDir,
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-16_384);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-16_384);
    });
    const exited = waitChildExit(child, HOST_START_SMOKE_TIMEOUT_MS);
    return {
      child,
      discovery: undefined as unknown as StartedHostSmoke['discovery'],
      token: '',
      stdout: () => stdout,
      stderr: () => stderr,
      exited,
    };
  };

  const awaitReady = async (started: StartedHostSmoke): Promise<StartedHostSmoke> => {
    await waitForDiscoveryWithin(discoveryFile, started.child, started.exited, HOST_START_SMOKE_TIMEOUT_MS);
    const discovery = JSON.parse(readFileSync(discoveryFile, 'utf-8')) as StartedHostSmoke['discovery'];
    if (
      discovery.schemaVersion !== 1 ||
      discovery.protocolVersion !== 1 ||
      discovery.listenAddress !== '127.0.0.1' ||
      !Number.isInteger(discovery.port) ||
      discovery.port < 1 ||
      discovery.port > 65_535 ||
      discovery.pid !== started.child.pid ||
      typeof discovery.hostInstanceId !== 'string' ||
      discovery.hostInstanceId.length === 0 ||
      discovery.dataRootIdentity !==
        createHash('sha256').update(realpathSync(dataRoot), 'utf8').digest('hex')
    ) {
      fail('shiploop-host: discovery published by dist/start.js is inconsistent with the actual socket/root');
    }
    const token = readFileSync(tokenFile, 'utf-8');
    if (!/^[0-9a-f]{64}$/.test(token)) {
      fail('shiploop-host: auth.token is not 64 lowercase hex');
    }
    if (started.stdout().includes(token) || started.stderr().includes(token)) {
      fail('shiploop-host: start entry leaked the auth token to stdout/stderr');
    }
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      fail('shiploop-host: start entry exited after publishing discovery');
    }
    await assertLoopbackConnectable(discovery.port, 5_000);
    return { ...started, discovery, token };
  };

  const killAndConfirm = async (started: StartedHostSmoke): Promise<void> => {
    started.child.kill('SIGKILL');
    const exit = await started.exited;
    if (exit.signal !== 'SIGKILL') {
      fail(`shiploop-host: SIGKILL exit not confirmed (code=${String(exit.code)}, signal=${String(exit.signal)})`);
    }
  };

  const first = await awaitReady(startHost());
  await killAndConfirm(first);

  // SIGKILL 后 OS 释锁：同一规范根可再次获锁启动，且是全新实例与凭据。
  const second = await awaitReady(startHost());
  if (second.discovery.hostInstanceId === first.discovery.hostInstanceId) {
    fail('shiploop-host: restart did not issue a fresh hostInstanceId');
  }
  if (second.token === first.token) {
    fail('shiploop-host: restart did not issue a fresh auth token');
  }
  await killAndConfirm(second);

  // 监听地址覆盖零容忍（T23）：--bind 覆盖 → 退出码 2 且零文件副作用。
  const overrideRoot = join(workDir, 'override-reject');
  const rejected = spawnSync(
    process.execPath,
    [startEntry, '--data-root', overrideRoot, '--bind', '0.0.0.0'],
    { cwd: workDir, env: baseEnv, encoding: 'utf8', timeout: HOST_START_SMOKE_TIMEOUT_MS },
  );
  if (rejected.error || rejected.signal || rejected.status !== 2) {
    fail(
      `shiploop-host: bind override was not rejected with exit 2 (status=${String(rejected.status)}, signal=${String(rejected.signal)})`,
    );
  }
  if (!String(rejected.stderr).includes('bind_address_override_rejected')) {
    fail('shiploop-host: bind override rejection missing bind_address_override_rejected diagnostic');
  }
  if (String(rejected.stderr).includes('0.0.0.0') && String(rejected.stderr).includes('Bearer')) {
    fail('shiploop-host: rejection output leaked secret material');
  }
  if (existsSync(overrideRoot)) {
    fail('shiploop-host: bind override rejection left filesystem side effects');
  }

  console.log(
    'ok shiploop-host: start entry dist/start.js (loopback 127.0.0.1, discovery==socket, no token leak, ' +
      'fresh instance+token after SIGKILL, bind override exit=2)',
  );
}

for (const packageDir of packageDirs) {
  const packageRoot = resolve(repoRoot, packageDir);
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, 'package.json'), 'utf-8'),
  ) as PackageManifest;
  const name = typeof manifest.name === 'string' ? manifest.name : packageDir;
  const rootExport = manifest.exports?.['.'];

  if (typeof rootExport?.default !== 'string' || !rootExport.default.startsWith('./dist/')) {
    fail(`${name}: exports['.'].default must point at a ./dist/*.js artifact`);
  }
  if (typeof rootExport.types !== 'string' || !rootExport.types.startsWith('./dist/')) {
    fail(`${name}: exports['.'].types must point at a ./dist/*.d.ts artifact`);
  }

  const jsEntry = resolve(packageRoot, rootExport.default);
  const declarationEntry = resolve(packageRoot, rootExport.types);
  if (!existsSync(jsEntry)) {
    fail(`${name}: built entry missing: ${rootExport.default}`);
  }
  if (!existsSync(declarationEntry)) {
    fail(`${name}: declaration file missing: ${rootExport.types}`);
  }

  // Core 的受控装配入口经 `./assembly` 子路径导出；构建产物冒烟会在非源码 cwd 下
  // 加载它并执行装配/配置/受权路径序列（见 scripts/core-assembly-smoke.mjs）。
  let assemblyEntry: string | null = null;
  if (name === 'shiploop-core') {
    const assembly = manifest.exports?.['./assembly'];
    if (typeof assembly?.default !== 'string' || !assembly.default.startsWith('./dist/')) {
      fail(`${name}: exports['./assembly'].default must point at a ./dist/*.js artifact`);
    }
    if (typeof assembly.types !== 'string' || !assembly.types.startsWith('./dist/')) {
      fail(`${name}: exports['./assembly'].types must point at a ./dist/*.d.ts artifact`);
    }
    assemblyEntry = resolve(packageRoot, assembly.default);
    if (!existsSync(assemblyEntry)) {
      fail(`${name}: assembly entry missing: ${assembly.default}`);
    }
    if (!existsSync(resolve(packageRoot, assembly.types))) {
      fail(`${name}: assembly declaration missing: ${assembly.types}`);
    }
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'shiploop-smoke-'));
  try {
    const home = join(sandbox, 'home');
    const configHome = join(sandbox, 'xdg-config');
    const dataHome = join(sandbox, 'xdg-data');
    const cacheHome = join(sandbox, 'xdg-cache');
    const cwd = join(sandbox, 'cwd');
    for (const directory of [home, configHome, dataHome, cacheHome, cwd]) {
      mkdirSync(directory, { recursive: true });
    }
    const watchedDirectories = [home, configHome, dataHome, cacheHome, cwd];
    const before = watchedDirectories.map(listFilesRelative);
    const childEnv = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      TMPDIR: sandbox,
      NODE_NO_WARNINGS: '1',
    };

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [jsEntry], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: LOAD_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;

    if (result.error) {
      fail(`${name}: subprocess error or timeout after ${LOAD_TIMEOUT_MS}ms: ${result.error.message}`);
    }
    if (result.signal) {
      fail(`${name}: subprocess killed by signal ${result.signal}`);
    }
    if (result.status !== 0) {
      fail(`${name}: exit code ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }

    if (assemblyEntry !== null) {
      const assemblySandbox = join(sandbox, 'core-assembly');
      mkdirSync(assemblySandbox, { recursive: true });
      const smokeScript = resolve(repoRoot, 'scripts/core-assembly-smoke.mjs');
      const smokeStartedAt = Date.now();
      const smoke = spawnSync(
        process.execPath,
        [smokeScript, assemblyEntry, jsEntry, assemblySandbox],
        {
          cwd,
          env: childEnv,
          encoding: 'utf8',
          timeout: ASSEMBLY_SMOKE_TIMEOUT_MS,
        },
      );
      if (smoke.error) {
        fail(
          `${name}: assembly smoke error or timeout after ${ASSEMBLY_SMOKE_TIMEOUT_MS}ms: ${smoke.error.message}`,
        );
      }
      if (smoke.signal) {
        fail(`${name}: assembly smoke killed by signal ${smoke.signal}`);
      }
      if (smoke.status !== 0) {
        fail(
          `${name}: assembly smoke exit code ${smoke.status}\nstdout: ${smoke.stdout}\nstderr: ${smoke.stderr}`,
        );
      }
      console.log(
        `ok ${name}: assembly entry ${manifest.exports?.['./assembly']?.default} (${Date.now() - smokeStartedAt}ms) -> ${smoke.stdout.trim()}`,
      );
    }

    const after = watchedDirectories.map(listFilesRelative);
    for (let index = 0; index < watchedDirectories.length; index += 1) {
      const writes = after[index]?.filter((file) => !before[index]?.includes(file)) ?? [];
      if (writes.length > 0) {
        fail(`${name}: entry wrote user data files: ${writes.join(', ')}`);
      }
    }

    // F-006：公共入口加载无副作用核验通过后，再从 dist、非源码 cwd 冒烟真实
    // Host 启动入口（专用子目录，不影响上面的用户目录写入断言）。
    if (name === 'shiploop-host') {
      await smokeHostStartEntry(packageRoot, sandbox, childEnv);
    }

    console.log(
      `ok ${name}: loaded ${rootExport.default} (exit=0, ${durationMs}ms, no side effects)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
