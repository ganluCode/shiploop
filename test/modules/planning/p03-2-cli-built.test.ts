/**
 * P03-2 / F-008 构建后 CLI 验收（真实 dist/bin.js + 正构建 Host）。
 *
 * 定位：F-008 的「构建后 CLI 测试」——beforeAll 真实 `npm run build`，全部命令
 * 经真实 `packages/cli/dist/bin.js` 子进程执行；Host 用 npm run build 的 dist
 * 产物（dist-host-entry-catalog.mjs 装配 dist/runtime 与 dist/core，受信测试
 * 能力目录只服务配置/策略复检，不是产品能力放宽；纪律见该文件头）：
 * - 主线：project register → config create → phase create → feature import →
 *   `feature approve`（实际计划身份 + 当前审批状态 + execution.started=false）→
 *   `task strategy`（task_edit 来源 + planDigest 不变）→ `task prepare` 制品组
 *   （version/hash/用途）→ `task inputs` 经既有回执查询读取复验；
 * - 同请求恢复：同 `--command-id` 冻结信封 + 先查回执重放（replayed）；
 * - 失败退出：缺摘要/摘要不匹配/秘密字段/未知回执按既有 0/1/2 约定；
 * - 帮助（构建后入口）：批准/拒绝明确未启动执行、未知执行能力不显示为可运行，
 *   不出现 Run/Work 启动命令；输出不泄漏秘密或开发机路径。
 *
 * 复用既有夹具（isolated-environment / git-repo），不另建体系；不读真实凭据、
 * 不联网、不调用模型、不修改开发仓库或用户 HOME；全部等待有界。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_FILE_NAME } from '../../../packages/core/src/ports/path-service.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { commitAll, initGitRepo } from '../../helpers/git-repo.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 真实 dist CLI 可执行入口（npm run build 产物，与生产同一入口）。 */
const DIST_CLI_BIN = fileURLToPath(new URL('../../../packages/cli/dist/bin.js', import.meta.url));
/** 装配 dist 产物的 Host 入口（受信测试能力目录；纪律见文件头）。 */
const DIST_CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/dist-host-entry-catalog.mjs', import.meta.url),
);

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
 * 进程/等待小工具（与 p03-1 集成回归同一口径）
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
  expect(invocation.exitCode, invocation.stderr).toBe(exitCode);
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
): Promise<number> {
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
        return discovery.pid;
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
 * 计划/配置夹具（与 F-008 纵向同值语义，正式构建链路复核）
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

const STRATEGY_EDIT = {
  schemaVersion: 2,
  runtime: 'pi',
  provider: 'anthropic',
  model: 'claude-opus',
} as const;

function samplePlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '构建后决策 Feature',
      description: 'F-008 构建后描述',
      labels: ['built'],
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

describe('F-008 构建后 CLI（真实 dist/bin.js + 正式构建 Host）', () => {
  let env: IsolatedHostEnvironment;

  afterEach(async () => {
    await env.dispose();
  });

  /** 夹具登记 ready 受管制品（固定输入来源身份；仅测试装配）。 */
  async function seedReadyArtifact(root: string, projectId: string, name: string): Promise<string> {
    const contentHash = createHash('sha256').update(`fixture-${name}`, 'utf8').digest('hex');
    const session = openSqliteStorageSession({ path: join(root, DATABASE_FILE_NAME) });
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

  it('构建后主线：批准 → 策略编辑 → 固定输入准备/查看 + 重放 + 失败退出', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-built-' });
    const root = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    const repoDir = join(env.sandboxRoot, 'repo-a');
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# Repo A\n', 'utf8');
    commitAll(repoDir, 'init A', { home });

    const hostPid = await startCatalogHost(env, root, 'F-008 构建后');

    // 项目 + 配置 + Phase + 计划导入（既有命令）。
    const registered = successResult(
      await runDistCli(env, ['project', 'register', repoDir, '--name', 'F-008 built', '--data-root', root, '--json']),
      'project.register',
    ) as { result: { project: { id: string } } };
    const projectId = registered.result.project.id;
    const configPath = join(env.sandboxRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify(GLOBAL_CONFIG), 'utf8');
    successResult(
      await runDistCli(env, ['config', 'create', '--scope', 'global', '--input', configPath, '--data-root', root, '--json']),
      'config.create',
    );
    const created = successResult(
      await runDistCli(env, ['phase', 'create', '--project', projectId, '--title', '阶段一', '--data-root', root, '--json']),
      'phase.create',
    ) as { result: { phase: { id: string } } };
    const planPath = join(env.sandboxRoot, 'plan.json');
    writeFileSync(planPath, JSON.stringify(samplePlan()), 'utf8');
    const imported = successResult(
      await runDistCli(env, [
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
    const featureId = imported.result.feature.id;
    const planDigest = imported.result.feature.planDigest;

    // feature approve：实际计划身份 + 当前审批状态 + 未启动执行。
    const decideCommandId = randomUUID();
    const approved = successResult(
      await runDistCli(env, [
        'feature', 'approve', featureId,
        '--project', projectId,
        '--digest', planDigest,
        '--revision', '1',
        '--command-id', decideCommandId,
        '--data-root', root,
        '--json',
      ]),
      'feature.approve',
    ) as {
      commandId: string;
      replayed: boolean;
      feature: { planDigest: string; planStatus: string };
      approval: { status: string; subjectDigest: string };
      execution: { started: boolean; runnable: boolean };
    };
    expect(approved.commandId).toBe(decideCommandId);
    expect(approved.replayed).toBe(false);
    expect(approved.feature.planDigest).toBe(planDigest);
    expect(approved.feature.planStatus).toBe('approved');
    expect(approved.approval.status).toBe('approved');
    expect(approved.approval.subjectDigest).toBe(planDigest);
    expect(approved.execution).toEqual({ started: false, capability: 'unknown', runnable: false });

    // 同请求恢复：同 --command-id 重放（replayed），人类输出明确未启动执行。
    const replay = await runDistCli(env, [
      'feature', 'approve', featureId,
      '--project', projectId,
      '--digest', planDigest,
      '--revision', '1',
      '--command-id', decideCommandId,
      '--data-root', root,
    ]);
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(replay.stdout).toContain('未启动执行');
    expect(replay.stdout).toContain('（replayed）');

    // task strategy：完整副本 CAS 编辑（来源 task_edit；planDigest 不变）。
    const strategyPath = join(env.sandboxRoot, 'strategy.json');
    writeFileSync(strategyPath, JSON.stringify(STRATEGY_EDIT), 'utf8');
    const edited = successResult(
      await runDistCli(env, [
        'task', 'strategy', 't-2',
        '--project', projectId,
        '--revision', '1',
        '--input', strategyPath,
        '--data-root', root,
        '--json',
      ]),
      'task.strategy',
    ) as {
      strategy: { executionConfig: Record<string, unknown>; configSource: string; configSourceKey: string | null };
      execution: { started: boolean };
    };
    expect(edited.strategy.executionConfig).toEqual(STRATEGY_EDIT);
    expect(edited.strategy.configSource).toBe('task_edit');
    expect(edited.strategy.configSourceKey).toBe('taskEdit');
    expect(edited.execution.started).toBe(false);
    const featureAfter = successResult(
      await runDistCli(env, ['feature', 'get', featureId, '--data-root', root, '--json']),
      'feature.get',
    ) as { feature: { planDigest: string; planStatus: string } };
    expect(featureAfter.feature.planDigest).toBe(planDigest);
    expect(featureAfter.feature.planStatus).toBe('approved');

    // task prepare + task inputs：制品组 version/hash/用途读取复验。
    const itemsPath = join(env.sandboxRoot, 'items.json');
    writeFileSync(
      itemsPath,
      JSON.stringify({
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: 'art-missing' } }],
      }),
      'utf8',
    );
    // 缺必需输入（未知制品）→ 明确失败（not_found）。
    const missingInput = await runDistCli(env, [
      'task', 'prepare', 't-2',
      '--project', projectId,
      '--feature', featureId,
      '--input', itemsPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(missingInput, 1, 'not_found');

    // 空清单也被显式拒绝（缺失必需输入不静默省略）。
    const emptyItemsPath = join(env.sandboxRoot, 'empty-items.json');
    writeFileSync(emptyItemsPath, JSON.stringify({ items: [] }), 'utf8');
    const emptyInput = await runDistCli(env, [
      'task', 'prepare', 't-2',
      '--project', projectId,
      '--feature', featureId,
      '--input', emptyItemsPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(emptyInput, 2, 'invalid_input');

    // 成功路径：固定输入制品组准备 + 读取复验（version/hash/用途）。
    const artifactId = await seedReadyArtifact(root, projectId, 'requirements');
    const okItemsPath = join(env.sandboxRoot, 'ok-items.json');
    writeFileSync(
      okItemsPath,
      JSON.stringify({
        items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId } }],
      }),
      'utf8',
    );
    const prepared = successResult(
      await runDistCli(env, [
        'task', 'prepare', 't-2',
        '--project', projectId,
        '--feature', featureId,
        '--input', okItemsPath,
        '--data-root', root,
        '--json',
      ]),
      'task.prepare',
    ) as {
      commandId: string;
      bindable: boolean;
      group: { purpose: string; version: number; contentHash: string }[];
      requiredInputs: { purpose: string; contentHash: string }[];
      approval: { planDigest: string };
      execution: { started: boolean };
    };
    expect(prepared.bindable).toBe(true);
    expect(prepared.group.map((part) => part.purpose)).toEqual(['snapshot', 'manifest', 'prompt']);
    for (const part of prepared.group) {
      expect(part.version).toBeGreaterThanOrEqual(1);
      expect(part.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(prepared.requiredInputs[0]?.purpose).toBe('requirements');
    expect(prepared.approval.planDigest).toBe(planDigest);
    expect(prepared.execution.started).toBe(false);
    const viewed = successResult(
      await runDistCli(env, ['task', 'inputs', prepared.commandId, '--data-root', root, '--json']),
      'task.inputs',
    ) as {
      commandId: string;
      group: unknown[];
      requiredInputs: unknown[];
      execution: { started: boolean };
    };
    expect(viewed.commandId).toBe(prepared.commandId);
    expect(viewed.group).toEqual(prepared.group);
    expect(viewed.requiredInputs).toEqual(prepared.requiredInputs);
    expect(viewed.execution.started).toBe(false);
    const viewHuman = await runDistCli(env, ['task', 'inputs', prepared.commandId, '--data-root', root]);
    expect(viewHuman.exitCode, viewHuman.stderr).toBe(0);
    expect(viewHuman.stdout).toContain('未启动执行');
    expect(viewHuman.stdout).toContain(prepared.commandId);

    // 失败退出：缺摘要（退出码 2）与秘密字段（退出码 2，不回显）。
    const missingDigest = await runDistCli(env, [
      'feature', 'approve', featureId,
      '--project', projectId,
      '--revision', '1',
      '--data-root', root,
      '--json',
    ]);
    failureOf(missingDigest, 2, 'invalid_input');
    const secretPath = join(env.sandboxRoot, 'secret.json');
    writeFileSync(
      secretPath,
      JSON.stringify({ runtime: 'pi', provider: 'anthropic', model: 'm', token: 'sk-secret-value' }),
      'utf8',
    );
    const secret = await runDistCli(env, [
      'task', 'strategy', 't-2',
      '--project', projectId,
      '--revision', '2',
      '--input', secretPath,
      '--data-root', root,
      '--json',
    ]);
    failureOf(secret, 2, 'invalid_input');
    expect(secret.stdout).not.toContain('sk-secret-value');
    expect(secret.stderr).not.toContain('sk-secret-value');

    // 未知回执 → not_found；摘要不匹配 → conflict。
    const unknownView = await runDistCli(env, ['task', 'inputs', randomUUID(), '--data-root', root, '--json']);
    failureOf(unknownView, 1, 'not_found');
    const mismatch = await runDistCli(env, [
      'feature', 'approve', featureId,
      '--project', projectId,
      '--digest', 'c'.repeat(64),
      '--revision', '1',
      '--data-root', root,
      '--json',
    ]);
    const mismatchError = failureOf(mismatch, 1, 'conflict');
    expect(mismatchError?.details?.reason).toBe('plan_digest_mismatch');

    await stopHostViaDistCli(env, root, hostPid);
  }, 300_000);

  it('构建后帮助与失败退出（无需 Host）：不宣称执行可用、不泄漏秘密', async () => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f008-built-help-' });
    for (const scope of ['feature.approve', 'feature.reject', 'task.strategy', 'task.prepare', 'task.inputs']) {
      const help = await runDistCli(env, [scope.split('.')[0] as string, scope.split('.')[1] as string, '--help']);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toContain('未启动执行');
      expect(help.stdout).toContain('未知执行能力不显示为可运行');
      expect(help.stdout).not.toMatch(/shiploop (run|work)\b/);
    }
    // 参数失败退出（解析失败在任何 I/O 之前，退出码 2）。
    const missingRevision = await runDistCli(env, [
      'feature', 'approve', randomUUID(),
      '--project', randomUUID(),
      '--digest', 'a'.repeat(64),
      '--json',
    ]);
    failureOf(missingRevision, 2, 'invalid_input');
    expect(missingRevision.stdout).not.toContain('/Users/');
    expect(missingRevision.stdout).not.toContain(env.sandboxRoot);
  }, 120_000);
});
