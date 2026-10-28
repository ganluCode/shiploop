/**
 * F-014 P02-3 基线 /v1 路由与 HostClient 验收（真实 127.0.0.1 HTTP + 真实
 * SQLite/Git/子进程 + 生产 startHost 装配 + 真实 HostClient 发现/握手）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md §3.2（路由总表）、§5.3
 *（accepted → 202）、§6（preview/run/cancel payload 与回执）、§7.4-§7.6
 *（分页/详情/证据正文）、§9.2（基线事件白名单）与 §13（预算）。
 *
 * F-014 验收标准逐项：
 * 1. Host 复用既有认证/信封/回执/SSE/结构化错误；baseline.run authorize →
 *    202 accepted + operationId；握手能力只宣告真实接线接口（含
 *    baseline.cancel 与 baselines.list/get + artifacts.get）。
 * 2. HostClient 复用有界超时与「超时先查回执再原样重发」；校验基线/证据响应
 *    Schema；客户端断开/close/Abort 绝不自动取消后台检查（取消只经显式
 *    baseline.cancel 命令）。
 * 3. 真实 HTTP 覆盖 preview / decline / authorized start / active 查询 /
 *    cancel / 重启后历史分页 / output artifact 正文读取；跨项目
 *    operationId/baselineId/artifactId、伪环境引用、cwd 逃逸、任意路径读取、
 *    未知版本与非法输入一律拒绝且状态/文件不变。
 * 4. overview 健康来自真实持久基线摘要；事件流携带脱敏基线事件（客户端线
 *    校验通过）。
 *
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  startHost,
  type HostClient,
  type RunningHost,
} from '../../../packages/host/src/index.ts';
import {
  createLocalOwnerPrincipal,
  createStaticRuntimeCapabilityCatalog,
  WIRE_MESSAGE_SCHEMA_VERSION,
  type CommandReceipt,
  type PublicStateEvent,
} from '../../../packages/core/src/index.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineFixture, type BaselineFixture } from '../../helpers/p02-3/index.ts';
import {
  createRestrictedPrincipal,
  scopeAllowlist,
  type TestTrustedPrincipal,
} from '../../helpers/p02-2/principals.ts';
import { loopbackRequest } from '../../helpers/host/http-probe.ts';
import {
  validateAppQueryResponse,
  validateBaselineCommandResultWire,
  validateBaselinePreviewResultWire,
  validateStateEventWire,
} from '../../../packages/host/src/client/app-wire.ts';

const CATALOG = createStaticRuntimeCapabilityCatalog([]);
const OWNER = createLocalOwnerPrincipal();
const CLIENT_TIMEOUTS = { appRequestMs: 30_000, submitBudgetMs: 90_000 } as const;

/** 快速成功检查（node --version；输出含 vX.Y.Z）。 */
const VERSION_CHECK = {
  checkKey: 'node-version',
  kind: 'command',
  argv: [process.execPath, '--version'],
  timeoutMs: 30_000,
  required: true,
} as const;

/** 挂起检查（等显式取消；响应 SIGTERM）。 */
const HANGING_CHECK = {
  checkKey: 'hang',
  kind: 'command',
  argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
  timeoutMs: 120_000,
  required: true,
} as const;

function planOf(check: unknown): { checks: unknown[] } {
  return { checks: [check] };
}

function commandEnvelope(
  operation: string,
  scope: Record<string, unknown>,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    // 命令信封用线消息版本（P03-1 / F-009 起 v4）；ONBOARDING_QUERY_SCHEMA_VERSION
    // 是基线/接入查询响应的独立版本族，不共用。
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: new Date().toISOString(),
    payload,
    ...overrides,
  };
}

function acceptedOf(receipt: CommandReceipt): string {
  if (receipt.status !== 'accepted' || typeof receipt.operationId !== 'string') {
    throw new Error(`预期 accepted 回执，实际 ${receipt.status}`);
  }
  return receipt.operationId;
}

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed' || receipt.result === undefined) {
    throw new Error(`预期 completed 回执，实际 ${receipt.status}`);
  }
  return receipt.result as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 生产装配（startHost + connectToHost）夹具
 * ------------------------------------------------------------------ */

interface ProductionHostContext {
  readonly box: BaselineFixture;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly projectId: string;
  readonly host: RunningHost;
  readonly client: HostClient;
  restart(): Promise<void>;
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) {
    await dispose();
  }
});

async function bootProductionHost(): Promise<ProductionHostContext> {
  const box = createBaselineFixture({ prefix: 'shiploop-f014-' });
  disposers.push(() => box.dispose());
  const root = box.dataRoot();
  const canonicalRoot = realpathSync(root);
  let host = await startHost({ dataRoot: root, capabilityCatalog: CATALOG, env: {} });
  let client = await connectToHost({ canonicalRoot, timeouts: CLIENT_TIMEOUTS });
  const context: ProductionHostContext = {
    box,
    root,
    canonicalRoot,
    projectId: '',
    get host() {
      return host;
    },
    get client() {
      return client;
    },
    async restart() {
      client.close();
      await host.core.baselineExecutionService.waitForIdle();
      await host.close();
      host = await startHost({ dataRoot: root, capabilityCatalog: CATALOG, env: {} });
      client = await connectToHost({ canonicalRoot, timeouts: CLIENT_TIMEOUTS });
    },
  } as ProductionHostContext;
  disposers.push(async () => {
    client.close();
    try {
      await host.core.baselineExecutionService.waitForIdle();
    } catch {
      // 尽力收尾。
    }
    await host.close().catch(() => undefined);
  });

  const register = await client.submitCommand({
    operation: 'project.register',
    scope: { kind: 'registration' },
    payload: { repositoryPath: box.repos.withHead, displayName: 'f014', labels: ['f014'] },
  });
  const registered = completedResult(register) as { project: { id: string } };
  (context as { projectId: string }).projectId = registered.project.id;
  return context;
}

/** 有界轮询到终态（三轴：accepted/running/cancelling 之外即终态）。 */
async function waitForTerminal(
  client: HostClient,
  operationId: string,
  budgetMs = 30_000,
): Promise<Awaited<ReturnType<HostClient['getBaseline']>>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const detail = await client.getBaseline(operationId);
    if (!['accepted', 'running', 'cancelling'].includes(detail.operation.status)) {
      return detail;
    }
    if (Date.now() > deadline) {
      throw new Error(`基线操作 ${operationId} 未在 ${budgetMs}ms 内进入终态`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 有界等待谓词（事件推送等异步观察）。 */
async function waitFor(predicate: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('谓词未在预算内成立');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/* ------------------------------------------------------------------ *
 * 受限主体路由夹具（无 startHost；直接 openCoreApplication + 传输面）
 * ------------------------------------------------------------------ */

const STUB_TOKEN = randomBytes(32).toString('hex');
const STUB_INSTANCE = randomUUID();
const STUB_STARTED_AT = new Date().toISOString();

async function startAppServer(
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
    dataRootIdentity: 'sha256:restricted-harness',
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
  disposers.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  );
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('应用传输面监听地址非法');
  }
  return { port: address.port };
}

/** 只读第二连接核对持久行（不干扰主会话事务）。 */
function readRows(app: CoreApplication, sql: string): unknown[] {
  const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
  try {
    return session.database.prepare(sql).all() as unknown[];
  } finally {
    session.close();
  }
}

/** 仓库工作区受管文件清单（排除 .git；用于「文件不变」断言）。 */
function workspaceFiles(rootDir: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(rootDir, '');
  return entries.sort();
}

/* ------------------------------------------------------------------ *
 * 验收标准 1/3/4：preview → decline → authorize → 完成 → 查询/证据 → 重启
 * ------------------------------------------------------------------ */

describe('F-014 基线 /v1 路由与 HostClient（生产装配真实 HTTP）', () => {
  it('preview→decline→authorize→完成→详情/分页/证据正文/overview 健康→重启后仍可读', async () => {
    const f = await bootProductionHost();

    // 握手能力宣告与真实接线一致（F-014 新增三项查询 + baseline.cancel）。
    expect(f.client.handshake.capabilities.application.commands).toContain('baseline.cancel');
    expect(f.client.handshake.capabilities.application.queries).toEqual(
      expect.arrayContaining(['baselines.list', 'baselines.get', 'artifacts.get']),
    );

    // 1) 预览（只读）：completed 回执 + 预览摘要（摘要/政策修订/代码身份/逐项 argv）。
    const plan = planOf(VERSION_CHECK);
    const previewReceipt = await f.client.previewBaseline({ projectId: f.projectId, plan });
    const preview = completedResult(previewReceipt) as unknown as {
      previewDigest: string;
      policyRevision: string;
      codeIdentity: { headCommit: string | null };
      checks: { argv: string[] }[];
    };
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.policyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.codeIdentity.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(preview.checks[0]?.argv).toEqual([...VERSION_CHECK.argv]);

    // 2) decline：completed + not_run（零种子检查/零启动）。
    const decline = await f.client.runBaseline({
      projectId: f.projectId,
      decision: 'decline',
      plan,
      previewDigest: preview.previewDigest,
    });
    const declined = completedResult(decline);
    expect(declined).toMatchObject({ status: 'not_run', reasonCode: 'authorization_rejected' });
    const declinedId = declined.operationId as string;
    const declinedDetail = await f.client.getBaseline(declinedId);
    expect(declinedDetail.operation.status).toBe('not_run');
    expect(declinedDetail.authorization).toBeNull();
    expect(declinedDetail.checks).toEqual([]);
    // 与 decline 的 ended_at 拉开确定序（健康派生按结束时间取最近终态）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 3) authorize → 202 accepted + operationId；检查随后台启动。
    const accepted = await f.client.runBaseline({
      projectId: f.projectId,
      decision: 'authorize',
      plan,
      previewDigest: preview.previewDigest,
    });
    const operationId = acceptedOf(accepted);
    // active 查询：在途状态明确（accepted/running），绝不冒充完成。
    const inflight = await f.client.getBaseline(operationId);
    expect(['accepted', 'running']).toContain(inflight.operation.status);

    // 4) 完成：详情含授权摘要与逐项检查（passed + output 引用 + 脱敏 tail）。
    const detail = await waitForTerminal(f.client, operationId);
    expect(detail.schemaVersion).toBe(3);
    expect(detail.operation.status).toBe('completed');
    expect(detail.operation.summary).toMatchObject({ total: 1, passed: 1 });
    expect(detail.authorization).not.toBeNull();
    expect(detail.authorization?.projectId).toBe(f.projectId);
    expect(detail.authorization?.planDigest).toBe(preview.policyRevision);
    expect(detail.authorization?.authorizedBy).toBe(OWNER.principalId);
    const check = detail.checks[0];
    expect(check).toBeDefined();
    expect(check?.status).toBe('passed');
    expect(check?.exitCode).toBe(0);
    expect(check?.output).not.toBeNull();
    expect(check?.output?.byteSize).toBeGreaterThan(0);
    expect(check?.tail).toMatch(/v\d+\.\d+\.\d+/);
    expect(Buffer.byteLength(check?.tail ?? '', 'utf8')).toBeLessThanOrEqual(16_384);

    // 5) artifacts.get：正式证据正文（text/plain 有界），内容与 tail 一致。
    const artifactId = check?.output?.artifactId;
    expect(typeof artifactId).toBe('string');
    const artifact = await f.client.readArtifactContent(artifactId as string);
    expect(artifact.byteSize).toBeGreaterThan(0);
    expect(artifact.content).toMatch(/v\d+\.\d+\.\d+/);
    if (check?.tail != null) {
      expect(artifact.content.endsWith(check.tail)).toBe(true);
    }

    // 6) 分页：limit=1 两页覆盖全部操作（升序键集；游标=上一页末条）。
    const page1 = await f.client.listBaselines(f.projectId, { limit: 1 });
    expect(page1.records).toHaveLength(1);
    expect(page1.nextCursor).toBe(page1.records[0]?.operationId);
    const page2 = await f.client.listBaselines(f.projectId, {
      limit: 1,
      cursor: page1.nextCursor as string,
    });
    expect(page2.records).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const all = await f.client.listBaselines(f.projectId);
    expect(all.records.map((record) => record.operationId).sort()).toEqual(
      [declinedId, operationId].sort(),
    );
    expect(all.limit).toBe(20);

    // 7) overview 健康：来自真实持久基线摘要（注册/健康分离）。
    const overview = await f.client.getProjectOverview(f.projectId);
    expect(overview.registration.status).toBe('registered');
    expect(overview.health.status).toBe('healthy');
    expect(overview.health.lastBaselineOperationId).toBe(operationId);

    // 8) 重启后：历史分页/详情/证据正文仍可读（持久真相）。
    await f.restart();
    const afterRestartList = await f.client.listBaselines(f.projectId);
    expect(afterRestartList.records.map((record) => record.operationId).sort()).toEqual(
      [declinedId, operationId].sort(),
    );
    const afterRestart = await f.client.getBaseline(operationId);
    expect(afterRestart.operation.status).toBe('completed');
    expect(afterRestart.checks[0]?.output?.artifactId).toBe(artifactId);
    const artifactAfter = await f.client.readArtifactContent(artifactId as string);
    expect(artifactAfter.content).toBe(artifact.content);
  }, 90_000);

  it('在途基线：客户端 close/Abort 不取消后台检查；显式 baseline.cancel 确认停止且幂等', async () => {
    const f = await bootProductionHost();
    const plan = planOf(HANGING_CHECK);
    const preview = completedResult(
      await f.client.previewBaseline({ projectId: f.projectId, plan }),
    ) as { previewDigest: string };
    const accepted = await f.client.runBaseline({
      projectId: f.projectId,
      decision: 'authorize',
      plan,
      previewDigest: preview.previewDigest,
    });
    const operationId = acceptedOf(accepted);

    // Abort 一个观察性提交（另一命令）不触及在途基线。
    const controller = new AbortController();
    const observing = f.client.previewBaseline(
      { projectId: f.projectId, plan },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(observing).rejects.toMatchObject({ code: 'unreachable' });

    // 客户端 close 只释放本地观察资源：后台检查绝不因此被取消。
    f.client.close();
    const client2 = await connectToHost({
      canonicalRoot: f.canonicalRoot,
      timeouts: CLIENT_TIMEOUTS,
    });
    disposers.push(async () => {
      client2.close();
    });
    const still = await client2.getBaseline(operationId);
    expect(['accepted', 'running']).toContain(still.operation.status);

    // 取消唯一途径：显式 baseline.cancel 命令 → completed 回执 + 进程已确认停止。
    const cancel = await client2.cancelBaseline(f.projectId, operationId);
    const cancelled = completedResult(cancel);
    expect(cancelled).toMatchObject({ operationId, status: 'cancelled' });
    const final = await client2.getBaseline(operationId);
    expect(final.operation.status).toBe('cancelled');
    // 占用释放、无遗留进程活动。
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();

    // 取消已终态操作幂等：completed 回执返回当前终态。
    const again = await client2.cancelBaseline(f.projectId, operationId);
    expect(completedResult(again)).toMatchObject({ operationId, status: 'cancelled' });
  }, 90_000);

  it('事件流携带基线生命周期事件（脱敏摘要），HostClient 线校验通过', async () => {
    const f = await bootProductionHost();
    const snapshot = await f.client.getSnapshot({ kind: 'project', projectId: f.projectId });
    const events: PublicStateEvent[] = [];
    const subscription = await f.client.subscribeEvents({
      scope: { kind: 'project', projectId: f.projectId },
      cursor: snapshot.watermark.cursor,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      const plan = planOf(VERSION_CHECK);
      const preview = completedResult(
        await f.client.previewBaseline({ projectId: f.projectId, plan }),
      ) as { previewDigest: string; policyRevision: string };
      const accepted = await f.client.runBaseline({
        projectId: f.projectId,
        decision: 'authorize',
        plan,
        previewDigest: preview.previewDigest,
      });
      const operationId = acceptedOf(accepted);
      await waitForTerminal(f.client, operationId);
      await waitFor(() => events.some((event) => event.type === 'baseline.completed'));

      const types = events.map((event) => event.type);
      expect(types).toContain('baseline.authorized');
      expect(types).toContain('baseline.started');
      expect(types).toContain('baseline.check_completed');
      expect(types).toContain('baseline.completed');
      const authorized = events.find((event) => event.type === 'baseline.authorized');
      expect(authorized?.payload).toMatchObject({
        operationId,
        planDigest: preview.policyRevision,
        checkCount: 1,
      });
      const completed = events.find((event) => event.type === 'baseline.completed');
      expect(completed?.payload).toMatchObject({
        operationId,
        status: 'completed',
        summary: { total: 1, passed: 1 },
      });
      // 脱敏：事件 payload 不含仓库路径/输出正文。
      for (const event of events) {
        expect(JSON.stringify(event.payload)).not.toContain(f.box.repos.withHead);
      }
    } finally {
      subscription.close();
      await subscription.ended;
    }
  }, 90_000);
});

/* ------------------------------------------------------------------ *
 * 验收标准 2：HostClient 基线/证据响应 Schema 校验（线形状把关，纯函数）
 * ------------------------------------------------------------------ */

const SAMPLE_OPERATION = {
  operationId: randomUUID(),
  kind: 'baseline',
  status: 'completed',
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  summary: { total: 1, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 0 },
} as const;

function expectMalformed(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('response_malformed');
    return;
  }
  throw new Error('预期 response_malformed，但校验通过');
}

describe('F-014 HostClient 基线/证据响应 Schema 校验（线形状把关）', () => {
  it('baselines.list/get：未知键、未知版本、越界字段一律 response_malformed', () => {
    const validList = {
      schemaVersion: 3,
      projectId: 'proj-1',
      records: [SAMPLE_OPERATION],
      nextCursor: null,
      limit: 20,
    };
    expect(validateAppQueryResponse('baselines.list', validList).records).toHaveLength(1);
    expectMalformed(() =>
      validateAppQueryResponse('baselines.list', { ...validList, smuggled: true }),
    );
    // 未知 schema 版本单独分类（§11.2：unsupported_schema_version，非畸形）。
    try {
      validateAppQueryResponse('baselines.list', { ...validList, schemaVersion: 2 });
      throw new Error('预期拒绝未知版本');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('unsupported_schema_version');
    }
    expectMalformed(() =>
      validateAppQueryResponse('baselines.list', { ...validList, nextCursor: 'not-a-uuid' }),
    );
    expectMalformed(() =>
      validateAppQueryResponse('baselines.list', {
        ...validList,
        records: [{ ...SAMPLE_OPERATION, status: 'passed' }],
      }),
    );

    const validDetail = {
      schemaVersion: 3,
      operation: SAMPLE_OPERATION,
      authorization: null,
      checks: [
        {
          checkKey: 'node-version',
          argv: ['node', '--version'],
          cwdRef: null,
          environmentRef: null,
          timeoutMs: 30_000,
          required: true,
          status: 'passed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          output: { artifactId: 'artifact-1', byteSize: 12, truncated: false },
          tail: 'v22.19.0\n',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 42,
        },
      ],
    };
    const detail = validateAppQueryResponse('baselines.get', validDetail);
    expect(detail.checks[0]?.output?.artifactId).toBe('artifact-1');
    // output 缺 truncated / tail 超 16 KiB / 未知检查状态一律拒绝。
    expectMalformed(() =>
      validateAppQueryResponse('baselines.get', {
        ...validDetail,
        checks: [{ ...validDetail.checks[0], output: { artifactId: 'a', byteSize: 1 } }],
      }),
    );
    expectMalformed(() =>
      validateAppQueryResponse('baselines.get', {
        ...validDetail,
        checks: [{ ...validDetail.checks[0], tail: 'x'.repeat(16_385) }],
      }),
    );
    expectMalformed(() =>
      validateAppQueryResponse('baselines.get', {
        ...validDetail,
        checks: [{ ...validDetail.checks[0], status: 'green' }],
      }),
    );
  });

  it('preview/cancel 回执 result 与基线事件 payload 形状把关', () => {
    const validPreview = {
      previewDigest: 'a'.repeat(64),
      policyRevision: 'b'.repeat(64),
      repositoryBindingId: randomUUID(),
      repositoryBindingRevision: 1,
      bindingRecordRevision: 1,
      codeIdentity: { headCommit: null, workingTreeDigest: 'c'.repeat(64), hasUncommittedChanges: false },
      dirtyScope: { status: 'clean', explanation: 'clean' },
      environmentIdentity: {
        schemaVersion: 1,
        environmentRef: null,
        definitionRevision: null,
        toolchain: {},
        platform: { os: 'darwin', arch: 'arm64' },
        allowedVariables: ['PATH'],
        coverage: ['PATH'],
        unknownFields: [],
      },
      workspace: { excludedDirNames: ['.git'], fileCount: 0 },
      checks: [
        {
          checkKey: 'node-version',
          kind: 'command',
          argv: ['node', '--version'],
          cwdRef: null,
          cwd: '/repo',
          environmentRef: null,
          allowedVariables: ['PATH'],
          timeoutMs: 30_000,
          required: true,
        },
      ],
      warnings: [],
    };
    expect(validateBaselinePreviewResultWire(validPreview).previewDigest).toBe('a'.repeat(64));
    expectMalformed(() => validateBaselinePreviewResultWire({ ...validPreview, warnings: [{ code: 'made_up' }] }));
    expectMalformed(() => validateBaselinePreviewResultWire({ ...validPreview, previewDigest: 'zz' }));

    const operationId = randomUUID();
    expect(
      validateBaselineCommandResultWire({ operationId, status: 'cancelled', reasonCode: 'cancelled' }).status,
    ).toBe('cancelled');
    expectMalformed(() => validateBaselineCommandResultWire({ operationId: 'x', status: 'cancelled' }));
    expectMalformed(() => validateBaselineCommandResultWire({ operationId, status: 'passed' }));

    // §9.2 基线事件 payload（客户端校验与服务端 mapStateEvent 同一冻结形状）。
    const baseEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: 1,
      scope: { kind: 'project', projectId: randomUUID() },
      aggregate: { type: 'project', id: randomUUID(), revision: 1 },
      occurredAt: new Date().toISOString(),
    };
    const authorized = validateStateEventWire({
      ...baseEvent,
      type: 'baseline.authorized',
      payload: { operationId, planDigest: 'd'.repeat(64), checkCount: 1 },
    });
    expect(authorized.payload).toMatchObject({ operationId, checkCount: 1 });
    const completed = validateStateEventWire({
      ...baseEvent,
      type: 'baseline.completed',
      payload: {
        operationId,
        status: 'completed',
        summary: { total: 1, passed: 1, failed: 0, error: 0, inconclusive: 0, notRun: 0 },
      },
    });
    expect(completed.payload).toMatchObject({ operationId, status: 'completed' });
    // 缺 summary / 夹带正文字段 → 拒绝。
    expectMalformed(() =>
      validateStateEventWire({
        ...baseEvent,
        type: 'baseline.completed',
        payload: { operationId, status: 'completed' },
      }),
    );
    expectMalformed(() =>
      validateStateEventWire({
        ...baseEvent,
        type: 'baseline.check_completed',
        payload: { operationId, checkKey: 'a', status: 'passed', output: 'raw-content-leak' },
      }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * 验收标准 3：越权/伪造/任意路径/非法输入一律拒绝且状态与文件不变
 * ------------------------------------------------------------------ */

describe('F-014 基线路由拒绝面（受限主体 + 伪造引用 + 非法输入）', () => {
  it('跨项目身份/伪环境与 cwd/任意路径/未知版本/非法分页全部拒绝，状态与文件不变', async () => {
    const box = createBaselineFixture({ prefix: 'shiploop-f014-neg-' });
    disposers.push(() => box.dispose());
    const app = await openCoreApplication({ dataRoot: box.dataRoot(), capabilityCatalog: CATALOG });
    disposers.push(async () => {
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
        repositoryPath: box.repos.withHead,
        displayName: 'proj-a',
      })
    ).project.id;
    const projectB = (
      await app.projectService.registerRepository({
        repositoryPath: box.repos.cloneB,
        displayName: 'proj-b',
      })
    ).project.id;
    const plan = planOf(VERSION_CHECK);
    const preview = await app.baselineService.previewBaseline(OWNER, projectA, { plan });
    const accepted = await app.baselineExecutionService.submit(
      OWNER,
      commandEnvelope('baseline.run', { kind: 'project', projectId: projectA }, {
        decision: 'authorize',
        plan,
        previewDigest: preview.previewDigest,
      }),
    );
    const operationId = acceptedOf(accepted);
    await app.baselineExecutionService.waitForIdle();
    const checkRows = app.baselineStore.listBaselineCheckResults(operationId);
    const artifactId = checkRows[0]?.outputArtifactId;
    expect(typeof artifactId).toBe('string');

    const ownerServer = await startAppServer(app, OWNER);
    const restricted = createRestrictedPrincipal({
      capabilities: ['baseline.read', 'baseline.run'],
      projectScope: scopeAllowlist([projectB]),
    });
    const restrictedServer = await startAppServer(app, restricted);
    const noBaselineRead = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: scopeAllowlist([projectA]),
    });
    const noReadServer = await startAppServer(app, noBaselineRead);

    const get = (port: number, path: string) =>
      loopbackRequest({ port, method: 'GET', path, token: STUB_TOKEN });
    const post = (port: number, body: unknown) =>
      loopbackRequest({ port, method: 'POST', path: '/v1/commands', token: STUB_TOKEN, body });

    // 拒绝前的状态/文件基线。
    const rowsBefore = {
      operations: readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations'),
      checks: readRows(app, 'SELECT COUNT(*) AS c FROM baseline_check_results'),
      receipts: readRows(app, 'SELECT COUNT(*) AS c FROM command_receipts'),
      artifacts: readRows(app, 'SELECT COUNT(*) AS c FROM artifacts'),
    };
    const filesBefore = workspaceFiles(box.repos.withHead);

    // 跨项目（受限主体只见项目 B）：operationId/artifactId 一律不可见。
    const crossGet = await get(restrictedServer.port, `/v1/baselines/${operationId}`);
    expect(crossGet.statusCode).toBe(404);
    const crossList = await get(restrictedServer.port, `/v1/projects/${projectA}/baselines`);
    expect(crossList.statusCode).toBe(403);
    const crossArtifact = await get(
      restrictedServer.port,
      `/v1/artifacts/${artifactId}/content`,
    );
    expect(crossArtifact.statusCode).toBe(404);
    expect(crossArtifact.bodyText).not.toContain('v' + process.version.slice(1));
    // 跨项目取消（scope 可见但操作归属其他项目）→ not_found。
    const crossCancel = await post(
      restrictedServer.port,
      commandEnvelope('baseline.cancel', { kind: 'project', projectId: projectB }, { operationId }),
    );
    expect(crossCancel.statusCode).toBe(404);

    // 能力缺失主体：baselines.get → forbidden；artifacts.get → 统一 not_found（防枚举）。
    const noReadGet = await get(noReadServer.port, `/v1/baselines/${operationId}`);
    expect(noReadGet.statusCode).toBe(403);
    const noReadArtifact = await get(noReadServer.port, `/v1/artifacts/${artifactId}/content`);
    expect(noReadArtifact.statusCode).toBe(404);
    const noReadList = await get(noReadServer.port, `/v1/projects/${projectA}/baselines`);
    expect(noReadList.statusCode).toBe(403);

    // 任意路径读取形态：表外路径 404 unknown_operation；伪造制品身份 404；
    // 穿越形态的路径段不是合法稳定 ID → 统一 not_found，且永不返回文件内容。
    for (const path of [
      '/v1/files?path=/etc/passwd',
      '/v1/artifacts//content',
      '/v1/artifacts',
      `/v1/artifacts/${randomUUID()}/content`,
    ]) {
      const response = await get(ownerServer.port, path);
      expect([404]).toContain(response.statusCode);
      expect(response.bodyText).not.toContain('root:');
    }
    const traversal = await get(
      ownerServer.port,
      '/v1/artifacts/..%2F..%2Fetc%2Fpasswd/content',
    );
    expect(traversal.statusCode).toBe(404);
    expect(traversal.bodyText).not.toContain('root:');

    // 非法输入：非 UUID operationId、非法分页、未知查询参数、未知 schema 版本。
    const badId = await get(ownerServer.port, '/v1/baselines/not-a-uuid');
    expect(badId.statusCode).toBe(400);
    for (const query of ['limit=0', 'limit=abc', 'limit=1&limit=2', 'bogus=1']) {
      const response = await get(ownerServer.port, `/v1/projects/${projectA}/baselines?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
    const legacy = await post(
      ownerServer.port,
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, { plan }, { schemaVersion: 2 }),
    );
    expect(legacy.statusCode).toBe(400);

    // 伪环境引用与 cwd 逃逸：预览即拒绝（fail-closed，零副作用）。
    const fakeEnv = await post(
      ownerServer.port,
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, {
        plan: { checks: [{ ...VERSION_CHECK, environmentRef: 'ghost-env' }] },
      }),
    );
    expect(fakeEnv.statusCode).toBe(400);
    const escapeCwd = await post(
      ownerServer.port,
      commandEnvelope('baseline.preview', { kind: 'project', projectId: projectA }, {
        plan: { checks: [{ ...VERSION_CHECK, cwdRef: '../../outside' }] },
      }),
    );
    expect(escapeCwd.statusCode).toBe(400);

    // 状态与文件不变：基线/回执/制品行数与仓库工作区文件集合逐一致。
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toEqual(rowsBefore.operations);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_check_results')).toEqual(rowsBefore.checks);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM command_receipts')).toEqual(rowsBefore.receipts);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM artifacts')).toEqual(rowsBefore.artifacts);
    expect(workspaceFiles(box.repos.withHead)).toEqual(filesBefore);
  }, 120_000);
});
