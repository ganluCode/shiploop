/**
 * P03-1 / F-010 计划 CLI 纵向（真实 Host 子进程 + HostClient + SQLite）。
 *
 * 验收面（经 `runAppCli`，与 dist/bin.js 同一执行路径）：
 * - `phase create` 建立 Phase、`feature import` 从有界 UTF-8 JSON 文件导入
 *   单 Feature 三 Task 计划、`feature get`/`task get`/层级列表重查、
 *   `task labels` 纯标签编辑后 planDigest 不变、`feature revise` 实质修改后
 *   planDigest 改变；
 * - 非法计划（环依赖）整组拒绝、零部分写入；旧 revision CAS 以 conflict 拒绝；
 *   业务归属拒绝（跨项目 Phase）按公开错误约定返回；
 * - 输入文件层（非法 JSON/超大/非 UTF-8/缺 CAS）在连接 Host 之前以退出码 2
 *   结构化拒绝，错误不回显文件内容；
 * - JSON 输出包含稳定 ID、revision、planStatus=draft、planDigest 与可审阅
 *   验收；帮助与结构化输出不宣称已有审批批准、Task passed 或 Work 执行。
 *
 * CLI 只经 Host 公共客户端发请求：不打开状态库、不读取凭据、不运行模型；
 * 不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../../../packages/cli/src/app-execute.ts';
import {
  runHostCli,
  type HostCliIo,
} from '../../../packages/cli/src/host/execute.ts';
import { connectToHost } from '../../../packages/host/src/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from '../../helpers/host/index.ts';
import { commitAll, initGitRepo } from '../../helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 带能力目录的 TS 测试 Host 入口（生产入口目录为空，配置策略需此夹具）。 */
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

/** 干净树下以 TS 源码运行带能力目录的 Host 入口 argv 前缀。 */
function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, CATALOG_HOST_ENTRY];
}

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

interface AppInvocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

async function runApp(
  env: IsolatedHostEnvironment,
  args: readonly string[],
): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    env: {},
    launch: { entryArgv: tsEntryArgv(), childEnv: env.childEnv(), pollIntervalMs: 50 },
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
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

function parseEnvelope(invocation: AppInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function successResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(invocation: AppInvocation, exitCode: number, code: string): EnvelopeShape['error'] {
  expect(invocation.result.exitCode, invocation.stderr).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as EnvelopeShape['error'];
  expect(error?.code).toBe(code);
  return error;
}

interface ReceiptShape {
  commandId: string;
  operation: string;
  status: string;
  replayed: boolean;
  resultRef?: string;
  result?: Record<string, unknown>;
}

function receiptOf(result: Record<string, unknown>): ReceiptShape {
  return result as unknown as ReceiptShape;
}

/** 停止测试自有的 Host：先经生产 stop（三证据），失败再直接客户端 stop 兜底。 */
async function stopHostBestEffort(canonicalRoot: string): Promise<void> {
  const collected = collectIo();
  try {
    const stopped = await runHostCli({
      args: ['host', 'stop', '--data-root', canonicalRoot, '--json'],
      io: collected.io as HostCliIo,
      env: {},
    });
    if (stopped.exitCode === 0) {
      return;
    }
  } catch {
    // 继续兜底。
  }
  try {
    const client = await connectToHost({ canonicalRoot });
    await client.stop().catch(() => undefined);
    client.close();
  } catch {
    // 尽力而为：无实例或已停止。
  }
}

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

/** 无引用三 Task 链计划（t-1 ← t-2 ← t-3）；每 Task 带结构化验收。 */
function samplePlan(titleSuffix = ''): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: `纵向 Feature${titleSuffix}`,
      description: 'F-010 纵向描述',
      labels: ['vertical'],
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

/** 非法计划：依赖环（t-a ← t-b ← t-a）→ 整组拒绝。 */
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

describe('F-010 计划 CLI 纵向（真实 Host + HostClient + SQLite）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  let repoA: string;
  let repoB: string;
  const usedRoots: string[] = [];

  function useRoot(): string {
    usedRoots.push(dataRoot);
    return dataRoot;
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-' });
    dataRoot = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    repoA = join(env.sandboxRoot, 'repo-a');
    repoB = join(env.sandboxRoot, 'repo-b');
    initGitRepo(repoA);
    writeFileSync(join(repoA, 'README.md'), '# Repo A\n', 'utf8');
    commitAll(repoA, 'init A', { home });
    initGitRepo(repoB);
    writeFileSync(join(repoB, 'README.md'), '# Repo B\n', 'utf8');
    commitAll(repoB, 'init B', { home });
  });

  afterEach(async () => {
    for (const root of usedRoots) {
      await stopHostBestEffort(root);
    }
    usedRoots.length = 0;
    await env.dispose();
  });

  /** 项目注册（既有 CLI 命令；计划命令的前置条件）。 */
  async function seedProject(
    root: string,
    repositoryPath: string,
    displayName: string,
  ): Promise<string> {
    const registered = successResult(
      await runApp(env, [
        'project',
        'register',
        repositoryPath,
        '--name',
        displayName,
        '--data-root',
        root,
        '--json',
      ]),
      'project.register',
    );
    const receipt = receiptOf(registered);
    const projectId = (receipt.result as { project?: { id?: string } } | undefined)?.project?.id;
    expect(typeof projectId).toBe('string');
    return projectId as string;
  }

  /** 全局配置（计划导入的策略副本来源；每个数据根只创建一次）。 */
  async function createGlobalConfig(root: string): Promise<void> {
    const configPath = join(env.sandboxRoot, `config-${randomUUID()}.json`);
    writeFileSync(configPath, JSON.stringify(GLOBAL_CONFIG), 'utf8');
    successResult(
      await runApp(env, [
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
    );
  }

  it('创建 Phase → 三 Task 导入 → 重查 → 标签摘要不变 → 实质修订摘要改变', async () => {
    const root = useRoot();
    const projectId = await seedProject(root, repoA, 'F-010 纵向');
    await createGlobalConfig(root);

    // 1) Phase 建立：稳定 ID + revision + status=open。
    const created = receiptOf(
      successResult(
        await runApp(env, [
          'phase',
          'create',
          '--project',
          projectId,
          '--title',
          '阶段一',
          '--description',
          '纵向阶段',
          '--label',
          'p03',
          '--data-root',
          root,
          '--json',
        ]),
        'phase.create',
      ),
    );
    expect(created.status).toBe('completed');
    expect(created.operation).toBe('phase.create');
    const phase = (
      created.result as {
        phase: { id: string; projectId: string; revision: number; status: string };
      }
    ).phase;
    expect(phase.projectId).toBe(projectId);
    expect(phase.revision).toBe(1);
    expect(phase.status).toBe('open');
    const phaseId = phase.id;

    // 2) 单 Feature 计划导入（Phase 聚合 CAS=1）：三 Task 链。
    const planPath = join(env.sandboxRoot, 'plan.json');
    writeFileSync(planPath, JSON.stringify(samplePlan()), 'utf8');
    const imported = receiptOf(
      successResult(
        await runApp(env, [
          'feature',
          'import',
          '--project',
          projectId,
          '--phase',
          phaseId,
          '--revision',
          '1',
          '--input',
          planPath,
          '--data-root',
          root,
          '--json',
        ]),
        'feature.import',
      ),
    );
    expect(imported.status).toBe('completed');
    const importResult = imported.result as {
      feature: { id: string; revision: number; planStatus: string; planDigest: string };
      tasks: { id: string }[];
      validation: { taskCount: number; dependencyEdgeCount: number; executable: boolean };
    };
    const featureId = importResult.feature.id;
    expect(featureId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    expect(importResult.feature.revision).toBe(1);
    expect(importResult.feature.planStatus).toBe('draft');
    expect(importResult.feature.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(importResult.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(importResult.validation).toEqual({
      taskCount: 3,
      dependencyEdgeCount: 2,
      executable: true,
    });
    const digestAfterImport = importResult.feature.planDigest;

    // 3) 重查：Feature 详情（完整 Task DAG + 可审阅验收）与 Task 详情。
    const detail = successResult(
      await runApp(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as {
      feature: { id: string; revision: number; planStatus: string; planDigest: string };
      validation: { taskCount: number; dependencyEdgeCount: number; executable: boolean };
      notExecutableReasons: string[];
      tasks: { id: string; status: string; acceptance: { criteria: string[] } }[];
      dependencies: { taskId: string; dependsOnId: string }[];
    };
    expect(detail.feature.planDigest).toBe(digestAfterImport);
    expect(detail.feature.planStatus).toBe('draft');
    expect(detail.notExecutableReasons).toEqual(['plan_not_approved']);
    expect(detail.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(detail.tasks.map((task) => task.status)).toEqual(['pending', 'pending', 'pending']);
    expect(detail.tasks[1]?.acceptance.criteria).toEqual(['任务二验收']);
    expect(detail.dependencies).toEqual([
      { taskId: 't-2', dependsOnId: 't-1' },
      { taskId: 't-3', dependsOnId: 't-2' },
    ]);
    const task = successResult(
      await runApp(env, ['task', 'get', 't-2', '--data-root', root, '--json']),
      'task.get',
    ) as {
      task: {
        id: string;
        featureId: string;
        revision: number;
        status: string;
        acceptance: { criteria: string[] };
        configSource: string;
      };
    };
    expect(task.task.id).toBe('t-2');
    expect(task.task.featureId).toBe(featureId);
    expect(task.task.acceptance.criteria).toEqual(['任务二验收']);
    expect(task.task.status).toBe('pending');
    expect(task.task.configSource).toBe('global_default');

    // 4) 层级分页查询：phases/features/tasks 稳定键集分页。
    const phases = successResult(
      await runApp(env, ['phase', 'list', '--project', projectId, '--data-root', root, '--json']),
      'phase.list',
    ) as { records: { id: string }[]; nextCursor: string | null; limit: number };
    expect(phases.records.map((record) => record.id)).toEqual([phaseId]);
    expect(phases.nextCursor).toBeNull();
    const features = successResult(
      await runApp(env, [
        'feature',
        'list',
        '--project',
        projectId,
        '--phase',
        phaseId,
        '--data-root',
        root,
        '--json',
      ]),
      'feature.list',
    ) as { records: { id: string }[]; nextCursor: string | null };
    expect(features.records.map((record) => record.id)).toEqual([featureId]);
    const firstPage = successResult(
      await runApp(env, [
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
      await runApp(env, [
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

    // 5) 纯标签编辑（Task 自身 revision CAS）：planDigest 不变。
    const labels = receiptOf(
      successResult(
        await runApp(env, [
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
      ),
    );
    expect(labels.status).toBe('completed');
    expect(labels.result).toMatchObject({
      entityType: 'task',
      id: 't-1',
      labels: ['wired'],
      revision: 2,
    });
    const afterLabels = successResult(
      await runApp(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string } };
    expect(afterLabels.feature.planDigest).toBe(digestAfterImport);

    // 6) 实质修订（Feature 聚合 CAS=1 → revision 2）：planDigest 改变。
    const revisePath = join(env.sandboxRoot, 'plan-revised.json');
    writeFileSync(revisePath, JSON.stringify(samplePlan('（实质修订）')), 'utf8');
    const revised = receiptOf(
      successResult(
        await runApp(env, [
          'feature',
          'revise',
          featureId,
          '--project',
          projectId,
          '--revision',
          '1',
          '--input',
          revisePath,
          '--data-root',
          root,
          '--json',
        ]),
        'feature.revise',
      ),
    );
    expect(revised.status).toBe('completed');
    const reviseResult = revised.result as {
      feature: { revision: number; planStatus: string; planDigest: string };
      memberChanges: { keptTaskCount: number; createdTaskCount: number; removedTaskCount: number };
    };
    expect(reviseResult.feature.revision).toBe(2);
    expect(reviseResult.feature.planStatus).toBe('draft');
    expect(reviseResult.feature.planDigest).not.toBe(digestAfterImport);
    expect(reviseResult.memberChanges).toEqual({
      keptTaskCount: 3,
      createdTaskCount: 0,
      removedTaskCount: 0,
    });

    // 7) 不宣称纪律：结构化输出只含草稿/待执行状态，不含批准/通过/运行结论。
    for (const text of [JSON.stringify(imported), JSON.stringify(detail), JSON.stringify(reviseResult)]) {
      expect(text).not.toContain('"approved"');
      expect(text).not.toContain('"passed"');
      expect(text).not.toContain('"runId"');
      expect(text).not.toContain('"workId"');
    }
  }, 120_000);

  it('非法计划整组拒绝、CAS 与业务归属拒绝沿用既有结构化错误约定', async () => {
    const root = useRoot();
    const projectId = await seedProject(root, repoA, 'F-010 拒绝');
    const otherProjectId = await seedProject(root, repoB, 'F-010 其他项目');
    await createGlobalConfig(root);
    const created = receiptOf(
      successResult(
        await runApp(env, [
          'phase',
          'create',
          '--project',
          projectId,
          '--title',
          '拒绝用阶段',
          '--data-root',
          root,
          '--json',
        ]),
        'phase.create',
      ),
    );
    const phaseId = (created.result as { phase: { id: string } }).phase.id;
    const otherPhase = receiptOf(
      successResult(
        await runApp(env, [
          'phase',
          'create',
          '--project',
          otherProjectId,
          '--title',
          '其他项目阶段',
          '--data-root',
          root,
          '--json',
        ]),
        'phase.create',
      ),
    );
    const otherPhaseId = (otherPhase.result as { phase: { id: string } }).phase.id;

    // 合法导入一次（产生可修订的草稿）。
    const planPath = join(env.sandboxRoot, 'plan.json');
    writeFileSync(planPath, JSON.stringify(samplePlan()), 'utf8');
    const imported = receiptOf(
      successResult(
        await runApp(env, [
          'feature',
          'import',
          '--project',
          projectId,
          '--phase',
          phaseId,
          '--revision',
          '1',
          '--input',
          planPath,
          '--data-root',
          root,
          '--json',
        ]),
        'feature.import',
      ),
    );
    const featureId = (imported.result as { feature: { id: string; planDigest: string } }).feature.id;
    const digestBefore = (imported.result as { feature: { planDigest: string } }).feature.planDigest;

    // 非法计划（依赖环）：整组拒绝、零部分写入。
    const badPath = join(env.sandboxRoot, 'plan-bad.json');
    writeFileSync(badPath, JSON.stringify(cyclicPlan()), 'utf8');
    const rejectedPlan = await runApp(env, [
      'feature',
      'revise',
      featureId,
      '--project',
      projectId,
      '--revision',
      '1',
      '--input',
      badPath,
      '--data-root',
      root,
      '--json',
    ]);
    const planError = failureOf(rejectedPlan, 2, 'invalid_input');
    expect(planError?.details?.field ?? planError?.details?.reason).toBeDefined();
    // 错误不回显输入正文。
    expect(rejectedPlan.stdout).not.toContain('非法 Feature');
    expect(rejectedPlan.stdout).not.toContain('t-a');
    const unchanged = successResult(
      await runApp(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as {
      feature: { planDigest: string; revision: number };
      tasks: { id: string }[];
    };
    expect(unchanged.feature.planDigest).toBe(digestBefore);
    expect(unchanged.feature.revision).toBe(1);
    expect(unchanged.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);

    // 旧 revision CAS：不匹配的 expectedRevision 固化 conflict 业务拒绝（退出码 1）。
    const stalePath = join(env.sandboxRoot, 'plan-stale.json');
    writeFileSync(stalePath, JSON.stringify(samplePlan('（旧 CAS）')), 'utf8');
    const stale = await runApp(env, [
      'feature',
      'revise',
      featureId,
      '--project',
      projectId,
      '--revision',
      '7',
      '--input',
      stalePath,
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(stale, 1, 'conflict');

    // 业务归属拒绝：项目 A 命令引用项目 B 的 Phase → forbidden（归属拒绝，不泄漏存在性）。
    const cross = await runApp(env, [
      'feature',
      'import',
      '--project',
      projectId,
      '--phase',
      otherPhaseId,
      '--revision',
      '1',
      '--input',
      planPath,
      '--data-root',
      root,
      '--json',
    ]);
    const crossError = failureOf(cross, 1, 'forbidden');
    expect(crossError?.message.length).toBeGreaterThan(0);
    expect(cross.stdout).not.toContain(otherPhaseId);
  }, 120_000);

  it('输入文件层：非法 JSON/超大/非 UTF-8/缺 CAS 在连接 Host 之前以退出码 2 拒绝', async () => {
    const root = useRoot();
    const baseArgs = [
      'feature',
      'import',
      '--project',
      randomUUID(),
      '--phase',
      'phase-x',
      '--revision',
      '1',
      '--data-root',
      root,
      '--json',
    ];

    // 非法 JSON。
    const badJson = join(env.sandboxRoot, 'bad.json');
    writeFileSync(badJson, '{oops', 'utf8');
    const badJsonError = failureOf(
      await runApp(env, [...baseArgs, '--input', badJson]),
      2,
      'invalid_input',
    );
    expect(badJsonError?.details?.reason).toBe('invalid_input_json');

    // 超大文件（超过有界读取上限）。
    const huge = join(env.sandboxRoot, 'huge.json');
    writeFileSync(huge, `{"pad":"${'x'.repeat(70_000)}"}`, 'utf8');
    const hugeError = failureOf(
      await runApp(env, [...baseArgs, '--input', huge]),
      2,
      'invalid_input',
    );
    expect(hugeError?.details?.reason).toBe('input_file_too_large');

    // 非 UTF-8 字节。
    const binary = join(env.sandboxRoot, 'binary.json');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
    const binaryError = failureOf(
      await runApp(env, [...baseArgs, '--input', binary]),
      2,
      'invalid_input',
    );
    expect(binaryError?.details?.reason).toBe('input_file_encoding');

    // 缺必要 CAS：解析层拒绝（缺 --revision）。
    const planPath = join(env.sandboxRoot, 'plan.json');
    writeFileSync(planPath, JSON.stringify(samplePlan()), 'utf8');
    const noCas = await runApp(env, [
      'feature',
      'import',
      '--project',
      randomUUID(),
      '--phase',
      'phase-x',
      '--input',
      planPath,
      '--data-root',
      root,
      '--json',
    ]);
    const noCasError = failureOf(noCas, 2, 'invalid_input');
    expect(noCasError?.details).toMatchObject({ reason: 'missing_required_option', field: 'revision' });
  }, 60_000);
});
