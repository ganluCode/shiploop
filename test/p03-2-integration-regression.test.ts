/**
 * P03-2 / F-009 跨模块集成回归与交付门禁（真实 dist CLI + 正式构建 Host）。
 *
 * 定位：F-009 验收——在 F-001~F-008 已交付能力上做**正式构建产物**端到端跨模块
 * 回归，验证批准身份、策略不漂移、历史增长不膨胀的完整可审计流程：
 * - 主线：三 Task 合法导入 → 查看策略（modelMap/default 副本）→ 批准前可选
 *   覆盖（task_edit 来源）→ 指定摘要批准 → 准备输入制品组 → `host stop`
 *   （三证据 + pid 退出）→ 重开后读取复验（查询/回执/制品正文逐字节一致）；
 *   断言 Task 数量与 ID 不变、未创建 Batch/Run/Attempt、未调用真实模型、
 *   未启动 Work（表/事件/命令面三方核验）；
 * - 漂移矩阵：项目 modelMap 更新不追溯既有 Task 策略；修改非活动 Task 副本后
 *   新输入改变而旧正文与摘要逐字节不变；检查政策或要求改变时旧批准和旧输入
 *   不能作为当前执行依据（fail-closed 明确原因）；纯标签编辑不导致无关失效；
 * - 历史增长与 fail-closed：大段报告制品与事件增长后 prompt 有界且逐字节
 *   不变、全部 acceptance 可读取；必需输入缺失/篡改/越界/超预算/跨项目访问
 *   fail-closed，输出有明确原因且无秘密与路径泄漏。
 *
 * 正式构建路径：全部命令经真实 `packages/cli/dist/bin.js` 子进程；Host 用
 * `npm run build` 的 dist 产物（dist-host-entry-catalog.mjs 装配 dist/runtime
 * 与 dist/core，受信测试能力目录只服务配置/策略复检，不是产品能力放宽）。
 * 审批有效性与制品正文读取复验经正式 Host HTTP 传输面（与 HostClient 同一
 * 路由），测试只以只读 SQLite 探针做第三方审计（P03-1 同一纪律）。
 *
 * 覆盖标注（T 矩阵，详见 docs/p03-2-handoff.md）：T24（策略副本/默认更新不
 * 追溯/用户覆盖）、T25 输入子集（快照不可变/旧正文逐字节不变；活动 Attempt
 * 竞争与预算清零 not_run——无 Run/Attempt 实体）、T26 审批子集（过期审批
 * 失效：plan_changed/check_policy_changed/纯标签不失效；配置 CAS 冲突沿用
 * 既有回归）、T37（历史增长不膨胀 prompt、acceptance 全量可读、必需输入
 * 缺失拒绝）。不宣称后序执行（startRun/Work/Runtime）或会话能力通过。
 *
 * 复用既有夹具（isolated-environment / git-repo / storage-probe /
 * http-probe），不另建体系；不读真实凭据、不联网、不调用模型、不修改开发
 * 仓库或用户 HOME；不对开发仓库作破坏性 Git 演练；全部等待有界。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { openStorageProbe, type StorageProbe } from './helpers/p02-2/storage-probe.ts';
import { loopbackRequest } from './helpers/host/http-probe.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { COMMAND_OPERATIONS } from '../packages/core/src/ports/commands.ts';
import { PUBLIC_STATE_EVENT_TYPES } from '../packages/core/src/ports/events.ts';
import { DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET } from '../packages/core/src/application/execution-input-prepare.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 真实 dist CLI 可执行入口（npm run build 产物，与生产同一入口）。 */
const DIST_CLI_BIN = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
/** 装配 dist 产物的 Host 入口（受信测试能力目录；纪律见文件头）。 */
const DIST_CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/dist-host-entry-catalog.mjs', import.meta.url),
);

/** 生产冻结缺省 prompt 上限（F-006 定案；与 Core 常量同源，不另立数值）。 */
const MAX_PROMPT_BYTES = DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET.maxPromptBytes;

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  if (!existsSync(DIST_CLI_BIN)) {
    throw new Error(`正式构建产物缺失：dist CLI 入口 ${DIST_CLI_BIN}；npm run build 未产出`);
  }
}, 570_000);

/* ------------------------------------------------------------------ *
 * 进程/CLI 小工具（与 F-008 构建后 CLI、P03-1 集成回归同一口径）
 * ------------------------------------------------------------------ */

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

interface DiscoveryRecord {
  readonly pid?: unknown;
  readonly port?: unknown;
}

function readDiscovery(root: string): DiscoveryRecord | undefined {
  const file = join(root, 'host', 'discovery.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord;
  } catch {
    return undefined;
  }
}

const OUTPUT_CAP_BYTES = 1 << 20;

interface DistCliInvocation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runDistCli(
  env: IsolatedHostEnvironment,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<DistCliInvocation> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [DIST_CLI_BIN, ...args], {
      cwd: env.sandboxRoot,
      env: env.childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      rejectRun(new Error(`dist CLI 超时（${timeoutMs}ms）：shiploop ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < OUTPUT_CAP_BYTES) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.length < OUTPUT_CAP_BYTES) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (stdoutBytes > OUTPUT_CAP_BYTES || stderrBytes > OUTPUT_CAP_BYTES) {
        rejectRun(new Error(`dist CLI 输出超限：shiploop ${args.join(' ')}`));
        return;
      }
      resolveRun({ exitCode: code, signal, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    commandId?: string;
    details?: Record<string, unknown>;
  };
}

function parseEnvelope(invocation: DistCliInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function successResult(invocation: DistCliInvocation, command: string): Record<string, unknown> {
  expect(invocation.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(
  invocation: DistCliInvocation,
  exitCode: number,
  code: string,
): EnvelopeShape['error'] {
  expect(invocation.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as EnvelopeShape['error'];
  expect(error?.code).toBe(code);
  return error;
}

/** dist 产物 Host（受信测试能力目录）拉起/停止。 */
const spawnedHostPids: number[] = [];

async function startCatalogHost(
  env: IsolatedHostEnvironment,
  root: string,
  label: string,
): Promise<{ pid: number; port: number }> {
  const child = spawn(process.execPath, [DIST_CATALOG_HOST_ENTRY, '--data-root', root], {
    cwd: env.sandboxRoot,
    env: env.childEnv(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  expect(typeof child.pid).toBe('number');
  spawnedHostPids.push(child.pid as number);
  const deadline = Date.now() + 45_000;
  let lastState = 'discovery 未发布';
  while (Date.now() < deadline) {
    const discovery = readDiscovery(root);
    if (discovery !== undefined && typeof discovery.pid === 'number' && typeof discovery.port === 'number') {
      lastState = `discovery pid=${discovery.pid} port=${discovery.port}`;
      if (discovery.pid === child.pid && pidAlive(discovery.pid)) {
        return { pid: discovery.pid, port: discovery.port };
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`dist Host 启动等待超时（${label}）：${lastState}`);
}

async function stopHostViaDistCli(
  env: IsolatedHostEnvironment,
  root: string,
  pid: number,
): Promise<void> {
  const stopped = await runDistCli(env, ['host', 'stop', '--data-root', root, '--json']);
  const result = successResult(stopped, 'host.stop');
  expect(result.status).toBe('stopped');
  await waitFor(() => !pidAlive(pid), 15_000, `host pid ${pid} 实际退出`);
}

afterEach(async () => {
  for (const pid of spawnedHostPids.splice(0)) {
    if (!pidAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 已退出。
    }
    try {
      await waitFor(() => !pidAlive(pid), 10_000, `兜底 SIGTERM 后 host pid ${pid} 退出`);
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出。
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * 正式 Host HTTP 传输面（审批有效性查询 / 制品正文校验读取）
 * ------------------------------------------------------------------ */

interface ApprovalValidityShape {
  readonly valid: boolean;
  readonly reason: string;
  readonly planDigest?: string;
  readonly checkPolicyDigest?: string;
}

interface ApprovalsResponseShape {
  readonly feature: { planDigest: string; planStatus: string };
  readonly currentDecision: { status: string; subjectDigest: string } | null;
  readonly decisions: { status: string; subjectDigest: string; current: boolean }[];
  readonly validity: ApprovalValidityShape;
}

/** 经正式 Host HTTP 路由查询审批有效性（与 HostClient.getFeatureApprovals 同一路由）。 */
async function queryApprovals(
  root: string,
  port: number,
  featureId: string,
): Promise<ApprovalsResponseShape> {
  const token = readFileSync(join(root, 'host', 'auth.token'), 'utf8');
  const response = await loopbackRequest({
    port,
    method: 'GET',
    path: `/v1/features/${featureId}/approvals`,
    token,
    maxResponseBytes: 262_144,
  });
  expect(response.statusCode, response.bodyText).toBe(200);
  return response.json() as ApprovalsResponseShape;
}

/* ------------------------------------------------------------------ *
 * 只读 SQLite 探针（第三方审计：表清单/事件/回执）
 * ------------------------------------------------------------------ */

function openProbe(root: string): StorageProbe {
  return openStorageProbe(join(root, DATABASE_FILE_NAME));
}

function sqliteTableNames(probe: StorageProbe): string[] {
  return probe
    .selectAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .map((row) => row.name);
}

function projectEventTypes(probe: StorageProbe, projectId: string): string[] {
  return probe
    .selectAll<{ event_type: string }>(
      'SELECT event_type FROM state_events WHERE project_id = ? ORDER BY sequence',
      [projectId],
    )
    .map((row) => row.event_type);
}

function receiptStatus(probe: StorageProbe, commandId: string): string | undefined {
  const row = probe.selectOne<{ status: string }>(
    'SELECT status FROM command_receipts WHERE principal_id = ? AND command_id = ?',
    ['local-owner', commandId],
  );
  return row?.status;
}

/** 「未创建 Batch/Run/Attempt、未启动 Work」三方核验之一：库表清单与行数。 */
function expectNoExecutionEntities(probe: StorageProbe): void {
  const tables = sqliteTableNames(probe);
  // Migration-created execution tables must remain empty in this planning-only flow.
  const present = tables.filter((name) => /batch|run|attempt|work/i.test(name)).sort();
  expect(present, `执行域表清单漂移（实际表：${tables.join(',')}）`).toEqual([
    'attempts',
    'attempt_notifications',
    'attempt_notification_diagnostics',
    'workspace_leases',
    'batch_budget_revisions',
    'execution_batches',
    'runs',
    // P03-3 / F-006 起预占账本表由迁移 v11 建立（空表）：仍不代表创建执行实体。
    'task_attempt_reservations',
    // P03-3 / F-007 起启动预占账本表由迁移 v12 建立（空表）：仍不代表启动 Runtime。
    'runtime_start_reservations',
    'run_outcome_settlements',
  ].sort());
  for (const table of present) {
    expect(probe.selectAll(`SELECT COUNT(*) AS n FROM ${table}`), `${table} 不得有执行实体行`).toEqual([
      { n: 0 },
    ]);
  }
}

/**
 * 三方核验之二：本会话事件全部落在冻结白名单内，且不含任何执行启动事件
 *（baseline.* 是 P02 检查域命令，本场景未触发；Work/Runtime 事件面不存在）。
 */
function expectEventsWithinWhitelist(eventTypes: readonly string[]): void {
  for (const eventType of eventTypes) {
    expect(PUBLIC_STATE_EVENT_TYPES, `事件 ${eventType} 必须在冻结白名单内`).toContain(eventType);
  }
  const executionEvents = eventTypes.filter(
    (eventType) => /^(work|run|attempt|batch|runtime|model)\./i.test(eventType),
  );
  expect(executionEvents).toEqual([]);
  expect(eventTypes.some((eventType) => eventType.startsWith('baseline.'))).toBe(false);
}

/** 三方核验之三：命令面不提供 Task 执行/模型调用入口（白名单冻结事实）。 */
function expectNoExecutionStartOperations(): void {
  const nonBaseline = COMMAND_OPERATIONS.filter((operation) => !operation.startsWith('baseline.'));
  const executionOps = nonBaseline.filter((operation) =>
    /^(work|run|attempt|batch)s?\./i.test(operation) || /runtime|model|invoke/i.test(operation),
  );
  expect(executionOps, '命令白名单不得包含 Work/Run/模型调用操作').toEqual([]);
}

/* ------------------------------------------------------------------ *
 * 计划/配置/制品夹具
 * ------------------------------------------------------------------ */

function globalConfigPayload(options?: { modelMapLowModel?: string; checksBeforeDone?: boolean }): Record<string, unknown> {
  return {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: {
        runtime: 'pi',
        provider: 'anthropic',
        model: 'claude-opus',
        credentialRef: 'keychain://shiploop/global-default',
      },
      modelMap: {
        low: {
          runtime: 'pi',
          provider: 'anthropic',
          model: options?.modelMapLowModel ?? 'claude-sonnet',
        },
      },
    },
    policies: {
      executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 },
      verification: { requireChecksBeforeDone: options?.checksBeforeDone ?? true },
    },
  };
}

const STRATEGY_OVERRIDE = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-sonnet',
} as const;

const STRATEGY_OVERRIDE_2 = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-opus',
} as const;

/** 合法三 Task 链计划（t-1 low → t-2 medium → t-3 low）。 */
function samplePlan(options?: { t1Criterion?: string }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: 'F-009 跨模块回归 Feature',
      description: '批准/策略/输入与历史增长集成回归',
      labels: ['integration'],
      sourceRefs: [],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        complexity: 'low',
        acceptance: { criteria: [options?.t1Criterion ?? '任务一验收：副本不漂移'] },
      },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收：批准绑定当前摘要'] },
        dependsOn: ['t-1'],
      },
      {
        id: 't-3',
        title: '任务三',
        complexity: 'low',
        acceptance: { criteria: ['任务三验收：旧正文不可变'] },
        dependsOn: ['t-2'],
      },
    ],
  };
}

interface SeededProject {
  readonly root: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly host: { pid: number; port: number };
}

/** 项目 + 全局配置 + Phase + 三 Task 导入（全部经 dist CLI 真实命令）。 */
async function seedThreeTaskPlan(
  env: IsolatedHostEnvironment,
  label: string,
): Promise<{ seed: SeededProject; writeInput: (name: string, value: unknown) => string }> {
  const root = env.dataRoot('app').canonicalRoot;
  const home = env.childEnv().HOME as string;
  const repoDir = join(env.sandboxRoot, `repo-${label}`);
  initGitRepo(repoDir);
  writeFileSync(join(repoDir, 'README.md'), `# Repo ${label}\n`, 'utf8');
  commitAll(repoDir, `init ${label}`, { home });

  const host = await startCatalogHost(env, root, label);

  const writeInput = (name: string, value: unknown): string => {
    const path = join(env.sandboxRoot, name);
    writeFileSync(path, JSON.stringify(value), 'utf8');
    return path;
  };

  const registered = successResult(
    await runDistCli(env, ['project', 'register', repoDir, '--name', `F-009 ${label}`, '--data-root', root, '--json']),
    'project.register',
  ) as { result: { project: { id: string } } };
  const projectId = registered.result.project.id;
  successResult(
    await runDistCli(env, [
      'config', 'create', '--scope', 'global',
      '--input', writeInput(`config-${label}.json`, globalConfigPayload()),
      '--data-root', root, '--json',
    ]),
    'config.create',
  );
  const created = successResult(
    await runDistCli(env, ['phase', 'create', '--project', projectId, '--title', '阶段一', '--data-root', root, '--json']),
    'phase.create',
  ) as { result: { phase: { id: string } } };
  const imported = successResult(
    await runDistCli(env, [
      'feature', 'import',
      '--project', projectId,
      '--phase', created.result.phase.id,
      '--revision', '1',
      '--input', writeInput(`plan-${label}.json`, samplePlan()),
      '--data-root', root, '--json',
    ]),
    'feature.import',
  ) as { result: { feature: { id: string; planDigest: string } } };
  return {
    seed: {
      root,
      projectId,
      phaseId: created.result.phase.id,
      featureId: imported.result.feature.id,
      planDigest: imported.result.feature.planDigest,
      host,
    },
    writeInput,
  };
}

/**
 * 夹具登记 ready 受管制品（固定输入来源身份；仅测试装配）。
 * 提供-content 时同时落盘真实正文文件（报告增长/篡改场景）。
 */
async function seedReadyArtifact(
  root: string,
  projectId: string,
  name: string,
  options?: { content?: string; declaredSizeBytes?: number },
): Promise<string> {
  const content = options?.content ?? `fixture-${name}`;
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  const session = openSqliteStorageSession({ path: join(root, DATABASE_FILE_NAME) });
  try {
    await migrateSqliteStorage(session);
    const artifactStore = createSqliteArtifactStore(session, { nowUtcMs: () => Date.now() });
    const record = await artifactStore.registerArtifact({
      projectId,
      kind: 'report',
      mediaType: 'text/markdown',
      expectedHash: contentHash,
      locator: `artifacts/${name}.md`,
    });
    await artifactStore.transitionArtifact(projectId, record.id, {
      expectedRevision: record.revision,
      outcome: {
        status: 'ready',
        actualHash: contentHash,
        sizeBytes: options?.declaredSizeBytes ?? Buffer.byteLength(content, 'utf8'),
      },
    });
    if (options?.content !== undefined) {
      const bodyPath = join(root, 'projects', projectId, 'artifacts', record.id, 'content');
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, content, 'utf8');
    }
    return record.id;
  } finally {
    session.close();
  }
}

/** 制品正文物理路径（受控数据根内 projects/<projectId>/artifacts/<artifactId>/content；探针用途，不是产品读取面）。 */
function artifactBodyPath(root: string, projectId: string, artifactId: string): string {
  return join(root, 'projects', projectId, 'artifacts', artifactId, 'content');
}

interface PreparedGroupPart {
  readonly purpose: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly locator: string;
}

interface PrepareResultShape {
  readonly commandId: string;
  readonly bindable: boolean;
  readonly group: PreparedGroupPart[];
  readonly requiredInputs: { purpose: string; contentHash: string }[];
  readonly approval: { planDigest: string };
  readonly execution: { started: boolean; runnable: boolean };
}

/** task prepare（固定输入制品组准备）成功结果。 */
async function prepareInputs(
  env: IsolatedHostEnvironment,
  seed: SeededProject,
  taskId: string,
  itemsPath: string,
): Promise<PrepareResultShape> {
  return successResult(
    await runDistCli(env, [
      'task', 'prepare', taskId,
      '--project', seed.projectId,
      '--feature', seed.featureId,
      '--input', itemsPath,
      '--data-root', seed.root, '--json',
    ]),
    'task.prepare',
  ) as unknown as PrepareResultShape;
}

/** 输出纪律：错误/帮助输出不得泄漏沙箱路径、开发机前缀或秘密值。 */
function expectNoLeaks(invocation: DistCliInvocation, env: IsolatedHostEnvironment, extra: readonly string[] = []): void {
  for (const channel of [invocation.stdout, invocation.stderr]) {
    expect(channel).not.toContain(env.sandboxRoot);
    expect(channel).not.toContain('/Users/');
    for (const marker of extra) {
      expect(channel).not.toContain(marker);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 回归主体
 * ------------------------------------------------------------------ */

describe('F-009 P03-2 跨模块集成回归（正式构建 Host/CLI + 隔离真实 SQLite）', () => {
  let env: IsolatedHostEnvironment;

  afterEach(async () => {
    await env.dispose();
  });

  it('主线：三 Task 查看策略 → 批准前覆盖 → 指定摘要批准 → 准备输入 → 停机重开读取复验；无执行实体/未调用真实模型/未启动 Work', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f009-main-' });
    const { seed, writeInput } = await seedThreeTaskPlan(env, 'main');
    const { root, projectId, featureId, planDigest, host } = seed;

    // 1) 查看策略：modelMap.low → sonnet；medium 回落 defaultStrategy → opus。
    for (const [taskId, expectedModel] of [
      ['t-1', 'claude-sonnet'],
      ['t-2', 'claude-opus'],
      ['t-3', 'claude-sonnet'],
    ] as const) {
      const task = successResult(
        await runDistCli(env, ['task', 'get', taskId, '--data-root', root, '--json']),
        'task.get',
      ) as { task: { executionConfig: { model: string }; configSource: string } };
      expect(task.task.executionConfig.model, taskId).toBe(expectedModel);
      expect(task.task.configSource).toBe('global_default');
    }

    // 2) 批准前可选覆盖：完整副本 CAS 替换（来源 task_edit），摘要不变。
    const overridden = successResult(
      await runDistCli(env, [
        'task', 'strategy', 't-2',
        '--project', projectId,
        '--revision', '1',
        '--input', writeInput('override.json', STRATEGY_OVERRIDE),
        '--data-root', root, '--json',
      ]),
      'task.strategy',
    ) as { strategy: { executionConfig: Record<string, unknown>; configSource: string } };
    expect(overridden.strategy.executionConfig).toEqual(STRATEGY_OVERRIDE);
    expect(overridden.strategy.configSource).toBe('task_edit');
    const beforeApprove = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string; planStatus: string } };
    expect(beforeApprove.feature.planDigest).toBe(planDigest);
    expect(beforeApprove.feature.planStatus).toBe('draft');

    // 3) 指定摘要批准：实际计划身份 + 未启动执行。
    const approveCommandId = randomUUID();
    const approved = successResult(
      await runDistCli(env, [
        'feature', 'approve', featureId,
        '--project', projectId,
        '--digest', planDigest,
        '--revision', '1',
        '--command-id', approveCommandId,
        '--data-root', root, '--json',
      ]),
      'feature.approve',
    ) as {
      replayed: boolean;
      feature: { planDigest: string; planStatus: string };
      approval: { status: string; subjectDigest: string };
      execution: { started: boolean; runnable: boolean };
    };
    expect(approved.replayed).toBe(false);
    expect(approved.feature.planDigest).toBe(planDigest);
    expect(approved.feature.planStatus).toBe('approved');
    expect(approved.approval).toMatchObject({ status: 'approved', subjectDigest: planDigest });
    expect(approved.execution).toEqual({ started: false, capability: 'unknown', runnable: false });

    // 4) 准备输入：制品组 version/hash/用途 + 逐字节正文留档。
    const artifactId = await seedReadyArtifact(root, projectId, 'main-requirements', {
      content: '# 需求正文\n集成回归必需输入。',
    });
    const prepared = await prepareInputs(
      env,
      seed,
      't-2',
      writeInput('main-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }],
      }),
    );
    expect(prepared.bindable).toBe(true);
    expect(prepared.group.map((part) => part.purpose)).toEqual(['snapshot', 'manifest', 'prompt']);
    for (const part of prepared.group) {
      expect(part.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(part.locator).toBe(`execution-input-groups/t-2/${part.purpose}`);
    }
    expect(prepared.approval.planDigest).toBe(planDigest);
    expect(prepared.execution.started).toBe(false);
    const groupBodiesBefore = new Map(
      prepared.group.map((part) => [
        part.purpose,
        readFileSync(artifactBodyPath(root, projectId, part.artifactId), 'utf8'),
      ]) as [string, string][],
    );

    // 5) Task 数量与 ID 不变；无执行实体/事件白名单/命令面三方核验。
    const detail = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { tasks: { id: string }[]; notExecutableReasons: string[] };
    expect(detail.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(detail.notExecutableReasons).toEqual([]);
    {
      const probe = openProbe(root);
      try {
        expectNoExecutionEntities(probe);
        expectEventsWithinWhitelist(projectEventTypes(probe, projectId));
        expect(receiptStatus(probe, approveCommandId)).toBe('completed');
        expect(receiptStatus(probe, prepared.commandId)).toBe('completed');
        expect(projectEventTypes(probe, projectId)).toEqual([
          'project.registered',
          'phase.created',
          'feature.plan.imported',
          'task.strategy.updated',
          'feature.plan.approved',
          'execution.input.prepared',
        ]);
      } finally {
        probe.close();
      }
      expectNoExecutionStartOperations();
    }

    // 6) 停机重开：host stop（status=stopped + pid 退出）→ 重新拉起 → 读取复验。
    await stopHostViaDistCli(env, root, host.pid);
    const host2 = await startCatalogHost(env, root, '主线重开');

    const detailAfter = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string; planStatus: string }; tasks: { id: string }[] };
    expect(detailAfter.feature.planDigest).toBe(planDigest);
    expect(detailAfter.feature.planStatus).toBe('approved');
    expect(detailAfter.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);

    const strategyAfter = successResult(
      await runDistCli(env, ['task', 'get', 't-2', '--data-root', root, '--json']),
      'task.get',
    ) as { task: { executionConfig: Record<string, unknown>; configSource: string } };
    expect(strategyAfter.task.executionConfig).toEqual(STRATEGY_OVERRIDE);
    expect(strategyAfter.task.configSource).toBe('task_edit');

    const viewed = successResult(
      await runDistCli(env, ['task', 'inputs', prepared.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as { commandId: string; group: PreparedGroupPart[]; execution: { started: boolean } };
    expect(viewed.commandId).toBe(prepared.commandId);
    expect(viewed.group).toEqual(prepared.group);
    expect(viewed.execution.started).toBe(false);

    // 制品正文逐字节不变（重开不重写历史输入）。
    for (const part of prepared.group) {
      const body = readFileSync(artifactBodyPath(root, projectId, part.artifactId), 'utf8');
      expect(body).toBe(groupBodiesBefore.get(part.purpose));
    }

    // 审批有效性经正式 Host HTTP 面查询（重开后仍成立；artifacts.get 仅限
    // P02-3 基线输出成员，执行输入正文无通用读取面——防枚举边界，见交接文档）。
    const approvals = await queryApprovals(root, host2.port, featureId);
    expect(approvals.validity).toMatchObject({ valid: true, reason: 'approved', planDigest });
    expect(approvals.feature.planDigest).toBe(planDigest);
    expect(approvals.feature.planStatus).toBe('approved');

    // 重开零新增事件（审计行不变；settings.global_created 属全局事件不在项目流内）。
    {
      const probe = openProbe(root);
      try {
        expect(projectEventTypes(probe, projectId)).toHaveLength(6);
      } finally {
        probe.close();
      }
    }

    await stopHostViaDistCli(env, root, host2.pid);
  }, 420_000);

  it('漂移矩阵：modelMap 不追溯；副本编辑后新输入改变旧正文不变；检查政策/要求改变旧批准旧输入失效；纯标签不误伤', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f009-drift-' });
    const { seed, writeInput } = await seedThreeTaskPlan(env, 'drift');
    const { root, projectId, featureId, planDigest } = seed;

    // 批准 + 首份输入（I1：t-3 使用 modelMap.low 副本）。
    successResult(
      await runDistCli(env, [
        'feature', 'approve', featureId,
        '--project', projectId, '--digest', planDigest, '--revision', '1',
        '--data-root', root, '--json',
      ]),
      'feature.approve',
    );
    const reqArtifact = await seedReadyArtifact(root, projectId, 'drift-requirements', {
      content: '# 漂移矩阵需求正文',
    });
    const itemsPath = writeInput('drift-items.json', {
      items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: reqArtifact } }],
    });
    const i1 = await prepareInputs(env, seed, 't-3', itemsPath);
    const i1Bodies = new Map(
      i1.group.map((part) => [
        part.purpose,
        readFileSync(artifactBodyPath(root, projectId, part.artifactId), 'utf8'),
      ]) as [string, string][],
    );
    const i1SnapshotDigest = i1.group.find((part) => part.purpose === 'snapshot')?.contentHash;

    // A) 项目默认 modelMap 更新不追溯既有 Task 策略（F-001/F-003 纪律）。
    successResult(
      await runDistCli(env, [
        'config', 'update', '--scope', 'global', '--revision', '1',
        '--input', writeInput('config-modelmap.json', globalConfigPayload({ modelMapLowModel: 'claude-opus' })),
        '--data-root', root, '--json',
      ]),
      'config.update',
    );
    const t1After = successResult(
      await runDistCli(env, ['task', 'get', 't-1', '--data-root', root, '--json']),
      'task.get',
    ) as { task: { executionConfig: { model: string }; configSource: string } };
    expect(t1After.task.executionConfig.model).toBe('claude-sonnet');
    expect(t1After.task.configSource).toBe('global_default');
    // modelMap 变化不进入捕获身份：t-1 准备照常可绑定（不误报业务失效）。
    const driftFreePrepare = await prepareInputs(env, seed, 't-1', itemsPath);
    expect(driftFreePrepare.bindable).toBe(true);
    expect(driftFreePrepare.approval.planDigest).toBe(planDigest);

    // B) 修改非活动 Task 副本 → 新输入改变；旧正文与摘要保持原值。
    successResult(
      await runDistCli(env, [
        'task', 'strategy', 't-3',
        '--project', projectId, '--revision', '1',
        '--input', writeInput('t3-strategy.json', STRATEGY_OVERRIDE_2),
        '--data-root', root, '--json',
      ]),
      'task.strategy',
    );
    const i2 = await prepareInputs(env, seed, 't-3', itemsPath);
    expect(i2.commandId).not.toBe(i1.commandId);
    const i2SnapshotDigest = i2.group.find((part) => part.purpose === 'snapshot')?.contentHash;
    expect(i2SnapshotDigest).not.toBe(i1SnapshotDigest);
    const i2SnapshotBody = readFileSync(
      artifactBodyPath(root, projectId, i2.group.find((part) => part.purpose === 'snapshot')?.artifactId as string),
      'utf8',
    );
    expect(i2SnapshotBody).toContain('claude-opus');
    // 旧制品组逐字节不变（历史输入不可变），历史回执仍可读取原身份。
    for (const part of i1.group) {
      expect(readFileSync(artifactBodyPath(root, projectId, part.artifactId), 'utf8')).toBe(
        i1Bodies.get(part.purpose),
      );
    }
    const i1Receipt = successResult(
      await runDistCli(env, ['task', 'inputs', i1.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as { group: PreparedGroupPart[] };
    expect(i1Receipt.group).toEqual(i1.group);

    // C) 纯标签编辑：摘要不变、批准不失效、新准备照常通过（批准已将 Feature
    //    revision 递增至 2，标签 CAS 从 2 起）。
    successResult(
      await runDistCli(env, [
        'feature', 'labels', featureId,
        '--project', projectId, '--revision', '2', '--label', 'drift-check',
        '--data-root', root, '--json',
      ]),
      'feature.labels',
    );
    const afterLabels = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string; planStatus: string } };
    expect(afterLabels.feature.planDigest).toBe(planDigest);
    expect(afterLabels.feature.planStatus).toBe('approved');
    const labelSafePrepare = await prepareInputs(env, seed, 't-1', itemsPath);
    expect(labelSafePrepare.bindable).toBe(true);

    // D) 检查政策改变：旧批准失效（HTTP 审批查询明确原因）+ 新准备 fail-closed；
    //    恢复同内容政策后批准自动恢复（内容身份，非 revision）。
    successResult(
      await runDistCli(env, [
        'config', 'update', '--scope', 'global', '--revision', '2',
        '--input', writeInput('config-policy.json', globalConfigPayload({ modelMapLowModel: 'claude-opus', checksBeforeDone: false })),
        '--data-root', root, '--json',
      ]),
      'config.update',
    );
    const host = await readDiscovery(root);
    const port = host?.port as number;
    const invalidApprovals = await queryApprovals(root, port, featureId);
    expect(invalidApprovals.validity).toMatchObject({ valid: false, reason: 'check_policy_changed', planDigest });
    expect(invalidApprovals.currentDecision?.status).toBe('approved');
    const policyDrift = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId, '--input', itemsPath,
      '--data-root', root, '--json',
    ]);
    const policyDriftError = failureOf(policyDrift, 1, 'conflict');
    expect((policyDriftError?.details as { reason?: string })?.reason).toBe('check_policy_changed');
    expectNoLeaks(policyDrift, env);
    // 旧输入回执仍可读取（历史证据），但其不再满足当前前置条件（上方新准备已拒绝）。
    const stillViewable = successResult(
      await runDistCli(env, ['task', 'inputs', i1.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as { group: PreparedGroupPart[] };
    expect(stillViewable.group).toEqual(i1.group);
    // 恢复原检查政策内容 → 批准按内容身份恢复有效。
    successResult(
      await runDistCli(env, [
        'config', 'update', '--scope', 'global', '--revision', '3',
        '--input', writeInput('config-restored.json', globalConfigPayload({ modelMapLowModel: 'claude-opus' })),
        '--data-root', root, '--json',
      ]),
      'config.update',
    );
    const restoredApprovals = await queryApprovals(root, port, featureId);
    expect(restoredApprovals.validity).toMatchObject({ valid: true, reason: 'approved', planDigest });
    const restoredPrepare = await prepareInputs(env, seed, 't-1', itemsPath);
    expect(restoredPrepare.bindable).toBe(true);

    // E) 要求改变（实质修订 t-1 验收）：旧批准失效 → 重新批准当前身份恢复
    //   （Feature revision：导入 1 → 批准 2 → 标签 3 → 修订 4）。
    const revised = successResult(
      await runDistCli(env, [
        'feature', 'revise', featureId,
        '--project', projectId, '--revision', '3',
        '--input', writeInput('plan-revised.json', samplePlan({ t1Criterion: '任务一验收：修订后的更严格口径' })),
        '--data-root', root, '--json',
      ]),
      'feature.revise',
    ) as { result: { feature: { revision: number; planStatus: string; planDigest: string }; memberChanges: { keptTaskCount: number } } };
    const digest2 = revised.result.feature.planDigest;
    expect(digest2).not.toBe(planDigest);
    expect(revised.result.feature.planStatus).toBe('draft');
    expect(revised.result.memberChanges.keptTaskCount).toBe(3);
    // Task 数量与 ID 不变（成员保留稳定身份）。
    const afterRevise = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { tasks: { id: string }[]; notExecutableReasons: string[] };
    expect(afterRevise.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(afterRevise.notExecutableReasons).toEqual(['plan_not_approved']);
    const revisedApprovals = await queryApprovals(root, port, featureId);
    expect(revisedApprovals.validity).toMatchObject({ valid: false, reason: 'plan_changed', planDigest: digest2 });
    const planDrift = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId, '--input', itemsPath,
      '--data-root', root, '--json',
    ]);
    const planDriftError = failureOf(planDrift, 1, 'conflict');
    expect((planDriftError?.details as { reason?: string })?.reason).toBe('plan_changed');
    expectNoLeaks(planDrift, env);
    // 重新批准当前身份（Feature revision 已到 4）后恢复。
    successResult(
      await runDistCli(env, [
        'feature', 'approve', featureId,
        '--project', projectId, '--digest', digest2, '--revision', '4',
        '--data-root', root, '--json',
      ]),
      'feature.approve',
    );
    const reApproved = await queryApprovals(root, port, featureId);
    expect(reApproved.validity).toMatchObject({ valid: true, reason: 'approved', planDigest: digest2 });
    const finalPrepare = await prepareInputs(env, seed, 't-1', itemsPath);
    expect(finalPrepare.bindable).toBe(true);
    expect(finalPrepare.approval.planDigest).toBe(digest2);
    // I1 旧制品组正文在整个漂移矩阵结束后仍逐字节不变。
    for (const part of i1.group) {
      expect(readFileSync(artifactBodyPath(root, projectId, part.artifactId), 'utf8')).toBe(
        i1Bodies.get(part.purpose),
      );
    }

    await stopHostViaDistCli(env, root, seed.host.pid);
  }, 420_000);

  it('历史增长不膨胀 + fail-closed 矩阵：prompt 有界/acceptance 全量可读；缺失/篡改/越界/超预算/跨项目 fail-closed 零泄漏', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f009-growth-' });
    const { seed, writeInput } = await seedThreeTaskPlan(env, 'growth');
    const { root, projectId, featureId, planDigest } = seed;

    successResult(
      await runDistCli(env, [
        'feature', 'approve', featureId,
        '--project', projectId, '--digest', planDigest, '--revision', '1',
        '--data-root', root, '--json',
      ]),
      'feature.approve',
    );
    const reqArtifact = await seedReadyArtifact(root, projectId, 'growth-requirements', {
      content: '# 增长场景需求正文',
    });
    const itemsPath = writeInput('growth-items.json', {
      items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: reqArtifact } }],
    });

    // P1：基线准备（增长前）。
    const p1 = await prepareInputs(env, seed, 't-1', itemsPath);
    const bodyOf = (prepared: PrepareResultShape, purpose: string): string =>
      readFileSync(
        artifactBodyPath(root, projectId, prepared.group.find((part) => part.purpose === purpose)?.artifactId as string),
        'utf8',
      );
    const p1Prompt = bodyOf(p1, 'prompt');
    const p1Snapshot = bodyOf(p1, 'snapshot');
    expect(Buffer.byteLength(p1Prompt, 'utf8')).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    // 全部 acceptance 可读取（snapshot 业务字段 + prompt 必读清单逐项完整）。
    const p1SnapshotJson = JSON.parse(p1Snapshot) as { task: { acceptance: { criteria: string[] } } };
    expect(p1SnapshotJson.task.acceptance.criteria).toEqual(['任务一验收：副本不漂移']);
    expect(p1Prompt).toContain('[1] 任务一验收：副本不漂移');

    // 增长：40 份大段报告制品（含唯一标记）+ 8 次 Feature 标签 CAS（事件/回执增长）。
    const reportMarker = `SECRET-REPORT-MARKER-${randomUUID()}`;
    for (let index = 0; index < 40; index += 1) {
      await seedReadyArtifact(root, projectId, `growth-report-${index}`, {
        content: `# 历史报告 ${index}\n${reportMarker}\n${'大量报告正文。'.repeat(96)}`,
      });
    }
    for (let index = 0; index < 8; index += 1) {
      successResult(
        await runDistCli(env, [
          'feature', 'labels', featureId,
          '--project', projectId, '--revision', String(index + 2),
          '--label', `growth-${index}`,
          '--data-root', root, '--json',
        ]),
        'feature.labels',
      );
    }

    // P2：增长后新准备——prompt/snapshot/manifest 摘要与正文逐字节不变（历史
    // 不内联），报告标记不进入任何正文；acceptance 仍逐项完整可读。
    const p2 = await prepareInputs(env, seed, 't-1', itemsPath);
    for (const purpose of ['snapshot', 'manifest', 'prompt'] as const) {
      const p1Part = p1.group.find((part) => part.purpose === purpose);
      const p2Part = p2.group.find((part) => part.purpose === purpose);
      expect(p2Part?.contentHash).toBe(p1Part?.contentHash);
      expect(bodyOf(p2, purpose)).toBe(bodyOf(p1, purpose));
    }
    for (const purpose of ['snapshot', 'manifest', 'prompt'] as const) {
      expect(bodyOf(p2, purpose)).not.toContain(reportMarker);
    }
    expect(Buffer.byteLength(bodyOf(p2, 'prompt'), 'utf8')).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    // 第三次准备（新 commandId）：与 P1/P2 同摘要（确定性）——证明有界性不是
    // 一次性巧合。
    const p3 = await prepareInputs(env, seed, 't-1', itemsPath);
    expect(p3.group.find((part) => part.purpose === 'prompt')?.contentHash).toBe(
      p1.group.find((part) => part.purpose === 'prompt')?.contentHash,
    );

    // fail-closed 矩阵（经 dist CLI task prepare；全部有明确原因且零泄漏）。
    // 1) 缺失：未知制品 → not_found。
    const missing = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('missing-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: 'art-missing' } }],
      }),
      '--data-root', root, '--json',
    ]);
    failureOf(missing, 1, 'not_found');
    expectNoLeaks(missing, env);

    // 2) 越界：file 来源——生产装配获准根白名单为空（unknown_root fail-closed）；
    //    词法穿越在结构校验层拒绝。
    const unknownRoot = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('fileroot-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'file', root: 'docs', relativePath: 'a.md' } }],
      }),
      '--data-root', root, '--json',
    ]);
    const unknownRootError = failureOf(unknownRoot, 2, 'invalid_input');
    expect((unknownRootError?.details as { reason?: string })?.reason).toBe('unknown_root');
    expectNoLeaks(unknownRoot, env);
    const traversal = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('traversal-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'file', root: 'docs', relativePath: '../../escape.md' } }],
      }),
      '--data-root', root, '--json',
    ]);
    failureOf(traversal, 2, 'invalid_input');
    expectNoLeaks(traversal, env);

    // 3) 超预算：制品索引声明正文超单项上限（4 000 000B）→ limit_exceeded。
    const oversized = await seedReadyArtifact(root, projectId, 'growth-oversized', {
      content: 'x',
      declaredSizeBytes: 5_000_000,
    });
    const overBudget = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('oversize-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: oversized } }],
      }),
      '--data-root', root, '--json',
    ]);
    const overBudgetError = failureOf(overBudget, 2, 'invalid_input');
    expect((overBudgetError?.details as { reason?: string })?.reason).toBe('limit_exceeded');
    expectNoLeaks(overBudget, env);

    // 4) 跨项目访问：B 项目制品对 A 项目不可见（防枚举 not_found）。
    const home = env.childEnv().HOME as string;
    const repoB = join(env.sandboxRoot, 'repo-growth-b');
    initGitRepo(repoB);
    writeFileSync(join(repoB, 'README.md'), '# Repo B\n', 'utf8');
    commitAll(repoB, 'init B', { home });
    const registeredB = successResult(
      await runDistCli(env, ['project', 'register', repoB, '--name', 'F-009 growth B', '--data-root', root, '--json']),
      'project.register',
    ) as { result: { project: { id: string } } };
    const projectB = registeredB.result.project.id;
    const foreignArtifact = await seedReadyArtifact(root, projectB, 'growth-foreign');
    const crossProject = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('cross-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: foreignArtifact } }],
      }),
      '--data-root', root, '--json',
    ]);
    const crossProjectError = failureOf(crossProject, 1, 'forbidden');
    expect((crossProjectError?.details as { reason?: string })?.reason).toBe('ownership_denied');
    expectNoLeaks(crossProject, env, [projectB]);

    // 5) 秘密字段：清单输入连接前拒绝（CLI 层词汇表），不回显秘密值。
    const secretValue = `sk-secret-${randomUUID()}`;
    const secretItems = await runDistCli(env, [
      'task', 'prepare', 't-1',
      '--project', projectId, '--feature', featureId,
      '--input', writeInput('secret-items.json', {
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: reqArtifact }, token: secretValue }],
      }),
      '--data-root', root, '--json',
    ]);
    failureOf(secretItems, 2, 'invalid_input');
    expectNoLeaks(secretItems, env, [secretValue]);

    // 6) 篡改：P1 prompt 正文落盘篡改 → 回执查询不重读正文也不修复（身份仍为
    //    原摘要——系统不摘掉失败证据也不所蔽）；篡改字节保留、新准备发布新
    //    制品组不覆盖旧正文（不可变纪律）。逐字节校验读取 → corrupt 的失败
    //    语义在 Core 服务层覆盖（readVerifiedContent，见交接文档 §3/§6 边界：
    //    Host artifacts.get 仅限 P02-3 基线输出成员，无通用制品读取面）。
    const promptArtifactId = p1.group.find((part) => part.purpose === 'prompt')?.artifactId as string;
    const promptPath = artifactBodyPath(root, projectId, promptArtifactId);
    const originalPromptBytes = readFileSync(promptPath);
    writeFileSync(promptPath, Buffer.concat([originalPromptBytes, Buffer.from('TAMPERED', 'utf8')]));
    const receiptAfterTamper = successResult(
      await runDistCli(env, ['task', 'inputs', p1.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as { group: PreparedGroupPart[] };
    expect(receiptAfterTamper.group).toEqual(p1.group);
    expect(readFileSync(promptPath, 'utf8').endsWith('TAMPERED')).toBe(true);
    // 新准备发布新制品组（旧篡改正文不被覆盖修复，保持失败证据）。
    const afterTamperPrepare = await prepareInputs(env, seed, 't-1', itemsPath);
    for (const part of afterTamperPrepare.group) {
      expect(part.artifactId).not.toBe(promptArtifactId);
    }
    expect(readFileSync(promptPath, 'utf8').endsWith('TAMPERED')).toBe(true);

    await stopHostViaDistCli(env, root, seed.host.pid);
  }, 420_000);
});
