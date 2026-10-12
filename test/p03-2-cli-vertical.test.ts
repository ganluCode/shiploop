/**
 * P03-2 / F-008 计划决策、Task 策略编辑与固定输入 CLI 纵向（真实 Host + HostClient + SQLite）。
 *
 * 验收面（经 `runAppCli`，与 dist/bin.js 同一执行路径）：
 * - `feature approve/reject` 绑定指定 planDigest + Feature 聚合 expectedRevision
 *   提交决策；结构化输出含实际计划身份、当前审批状态与执行边界视图
 *   （execution.started=false、runnable=false）；批准/拒绝均明确未启动执行；
 * - `task strategy` 完整策略副本 CAS 编辑（来源服务端定值 task_edit）；批准不
 *   重新应用默认策略/不覆盖 Task 副本；planDigest 不因策略编辑改变；
 * - `task prepare` 固定输入制品组准备（version/hash/用途），`task inputs` 经
 *   既有回执查询流程读取复验（不新增查询面、正文永不内联）；
 * - 同请求恢复：同 `--command-id` 冻结信封 + 先查回执重放，异参复用 conflict，
 *   不重新生成参数偷偷绕过幂等；
 * - 失败退出：缺摘要/摘要不匹配/陈旧 revision/重复决定/秘密字段/非法策略/
 *   缺必需输入/未知回执按既有错误与非零退出约定；错误与帮助不泄漏秘密或路径。
 *
 * CLI 只经 Host 公共客户端发请求：不打开状态库、不读取凭据、不在本地推导
 * 批准成功或替换 modelMap、不运行模型；不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import {
  runHostCli,
  type HostCliIo,
} from '../packages/cli/src/host/execute.ts';
import { connectToHost } from '../packages/host/src/index.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 带能力目录的 TS 测试 Host 入口（生产入口目录为空，配置/策略编辑需此夹具）。 */
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry-catalog.ts', import.meta.url),
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

function failureOf(invocation: AppInvocation, exitCode: number, code: string): EnvelopeShape['error'] {
  expect(invocation.result.exitCode, invocation.stderr).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as EnvelopeShape['error'];
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

/** 完整策略副本（task.strategy 的 --input；整体替换，来源服务端定值）。 */
const STRATEGY_EDIT = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-opus',
  credentialRef: 'keychain://shiploop/task-edit',
} as const;

/** 无引用三 Task 链计划（t-1 ← t-2 ← t-3）。 */
function samplePlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '决策纵向 Feature',
      description: 'F-008 纵向描述',
      labels: ['decision'],
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

describe('F-008 决策/策略/固定输入 CLI 纵向（真实 Host + HostClient + SQLite）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  const usedRoots: string[] = [];

  function useRoot(): string {
    usedRoots.push(dataRoot);
    return dataRoot;
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-' });
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

  /** 项目注册 + 全局配置 + Phase + 三 Task 计划导入（F-008 前置）。 */
  async function seed(root: string): Promise<Seeded> {
    const repoA = join(env.sandboxRoot, 'repo-a');
    const registered = successResult(
      await runApp(env, [
        'project', 'register', repoA, '--name', 'F-008 纵向', '--data-root', root, '--json',
      ]),
      'project.register',
    ) as { status: string; result?: { project?: { id?: string } } };
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
        'phase', 'create', '--project', projectId, '--title', '阶段一', '--data-root', root, '--json',
      ]),
      'phase.create',
    ) as { status: string; result: { phase: { id: string } } };
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
    ) as { status: string; result: { feature: { id: string; planDigest: string } } };
    return {
      projectId,
      featureId: imported.result.feature.id,
      planDigest: imported.result.feature.planDigest,
    };
  }

  /** 夹具登记 ready 受管制品（固定输入来源身份；正文仍只经 Artifact 身份读取）。 */
  async function seedReadyArtifact(projectId: string, name: string): Promise<string> {
    const contentHash = createHash('sha256').update(`fixture-${name}`, 'utf8').digest('hex');
    const session = openSqliteStorageSession({ path: join(dataRoot, DATABASE_FILE_NAME) });
    try {
      await migrateSqliteStorage(session);
      const artifactStore = createSqliteArtifactStore(session, { nowUtcMs: () => Date.now() });
      const record = await artifactStore.registerArtifact({
        projectId,
        kind: 'requirement',
        mediaType: 'text/markdown',
        expectedHash: contentHash,
        locator: `artifacts/${name}.md`,
      });
      await artifactStore.transitionArtifact(projectId, record.id, {
        expectedRevision: record.revision,
        outcome: { status: 'ready', actualHash: contentHash, sizeBytes: 32 },
      });
      return record.id;
    } finally {
      session.close();
    }
  }

  it('主线：批准指定摘要 → 策略 CAS 编辑 → 固定输入准备/查看（重放 + 不重新应用默认值）', async () => {
    const root = useRoot();
    const seeded = await seed(root);

    // 基线：批准前 Task 策略副本与来源（用于「批准不重新应用默认值」断言）。
    const before = successResult(
      await runApp(env, ['task', 'get', 't-2', '--data-root', root, '--json']),
      'task.get',
    ) as { task: { revision: number; executionConfig: Record<string, unknown>; configSource: string } };
    const strategyBefore = JSON.stringify(before.task.executionConfig);
    const sourceBefore = before.task.configSource;

    // 1) 批准：绑定 planDigest + Feature 聚合 revision=1。
    const decideCommandId = randomUUID();
    const approved = successResult(
      await runApp(env, [
        'feature', 'approve', seeded.featureId,
        '--project', seeded.projectId,
        '--digest', seeded.planDigest,
        '--revision', '1',
        '--reason', '验收证据已复核',
        '--command-id', decideCommandId,
        '--data-root', root,
        '--json',
      ]),
      'feature.approve',
    ) as {
      commandId: string;
      replayed: boolean;
      feature: { id: string; revision: number; planStatus: string; planDigest: string };
      decision: string;
      approval: { status: string; current: boolean; subjectDigest: string; reason: string | null };
      execution: { started: boolean; capability: string; runnable: boolean };
    };
    // 结构化输出含实际计划身份、当前审批状态；批准明确未启动执行。
    expect(approved.commandId).toBe(decideCommandId);
    expect(approved.replayed).toBe(false);
    expect(approved.feature).toMatchObject({
      id: seeded.featureId,
      planStatus: 'approved',
      planDigest: seeded.planDigest,
    });
    expect(approved.decision).toBe('approve');
    expect(approved.approval.status).toBe('approved');
    expect(approved.approval.current).toBe(true);
    expect(approved.approval.subjectDigest).toBe(seeded.planDigest);
    expect(approved.approval.reason).toBe('验收证据已复核');
    expect(approved.execution).toEqual({ started: false, capability: 'unknown', runnable: false });

    // 2) 同请求恢复：同 --command-id + 同参数 → 人类模式重放原回执
    //    （明确未启动执行；不重新生成参数偷偷绕过幂等）。
    const replayHuman = await runApp(env, [
      'feature', 'approve', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', seeded.planDigest,
      '--revision', '1',
      '--reason', '验收证据已复核',
      '--command-id', decideCommandId,
      '--data-root', root,
    ]);
    expect(replayHuman.result.exitCode, replayHuman.stderr).toBe(0);
    expect(replayHuman.stdout).toContain('未启动执行');
    expect(replayHuman.stdout).toContain('（replayed）');
    expect(replayHuman.stdout).toContain(seeded.planDigest);

    // 异参复用同一命令 ID → conflict（不偷偷换参数绕过幂等）。
    const differentParams = await runApp(env, [
      'feature', 'approve', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', seeded.planDigest,
      '--revision', '2',
      '--command-id', decideCommandId,
      '--data-root', root,
      '--json',
    ]);
    failureOf(differentParams, 1, 'conflict');

    // 3) 批准不重新应用默认值：Task 策略副本与来源逐字节不变。
    const after = successResult(
      await runApp(env, ['task', 'get', 't-2', '--data-root', root, '--json']),
      'task.get',
    ) as { task: { executionConfig: Record<string, unknown>; configSource: string } };
    expect(JSON.stringify(after.task.executionConfig)).toBe(strategyBefore);
    expect(after.task.configSource).toBe(sourceBefore);

    // 4) Task 策略完整副本 CAS 编辑（来源服务端定值 task_edit）。
    const strategyPath = join(env.sandboxRoot, 'strategy.json');
    writeFileSync(strategyPath, JSON.stringify(STRATEGY_EDIT), 'utf8');
    const edited = successResult(
      await runApp(env, [
        'task', 'strategy', 't-2',
        '--project', seeded.projectId,
        '--revision', String(before.task.revision),
        '--input', strategyPath,
        '--data-root', root,
        '--json',
      ]),
      'task.strategy',
    ) as {
      task: { id: string; revision: number };
      strategy: {
        executionConfig: Record<string, unknown>;
        configSource: string;
        configSourceKey: string | null;
      };
      execution: { started: boolean };
    };
    expect(edited.task.id).toBe('t-2');
    expect(edited.task.revision).toBe(before.task.revision + 1);
    expect(edited.strategy.executionConfig).toEqual(STRATEGY_EDIT);
    expect(edited.strategy.configSource).toBe('task_edit');
    expect(edited.strategy.configSourceKey).toBe('taskEdit');
    expect(edited.execution.started).toBe(false);

    // 策略编辑不改变计划摘要与批准身份。
    const featureAfterEdit = successResult(
      await runApp(env, ['feature', 'get', seeded.featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string; planStatus: string } };
    expect(featureAfterEdit.feature.planDigest).toBe(seeded.planDigest);
    expect(featureAfterEdit.feature.planStatus).toBe('approved');

    // 5) 固定输入制品组准备（带一个必需输入来源身份）。
    const artifactId = await seedReadyArtifact(seeded.projectId, 'requirements');
    const itemsPath = join(env.sandboxRoot, 'items.json');
    writeFileSync(
      itemsPath,
      JSON.stringify({
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }],
      }),
      'utf8',
    );
    const prepared = successResult(
      await runApp(env, [
        'task', 'prepare', 't-2',
        '--project', seeded.projectId,
        '--feature', seeded.featureId,
        '--input', itemsPath,
        '--data-root', root,
        '--json',
      ]),
      'task.prepare',
    ) as {
      commandId: string;
      bindable: boolean;
      group: { purpose: string; version: number; contentHash: string; sizeBytes: number }[];
      requiredInputs: { purpose: string; version: number; contentHash: string }[];
      approval: { planDigest: string; checkPolicyDigest: string };
      execution: { started: boolean };
    };
    expect(prepared.bindable).toBe(true);
    expect(prepared.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // 输入制品组 version/hash/用途齐全；正文永不内联。
    expect(prepared.group.map((part) => part.purpose)).toEqual(['snapshot', 'manifest', 'prompt']);
    for (const part of prepared.group) {
      expect(part.version).toBeGreaterThanOrEqual(1);
      expect(part.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(part.sizeBytes).toBeGreaterThan(0);
    }
    expect(prepared.requiredInputs).toHaveLength(1);
    expect(prepared.requiredInputs[0]?.purpose).toBe('requirements');
    expect(prepared.requiredInputs[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.approval.planDigest).toBe(seeded.planDigest);
    expect(prepared.approval.checkPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.execution.started).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain('keychain://');
    expect(JSON.stringify(prepared)).not.toContain(env.sandboxRoot);

    // 6) 固定输入查看（独立调用 + 既有回执查询流程；version/hash/用途读取复验）。
    const viewed = successResult(
      await runApp(env, ['task', 'inputs', prepared.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as {
      commandId: string;
      group: { purpose: string; version: number; contentHash: string }[];
      requiredInputs: { purpose: string; contentHash: string }[];
      approval: { planDigest: string };
      execution: { started: boolean };
    };
    expect(viewed.commandId).toBe(prepared.commandId);
    expect(viewed.group).toEqual(prepared.group);
    expect(viewed.requiredInputs).toEqual(prepared.requiredInputs);
    expect(viewed.approval.planDigest).toBe(seeded.planDigest);
    expect(viewed.execution.started).toBe(false);

    // 人类输出：准备/查看均明确未启动执行且携带回执身份。
    const prepareHuman = await runApp(env, [
      'task', 'prepare', 't-2',
      '--project', seeded.projectId,
      '--feature', seeded.featureId,
      '--input', itemsPath,
      '--command-id', randomUUID(),
      '--data-root', root,
    ]);
    expect(prepareHuman.result.exitCode, prepareHuman.stderr).toBe(0);
    expect(prepareHuman.stdout).toContain('未启动执行');
    const viewHuman = await runApp(env, ['task', 'inputs', prepared.commandId, '--data-root', root]);
    expect(viewHuman.result.exitCode).toBe(0);
    expect(viewHuman.stdout).toContain('未启动执行');
    expect(viewHuman.stdout).toContain(prepared.commandId);
  });

  it('决策拒绝矩阵：摘要不匹配/陈旧 revision/重复决定明确失败退出，拒绝不启动执行', async () => {
    const root = useRoot();
    const seeded = await seed(root);
    const wrongDigest = 'b'.repeat(64);

    // 摘要不匹配 → conflict（plan_digest_mismatch）+ 退出码 1。
    const mismatch = await runApp(env, [
      'feature', 'approve', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', wrongDigest,
      '--revision', '1',
      '--data-root', root,
      '--json',
    ]);
    const mismatchError = failureOf(mismatch, 1, 'conflict');
    expect(mismatchError?.details?.reason).toBe('plan_digest_mismatch');
    expect(mismatch.stdout).not.toContain('"decision"');

    // 陈旧 revision → conflict（携带 expected/actual）+ 退出码 1。
    const stale = await runApp(env, [
      'feature', 'reject', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', seeded.planDigest,
      '--revision', '99',
      '--data-root', root,
      '--json',
    ]);
    const staleError = failureOf(stale, 1, 'conflict');
    expect(staleError?.details?.reason).toBe('conflict');
    expect(staleError?.details?.expectedRevision).toBe(99);

    // 首次拒绝成功（JSON）：输出明确未启动执行 + approval=rejected。
    const rejectCommandId = randomUUID();
    const rejected = successResult(
      await runApp(env, [
        'feature', 'reject', seeded.featureId,
        '--project', seeded.projectId,
        '--digest', seeded.planDigest,
        '--revision', '1',
        '--command-id', rejectCommandId,
        '--data-root', root,
        '--json',
      ]),
      'feature.reject',
    ) as {
      decision: string;
      approval: { status: string; subjectDigest: string };
      feature: { planStatus: string };
      execution: { started: boolean; runnable: boolean };
    };
    expect(rejected.decision).toBe('reject');
    expect(rejected.approval.status).toBe('rejected');
    expect(rejected.approval.subjectDigest).toBe(seeded.planDigest);
    expect(rejected.feature.planStatus).toBe('draft');
    expect(rejected.execution).toEqual({ started: false, capability: 'unknown', runnable: false });

    // 拒绝人类输出同样明确未启动执行（同请求重放）。
    const rejectHuman = await runApp(env, [
      'feature', 'reject', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', seeded.planDigest,
      '--revision', '1',
      '--command-id', rejectCommandId,
      '--data-root', root,
    ]);
    expect(rejectHuman.result.exitCode, rejectHuman.stderr).toBe(0);
    expect(rejectHuman.stdout).toContain('未启动执行');
    expect(rejectHuman.stdout).toContain('（replayed）');

    // 重复决定（同主体同身份）→ conflict（approval_already_decided）。
    const duplicate = await runApp(env, [
      'feature', 'approve', seeded.featureId,
      '--project', seeded.projectId,
      '--digest', seeded.planDigest,
      '--revision', '2',
      '--data-root', root,
      '--json',
    ]);
    const duplicateError = failureOf(duplicate, 1, 'conflict');
    expect(duplicateError?.details?.reason).toBe('approval_already_decided');
  });

  it('失败退出矩阵：秘密字段/非法策略/缺必需输入/未知回执按既有约定，不泄漏秘密', async () => {
    const root = useRoot();
    const seeded = await seed(root);

    // 秘密字段在连接 Host 之前拒绝（退出码 2，不回显值）。
    const secretPath = join(env.sandboxRoot, 'secret-strategy.json');
    writeFileSync(
      secretPath,
      JSON.stringify({ runtime: 'pi', provider: 'anthropic', model: 'm', apiKey: 'sk-secret-value' }),
      'utf8',
    );
    const secret = await runApp(env, [
      'task', 'strategy', 't-2',
      '--project', seeded.projectId,
      '--revision', '1',
      '--input', secretPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(secret, 2, 'invalid_input');
    expect(secret.stdout).not.toContain('sk-secret-value');
    expect(secret.stderr).not.toContain('sk-secret-value');

    // 非法策略（缺 schemaVersion 标记/孤立 model）→ 服务端权威拒绝（invalid_input，退出码 2）。
    const invalidPath = join(env.sandboxRoot, 'invalid-strategy.json');
    writeFileSync(invalidPath, JSON.stringify({ model: 'only-model' }), 'utf8');
    const invalid = await runApp(env, [
      'task', 'strategy', 't-2',
      '--project', seeded.projectId,
      '--revision', '1',
      '--input', invalidPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(invalid, 2, 'invalid_input');

    // 有效批准（后续固定输入用例的前置）。
    const decideCommandId = randomUUID();
    successResult(
      await runApp(env, [
        'feature', 'approve', seeded.featureId,
        '--project', seeded.projectId,
        '--digest', seeded.planDigest,
        '--revision', '1',
        '--command-id', decideCommandId,
        '--data-root', root,
        '--json',
      ]),
      'feature.approve',
    );

    // 固定输入缺必需输入（未知制品）→ 明确失败（not_found，退出码 1）。
    const itemsPath = join(env.sandboxRoot, 'items.json');
    writeFileSync(
      itemsPath,
      JSON.stringify({
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: 'art-missing' } }],
      }),
      'utf8',
    );
    const missingInput = await runApp(env, [
      'task', 'prepare', 't-2',
      '--project', seeded.projectId,
      '--feature', seeded.featureId,
      '--input', itemsPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(missingInput, 1, 'not_found');

    // 固定输入清单中的秘密字段 → 退出码 2。
    const secretItemsPath = join(env.sandboxRoot, 'secret-items.json');
    writeFileSync(
      secretItemsPath,
      JSON.stringify({
        items: [
          {
            purpose: 'requirements',
            source: { kind: 'file', root: 'docs', relativePath: 'a.md' },
            token: 'sk-secret-value',
          },
        ],
      }),
      'utf8',
    );
    const secretItems = await runApp(env, [
      'task', 'prepare', 't-2',
      '--project', seeded.projectId,
      '--feature', seeded.featureId,
      '--input', secretItemsPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(secretItems, 2, 'invalid_input');
    expect(secretItems.stdout).not.toContain('sk-secret-value');

    // 未知回执 → 明确失败（not_found）。
    const unknownView = await runApp(env, [
      'task', 'inputs', randomUUID(), '--data-root', root, '--json',
    ]);
    failureOf(unknownView, 1, 'not_found');

    // 非准备回执 → invalid_input（receipt_operation_mismatch）。
    const wrongReceipt = await runApp(env, [
      'task', 'inputs', decideCommandId, '--data-root', root, '--json',
    ]);
    const wrongReceiptError = failureOf(wrongReceipt, 2, 'invalid_input');
    expect(wrongReceiptError?.details?.reason).toBe('receipt_operation_mismatch');
  });
});
