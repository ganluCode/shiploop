/**
 * F-018 P02-3 整 Feature 真实 Git/SQLite/进程/Host/CLI 集成回归。
 *
 * 定位：本套件不改任何产品源码，把 P02-3 静态接入与基线检查（F-003 ~ F-017
 * 已交付能力）放进真实多进程场景做整链回归；单能力分支的逐项深挖见既有套件
 * （p02-3-init-overview-vertical / p02-3-baseline-preview-authorize /
 * baseline-execution / baseline-evidence / supervised-process-stopping /
 * baseline-host-faults / p02-3-baseline-host-routes / p02-3-baseline-cli-vertical），
 * 此处按 F-018 验收标准做跨能力组合回归：
 *
 * - FR-1 静态接入：真实仓库变体（有 HEAD/无 HEAD/脏/同 remote 双 clone/路径
 *   别名/恶意初始化脚本）经真实 CLI 执行层 + 真实 Host 子进程注册，独立只读
 *   SQLite 探针核对项目/绑定行、真实 HEAD、tracked/untracked 文件字节与恶意
 *   哨兵缺失；非 Git 注册拒绝零副作用；HTTP 客户端中断（首字节即断开）后
 *   恰一行项目且重放同信封得同一回执；
 * - FR-2 基线检查：一次获准运行覆盖成功/原有失败/缺命令/未知脚本（含 decline
 *   持久 not_run），断言逐项状态/原因/退出码/输出引用、SSE 事件与持久
 *   state_events 逐行一致、占用/claim 与实际副作用一致、失败不撤销注册；
   进程纪律矩阵覆盖挂起显式取消（真实 pid 停止核验）、timeout、忽略 SIGTERM
 *   的进程树（升级终止后父/孙进程核验死亡、取消升级期间 resource_busy 不能
 *   重跑）、大输出（output_overflow 有界）；证据写入失败经真实 HTTP 传输面 +
 *   确定性故障注入，运行不折算通过、占用保留、新运行拒绝；
 * - FR-3 并发/授权边界：两 CLI 客户端同数据根唯一 Host（实例不变、CLI 退出
 *   Host 存活）；并发竞争基线单次启动（恰一次真实进程启动）；相同命令重放
 *   沿用原操作、不同摘要 conflict、过期授权 command_expired 零副作用；取消与
 *   完成竞争终态一致且迟到取消不改写；preview_stale（源码变化）与运行期
 *   source_changed（改动保留）；跨项目操作/证据、cwd 逃逸与伪环境引用拒绝；
 * - FR-4 恢复：显式 host stop → 重启后注册/历史检查/证据/拒绝记录照常可查且
 *   可再运行；SIGKILL 崩溃 → 新实例恢复核对旧进程（真实 pid 死亡核验），
 *   interrupted 历史可查、原 commandId 不重放启动、新运行可继续。
 *
 * 运行前提：macOS（flock）；真实临时数据根/Git 仓库/回环 HTTP/真实子进程；
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME；全部等待
 * 有界；夹具回收只删除已核验的自有临时资源。旧进程「不可核实身份」的保留
 * 占用边界（需持久身份不可核实）由 baseline-host-faults.test.ts 覆盖，本套件
 * 以真实取消升级窗口（cancelling 未确认停止）覆盖同一不变量。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  connectToHost,
  createHostFileStore,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  startHost,
  type HostClient,
  type RunningHost,
} from '../packages/host/src/index.ts';
import {
  createLocalOwnerPrincipal,
  createStaticRuntimeCapabilityCatalog,
  type CommandReceipt,
} from '../packages/core/src/index.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createBaselineExecutionService } from '../packages/core/src/application/baseline-execution.ts';
import { createBaselineWorkspaceReader } from '../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createBaselineRepositoryGuard } from '../packages/core/src/adapters/fs/baseline-repository-guard.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import { runAppCli, type AppCliIo } from '../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import { openStorageProbe, type StorageProbe } from './helpers/p02-2/storage-probe.ts';
import {
  createBaselineFixture,
  isMissingCommandExecutableAbsent,
  type BaselineFixture,
} from './helpers/p02-3/index.ts';
import { createFaultyArtifactFileStore } from './helpers/p02-3/evidence-faults.ts';
import { createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';
import { connectSseLoopback, type SseConnection, type SseFrame } from './helpers/p02-2/sse-client.ts';
import { loopbackRequest, type LoopbackResponse } from './helpers/host/http-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 干净树下以 TS 源码运行正式 Host 入口（生产默认 argv 为 [dist/start.js]）。 */
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry.ts', import.meta.url),
);

const OWNER = createLocalOwnerPrincipal();
const CATALOG = createStaticRuntimeCapabilityCatalog([]);
const CLIENT_TIMEOUTS = { appRequestMs: 30_000, submitBudgetMs: 90_000 } as const;

let fixture: BaselineFixture;
/** 测试进程内直接 startHost 的实例（afterEach 受控关闭）。 */
const runningHosts: RunningHost[] = [];
/** runAppCli 拉起的 detached Host 数据根（afterEach 尽力 host stop）。 */
const cliHostRoots: string[] = [];
/** 受限传输面服务器与打开的 Core（收尾关闭）。 */
const openedServers: (() => Promise<void> | void)[] = [];
const openedApps: { close(): void }[] = [];
const openedSessions: { close(): void }[] = [];

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
  fixture = createBaselineFixture({ prefix: 'shiploop-f018-p023-' });
  expect(isMissingCommandExecutableAbsent(), '缺命令样例可执行文件必须确实不存在').toBe(true);
}, 90_000);

/** 经真实 HostClient 取消数据根内全部在途基线（有界；清理路径专用）。 */
async function cancelInFlightBaselines(canonicalRoot: string): Promise<void> {
  let client: HostClient;
  try {
    client = await connectToHost({ canonicalRoot, timeouts: { appRequestMs: 5_000, submitBudgetMs: 10_000 } });
  } catch {
    return; // 无可连接 Host（已崩溃/已停止）。
  }
  try {
    const projects = await client.listProjects();
    for (const record of projects.records) {
      const page = await client.listBaselines(record.id, { limit: 100 });
      for (const operation of page.records) {
        if (['accepted', 'running', 'cancelling'].includes(operation.status)) {
          await client.cancelBaseline(record.id, operation.operationId).catch(() => undefined);
        }
      }
    }
  } catch {
    // 尽力收尾。
  } finally {
    client.close();
  }
}

afterEach(async () => {
  while (runningHosts.length > 0) {
    const host = runningHosts.pop();
    if (host !== undefined) {
      try {
        for (const operationId of host.core.baselineExecutionService.activeOperationIds()) {
          const row = host.core.baselineStore.getBaselineOperation(operationId);
          if (row !== undefined) {
            await host.core.baselineExecutionService.cancel(OWNER, row.projectId, operationId).catch(() => undefined);
          }
        }
        await host.core.baselineExecutionService.waitForIdle();
      } catch {
        // 尽力收尾。
      }
      await host.close().catch(() => undefined);
    }
  }
  for (const server of openedServers.splice(0)) {
    await Promise.resolve(server()).catch(() => undefined);
  }
  for (const session of openedSessions.splice(0)) {
    session.close();
  }
  for (const app of openedApps.splice(0)) {
    app.close();
  }
  for (const root of cliHostRoots.splice(0)) {
    // 先取消在途基线（挂起检查会阻止 Host 停止并保留仓库 claim）。
    await cancelInFlightBaselines(root).catch(() => undefined);
    const collected = collectIo();
    try {
      await runHostCli({
        args: ['host', 'stop', '--data-root', root, '--json'],
        io: collected.io as HostCliIo,
        env: {},
      });
    } catch {
      // 尽力收尾；Host 可能已崩溃（崩溃用例本身会重启）。
    }
  }
});

afterAll(async () => {
  await fixture.dispose();
});

/* ------------------------------------------------------------------ *
 * 公共小工具
 * ------------------------------------------------------------------ */

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
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

function dataRootOf(name: string): string {
  const root = fixture.dataRoot(name);
  if (!cliHostRoots.includes(root)) {
    cliHostRoots.push(root);
  }
  return root;
}

function launchOverrides() {
  return {
    entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
    childEnv: fixture.childEnv(),
    pollIntervalMs: 50,
  };
}

interface CliInvocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 真实 CLI 执行层（与 dist/bin.js 同一路径），Host 经 ensureHostRunning 拉起真实子进程。 */
async function runApp(args: readonly string[]): Promise<CliInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    launch: launchOverrides(),
  });
  return { exitCode: result.exitCode, stdout: collected.stdout(), stderr: collected.stderr() };
}

function parseEnvelope(invocation: CliInvocation): {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
} {
  const lines = invocation.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0);
  expect(lines, invocation.stderr).toHaveLength(1);
  return JSON.parse(lines[0] as string);
}

function okResultOf(invocation: CliInvocation, command: string): Record<string, unknown> {
  expect(invocation.exitCode, invocation.stderr).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(invocation: CliInvocation, exitCode: number, code: string) {
  expect(invocation.exitCode, invocation.stderr).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.code).toBe(code);
  return envelope.error;
}

function probeOf(root: string): StorageProbe {
  return openStorageProbe(join(root, DATABASE_FILE_NAME));
}

function gitOf(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: fixture.childEnv(),
    encoding: 'utf8',
  });
}

function readToken(canonicalRoot: string): string {
  const token = readFileSync(join(canonicalRoot, 'host', 'auth.token'), 'utf8');
  fixture.evidence.registerSecret(token);
  return token;
}

function readDiscovery(canonicalRoot: string): { hostInstanceId: string; pid: number; port: number } {
  const discovery = createHostFileStore({ canonicalRoot }).readTrustedDiscovery();
  return { hostInstanceId: discovery.hostInstanceId, pid: discovery.pid, port: discovery.port };
}

/** 有界等待谓词成立（绝不无界轮询；谓词可为异步）。 */
async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  budgetMs: number,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时（预算 ${budgetMs}ms）`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

/** 有界等待进程真正消失（探测失败不算停止）。 */
async function waitForPidGone(pid: number, budgetMs: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : undefined;
    }
  }, budgetMs);
}

/** 进程真实存活核验（不把探测失败当作已停止）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/* ------------------------------------------------------------------ *
 * 命令脚本（全部写在沙箱内临时目录；绝不写入受检仓库 → 不触发 source_changed）
 * ------------------------------------------------------------------ */

let scriptsDir: string;
let pidHangScript: string;
let counterHangScript: string;
let treeIgnoreSigtermScript: string;
let writerChildScript: string;

function ensureScripts(): void {
  if (scriptsDir !== undefined) {
    return;
  }
  scriptsDir = join(fixture.root, 'f018-scripts');
  mkdirSync(scriptsDir, { recursive: true });
  pidHangScript = join(scriptsDir, 'pid-hang.cjs');
  writeFileSync(
    pidHangScript,
    [
      'const fs = require("fs");',
      'fs.writeFileSync(process.argv[2], String(process.pid));',
      'process.stdout.write("f018-pid-hang:started\\n");',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  counterHangScript = join(scriptsDir, 'counter-hang.cjs');
  writeFileSync(
    counterHangScript,
    [
      'const fs = require("fs");',
      'fs.appendFileSync(process.argv[2], process.pid + "\\n");',
      'process.stdout.write("f018-counter-hang:started\\n");',
      'const release = process.argv[3];',
      'setInterval(() => { if (fs.existsSync(release)) process.exit(0); }, 10);',
      '',
    ].join('\n'),
  );
  writerChildScript = join(scriptsDir, 'writer-child.cjs');
  writeFileSync(
    writerChildScript,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const dir = process.argv[2];',
      'fs.mkdirSync(dir, { recursive: true });',
      'let tick = 0;',
      'setInterval(() => { tick += 1; fs.writeFileSync(path.join(dir, `child-write-${tick}.txt`), `tick ${tick}\\n`); }, 20);',
      '',
    ].join('\n'),
  );
  treeIgnoreSigtermScript = join(scriptsDir, 'tree-ignore-sigterm.cjs');
  writeFileSync(
    treeIgnoreSigtermScript,
    [
      'const fs = require("fs");',
      'const { spawn } = require("child_process");',
      'const statusFile = process.argv[2];',
      'const childDir = process.argv[3];',
      'process.on("SIGTERM", () => { fs.appendFileSync(statusFile + ".term", "ignored\\n"); });',
      'const child = spawn(process.execPath, [process.argv[4], childDir], { stdio: "ignore" });',
      'fs.writeFileSync(statusFile, JSON.stringify({ parent: process.pid, child: child.pid }));',
      'process.stdout.write("f018-tree:started\\n");',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ *
 * 检查计划构造（纯函数）
 * ------------------------------------------------------------------ */

interface CheckSpec extends Record<string, unknown> {
  readonly checkKey: string;
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly required: boolean;
}

function check(checkKey: string, argv: readonly string[], extra: Record<string, unknown> = {}): CheckSpec {
  return {
    checkKey,
    kind: 'command',
    argv: [...argv],
    timeoutMs: 60_000,
    required: true,
    ...extra,
  };
}

function planOf(checks: readonly CheckSpec[]): { checks: CheckSpec[] } {
  return { checks: checks.map((entry) => ({ ...entry, argv: [...entry.argv] })) };
}

/* ------------------------------------------------------------------ *
 * HTTP 面（真实回环；token 只进 Authorization 头）
 * ------------------------------------------------------------------ */

interface HttpError {
  readonly code: string;
  readonly details?: Record<string, unknown>;
}

function errorOf(response: LoopbackResponse): HttpError {
  const body = response.json() as { error?: { code?: unknown; details?: unknown } };
  if (typeof body.error?.code !== 'string') {
    throw new Error(`响应不是结构化错误体：${response.bodyText.slice(0, 120)}`);
  }
  return body.error as HttpError;
}

function commandEnvelope(
  operation: string,
  scope: Record<string, unknown>,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 4,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: new Date().toISOString(),
    payload,
    ...overrides,
  };
}

/** Host 进程内上下文（生产 startHost + 真实发现/握手客户端）。 */
interface HostContext {
  readonly root: string;
  /** attach 模式（detached Host）下不可用；HTTP 面统一经 port 访问。 */
  readonly host: RunningHost | undefined;
  readonly port: number;
  readonly client: HostClient;
  readonly token: string;
  registerProject(repositoryPath: string, displayName: string): Promise<string>;
  preview(
    projectId: string,
    plan: { checks: CheckSpec[] },
  ): Promise<{ previewDigest: string; policyRevision: string }>;
  run(
    projectId: string,
    plan: { checks: CheckSpec[] },
    previewDigest: string,
    decision: 'authorize' | 'decline',
    options?: { readonly commandId?: string; readonly issuedAt?: string },
  ): Promise<CommandReceipt>;
  runTerminal(
    projectId: string,
    plan: { checks: CheckSpec[] },
    decision: 'authorize' | 'decline',
    budgetMs?: number,
  ): Promise<{ operationId: string; detail: BaselineDetail }>;
  close(): Promise<void>;
}

interface BaselineCheckView {
  readonly checkKey: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: { readonly artifactId: string; readonly byteSize: number } | null;
  readonly tail: string | null;
}

interface BaselineDetail {
  readonly operation: {
    readonly operationId: string;
    readonly status: string;
    readonly reasonCode: string | null;
    readonly summary: Record<string, number> | null;
  };
  readonly authorization: { readonly planDigest: string } | null;
  readonly checks: readonly BaselineCheckView[];
}

async function startHostContext(root: string): Promise<HostContext> {
  // 数据根已有 runAppCli 拉起的 detached Host 时直接 attach（同根唯一 Host），
  // 否则以生产 startHost 启动新实例（close 时受控拆卸）。
  const detached = existsSync(join(root, 'host', 'discovery.json'));
  const host = detached
    ? undefined
    : await startHost({ dataRoot: root, capabilityCatalog: CATALOG, env: {} });
  if (host !== undefined) {
    runningHosts.push(host);
  }
  const client = await connectToHost({ canonicalRoot: root, timeouts: CLIENT_TIMEOUTS });
  const token = readToken(root);
  const port = host?.port ?? readDiscovery(root).port;
  const context: HostContext = {
    root,
    host,
    client,
    token,
    get port() {
      return port;
    },
    async registerProject(repositoryPath, displayName) {
      const receipt = await client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: { repositoryPath, displayName },
      });
      if (receipt.status !== 'completed') {
        throw new Error(`注册未完成：${receipt.status}`);
      }
      return (receipt.result as { project: { id: string } }).project.id;
    },
    async preview(projectId, plan) {
      const receipt = await client.previewBaseline({ projectId, plan });
      if (receipt.status !== 'completed') {
        throw new Error(`预览未完成：${receipt.status}`);
      }
      return receipt.result as { previewDigest: string; policyRevision: string };
    },
    async run(projectId, plan, previewDigest, decision, options = {}) {
      return client.runBaseline(
        {
          projectId,
          decision,
          plan,
          previewDigest,
          ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
        },
        options.issuedAt !== undefined ? { issuedAt: options.issuedAt } : {},
      );
    },
    async runTerminal(projectId, plan, decision, budgetMs = 60_000) {
      const { previewDigest } = await this.preview(projectId, plan);
      const receipt = await this.run(projectId, plan, previewDigest, decision);
      let operationId: string;
      if (receipt.status === 'accepted') {
        operationId = receipt.operationId;
      } else if (receipt.status === 'completed') {
        operationId = (receipt.result as { operationId: string }).operationId;
      } else {
        throw new Error(`运行被拒绝：${receipt.error.code}`);
      }
      const detail = await waitForBaselineTerminal(this, operationId, budgetMs);
      return { operationId, detail };
    },
    async close() {
      client.close();
      if (host === undefined) {
        return;
      }
      try {
        await host.core.baselineExecutionService.waitForIdle();
      } catch {
        // 尽力收尾。
      }
      await host.close().catch(() => undefined);
      const index = runningHosts.indexOf(host);
      if (index >= 0) {
        runningHosts.splice(index, 1);
      }
    },
  };
  return context;
}

async function fetchBaselineDetail(context: HostContext, operationId: string): Promise<BaselineDetail> {
  const response = await loopbackRequest({
    port: context.port,
    method: 'GET',
    path: `/v1/baselines/${operationId}`,
    token: context.token,
  });
  expect(response.statusCode, response.bodyText.slice(0, 200)).toBe(200);
  return response.json() as BaselineDetail;
}

async function waitForBaselineTerminal(
  context: HostContext,
  operationId: string,
  budgetMs = 60_000,
): Promise<BaselineDetail> {
  return waitFor(async () => {
    const detail = await fetchBaselineDetail(context, operationId);
    return ['accepted', 'running', 'cancelling'].includes(detail.operation.status)
      ? undefined
      : detail;
  }, budgetMs);
}

function checkView(detail: BaselineDetail, checkKey: string): BaselineCheckView {
  const found = detail.checks.find((entry) => entry.checkKey === checkKey);
  if (found === undefined) {
    throw new Error(`缺少检查 ${checkKey}：${JSON.stringify(detail.checks.map((c) => c.checkKey))}`);
  }
  return found;
}

async function readArtifactText(context: HostContext, artifactId: string): Promise<string> {
  const response = await loopbackRequest({
    port: context.port,
    method: 'GET',
    path: `/v1/artifacts/${artifactId}/content`,
    token: context.token,
  });
  expect(response.statusCode, response.bodyText.slice(0, 200)).toBe(200);
  return response.bodyText;
}

/** 提交命令并在收到响应首字节时立即断开连接（真实客户端中断）。 */
function postAndAbortOnFirstByte(
  port: number,
  token: string,
  body: unknown,
): Promise<{ aborted: boolean }> {
  return new Promise((resolveAbort, rejectAbort) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/commands',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload, 'utf8')),
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        response.once('data', () => {
          request.destroy();
          resolveAbort({ aborted: true });
        });
        response.resume();
      },
    );
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolveAbort({ aborted: true });
        return;
      }
      rejectAbort(error);
    });
    request.end(payload);
  });
}

/** 有界收集业务事件帧（state-event 帧；心跳注释不入帧）。 */
async function collectBaselineEventFrames(
  connection: SseConnection,
  count: number,
  timeoutMs: number,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const iterator = connection.events();
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collectBaselineEventFrames 超时：已收 ${frames.length}/${count}`);
    }
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<SseFrame>>((_, reject) =>
        setTimeout(() => reject(new Error('帧等待超时')), remaining),
      ),
    ]);
    if (next.done === true) {
      break;
    }
    if (next.value.event === 'state-event') {
      frames.push(next.value);
    }
  }
  return frames;
}

function baselineEventTypes(frames: readonly SseFrame[]): string[] {
  return frames
    .map((frame) => (JSON.parse(frame.data) as { type?: unknown }).type)
    .filter((type): type is string => typeof type === 'string' && type.startsWith('baseline.'));
}

/* ================================================================== *
 * A. FR-1 静态接入注册回归（真实 Git/SQLite/CLI/Host 子进程）
 * ================================================================== */

describe('F-018 FR-1：静态接入注册（真实仓库变体 + 只读 SQLite 探针）', () => {
  it('注册矩阵：有 HEAD/无 HEAD/脏/双 clone/别名/恶意仓库 → 项目/绑定行、HEAD、文件字节与哨兵', async () => {
    const repos = fixture.repos;
    const root = dataRootOf('fr1-matrix');
    const dirtyStatusBefore = gitOf(repos.dirty, ['status', '--porcelain']);
    const dirtyTrackedBefore = readFileSync(repos.dirtyTrackedFile);
    const dirtyUntrackedBefore = readFileSync(repos.dirtyUntrackedFile);
    const withHeadTreeBefore = readdirSync(join(repos.withHead, 'src'), { recursive: true }).sort();

    const register = async (path: string, name: string): Promise<{ projectId: string; status: string }> => {
      const invocation = await runApp([
        'project',
        'init',
        path,
        '--name',
        name,
        '--confirm',
        '--data-root',
        root,
        '--json',
      ]);
      const result = okResultOf(invocation, 'project.init');
      const registration = result.registration as { projectId: string; status: string };
      return registration;
    };

    // 六个不同仓库 → 六个项目/六条绑定；别名 init → already_registered 复用身份。
    const withHeadReg = await register(repos.withHead, '有 HEAD 项目');
    const aliasReg = await register(repos.alias, '别名重复注册');
    expect(aliasReg.status).toBe('already_registered');
    expect(aliasReg.projectId).toBe(withHeadReg.projectId);
    const cloneAReg = await register(repos.cloneA, '克隆 A');
    const cloneBReg = await register(repos.cloneB, '克隆 B');
    const noHeadReg = await register(repos.noInitialCommit, '无 HEAD 项目');
    const dirtyReg = await register(repos.dirty, '脏工作区项目');
    const maliciousReg = await register(repos.malicious, '恶意仓库项目');
    const projectIds = [
      withHeadReg.projectId,
      cloneAReg.projectId,
      cloneBReg.projectId,
      noHeadReg.projectId,
      dirtyReg.projectId,
      maliciousReg.projectId,
    ];
    expect(new Set(projectIds).size, '同 remote 不同 clone 不得合并为同一项目').toBe(6);

    // 独立只读探针：真实业务行（不是成功日志）。
    const probe = probeOf(root);
    try {
      expect(probe.counts()).toMatchObject({
        projects: 6,
        repository_bindings: 6,
        state_events: 6,
        // 7 次提交各留一行回执（别名 already_registered 也有回执），但零新增业务行。
        command_receipts: 7,
      });
      // 双 clone：同 remote、不同 canonical_path，各占一行（remote 不是身份）。
      expect(repos.remoteOf('cloneA')).toBe(repos.remoteOf('cloneB'));
      const bindingRows = probe.selectAll<{ project_id: string; canonical_path: string; repo_identity: string; git_common_dir: string }>(
        'SELECT project_id, canonical_path, repo_identity, git_common_dir FROM repository_bindings',
      );
      expect(new Set(bindingRows.map((row) => row.canonical_path)).size).toBe(6);
      const clonePaths = bindingRows
        .filter((row) => row.project_id === cloneAReg.projectId || row.project_id === cloneBReg.projectId)
        .map((row) => row.canonical_path)
        .sort();
      expect(clonePaths).toEqual([repos.cloneA, repos.cloneB].sort());
      for (const row of bindingRows) {
        expect(row.repo_identity.length, 'repo_identity 非空').toBeGreaterThan(0);
        expect(row.git_common_dir, '真实 clone 的公共目录被记录').toContain('/.git');
      }
      // 别名不产生新行：canonical_path 已是 realpath（别名输入被规范化）。
      expect(
        bindingRows.filter((row) => row.project_id === withHeadReg.projectId),
      ).toMatchObject([{ canonical_path: repos.withHead }]);
    } finally {
      probe.close();
    }

    // 真实 HEAD：有 HEAD 仓库与 clone 记录真实 commit；无 HEAD 仓库不猜分支不造 commit。
    expect(repos.headOf('withHead')).toMatch(/^[0-9a-f]{40}$/);
    expect(repos.headOf('cloneA')).toBe(repos.headOf('cloneB'));
    expect(repos.headOf('cloneA')).toMatch(/^[0-9a-f]{40}$/);
    expect(repos.headOf('noInitialCommit')).toBeNull();
    expect(() => gitOf(repos.noInitialCommit, ['rev-parse', 'HEAD'])).toThrow();
    // inspect（真实 Git 事实）：cloneA 报告与绑定一致的 HEAD；无 HEAD 显式 null。
    const client = await connectToHost({ canonicalRoot: root });
    try {
      const inspectClone = await client.inspectRepository(repos.cloneA);
      expect(inspectClone.headCommit).toBe(repos.headOf('cloneA'));
      expect(inspectClone.alreadyRegistered).toMatchObject({ projectId: cloneAReg.projectId });
      const inspectNoHead = await client.inspectRepository(repos.noInitialCommit);
      expect(inspectNoHead.headCommit).toBeNull();
      expect(inspectNoHead.alreadyRegistered).toMatchObject({ projectId: noHeadReg.projectId });
    } finally {
      client.close();
    }

    // 脏工作区：tracked/untracked 文件字节不变、git 状态原样（不 stash/reset/commit）。
    expect(gitOf(repos.dirty, ['status', '--porcelain'])).toBe(dirtyStatusBefore);
    expect(readFileSync(repos.dirtyTrackedFile)).toEqual(dirtyTrackedBefore);
    expect(readFileSync(repos.dirtyUntrackedFile)).toEqual(dirtyUntrackedBefore);
    expect(gitOf(repos.dirty, ['stash', 'list'])).toBe('');

    // 恶意初始化脚本仓库：注册全程零执行（哨兵不存在、源文件清单不变）。
    expect(existsSync(repos.maliciousSentinelPath)).toBe(false);
    expect(
      readdirSync(join(repos.malicious, 'scripts'), { recursive: true }).sort(),
    ).toEqual(['evil-init.mjs']);
    expect(readdirSync(join(repos.withHead, 'src'), { recursive: true }).sort()).toEqual(
      withHeadTreeBefore,
    );
  }, 180_000);

  it('注册拒绝与客户端中断：非 Git 零副作用；HTTP 首字节断开后恰一行且重放同回执', async () => {
    const repos = fixture.repos;
    const root = dataRootOf('fr1-reject-interrupt');

    // 非 Git 目录（沙箱内新建普通目录）：结构化拒绝，零项目/绑定/事件/回执行。
    const notGit = join(fixture.root, 'fr1-not-git');
    mkdirSync(notGit, { recursive: true });
    const rejected = await runApp([
      'project',
      'init',
      notGit,
      '--name',
      '非 Git',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const error = failureOf(rejected, 2, 'invalid_input');
    expect(error?.details?.reason).toBe('repository_not_a_repository');

    // 客户端中断：注册已提交（真实 HTTP），客户端在响应首字节即断开。
    const context = await startHostContext(root);
    try {
      const envelope = commandEnvelope(
        'project.register',
        { kind: 'registration' },
        { repositoryPath: repos.withHead, displayName: '中断注册项目' },
      );
      const { aborted } = await postAndAbortOnFirstByte(context.port, context.token, envelope);
      expect(aborted).toBe(true);

      const probe = probeOf(root);
      let projectId = '';
      try {
        // 中断不产生第二行副作用：恰一行项目/绑定/事件。
        await waitFor(() => {
          const counts = probe.counts();
          return counts.projects >= 1 ? counts : undefined;
        }, 15_000);
        expect(probe.counts()).toMatchObject({
          projects: 1,
          repository_bindings: 1,
          state_events: 1,
          command_receipts: 1,
        });
        projectId = probe.selectAll<{ id: string }>('SELECT id FROM projects')[0]!.id;
      } finally {
        probe.close();
      }

      // 新客户端重发同冻结信封（同 commandId + issuedAt）：重放原回执，零新增副作用。
      const replay = await context.client.submitCommand({
        commandId: envelope.commandId as string,
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: envelope.payload as Record<string, unknown>,
        issuedAt: envelope.issuedAt as string,
      });
      if (replay.status !== 'completed') {
        throw new Error(`重放未完成：${replay.status}`);
      }
      expect(replay.replayed).toBe(true);
      expect((replay.result as { project: { id: string } }).project.id).toBe(projectId);
      const probeAfter = probeOf(root);
      try {
        expect(probeAfter.counts()).toMatchObject({
          projects: 1,
          repository_bindings: 1,
          state_events: 1,
          command_receipts: 1,
        });
      } finally {
        probeAfter.close();
      }
    } finally {
      await context.close();
    }

    // 拒绝路径没有留下任何状态库行（非 Git 拒绝仍为零）。
    const probeFinal = probeOf(root);
    try {
      expect(probeFinal.counts()).toMatchObject({ projects: 1, repository_bindings: 1 });
    } finally {
      probeFinal.close();
    }
  }, 120_000);
});

/* ================================================================== *
 * B. FR-2 基线检查执行回归（真实 Host HTTP + 真实进程 + 故障注入）
 * ================================================================== */

describe('F-018 FR-2：基线执行矩阵（真实进程/事件/占用/证据）', () => {
  it('获准运行：成功/原有失败/缺命令/未知脚本 → 逐项状态/原因/退出码/输出引用；失败不撤销注册；事件/占用一致', async () => {
    ensureScripts();
    const context = await startHostContext(dataRootOf('fr2-matrix'));
    try {
      const projectId = await context.registerProject(fixture.repos.withHead, 'f018-matrix');
      const marker = `f018-matrix-output-${String(Math.floor(Math.random() * 900000) + 100000)}`;
      const missingBinary = join(fixture.root, 'f018-missing-binary-does-not-exist');
      expect(existsSync(missingBinary)).toBe(false);
      const plan = planOf([
        check('a-success', [process.execPath, '-e', `process.stdout.write(${JSON.stringify(marker)})`]),
        check('b-preexisting-failure', [process.execPath, '-e', 'process.stderr.write("boom-7"); process.exit(3)']),
        check('c-missing-command', [missingBinary, '--version']),
        check('d-unknown-script', ['./absent-relative-script']),
      ]);

      // SSE 订阅先于运行：事件与实际副作用一致（真实持久事件流）。
      // 先取快照水位游标（live 订阅 cursor 必填，§9.4）。
      const snapshot = await loopbackRequest({
        port: context.port,
        method: 'GET',
        path: `/v1/snapshot?scope=project&projectId=${projectId}`,
        token: context.token,
      });
      expect(snapshot.statusCode).toBe(200);
      const eventCursor = (snapshot.json() as { watermark: { cursor: string } }).watermark.cursor;
      const events = await connectSseLoopback({
        port: context.port,
        token: context.token,
        path: `/v1/events?scope=project&projectId=${projectId}`,
        cursor: eventCursor,
      });

      const preview = await context.preview(projectId, plan);
      const accepted = await context.run(projectId, plan, preview.previewDigest, 'authorize');
      if (accepted.status !== 'accepted') {
        throw new Error(`预期 accepted 回执，实际 ${accepted.status}`);
      }
      const operationId = accepted.operationId;

      // 运行期间：占用行与仓库 claim 均在（真实副作用），不是只有日志。
      await waitFor(async () => {
        const detail = await fetchBaselineDetail(context, operationId);
        return detail.operation.status === 'running' ? detail : undefined;
      }, 30_000);
      const claimPath = join(fixture.repos.withHead, '.git', 'shiploop-baseline.claim');
      expect(existsSync(claimPath)).toBe(true);
      const probeRunning = probeOf(context.root);
      try {
        expect(
          probeRunning.selectOne<{ holder_operation_id: string }>(
            'SELECT holder_operation_id FROM baseline_occupancy WHERE id = ?',
            ['global'],
          ),
        ).toMatchObject({ holder_operation_id: operationId });
      } finally {
        probeRunning.close();
      }

      const detail = await waitForBaselineTerminal(context, operationId, 90_000);
      expect(detail.operation.status).toBe('completed');
      expect(detail.authorization?.planDigest).toBe(preview.policyRevision);

      // 逐项状态/原因/退出码/输出引用（顺序执行全四项：error 不中断后续检查）。
      expect(detail.checks.map((entry) => entry.checkKey)).toEqual([
        'a-success',
        'b-preexisting-failure',
        'c-missing-command',
        'd-unknown-script',
      ]);
      const successView = checkView(detail, 'a-success');
      expect(successView).toMatchObject({ status: 'passed', exitCode: 0 });
      expect(successView.reasonCode ?? null).toBeNull();
      const failureView = checkView(detail, 'b-preexisting-failure');
      expect(failureView).toMatchObject({ status: 'failed', exitCode: 3 });
      expect(failureView.reasonCode ?? null).toBeNull();
      expect(checkView(detail, 'c-missing-command')).toMatchObject({
        status: 'error',
        reasonCode: 'missing_command',
        exitCode: null,
      });
      expect(checkView(detail, 'd-unknown-script')).toMatchObject({
        status: 'error',
        reasonCode: 'unknown_script',
        exitCode: null,
      });
      const successOutput = checkView(detail, 'a-success').output;
      expect(successOutput).not.toBeNull();
      expect(successOutput?.byteSize).toBeGreaterThan(0);
      const artifactText = await readArtifactText(context, successOutput?.artifactId as string);
      expect(artifactText).toContain(marker);

      // SSE 事件与持久 state_events 逐行一致（无伪造事件）。
      const frames = await collectBaselineEventFrames(events, 7, 30_000);
      await events.close();
      expect(baselineEventTypes(frames)).toEqual([
        'baseline.authorized',
        'baseline.started',
        'baseline.check_completed',
        'baseline.check_completed',
        'baseline.check_completed',
        'baseline.check_completed',
        'baseline.completed',
      ]);
      const probe = probeOf(context.root);
      try {
        const persisted = probe
          .selectAll<{ event_type: string }>(
            "SELECT event_type FROM state_events WHERE event_type LIKE 'baseline.%' ORDER BY sequence",
          )
          .map((row) => row.event_type);
        expect(persisted).toEqual(baselineEventTypes(frames));
        // 终态后占用释放；四项检查种子行收尾为 revision 2（一次性收尾不可再变）。
        expect(
          probe.selectOne<{ holder_operation_id: string | null }>(
            'SELECT holder_operation_id FROM baseline_occupancy WHERE id = ?',
            ['global'],
          )?.holder_operation_id,
        ).toBeNull();
        expect(
          probe.selectAll<{ check_key: string; status: string; revision: number }>(
            'SELECT check_key, status, revision FROM baseline_check_results ORDER BY check_key',
          ),
        ).toMatchObject([
          { check_key: 'a-success', status: 'passed', revision: 2 },
          { check_key: 'b-preexisting-failure', status: 'failed', revision: 2 },
          { check_key: 'c-missing-command', status: 'error', revision: 2 },
          { check_key: 'd-unknown-script', status: 'error', revision: 2 },
        ]);
      } finally {
        probe.close();
      }
      expect(existsSync(claimPath), '终态后仓库 claim 释放').toBe(false);

      // 失败不撤销注册：注册照常、健康独立（最近终态为获准运行 → 不健康）。
      const overview = await context.client.getProjectOverview(projectId);
      expect(overview.registration.status).toBe('registered');
      expect(overview.health.status).toBe('unhealthy');
      expect(overview.health.lastBaselineOperationId).toBe(operationId);

      // 拒绝授权：持久 not_run、零启动、零授权行。
      const sentinel = join(fixture.root, `fr2-decline-sentinel-${randomUUID().slice(0, 8)}`);
      const declinePlan = planOf([
        check('sentinel', [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`,
        ]),
      ]);
      const { operationId: declinedId, detail: declinedDetail } = await context.runTerminal(
        projectId,
        declinePlan,
        'decline',
      );
      expect(declinedDetail.operation.status).toBe('not_run');
      expect(declinedDetail.operation.reasonCode).toBe('authorization_rejected');
      expect(declinedDetail.checks).toEqual([]);
      expect(declinedDetail.authorization).toBeNull();
      expect(existsSync(sentinel)).toBe(false);
      // 拒绝后健康派生跟随最近终态（not_run 不折算健康通过）。
      const overviewAfterDecline = await context.client.getProjectOverview(projectId);
      expect(overviewAfterDecline.registration.status).toBe('registered');
      expect(overviewAfterDecline.health.status).toBe('not_run');
      expect(overviewAfterDecline.health.lastBaselineOperationId).toBe(declinedId);

      const probeFinal = probeOf(context.root);
      try {
        expect(probeFinal.counts().projects).toBe(1);
        expect(
          probeFinal.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_authorizations'),
        ).toMatchObject({ n: 1 });
        expect(
          probeFinal.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_operations'),
        ).toMatchObject({ n: 2 });
      } finally {
        probeFinal.close();
      }
    } finally {
      await context.close();
    }
  }, 180_000);

  it('进程纪律：挂起显式取消/timeout 实际停止；忽略 SIGTERM 进程树升级终止且取消期间不能重跑；大输出有界', async () => {
    ensureScripts();
    const context = await startHostContext(dataRootOf('fr2-process'));
    try {
      const projectId = await context.registerProject(fixture.repos.withHead, 'f018-process');

      // 1) 挂起 + 显式取消：真实 pid 停止核验（不是只看状态字）。
      const pidFile = join(fixture.root, `fr2-pid-${randomUUID().slice(0, 8)}`);
      const hangPlan = planOf([
        check('hang', [process.execPath, pidHangScript, pidFile], { timeoutMs: 300_000 }),
      ]);
      const hangPreview = await context.preview(projectId, hangPlan);
      const hangAccepted = await context.run(projectId, hangPlan, hangPreview.previewDigest, 'authorize');
      if (hangAccepted.status !== 'accepted') {
        throw new Error(`预期 accepted 回执，实际 ${hangAccepted.status}`);
      }
      const hungPid = await waitFor(
        () => (existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, 'utf8'), 10) : undefined),
        30_000,
      );
      expect(pidAlive(hungPid)).toBe(true);
      const cancelReceipt = await context.client.cancelBaseline(projectId, hangAccepted.operationId);
      if (cancelReceipt.status !== 'completed') {
        throw new Error(`取消命令未完成：${cancelReceipt.status}`);
      }
      const cancelResult = cancelReceipt.result as { operationId: string; status: string };
      expect(cancelResult.operationId).toBe(hangAccepted.operationId);
      expect(['cancelling', 'cancelled']).toContain(cancelResult.status);
      const cancelledDetail = await waitForBaselineTerminal(context, hangAccepted.operationId, 60_000);
      expect(cancelledDetail.operation.status).toBe('cancelled');
      expect(checkView(cancelledDetail, 'hang')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'cancelled',
      });
      await waitForPidGone(hungPid, 15_000);

      // 2) timeout：检查超时收尾（timed_out），进程实际停止。
      const timeoutPidFile = join(fixture.root, `fr2-timeout-pid-${randomUUID().slice(0, 8)}`);
      const { detail: timedOutDetail } = await context.runTerminal(
        projectId,
        planOf([check('slow', [process.execPath, pidHangScript, timeoutPidFile], { timeoutMs: 1_500 })]),
        'authorize',
      );
      expect(timedOutDetail.operation.status).toBe('completed');
      expect(timedOutDetail.operation.reasonCode).toBe('timed_out');
      expect(checkView(timedOutDetail, 'slow')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'timed_out',
        timedOut: true,
      });
      const timedOutPid = Number.parseInt(readFileSync(timeoutPidFile, 'utf8'), 10);
      await waitForPidGone(timedOutPid, 15_000);

      // 3) 忽略 SIGTERM 的进程树：显式取消 → SIGTERM 被忽略 → 升级 SIGKILL 整组；
      //    取消未确认停止期间（cancelling）新基线运行被 resource_busy 拒绝；
      //    确认停止后父/孙进程核验死亡、写入停止、占用释放、可再运行。
      const statusFile = join(fixture.root, `fr2-tree-${randomUUID().slice(0, 8)}`);
      const childDir = join(fixture.root, `fr2-tree-writes-${randomUUID().slice(0, 8)}`);
      const treeCheck = check(
        'ignore-tree',
        [process.execPath, treeIgnoreSigtermScript, statusFile, childDir, writerChildScript],
        { timeoutMs: 300_000 },
      );
      const treePlan = planOf([treeCheck]);
      const { previewDigest: treeDigest } = await context.preview(projectId, treePlan);
      const treeAccepted = await context.run(projectId, treePlan, treeDigest, 'authorize');
      if (treeAccepted.status !== 'accepted') {
        throw new Error(`预期 accepted 回执，实际 ${treeAccepted.status}`);
      }
      const treeOperationId = treeAccepted.operationId;
      const tree = await waitFor(async () => {
        if (!existsSync(statusFile)) {
          return undefined;
        }
        return JSON.parse(readFileSync(statusFile, 'utf8')) as { parent: number; child: number };
      }, 30_000);
      expect(pidAlive(tree.parent)).toBe(true);

      // 取消升级窗口（SIGTERM 被忽略、停止未确认）：取消命令要等停止确认才返回，
      // 因此竞争提交必须在取消进行中并发发出 → 占用保留 → resource_busy。
      const busyDuringEscalation = await context.preview(
        projectId,
        planOf([check('quick', [process.execPath, '--version'])]),
      );
      const treeCancelPromise = context.client.cancelBaseline(projectId, treeOperationId);
      const busyResponse = await loopbackRequest({
        port: context.port,
        method: 'POST',
        path: '/v1/commands',
        token: context.token,
        body: commandEnvelope(
          'baseline.run',
          { kind: 'project', projectId },
          {
            decision: 'authorize',
            plan: planOf([check('quick', [process.execPath, '--version'])]),
            previewDigest: busyDuringEscalation.previewDigest,
          },
        ),
      });
      expect(busyResponse.statusCode).toBe(409);
      expect(errorOf(busyResponse).code).toBe('resource_busy');
      const treeCancelReceipt = await treeCancelPromise;
      if (treeCancelReceipt.status !== 'completed') {
        throw new Error(`取消命令未完成：${treeCancelReceipt.status}`);
      }
      expect(['cancelling', 'cancelled']).toContain(
        (treeCancelReceipt.result as { status: string }).status,
      );

      const treeDetail = await waitForBaselineTerminal(context, treeOperationId, 60_000);
      expect(treeDetail.operation.status).toBe('cancelled');
      expect(checkView(treeDetail, 'ignore-tree')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'cancelled',
      });
      // 父进程与孙进程都真实死亡；孙进程不再产生新写入。
      await waitForPidGone(tree.parent, 20_000);
      await waitForPidGone(tree.child, 20_000);
      const writesAtEnd = readdirSync(childDir).sort();
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
      expect(readdirSync(childDir).sort()).toEqual(writesAtEnd);
      expect(existsSync(`${statusFile}.term`), 'SIGTERM 确实被忽略过').toBe(true);

      // 确认停止后可再运行（之前被拒的 quick 计划）。
      const { detail: quickDetail } = await context.runTerminal(
        projectId,
        planOf([check('quick', [process.execPath, '--version'])]),
        'authorize',
      );
      expect(quickDetail.operation.status).toBe('completed');
      expect(checkView(quickDetail, 'quick')).toMatchObject({ status: 'passed' });

      // 4) 大输出：超过输出预算 → output_overflow 有界收尾（进程被停止）。
      const largeScript = join(
        fileURLToPath(new URL('./helpers/p02-3/command-scripts/', import.meta.url)),
        'large-output.mjs',
      );
      const { detail: largeDetail } = await context.runTerminal(
        projectId,
        planOf([check('large', [process.execPath, largeScript, '9437184', '0'], { timeoutMs: 60_000 })]),
        'authorize',
        90_000,
      );
      expect(largeDetail.operation.status).toBe('completed');
      expect(largeDetail.operation.reasonCode).toBe('output_overflow');
      expect(checkView(largeDetail, 'large')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'output_overflow',
      });

      // 全部失败/中断运行均不撤销注册。
      const overview = await context.client.getProjectOverview(projectId);
      expect(overview.registration.status).toBe('registered');
    } finally {
      await context.close();
    }
  }, 240_000);

  it('证据写入失败（真实 HTTP 传输面 + 确定性故障注入）：不折算通过、占用保留、新运行拒绝', async () => {
    ensureScripts();
    const root = dataRootOf('fr2-evidence-fault');
    const app = await openCoreApplication({ dataRoot: root, capabilityCatalog: CATALOG });
    openedApps.push(app);
    // 用 dirty 仓库：发布失败按设计保留占用/claim 直至恢复，不能污染后续用例
    // 共享的 withHead 仓库（claim 落在各仓库自己的 .git 内）。
    const registered = await app.projectService.registerRepository({
      repositoryPath: fixture.repos.dirty,
      displayName: 'f018-evidence-fault',
    });
    const projectId = registered.project.id;
    const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
    openedSessions.push(session);
    const faulty = createFaultyArtifactFileStore(app.artifactFileStore, { times: Infinity });
    const execution = createBaselineExecutionService({
      commands: app.commandService,
      atomicStore: createSqliteAtomicCommandStore(session),
      baselines: app.baselineStore,
      state: app.stateStore,
      inspector: app.repositoryInspector,
      workspace: createBaselineWorkspaceReader(),
      processes: createCommandProcessAdapter(),
      artifacts: app.artifactStore,
      files: faulty.store,
      repositoryGuard: createBaselineRepositoryGuard(),
      environmentDirectory: { resolveEnvironmentRef: () => null },
      resolveEnvironment: (names) =>
        Object.fromEntries(
          names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
        ),
    });

    // 真实应用传输面（生产路由/认证/信封），仅注入「输出发布失败」。
    const stubToken = randomBytes(32).toString('hex');
    fixture.evidence.registerSecret(stubToken);
    let lifecycle: 'ready' | 'quiescing' | 'stopping' = 'ready';
    const stopController = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => Promise.resolve(),
      releaseAfterTeardown: () => Promise.resolve(),
    });
    const server = createHostLifecycleServer({
      hostInstanceId: randomUUID(),
      dataRootIdentity: `sha256:${randomBytes(16).toString('hex')}`,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      authToken: stubToken,
      getLifecycleState: () => lifecycle,
      getActivities: () => stopController.getActivities(),
      stop: stopController,
      application: {
        principal: OWNER,
        commandService: app.commandService,
        queryService: app.queryService,
        commandReceiptsService: app.commandReceiptsService,
        onboardingService: app.onboardingService,
        baselineQueryService: app.baselineQueryService,
        baselineExecutionService: execution,
        getLifecycleState: () => lifecycle,
      },
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    openedServers.push(() =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
    );
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('传输面监听地址非法');
    }
    const port = address.port;
    const token = stubToken;
    const post = (body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token, body });

    // 预览 → 获准运行：进程真实执行，但输出发布持续失败。
    const plan = planOf([
      check('a-ok', [process.execPath, '-e', 'process.stdout.write("evidence-fault-ok")']),
      check('b-next', [process.execPath, '--version']),
    ]);
    const previewResponse = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId }, { plan }),
    );
    expect(previewResponse.statusCode).toBe(200);
    const previewDigest = (
      (previewResponse.json() as { result: { previewDigest: string } }).result
    ).previewDigest;
    const runResponse = await post(
      commandEnvelope(
        'baseline.run',
        { kind: 'project', projectId },
        { decision: 'authorize', plan, previewDigest },
      ),
    );
    expect(runResponse.statusCode).toBe(202);
    const operationId = (runResponse.json() as { operationId: string }).operationId;

    // 有界等到非终态停住（证据缺口门槛：运行保持 running，绝不折算 passed/completed）。
    const getDetail = () =>
      loopbackRequest({ port, method: 'GET', path: `/v1/baselines/${operationId}`, token });
    const detail = await waitFor(async () => {
      const response = await getDetail();
      if (response.statusCode !== 200) {
        return undefined;
      }
      const body = response.json() as BaselineDetail;
      return body.operation.status === 'running' && body.operation.reasonCode === 'evidence_incomplete'
        ? body
        : undefined;
    }, 30_000);
    expect(detail.checks.map((entry) => [entry.checkKey, entry.status, entry.reasonCode])).toEqual([
      ['a-ok', 'inconclusive', 'evidence_incomplete'],
      ['b-next', 'not_run', 'evidence_incomplete'],
    ]);

    // 占用保留（发布失败可重试恢复，绝不静默放行新运行）。
    const probe = probeOf(root);
    try {
      expect(
        probe.selectOne<{ holder_operation_id: string }>(
          'SELECT holder_operation_id FROM baseline_occupancy WHERE id = ?',
          ['global'],
        ),
      ).toMatchObject({ holder_operation_id: operationId });
    } finally {
      probe.close();
    }
    const busyResponse = await post(
      commandEnvelope(
        'baseline.run',
        { kind: 'project', projectId },
        {
          decision: 'authorize',
          plan: planOf([check('retry', [process.execPath, '--version'])]),
          previewDigest: (
            (
              await post(
                commandEnvelope(
                  'baseline.preview',
                  { kind: 'project', projectId },
                  { plan: planOf([check('retry', [process.execPath, '--version'])]) },
                ),
              )
            ).json() as { result: { previewDigest: string } }
          ).result.previewDigest,
        },
      ),
    );
    expect(busyResponse.statusCode).toBe(409);
    expect(errorOf(busyResponse).code).toBe('resource_busy');

    // 注册不受影响（失败不撤销注册）。
    const overviewResponse = await loopbackRequest({
      port,
      method: 'GET',
      path: `/v1/projects/${projectId}/overview`,
      token,
    });
    expect(overviewResponse.statusCode).toBe(200);
    expect(
      (overviewResponse.json() as { registration: { status: string } }).registration.status,
    ).toBe('registered');
  }, 120_000);
});

/* ================================================================== *
 * C. FR-3 并发与授权边界（两客户端/竞争/重放/过期/取消竞争/越权/源码变化）
 * ================================================================== */

describe('F-018 FR-3：并发与授权边界（同数据根唯一 Host + 单次启动 + 幂等/过期/越权）', () => {
  it('两客户端同数据根唯一 Host；竞争基线单次启动；重放沿用原操作、不同摘要冲突、过期授权零副作用', async () => {
    ensureScripts();
    const repos = fixture.repos;
    const root = dataRootOf('fr3-clients-race');

    // 两 CLI 客户端（独立执行层调用）同一数据根：唯一 Host，实例不变。
    const firstInit = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '竞争项目',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const firstResult = okResultOf(firstInit, 'project.init');
    const projectId = (firstResult.registration as { projectId: string }).projectId;
    const discoveryFirst = readDiscovery(root);
    const secondOverview = await runApp([
      'project',
      'overview',
      projectId,
      '--data-root',
      root,
      '--json',
    ]);
    expect(okResultOf(secondOverview, 'project.overview').registration).toMatchObject({
      status: 'registered',
    });
    expect(readDiscovery(root).hostInstanceId).toBe(discoveryFirst.hostInstanceId);
    // CLI「退出」后 Host 子进程仍存活（Host 生命周期独立于客户端）。
    expect(pidAlive(discoveryFirst.pid)).toBe(true);

    const context = await startHostContext(root);
    try {
      // 并发竞争（同步屏障）：两路获准提交 → 恰一路 202 accepted 启动，
      // 另一路 409 resource_busy；真实进程只启动一次（计数文件恰一行）。
      const counterFile = join(fixture.root, `fr3-counter-${randomUUID().slice(0, 8)}`);
      const releaseFile = join(fixture.root, `fr3-release-${randomUUID().slice(0, 8)}`);
      const racePlan = planOf([
        check('single-launch', [process.execPath, counterHangScript, counterFile, releaseFile], {
          timeoutMs: 300_000,
        }),
      ]);
      const racePreview = await context.preview(projectId, racePlan);
      // 固定两路信封身份（commandId + issuedAt 冻结），胜者信封稍后原样重放。
      const identityA = { commandId: randomUUID(), issuedAt: new Date().toISOString() };
      const identityB = { commandId: randomUUID(), issuedAt: new Date().toISOString() };
      const envelopeOf = (identity: { commandId: string; issuedAt: string }) =>
        commandEnvelope(
          'baseline.run',
          { kind: 'project', projectId },
          { decision: 'authorize', plan: racePlan, previewDigest: racePreview.previewDigest },
          { commandId: identity.commandId, issuedAt: identity.issuedAt },
        );
      const [outcomeA, outcomeB] = await Promise.all([
        postEnvelope(context, envelopeOf(identityA)),
        postEnvelope(context, envelopeOf(identityB)),
      ]);
      const statuses = [outcomeA.statusCode, outcomeB.statusCode].sort();
      expect(statuses).toEqual([202, 409]);
      const winner = outcomeA.statusCode === 202 ? outcomeA : outcomeB;
      const loser = outcomeA.statusCode === 202 ? outcomeB : outcomeA;
      const winnerIdentity = outcomeA.statusCode === 202 ? identityA : identityB;
      const raceOperationId = (winner.json() as { operationId: string }).operationId;
      expect(errorOf(loser).code).toBe('resource_busy');
      await waitFor(() => (existsSync(counterFile) ? readFileSync(counterFile, 'utf8') : undefined), 30_000);
      expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1);

      // 相同命令重放（胜者信封原样）：在途期间 → 重放 accepted 回执、沿用原操作。
      const replayInFlight = await postEnvelope(context, envelopeOf(winnerIdentity));
      expect(replayInFlight.statusCode).toBe(202);
      const replayReceiptInFlight = replayInFlight.json() as {
        operationId: string;
        replayed: boolean;
        status: string;
      };
      expect(replayReceiptInFlight.replayed).toBe(true);
      expect(replayReceiptInFlight.operationId).toBe(raceOperationId);
      expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1);

      writeFileSync(releaseFile, 'release');
      const raceDetail = await waitForBaselineTerminal(context, raceOperationId, 60_000);
      expect(raceDetail.operation.status).toBe('completed');
      // 终态后重放同一信封：仍重放原回执，不二次启动。
      const replayAfterTerminal = await postEnvelope(context, envelopeOf(winnerIdentity));
      expect(replayAfterTerminal.statusCode).toBe(202);
      const replayReceipt = replayAfterTerminal.json() as { operationId: string; replayed: boolean };
      expect(replayReceipt.replayed).toBe(true);
      expect(replayReceipt.operationId).toBe(raceOperationId);
      expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(1);

      // 不同摘要（不同计划）+ 同 commandId → 409 conflict，零副作用。
      const otherPlan = planOf([check('other', [process.execPath, '--version'])]);
      const conflict = await postEnvelope(
        context,
        commandEnvelope(
          'baseline.run',
          { kind: 'project', projectId },
          { decision: 'authorize', plan: otherPlan, previewDigest: racePreview.previewDigest },
          { commandId: winnerIdentity.commandId },
        ),
      );
      expect(conflict.statusCode).toBe(409);
      expect(errorOf(conflict).code).toBe('conflict');

      // 过期授权：expiresAt 已过 → 400 command_expired，零基线副作用。
      const expiredPlan = planOf([check('expired', [process.execPath, '--version'])]);
      const expiredPreview = await context.preview(projectId, expiredPlan);
      const expired = await postEnvelope(
        context,
        commandEnvelope(
          'baseline.run',
          { kind: 'project', projectId },
          { decision: 'authorize', plan: expiredPlan, previewDigest: expiredPreview.previewDigest },
          // issuedAt 在允许时钟偏差内、expiresAt 晚于 issuedAt 且寿命 ≤300s，但已过期。
          {
            issuedAt: new Date(Date.now() - 30_000).toISOString(),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ),
      );
      expect(expired.statusCode).toBe(400);
      expect(errorOf(expired).code).toBe('command_expired');
      const probe = probeOf(root);
      try {
        expect(
          probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_operations'),
        ).toMatchObject({ n: 1 });
      } finally {
        probe.close();
      }
    } finally {
      await context.close();
    }
  }, 180_000);

  it('取消与完成竞争终态一致；迟到取消不改写；preview 后源码变化 → preview_stale；运行期源码变化保留改动', async () => {
    ensureScripts();
    const context = await startHostContext(dataRootOf('fr3-cancel-source'));
    try {
      const projectId = await context.registerProject(fixture.repos.withHead, 'f018-cancel-source');

      // 取消与完成竞争：快速检查 + 立即取消 → 终态非 completed 即 cancelled，
      // 且操作行/检查行/占用三处一致；迟到取消不改写已终态结果。
      const quickPlan = planOf([
        check('quick-race', [
          process.execPath,
          '-e',
          'setTimeout(() => { process.stdout.write("race-done"); process.exit(0); }, 700)',
        ]),
      ]);
      const quickPreview = await context.preview(projectId, quickPlan);
      const accepted = await context.run(projectId, quickPlan, quickPreview.previewDigest, 'authorize');
      if (accepted.status !== 'accepted') {
        throw new Error(`预期 accepted 回执，实际 ${accepted.status}`);
      }
      const raceOperationId = accepted.operationId;
      const cancelReceipt = await context.client.cancelBaseline(projectId, raceOperationId);
      const terminal = await waitForBaselineTerminal(context, raceOperationId, 60_000);
      expect(['completed', 'cancelled']).toContain(terminal.operation.status);
      if (cancelReceipt.status !== 'completed') {
        throw new Error(`取消命令未完成：${cancelReceipt.status}`);
      }
      // 取消回执永不提前声称已停：取消丢失竞争时回答实际终态。
      expect(['cancelling', 'cancelled', 'completed']).toContain(
        (cancelReceipt.result as { status: string }).status,
      );
      // 迟到取消（终态后再次取消）：幂等回答终态，不改写行。
      const lateCancel = await context.client.cancelBaseline(projectId, raceOperationId);
      if (lateCancel.status !== 'completed') {
        throw new Error(`迟到取消未完成：${lateCancel.status}`);
      }
      expect((lateCancel.result as { status: string }).status).toBe(terminal.operation.status);
      const afterLate = await fetchBaselineDetail(context, raceOperationId);
      expect(afterLate.operation.status).toBe(terminal.operation.status);
      const probe = probeOf(context.root);
      try {
        expect(
          probe.selectOne<{ holder_operation_id: string | null }>(
            'SELECT holder_operation_id FROM baseline_occupancy WHERE id = ?',
            ['global'],
          )?.holder_operation_id,
        ).toBeNull();
      } finally {
        probe.close();
      }

      // preview 后源码变化：旧 previewDigest 授权 → 409 preview_stale，零授权/零启动。
      const stalePlan = planOf([check('stale', [process.execPath, '--version'])]);
      const stalePreview = await context.preview(projectId, stalePlan);
      const lateChange = join(fixture.repos.withHead, `f018-late-${randomUUID().slice(0, 8)}.txt`);
      try {
        writeFileSync(lateChange, 'late change\n', 'utf8');
        const staleRun = await postEnvelope(
          context,
          commandEnvelope(
            'baseline.run',
            { kind: 'project', projectId },
            { decision: 'authorize', plan: stalePlan, previewDigest: stalePreview.previewDigest },
          ),
        );
        expect(staleRun.statusCode).toBe(409);
        expect(errorOf(staleRun).code).toBe('conflict');
        expect(errorOf(staleRun).details).toMatchObject({ reason: 'preview_stale' });
        const staleProbe = probeOf(context.root);
        try {
          // 只有此前 quick-race 的一条授权；preview_stale 尝试零新增授权/零启动。
          expect(
            staleProbe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_authorizations'),
          ).toMatchObject({ n: 1 });
        } finally {
          staleProbe.close();
        }
      } finally {
        // 清理临时改动，恢复受检工作区原状（下一次预览可重新取摘要）。
        require('node:fs').rmSync(lateChange);
      }

      // 运行期源码变化：检查自身写入受检仓库 → source_changed，不折算通过且改动保留。
      const mutationTarget = join(fixture.repos.withHead, `f018-mutated-${randomUUID().slice(0, 8)}.ts`);
      const mutatedPlan = planOf([
        check('mutator', [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(mutationTarget)}, 'mutated\\n'); process.stdout.write('mutated-ok')`,
        ]),
      ]);
      const { detail: mutatedDetail } = await context.runTerminal(projectId, mutatedPlan, 'authorize');
      expect(mutatedDetail.operation.status).toBe('completed');
      expect(mutatedDetail.operation.reasonCode).toBe('source_changed');
      expect(checkView(mutatedDetail, 'mutator')).toMatchObject({
        status: 'inconclusive',
        reasonCode: 'source_changed',
      });
      expect(readFileSync(mutationTarget, 'utf8')).toBe('mutated\n');
      // 前后代码身份都持久在 baseline-summary（改动保留、从不回滚）。
      const probeFinal = probeOf(context.root);
      try {
        // 前后代码身份持久在 baseline-summary（改动保留、从不回滚）。
        const summaries = probeFinal.selectOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'baseline-summary' AND status = 'ready'",
        );
        expect((summaries?.n ?? 0)).toBeGreaterThan(0);
      } finally {
        probeFinal.close();
      }
      require('node:fs').rmSync(mutationTarget);
    } finally {
      await context.close();
    }
  }, 150_000);

  it('越权与非法输入：跨项目操作/证据 not_found；cwd 逃逸与伪环境引用拒绝且零副作用', async () => {
    ensureScripts();
    const root = dataRootOf('fr3-escalation');
    const app = await openCoreApplication({ dataRoot: root, capabilityCatalog: CATALOG });
    openedApps.push(app);
    const projectA = (
      await app.projectService.registerRepository({
        repositoryPath: fixture.repos.cloneA,
        displayName: '越权 A',
      })
    ).project.id;
    const projectB = (
      await app.projectService.registerRepository({
        repositoryPath: fixture.repos.cloneB,
        displayName: '越权 B',
      })
    ).project.id;

    // 受限主体：只可见项目 A（可信测试装配构造，产品无网络提权入口）。
    const restricted = createRestrictedPrincipal({
      capabilities: ['project.read', 'baseline.read', 'baseline.run', 'receipts.read'],
      projectScope: scopeAllowlist([projectA]),
    });
    const stubToken = randomBytes(32).toString('hex');
    fixture.evidence.registerSecret(stubToken);
    let lifecycle: 'ready' | 'quiescing' | 'stopping' = 'ready';
    const stopController = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: (next) => {
        lifecycle = next;
      },
      prepareTeardown: () => Promise.resolve(),
      releaseAfterTeardown: () => Promise.resolve(),
    });
    const server = createHostLifecycleServer({
      hostInstanceId: randomUUID(),
      dataRootIdentity: `sha256:${randomBytes(16).toString('hex')}`,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      authToken: stubToken,
      getLifecycleState: () => lifecycle,
      getActivities: () => stopController.getActivities(),
      stop: stopController,
      application: {
        principal: restricted,
        commandService: app.commandService,
        queryService: app.queryService,
        commandReceiptsService: app.commandReceiptsService,
        onboardingService: app.onboardingService,
        baselineQueryService: app.baselineQueryService,
        baselineExecutionService: app.baselineExecutionService,
        getLifecycleState: () => lifecycle,
      },
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    openedServers.push(() =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
    );
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new Error('传输面监听地址非法');
    }
    const port = address.port;
    const token = stubToken;
    const post = (body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token, body });
    const get = (path: string) => loopbackRequest({ port, method: 'GET', path, token });

    // 项目 A：获准运行成功（受限主体在自己的可见范围内正常工作）。
    const planA = planOf([check('a-pass', [process.execPath, '-e', 'process.stdout.write("escalation-ok")'])]);
    const previewA = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, { plan: planA }),
    );
    expect(previewA.statusCode).toBe(200);
    const runA = await post(
      commandEnvelope(
        'baseline.run',
        { kind: 'project', projectId: projectA },
        {
          decision: 'authorize',
          plan: planA,
          previewDigest: (previewA.json() as { result: { previewDigest: string } }).result.previewDigest,
        },
      ),
    );
    expect(runA.statusCode).toBe(202);
    const operationA = (runA.json() as { operationId: string }).operationId;
    const artifactId = await waitFor(async () => {
      const detailResponse = await get(`/v1/baselines/${operationA}`);
      if (detailResponse.statusCode !== 200) {
        return undefined;
      }
      const detail = detailResponse.json() as BaselineDetail;
      if (!['accepted', 'running', 'cancelling'].includes(detail.operation.status)) {
        const output = detail.checks[0]?.output ?? null;
        return output !== null && output.artifactId.length > 0 ? output.artifactId : undefined;
      }
      return undefined;
    }, 30_000);

    // 跨项目：受限主体查 B 的项目 overview → 403 forbidden（不区分不可见/不存在）。
    expect((await get(`/v1/projects/${projectB}/overview`)).statusCode).toBe(403);

    // B 项目在 owner 侧先产生一条真实操作与证据，再以受限主体访问。
    const planB = planOf([check('b-owner', [process.execPath, '-e', 'process.stdout.write("b-ok")'])]);
      const ownerPreview = await app.baselineService.previewBaseline(OWNER, projectB, { plan: planB });
      const receiptB = await app.baselineExecutionService.submit(OWNER, {
        schemaVersion: 4,
        commandId: randomUUID(),
        operation: 'baseline.run',
        scope: { kind: 'project', projectId: projectB },
        issuedAt: new Date().toISOString(),
        payload: { decision: 'authorize', plan: planB, previewDigest: ownerPreview.previewDigest },
      });
      if (receiptB.status !== 'accepted') {
        throw new Error(`B 项目运行未被接受：${receiptB.status}`);
      }
      await app.baselineExecutionService.waitForIdle();
      expect((await get(`/v1/baselines/${receiptB.operationId}`)).statusCode).toBe(404);
      const outputB = app.baselineStore
        .listBaselineCheckResults(receiptB.operationId)
        .find((row) => row.checkKey === 'b-owner');
      expect(outputB?.outputArtifactId).toBeTruthy();
      expect(
        (await get(`/v1/artifacts/${outputB?.outputArtifactId}/content`)).statusCode,
      ).toBe(404);

    // 证据越权（对受限主体可见项目之外的制品）——A 的制品对 A 可见，构造性对拍：
    expect((await get(`/v1/artifacts/${artifactId}/content`)).statusCode).toBe(200);

    // cwd 逃逸与伪环境引用：预览阶段拒绝（fail-closed），零授权/操作副作用。
    const escapePlan = planOf([
      check('escape-cwd', [process.execPath, '--version'], { cwdRef: '../outside' }),
    ]);
    const escapePreview = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, { plan: escapePlan }),
    );
    expect(escapePreview.statusCode).toBe(400);
    expect(errorOf(escapePreview).code).toBe('invalid_input');
    const envPlan = planOf([
      check('fake-env', [process.execPath, '--version'], { environmentRef: 'not-authorized-env' }),
    ]);
    const envPreview = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, { plan: envPlan }),
    );
    expect(envPreview.statusCode).toBe(400);
    const probe = probeOf(root);
    try {
      // A 获准 + B owner 获准各一条授权/操作；cwd 逃逸与伪环境引用零新增。
      expect(
        probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_authorizations'),
      ).toMatchObject({ n: 2 });
      expect(
        probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM baseline_operations'),
      ).toMatchObject({ n: 2 });
    } finally {
      probe.close();
    }
  }, 120_000);
});

/* ================================================================== *
 * D. FR-4 停止与崩溃恢复（真实 stop/SIGKILL + 历史可查 + 可再运行）
 * ================================================================== */

describe('F-018 FR-4：停止与崩溃恢复', () => {
  it('显式 host stop → 重启：注册/历史检查/证据/拒绝记录照常可查，占用释放后可再运行', async () => {
    ensureScripts();
    const repos = fixture.repos;
    const root = dataRootOf('fr4-stop-restart');

    const init = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '恢复项目',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const projectId = (okResultOf(init, 'project.init').registration as { projectId: string }).projectId;
    const marker = `fr4-restart-evidence-${String(Math.floor(Math.random() * 900000) + 100000)}`;
    const passPlanFile = join(fixture.root, `fr4-plan-${randomUUID().slice(0, 8)}.json`);
    const declinedPlanFile = join(fixture.root, `fr4-declined-${randomUUID().slice(0, 8)}.json`);
    const writePlanFile = (file: string, checks: readonly CheckSpec[]): void => {
      writeFileSync(file, JSON.stringify({ checks: checks.map((entry) => ({ ...entry })) }));
    };
    writePlanFile(passPlanFile, [check('restart-ok', [process.execPath, '-e', `process.stdout.write(${JSON.stringify(marker)})`])]);
    writePlanFile(declinedPlanFile, [check('restart-declined', [process.execPath, '--version'])]);

    // 获准运行（--wait 终态）+ 拒绝记录（持久 not_run）。
    const run = await runApp([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      passPlanFile,
      '--confirm',
      '--wait',
      '--data-root',
      root,
      '--json',
    ]);
    const runResult = okResultOf(run, 'baseline.run');
    expect(runResult.state).toBe('passed');
    const operationId = runResult.operationId as string;
    const artifactId = (
      (runResult.checks as { output: { artifactId: string } }[])[0] as { output: { artifactId: string } }
    ).output.artifactId;
    const declined = await runApp([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      declinedPlanFile,
      '--decline',
      '--data-root',
      root,
      '--json',
    ]);
    const declinedResult = okResultOf(declined, 'baseline.run');
    expect(declinedResult.state).toBe('not_run');
    const declinedId = declinedResult.operationId as string;

    // 显式 stop（产品 Host CLI 命令）：Host 进程退出、发现移除。
    const instanceBefore = readDiscovery(root).hostInstanceId;
    const pidBefore = readDiscovery(root).pid;
    const stopIo = collectIo();
    const stop = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: stopIo.io as HostCliIo,
      env: {},
    });
    expect(stop.exitCode, stopIo.stderr()).toBe(0);
    const stopEnvelope = JSON.parse(stopIo.stdout()) as {
      ok: boolean;
      command: string;
      result: { status: string };
    };
    expect(stopEnvelope.command).toBe('host.stop');
    expect(stopEnvelope.result.status).toBe('stopped');
    await waitForPidGone(pidBefore, 15_000);

    // 重启（业务命令自动拉起新实例）：历史检查/证据/拒绝记录/注册照常可查。
    const detail = await runApp(['baseline', 'status', operationId, '--data-root', root, '--json']);
    const detailResult = okResultOf(detail, 'baseline.status');
    expect(detailResult.state).toBe('passed');
    const evidence = await runApp(['baseline', 'evidence', artifactId, '--data-root', root, '--json']);
    expect(okResultOf(evidence, 'baseline.evidence').content as string).toContain(marker);
    const declinedAfter = await runApp(['baseline', 'status', declinedId, '--data-root', root, '--json']);
    expect(okResultOf(declinedAfter, 'baseline.status').status).toBe('not_run');
    const overview = await runApp(['project', 'overview', projectId, '--data-root', root, '--json']);
    const overviewResult = okResultOf(overview, 'project.overview');
    expect(overviewResult.registration).toMatchObject({ status: 'registered' });
    expect(readDiscovery(root).hostInstanceId).not.toBe(instanceBefore);

    // 占用已释放：可再运行一次新基线。
    const againPlanFile = join(fixture.root, `fr4-again-${randomUUID().slice(0, 8)}.json`);
    writePlanFile(againPlanFile, [check('restart-again', [process.execPath, '-e', 'process.stdout.write("again-ok")'])]);
    const again = await runApp([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      againPlanFile,
      '--confirm',
      '--wait',
      '--data-root',
      root,
      '--json',
    ]);
    expect(okResultOf(again, 'baseline.run').state).toBe('passed');
  }, 240_000);

  it('SIGKILL 崩溃：新实例恢复核对旧进程（真实 pid 死亡）；interrupted 可查；原命令不重放启动；可再运行', async () => {
    ensureScripts();
    const repos = fixture.repos;
    const root = dataRootOf('fr4-crash');

    const init = await runApp([
      'project',
      'init',
      repos.withHead,
      '--name',
      '崩溃恢复项目',
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const projectId = (okResultOf(init, 'project.init').registration as { projectId: string }).projectId;
    const counterFile = join(fixture.root, `fr4-crash-counter-${randomUUID().slice(0, 8)}`);
    const planFile = join(fixture.root, `fr4-crash-plan-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(
      planFile,
      JSON.stringify({
        checks: [
          {
            checkKey: 'crash-hang',
            kind: 'command',
            argv: [process.execPath, counterHangScript, counterFile, join(fixture.root, 'never-released')],
            timeoutMs: 300_000,
            required: true,
          },
        ],
      }),
    );

    // 直接经真实 HostClient 提交获准运行（不经 CLI --wait：CLI 失败重试会自动
    // 重启 Host 并提前触发恢复，掩盖「崩溃时检查进程仍在运行」的现场）。
    const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { checks: CheckSpec[] };
    const client = await connectToHost({ canonicalRoot: root, timeouts: CLIENT_TIMEOUTS });
    let operationId = '';
    try {
      const previewReceipt = await client.previewBaseline({ projectId, plan });
      if (previewReceipt.status !== 'completed') {
        throw new Error(`预览未完成：${previewReceipt.status}`);
      }
      const runReceipt = await client.runBaseline({
        projectId,
        decision: 'authorize',
        plan,
        previewDigest: (previewReceipt.result as { previewDigest: string }).previewDigest,
      });
      if (runReceipt.status !== 'accepted') {
        throw new Error(`预期 accepted 回执，实际 ${runReceipt.status}`);
      }
      operationId = runReceipt.operationId;
    } finally {
      client.close();
    }

    const crashedPidLine = await waitFor(
      () => (existsSync(counterFile) ? readFileSync(counterFile, 'utf8').trim() : undefined),
      30_000,
    );
    const crashedPid = Number.parseInt(crashedPidLine.split('\n')[0] as string, 10);
    const hostPid = readDiscovery(root).pid;
    expect(pidAlive(hostPid)).toBe(true);
    expect(pidAlive(crashedPid)).toBe(true);
    // SIGKILL Host 子进程（真实崩溃，非优雅停止）。受监督命令随后由独立 supervisor
    // 按 IPC 失联走同一有界停止路径（F-010 设计：不遗留无主进程），属预期行为。
    process.kill(hostPid, 'SIGKILL');
    await waitForPidGone(hostPid, 15_000);

    // 重启：新实例获锁后恢复 —— 升级停止旧进程、落 interrupted、释放占用/claim。
    const statusAfterCrash = await runApp([
      'baseline',
      'status',
      operationId,
      '--data-root',
      root,
      '--json',
    ]);
    const statusResult = okResultOf(statusAfterCrash, 'baseline.status');
    expect(statusResult.status).toBe('interrupted');
    expect(statusResult.reasonCode).toBe('restart_recovery');
    // §12.2 八态分类：interrupted 归入 failed 档（不折算成功，也不冒充完成）。
    expect(statusResult.state).toBe('failed');
    await waitForPidGone(crashedPid, 30_000);
    expect(existsSync(join(repos.withHead, '.git', 'shiploop-baseline.claim'))).toBe(false);
    const probe = probeOf(root);
    try {
      expect(
        probe.selectOne<{ holder_operation_id: string | null }>(
          'SELECT holder_operation_id FROM baseline_occupancy WHERE id = ?',
          ['global'],
        )?.holder_operation_id,
      ).toBeNull();
      expect(
        probe.selectOne<{ status: string; reason_code: string }>(
          'SELECT status, reason_code FROM baseline_operations WHERE id = ?',
          [operationId],
        ),
      ).toMatchObject({ status: 'interrupted', reason_code: 'restart_recovery' });
    } finally {
      probe.close();
    }

    // 历史可查：崩溃前完成的注册与 interrupted 操作都在。
    const overview = await runApp(['project', 'overview', projectId, '--data-root', root, '--json']);
    expect(okResultOf(overview, 'project.overview').registration).toMatchObject({ status: 'registered' });

    // 可再运行：新基线获准执行（计数恰增一行 → 累计两行，崩溃操作未被重放）。
    const againPlanFile = join(fixture.root, `fr4-crash-again-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(
      againPlanFile,
      JSON.stringify({
        checks: [
          {
            checkKey: 'crash-again',
            kind: 'command',
            argv: [
              process.execPath,
              counterHangScript,
              counterFile,
              join(fixture.root, `fr4-crash-release-${randomUUID().slice(0, 8)}`),
            ],
            timeoutMs: 300_000,
            required: true,
          },
        ],
      }),
    );
    const againRun = await runApp([
      'baseline',
      'run',
      '--project',
      projectId,
      '--input',
      againPlanFile,
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    const againResult = okResultOf(againRun, 'baseline.run');
    const secondOperationId = againResult.operationId as string;
    const secondPid = await waitFor(() => {
      const lines = existsSync(counterFile) ? readFileSync(counterFile, 'utf8').trim().split('\n') : [];
      return lines.length >= 2 ? Number.parseInt(lines[1] as string, 10) : undefined;
    }, 30_000);

    // 显式取消收尾新操作（有界；不遗留挂起检查进程）。
    const cancelOutcome = await runApp([
      'baseline',
      'cancel',
      secondOperationId,
      '--confirm',
      '--data-root',
      root,
      '--json',
    ]);
    expect(okResultOf(cancelOutcome, 'baseline.cancel').operationId).toBe(secondOperationId);
    await waitForPidGone(secondPid, 20_000);
    // 累计恰两行：崩溃的那次 + 新的一次；崩溃操作从未被重放执行。
    expect(readFileSync(counterFile, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 300_000);
});

async function postEnvelope(context: HostContext, envelope: Record<string, unknown>): Promise<LoopbackResponse> {
  return loopbackRequest({
    port: context.port,
    method: 'POST',
    path: '/v1/commands',
    token: context.token,
    body: envelope,
  });
}
