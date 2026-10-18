/**
 * P03-3 / F-012 执行授权 CLI 纵向（真实临时 Host + 真实 SQLite + 真实 Git）。
 *
 * 验收面（经 `runAppCli`，与 dist/bin.js 同一执行路径；命令只经过 Host）：
 * - 预览后确认：`execution preview` 得到 ready 与 previewDigest，`execution start
 *   --confirm --preview-digest` 显式授权后返回真实 Batch/Run ID；accepted 只是
 *   提交成功（退出码 0），输出不被描述为 Feature 已验收通过；
 * - 同命令重放：同 `--command-id` 冻结信封 + 先查回执重放，返回同一 Batch/Run；
 * - 状态查询：`execution budget` 显示真实 Batch/Run ID、各层剩余额度、queued 未
 *   执行事实（runtimeStarts=0、runtime_not_found）与修订历史；
 * - 显式修订：`execution revise --revision <budget_revision> --reason` CAS 修订，
 *   陈旧 revision 拒绝；修订历史与剩余额度经查询复核；
 * - 参数校验（缺少预算/非法日期/非法整数/有效并发大于一/冲突参数/缺失确认）
 *   全部在连接 Host 之前以退出码 2 拒绝，且不发启动请求（回执 not_found）；
 *   过期预览与授权拒绝有稳定原因与非成功分类。
 *
 * 不改全局用户配置（隔离 HOME/数据根）、不调用真实模型、不实现 wait/cancel/resume。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../../../../packages/cli/src/app-execute.ts';
import {
  runHostCli,
  type HostCliIo,
} from '../../../../packages/cli/src/host/execute.ts';
import { connectToHost } from '../../../../packages/host/src/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from '../../../helpers/host/index.ts';
import { commitAll, initGitRepo } from '../../../helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../../helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

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

function failureOf(invocation: AppInvocation, exitCode: number, code: string): NonNullable<EnvelopeShape['error']> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as NonNullable<EnvelopeShape['error']>;
  expect(error?.code).toBe(code);
  return error;
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

/** 主线预算文档（deadline 用 ISO-8601 UTC 日期，CLI 映射为 epoch 毫秒）。 */
const BUDGET_DOCUMENT = {
  batch: {
    maxRuns: 2,
    maxTotalAttempts: 4,
    maxRuntimeStarts: 3,
    maxNoProgressRuns: 2,
    deadlineUtcMs: '2099-06-01T00:00:00.000Z',
    maxTokenTotal: 1_000,
    maxCostTotal: 12.5,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
} as const;

/** 修订预算（仅增额/延期）。 */
const REVISED_BUDGET_DOCUMENT = {
  batch: {
    maxRuns: 3,
    maxTotalAttempts: 6,
    maxRuntimeStarts: 5,
    maxNoProgressRuns: 3,
    deadlineUtcMs: '2099-07-01T00:00:00.000Z',
    maxTokenTotal: 2_000,
    maxCostTotal: 20,
  },
  run: { maxAttemptsPerRun: 3, runTimeLimitMs: 7_200_000 },
} as const;

/** 无引用两 Task 链计划（t-1 ← t-2）。 */
function samplePlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '执行授权纵向 Feature',
      description: 'F-012 纵向描述',
      labels: ['execution'],
      sourceRefs: [],
    },
    tasks: [
      { id: 't-1', title: '任务一', complexity: 'low', acceptance: { criteria: ['任务一验收'] } },
      {
        id: 't-2',
        title: '任务二',
        complexity: 'medium',
        acceptance: { criteria: ['任务二验收'] },
        dependsOn: ['t-1'],
      },
    ],
  };
}

describe('F-012 执行授权 CLI 纵向（真实 Host + SQLite + Git）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  const usedRoots: string[] = [];

  function useRoot(): string {
    usedRoots.push(dataRoot);
    return dataRoot;
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f012-' });
    dataRoot = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    const repoA = join(env.sandboxRoot, 'repo-a');
    initGitRepo(repoA);
    writeFileSync(join(repoA, 'README.md'), '# Repo A\n', 'utf8');
    commitAll(repoA, 'init A', { home });
  });

  afterEach(async () => {
    for (const root of usedRoots) {
      await stopHostBestEffort(root);
    }
    usedRoots.length = 0;
    await env.dispose();
  });

  interface Seeded {
    readonly projectId: string;
    readonly featureId: string;
    readonly planDigest: string;
  }

  /** 项目注册 + 全局配置 + Phase + 两 Task 计划导入 + 批准（执行授权前置）。 */
  async function seed(root: string): Promise<Seeded> {
    const repoA = join(env.sandboxRoot, 'repo-a');
    const registered = successResult(
      await runApp(env, [
        'project', 'register', repoA, '--name', 'F-012 纵向', '--data-root', root, '--json',
      ]),
      'project.register',
    ) as { result?: { project?: { id?: string } } };
    const projectId = registered.result?.project?.id as string;
    expect(typeof projectId).toBe('string');

    const configPath = join(env.sandboxRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify(GLOBAL_CONFIG), 'utf8');
    successResult(
      await runApp(env, [
        'config', 'create', '--scope', 'global', '--input', configPath, '--data-root', root, '--json',
      ]),
      'config.create',
    );

    const created = successResult(
      await runApp(env, [
        'phase', 'create', '--project', projectId, '--title', '执行阶段', '--data-root', root, '--json',
      ]),
      'phase.create',
    ) as { result: { phase: { id: string } } };
    const planPath = join(env.sandboxRoot, 'plan.json');
    writeFileSync(planPath, JSON.stringify(samplePlan()), 'utf8');
    const imported = successResult(
      await runApp(env, [
        'feature', 'import',
        '--project', projectId,
        '--phase', created.result.phase.id,
        '--revision', '1',
        '--input', planPath,
        '--data-root', root,
        '--json',
      ]),
      'feature.import',
    ) as { result: { feature: { id: string; planDigest: string } } };

    const approved = successResult(
      await runApp(env, [
        'feature', 'approve', imported.result.feature.id,
        '--project', projectId,
        '--digest', imported.result.feature.planDigest,
        '--revision', '1',
        '--data-root', root,
        '--json',
      ]),
      'feature.approve',
    );
    expect(approved).toBeDefined();
    return {
      projectId,
      featureId: imported.result.feature.id,
      planDigest: imported.result.feature.planDigest,
    };
  }

  function writeBudgetFile(name: string, document: unknown): string {
    const path = join(env.sandboxRoot, name);
    writeFileSync(path, JSON.stringify(document), 'utf8');
    return path;
  }

  it('主线：预览后确认启动 → 同命令重放 → 状态查询 → 显式修订（accepted 不冒充验收完成）', async () => {
    const root = useRoot();
    const seeded = await seed(root);
    const budgetPath = writeBudgetFile('budget.json', BUDGET_DOCUMENT);

    // 1) 预览（只读；不是授权）。
    const previewCommandId = randomUUID();
    const preview = successResult(
      await runApp(env, [
        'execution', 'preview', seeded.featureId,
        '--project', seeded.projectId,
        '--input', budgetPath,
        '--command-id', previewCommandId,
        '--data-root', root,
        '--json',
      ]),
      'execution.preview',
    ) as {
      status: string;
      previewDigest: string | null;
      authorization: { confirmed: boolean };
      execution: { started: boolean; runtimeExecution: boolean };
      summary: { plan: { taskCount: number; pendingTaskIds: string[] } } | null;
    };
    expect(preview.status).toBe('ready');
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.authorization.confirmed).toBe(false);
    expect(preview.execution).toEqual({ started: false, runtimeExecution: false });
    expect(preview.summary?.plan.taskCount).toBe(2);

    // 2) 显式确认启动：真实 Batch/Run ID；accepted = 提交成功（退出码 0），不等于验收完成。
    const startCommandId = randomUUID();
    const started = successResult(
      await runApp(env, [
        'execution', 'start', seeded.featureId,
        '--project', seeded.projectId,
        '--input', budgetPath,
        '--preview-digest', preview.previewDigest as string,
        '--confirm',
        '--command-id', startCommandId,
        '--data-root', root,
        '--json',
      ]),
      'execution.start',
    ) as {
      status: string;
      executionState: string;
      batchId: string;
      runId: string;
      operationId: string;
      completion: { featureVerified: boolean; businessCompleted: boolean };
    };
    expect(started.status).toBe('accepted');
    expect(started.executionState).toBe('accepted');
    expect(started.batchId).toBe(started.operationId);
    expect(started.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.completion).toEqual(
      expect.objectContaining({ featureVerified: false, businessCompleted: false }),
    );

    // 3) 同命令重放：同 --command-id 同参 → 原回执（同一 Batch/Run，不重复扣额）。
    const replayed = successResult(
      await runApp(env, [
        'execution', 'start', seeded.featureId,
        '--project', seeded.projectId,
        '--input', budgetPath,
        '--preview-digest', preview.previewDigest as string,
        '--confirm',
        '--command-id', startCommandId,
        '--data-root', root,
        '--json',
      ]),
      'execution.start',
    ) as { replayed: boolean; batchId: string; runId: string };
    expect(replayed.replayed).toBe(true);
    expect(replayed.batchId).toBe(started.batchId);
    expect(replayed.runId).toBe(started.runId);

    // 4) 状态查询：真实身份 + 剩余额度 + 尚未执行事实 + 初始修订历史。
    const queried = successResult(
      await runApp(env, [
        'execution', 'budget', started.batchId,
        '--project', seeded.projectId,
        '--data-root', root,
        '--json',
      ]),
      'execution.budget',
    ) as {
      executionState: string;
      states: Record<string, boolean>;
      budget: {
        batch: {
          id: string;
          budgetRevision: number;
          runtimeStartsReserved: number;
          dimensions: Record<string, { limit: number; used: number | null; remaining: number | null; exhausted: boolean | null }>;
          usage: { tokenUsed: number | null; costUsed: number | null };
        };
        runs: { id: string; status: string; reason: string | null; startedAt: string | null }[];
      };
      revisions: { records: { version: number }[] };
    };
    expect(queried.executionState).toBe('not_executed');
    expect(queried.states).toMatchObject({ accepted: true, notExecuted: true, businessCompleted: false });
    expect(queried.budget.batch.id).toBe(started.batchId);
    expect(queried.budget.batch.budgetRevision).toBe(1);
    expect(queried.budget.batch.runtimeStartsReserved).toBe(0);
    expect(queried.budget.batch.dimensions.maxRuns).toEqual({ limit: 2, used: 1, remaining: 1, exhausted: false });
    // 未知 token/cost 用量保持未知（不填零）。
    expect(queried.budget.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
    expect(queried.budget.runs.map((run) => run.id)).toEqual([started.runId]);
    expect(queried.budget.runs[0]).toMatchObject({
      status: 'queued',
      reason: 'runtime_not_found',
      startedAt: null,
    });
    expect(queried.revisions.records.map((record) => record.version)).toEqual([1]);

    // 5) 显式修订（expectedRevision + 理由）。
    const revisePath = writeBudgetFile('budget-revised.json', REVISED_BUDGET_DOCUMENT);
    const revised = successResult(
      await runApp(env, [
        'execution', 'revise', started.batchId,
        '--project', seeded.projectId,
        '--revision', '1',
        '--reason', '纵向验收增额',
        '--input', revisePath,
        '--data-root', root,
        '--json',
      ]),
      'execution.revise',
    ) as { batchId: string; budgetRevision: number; previous: { version: number }; revised: { version: number } };
    expect(revised.batchId).toBe(started.batchId);
    expect(revised.budgetRevision).toBe(2);
    expect(revised.previous.version).toBe(1);
    expect(revised.revised.version).toBe(2);

    // 修订后剩余额度与修订历史经查询复核（revision 2 → 3 份历史）。
    const afterRevise = successResult(
      await runApp(env, [
        'execution', 'budget', started.batchId,
        '--project', seeded.projectId,
        '--data-root', root,
        '--json',
      ]),
      'execution.budget',
    ) as {
      budget: { batch: { budgetRevision: number; dimensions: Record<string, { limit: number; remaining: number | null }> } };
      revisions: { records: { version: number }[] };
    };
    expect(afterRevise.budget.batch.budgetRevision).toBe(2);
    expect(afterRevise.budget.batch.dimensions.maxRuns).toMatchObject({ limit: 3, remaining: 2 });
    expect(afterRevise.revisions.records.map((record) => record.version)).toEqual([1, 2]);

    // 陈旧 expectedRevision → conflict（零写入）。
    const stale = await runApp(env, [
      'execution', 'revise', started.batchId,
      '--project', seeded.projectId,
      '--revision', '1',
      '--reason', '陈旧 revision',
      '--input', revisePath,
      '--data-root', root,
      '--json',
    ]);
    const staleError = failureOf(stale, 1, 'conflict');
    expect(staleError.details?.reason).toBe('budget_revision_stale');
  });

  it('过期预览：显式启动携带不匹配 previewDigest → preview_stale 稳定原因（非成功分类，可查回执）', async () => {
    const root = useRoot();
    const seeded = await seed(root);
    const budgetPath = writeBudgetFile('budget.json', BUDGET_DOCUMENT);
    const startCommandId = randomUUID();
    const stale = await runApp(env, [
      'execution', 'start', seeded.featureId,
      '--project', seeded.projectId,
      '--input', budgetPath,
      '--preview-digest', 'b'.repeat(64),
      '--confirm',
      '--command-id', startCommandId,
      '--data-root', root,
      '--json',
    ]);
    const error = failureOf(stale, 1, 'conflict');
    expect(error.details?.reason).toBe('preview_stale');

    // 固化 rejected 回执可查（receipt get 按 §12.3 展示原业务拒绝，保留 commandId；
    // 零创建零扣额）。
    const receipt = await runApp(env, ['receipt', 'get', startCommandId, '--data-root', root, '--json']);
    const receiptError = failureOf(receipt, 1, 'conflict');
    expect(receiptError.commandId).toBe(startCommandId);
    expect(receiptError.details?.reason).toBe('preview_stale');
  });

  it('参数校验（缺少预算/非法日期/非法整数/有效并发大于一/冲突参数/缺失确认）不发启动请求', async () => {
    const root = useRoot();
    const seeded = await seed(root);
    const invalidDatePath = writeBudgetFile('budget-bad-date.json', {
      ...BUDGET_DOCUMENT,
      batch: { ...BUDGET_DOCUMENT.batch, deadlineUtcMs: 'not-a-date' },
    });
    const invalidIntPath = writeBudgetFile('budget-bad-int.json', {
      ...BUDGET_DOCUMENT,
      batch: { ...BUDGET_DOCUMENT.batch, maxRuns: 1.5 },
    });
    const concurrencyPath = writeBudgetFile('budget-concurrency.json', {
      ...BUDGET_DOCUMENT,
      concurrency: { maxConcurrentWorks: 2 },
    });
    const budgetPath = writeBudgetFile('budget.json', BUDGET_DOCUMENT);

    const cases: { args: readonly string[]; reason: string }[] = [
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--input', budgetPath,
          '--preview-digest', 'a'.repeat(64),
        ],
        reason: 'confirmation_required',
      },
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--preview-digest', 'a'.repeat(64),
          '--confirm',
        ],
        reason: 'missing_budget',
      },
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--input', invalidDatePath,
          '--preview-digest', 'a'.repeat(64),
          '--confirm',
        ],
        reason: 'invalid_budget_date',
      },
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--input', invalidIntPath,
          '--preview-digest', 'a'.repeat(64),
          '--confirm',
        ],
        reason: 'invalid_integer',
      },
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--input', concurrencyPath,
          '--preview-digest', 'a'.repeat(64),
          '--confirm',
        ],
        reason: 'concurrency_not_supported',
      },
      {
        args: [
          'execution', 'start', seeded.featureId,
          '--project', seeded.projectId,
          '--retry-batch', randomUUID(),
          '--input', budgetPath,
          '--confirm',
        ],
        reason: 'conflicting_options',
      },
    ];

    for (const testCase of cases) {
      const commandId = randomUUID();
      const invocation = await runApp(env, [
        ...testCase.args,
        '--command-id', commandId,
        '--data-root', root,
        '--json',
      ]);
      const error = failureOf(invocation, 2, 'invalid_input');
      expect(error.details?.reason, JSON.stringify(testCase.args)).toBe(testCase.reason);
      // 输入错误不发启动请求：该 commandId 下无任何回执。
      const receipt = await runApp(env, ['receipt', 'get', commandId, '--data-root', root, '--json']);
      failureOf(receipt, 1, 'not_found');
    }
  });

  it('授权拒绝（跨项目预算查询）不泄漏存在性；预算查询零写入', async () => {
    const root = useRoot();
    const seeded = await seed(root);
    const budgetPath = writeBudgetFile('budget.json', BUDGET_DOCUMENT);
    const preview = successResult(
      await runApp(env, [
        'execution', 'preview', seeded.featureId,
        '--project', seeded.projectId,
        '--input', budgetPath,
        '--data-root', root,
        '--json',
      ]),
      'execution.preview',
    ) as { previewDigest: string | null };
    const started = successResult(
      await runApp(env, [
        'execution', 'start', seeded.featureId,
        '--project', seeded.projectId,
        '--input', budgetPath,
        '--preview-digest', preview.previewDigest as string,
        '--confirm',
        '--data-root', root,
        '--json',
      ]),
      'execution.start',
    ) as { batchId: string };

    // 第二个项目（跨项目查询负例）。
    const repoB = join(env.sandboxRoot, 'repo-b');
    initGitRepo(repoB);
    writeFileSync(join(repoB, 'README.md'), '# Repo B\n', 'utf8');
    commitAll(repoB, 'init B', { home: env.childEnv().HOME as string });
    const registeredB = successResult(
      await runApp(env, [
        'project', 'register', repoB, '--name', 'F-012 纵向 B', '--data-root', root, '--json',
      ]),
      'project.register',
    ) as { result: { project: { id: string } } };

    const crossed = await runApp(env, [
      'execution', 'budget', started.batchId,
      '--project', registeredB.result.project.id,
      '--data-root', root,
      '--json',
    ]);
    const crossedError = failureOf(crossed, 1, 'not_found');
    expect(crossedError.message).not.toContain(started.batchId);

    // 同项目查询零写入：状态与修订历史保持一致。
    const queried = successResult(
      await runApp(env, [
        'execution', 'budget', started.batchId,
        '--project', seeded.projectId,
        '--data-root', root,
        '--json',
      ]),
      'execution.budget',
    ) as { budget: { batch: { budgetRevision: number } }; revisions: { records: unknown[] } };
    expect(queried.budget.batch.budgetRevision).toBe(1);
    expect(queried.revisions.records).toHaveLength(1);
  });
});
