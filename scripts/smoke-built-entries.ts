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
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['packages/core', 'packages/host', 'packages/cli'] as const;
const LOAD_TIMEOUT_MS = 5000;
const ASSEMBLY_SMOKE_TIMEOUT_MS = 60_000;
const HOST_START_SMOKE_TIMEOUT_MS = 30_000;
const CLI_BIN_SMOKE_TIMEOUT_MS = 30_000;

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

/**
 * F-012 构建冒烟：dist/bin.js 在非源码 cwd、显式临时数据根跑通纵向命令。
 * 断言监听地址/实例身份/退出码/CLI 退出后 Host 存活/stop 三证据/停止后锁可获，
 * 不只匹配成功日志；任何输出都不得包含 token。
 */
async function smokeCliBin(
  packageRoot: string,
  sandbox: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const binEntry = resolve(packageRoot, 'dist/bin.js');
  if (!existsSync(binEntry)) {
    fail('shiploop-cli: F-012 bin entry missing: dist/bin.js');
  }
  const binHead = readFileSync(binEntry, 'utf8').slice(0, 32);
  if (!binHead.startsWith('#!/usr/bin/env node')) {
    fail('shiploop-cli: dist/bin.js must start with the #!/usr/bin/env node shebang');
  }
  if ((statSync(binEntry).mode & 0o111) === 0) {
    fail('shiploop-cli: dist/bin.js must have an executable bit (prepare-cli-bin.ts)');
  }

  const workDir = join(sandbox, 'cli-bin');
  mkdirSync(workDir, { recursive: true });
  const dataRoot = join(workDir, 'data');
  const hostDir = join(dataRoot, 'host');
  const discoveryFile = join(hostDir, 'discovery.json');
  const tokenFile = join(hostDir, 'auth.token');
  const lockFile = join(hostDir, 'writer.lock');
  const outputs: Array<{ name: string; stdout: string; stderr: string }> = [];

  const run = (label: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [binEntry, ...args], {
      cwd: workDir,
      env: baseEnv,
      encoding: 'utf8',
      timeout: CLI_BIN_SMOKE_TIMEOUT_MS,
    });
    if (result.error) {
      fail(`shiploop-cli: ${label} spawn failed: ${result.error.message}`);
    }
    if (result.signal) {
      fail(`shiploop-cli: ${label} killed by signal ${String(result.signal)}`);
    }
    outputs.push({ name: label, stdout: result.stdout, stderr: result.stderr });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const jsonResult = (label: string, invocation: { status: number | null; stdout: string; stderr: string }): Record<string, any> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(invocation.stdout.trim());
    } catch (error) {
      fail(`shiploop-cli: ${label} stdout is not one JSON object: ${(error as Error).message} (${invocation.stdout})`);
    }
    return parsed as Record<string, any>;
  };

  const assertAlive = (pid: number): void => {
    try {
      process.kill(pid, 0);
    } catch {
      fail(`shiploop-cli: Host pid ${pid} is not alive right after a CLI invocation`);
    }
  };

  // 1) start（经 dist/start.js 正式入口 spawn 后台 Host，非源码 cwd）。
  const start = run('start', ['host', 'start', '--data-root', dataRoot, '--json']);
  if (start.status !== 0) {
    fail(`shiploop-cli: start exit ${String(start.status)}: ${start.stderr}`);
  }
  const startEnvelope = jsonResult('start', start);
  if (startEnvelope.ok !== true || startEnvelope.command !== 'host.start') {
    fail('shiploop-cli: start envelope shape mismatch');
  }
  const first = startEnvelope.result;
  if (
    first.outcome !== 'started' ||
    first.listenAddress !== '127.0.0.1' ||
    !Number.isInteger(first.port) ||
    first.port < 1 ||
    first.port > 65535 ||
    typeof first.hostInstanceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.hostInstanceId) ||
    !/^[0-9a-f]{64}$/.test(first.dataRootIdentity) ||
    first.lifecycleState !== 'ready' ||
    first.protocolVersion !== 1
  ) {
    fail(`shiploop-cli: start result is not a handshake-verified instance: ${JSON.stringify(first)}`);
  }
  const firstId = first.hostInstanceId as string;
  const firstPort = first.port as number;
  const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as Record<string, unknown>;
  if (
    discovery.hostInstanceId !== firstId ||
    discovery.port !== firstPort ||
    discovery.listenAddress !== '127.0.0.1' ||
    typeof discovery.pid !== 'number'
  ) {
    fail('shiploop-cli: discovery.json is inconsistent with the start result');
  }
  if (realpathSync(dataRoot) && first.dataRootIdentity !== createHash('sha256').update(realpathSync(dataRoot), 'utf8').digest('hex')) {
    fail('shiploop-cli: dataRootIdentity does not match the canonical data root');
  }
  const firstPid = discovery.pid as number;
  const firstToken = readFileSync(tokenFile, 'utf8');
  if (!/^[0-9a-f]{64}$/.test(firstToken)) {
    fail('shiploop-cli: auth.token is not 64 lowercase hex');
  }
  assertAlive(firstPid);

  // 2) 第二次 start：连接同一实例（CLI 进程已退出，Host 仍存活）。
  const second = run('start-again', ['host', 'start', '--data-root', dataRoot, '--json']);
  if (second.status !== 0) {
    fail(`shiploop-cli: second start exit ${String(second.status)}: ${second.stderr}`);
  }
  const again = jsonResult('start-again', second).result;
  if (again.outcome !== 'already_running' || again.hostInstanceId !== firstId || again.port !== firstPort) {
    fail(`shiploop-cli: second start did not connect to the same instance: ${JSON.stringify(again)}`);
  }

  // 3) status（JSON）：真实生命周期状态。
  const status = run('status', ['host', 'status', '--data-root', dataRoot, '--json']);
  if (status.status !== 0) {
    fail(`shiploop-cli: status exit ${String(status.status)}: ${status.stderr}`);
  }
  const statusResult = jsonResult('status', status).result;
  if (
    statusResult.hostInstanceId !== firstId ||
    statusResult.lifecycleState !== 'ready' ||
    statusResult.pid !== firstPid ||
    JSON.stringify(statusResult.activities) !== JSON.stringify({ accepted: 0, quiescing: 0 }) ||
    statusResult.stop !== null
  ) {
    fail(`shiploop-cli: status result mismatch: ${JSON.stringify(statusResult)}`);
  }

  // 4) 非 JSON 人类输出到 stdout；Host 在多个短生命周期 CLI 后仍存活。
  const human = run('status-human', ['host', 'status', '--data-root', dataRoot]);
  if (human.status !== 0 || !human.stdout.includes('ready') || !human.stdout.includes(firstId)) {
    fail(`shiploop-cli: human status mismatch (exit=${String(human.status)}): ${human.stdout} ${human.stderr}`);
  }
  assertAlive(firstPid);

  // 4b) F-015 项目命令纵向：dist/bin.js 在非源码 cwd、真实临时 Git 仓库/数据根
  // 上完成注册/分页列表/详情+绑定/CAS 编辑/标签统计，并核验幂等与别名语义。
  const repoDir = join(workDir, 'repo-smoke');
  mkdirSync(repoDir, { recursive: true });
  const gitRun = (gitArgs: readonly string[]): string => {
    const result = spawnSync('git', [...gitArgs], {
      cwd: repoDir,
      env: {
        ...baseEnv,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error || result.signal || result.status !== 0) {
      fail(
        `shiploop-cli: git ${gitArgs.join(' ')} failed (status=${String(result.status)}, signal=${String(result.signal)}): ${String(result.stderr).slice(0, 200)}`,
      );
    }
    return String(result.stdout);
  };
  gitRun(['init', '--initial-branch=main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), '# smoke repo\n', 'utf8');
  gitRun(['add', '-A']);
  gitRun([
    '-c',
    'user.name=ShipLoop Smoke',
    '-c',
    'user.email=smoke@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'init',
  ]);

  const projectArgs = (rest: readonly string[]): string[] => [...rest, '--data-root', dataRoot, '--json'];
  const register = run(
    'project-register',
    projectArgs(['project', 'register', repoDir, '--name', 'Smoke Repo', '--label', 'smoke']),
  );
  if (register.status !== 0) {
    fail(`shiploop-cli: project register exit ${String(register.status)}: ${register.stderr}`);
  }
  const registerEnvelope = jsonResult('project-register', register);
  if (registerEnvelope.ok !== true || registerEnvelope.command !== 'project.register') {
    fail('shiploop-cli: project register envelope mismatch');
  }
  const registerReceipt = registerEnvelope.result as Record<string, any>;
  if (
    registerReceipt.status !== 'completed' ||
    (registerReceipt.result as Record<string, any>).status !== 'registered' ||
    typeof (registerReceipt.result as Record<string, any>).project?.id !== 'string'
  ) {
    fail(`shiploop-cli: project register receipt mismatch: ${JSON.stringify(registerReceipt)}`);
  }
  const projectId = (registerReceipt.result as Record<string, any>).project.id as string;
  const registeredBinding = (registerReceipt.result as Record<string, any>).binding as Record<string, unknown>;
  if (registeredBinding.canonicalPath !== realpathSync(repoDir)) {
    fail('shiploop-cli: registered binding canonicalPath mismatch');
  }

  const list = run('project-list', projectArgs(['project', 'list', '--limit', '1']));
  if (list.status !== 0) {
    fail(`shiploop-cli: project list exit ${String(list.status)}: ${list.stderr}`);
  }
  const listResult = jsonResult('project-list', list).result as Record<string, any>;
  if (
    !Array.isArray(listResult.records) ||
    listResult.records[0]?.id !== projectId ||
    listResult.limit !== 1
  ) {
    fail(`shiploop-cli: project list mismatch: ${JSON.stringify(listResult)}`);
  }

  const get = run('project-get', projectArgs(['project', 'get', projectId]));
  if (get.status !== 0) {
    fail(`shiploop-cli: project get exit ${String(get.status)}: ${get.stderr}`);
  }
  const getResult = jsonResult('project-get', get).result as Record<string, any>;
  if (getResult.project?.id !== projectId || getResult.binding?.canonicalPath !== realpathSync(repoDir)) {
    fail(`shiploop-cli: project get mismatch: ${JSON.stringify(getResult)}`);
  }

  const labels = run('project-labels', projectArgs(['project', 'labels']));
  if (labels.status !== 0) {
    fail(`shiploop-cli: project labels exit ${String(labels.status)}: ${labels.stderr}`);
  }
  const labelRows = jsonResult('project-labels', labels).result.labels as Array<{ label: string; projectCount: number }>;
  if (!labelRows.some((row) => row.label === 'smoke' && row.projectCount === 1)) {
    fail(`shiploop-cli: project labels mismatch: ${JSON.stringify(labelRows)}`);
  }

  const edit = run(
    'project-edit',
    projectArgs(['project', 'edit', projectId, '--revision', '1', '--name', 'Smoke Renamed', '--description', 'edited']),
  );
  if (edit.status !== 0) {
    fail(`shiploop-cli: project edit exit ${String(edit.status)}: ${edit.stderr}`);
  }
  const editProject = (jsonResult('project-edit', edit).result as Record<string, any>).result.project as Record<string, any>;
  if (editProject.revision !== 2 || editProject.displayName !== 'Smoke Renamed') {
    fail(`shiploop-cli: project edit result mismatch: ${JSON.stringify(editProject)}`);
  }

  // 显式相同 commandId 重放原回执；不同参数复用 ID → conflict（退出码 1）。
  const replayId = randomUUID();
  const replayRegister = (name: string) =>
    run('project-idem', projectArgs(['project', 'register', repoDir, '--name', name, '--command-id', replayId]));
  if (replayRegister('Idem Name').status !== 0) {
    fail('shiploop-cli: first explicit-commandId register failed');
  }
  const secondReplay = replayRegister('Idem Name');
  if (secondReplay.status !== 0 || jsonResult('project-idem-2', secondReplay).result?.replayed !== true) {
    fail('shiploop-cli: second explicit-commandId register was not replayed');
  }
  const conflictRegister = replayRegister('Different Name');
  if (
    conflictRegister.status !== 1 ||
    jsonResult('project-idem-conflict', conflictRegister).error?.code !== 'conflict'
  ) {
    fail(`shiploop-cli: different-params commandId reuse must exit 1 conflict: ${String(conflictRegister.stderr)}`);
  }

  // 符号链接别名复用同一项目（不新增项目/绑定/事件）。
  const aliasDir = join(workDir, 'repo-smoke-alias');
  symlinkSync(repoDir, aliasDir, 'dir');
  const alias = run('project-alias', projectArgs(['project', 'register', aliasDir, '--name', 'Alias']));
  if (alias.status !== 0) {
    fail(`shiploop-cli: alias register exit ${String(alias.status)}: ${alias.stderr}`);
  }
  const aliasResult = (jsonResult('project-alias', alias).result as Record<string, any>).result as Record<string, any>;
  if (aliasResult.status !== 'already_exists' || aliasResult.project?.id !== projectId) {
    fail(`shiploop-cli: symlink alias duplicated project: ${JSON.stringify(aliasResult)}`);
  }
  assertAlive(firstPid);

  // 4c) F-016 配置与回执纵向：dist/bin.js 在非源码 cwd、真实数据根上完成
  // config create/get/effective/export 与 receipt get，并核验幂等/冲突/无配置。
  // 生产入口能力目录为空，故配置 payload 只用 policies（策略条目会 fail-closed）。
  const globalPayloadFile = join(workDir, 'global-config.json');
  writeFileSync(
    globalPayloadFile,
    JSON.stringify({
      schemaVersion: 2,
      policies: { executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600000 } },
    }),
    'utf8',
  );
  const projectPayloadFile = join(workDir, 'project-config.json');
  writeFileSync(
    projectPayloadFile,
    JSON.stringify({ schemaVersion: 2, policies: { verification: { requireChecksBeforeDone: true } } }),
    'utf8',
  );

  // 未配置项目 → not_found 退出码 1（明确区别于损坏/已配置）。
  const noConfig = run(
    'config-get-absent',
    projectArgs(['config', 'get', '--scope', 'project', '--project', projectId]),
  );
  if (noConfig.status !== 1 || jsonResult('config-get-absent', noConfig).error?.code !== 'not_found') {
    fail(`shiploop-cli: config get on unconfigured project must exit 1 not_found: ${noConfig.stderr}`);
  }

  const configCommandId = randomUUID();
  const globalCreate = run(
    'config-create-global',
    projectArgs([
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      globalPayloadFile,
      '--command-id',
      configCommandId,
    ]),
  );
  if (globalCreate.status !== 0) {
    fail(`shiploop-cli: config create global exit ${String(globalCreate.status)}: ${globalCreate.stderr}`);
  }
  const globalReceipt = jsonResult('config-create-global', globalCreate).result as Record<string, any>;
  if (
    globalReceipt.status !== 'completed' ||
    globalReceipt.result?.revision !== 1 ||
    globalReceipt.result?.scope?.kind !== 'global'
  ) {
    fail(`shiploop-cli: config create global receipt mismatch: ${JSON.stringify(globalReceipt)}`);
  }

  // 显式相同 commandId 的重复创建 → 重放原回执（不重复副作用）。
  const globalReplay = run(
    'config-create-global-replay',
    projectArgs([
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      globalPayloadFile,
      '--command-id',
      configCommandId,
    ]),
  );
  if (globalReplay.status !== 0 || jsonResult('config-create-global-replay', globalReplay).result?.replayed !== true) {
    fail('shiploop-cli: explicit commandId config create was not replayed');
  }

  const globalGet = run('config-get-global', projectArgs(['config', 'get', '--scope', 'global']));
  if (globalGet.status !== 0) {
    fail(`shiploop-cli: config get global exit ${String(globalGet.status)}: ${globalGet.stderr}`);
  }
  const globalGetResult = jsonResult('config-get-global', globalGet).result as Record<string, any>;
  if (globalGetResult.revision !== 1 || globalGetResult.scope?.kind !== 'global') {
    fail(`shiploop-cli: config get global mismatch: ${JSON.stringify(globalGetResult)}`);
  }

  // 带 revision 的成功更新 → revision 2，当前值与持久状态一致。
  const globalUpdateFile = join(workDir, 'global-config-update.json');
  writeFileSync(
    globalUpdateFile,
    JSON.stringify({
      schemaVersion: 2,
      policies: { executionLimits: { maxConcurrentWorks: 2, workTimeoutMs: 600000 } },
    }),
    'utf8',
  );
  const globalUpdate = run(
    'config-update-global',
    projectArgs(['config', 'update', '--scope', 'global', '--revision', '1', '--input', globalUpdateFile]),
  );
  if (globalUpdate.status !== 0) {
    fail(`shiploop-cli: config update global exit ${String(globalUpdate.status)}: ${globalUpdate.stderr}`);
  }
  const globalUpdateReceipt = jsonResult('config-update-global', globalUpdate).result as Record<string, any>;
  if (globalUpdateReceipt.status !== 'completed' || globalUpdateReceipt.result?.revision !== 2) {
    fail(`shiploop-cli: config update global receipt mismatch: ${JSON.stringify(globalUpdateReceipt)}`);
  }
  const globalGetUpdated = run('config-get-global-updated', projectArgs(['config', 'get', '--scope', 'global']));
  if (
    globalGetUpdated.status !== 0 ||
    (jsonResult('config-get-global-updated', globalGetUpdated).result as Record<string, any>).revision !== 2
  ) {
    fail('shiploop-cli: config get after update must show revision 2');
  }

  const projectCreate = run(
    'config-create-project',
    projectArgs([
      'config',
      'create',
      '--scope',
      'project',
      '--project',
      projectId,
      '--input',
      projectPayloadFile,
    ]),
  );
  if (projectCreate.status !== 0) {
    fail(`shiploop-cli: config create project exit ${String(projectCreate.status)}: ${projectCreate.stderr}`);
  }

  const effective = run('config-effective', projectArgs(['config', 'effective', '--project', projectId]));
  if (effective.status !== 0) {
    fail(`shiploop-cli: config effective exit ${String(effective.status)}: ${effective.stderr}`);
  }
  const effectiveResult = jsonResult('config-effective', effective).result as Record<string, any>;
  // policies-only 配置不声称执行就绪（configured=false），但来源必须正确合并。
  if (
    effectiveResult.policies?.executionLimits?.source?.kind !== 'global_default' ||
    effectiveResult.policies?.verification?.source?.kind !== 'project_default'
  ) {
    fail(`shiploop-cli: config effective policy sources mismatch: ${JSON.stringify(effectiveResult)}`);
  }

  const exportRes = run('config-export', projectArgs(['config', 'export', '--scope', 'global']));
  if (exportRes.status !== 0) {
    fail(`shiploop-cli: config export exit ${String(exportRes.status)}: ${exportRes.stderr}`);
  }
  const exportResult = jsonResult('config-export', exportRes).result as Record<string, any>;
  if (
    exportResult.exportFormatVersion !== 1 ||
    exportResult.current?.revision !== 2 ||
    exportResult.scope !== 'global'
  ) {
    fail(`shiploop-cli: config export mismatch: ${JSON.stringify(exportResult)}`);
  }

  const receiptGet = run('receipt-get', projectArgs(['receipt', 'get', configCommandId]));
  if (receiptGet.status !== 0) {
    fail(`shiploop-cli: receipt get exit ${String(receiptGet.status)}: ${receiptGet.stderr}`);
  }
  const receiptResult = jsonResult('receipt-get', receiptGet).result as Record<string, any>;
  if (receiptResult.status !== 'completed' || receiptResult.commandId !== configCommandId) {
    fail(`shiploop-cli: receipt get mismatch: ${JSON.stringify(receiptResult)}`);
  }

  // 相同 commandId + 不同参数 → conflict（idempotency_key_reuse），不重复副作用。
  const reuseConflict = run(
    'config-command-id-conflict',
    projectArgs([
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      projectPayloadFile,
      '--command-id',
      configCommandId,
    ]),
  );
  if (
    reuseConflict.status !== 1 ||
    jsonResult('config-command-id-conflict', reuseConflict).error?.code !== 'conflict' ||
    jsonResult('config-command-id-conflict', reuseConflict).error?.details?.reason !== 'idempotency_key_reuse'
  ) {
    fail(`shiploop-cli: commandId reuse with different params must exit 1 conflict: ${reuseConflict.stderr}`);
  }

  // 未装配能力目录 → 策略条目 fail-closed 拒绝（invalid_input，零写入）。
  const strategyPayloadFile = join(workDir, 'strategy-config.json');
  writeFileSync(
    strategyPayloadFile,
    JSON.stringify({
      schemaVersion: 2,
      strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
    }),
    'utf8',
  );
  const incompatible = run(
    'config-incompatible-strategy',
    projectArgs(['config', 'create', '--scope', 'project', '--project', projectId, '--input', strategyPayloadFile]),
  );
  if (incompatible.status !== 2 || jsonResult('config-incompatible-strategy', incompatible).error?.code !== 'invalid_input') {
    fail(`shiploop-cli: unassembled strategy must exit 2 invalid_input: ${incompatible.stderr}`);
  }

  // 陈旧 revision → conflict 退出码 1，且不修改已持久配置。
  const staleUpdate = run(
    'config-update-stale',
    projectArgs([
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '99',
      '--input',
      projectPayloadFile,
    ]),
  );
  if (staleUpdate.status !== 1 || jsonResult('config-update-stale', staleUpdate).error?.code !== 'conflict') {
    fail(`shiploop-cli: stale config revision must exit 1 conflict: ${staleUpdate.stderr}`);
  }
  assertAlive(firstPid);

  // 4d) F-017 事件观察纵向：dist/bin.js 快照 + 水位 + 显式游标恢复补读（NDJSON
  // 记录流）；Ctrl+C（SIGINT）只结束本次观察（退出码 4），Host 不停止。
  // 此时持久事件恰为：registered / metadata_updated / global_created /
  // global_updated / project_created（水位 sequence=5）。
  const eventsArgs = (rest: readonly string[]): string[] => [
    'events',
    ...rest,
    '--data-root',
    dataRoot,
    '--json',
  ];
  const parseNdjson = (label: string, stdout: string): Array<Record<string, any>> => {
    const trimmed = stdout.trim();
    if (trimmed === '') {
      fail(`shiploop-cli: ${label} produced no NDJSON records`);
    }
    return trimmed.split('\n').map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        fail(`shiploop-cli: ${label} stdout line is not JSON: ${line}`);
      }
    });
  };
  const recordKindsOf = (records: Array<Record<string, any>>): string[] =>
    records.map((record) =>
      record.ok === true ? String(record.result?.kind) : `error:${String(record.error?.code)}`,
    );

  const snapOnly = run('events-snapshot-only', eventsArgs(['--project', projectId, '--snapshot-only']));
  if (snapOnly.status !== 0) {
    fail(`shiploop-cli: events snapshot-only exit ${String(snapOnly.status)}: ${snapOnly.stderr}`);
  }
  const snapRecords = parseNdjson('events-snapshot-only', snapOnly.stdout);
  if (recordKindsOf(snapRecords).join(',') !== 'snapshot,observation_end') {
    fail(`shiploop-cli: events snapshot-only records mismatch: ${snapOnly.stdout}`);
  }
  const snapWatermark = snapRecords[0].result?.snapshot?.watermark as Record<string, any>;
  if (
    snapWatermark.sequence !== 5 ||
    typeof snapWatermark.cursor !== 'string' ||
    !snapWatermark.cursor.startsWith('evcur_v1_')
  ) {
    fail(`shiploop-cli: events snapshot watermark mismatch: ${JSON.stringify(snapWatermark)}`);
  }
  if (snapRecords[0].result?.snapshot?.project?.revision !== 2) {
    fail('shiploop-cli: events snapshot project revision mismatch');
  }
  const resumeCursor = snapWatermark.cursor as string;

  // 建连前写入（revision 2 → 3），再显式游标恢复补读：事件与重取快照投影一致。
  const editAgain = run(
    'project-edit-again',
    projectArgs(['project', 'edit', projectId, '--revision', '2', '--description', 'edited again']),
  );
  if (editAgain.status !== 0) {
    fail(`shiploop-cli: project edit again exit ${String(editAgain.status)}: ${editAgain.stderr}`);
  }
  const resume = run(
    'events-resume',
    eventsArgs(['--project', projectId, '--cursor', resumeCursor, '--snapshot-only']),
  );
  if (resume.status !== 0) {
    fail(`shiploop-cli: events resume exit ${String(resume.status)}: ${resume.stderr}`);
  }
  const resumeRecords = parseNdjson('events-resume', resume.stdout);
  if (recordKindsOf(resumeRecords).join(',') !== 'snapshot,event,snapshot,observation_end') {
    fail(`shiploop-cli: events resume records mismatch: ${resume.stdout}`);
  }
  const resumedEvent = resumeRecords[1].result?.event as Record<string, any>;
  if (
    resumedEvent.type !== 'project.metadata_updated' ||
    resumedEvent.sequence !== 6 ||
    resumedEvent.aggregate?.revision !== 3
  ) {
    fail(`shiploop-cli: resumed event mismatch: ${JSON.stringify(resumedEvent)}`);
  }
  const finalSnapshot = resumeRecords[2].result?.snapshot as Record<string, any>;
  if (finalSnapshot.project?.revision !== 3 || finalSnapshot.watermark?.sequence !== 6) {
    fail('shiploop-cli: final snapshot after drain does not match Core state');
  }

  // 未知/不可见项目观察 → forbidden（退出码 1），单条失败记录。
  const forbiddenObserve = run(
    'events-forbidden',
    eventsArgs(['--project', randomUUID(), '--snapshot-only']),
  );
  const forbiddenRecords = parseNdjson('events-forbidden', forbiddenObserve.stdout);
  if (forbiddenObserve.status !== 1 || forbiddenRecords.at(-1)?.error?.code !== 'forbidden') {
    fail(`shiploop-cli: events on unknown project must exit 1 forbidden: ${forbiddenObserve.stderr}`);
  }

  // follow + SIGINT：只结束本次观察（退出码 4 + observation_interrupted 终态记录），
  // Host 不停止、已提交命令不受影响。
  const followChild = spawn(
    process.execPath,
    [binEntry, 'events', '--project', projectId, '--data-root', dataRoot, '--json'],
    { cwd: workDir, env: baseEnv },
  );
  let followStdout = '';
  let followStderr = '';
  followChild.stdout?.on('data', (chunk) => {
    followStdout += String(chunk);
  });
  followChild.stderr?.on('data', (chunk) => {
    followStderr += String(chunk);
  });
  const followDeadline = Date.now() + CLI_BIN_SMOKE_TIMEOUT_MS;
  while (!followStdout.includes('"kind":"snapshot"')) {
    if (Date.now() >= followDeadline) {
      followChild.kill('SIGKILL');
      fail(`shiploop-cli: events follow did not emit snapshot record: ${followStderr}`);
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
  followChild.kill('SIGINT');
  const followExit = await waitChildExit(followChild, CLI_BIN_SMOKE_TIMEOUT_MS);
  outputs.push({ name: 'events-follow-sigint', stdout: followStdout, stderr: followStderr });
  if (followExit.code !== 4) {
    fail(
      `shiploop-cli: events follow SIGINT must exit 4, got ${String(followExit.code)}/${String(followExit.signal)}: ${followStderr}`,
    );
  }
  const followRecords = parseNdjson('events-follow', followStdout);
  if (followRecords.at(-1)?.error?.code !== 'observation_interrupted') {
    fail(`shiploop-cli: events follow terminal record mismatch: ${followStdout}`);
  }
  assertAlive(firstPid);

  // 4c2) F-006（P02-3）静态接入纵向：dist/bin.js 先静态预览（有 HEAD/无 HEAD/脏
  // 仓库）、显式 --confirm 才经既有 project.register 注册；overview 注册/健康
  // 分开；重复 init 同规范路径（别名）复用既有项目；同 commandId 幂等/冲突。
  const initGitRun = (gitArgs: readonly string[], cwd: string): string => {
    const result = spawnSync('git', [...gitArgs], {
      cwd,
      env: {
        ...baseEnv,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error || result.signal || result.status !== 0) {
      fail(
        `shiploop-cli: git ${gitArgs.join(' ')} failed in ${cwd}: ${String(result.stderr).slice(0, 200)}`,
      );
    }
    return String(result.stdout);
  };
  const initRepo = join(workDir, 'repo-init');
  mkdirSync(initRepo, { recursive: true });
  initGitRun(['init', '--initial-branch=main', initRepo], workDir);
  writeFileSync(join(initRepo, 'README.md'), '# init smoke\n', 'utf8');
  initGitRun(['add', '-A'], initRepo);
  initGitRun(
    ['-c', 'user.name=ShipLoop Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'init'],
    initRepo,
  );
  const initHead = initGitRun(['rev-parse', 'HEAD'], initRepo).trim();
  const emptyRepo = join(workDir, 'repo-init-empty');
  mkdirSync(emptyRepo, { recursive: true });
  initGitRun(['init', '--initial-branch=main', emptyRepo], workDir);
  const dirtyRepo = join(workDir, 'repo-init-dirty');
  mkdirSync(dirtyRepo, { recursive: true });
  initGitRun(['init', '--initial-branch=main', dirtyRepo], workDir);
  writeFileSync(join(dirtyRepo, 'README.md'), '# dirty smoke\n', 'utf8');
  initGitRun(['add', '-A'], dirtyRepo);
  initGitRun(
    ['-c', 'user.name=ShipLoop Smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'dirty'],
    dirtyRepo,
  );
  writeFileSync(join(dirtyRepo, 'uncommitted.txt'), 'dirty\n', 'utf8');

  // 预览一：有 HEAD 新仓库（无 --confirm）→ not_run，退出码 0，零注册副作用。
  // （projectArgs 恒附 --json；人类模式单独起一次不带 --json 的调用。）
  const initPreviewHuman = run('project-init-preview-human', [
    'project',
    'init',
    initRepo,
    '--name',
    'Init Smoke',
    '--data-root',
    dataRoot,
  ]);
  if (initPreviewHuman.status !== 0) {
    fail(
      `shiploop-cli: project init preview exit ${String(initPreviewHuman.status)}: ${initPreviewHuman.stderr}`,
    );
  }
  if (
    !initPreviewHuman.stdout.includes(realpathSync(initRepo)) ||
    !initPreviewHuman.stdout.includes('静态预览') ||
    !initPreviewHuman.stdout.includes('not_run') ||
    initPreviewHuman.stderr.length === 0
  ) {
    fail(`shiploop-cli: project init preview must show static facts: ${initPreviewHuman.stdout}`);
  }
  const initPreviewJson = run(
    'project-init-preview-json',
    projectArgs(['project', 'init', initRepo, '--name', 'Init Smoke']),
  );
  const initPreviewResult = jsonResult('project-init-preview-json', initPreviewJson).result as Record<string, any>;
  if (
    initPreviewResult.registration?.status !== 'not_run' ||
    initPreviewResult.health?.status !== 'not_run' ||
    initPreviewResult.health?.reasonCode !== 'no_baseline' ||
    initPreviewResult.preview?.headCommit !== initHead ||
    initPreviewResult.preview?.hasUncommittedChanges !== false
  ) {
    fail(`shiploop-cli: project init preview result mismatch: ${JSON.stringify(initPreviewResult)}`);
  }
  // 预览二：无 HEAD 仓库不猜分支（headCommit=null）；脏仓库原样保留脏标记。
  const emptyPreview = jsonResult(
    'project-init-empty',
    run('project-init-empty', projectArgs(['project', 'init', emptyRepo])),
  ).result as Record<string, any>;
  if (emptyPreview.preview?.headCommit !== null || emptyPreview.preview?.hasInitialCommit !== false) {
    fail(`shiploop-cli: empty repo preview must show headCommit null: ${JSON.stringify(emptyPreview)}`);
  }
  const dirtyPreview = jsonResult(
    'project-init-dirty',
    run('project-init-dirty', projectArgs(['project', 'init', dirtyRepo])),
  ).result as Record<string, any>;
  if (dirtyPreview.preview?.hasUncommittedChanges !== true) {
    fail(`shiploop-cli: dirty repo preview must show uncommitted changes: ${JSON.stringify(dirtyPreview)}`);
  }

  // --confirm 但缺 --name：在连接 Host 之前以退出码 2 拒绝。
  const initNoName = run('project-init-no-name', projectArgs(['project', 'init', initRepo, '--confirm']));
  if (
    initNoName.status !== 2 ||
    jsonResult('project-init-no-name', initNoName).error?.details?.reason !== 'name_required_for_registration'
  ) {
    fail(`shiploop-cli: project init --confirm without --name must exit 2: ${initNoName.stderr}`);
  }

  // 确认注册：返回真实 projectId，健康独立显示尚未检查。
  const initCommandId = randomUUID();
  const initConfirm = run(
    'project-init-confirm',
    projectArgs([
      'project',
      'init',
      initRepo,
      '--name',
      'Init Smoke',
      '--label',
      'onboarding',
      '--confirm',
      '--command-id',
      initCommandId,
    ]),
  );
  if (initConfirm.status !== 0) {
    fail(`shiploop-cli: project init --confirm exit ${String(initConfirm.status)}: ${initConfirm.stderr}`);
  }
  const initConfirmResult = jsonResult('project-init-confirm', initConfirm).result as Record<string, any>;
  const initProjectId = initConfirmResult.registration?.projectId;
  if (
    initConfirmResult.registration?.status !== 'registered' ||
    typeof initProjectId !== 'string' ||
    initConfirmResult.health?.status !== 'not_run' ||
    initConfirmResult.health?.reasonCode !== 'no_baseline'
  ) {
    fail(`shiploop-cli: project init confirm result mismatch: ${JSON.stringify(initConfirmResult)}`);
  }

  // overview：注册状态与健康状态分开显示（注册成功 ≠ 健康通过）。
  const overview = run('project-overview', [
    'project',
    'overview',
    initProjectId as string,
    '--data-root',
    dataRoot,
  ]);
  if (overview.status !== 0) {
    fail(`shiploop-cli: project overview exit ${String(overview.status)}: ${overview.stderr}`);
  }
  if (!overview.stdout.includes('注册状态：registered') || !overview.stdout.includes('健康状态：not_run')) {
    fail(`shiploop-cli: project overview must separate registration and health: ${overview.stdout}`);
  }
  const overviewJson = jsonResult(
    'project-overview-json',
    run('project-overview-json', projectArgs(['project', 'overview', initProjectId as string])),
  ).result as Record<string, any>;
  if (
    overviewJson.registration?.status !== 'registered' ||
    overviewJson.health?.status !== 'not_run' ||
    overviewJson.health?.reasonCode !== 'no_baseline' ||
    overviewJson.binding?.canonicalPath !== realpathSync(initRepo)
  ) {
    fail(`shiploop-cli: project overview result mismatch: ${JSON.stringify(overviewJson)}`);
  }

  // 别名路径重复 init：already_registered 复用既有项目，不覆盖元数据。
  const initAlias = join(workDir, 'repo-init-alias');
  symlinkSync(realpathSync(initRepo), initAlias, 'dir');
  const initRepeat = run(
    'project-init-repeat-alias',
    projectArgs(['project', 'init', initAlias, '--name', 'Overwrite Name', '--confirm']),
  );
  if (initRepeat.status !== 0) {
    fail(`shiploop-cli: repeated init exit ${String(initRepeat.status)}: ${initRepeat.stderr}`);
  }
  const initRepeatResult = jsonResult('project-init-repeat-alias', initRepeat).result as Record<string, any>;
  if (
    initRepeatResult.registration?.status !== 'already_registered' ||
    initRepeatResult.registration?.projectId !== initProjectId
  ) {
    fail(`shiploop-cli: repeated init must reuse existing project: ${JSON.stringify(initRepeatResult)}`);
  }
  const overviewAfterRepeat = jsonResult(
    'project-overview-after-repeat',
    run('project-overview-after-repeat', projectArgs(['project', 'overview', initProjectId as string])),
  ).result as Record<string, any>;
  if (
    overviewAfterRepeat.project?.displayName !== 'Init Smoke' ||
    overviewAfterRepeat.project?.labels?.[0] !== 'onboarding'
  ) {
    fail(
      `shiploop-cli: repeated init must not overwrite metadata: ${JSON.stringify(overviewAfterRepeat)}`,
    );
  }

  // 同 commandId 同参数 → 重放原回执（注册轴仍 registered + 同 projectId）；
  // 不同参数 → conflict 退出码 1。
  const initReplay = run(
    'project-init-replay',
    projectArgs([
      'project',
      'init',
      initRepo,
      '--name',
      'Init Smoke',
      '--label',
      'onboarding',
      '--confirm',
      '--command-id',
      initCommandId,
    ]),
  );
  if (initReplay.status !== 0) {
    fail(`shiploop-cli: project init replay exit ${String(initReplay.status)}: ${initReplay.stderr}`);
  }
  const initReplayResult = jsonResult('project-init-replay', initReplay).result as Record<string, any>;
  if (
    initReplayResult.registration?.status !== 'registered' ||
    initReplayResult.registration?.projectId !== initProjectId
  ) {
    fail(`shiploop-cli: project init replay must return original receipt outcome: ${JSON.stringify(initReplayResult)}`);
  }
  const initReceipt = jsonResult(
    'project-init-receipt',
    run('project-init-receipt', projectArgs(['receipt', 'get', initCommandId])),
  ).result as Record<string, any>;
  if (initReceipt.status !== 'completed' || initReceipt.commandId !== initCommandId) {
    fail(`shiploop-cli: project init receipt mismatch: ${JSON.stringify(initReceipt)}`);
  }
  const initConflict = run(
    'project-init-conflict',
    projectArgs([
      'project',
      'init',
      initRepo,
      '--name',
      'Different Params',
      '--confirm',
      '--command-id',
      initCommandId,
    ]),
  );
  if (
    initConflict.status !== 1 ||
    jsonResult('project-init-conflict', initConflict).error?.code !== 'conflict' ||
    jsonResult('project-init-conflict', initConflict).error?.details?.reason !== 'idempotency_key_reuse'
  ) {
    fail(`shiploop-cli: init commandId reuse with different params must exit 1 conflict: ${initConflict.stderr}`);
  }
  assertAlive(firstPid);

  // 5) 解析失败 → 退出码 2，stdout 为空（非 JSON 模式）。
  const badArgs = run('bad-args', ['host', 'status', '--bogus']);
  if (badArgs.status !== 2 || badArgs.stdout !== '' || !badArgs.stderr.includes('invalid_input')) {
    fail(`shiploop-cli: invalid args must exit 2 with stderr diagnostic: ${JSON.stringify(badArgs)}`);
  }

  // 6) status/stop 不启动 Host：全新根 → host_not_found 退出码 3，不创建根。
  const data2 = join(workDir, 'data2');
  const absent = run('status-absent', ['host', 'status', '--data-root', data2, '--json']);
  if (absent.status !== 3) {
    fail(`shiploop-cli: status on absent root must exit 3, got ${String(absent.status)}`);
  }
  const absentEnvelope = jsonResult('status-absent', absent);
  if (absentEnvelope.error?.code !== 'host_not_found') {
    fail(`shiploop-cli: absent status must report host_not_found: ${JSON.stringify(absentEnvelope)}`);
  }
  if (existsSync(data2)) {
    fail('shiploop-cli: status created the data root (must never launch or create)');
  }

  // 7) 监听地址覆盖 → 退出码 2 且零文件副作用。
  const data3 = join(workDir, 'data3');
  const override = run('bind-override', ['host', 'start', '--data-root', data3, '--bind', '0.0.0.0', '--json']);
  if (override.status !== 2) {
    fail(`shiploop-cli: bind override must exit 2, got ${String(override.status)}`);
  }
  if (jsonResult('bind-override', override).error?.code !== 'bind_address_override_rejected') {
    fail('shiploop-cli: bind override must report bind_address_override_rejected');
  }
  if (existsSync(data3)) {
    fail('shiploop-cli: bind override rejection left filesystem side effects');
  }

  // 8) stop：三证据齐备才 stopped；随后进程退出、发现/凭据删除、锁文件保留。
  const stop = run('stop', ['host', 'stop', '--data-root', dataRoot, '--json']);
  if (stop.status !== 0) {
    fail(`shiploop-cli: stop exit ${String(stop.status)}: ${stop.stderr}`);
  }
  const stopResult = jsonResult('stop', stop).result;
  if (
    stopResult.status !== 'stopped' ||
    stopResult.hostInstanceId !== firstId ||
    JSON.stringify(stopResult.evidence) !==
      JSON.stringify({ processExit: 'confirmed', lock: 'acquirable', discovery: 'removed' })
  ) {
    fail(`shiploop-cli: stop result is not evidence-based stopped: ${JSON.stringify(stopResult)}`);
  }
  // 外部证据复核：进程退出（有界）、发现/凭据消失、writer.lock 保留。
  const goneDeadline = Date.now() + 10_000;
  let exited = false;
  while (Date.now() < goneDeadline) {
    try {
      process.kill(firstPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        exited = true;
        break;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!exited) {
    fail(`shiploop-cli: Host pid ${firstPid} did not exit after stop`);
  }
  if (existsSync(discoveryFile) || existsSync(tokenFile)) {
    fail('shiploop-cli: stop did not remove discovery/token files');
  }
  if (!existsSync(lockFile)) {
    fail('shiploop-cli: stop must never delete writer.lock');
  }

  // 9) 停止后锁可获：start 成功且为全新实例（新身份）；再 stop 收尾。
  const restart = run('restart', ['host', 'start', '--data-root', dataRoot, '--json']);
  if (restart.status !== 0) {
    fail(`shiploop-cli: restart after stop exit ${String(restart.status)}: ${restart.stderr}`);
  }
  const restartResult = jsonResult('restart', restart).result;
  if (restartResult.outcome !== 'started' || restartResult.hostInstanceId === firstId) {
    fail(`shiploop-cli: restart must start a fresh instance: ${JSON.stringify(restartResult)}`);
  }
  const secondToken = readFileSync(tokenFile, 'utf8');
  const restartPid = JSON.parse(readFileSync(discoveryFile, 'utf8')) as { pid?: number };
  if (typeof restartPid.pid !== 'number') {
    fail('shiploop-cli: restart discovery pid missing before final stop');
  }
  const restartPidValue = restartPid.pid;
  const restartStop = run('restart-stop', ['host', 'stop', '--data-root', dataRoot, '--json']);
  if (restartStop.status !== 0 || jsonResult('restart-stop', restartStop).result?.status !== 'stopped') {
    fail(`shiploop-cli: final stop mismatch: ${restartStop.status} ${restartStop.stdout} ${restartStop.stderr}`);
  }
  const restartGoneDeadline = Date.now() + 10_000;
  let restartExited = false;
  while (Date.now() < restartGoneDeadline) {
    try {
      process.kill(restartPidValue, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        restartExited = true;
        break;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!restartExited) {
    fail(`shiploop-cli: restart Host pid ${String(restartPidValue)} did not exit after stop`);
  }
  if (existsSync(discoveryFile)) {
    fail('shiploop-cli: final stop left discovery.json behind');
  }

  // 10) 全部 CLI 输出（含错误分支）都不得泄漏任一 token。
  for (const output of outputs) {
    if (output.stdout.includes(firstToken) || output.stderr.includes(firstToken)) {
      fail(`shiploop-cli: ${output.name} leaked the first auth token`);
    }
    if (output.stdout.includes(secondToken) || output.stderr.includes(secondToken)) {
      fail(`shiploop-cli: ${output.name} leaked the restart auth token`);
    }
  }

  console.log(
    'ok shiploop-cli: dist/bin.js host start/status/stop + project/config/receipt vertical smoke (same instance on second start, '
      + 'host alive across CLI exits, evidence-based stopped, fresh instance after stop, config idempotency/CAS/no-config, exit codes 0/1/2/3, no token leak)',
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

    // Explicit Fake entries must also load from dist without SDK, login or side effects.
    if (name === 'shiploop-core' || name === 'shiploop-host') {
      const testing = manifest.exports?.['./testing'];
      if (typeof testing?.default !== 'string' || !testing.default.startsWith('./dist/') ||
          typeof testing.types !== 'string' || !testing.types.startsWith('./dist/') ||
          !existsSync(resolve(packageRoot, testing.default)) || !existsSync(resolve(packageRoot, testing.types))) {
        fail(`${name}: testing export must provide built JS and declarations`);
      }
      const loaded = spawnSync(process.execPath, [resolve(packageRoot, testing.default)], {
        cwd, env: childEnv, encoding: 'utf8', timeout: LOAD_TIMEOUT_MS,
      });
      if (loaded.error || loaded.signal || loaded.status !== 0) {
        fail(`${name}: testing entry failed: ${loaded.error?.message ?? loaded.stderr}`);
      }
      console.log(`ok ${name}: explicit testing entry ${testing.default}`);
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

    // F-012：CLI bin 清单字段必须指向已发射的 dist/bin.js（侧效应加载的是
    // exports['.'] 公共入口，bin 不在此列，单独冒烟 start/status/stop 纵切）。
    if (name === 'shiploop-cli') {
      const binField = (manifest as { bin?: unknown }).bin;
      if (JSON.stringify(binField) !== JSON.stringify({ shiploop: './dist/bin.js' })) {
        fail('shiploop-cli: package.json bin must be { shiploop: ./dist/bin.js }');
      }
      await smokeCliBin(packageRoot, sandbox, childEnv);
    }

    console.log(
      `ok ${name}: loaded ${rootExport.default} (exit=0, ${durationMs}ms, no side effects)`,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
