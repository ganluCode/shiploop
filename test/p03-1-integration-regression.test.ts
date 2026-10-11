/**
 * F-011 P03-1 局部集成回归（正式构建 Host/CLI + 隔离真实 SQLite）。
 *
 * 定位：P03-1 最终局部集成门禁——不新增产品源码，把 F-002 ~ F-010 已交付的
 * 领域计划能力放进「正式构建产物 + 真实子进程 + 真实 SQLite」整链复核：
 *
 * - 正式构建：beforeAll 真实 `npm run build`，全部命令经真实
 *   `packages/cli/dist/bin.js` 子进程执行；Host 用 npm run build 的 dist 产物
 *   （dist-host-entry-catalog.mjs 装配 dist/runtime 与 dist/core，纪律与
 *   detached-host-entry-catalog.ts 相同：受信测试能力目录只服务配置策略复检，
 *   不是产品能力放宽；纯生产 dist/start.js 的空目录 fail-closed 边界单独验证）；
 * - 端到端主线：project register → config create（策略副本来源）→ phase create →
 *   合法三 Task 链 feature import → feature get/task list 重查 → **进程重开**
 *   （host stop 三证据 + pid 实际退出 → 重新拉起 → 查询结果一致）→ **库重开**
 *   （独立只读 SQLite 探针核对 phases/features/tasks/task_dependencies 行、
 *   state_events 事件序与脱敏 payload、command_receipts 回执——状态/事件/回执
 *   三方真实一致）→ task labels（摘要不变）→ feature revise（摘要改变）→
 *   最终库重开审计；
 * - 负例与幂等/CAS（dist CLI 级）：非法计划（依赖环）整组拒绝零写入、同
 *   commandId 同参数重放零新增（回执/实体/事件均不重复）、旧 revision CAS
 *   conflict；不宣称批准/通过/Work 执行；
 * - 生产构建边界：dist CLI `host start` 自行拉起生产 dist/start.js（空能力目录），
 *   非 strategies 命令可用、strategies 配置按能力目录 fail-closed 拒绝且零写入
 *   ——这是 P03-1 已记录的已知缺口（能力目录装配是后续阶段范围），不折算通过。
 *
 * 复用既有夹具（isolated-environment / git-repo / storage-probe），不另建体系；
 * 不读真实凭据、不联网、不调用模型、不修改开发仓库或用户 HOME；全部等待有界；
 * 夹具回收只针对本套件真实 spawn 的子进程。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { openStorageProbe, type StorageProbe } from './helpers/p02-2/storage-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 真实 dist CLI 可执行入口（npm run build 产物，与生产同一入口）。 */
const DIST_CLI_BIN = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
/** 生产 Host 入口产物（dist CLI 自行拉起时使用；空能力目录 fail-closed）。 */
const DIST_HOST_START = fileURLToPath(new URL('../packages/host/dist/start.js', import.meta.url));
const DIST_HOST_RUNTIME = fileURLToPath(new URL('../packages/host/dist/runtime/index.js', import.meta.url));
const DIST_CORE_INDEX = fileURLToPath(new URL('../packages/core/dist/index.js', import.meta.url));
/** 装配 dist 产物的 Host 入口（受信测试能力目录；纪律见文件头）。 */
const DIST_CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/dist-host-entry-catalog.mjs', import.meta.url),
);

const DATABASE_FILE_NAME = 'core.sqlite';

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  for (const [label, artifact] of [
    ['dist CLI 入口', DIST_CLI_BIN],
    ['dist Host 生产入口', DIST_HOST_START],
    ['dist Host runtime', DIST_HOST_RUNTIME],
    ['dist Core 入口', DIST_CORE_INDEX],
  ] as const) {
    if (!existsSync(artifact)) {
      throw new Error(`正式构建产物缺失：${label} ${artifact}；npm run build 未产出`);
    }
  }
}, 570_000);

/* ------------------------------------------------------------------ *
 * 小工具：进程/端口/等待
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

function tcpPortOpen(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = tcpConnect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveOpen(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs).unref();
  });
}

interface DiscoveryRecord {
  readonly pid?: unknown;
  readonly port?: unknown;
}

function readDiscovery(root: string): { pid: number; port: number } | undefined {
  const file = join(root, 'host', 'discovery.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as DiscoveryRecord;
    if (typeof record.pid === 'number' && typeof record.port === 'number') {
      return { pid: record.pid, port: record.port };
    }
  } catch {
    // 发布中途的部分写入：按未就绪处理，继续有界等待。
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * dist CLI 子进程（真实 bin.js；argv 直接 spawn、无 shell）
 * ------------------------------------------------------------------ */

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

function failureOf(invocation: DistCliInvocation, exitCode: number, code: string): EnvelopeShape['error'] {
  expect(invocation.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as EnvelopeShape['error'];
  expect(error?.code).toBe(code);
  return error;
}

/* ------------------------------------------------------------------ *
 * dist 产物 Host（受信测试能力目录）拉起/停止
 * ------------------------------------------------------------------ */

interface CatalogHost {
  readonly pid: number;
  readonly port: number;
}

/** 本套件真实 spawn 的 Host 进程（cleanup 只针对这些 pid）。 */
const spawnedHostPids: number[] = [];

async function startCatalogHost(
  env: IsolatedHostEnvironment,
  root: string,
  label: string,
): Promise<CatalogHost> {
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
    if (discovery !== undefined) {
      lastState = `discovery pid=${discovery.pid} port=${discovery.port}`;
      if (discovery.pid === child.pid && pidAlive(discovery.pid)) {
        if (await tcpPortOpen(discovery.port)) {
          return { pid: discovery.pid, port: discovery.port };
        }
        lastState += '（端口未就绪）';
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`dist Host 启动等待超时（${label}）：${lastState}`);
}

/** dist CLI 显式停止（生产三证据路径）并核对 pid 实际退出。 */
async function stopHostViaDistCli(
  env: IsolatedHostEnvironment,
  root: string,
  pid: number,
): Promise<void> {
  const stopped = await runDistCli(env, ['host', 'stop', '--data-root', root, '--json']);
  const result = successResult(stopped, 'host.stop');
  expect(result.status).toBe('stopped');
  expect((result.evidence as Record<string, unknown>)).toEqual({
    processExit: 'confirmed',
    lock: 'acquirable',
    discovery: 'removed',
  });
  await waitFor(() => !pidAlive(pid), 15_000, `host pid ${pid} 实际退出`);
}

afterEach(async () => {
  // 兜底回收：正常路径已由 host stop 关闭；失败泄漏时按 pid 有限收尾。
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

afterAll(() => {
  expect(spawnedHostPids, 'host pid 登记应在 afterEach 清空').toEqual([]);
});

/* ------------------------------------------------------------------ *
 * 计划夹具（与 F-010 纵向同值语义，正式构建链路复核）
 * ------------------------------------------------------------------ */

const GLOBAL_CONFIG = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: 'keychain://shiploop/global-default',
    },
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 },
    verification: { requireChecksBeforeDone: true },
  },
} as const;

function samplePlan(titleSuffix = ''): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: `集成回归 Feature${titleSuffix}`,
      description: 'F-011 集成回归描述',
      labels: ['integration'],
      sourceRefs: [],
    },
    tasks: [
      {
        id: 't-1',
        title: '任务一',
        complexity: 'low',
        acceptance: { criteria: ['任务一验收'] },
      },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收'] },
        dependsOn: ['t-1'],
      },
      {
        id: 't-3',
        title: '任务三',
        complexity: 'low',
        acceptance: { criteria: ['任务三验收'] },
        dependsOn: ['t-2'],
      },
    ],
  };
}

function cyclicPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: { title: '非法 Feature' },
    tasks: [
      { id: 't-a', title: 'A', acceptance: { criteria: ['a'] }, dependsOn: ['t-b'] },
      { id: 't-b', title: 'B', acceptance: { criteria: ['b'] }, dependsOn: ['t-a'] },
    ],
  };
}

interface ProjectSeed {
  readonly env: IsolatedHostEnvironment;
  readonly root: string;
  readonly projectId: string;
  readonly repoDir: string;
}

async function seedProject(env: IsolatedHostEnvironment, root: string, name: string): Promise<ProjectSeed> {
  const repoDir = join(env.sandboxRoot, `repo-${randomUUID().slice(0, 8)}`);
  initGitRepo(repoDir);
  writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`, 'utf8');
  commitAll(repoDir, `init ${name}`, { home: env.childEnv().HOME });
  const registered = successResult(
    await runDistCli(env, [
      'project',
      'register',
      repoDir,
      '--name',
      name,
      '--data-root',
      root,
      '--json',
    ]),
    'project.register',
  ) as { status: string; result?: { project?: { id?: string } } };
  expect(registered.status).toBe('completed');
  expect(typeof registered.result?.project?.id).toBe('string');
  return { env, root, projectId: registered.result?.project?.id as string, repoDir };
}

async function createGlobalConfig(env: IsolatedHostEnvironment, root: string): Promise<void> {
  const configPath = join(env.sandboxRoot, `config-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(configPath, JSON.stringify(GLOBAL_CONFIG), 'utf8');
  const configReceipt = successResult(
    await runDistCli(env, [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      configPath,
      '--data-root',
      root,
      '--json',
    ]),
    'config.create',
  ) as { status: string };
  expect(configReceipt.status).toBe('completed');
}

function writePlanFile(env: IsolatedHostEnvironment, plan: Record<string, unknown>): string {
  const path = join(env.sandboxRoot, `plan-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, JSON.stringify(plan), 'utf8');
  return path;
}

/* ------------------------------------------------------------------ *
 * 库重开只读审计（独立 better-sqlite3 连接）
 * ------------------------------------------------------------------ */

function openProbe(root: string): StorageProbe {
  return openStorageProbe(join(root, DATABASE_FILE_NAME));
}

interface PlanRowAudit {
  readonly featureDigest: string;
  readonly featureRevision: number;
  readonly taskIds: string[];
  readonly edges: { taskId: string; dependsOnId: string }[];
}

function auditPlanRows(probe: StorageProbe, featureId: string): PlanRowAudit {
  const feature = probe.selectOne<{
    plan_digest: string;
    revision: number;
    plan_status: string;
    phase_id: string;
    project_id: string;
  }>('SELECT plan_digest, revision, plan_status, phase_id, project_id FROM features WHERE id = ?', [
    featureId,
  ]);
  expect(feature, 'features 行必须存在').toBeDefined();
  expect(feature?.plan_status).toBe('draft');
  const tasks = probe.selectAll<{ id: string; feature_id: string; config_source: string }>(
    'SELECT id, feature_id, config_source FROM tasks WHERE feature_id = ? ORDER BY id',
    [featureId],
  );
  const edges = probe
    .selectAll<{ task_id: string; depends_on_id: string }>(
      'SELECT task_id, depends_on_id FROM task_dependencies WHERE feature_id = ? ORDER BY task_id',
      [featureId],
    )
    .map((edge) => ({ taskId: edge.task_id, dependsOnId: edge.depends_on_id }));
  return {
    featureDigest: feature?.plan_digest as string,
    featureRevision: feature?.revision as number,
    taskIds: tasks.map((task) => task.id),
    edges,
  };
}

interface EventRow {
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload: string;
}

function projectEvents(probe: StorageProbe, projectId: string): EventRow[] {
  return probe.selectAll<EventRow>(
    'SELECT sequence, event_type, aggregate_type, aggregate_id, payload FROM state_events WHERE project_id = ? ORDER BY sequence',
    [projectId],
  );
}

function receiptStatus(probe: StorageProbe, commandId: string): string | undefined {
  const row = probe.selectOne<{ status: string }>(
    'SELECT status FROM command_receipts WHERE principal_id = ? AND command_id = ?',
    ['local-owner', commandId],
  );
  return row?.status;
}

function expectEvent(event: EventRow, type: string, aggregateType: string, aggregateId: string, payload: string): void {
  expect(event.event_type).toBe(type);
  expect(event.aggregate_type).toBe(aggregateType);
  expect(event.aggregate_id).toBe(aggregateId);
  expect(event.payload).toBe(payload);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('F-011 P03-1 局部集成回归（正式构建 Host/CLI + 隔离真实 SQLite）', () => {
  let env: IsolatedHostEnvironment;

  afterEach(async () => {
    await env.dispose();
  });

  it('端到端主线：Phase 创建 → 三 Task 导入 → 进程重开查询 → 库重开审计 → 标签/实质修订', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f011-main-' });
    const root = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    expect(home).not.toBe(homedir());

    // Host：dist 产物 + 受信测试能力目录（正式构建代码真实子进程）。
    const host1 = await startCatalogHost(env, root, '主线首轮');
    const seed = await seedProject(env, root, 'F-011 集成回归');
    const projectId = seed.projectId;
    await createGlobalConfig(env, root);

    // 1) phase create：稳定 ID、revision=1、open。
    const created = successResult(
      await runDistCli(env, [
        'phase',
        'create',
        '--project',
        projectId,
        '--title',
        '阶段一',
        '--description',
        '集成回归阶段',
        '--label',
        'p03',
        '--data-root',
        root,
        '--json',
      ]),
      'phase.create',
    ) as { status: string; result: { phase: { id: string; revision: number; status: string } } };
    expect(created.status).toBe('completed');
    const phase = created.result.phase;
    expect(phase.revision).toBe(1);
    expect(phase.status).toBe('open');
    const phaseId = phase.id;

    // 2) 合法三 Task 链导入（Phase 聚合 CAS=1）。
    const importCommandId = randomUUID();
    const importReceipt = successResult(
      await runDistCli(env, [
        'feature',
        'import',
        '--project',
        projectId,
        '--phase',
        phaseId,
        '--revision',
        '1',
        '--input',
        writePlanFile(env, samplePlan()),
        '--command-id',
        importCommandId,
        '--data-root',
        root,
        '--json',
      ]),
      'feature.import',
    ) as {
      status: string;
      result: {
        feature: { id: string; revision: number; planStatus: string; planDigest: string };
        tasks: { id: string }[];
        validation: { taskCount: number; dependencyEdgeCount: number; executable: boolean };
      };
    };
    expect(importReceipt.status).toBe('completed');
    const imported = importReceipt.result;
    const featureId = imported.feature.id;
    const digestAfterImport = imported.feature.planDigest;
    expect(imported.feature.revision).toBe(1);
    expect(imported.feature.planStatus).toBe('draft');
    expect(imported.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(imported.validation).toEqual({ taskCount: 3, dependencyEdgeCount: 2, executable: true });
    expect(receiptStatus(openProbe(root), importCommandId)).toBe('completed');

    // 3) 重查：Feature 详情与 Task 分页。
    const detail = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as {
      feature: { planDigest: string; revision: number };
      dependencies: { taskId: string; dependsOnId: string }[];
      notExecutableReasons: string[];
    };
    expect(detail.feature.planDigest).toBe(digestAfterImport);
    expect(detail.dependencies).toEqual([
      { taskId: 't-2', dependsOnId: 't-1' },
      { taskId: 't-3', dependsOnId: 't-2' },
    ]);
    expect(detail.notExecutableReasons).toEqual(['plan_not_approved']);
    const firstPage = successResult(
      await runDistCli(env, [
        'task',
        'list',
        '--project',
        projectId,
        '--feature',
        featureId,
        '--limit',
        '2',
        '--data-root',
        root,
        '--json',
      ]),
      'task.list',
    ) as { records: { id: string }[]; nextCursor: string | null };
    expect(firstPage.records.map((record) => record.id)).toEqual(['t-1', 't-2']);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = successResult(
      await runDistCli(env, [
        'task',
        'list',
        '--project',
        projectId,
        '--feature',
        featureId,
        '--limit',
        '2',
        '--cursor',
        firstPage.nextCursor as string,
        '--data-root',
        root,
        '--json',
      ]),
      'task.list',
    ) as { records: { id: string }[]; nextCursor: string | null };
    expect(secondPage.records.map((record) => record.id)).toEqual(['t-3']);
    expect(secondPage.nextCursor).toBeNull();

    // 4) 进程重开：显式 stop（三证据 + pid 实际退出）→ 重新拉起 → 查询一致。
    await stopHostViaDistCli(env, root, host1.pid);
    {
      // 库重开审计 #1（独立只读连接）：行/事件/回执三方一致。
      const probe = openProbe(root);
      try {
        const audit = auditPlanRows(probe, featureId);
        expect(audit.featureDigest).toBe(digestAfterImport);
        expect(audit.featureRevision).toBe(1);
        expect(audit.taskIds).toEqual(['t-1', 't-2', 't-3']);
        expect(audit.edges).toEqual([
          { taskId: 't-2', dependsOnId: 't-1' },
          { taskId: 't-3', dependsOnId: 't-2' },
        ]);
        const events = projectEvents(probe, projectId);
        expect(events.map((event) => event.event_type)).toEqual([
          'project.registered',
          'phase.created',
          'feature.plan.imported',
        ]);
        expectEvent(events[1] as EventRow, 'phase.created', 'phase', phaseId, '{"created":true}');
        expectEvent(
          events[2] as EventRow,
          'feature.plan.imported',
          'feature',
          featureId,
          '{"imported":true}',
        );
        expect(receiptStatus(probe, importCommandId)).toBe('completed');
      } finally {
        probe.close();
      }
    }
    const host2 = await startCatalogHost(env, root, '主线重开');
    const detailAfterRestart = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as {
      feature: { planDigest: string; revision: number };
      tasks: { id: string }[];
    };
    expect(detailAfterRestart.feature.planDigest).toBe(digestAfterImport);
    expect(detailAfterRestart.feature.revision).toBe(1);
    expect(detailAfterRestart.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);

    // 5) 纯标签编辑（Task 自身 CAS 1→2）：摘要不变。
    const labels = successResult(
      await runDistCli(env, [
        'task',
        'labels',
        't-1',
        '--project',
        projectId,
        '--revision',
        '1',
        '--label',
        'wired',
        '--data-root',
        root,
        '--json',
      ]),
      'task.labels',
    ) as { status: string; result: Record<string, unknown> };
    expect(labels.status).toBe('completed');
    expect(labels.result).toMatchObject({ entityType: 'task', id: 't-1', labels: ['wired'], revision: 2 });
    const afterLabels = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string } };
    expect(afterLabels.feature.planDigest).toBe(digestAfterImport);

    // 6) 实质修订（Feature 聚合 CAS=1 → 2）：摘要改变。
    const reviseReceipt = successResult(
      await runDistCli(env, [
        'feature',
        'revise',
        featureId,
        '--project',
        projectId,
        '--revision',
        '1',
        '--input',
        writePlanFile(env, samplePlan('（实质修订）')),
        '--data-root',
        root,
        '--json',
      ]),
      'feature.revise',
    ) as {
      status: string;
      result: {
        feature: { revision: number; planDigest: string; planStatus: string };
        memberChanges: { keptTaskCount: number; createdTaskCount: number; removedTaskCount: number };
      };
    };
    expect(reviseReceipt.status).toBe('completed');
    const revised = reviseReceipt.result;
    expect(revised.feature.revision).toBe(2);
    expect(revised.feature.planStatus).toBe('draft');
    expect(revised.feature.planDigest).not.toBe(digestAfterImport);
    expect(revised.memberChanges).toEqual({ keptTaskCount: 3, createdTaskCount: 0, removedTaskCount: 0 });
    const digestAfterRevise = revised.feature.planDigest;

    // 7) 进程重开 #2 + 库重开审计 #2：修订后状态/事件/回执一致。
    await stopHostViaDistCli(env, root, host2.pid);
    {
      const probe = openProbe(root);
      try {
        const audit = auditPlanRows(probe, featureId);
        expect(audit.featureDigest).toBe(digestAfterRevise);
        expect(audit.featureRevision).toBe(2);
        expect(audit.taskIds).toEqual(['t-1', 't-2', 't-3']);
        // 保留成员语义（F-008 定案）：实质修订整体替换业务内容（含标签），
        // 策略副本/状态/创建时间不变，revision 在标签编辑递增后再递增一次（2→3）。
        const taskRow = probe.selectOne<{ labels: string; revision: number }>(
          'SELECT labels, revision FROM tasks WHERE id = ? AND feature_id = ?',
          ['t-1', featureId],
        );
        expect(taskRow?.revision).toBe(3);
        expect(JSON.parse(taskRow?.labels as string)).toEqual([]);
        const events = projectEvents(probe, projectId);
        expect(events.map((event) => event.event_type)).toEqual([
          'project.registered',
          'phase.created',
          'feature.plan.imported',
          'task.labels.updated',
          'feature.plan.revised',
        ]);
        expectEvent(
          events[3] as EventRow,
          'task.labels.updated',
          'task',
          't-1',
          '{"labelsUpdated":true}',
        );
        expectEvent(
          events[4] as EventRow,
          'feature.plan.revised',
          'feature',
          featureId,
          '{"revised":true}',
        );
        const sequences = events.map((event) => event.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
        const receipts = probe.selectAll<{ status: string }>(
          'SELECT status FROM command_receipts WHERE principal_id = ?',
          ['local-owner'],
        );
        expect(receipts.length).toBeGreaterThanOrEqual(4);
        expect(receipts.every((row) => row.status === 'completed')).toBe(true);
        expect(receiptStatus(probe, importCommandId)).toBe('completed');
      } finally {
        probe.close();
      }
    }

    // 8) 不宣称纪律：全部结构化输出不含批准/通过/运行结论。
    for (const text of [JSON.stringify(imported), JSON.stringify(detail), JSON.stringify(revised)]) {
      expect(text).not.toContain('"approved"');
      expect(text).not.toContain('"passed"');
      expect(text).not.toContain('"runId"');
      expect(text).not.toContain('"workId"');
    }
  }, 420_000);

  it('负例与幂等/CAS：非法计划整组拒绝零写入、同 commandId 重放零新增、旧 revision conflict', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f011-neg-' });
    const root = env.dataRoot('app').canonicalRoot;
    await startCatalogHost(env, root, '负例');
    const seed = await seedProject(env, root, 'F-011 负例');
    const projectId = seed.projectId;
    await createGlobalConfig(env, root);
    const created = successResult(
      await runDistCli(env, [
        'phase',
        'create',
        '--project',
        projectId,
        '--title',
        '负例阶段',
        '--data-root',
        root,
        '--json',
      ]),
      'phase.create',
    ) as { status: string; result: { phase: { id: string } } };
    expect(created.status).toBe('completed');
    const phaseId = created.result.phase.id;

    // 合法导入一次（显式 commandId，供重放核对）。
    const importCommandId = randomUUID();
    const planFile = writePlanFile(env, samplePlan());
    const firstImport = successResult(
      await runDistCli(env, [
        'feature',
        'import',
        '--project',
        projectId,
        '--phase',
        phaseId,
        '--revision',
        '1',
        '--input',
        planFile,
        '--command-id',
        importCommandId,
        '--data-root',
        root,
        '--json',
      ]),
      'feature.import',
    ) as { status: string; replayed: boolean; result: { feature: { id: string; planDigest: string } } };
    expect(firstImport.status).toBe('completed');
    expect(firstImport.replayed).toBe(false);
    const featureId = firstImport.result.feature.id;
    const digestBefore = firstImport.result.feature.planDigest;

    // 1) 幂等重放：同 commandId 同参数 → 同一 Feature/摘要，零新增实体/事件/回执。
    const replay = successResult(
      await runDistCli(env, [
        'feature',
        'import',
        '--project',
        projectId,
        '--phase',
        phaseId,
        '--revision',
        '1',
        '--input',
        planFile,
        '--command-id',
        importCommandId,
        '--data-root',
        root,
        '--json',
      ]),
      'feature.import',
    ) as { replayed: boolean; result: { feature: { id: string; planDigest: string } } };
    expect(replay.replayed).toBe(true);
    expect(replay.result.feature.id).toBe(featureId);
    expect(replay.result.feature.planDigest).toBe(digestBefore);
    {
      const probe = openProbe(root);
      try {
        expect(probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM features')?.n).toBe(1);
        expect(
          probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ?', [
            featureId,
          ])?.n,
        ).toBe(3);
        expect(
          probe
            .selectAll<{ event_type: string }>(
              "SELECT event_type FROM state_events WHERE event_type = 'feature.plan.imported'",
            )
            .map((row) => row.event_type),
        ).toEqual(['feature.plan.imported']);
        expect(
          probe.selectOne<{ n: number }>(
            'SELECT COUNT(*) AS n FROM command_receipts WHERE command_id = ?',
            [importCommandId],
          )?.n,
        ).toBe(1);
      } finally {
        probe.close();
      }
    }

    // 2) 非法计划（依赖环）：整组拒绝（exit 2 invalid_input），零写入、零成功回执。
    const badCommandId = randomUUID();
    const badInvocation = await runDistCli(env, [
      'feature',
      'revise',
      featureId,
      '--project',
      projectId,
      '--revision',
      '1',
      '--input',
      writePlanFile(env, cyclicPlan()),
      '--command-id',
      badCommandId,
      '--data-root',
      root,
      '--json',
    ]);
    const badError = failureOf(badInvocation, 2, 'invalid_input');
    expect(badError?.details?.field ?? badError?.details?.reason).toBeDefined();
    expect(badInvocation.stdout).not.toContain('非法 Feature');
    expect(badInvocation.stdout).not.toContain('t-a');
    {
      const probe = openProbe(root);
      try {
        const audit = auditPlanRows(probe, featureId);
        expect(audit.featureDigest).toBe(digestBefore);
        expect(audit.featureRevision).toBe(1);
        expect(audit.taskIds).toEqual(['t-1', 't-2', 't-3']);
        const status = receiptStatus(probe, badCommandId);
        expect(status).not.toBe('completed');
        expect(
          probe.selectOne<{ n: number }>(
            "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'feature.plan.revised'",
          )?.n,
        ).toBe(0);
      } finally {
        probe.close();
      }
    }

    // 3) 合法修订（1→2）后，旧 revision CAS 冲突拒绝且状态不变。
    const revised = successResult(
      await runDistCli(env, [
        'feature',
        'revise',
        featureId,
        '--project',
        projectId,
        '--revision',
        '1',
        '--input',
        writePlanFile(env, samplePlan('（负例后修订）')),
        '--data-root',
        root,
        '--json',
      ]),
      'feature.revise',
    ) as { status: string; result: { feature: { revision: number; planDigest: string } } };
    expect(revised.status).toBe('completed');
    expect(revised.result.feature.revision).toBe(2);
    const digestAfterRevise = revised.result.feature.planDigest;
    const stale = await runDistCli(env, [
      'feature',
      'revise',
      featureId,
      '--project',
      projectId,
      '--revision',
      '1',
      '--input',
      writePlanFile(env, samplePlan('（旧 revision）')),
      '--data-root',
      root,
      '--json',
    ]);
    const staleError = failureOf(stale, 1, 'conflict');
    expect(staleError?.details).toBeDefined();
    {
      const probe = openProbe(root);
      try {
        const audit = auditPlanRows(probe, featureId);
        expect(audit.featureDigest).toBe(digestAfterRevise);
        expect(audit.featureRevision).toBe(2);
      } finally {
        probe.close();
      }
    }
  }, 300_000);

  it('生产构建边界：dist CLI 拉起生产 dist/start.js，空能力目录对 strategies 配置 fail-closed 且零写入', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f011-prod-' });
    const root = env.dataRoot('app').canonicalRoot;

    // dist CLI host start：无实例时自行拉起生产 dist/start.js 并完成握手。
    const started = await runDistCli(env, ['host', 'start', '--data-root', root, '--json']);
    const startResult = successResult(started, 'host.start');
    expect(['started', 'already_running']).toContain(startResult.outcome);
    const status = successResult(
      await runDistCli(env, ['host', 'status', '--data-root', root, '--json']),
      'host.status',
    );
    expect(status.lifecycleState).toBe('ready');
    const discovery = readDiscovery(root);
    expect(discovery).toBeDefined();
    expect(pidAlive(discovery?.pid as number)).toBe(true);

    // 非 strategies 命令在纯生产构建上正常（项目注册可用）。
    const seed = await seedProject(env, root, 'F-011 生产边界');
    expect(seed.projectId).toMatch(/^[0-9a-f-]{36}$/);

    // strategies 配置按空能力目录 fail-closed 拒绝（已知缺口：能力目录装配属后续阶段）。
    const configPath = join(env.sandboxRoot, `config-${randomUUID().slice(0, 8)}.json`);
    writeFileSync(configPath, JSON.stringify(GLOBAL_CONFIG), 'utf8');
    const rejected = await runDistCli(env, [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      configPath,
      '--data-root',
      root,
      '--json',
    ]);
    const error = failureOf(rejected, 2, 'invalid_input');
    expect(JSON.stringify(error?.details)).toContain('unknown_runtime');
    {
      const probe = openProbe(root);
      try {
        expect(probe.tableExists('global_settings')).toBe(true);
        expect(probe.selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM global_settings')?.n).toBe(0);
        expect(
          probe.selectOne<{ n: number }>(
            "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'settings.global_created'",
          )?.n,
        ).toBe(0);
      } finally {
        probe.close();
      }
    }

    // 显式停止（生产三证据 + pid 实际退出）。
    await stopHostViaDistCli(env, root, discovery?.pid as number);
  }, 240_000);
});
