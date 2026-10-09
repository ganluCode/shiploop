/**
 * F-016 配置与回执 CLI 纵向接线验收（契约 §12.1/§12.2/§12.3、§5.5、§6、§7）。
 *
 * 定位：驱动应用命令执行层 `runAppCli`（dist/bin.js 同一路径），经
 * `ensureHostRunning` 连接/启动真实 Host 子进程；本套件使用带可信能力目录的
 * 测试入口夹具（pi/anthropic/openai），在真实临时数据根、真实 Git 仓库与
 * 真实 SQLite 上跑通：
 * - config create/update/get/effective/export 的 JSON 与人类输出，值/revision/
 *   来源与 SQLite 持久行一致；
 * - 显式 commandId 重放原回执、不同参数同 ID conflict、陈旧 revision conflict；
 * - 无配置 not_found、未知 runtime 能力拒绝、提权/任意路径字段拒绝；
 * - receipt get 查询 completed/rejected 回执与 not_found；
 * - 项目覆盖不改变全局当前值；导出不含明文凭据。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../packages/cli/src/host/execute.ts';
import { connectToHost } from '../packages/host/src/index.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';
import { commitAll, initGitRepo } from './helpers/git-repo.ts';
import { openStorageProbe } from './helpers/p02-2/storage-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 带能力目录的 TS 测试 Host 入口（生产入口目录为空，配置策略需此夹具）。 */
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

const SYNTHETIC_SECRET = 'sk-synthetic-f016-do-not-leak';
const GLOBAL_CREDENTIAL_REF = 'keychain://shiploop/global-default';

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function catalogEntryArgv(): string[] {
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
  options: {
    platform?: string;
    userHomeDir?: string;
    cliEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    env: options.cliEnv,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.userHomeDir !== undefined ? { userHomeDir: options.userHomeDir } : {}),
    launch: { entryArgv: catalogEntryArgv(), childEnv: env.childEnv(), pollIntervalMs: 50 },
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
}

function parseEnvelope(invocation: AppInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function successResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.result.exitCode, invocation.stderr).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(
  invocation: AppInvocation,
  exitCode: number,
  code: string,
): EnvelopeShape['error'] {
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
  error?: { code: string; details?: Record<string, unknown> };
}

function receiptOf(result: Record<string, unknown>): ReceiptShape {
  return result as unknown as ReceiptShape;
}

async function waitProcessGone(pid: number, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`进程 ${pid} 在 ${budgetMs}ms 预算内未被回收核验`);
    }
    await delay(50);
  }
}

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

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: GLOBAL_CREDENTIAL_REF,
    },
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 },
    verification: { requireChecksBeforeDone: true },
  },
} as const;

const PROJECT_PAYLOAD = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-project-default',
      endpointRef: 'endpoint://shiploop/project-endpoint',
    },
  },
  policies: { executionLimits: { maxConcurrentWorks: 2 } },
} as const;

describe('F-016 配置与回执 CLI 纵向接线（真实 Host 子进程 + SQLite + Git）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  let repoA: string;
  const usedRoots: string[] = [];

  function useRoot(): string {
    usedRoots.push(dataRoot);
    return dataRoot;
  }

  function probe() {
    return openStorageProbe(join(dataRoot, DATABASE_FILE_NAME));
  }

  /** 写一个显式输入 JSON 文件（只作为本次命令输入；沙箱内）。 */
  function writeInput(name: string, value: unknown): string {
    const file = join(env.sandboxRoot, name);
    writeFileSync(file, JSON.stringify(value), 'utf8');
    return file;
  }

  /** 注册一个项目并返回其 id（多个配置用例都要一个可见项目）。 */
  async function registerProject(): Promise<string> {
    const root = useRoot();
    const receipt = receiptOf(
      successResult(
        await runApp(env, ['project', 'register', repoA, '--name', 'Cfg Repo', '--data-root', root, '--json']),
        'project.register',
      ),
    );
    return (receipt.result as { project: { id: string } }).project.id;
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f016-' });
    dataRoot = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    repoA = join(env.sandboxRoot, 'repo-a');
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

  it('config create/get/effective/export：值、revision 与来源对应 SQLite 持久状态', async () => {
    const root = useRoot();
    const projectId = await registerProject();

    // create global
    const globalCreate = receiptOf(
      successResult(
        await runApp(env, [
          'config',
          'create',
          '--scope',
          'global',
          '--input',
          writeInput('global.json', GLOBAL_PAYLOAD),
          '--data-root',
          root,
          '--json',
        ]),
        'config.create',
      ),
    );
    expect(globalCreate.status).toBe('completed');
    expect(globalCreate.operation).toBe('settings.global.create');
    const globalState = globalCreate.result as { scope: { kind: string }; revision: number; payload: unknown };
    expect(globalState.scope).toEqual({ kind: 'global' });
    expect(globalState.revision).toBe(1);
    expect(globalState.payload).toEqual(GLOBAL_PAYLOAD);

    const probeAfterGlobal = probe();
    try {
      const row = probeAfterGlobal.settingsRow('global');
      expect(row?.revision).toBe(1);
      expect(JSON.parse(String(row?.payload))).toEqual(GLOBAL_PAYLOAD);
      expect(probeAfterGlobal.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
      ]);
    } finally {
      probeAfterGlobal.close();
    }

    // create project（覆盖不改变全局）
    const projectCreate = receiptOf(
      successResult(
        await runApp(env, [
          'config',
          'create',
          '--scope',
          'project',
          '--project',
          projectId,
          '--input',
          writeInput('project.json', PROJECT_PAYLOAD),
          '--data-root',
          root,
          '--json',
        ]),
        'config.create',
      ),
    );
    expect(projectCreate.operation).toBe('settings.project.create');
    expect((projectCreate.result as { revision: number }).revision).toBe(1);

    // get global / project
    const globalGet = successResult(
      await runApp(env, ['config', 'get', '--scope', 'global', '--data-root', root, '--json']),
      'config.get',
    );
    expect((globalGet as { revision: number }).revision).toBe(1);
    expect((globalGet as { payload: unknown }).payload).toEqual(GLOBAL_PAYLOAD);
    const projectGet = successResult(
      await runApp(env, [
        'config',
        'get',
        '--scope',
        'project',
        '--project',
        projectId,
        '--data-root',
        root,
        '--json',
      ]),
      'config.get',
    );
    expect((projectGet as { payload: unknown }).payload).toEqual(PROJECT_PAYLOAD);

    // effective：项目覆盖 defaultStrategy，modelMap.low 继承全局
    const effective = successResult(
      await runApp(env, ['config', 'effective', '--project', projectId, '--data-root', root, '--json']),
      'config.effective',
    );
    expect(effective.configured).toBe(true);
    const strategies = effective.strategies as {
      defaultStrategy?: { source: { kind: string } };
      modelMap?: { low?: { source: { kind: string } } };
    };
    expect(strategies.defaultStrategy?.source.kind).toBe('project_default');
    expect(strategies.modelMap?.low?.source.kind).toBe('global_default');

    // export：脱敏投影含引用字符串，不含明文秘密；不声称执行就绪
    const exported = successResult(
      await runApp(env, ['config', 'export', '--scope', 'global', '--data-root', root, '--json']),
      'config.export',
    );
    expect(exported.exportFormatVersion).toBe(1);
    expect(exported.scope).toBe('global');
    const current = exported.current as { revision: number; strategies?: unknown };
    expect(current.revision).toBe(1);
    expect(JSON.stringify(exported)).toContain(GLOBAL_CREDENTIAL_REF);
    expect(JSON.stringify(exported)).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(exported)).not.toMatch(/"(executable|ready)"/);

    // 全局当前值未被项目覆盖改写
    const probeFinal = probe();
    try {
      const globalRow = probeFinal.settingsRow('global');
      const projectRow = probeFinal.settingsRow('project', projectId);
      expect(JSON.parse(String(globalRow?.payload))).toEqual(GLOBAL_PAYLOAD);
      expect(JSON.parse(String(projectRow?.payload))).toEqual(PROJECT_PAYLOAD);
    } finally {
      probeFinal.close();
    }
  });

  it('config update CAS：成功提升 revision；陈旧 revision conflict；重复命令重放/不同参数 conflict', async () => {
    const root = useRoot();
    await registerProject();
    const create = receiptOf(
      successResult(
        await runApp(env, [
          'config',
          'create',
          '--scope',
          'global',
          '--input',
          writeInput('g1.json', GLOBAL_PAYLOAD),
          '--data-root',
          root,
          '--json',
        ]),
        'config.create',
      ),
    );
    expect(create.status).toBe('completed');

    const updatedPayload = {
      schemaVersion: 2,
      policies: { executionLimits: { maxConcurrentWorks: 3, workTimeoutMs: 700_000 } },
    };
    const commandId = randomUUID();
    const updateArgs = [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '1',
      '--input',
      writeInput('g2.json', updatedPayload),
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ];
    const first = receiptOf(successResult(await runApp(env, updateArgs), 'config.update'));
    expect(first.replayed).toBe(false);
    expect(first.operation).toBe('settings.global.update');
    expect((first.result as { revision: number }).revision).toBe(2);

    // 相同 commandId + 相同参数 → 重放原回执
    const replay = receiptOf(successResult(await runApp(env, updateArgs), 'config.update'));
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(first.commandId);
    expect(replay.resultRef).toBe(first.resultRef);

    // 相同 commandId + 不同参数 → conflict（idempotency_key_reuse），不再修改对象
    const different = await runApp(env, [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '2',
      '--input',
      writeInput('g3.json', {
        schemaVersion: 2,
        policies: { executionLimits: { maxConcurrentWorks: 9 } },
      }),
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ]);
    const conflict = failureOf(different, 1, 'conflict');
    expect(conflict?.details?.reason).toBe('idempotency_key_reuse');

    // 陈旧 revision → conflict，且对象与事件不变
    const stale = await runApp(env, [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '1',
      '--input',
      writeInput('g4.json', updatedPayload),
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(stale, 1, 'conflict');

    const probeFinal = probe();
    try {
      const row = probeFinal.settingsRow('global');
      expect(row?.revision).toBe(2);
      expect(JSON.parse(String(row?.payload))).toEqual(updatedPayload);
      // create + update 两条事件 + 注册一条
      expect(probeFinal.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
        'settings.global_updated',
      ]);
    } finally {
      probeFinal.close();
    }
  });

  it('无配置 not_found、未知 runtime/提权字段/明文秘密拒绝，零副作用', async () => {
    const root = useRoot();
    const projectId = await registerProject();

    // 尚未创建全局配置 → not_found（exit 1）
    failureOf(
      await runApp(env, ['config', 'get', '--scope', 'global', '--data-root', root, '--json']),
      1,
      'not_found',
    );
    // 项目存在但无覆盖 → not_found；未知项目同样不泄漏存在性（not_found）
    failureOf(
      await runApp(env, [
        'config',
        'get',
        '--scope',
        'project',
        '--project',
        projectId,
        '--data-root',
        root,
        '--json',
      ]),
      1,
      'not_found',
    );
    failureOf(
      await runApp(env, [
        'config',
        'get',
        '--scope',
        'project',
        '--project',
        randomUUID(),
        '--data-root',
        root,
        '--json',
      ]),
      1,
      'not_found',
    );

    // 未知 runtime：能力目录未装配 → invalid_input（exit 2），零写入
    failureOf(
      await runApp(env, [
        'config',
        'create',
        '--scope',
        'global',
        '--input',
        writeInput('bad-runtime.json', {
          schemaVersion: 2,
          strategies: { defaultStrategy: { runtime: 'unknown-runtime', provider: 'x', model: 'y' } },
        }),
        '--data-root',
        root,
        '--json',
      ]),
      2,
      'invalid_input',
    );

    // 明文秘密字段（未知键）→ invalid_input
    failureOf(
      await runApp(env, [
        'config',
        'create',
        '--scope',
        'global',
        '--input',
        writeInput('secret.json', { schemaVersion: 2, apiKey: SYNTHETIC_SECRET }),
        '--data-root',
        root,
        '--json',
      ]),
      2,
      'invalid_input',
    );

    // 提权/任意路径字段不能进入信封 payload（顶层未知键）→ invalid_input
    failureOf(
      await runApp(env, [
        'config',
        'create',
        '--scope',
        'global',
        '--input',
        writeInput('escalation.json', {
          schemaVersion: 2,
          actorId: 'root',
          dataRoot: '/etc',
          databasePath: '/tmp/other.db',
        }),
        '--data-root',
        root,
        '--json',
      ]),
      2,
      'invalid_input',
    );

    const probeFinal = probe();
    try {
      expect(probeFinal.counts().global_settings).toBe(0);
      expect(probeFinal.counts().project_settings).toBe(0);
    } finally {
      probeFinal.close();
    }
  });

  it('缺失/畸形输入文件在任何 Host 连接前以退出码 2 拒绝', async () => {
    const root = useRoot();
    const missing = await runApp(env, [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      join(env.sandboxRoot, 'missing.json'),
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(missing, 2, 'invalid_input');
    // 没有启动 Host / 未创建数据根发现文件。
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);

    const malformedFile = join(env.sandboxRoot, 'malformed.json');
    writeFileSync(malformedFile, '{not json', 'utf8');
    const malformed = await runApp(env, [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      malformedFile,
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(malformed, 2, 'invalid_input');
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);
  });

  it('receipt get：completed 与 rejected 回执可按 commandId 查询，未知 not_found', async () => {
    const root = useRoot();
    await registerProject();

    const createCommandId = randomUUID();
    const created = receiptOf(
      successResult(
        await runApp(env, [
          'config',
          'create',
          '--scope',
          'global',
          '--input',
          writeInput('r1.json', GLOBAL_PAYLOAD),
          '--command-id',
          createCommandId,
          '--data-root',
          root,
          '--json',
        ]),
        'config.create',
      ),
    );
    expect(created.status).toBe('completed');

    // 独立调用按同一 commandId 查回执（超时/响应丢失后查最终结果，不重发副作用）。
    const fetched = receiptOf(
      successResult(
        await runApp(env, ['receipt', 'get', createCommandId, '--data-root', root, '--json']),
        'receipt.get',
      ),
    );
    expect(fetched.status).toBe('completed');
    expect(fetched.commandId).toBe(createCommandId);
    expect(fetched.resultRef).toBe(created.resultRef);
    expect(fetched.operation).toBe('settings.global.create');

    // rejected 回执可查询：陈旧 revision update 固化 rejected。
    const rejectedCommandId = randomUUID();
    const rejectedSubmit = await runApp(env, [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '99',
      '--input',
      writeInput('r2.json', PROJECT_PAYLOAD),
      '--command-id',
      rejectedCommandId,
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(rejectedSubmit, 1, 'conflict');

    const rejectedReceipt = await runApp(env, [
      'receipt',
      'get',
      rejectedCommandId,
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(rejectedReceipt, 1, 'conflict');

    // 未知 commandId → not_found
    failureOf(
      await runApp(env, ['receipt', 'get', randomUUID(), '--data-root', root, '--json']),
      1,
      'not_found',
    );
  });

  it('人类输出与 JSON 分离；配置命令不写源仓库文件', async () => {
    const root = useRoot();
    await registerProject();

    const human = await runApp(env, [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      writeInput('human.json', GLOBAL_PAYLOAD),
      '--data-root',
      root,
    ]);
    expect(human.result.exitCode, human.stderr).toBe(0);
    expect(human.stdout).not.toContain('"ok"');
    expect(human.stdout).toContain('config create');

    const getHuman = await runApp(env, [
      'config',
      'get',
      '--scope',
      'global',
      '--data-root',
      root,
    ]);
    expect(getHuman.result.exitCode, getHuman.stderr).toBe(0);
    expect(getHuman.stdout).toContain('config get');
    expect(getHuman.stdout).not.toContain('"ok"');

    const exportHuman = await runApp(env, [
      'config',
      'export',
      '--scope',
      'global',
      '--data-root',
      root,
    ]);
    expect(exportHuman.result.exitCode, exportHuman.stderr).toBe(0);
    expect(exportHuman.stdout).toContain('config export');

    // 新命令写项目配置（显式 commandId），再以人类模式查回执。
    const commandId = randomUUID();
    const projectCreate = receiptOf(
      successResult(
        await runApp(env, [
          'config',
          'create',
          '--scope',
          'project',
          '--project',
          (
            receiptOf(
              successResult(
                await runApp(env, ['project', 'register', repoA, '--name', 'Human Repo', '--data-root', root, '--json']),
                'project.register',
              ),
            ).result as { project: { id: string } }
          ).project.id,
          '--input',
          writeInput('human-p.json', PROJECT_PAYLOAD),
          '--command-id',
          commandId,
          '--data-root',
          root,
          '--json',
        ]),
        'config.create',
      ),
    );
    expect(projectCreate.status).toBe('completed');

    const receiptHuman = await runApp(env, [
      'receipt',
      'get',
      commandId,
      '--data-root',
      root,
    ]);
    expect(receiptHuman.result.exitCode, receiptHuman.stderr).toBe(0);
    expect(receiptHuman.stdout).toContain('receipt get');
    expect(receiptHuman.stdout).not.toContain('"ok"');
  });

  it('解析失败前不发现 Host（含 events 观察参数面，F-017 起已接线）', async () => {
    const root = useRoot();
    const parseFailure = await runApp(env, [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '0',
      '--input',
      writeInput('p.json', GLOBAL_PAYLOAD),
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(parseFailure, 2, 'invalid_input');
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);

    // F-017 起 events 观察已接线；其解析失败（缺 scope）同样零 I/O 拒绝。
    const events = await runApp(env, ['events', '--json', '--data-root', root]);
    expect(events.result.exitCode).toBe(2);
    expect(parseEnvelope(events).error?.code).toBe('invalid_input');
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);
  });
});
