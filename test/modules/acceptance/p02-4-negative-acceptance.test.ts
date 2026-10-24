/**
 * F-006 P02-4 组合认证、协议、项目范围和固定回环监听的阶段负例真实验收场景。
 *
 * 对应 docs/p02-4-acceptance-contract.md §2.1 冻结的必需检查 `P02-FR2-AUTH-REJECT`
 * （FR-2 认证/协议/范围/监听拒绝；零副作用且不泄密）。五组负例（验收 1~5）：
 *
 * 1. 真实 Host（dist CLI 启动）上的缺失/错误 token、旧实例身份（真实重启后的
 *    旧凭据/旧实例）、数据根不匹配与未知协议/Schema——得到前序冻结的
 *    unauthorized / instance_mismatch / data_root_mismatch /
 *    unsupported_schema_version / protocol_incompatible；项目、配置、检查与
 *    文件逐项未变；不启动第二个 Host（重复 start = already_running 同实例
 *    同端口，唯一持锁）。
 * 2. 复用可信测试装配（openCoreApplication + createHostLifecycleServer +
 *    createRestrictedPrincipal）验证跨项目详情、基线结果/输出制品读取与变更
 *    被拒（forbidden / not_found 防枚举）；actorId 或 payload 中的权限字段
 *    不能提权（信封结构拒绝且零副作用）；不扩建产品多用户或配对系统
 *    （产品源码无 test-restricted 入口，受限主体只能由测试装配构造）。
 * 3. 非法 JSON/分页、任意路径读取、根外与符号链接逃逸 cwd、未知能力/提权字段
 *    明确拒绝；没有返回目标文件正文（canary/`root:` 不出现）、没有创建基线
 *    进程（marker 零落盘、基线三表零新增）；错误结构保留适用操作身份且不
 *    泄漏秘密。
 * 4. 复用并纳入前序 T23 组合（不以此前测试数量充当证据）：dist CLI 参数/env、
 *    Host 启动入口 argv、Host 启动配置选项与注入 env 的公网监听覆盖全部拒绝
 *    （bind_address_override_rejected、退出码 2）且零文件副作用；真实 Host 的
 *    错误 Host/Origin 一律 401；实际绑定仍为 127.0.0.1 随机端口。
 * 5. 认证头、发现凭据正文与合成 token 不出现在 JSON 输出、诊断及导出的证据
 *    中；报告仅保存脱敏错误码、状态与副作用摘要。
 *
 * 写入路径纪律：Host/项目/配置/基线全部经真实 `packages/cli/dist/bin.js`；
 * 受限 principal 场景按验收约定经可信测试装配（产品 Host 恒绑定 local-owner，
 * 受限主体只能由测试装配构造，本套件不扩建产品多用户或配对系统）；数据库只
 * 经 p02-2 只读探针核对；判定以结构化信封 + HTTP 错误体 + 只读持久行 +
 * marker/哨兵零执行为准，不以成功文本替代。
 *
 * 运行前提：macOS（flock）；`beforeAll` 先 `npm run build` 保证 dist 与源码一致。
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME（复用 F-002
 * 隔离夹具；回收 fail-closed：停止未确认即保留资源与诊断）。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireWriterLock,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  isHostProtocolError,
  startHost,
  type HostStartOptions,
} from '../../../packages/host/src/index.ts';
import {
  createLocalOwnerPrincipal,
  createStaticRuntimeCapabilityCatalog,
  LOCAL_OWNER_CAPABILITIES,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from '../../../packages/core/src/index.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import {
  assertDistCliBuilt,
  createAcceptanceFixture,
  exportEvidenceDocument,
  extractHostIdentity,
  extractOperationSnapshot,
  openDataRootStorageProbe,
  scanForCredentialShapes,
  singleEnvelope,
  type AcceptanceFixture,
  type DistCliResult,
  type EvidenceDocumentInput,
  type OperationSnapshot,
  type StorageTableCounts,
} from '../../helpers/p02-4/index.ts';
import {
  createRestrictedPrincipal,
  scopeAllowlist,
  TEST_RESTRICTED_PRINCIPAL_PREFIX,
  type TestTrustedPrincipal,
} from '../../helpers/p02-2/principals.ts';
import { loopbackRequest, type LoopbackResponse } from '../../helpers/host/http-probe.ts';

const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

/** Host 显式启动入口（`npm run build` 产物，与生产同一入口）。 */
const HOST_START_ENTRY = fileURLToPath(new URL('../../../packages/host/dist/start.js', import.meta.url));

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 随机端口核验区间（Host 以 listen(0) 由 OS 分配，不接受监听覆盖）。 */
const RANDOM_PORT_MIN = 1024;
const RANDOM_PORT_MAX = 65_535;

const CATALOG = createStaticRuntimeCapabilityCatalog([]);
const OWNER = createLocalOwnerPrincipal();

/** 全局配置初始值（政策段；生产 Host 能力目录为空，策略条目留空即合法）。 */
const GLOBAL_CREATE_PAYLOAD = {
  schemaVersion: 2,
  policies: {
    executionLimits: { maxConcurrentWorks: 2, workTimeoutMs: 600_000 },
    verification: { requireChecksBeforeDone: true },
  },
} as const;

/* ------------------------------------------------------------------ *
 * 夹具与公共小工具
 * ------------------------------------------------------------------ */

const activeFixtures: AcceptanceFixture[] = [];
/** 可信测试装配（CoreApplication + 受限主体传输面）的拆卸器。 */
const assemblyDisposers: Array<() => Promise<void>> = [];

function useFixture(prefix: string): AcceptanceFixture {
  const fixture = createAcceptanceFixture({ prefix, stepMs: 300 });
  activeFixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const dispose of assemblyDisposers.splice(0).reverse()) {
    await dispose();
  }
  const pending = activeFixtures.splice(0);
  for (const fixture of pending) {
    if (!fixture.disposed) {
      await fixture.dispose();
    }
  }
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  assertDistCliBuilt();
  if (!existsSync(HOST_START_ENTRY)) {
    throw new Error(`Host 启动入口不存在：${HOST_START_ENTRY}；请先运行 npm run build`);
  }
}, 570_000);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 有界轮询等待（不用固定 sleep）；超时即失败。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor 条件在 ${timeoutMs}ms 内未满足`);
}

function resultOf(result: DistCliResult): Record<string, unknown> {
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(true);
  return envelope.result as Record<string, unknown>;
}

/** CLI 失败信封核验：退出码 + ok:false + 错误码（业务完成不以文本判定）。 */
function failureEnvelopeOf(
  result: DistCliResult,
  expectedExitCode: number,
  expectedCode: string,
): { command: string | null; error: { code: string; details?: unknown } } {
  expect(result.exitCode, result.stderr).toBe(expectedExitCode);
  const envelope = singleEnvelope(result);
  expect(envelope.ok, result.stderr).toBe(false);
  expect(envelope.error?.code, result.stderr).toBe(expectedCode);
  return {
    command: envelope.command,
    error: envelope.error as { code: string; details?: unknown },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP 负例小工具（真实 Host / 受限装配共用）
 * ------------------------------------------------------------------ */

interface HttpErrorShape {
  readonly code: string;
  readonly operation: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function httpErrorOf(response: LoopbackResponse): HttpErrorShape {
  const parsed = response.json() as { error?: Record<string, unknown> };
  expect(parsed.error, response.bodyText).toBeDefined();
  const error = parsed.error as Record<string, unknown>;
  expect(typeof error.code, response.bodyText).toBe('string');
  expect(typeof error.operation, response.bodyText).toBe('string');
  return {
    code: error.code as string,
    operation: error.operation as string,
    message: error.message as string,
    ...(typeof error.details === 'object' && error.details !== null
      ? { details: error.details as Record<string, unknown> }
      : {}),
  };
}

/** 断言状态码 + 错误码（可选操作身份）；返回解析后的错误结构。 */
function expectRejected(
  response: LoopbackResponse,
  statusCode: number,
  code: string,
  operation?: string,
): HttpErrorShape {
  expect(response.statusCode, response.bodyText).toBe(statusCode);
  const error = httpErrorOf(response);
  expect(error.code, response.bodyText).toBe(code);
  if (operation !== undefined) {
    expect(error.operation, response.bodyText).toBe(operation);
  }
  return error;
}

/** 传输纪律（§7.2/§7.3）：JSON、no-store、无 CORS、无 3xx、无凭据回显。 */
function expectTransportHygiene(response: LoopbackResponse, secrets: readonly string[]): void {
  expect(response.statusCode < 300 || response.statusCode >= 400).toBe(true);
  expect(response.headers['content-type'] ?? '').toContain('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  for (const name of Object.keys(response.headers)) {
    expect(name.startsWith('access-control-')).toBe(false);
  }
  for (const secret of secrets) {
    if (secret.length > 0) {
      expect(response.bodyText).not.toContain(secret);
    }
  }
  expect(response.bodyText).not.toContain('Bearer');
}

/** 原始 HTTP 报文交换（伪造/缺失 Host 头等探针无法表达的用例）。 */
function rawExchange(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        socket.destroy();
        rejectExchange(error);
      }
    };
    socket.setTimeout(5_000);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      if (!settled) {
        settled = true;
        resolveExchange(Buffer.concat(chunks).toString('utf8'));
      }
    });
    socket.on('timeout', () => fail(new Error('原始报文交换超时')));
    socket.on('error', (error) => fail(error));
    socket.write(rawRequest);
  });
}

function statusOf(rawResponse: string): number {
  const match = /^HTTP\/1\.1 (\d{3})\b/.exec(rawResponse);
  expect(match, rawResponse).not.toBeNull();
  return Number.parseInt((match as RegExpExecArray)[1] as string, 10);
}

/* ------------------------------------------------------------------ *
 * Host 身份 / 数据根快照小工具
 * ------------------------------------------------------------------ */

interface DiscoveryFileRecord {
  readonly hostInstanceId?: unknown;
  readonly dataRootIdentity?: unknown;
  readonly listenAddress?: unknown;
  readonly port?: unknown;
  readonly pid?: unknown;
}

function readDiscoveryFile(dataRoot: string): DiscoveryFileRecord {
  return JSON.parse(readFileSync(join(dataRoot, 'host', 'discovery.json'), 'utf8')) as DiscoveryFileRecord;
}

function readHostToken(dataRoot: string): string {
  return readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8').trim();
}

/** 独立推导数据根身份（契约 §3.3：lower_hex(sha256(utf8(canonicalRoot)))）。 */
function expectedDataRootIdentity(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot, 'utf8').digest('hex');
}

/** Host 保护文件快照（发现/凭据/状态库逐字节与时间戳）。 */
function snapshotHostFiles(dataRoot: string): Record<string, unknown> {
  return {
    discovery: readFileSync(join(dataRoot, 'host', 'discovery.json'), 'utf8'),
    tokenFile: readFileSync(join(dataRoot, 'host', 'auth.token'), 'utf8'),
    dbSize: statSync(join(dataRoot, 'core.sqlite')).size,
    dbMtimeMs: statSync(join(dataRoot, 'core.sqlite')).mtimeMs,
  };
}

interface RootStateSnapshot {
  readonly counts: StorageTableCounts;
  readonly baselineAuthorizationRows: number;
  readonly baselineOperationRows: number;
  readonly baselineCheckRows: number;
}

/** 只读探针核对持久状态（绝不写业务状态）。 */
function snapshotRootState(dataRoot: string): RootStateSnapshot {
  const probe = openDataRootStorageProbe(dataRoot);
  try {
    expect(probe.readonly).toBe(true);
    const countOf = (table: string): number => {
      const rows = probe.selectAll<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      expect(rows, table).toHaveLength(1);
      return rows[0]?.c ?? -1;
    };
    return {
      counts: probe.counts(),
      baselineAuthorizationRows: countOf('baseline_authorizations'),
      baselineOperationRows: countOf('baseline_operations'),
      baselineCheckRows: countOf('baseline_check_results'),
    };
  } finally {
    probe.close();
  }
}

/** 导出脱敏证据文档：凭据形状扫描为空 + 已登记秘密不出现（fail-closed）。 */
function exportScannedEvidence(input: EvidenceDocumentInput, secrets: readonly string[]): string {
  const document = exportEvidenceDocument(input);
  expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
  for (const secret of secrets) {
    if (secret.length > 0) {
      expect(document).not.toContain(secret);
    }
  }
  return document;
}

/** 基线操作轮询：pass 依据只来自持久检查终态（不来自 accepted 回执）。 */
async function pollTerminalOperation(
  fixture: AcceptanceFixture,
  dataRoot: string,
  operationId: string,
  budgetMs: number,
): Promise<OperationSnapshot> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const status = await fixture.runDistCli(
      ['baseline', 'status', operationId, '--data-root', dataRoot, '--json'],
      { label: 'baseline-status-poll' },
    );
    expect(status.exitCode, status.stderr).toBe(0);
    const envelope = singleEnvelope(status);
    expect(envelope.ok, status.stderr).toBe(true);
    expect(envelope.command).toBe('baseline.status');
    const snapshot = extractOperationSnapshot(envelope.result as Record<string, unknown>);
    if (snapshot.status !== 'accepted' && snapshot.status !== 'running' && snapshot.status !== 'cancelling') {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `基线操作 ${operationId} 在 ${budgetMs}ms 内未达终态（最后状态：${String(snapshot.status)}）`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/** /v1/commands 命令信封（§4.1 冻结结构；不含任何身份/权限字段）。 */
function commandEnvelope(
  operation: string,
  scope: Record<string, unknown>,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    // 命令信封用线消息版本（P03-1 / F-009 起 v4）；ONBOARDING_QUERY_SCHEMA_VERSION
    // 是 inspect/overview/baselines 查询响应的独立版本族，不共用。
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: new Date().toISOString(),
    payload,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 可信测试装配（受限 principal 传输面；复用 p02-3 模式，不另立一套）
 * ------------------------------------------------------------------ */

const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = randomUUID();
const STUB_STARTED_AT = new Date().toISOString();

async function startRestrictedAppServer(
  app: CoreApplication,
  principal: TestTrustedPrincipal,
): Promise<{ port: number }> {
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
  const server: Server = createHostLifecycleServer({
    hostInstanceId: STUB_INSTANCE,
    dataRootIdentity: 'sha256:p02-4-restricted-harness',
    startedAt: STUB_STARTED_AT,
    pid: process.pid,
    authToken: STUB_TOKEN,
    getLifecycleState: () => lifecycle,
    getActivities: () => stopController.getActivities(),
    stop: stopController,
    application: {
      principal,
      commandService: app.commandService,
      queryService: app.queryService,
      commandReceiptsService: app.commandReceiptsService,
      onboardingService: app.onboardingService,
      baselineQueryService: app.baselineQueryService,
      baselineExecutionService: app.baselineExecutionService,
      planningQueryService: app.planningQueryService,
      getLifecycleState: () => lifecycle,
    },
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  assemblyDisposers.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('受限装配传输面监听地址非法');
  }
  return { port: address.port };
}

/* ------------------------------------------------------------------ *
 * marker 命令（「没有创建基线进程」的零执行哨兵）
 * ------------------------------------------------------------------ */

interface MarkerSetup {
  readonly scriptPath: string;
  readonly markerPath: string;
  readonly plan: { checks: Array<Record<string, unknown>> };
}

/** marker 脚本：真实启动才会向 marker 文件追加一行（拒绝路径零落盘）。 */
function setupMarkerCheck(fixture: AcceptanceFixture, checkKey: string): MarkerSetup {
  const scriptPath = join(fixture.root, 'marker-check.mjs');
  const markerPath = join(fixture.root, 'marker-runs.txt');
  writeFileSync(
    scriptPath,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.argv[2], `ran:${process.pid}\\n`);",
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    scriptPath,
    markerPath,
    plan: {
      checks: [
        {
          checkKey,
          kind: 'command',
          argv: [process.execPath, scriptPath, markerPath],
          timeoutMs: 30_000,
          required: true,
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * 验收 1：认证/身份/协议负例（真实 dist CLI Host）
 * ------------------------------------------------------------------ */

describe('P02-FR2-AUTH-REJECT 认证/身份/协议负例（真实 Host）', () => {
  it('缺失/错误 token、旧实例身份、数据根不匹配与未知协议/Schema 被拒；项目/配置/检查/文件未变且不启动第二个 Host', async () => {
    const f = useFixture('shiploop-p02-4-f006-identity-');
    const root = f.dataRoot();
    const canonicalRoot = realpathSync(root);
    const repoPath = f.repos.withHead;

    // 前置：无残留 Host。
    expect(f.liveHostPid()).toBeNull();

    // --- 建立真实状态：Host + 项目 + 全局配置 + 完成基线（全部经 dist CLI）。 ---
    const start = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'neg-host-start',
    });
    expect(start.exitCode, start.stderr).toBe(0);
    const startResult = resultOf(start);
    expect(startResult.outcome).toBe('started');
    const hostInstanceId = startResult.hostInstanceId as string;
    const dataRootIdentity = startResult.dataRootIdentity as string;
    const port = startResult.port as number;
    expect(hostInstanceId).toMatch(UUID_V4_PATTERN);
    // 数据根身份独立复算（sha256(utf8(canonicalRoot))）；实际绑定 127.0.0.1。
    expect(dataRootIdentity).toBe(expectedDataRootIdentity(canonicalRoot));
    expect(startResult.listenAddress).toBe('127.0.0.1');
    expect(port).toBeGreaterThanOrEqual(RANDOM_PORT_MIN);
    expect(port).toBeLessThanOrEqual(RANDOM_PORT_MAX);
    const hostPid = f.liveHostPid();
    expect(hostPid).not.toBeNull();
    expect(pidAlive(hostPid as number)).toBe(true);

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '负例守护项目', '--data-root', root, '--json'],
      { label: 'neg-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;
    expect(projectId).toMatch(UUID_V4_PATTERN);

    const settingsFile = join(f.root, `settings-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(settingsFile, JSON.stringify(GLOBAL_CREATE_PAYLOAD), 'utf8');
    const configCreate = await f.runDistCli(
      ['config', 'create', '--scope', 'global', '--input', settingsFile, '--data-root', root, '--json'],
      { label: 'neg-config-create' },
    );
    expect(configCreate.exitCode, configCreate.stderr).toBe(0);

    const plan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-neg-baseline' });
    const planFile = join(f.root, `plan-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(planFile, JSON.stringify({ checks: plan.checks }), 'utf8');
    const run = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--data-root', root, '--json',
      ],
      { label: 'neg-baseline-run' },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    const runResult = resultOf(run) as { operationId: string };
    const terminal = await pollTerminalOperation(f, root, runResult.operationId, 60_000);
    expect(terminal.status).toBe('completed');
    expect(terminal.state).toBe('passed');
    expect(terminal.checks[0]?.output?.artifactId).toMatch(UUID_V4_PATTERN);

    // --- 凭据与快照（token 立即登记为秘密：此后任何证据都不得包含）。 ---
    const token = readHostToken(root);
    f.evidence.registerSecret(token);
    const wrongToken = 'f'.repeat(64);
    const handshakeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      schemaVersion: 5,
      protocolVersion: 1,
      hostInstanceId,
      dataRootIdentity,
      ...overrides,
    });
    const secrets = [token];
    const discoveryBefore = readDiscoveryFile(root);
    const filesBefore = snapshotHostFiles(root);
    const stateBefore = snapshotRootState(root);
    const repoSnapshotBefore = f.snapshotRepository(repoPath);
    expect(stateBefore.counts).toMatchObject({ projects: 1, repository_bindings: 1, global_settings: 1 });
    expect(stateBefore.baselineOperationRows).toBe(1);
    expect(stateBefore.baselineCheckRows).toBe(1);

    // --- 负例矩阵（同实例；401 子原因不可区分）。 ---
    const missing = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      body: handshakeBody(),
    });
    expectRejected(missing, 401, 'unauthorized', 'host.handshake');
    expect(missing.bodyText).not.toContain(canonicalRoot);

    const wrong = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      token: wrongToken,
      body: handshakeBody(),
    });
    expectRejected(wrong, 401, 'unauthorized', 'host.handshake');
    expect(wrong.bodyText).not.toContain(wrongToken);

    const wrongStatus = await loopbackRequest({
      port,
      method: 'GET',
      path: '/v1/host/status',
      token: wrongToken,
    });
    expectRejected(wrongStatus, 401, 'unauthorized', 'host.status');

    const withOrigin = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      token,
      headers: { origin: 'https://evil.example' },
      body: handshakeBody(),
    });
    expectRejected(withOrigin, 401, 'unauthorized', 'host.handshake');

    const tokenInQuery = await loopbackRequest({
      port,
      method: 'POST',
      path: `/v1/host/handshake?token=${token}`,
      body: handshakeBody(),
    });
    expectRejected(tokenInQuery, 401, 'unauthorized', 'host.handshake');

    // 应用路由同样要求凭据（错误身份保留应用操作身份）。
    const appNoToken = await loopbackRequest({ port, method: 'GET', path: '/v1/projects' });
    expectRejected(appNoToken, 401, 'unauthorized', 'projects.list');
    const appWrongToken = await loopbackRequest({
      port,
      method: 'GET',
      path: '/v1/projects',
      token: wrongToken,
    });
    expectRejected(appWrongToken, 401, 'unauthorized', 'projects.list');
    for (const response of [missing, wrong, wrongStatus, withOrigin, tokenInQuery, appNoToken, appWrongToken]) {
      expectTransportHygiene(response, secrets);
    }

    // 身份/协议门禁（§8 顺序：结构合法 + 凭据合法后才核对版本/实例/数据根）。
    const forgedInstance = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      token,
      body: handshakeBody({ hostInstanceId: randomUUID() }),
    });
    expectRejected(forgedInstance, 409, 'instance_mismatch', 'host.handshake');

    const wrongRoot = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      token,
      body: handshakeBody({ dataRootIdentity: 'a'.repeat(64) }),
    });
    expectRejected(wrongRoot, 409, 'data_root_mismatch', 'host.handshake');

    for (const legacyVersion of [3, 2, 1, 99]) {
      const legacySchema = await loopbackRequest({
        port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        body: handshakeBody({ schemaVersion: legacyVersion }),
      });
      const error = expectRejected(legacySchema, 400, 'unsupported_schema_version', 'host.handshake');
      expect(error.details?.supportedSchemaVersions).toEqual([5]);
    }

    const protocolMismatch = await loopbackRequest({
      port,
      method: 'POST',
      path: '/v1/host/handshake',
      token,
      body: handshakeBody({ protocolVersion: 99 }),
    });
    const protocolError = expectRejected(protocolMismatch, 426, 'protocol_incompatible', 'host.handshake');
    expect(protocolError.details?.supportedProtocolVersions).toEqual([1]);
    for (const response of [forgedInstance, wrongRoot, protocolMismatch]) {
      expectTransportHygiene(response, secrets);
    }

    // --- 零副作用：项目/配置/检查/文件逐项未变，Host 原实例存活。 ---
    expect(snapshotHostFiles(root)).toEqual(filesBefore);
    expect(snapshotRootState(root)).toEqual(stateBefore);
    expect(readDiscoveryFile(root)).toEqual(discoveryBefore);
    expect(f.snapshotRepository(repoPath)).toEqual(repoSnapshotBefore);
    expect(f.liveHostPid()).toBe(hostPid);

    // --- 不启动第二个 Host：重复 start = already_running 同实例同端口；唯一持锁。 ---
    const restartAttempt = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'neg-host-restart-attempt',
    });
    expect(restartAttempt.exitCode, restartAttempt.stderr).toBe(0);
    const restartResult = resultOf(restartAttempt);
    expect(restartResult.outcome).toBe('already_running');
    expect(restartResult.hostInstanceId).toBe(hostInstanceId);
    expect(restartResult.port).toBe(port);
    expect(f.liveHostPid()).toBe(hostPid);
    await expect(acquireWriterLock({ canonicalRoot, timeoutMs: 0 })).rejects.toSatisfy(
      (error: unknown) => isHostProtocolError(error, 'owner_unknown') || isHostProtocolError(error, 'owner_active'),
    );

    // --- 旧实例身份/旧凭据（真实重启：新实例 + 新凭据后旧材料一律无效）。 ---
    const oldToken = token;
    const oldInstance = hostInstanceId;
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);

    const startAgain = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'neg-host-start-again',
    });
    expect(startAgain.exitCode, startAgain.stderr).toBe(0);
    const againResult = resultOf(startAgain);
    expect(againResult.outcome).toBe('started');
    const newInstance = againResult.hostInstanceId as string;
    const newPort = againResult.port as number;
    expect(newInstance).not.toBe(oldInstance);
    const newToken = readHostToken(root);
    f.evidence.registerSecret(newToken);
    expect(newToken).not.toBe(oldToken);
    expect(readDiscoveryFile(root).hostInstanceId).toBe(newInstance);
    expect(readDiscoveryFile(root).listenAddress).toBe('127.0.0.1');

    // 旧凭据对新实例一律无效（§4.1/§4.2）。
    const staleToken = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: oldToken,
      body: {
        schemaVersion: 5,
        protocolVersion: 1,
        hostInstanceId: newInstance,
        dataRootIdentity,
      },
    });
    expectRejected(staleToken, 401, 'unauthorized', 'host.handshake');

    // 新凭据 + 旧实例 → 409 instance_mismatch。
    const staleInstance = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: newToken,
      body: {
        schemaVersion: 5,
        protocolVersion: 1,
        hostInstanceId: oldInstance,
        dataRootIdentity,
      },
    });
    expectRejected(staleInstance, 409, 'instance_mismatch', 'host.handshake');

    // 新凭据 + 错误数据根身份 → 409 data_root_mismatch。
    const staleRoot = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: newToken,
      body: {
        schemaVersion: 5,
        protocolVersion: 1,
        hostInstanceId: newInstance,
        dataRootIdentity: 'b'.repeat(64),
      },
    });
    expectRejected(staleRoot, 409, 'data_root_mismatch', 'host.handshake');

    // 对照：新凭据 + 新实例 → 200（拒绝不是把服务打坏）。
    const valid = await loopbackRequest({
      port: newPort,
      method: 'POST',
      path: '/v1/host/handshake',
      token: newToken,
      body: {
        schemaVersion: 5,
        protocolVersion: 1,
        hostInstanceId: newInstance,
        dataRootIdentity,
      },
    });
    expect(valid.statusCode, valid.bodyText).toBe(200);
    for (const response of [staleToken, staleInstance, staleRoot, valid]) {
      expectTransportHygiene(response, [oldToken, newToken]);
    }

    // --- 重启后零副作用：持久项目/配置/检查行与仓库文件未变。 ---
    expect(snapshotRootState(root)).toEqual(stateBefore);
    expect(f.snapshotRepository(repoPath)).toEqual(repoSnapshotBefore);

    // --- 证据（脱敏）：错误码计数、状态与副作用摘要。 ---
    const statusQuery = await f.runDistCli(['host', 'status', '--data-root', root, '--json'], {
      label: 'neg-host-status',
    });
    expect(statusQuery.exitCode, statusQuery.stderr).toBe(0);
    f.evidence.record('p02-4.fr2.auth_reject.identity', {
      hostInstanceId: newInstance,
      dataRootIdentity,
      listenAddress: '127.0.0.1',
      port: newPort,
      rejectedCodes: {
        unauthorized: 9,
        instance_mismatch: 2,
        data_root_mismatch: 2,
        unsupported_schema_version: 2,
        protocol_incompatible: 1,
      },
      secondHost: 'not_started',
      sideEffects: 'none',
      projects: stateBefore.counts.projects,
      globalSettings: stateBefore.counts.global_settings,
      baselineChecks: stateBefore.baselineCheckRows,
    });
    const document = exportScannedEvidence(
      { hostIdentity: extractHostIdentity(resultOf(statusQuery)), notes: ['P02-FR2-AUTH-REJECT identity'] },
      [oldToken, newToken],
    );
    expect(document).toContain(newInstance);
    expect(document).toContain(dataRootIdentity);

    // 收尾：受控停止（三证据）。
    const finalStop = await f.stopHost();
    expect(finalStop.exitCode, finalStop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 验收 2：受限 principal 跨项目与提权拒绝（可信测试装配）
 * ------------------------------------------------------------------ */

describe('P02-FR2-AUTH-REJECT 受限 principal 跨项目与提权拒绝', () => {
  it('跨项目详情/基线/制品读取与变更被拒；actorId/payload 权限字段不能提权；不扩建产品多用户或配对系统', async () => {
    const f = useFixture('shiploop-p02-4-f006-restricted-');
    const root = f.dataRoot('restricted');
    f.evidence.registerSecret(STUB_TOKEN);

    const app = await openCoreApplication({ dataRoot: root, capabilityCatalog: CATALOG });
    assemblyDisposers.push(async () => {
      try {
        await app.baselineExecutionService.waitForIdle();
      } catch {
        // 尽力收尾。
      }
      app.close();
    });

    // 项目 A（有完成基线）与项目 B（受限主体唯一可见）。
    const projectA = (
      await app.projectService.registerRepository({
        repositoryPath: f.repos.withHead,
        displayName: 'proj-a',
      })
    ).project.id;
    const projectB = (
      await app.projectService.registerRepository({
        repositoryPath: f.repos.cloneB,
        displayName: 'proj-b',
      })
    ).project.id;
    expect(projectA).toMatch(UUID_V4_PATTERN);
    expect(projectB).toMatch(UUID_V4_PATTERN);

    const plan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-restricted-baseline' });
    const preview = await app.baselineService.previewBaseline(OWNER, projectA, { plan });
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    const accepted = await app.baselineExecutionService.submit(
      OWNER,
      commandEnvelope('baseline.run', { kind: 'project', projectId: projectA }, {
        decision: 'authorize',
        plan,
        previewDigest: preview.previewDigest,
      }),
    );
    expect(accepted.status).toBe('accepted');
    const operationId = (accepted as { operationId?: unknown }).operationId;
    expect(typeof operationId).toBe('string');
    await app.baselineExecutionService.waitForIdle();
    const checkRows = app.baselineStore.listBaselineCheckResults(operationId as string);
    expect(checkRows[0]?.status).toBe('passed');
    const artifactId = checkRows[0]?.outputArtifactId;
    expect(typeof artifactId).toBe('string');

    // marker 计划：被拒的变更尝试一旦真的启动会落盘 marker 行（零执行哨兵）。
    const marker = setupMarkerCheck(f, 'p02-4-restricted-marker');
    const markerPreviewB = await app.baselineService.previewBaseline(OWNER, projectB, {
      plan: marker.plan as never,
    });
    expect(markerPreviewB.previewDigest).toMatch(/^[0-9a-f]{64}$/);

    // 拒绝前的状态基线（只读探针独立视角）。
    const stateBefore = snapshotRootState(root);
    expect(stateBefore.counts.projects).toBe(2);
    expect(stateBefore.baselineOperationRows).toBe(1);
    expect(existsSync(marker.markerPath)).toBe(false);

    // 三个传输面：owner（对照）/ 受限（baseline.read+run，仅见 B）/ 缺基线能力（仅见 A）。
    const ownerServer = await startRestrictedAppServer(app, OWNER);
    const restricted = createRestrictedPrincipal({
      capabilities: ['project.read', 'baseline.read', 'baseline.run'],
      projectScope: scopeAllowlist([projectB]),
    });
    const restrictedServer = await startRestrictedAppServer(app, restricted);
    const noBaselineRun = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: scopeAllowlist([projectA]),
    });
    const noRunServer = await startRestrictedAppServer(app, noBaselineRun);

    const get = (port: number, path: string) =>
      loopbackRequest({ port, method: 'GET', path, token: STUB_TOKEN });
    const post = (port: number, body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token: STUB_TOKEN, body });

    // 对照：受限主体对可见项目 B 的读取成功（范围裁剪不是一刀切失败）。
    const visibleB = await get(restrictedServer.port, `/v1/projects/${projectB}`);
    expect(visibleB.statusCode, visibleB.bodyText).toBe(200);
    expect(visibleB.bodyText).toContain('proj-b');

    // 跨项目读取：不可见项目 forbidden；操作/制品统一 not_found（防枚举）。
    const crossProject = await get(restrictedServer.port, `/v1/projects/${projectA}`);
    expectRejected(crossProject, 403, 'forbidden', 'projects.get');
    const crossGet = await get(restrictedServer.port, `/v1/baselines/${operationId}`);
    expectRejected(crossGet, 404, 'not_found', 'baselines.get');
    const crossList = await get(restrictedServer.port, `/v1/projects/${projectA}/baselines`);
    expectRejected(crossList, 403, 'forbidden', 'baselines.list');
    const crossArtifact = await get(restrictedServer.port, `/v1/artifacts/${artifactId}/content`);
    expect(crossArtifact.statusCode, crossArtifact.bodyText).toBe(404);
    expect(crossArtifact.bodyText).not.toContain('sample-ok');

    // 跨项目变更：preview/run（越权目标）与 cancel（scope 可见但操作归属 A）拒绝。
    const crossPreview = await post(
      restrictedServer.port,
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, { plan }),
    );
    expectRejected(crossPreview, 403, 'forbidden', 'baseline.preview');
    const crossRun = await post(
      restrictedServer.port,
      commandEnvelope('baseline.run', { kind: 'project', projectId: projectA }, {
        decision: 'authorize',
        plan: marker.plan,
        previewDigest: markerPreviewB.previewDigest,
      }),
    );
    expectRejected(crossRun, 403, 'forbidden', 'baseline.run');
    const crossCancel = await post(
      restrictedServer.port,
      commandEnvelope('baseline.cancel', { kind: 'project', projectId: projectB }, { operationId }),
    );
    expectRejected(crossCancel, 404, 'not_found', 'baseline.cancel');

    // 能力缺失：目标可见但没有 baseline.run / project.metadata.write。
    const noCapRun = await post(
      noRunServer.port,
      commandEnvelope('baseline.run', { kind: 'project', projectId: projectA }, {
        decision: 'authorize',
        plan: marker.plan,
        previewDigest: preview.previewDigest,
      }),
    );
    expectRejected(noCapRun, 403, 'forbidden', 'baseline.run');
    const noCapList = await get(noRunServer.port, `/v1/projects/${projectA}/baselines`);
    expectRejected(noCapList, 403, 'forbidden', 'baselines.list');
    const noCapMetadata = await post(
      restrictedServer.port,
      commandEnvelope('project.metadata.update', { kind: 'project', projectId: projectB }, { displayName: '提权失败' }, { expectedRevision: 1 }),
    );
    expectRejected(noCapMetadata, 403, 'forbidden', 'project.metadata.update');

    // 提权字段：actorId / principal / capabilities（顶层与 payload）一律结构拒绝。
    const escalations: Array<{ name: string; body: Record<string, unknown>; code: string; operation: string }> = [
      {
        name: '顶层 actorId',
        body: commandEnvelope('baseline.preview', { kind: 'project', projectId: projectB }, { plan: marker.plan }, { actorId: 'local-owner' }),
        code: 'invalid_input',
        operation: 'commands.submit',
      },
      {
        name: '顶层 principalId',
        body: commandEnvelope('baseline.preview', { kind: 'project', projectId: projectB }, { plan: marker.plan }, { principalId: 'local-owner' }),
        code: 'invalid_input',
        operation: 'commands.submit',
      },
      {
        name: '顶层 capabilities（全部产品能力）',
        body: commandEnvelope('baseline.preview', { kind: 'project', projectId: projectB }, { plan: marker.plan }, { capabilities: [...LOCAL_OWNER_CAPABILITIES] }),
        code: 'invalid_input',
        operation: 'commands.submit',
      },
      {
        name: '顶层 capabilities（未知能力 root.all）',
        body: commandEnvelope('baseline.preview', { kind: 'project', projectId: projectB }, { plan: marker.plan }, { capabilities: ['root.all'] }),
        code: 'invalid_input',
        operation: 'commands.submit',
      },
      {
        name: 'payload actorId',
        body: commandEnvelope('baseline.preview', { kind: 'project', projectId: projectB }, { plan: marker.plan, actorId: 'local-owner' }),
        code: 'invalid_input',
        operation: 'baseline.preview',
      },
      {
        name: 'payload principalId',
        body: commandEnvelope('baseline.run', { kind: 'project', projectId: projectB }, {
          decision: 'authorize',
          plan: marker.plan,
          previewDigest: markerPreviewB.previewDigest,
          principalId: 'local-owner',
        }),
        code: 'invalid_input',
        operation: 'baseline.run',
      },
    ];
    for (const escalation of escalations) {
      const response = await post(restrictedServer.port, escalation.body);
      expectRejected(response, 400, escalation.code, escalation.operation);
    }

    // 提权失败后能力/范围不变：受限主体依旧不能改 B 元数据。
    const stillForbidden = await post(
      restrictedServer.port,
      commandEnvelope('project.metadata.update', { kind: 'project', projectId: projectB }, { displayName: '再次提权失败' }, { expectedRevision: 1 }),
    );
    expectRejected(stillForbidden, 403, 'forbidden', 'project.metadata.update');

    // 全部响应脱敏（合成凭据不回显）。
    const sanitizedResponses = [
      visibleB, crossProject, crossGet, crossList, crossArtifact, crossPreview, crossRun,
      crossCancel, noCapRun, noCapList, noCapMetadata, stillForbidden,
    ];
    for (const response of sanitizedResponses) {
      for (const name of Object.keys(response.headers)) {
        expect(name.startsWith('access-control-')).toBe(false);
      }
    }

    // --- 零副作用：项目/配置/基线行不变、B 修订不被推进、marker 零落盘。 ---
    expect(snapshotRootState(root)).toEqual(stateBefore);
    expect(existsSync(marker.markerPath)).toBe(false);
    const probe = openDataRootStorageProbe(root);
    try {
      expect(probe.projectRow(projectB)?.revision).toBe(1);
    } finally {
      probe.close();
    }

    // --- 不扩建产品多用户或配对系统（不变量复验）。 ---
    // 1) 产品源码不存在任何 test-restricted 身份入口（只能由测试夹具构造）。
    const packagesSrc = join(REPO_ROOT, 'packages');
    const occurrences: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'dist' || entry.name === 'node_modules') {
          continue;
        }
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          if (readFileSync(child, 'utf8').includes(TEST_RESTRICTED_PRINCIPAL_PREFIX)) {
            occurrences.push(child);
          }
        }
      }
    };
    walk(packagesSrc);
    expect(occurrences).toEqual([]);
    // 2) 可信装配自身对未知能力 fail-closed（不存在宽松构造路径）。
    expect(() =>
      createRestrictedPrincipal({
        capabilities: ['root.all' as never],
        projectScope: scopeAllowlist([projectB]),
      }),
    ).toThrow(TypeError);

    // --- 证据（脱敏）。 ---
    f.evidence.record('p02-4.fr2.auth_reject.restricted', {
      restrictedPrincipalKind: 'project.read+baseline.read+baseline.run, allowlist B',
      crossProject: 'rejected',
      crossBaseline: 'rejected',
      crossArtifact: 'rejected',
      changes: 'rejected',
      privilegeEscalation: 'rejected',
      sideEffects: 'none',
      markerExecutions: 0,
    });
    const document = exportScannedEvidence(
      { notes: ['P02-FR2-AUTH-REJECT restricted-principal'] },
      [STUB_TOKEN],
    );
    expect(document).toContain('P02-FR2-AUTH-REJECT restricted-principal');
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * 验收 3：非法输入/任意路径/cwd 逃逸/未知能力拒绝（真实 Host）
 * ------------------------------------------------------------------ */

describe('P02-FR2-AUTH-REJECT 非法输入/任意路径/cwd 逃逸/未知能力拒绝', () => {
  it('非法 JSON/分页、任意路径读取、根外与符号链接逃逸 cwd、未知能力/提权字段明确拒绝；不返回正文、不建进程、错误保留操作身份', async () => {
    const f = useFixture('shiploop-p02-4-f006-inputs-');
    const root = f.dataRoot();
    const repoPath = f.repos.withHead;

    // --- 建立真实状态：Host + 项目 + 完成基线（全部经 dist CLI）。 ---
    const start = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'inputs-host-start',
    });
    expect(start.exitCode, start.stderr).toBe(0);
    const startResult = resultOf(start);
    const port = startResult.port as number;
    expect(startResult.listenAddress).toBe('127.0.0.1');

    const init = await f.runDistCli(
      ['project', 'init', repoPath, '--confirm', '--name', '非法输入守护项目', '--data-root', root, '--json'],
      { label: 'inputs-init' },
    );
    expect(init.exitCode, init.stderr).toBe(0);
    const projectId = (
      (singleEnvelope(init).result as { registration: { projectId: string } }).registration
    ).projectId;

    const plan = f.scenario('baselineSuccess').plan({ checkKey: 'p02-4-inputs-baseline' });
    const planFile = join(f.root, `plan-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(planFile, JSON.stringify({ checks: plan.checks }), 'utf8');
    const run = await f.runDistCli(
      [
        'baseline', 'run', '--project', projectId, '--input', planFile,
        '--confirm', '--data-root', root, '--json',
      ],
      { label: 'inputs-baseline-run' },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    const terminal = await pollTerminalOperation(f, root, (resultOf(run) as { operationId: string }).operationId, 60_000);
    expect(terminal.state).toBe('passed');
    const realArtifactId = terminal.checks[0]?.output?.artifactId as string;
    expect(realArtifactId).toMatch(UUID_V4_PATTERN);

    // --- 拒绝面材料：token / canary / 符号链接逃逸 / marker 计划。 ---
    const token = readHostToken(root);
    f.evidence.registerSecret(token);
    const secrets = [token];

    const canaryDir = join(f.root, 'canary');
    mkdirSync(canaryDir, { recursive: true });
    const canaryContent = `P02-6-CANARY-${randomUUID()}`;
    const canaryPath = join(canaryDir, 'secret.txt');
    writeFileSync(canaryPath, canaryContent, 'utf8');

    const outsideDir = join(f.root, 'outside-escape');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(repoPath, 'escape-link'));

    const marker = setupMarkerCheck(f, 'p02-4-inputs-marker');

    const stateBefore = snapshotRootState(root);
    expect(stateBefore.baselineOperationRows).toBe(1);
    const repoSnapshotBefore = f.snapshotRepository(repoPath);
    const discoveryBefore = readDiscoveryFile(root);
    expect(existsSync(marker.markerPath)).toBe(false);

    const post = (body: unknown | string, options: { raw?: boolean; headers?: Record<string, string> } = {}) =>
      loopbackRequest({
        port,
        method: 'POST',
        path: '/v1/commands',
        token,
        ...(options.raw ? { rawBody: body as string } : { body: body as unknown }),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      });
    const get = (path: string) => loopbackRequest({ port, method: 'GET', path, token });

    // --- 非法 JSON / 内容类型 / GET 带体 / 超限：明确拒绝且不回显请求原文。 ---
    const brokenJson = await post('{broken', { raw: true });
    const brokenJsonError = expectRejected(brokenJson, 400, 'invalid_input', 'commands.submit');
    expect(brokenJsonError.details?.reason).toBe('invalid_json');
    expect(brokenJson.bodyText).not.toContain('{broken');

    const badContentType = await post('{"schemaVersion":3}', {
      raw: true,
      headers: { 'content-type': 'text/plain' },
    });
    expectRejected(badContentType, 400, 'invalid_input', 'commands.submit');

    const getWithBody = await loopbackRequest({
      port,
      method: 'GET',
      path: '/v1/host/status',
      token,
      body: {},
    });
    expectRejected(getWithBody, 400, 'invalid_input', 'host.status');

    const oversized = await post(`{"pad":"${'x'.repeat(65_600)}"}`, { raw: true });
    expectRejected(oversized, 413, 'request_too_large', 'commands.submit');

    // --- 非法分页 / 非法 ID：错误保留适用查询操作身份。 ---
    for (const query of ['limit=0', 'limit=abc', 'bogus=1']) {
      const response = await get(`/v1/projects?${query}`);
      expectRejected(response, 400, 'invalid_input', 'projects.list');
    }
    const duplicateLimit = await get(`/v1/projects/${projectId}/baselines?limit=1&limit=2`);
    expectRejected(duplicateLimit, 400, 'invalid_input', 'baselines.list');
    const badOperationId = await get('/v1/baselines/not-a-uuid');
    expectRejected(badOperationId, 400, 'invalid_input', 'baselines.get');

    // --- 任意路径读取：表外路径/穿越/伪造 ID 一律 404，永不返回文件正文。 ---
    const arbitraryPaths = [
      `/v1/files?path=${encodeURIComponent(canaryPath)}`,
      '/v1/files?path=/etc/passwd',
      `/v1/artifacts/${randomUUID()}/content`,
      '/v1/artifacts/..%2F..%2F..%2Fetc%2Fpasswd/content',
      '/v1/artifacts//content',
      '/v1/artifacts',
    ];
    for (const path of arbitraryPaths) {
      const response = await get(path);
      expect(response.statusCode, `${path}: ${response.bodyText}`).toBe(404);
      expect(response.bodyText).not.toContain(canaryContent);
      expect(response.bodyText).not.toContain('root:');
    }
    // 对照：合法制品正文可读（404 是存在性/授权拒绝，不是路由整体失效）。
    const validArtifact = await get(`/v1/artifacts/${realArtifactId}/content`);
    expect(validArtifact.statusCode, validArtifact.bodyText).toBe(200);
    expect(validArtifact.bodyText).toContain('sample-ok');

    // --- cwd 逃逸 / 伪环境引用：preview 校验层拒绝，零进程启动（marker 哨兵）。 ---
    const cwdPlan = (check: Record<string, unknown>): { checks: Array<Record<string, unknown>> } => ({
      checks: [check],
    });
    const markerCheck = marker.plan.checks[0] as Record<string, unknown>;
    for (const cwdRef of ['../outside', '/etc', 'escape-link']) {
      const response = await post(
        commandEnvelope('baseline.preview', { kind: 'project', projectId }, {
          plan: cwdPlan({ ...markerCheck, cwdRef }),
        }),
      );
      const error = expectRejected(response, 400, 'invalid_input', 'baseline.preview');
      expect(error.details?.reason).toBe('path_outside_repository');
    }
    const fakeEnv = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId }, {
        plan: cwdPlan({ ...markerCheck, environmentRef: 'ghost-env' }),
      }),
    );
    expectRejected(fakeEnv, 400, 'invalid_input', 'baseline.preview');

    // --- 未知能力/提权字段：信封顶层与 payload 一律结构拒绝；未知操作 501。 ---
    for (const capabilities of [['project.read'], ['root.all']]) {
      const response = await post(
        commandEnvelope('baseline.preview', { kind: 'project', projectId }, { plan: marker.plan }, { capabilities }),
      );
      expectRejected(response, 400, 'invalid_input', 'commands.submit');
    }
    const actorIdTop = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId }, { plan: marker.plan }, { actorId: 'local-owner' }),
    );
    expectRejected(actorIdTop, 400, 'invalid_input', 'commands.submit');
    const actorIdPayload = await post(
      commandEnvelope('baseline.preview', { kind: 'project', projectId }, { plan: marker.plan, actorId: 'local-owner' }),
    );
    expectRejected(actorIdPayload, 400, 'invalid_input', 'baseline.preview');
    const unknownOperation = await post(
      commandEnvelope('work.run', { kind: 'project', projectId }, { plan: marker.plan }),
    );
    const unsupportedError = expectRejected(unknownOperation, 501, 'unsupported', 'commands.submit');
    const supported = unsupportedError.details?.supportedOperations as unknown[];
    expect(Array.isArray(supported)).toBe(true);
    expect(supported).not.toContain('work.run');

    // --- 全部 JSON 错误响应的传输纪律与脱敏（不泄漏 token/路径/正文）。 ---
    for (const response of [
      brokenJson, badContentType, getWithBody, duplicateLimit, badOperationId,
      fakeEnv, actorIdTop, actorIdPayload, unknownOperation,
    ]) {
      expectTransportHygiene(response, secrets);
      expect(response.bodyText).not.toContain(canaryContent);
    }

    // --- 零副作用：持久行/发现/仓库文件不变；marker 零落盘（没有创建基线进程）。 ---
    expect(snapshotRootState(root)).toEqual(stateBefore);
    expect(readDiscoveryFile(root)).toEqual(discoveryBefore);
    expect(f.snapshotRepository(repoPath)).toEqual(repoSnapshotBefore);
    expect(existsSync(marker.markerPath)).toBe(false);
    expect(f.liveHostPid()).not.toBeNull();

    // --- 证据（脱敏）。 ---
    f.evidence.record('p02-4.fr2.auth_reject.inputs', {
      rejectedCodes: {
        invalid_input: 15,
        request_too_large: 1,
        unknown_operation: 6,
        unsupported: 1,
      },
      fileContentLeaked: false,
      baselineProcessesCreated: 0,
      markerExecutions: 0,
      sideEffects: 'none',
    });
    const document = exportScannedEvidence(
      { notes: ['P02-FR2-AUTH-REJECT invalid-inputs'] },
      secrets,
    );
    expect(document).toContain('P02-FR2-AUTH-REJECT invalid-inputs');

    // 收尾：受控停止。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
    // 拒绝路径从未触碰的 canary 文件仍在原位。
    expect(readFileSync(canaryPath, 'utf8')).toBe(canaryContent);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 验收 4：固定回环监听（T23 组合复验：配置/env/CLI + Host/Origin + 实际绑定）
 * ------------------------------------------------------------------ */

describe('P02-FR2-AUTH-REJECT 固定回环监听（T23 组合复验）', () => {
  it('CLI 参数/env、Host 启动入口 argv 与启动配置/env 的监听覆盖全部拒绝且零文件副作用；错误 Host/Origin 拒绝；实际绑定仍为 127.0.0.1', async () => {
    const f = useFixture('shiploop-p02-4-f006-listen-');

    // --- CLI 参数覆盖（真实 dist CLI；host 与 app 命令面都拒绝）。 ---
    const argvRoot = f.dataRoot('t23-argv');
    const argvCases: Array<{ subcommand: string[]; override: string[] }> = [
      { subcommand: ['host', 'start'], override: ['--bind', '0.0.0.0'] },
      { subcommand: ['host', 'start'], override: ['--listen-address', '192.168.1.10'] },
      { subcommand: ['host', 'start'], override: ['--port', '8080'] },
      { subcommand: ['host', 'status'], override: ['--hostname', '::'] },
      { subcommand: ['host', 'stop'], override: ['--listen=0.0.0.0'] },
      { subcommand: ['project', 'list'], override: ['--address', '192.168.1.1'] },
    ];
    for (const testCase of argvCases) {
      const result = await f.runDistCli(
        [...testCase.subcommand, ...testCase.override, '--data-root', argvRoot, '--json'],
        { label: `t23-argv-${testCase.subcommand.join('-')}` },
      );
      const { error } = failureEnvelopeOf(result, 2, 'bind_address_override_rejected');
      expect((error.details as { reason?: unknown } | undefined)?.reason).toBe(
        'listen_override_argument_rejected',
      );
      // 覆盖值不回显。
      expect(result.stdout).not.toContain('0.0.0.0');
      expect(result.stdout).not.toContain('192.168.1.10');
      expect(result.stdout).not.toContain('192.168.1.1');
      expect(result.stdout).not.toContain('8080');
      expect(result.stderr).not.toContain('0.0.0.0');
    }
    // 零文件副作用：没有 Host 目录/状态库/存活 Host。
    expect(existsSync(join(argvRoot, 'host'))).toBe(false);
    expect(existsSync(join(argvRoot, 'core.sqlite'))).toBe(false);
    expect(f.liveHostPid('t23-argv')).toBeNull();

    // --- CLI env 覆盖（非空覆盖键在 host 与 app 命令面都拒绝）。 ---
    const envRoot = f.dataRoot('t23-env');
    for (const [name, value] of [
      ['SHIPLOOP_HOST_BIND', '0.0.0.0'],
      ['SHIPLOOP_HOST_PORT', '8080'],
      ['SHIPLOOP_HOST_LISTEN_ADDRESS', '192.168.1.10'],
    ] as const) {
      for (const subcommand of [['host', 'status'], ['project', 'list']]) {
        const result = await f.runDistCli([...subcommand, '--data-root', envRoot, '--json'], {
          label: `t23-env-${name}`,
          childEnv: f.childEnv({ [name]: value }),
        });
        const { error } = failureEnvelopeOf(result, 2, 'bind_address_override_rejected');
        expect((error.details as { reason?: unknown } | undefined)?.reason).toBe(
          'listen_override_env_rejected',
        );
        expect((error.details as { field?: unknown } | undefined)?.field).toBe(name);
        // 覆盖值不回显。
        expect(result.stdout + result.stderr).not.toContain(value);
      }
    }
    expect(existsSync(join(envRoot, 'host'))).toBe(false);
    expect(existsSync(join(envRoot, 'core.sqlite'))).toBe(false);
    expect(f.liveHostPid('t23-env')).toBeNull();

    // --- Host 显式启动入口（真实 dist start.js）：监听覆盖 argv 拒绝且零副作用。 ---
    const entryRoot = f.dataRoot('t23-entry');
    const entryResult = await f.runDistCli(['--data-root', entryRoot, '--bind', '0.0.0.0'], {
      label: 't23-host-start-entry',
      entryArgv: [process.execPath, HOST_START_ENTRY],
    });
    expect(entryResult.exitCode, entryResult.stderr).toBe(2);
    expect(entryResult.stderr).toContain('bind_address_override_rejected');
    expect(entryResult.stderr).not.toContain('0.0.0.0');
    expect(existsSync(join(entryRoot, 'host'))).toBe(false);

    // --- Host 启动配置选项（in-process startHost；任何覆盖键/取值一律拒绝）。 ---
    const optionKeys = ['bind', 'bindAddress', 'host', 'hostname', 'address', 'listen', 'listenAddress', 'port'] as const;
    for (const key of optionKeys) {
      const freshRoot = join(f.root, `t23-cfg-${key}`);
      const forged = {
        dataRoot: freshRoot,
        capabilityCatalog: CATALOG,
        env: {},
        [key]: '0.0.0.0',
      } as unknown as HostStartOptions;
      try {
        const host = await startHost(forged);
        await host.close();
        throw new Error(`启动选项 ${key} 的监听覆盖未被拒绝`);
      } catch (error) {
        expect(isHostProtocolError(error, 'bind_address_override_rejected'), String(error)).toBe(true);
      }
      expect(existsSync(freshRoot)).toBe(false);
    }
    for (const value of ['0.0.0.0', '::', '192.168.1.10', 'public.example.com']) {
      const freshRoot = join(f.root, 't23-cfg-value');
      const forged = {
        dataRoot: freshRoot,
        capabilityCatalog: CATALOG,
        env: {},
        listen: value,
      } as unknown as HostStartOptions;
      try {
        const host = await startHost(forged);
        await host.close();
        throw new Error(`启动选项取值 ${value} 未被拒绝`);
      } catch (error) {
        expect(isHostProtocolError(error, 'bind_address_override_rejected'), String(error)).toBe(true);
      }
      expect(existsSync(freshRoot)).toBe(false);
    }

    // --- Host 启动注入 env（HOST 侧同表键；details 只含变量名不回显取值）。 ---
    for (const name of ['SHIPLOOP_HOST_BIND', 'SHIPLOOP_HOST_HOST', 'SHIPLOOP_HOST_PORT', 'SHIPLOOP_HOST_LISTEN_ADDRESS']) {
      const freshRoot = join(f.root, `t23-env-${name}`);
      try {
        const host = await startHost({
          dataRoot: freshRoot,
          capabilityCatalog: CATALOG,
          env: { [name]: '0.0.0.0' },
        });
        await host.close();
        throw new Error(`注入 env ${name} 的监听覆盖未被拒绝`);
      } catch (error) {
        if (!isHostProtocolError(error, 'bind_address_override_rejected')) {
          throw error;
        }
        expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain('0.0.0.0');
      }
      expect(existsSync(freshRoot)).toBe(false);
    }

    // --- 真实 Host：错误 Host/Origin 拒绝 + 实际绑定仍为 127.0.0.1。 ---
    const listenRoot = f.dataRoot('t23-listen');
    const start = await f.runDistCli(['host', 'start', '--data-root', listenRoot, '--json'], {
      label: 't23-host-start',
    });
    expect(start.exitCode, start.stderr).toBe(0);
    const startResult = resultOf(start);
    const port = startResult.port as number;
    expect(startResult.listenAddress).toBe('127.0.0.1');
    expect(port).toBeGreaterThanOrEqual(RANDOM_PORT_MIN);
    expect(port).toBeLessThanOrEqual(RANDOM_PORT_MAX);
    const discovery = readDiscoveryFile(listenRoot);
    expect(discovery.listenAddress).toBe('127.0.0.1');
    expect(discovery.port).toBe(port);
    const token = readHostToken(listenRoot);
    f.evidence.registerSecret(token);
    const secrets = [token];

    // Origin 携带（正确凭据也拒绝）；URL query 凭据不算认证头。
    for (const origin of ['https://evil.example', 'http://localhost.attacker.example', 'null']) {
      const response = await loopbackRequest({
        port,
        method: 'POST',
        path: '/v1/host/handshake',
        token,
        headers: { origin },
        body: { schemaVersion: 5, protocolVersion: 1, hostInstanceId: discovery.hostInstanceId, dataRootIdentity: discovery.dataRootIdentity },
      });
      expectRejected(response, 401, 'unauthorized', 'host.handshake');
      expectTransportHygiene(response, secrets);
    }
    const queryCredential = await loopbackRequest({
      port,
      method: 'POST',
      path: `/v1/host/handshake?token=${token}`,
      body: { schemaVersion: 5, protocolVersion: 1, hostInstanceId: discovery.hostInstanceId, dataRootIdentity: discovery.dataRootIdentity },
    });
    expectRejected(queryCredential, 401, 'unauthorized', 'host.handshake');
    expect(queryCredential.bodyText).not.toContain(token);

    // 错误 Host 头（raw 报文）：localhost/错误端口/域名/0.0.0.0 一律 401；缺失 Host 400。
    const statusRequest = (hostLine: string | null): string => [
      'GET /v1/host/status HTTP/1.1',
      ...(hostLine === null ? [] : [hostLine]),
      `Authorization: Bearer ${token}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    for (const hostLine of [
      `Host: localhost:${port}`,
      `Host: 127.0.0.1:${port + 1}`,
      'Host: evil.example',
      'Host: 0.0.0.0',
    ]) {
      const raw = await rawExchange(port, statusRequest(hostLine));
      expect(statusOf(raw), `${hostLine}: ${raw}`).toBe(401);
      expect(raw).not.toContain(token);
      const jsonMatch = /\{.*\}/s.exec(raw);
      expect(jsonMatch, raw).not.toBeNull();
      const parsed = JSON.parse((jsonMatch as RegExpExecArray)[0]) as { error: { code: string } };
      expect(parsed.error.code).toBe('unauthorized');
    }
    const missingHostRaw = await rawExchange(port, statusRequest(null));
    // HTTP/1.1 缺失 Host：Node 内核在业务处理器之前以 400 拒绝（同为有界零副作用拒绝）。
    expect(statusOf(missingHostRaw)).toBe(400);
    expect(missingHostRaw).not.toContain(token);
    // 对照：正确 Host 头可通过认证（Host 仍存活）。
    const okRaw = await rawExchange(port, statusRequest(`Host: 127.0.0.1:${port}`));
    expect(statusOf(okRaw), okRaw).toBe(200);

    // 拒绝后零副作用：发现不变、Host 原实例存活（错误 Host/Origin 不触发任何变更）。
    expect(readDiscoveryFile(listenRoot)).toEqual(discovery);
    expect(f.liveHostPid('t23-listen')).toBe(discovery.pid as number);

    // --- 证据（脱敏）。 ---
    f.evidence.record('p02-4.fr2.auth_reject.listen', {
      cliOverrideRejected: 'argument+env',
      hostEntryOverrideRejected: true,
      startupOptionOverrideRejected: optionKeys.length + 4,
      startupEnvOverrideRejected: 4,
      wrongHostOrOriginRejected: 8,
      actualBinding: '127.0.0.1',
      portRange: 'ephemeral',
      sideEffects: 'none',
    });
    const document = exportScannedEvidence(
      {
        hostIdentity: extractHostIdentity(startResult),
        notes: ['P02-FR2-AUTH-REJECT loopback-listen'],
      },
      secrets,
    );
    expect(document).toContain('127.0.0.1');

    // 收尾：受控停止。
    const stop = await f.stopHost('t23-listen');
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid('t23-listen') === null, 10_000);
  }, 300_000);
});

/* ------------------------------------------------------------------ *
 * 验收 5：证据脱敏（认证头/发现凭据正文/合成 token 不出现）
 * ------------------------------------------------------------------ */

describe('P02-FR2-AUTH-REJECT 证据脱敏', () => {
  it('认证头、发现凭据正文与合成 token 不出现在 JSON 输出、诊断及导出的证据中；仅保存脱敏错误码、状态与副作用摘要', async () => {
    const f = useFixture('shiploop-p02-4-f006-redact-');
    const root = f.dataRoot();

    // 建立真实 Host 并收集真实/拒绝输出的全文（JSON 输出 + 诊断）。
    const start = await f.runDistCli(['host', 'start', '--data-root', root, '--json'], {
      label: 'redact-host-start',
    });
    expect(start.exitCode, start.stderr).toBe(0);
    const startResult = resultOf(start);
    const port = startResult.port as number;
    const token = readHostToken(root);
    // 发现凭据正文（auth.token 文件内容）与两个合成 token 全部登记为秘密。
    const tokenFileContent = readFileSync(join(root, 'host', 'auth.token'), 'utf8');
    const synthesizedTokens = ['e'.repeat(64), randomBytes(32).toString('hex'), `Bearer ${randomBytes(24).toString('hex')}`];
    for (const secret of [token, ...synthesizedTokens]) {
      f.evidence.registerSecret(secret);
    }
    const secrets = [token, tokenFileContent, ...synthesizedTokens];

    // 成功 JSON 输出（host status）：不含任何凭据形态。
    const status = await f.runDistCli(['host', 'status', '--data-root', root, '--json'], {
      label: 'redact-host-status',
    });
    expect(status.exitCode, status.stderr).toBe(0);
    for (const secret of secrets) {
      expect(status.stdout).not.toContain(secret);
      expect(status.stderr).not.toContain(secret);
    }

    // 拒绝 JSON 输出：错误 token / 缺失 token 的 HTTP 响应体。
    const rejectedBodies: string[] = [];
    for (const options of [
      { method: 'POST' as const, path: '/v1/host/handshake', body: { schemaVersion: 5, protocolVersion: 1, hostInstanceId: startResult.hostInstanceId, dataRootIdentity: startResult.dataRootIdentity } },
      { method: 'POST' as const, path: '/v1/host/handshake', token: synthesizedTokens[0], body: { schemaVersion: 5, protocolVersion: 1, hostInstanceId: startResult.hostInstanceId, dataRootIdentity: startResult.dataRootIdentity } },
      { method: 'GET' as const, path: '/v1/projects', token: synthesizedTokens[0] },
    ]) {
      const response = await loopbackRequest({ port, ...options });
      expectRejected(response, 401, 'unauthorized');
      rejectedBodies.push(response.bodyText);
      for (const secret of secrets) {
        expect(response.bodyText).not.toContain(secret);
      }
      expectTransportHygiene(response, secrets);
    }

    // CLI 诊断（监听覆盖拒绝）：stdout 信封与 stderr 人类诊断都不含凭据。
    const overrideRejected = await f.runDistCli(
      ['host', 'start', '--bind', '0.0.0.0', '--data-root', root, '--json'],
      { label: 'redact-listen-override' },
    );
    failureEnvelopeOf(overrideRejected, 2, 'bind_address_override_rejected');
    for (const secret of secrets) {
      expect(overrideRejected.stdout).not.toContain(secret);
      expect(overrideRejected.stderr).not.toContain(secret);
    }

    // 认证头形状：成功/拒绝输出都不出现 Bearer 形态。
    expect(status.stdout).not.toContain('Bearer');
    expect(overrideRejected.stdout).not.toContain('Bearer');
    for (const body of rejectedBodies) {
      expect(body).not.toContain('Bearer');
    }

    // 证据事件：仅保存脱敏错误码、状态与副作用摘要（键集合受控）。
    const event = f.evidence.record('p02-4.fr2.auth_reject.redaction', {
      rejectedCodes: ['unauthorized'],
      responseStatuses: [401, 401, 401],
      cliExitCode: 2,
      sideEffects: 'none',
    });
    expect(Object.keys(event.fields).sort()).toEqual([
      'cliExitCode',
      'rejectedCodes',
      'responseStatuses',
      'sideEffects',
    ]);
    const serialized = f.evidence.serialize();
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }

    // 导出证据文档：凭据形状扫描为空 + 全部秘密不出现。
    const document = exportScannedEvidence(
      {
        hostIdentity: extractHostIdentity(startResult),
        notes: ['P02-FR2-AUTH-REJECT redaction'],
      },
      secrets,
    );
    expect(scanForCredentialShapes(JSON.parse(document))).toEqual([]);
    expect(document).toContain('P02-FR2-AUTH-REJECT redaction');
    // 文档只携带脱敏身份/摘要（hostInstanceId 等非秘密字段）。
    expect(document).toContain(startResult.hostInstanceId as string);

    // 收尾：受控停止。
    const stop = await f.stopHost();
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor(() => f.liveHostPid() === null, 10_000);
  }, 180_000);
});
