/**
 * F-014 文档核验：`docs/p02-1-operations.md` 的操作示例必须与真实 Host 生命周期
 * CLI 一致，`docs/p02-1-handoff.md` 与 `docs/acceptance/p02-1-f014-report.md` 必须
 * 指向真实可复跑入口、锁边界与未实现能力。
 *
 * 定位：F-014 只交付文档（+ 本守护）；为避免文档与实现漂移，本套件在真实临时数据
 * 根与真实 Host 子进程上，用生产 CLI 执行层 `runHostCli` 跑通操作说明记录的纵向
 * 命令（start/二次 start 同实例/status/stop/无实例 status），并用纯解析面交叉核对
 * 文档记录的命令、参数、默认值、退出码与诊断码。不新增业务实现、不扩大 P02-1
 * 交付范围、不依赖预存 dist。
 *
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runHostCli,
  type HostCliIo,
  type HostCliRunResult,
} from '../packages/cli/src/host/execute.ts';
import { getHostCliHelp, parseHostCliArgs } from '../packages/cli/src/index.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPERATIONS_DOC_PATH = 'docs/p02-1-operations.md';
const HANDOFF_DOC_PATH = 'docs/p02-1-handoff.md';
const REPORT_DOC_PATH = 'docs/acceptance/p02-1-f014-report.md';
const F013_EVIDENCE_DOC_PATH = 'docs/acceptance/evidence-p02-1/f013-regression-evidence.md';

const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const handoffDoc = readFileSync(resolve(REPO_ROOT, HANDOFF_DOC_PATH), 'utf-8');
const reportDoc = readFileSync(resolve(REPO_ROOT, REPORT_DOC_PATH), 'utf-8');

const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);

/** 干净树下以 TS 源码运行正式 Host 入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY];
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: REPO_ROOT, timeout: 60_000 });
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
): Promise<CliInvocation> {
  const collected = collectIo();
  const result = await runHostCli({
    args,
    io: collected.io,
    launch: {
      entryArgv: tsEntryArgv(),
      childEnv: env.childEnv(),
    },
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

function parseEnvelope(invocation: CliInvocation): Record<string, unknown> {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as Record<string, unknown>;
}

describe('F-014 P02-1 操作说明文档', () => {
  let env: IsolatedHostEnvironment;

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-p021-f014-docs-' });
  });

  afterEach(async () => {
    await env.dispose();
  });

  it('操作说明记录的纵向命令在真实数据根上可复跑（start/二次 start/status/stop/无实例 status）', async () => {
    const { canonicalRoot } = env.dataRoot('docs-vertical');

    // 1) start：连接或经正式获锁入口启动；JSON 信封含真实方式与握手事实。
    const start = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(start.result.exitCode, start.stderr).toBe(0);
    const startEnvelope = parseEnvelope(start);
    expect(startEnvelope.ok).toBe(true);
    expect(startEnvelope.command).toBe('host.start');
    const startResult = startEnvelope.result as Record<string, unknown>;
    expect(startResult.outcome).toBe('started');
    expect(startResult.listenAddress).toBe('127.0.0.1');
    expect(Number.isInteger(startResult.port)).toBe(true);
    expect(startResult.lifecycleState).toBe('ready');
    const instanceId = startResult.hostInstanceId as string;

    // 2) 二次 start：客户端退出不停止 Host，直接连接同一实例。
    const second = await runCli(env, ['host', 'start', '--data-root', canonicalRoot, '--json']);
    expect(second.result.exitCode, second.stderr).toBe(0);
    const secondResult = parseEnvelope(second).result as Record<string, unknown>;
    expect(secondResult.outcome).toBe('already_running');
    expect(secondResult.hostInstanceId).toBe(instanceId);

    // 3) status：只读真实状态，不启动 Host。
    const status = await runCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
    expect(status.result.exitCode, status.stderr).toBe(0);
    const statusResult = parseEnvelope(status).result as Record<string, unknown>;
    expect(statusResult.hostInstanceId).toBe(instanceId);
    expect(statusResult.lifecycleState).toBe('ready');

    // 4) stop：只有 §10.6 三证据齐备才报告 stopped。
    const stop = await runCli(env, ['host', 'stop', '--data-root', canonicalRoot, '--json']);
    expect(stop.result.exitCode, stop.stderr).toBe(0);
    const stopResult = parseEnvelope(stop).result as Record<string, unknown>;
    expect(stopResult.status).toBe('stopped');
    expect(stopResult.evidence).toEqual({
      processExit: 'confirmed',
      lock: 'acquirable',
      discovery: 'removed',
    });
    expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
    expect(existsSync(join(canonicalRoot, 'host', 'auth.token'))).toBe(false);
    // writer.lock 永不被业务清理删除。
    expect(existsSync(join(canonicalRoot, 'host', 'writer.lock'))).toBe(true);

    // 5) 无实例的 status：只读命令失败为连接错误（退出码 3），绝不启动新 Host。
    const missing = await runCli(env, ['host', 'status', '--data-root', canonicalRoot, '--json']);
    expect(missing.result.exitCode, missing.stderr).toBe(3);
    const missingEnvelope = parseEnvelope(missing);
    expect(missingEnvelope.ok).toBe(false);
    expect((missingEnvelope.error as Record<string, unknown>).code).toBe('host_not_found');
    expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);

    // 6) 相对数据根与监听地址覆盖在任何 I/O 之前以退出码 2 拒绝。
    const relative = await runCli(env, ['host', 'status', '--data-root', 'relative/root']);
    expect(relative.result.exitCode, relative.stderr).toBe(2);
    const bindOverride = await runCli(env, [
      'host',
      'start',
      '--data-root',
      canonicalRoot,
      '--bind',
      '0.0.0.0',
    ]);
    expect(bindOverride.result.exitCode, bindOverride.stderr).toBe(2);
    expect(existsSync(join(canonicalRoot, 'host', 'discovery.json'))).toBe(false);
  });

  it('操作说明记录的命令、参数、默认值与退出码与真实解析面一致', () => {
    // 文档只声明本 Feature 的三个生命周期子命令，不编造后续命令。
    for (const command of ['host start', 'host status', 'host stop']) {
      expect(operationsDoc).toContain(command);
    }
    expect(operationsDoc).not.toMatch(/shiploop\s+(project|run|feature)\b/);

    // 记录的命令示例使用真实构建入口（dist/bin.js 或已发布的 shiploop bin）。
    expect(operationsDoc).toContain('packages/cli/dist/bin.js');
    expect(operationsDoc).toContain('node packages/cli/dist/bin.js host start');

    // 参数名与默认值/范围与解析面一致，且出现在真实帮助文本中。
    const startParsed = parseHostCliArgs([
      'host',
      'start',
      '--data-root',
      '/tmp/shiploop-docs-root',
      '--start-timeout-ms',
      '15000',
      '--json',
    ]);
    expect(startParsed.kind).toBe('command');
    if (startParsed.kind !== 'command') {
      throw new Error('expected command parse result');
    }
    expect(startParsed.command).toBe('start');
    const stopParsed = parseHostCliArgs([
      'host',
      'stop',
      '--data-root',
      '/tmp/shiploop-docs-root',
      '--stop-command-id',
      '0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10',
      '--confirm-timeout-ms',
      '10000',
      '--json',
    ]);
    expect(stopParsed.kind).toBe('command');
    if (stopParsed.kind !== 'command') {
      throw new Error('expected command parse result');
    }
    expect(stopParsed.command).toBe('stop');

    const startHelp = getHostCliHelp('start');
    const stopHelp = getHostCliHelp('stop');
    const hostHelp = getHostCliHelp('host');
    for (const token of [
      '--data-root',
      '--json',
      '--start-timeout-ms',
      '--stop-command-id',
      '--confirm-timeout-ms',
    ]) {
      expect(operationsDoc).toContain(token);
    }
    expect(startHelp).toContain('--start-timeout-ms');
    expect(stopHelp).toContain('--stop-command-id');
    expect(hostHelp).toContain('--data-root');
    // 默认值/范围（15000 / 1000..60000 / 10000 / 0..30000）必须与文档一致。
    for (const value of ['15000', '1000..60000', '10000', '0..30000']) {
      expect(operationsDoc).toContain(value);
    }

    // 四档退出码与脱敏信封措辞出现在文档。
    for (const exitToken of [
      '退出码 0',
      '退出码 1',
      '退出码 2',
      '退出码 3',
      'stop_not_confirmed',
      'owner_unknown',
      'owner_active',
      'unsafe_discovery',
      'invalid_discovery',
    ]) {
      expect(operationsDoc).toContain(exitToken);
    }

    // 受保护文件布局与权限、回环地址不可配置边界。
    for (const layoutToken of [
      'discovery.json',
      'auth.token',
      'writer.lock',
      '0700',
      '0600',
      '127.0.0.1',
    ]) {
      expect(operationsDoc).toContain(layoutToken);
    }

    // 安全边界与 macOS 唯一正式平台。
    for (const securityToken of [
      '同用户',
      'macOS',
      'token',
      '不防',
      '可信',
    ]) {
      expect(operationsDoc).toContain(securityToken);
    }

    // 运行产物不含开发机绝对路径或真实凭据样例。
    expect(operationsDoc).not.toContain('/Users/ganlu');
    expect(operationsDoc).not.toMatch(/[0-9a-f]{64}/);
  });

  it('交接文档指向真实公共面、锁要求与待实现能力，报告记录命令/证据/差距', () => {
    for (const publicSurface of [
      'shiploop-host',
      'connectToHost',
      'ensureHostRunning',
      'acquireWriterLock',
      'openLockedWriter',
      'createHostFileStore',
      'runHostCli',
    ]) {
      expect(handoffDoc).toContain(publicSurface);
    }
    // 锁持有要求与未实现能力如实交接。
    for (const boundary of [
      'writer.lock',
      'owner_unknown',
      'advisory',
      '项目注册',
      'SSE',
      'Scheduler',
      'Runner',
      'Pi SDK',
      'command_receipts',
      'accept:p02',
      'not_run',
    ]) {
      expect(handoffDoc).toContain(boundary);
    }
    // 交接引用真实存在的契约/证据文件。
    for (const ref of [
      'p02-1-host-lifecycle-contract.md',
      'p02-1-writer-lock.md',
      'acceptance/evidence-p02-1/f013-regression-evidence.md',
    ]) {
      expect(handoffDoc).toContain(ref);
    }

    for (const section of [
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run verify',
      'evidence-p02-1',
      'not_run',
      '结论',
      '安全',
    ]) {
      expect(reportDoc).toContain(section);
    }
    // 报告对应实际受测代码 commit，并指向真实脱敏证据。
    expect(reportDoc).toMatch(/[0-9a-f]{40}/);
    expect(() => readFileSync(resolve(REPO_ROOT, F013_EVIDENCE_DOC_PATH), 'utf-8')).not.toThrow();
    expect(() =>
      readFileSync(resolve(REPO_ROOT, 'docs/acceptance/evidence-p02-1/f014-commands.md'), 'utf-8'),
    ).not.toThrow();
    // 报告与证据均不含凭据或开发机绝对路径。
    expect(reportDoc).not.toContain('/Users/ganlu');
    expect(reportDoc).not.toContain('apiKey:');
    const f014Evidence = readFileSync(
      resolve(REPO_ROOT, 'docs/acceptance/evidence-p02-1/f014-commands.md'),
      'utf-8',
    );
    expect(f014Evidence).not.toContain('/Users/ganlu');
    expect(f014Evidence).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });
});
