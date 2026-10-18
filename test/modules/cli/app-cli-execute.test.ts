/**
 * F-015 项目命令 CLI 纵向接线验收（契约 §12.1/§12.2/§12.3、§5.5、§6、§7）。
 *
 * 定位：本套件驱动 F-015 新增的应用命令执行层 `runAppCli`（与 dist/bin.js 同一
 * 路径），经 `ensureHostRunning` 连接/启动真实 P02-1 Host 子进程（干净树用 TS
 * 正式入口），在真实临时数据根与真实 Git 仓库上跑通：
 * - project register/list/get/edit/labels 的 JSON 与人类输出，读取结果与 SQLite
 *   持久对象一致（独立只读探针核对，不只看成功日志）；
 * - 显式相同 commandId 的重复注册/编辑返回原回执（replayed），不同参数复用 ID
 *   得 conflict；符号链接别名不重复建项目；陈旧 revision 与非法仓库的退出码/
 *   错误与 Host 契约一致；
 * - 两个 CLI 调用复用同一 Host；客户端退出后项目仍可查询；源仓库被检视但
 *   tracked/untracked 文件与无脚本约束不被改动；
 * - `--json` stdout 恰好一个信封；解析失败退出码 2 且零 I/O。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { DATABASE_FILE_NAME } from '../../../packages/core/src/ports/path-service.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from '../../helpers/host/index.ts';
import { commitAll, initGitRepo } from '../../helpers/git-repo.ts';
import { openStorageProbe } from '../../helpers/p02-2/storage-probe.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

/** 干净树下以 TS 源码运行正式 Host 入口的 argv 前缀（生产默认是 [dist/start.js]）。 */
function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY];
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
    launch: { entryArgv: tsEntryArgv(), childEnv: env.childEnv(), pollIntervalMs: 50 },
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
  error?: { code: string; details?: Record<string, unknown> };
}

function receiptOf(result: Record<string, unknown>): ReceiptShape {
  return result as unknown as ReceiptShape;
}

/** 有界等待进程退出（ESRCH）；只用于测试自有的 Host 子进程。 */
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

function gitStatus(repo: string, home: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: 'utf8',
  });
}

function listRepoFiles(repo: string): string[] {
  const result: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relative);
      } else {
        result.push(relative);
      }
    }
  };
  walk(repo, '');
  return result.sort();
}

describe('F-015 项目命令 CLI 纵向接线（真实 Host 子进程 + SQLite + Git）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  let repoA: string;
  let repoB: string;
  const usedRoots: string[] = [];

  function useRoot(): string {
    usedRoots.push(dataRoot);
    return dataRoot;
  }

  function probe() {
    return openStorageProbe(join(dataRoot, DATABASE_FILE_NAME));
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f015-' });
    dataRoot = env.dataRoot('app').canonicalRoot;
    const home = env.childEnv().HOME as string;
    repoA = join(env.sandboxRoot, 'repo-a');
    repoB = join(env.sandboxRoot, 'repo-b');
    initGitRepo(repoA);
    writeFileSync(join(repoA, 'README.md'), '# Repo A\n', 'utf8');
    writeFileSync(join(repoA, 'src.ts'), 'export const a = 1;\n', 'utf8');
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

  it('project register：JSON 信封 completed，结果与 SQLite 持久项目/事件一致', async () => {
    const root = useRoot();
    const inv = await runApp(env, [
      'project',
      'register',
      repoA,
      '--name',
      'Repo A 显示名',
      '--description',
      '说明文本',
      '--label',
      'alpha',
      '--label',
      'beta',
      '--data-root',
      root,
      '--json',
    ]);
    const receipt = receiptOf(successResult(inv, 'project.register'));
    expect(receipt.status).toBe('completed');
    expect(receipt.operation).toBe('project.register');
    expect(receipt.replayed).toBe(false);
    expect(typeof receipt.resultRef).toBe('string');
    const business = receipt.result as { status: string; project: Record<string, unknown>; binding: Record<string, unknown> };
    expect(business.status).toBe('registered');
    const projectId = business.project.id as string;

    const probeHandle = probe();
    try {
      const row = probeHandle.projectRow(projectId);
      expect(row).toBeDefined();
      expect(row?.display_name).toBe('Repo A 显示名');
      expect(row?.description).toBe('说明文本');
      expect(JSON.parse(String(row?.labels))).toEqual(['alpha', 'beta']);
      expect(row?.revision).toBe(1);
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().state_events).toBe(1);
      const events = probeHandle.stateEvents();
      expect(events.map((event) => event.event_type)).toEqual(['project.registered']);
      expect(events[0]?.project_id).toBe(projectId);
    } finally {
      probeHandle.close();
    }
  });

  it('project list/get/labels：分页、标签过滤、绑定与 SQLite 一致；CLI 退出后 Host 仍可查询', async () => {
    const root = useRoot();
    const first = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          repoA,
          '--name',
          'Repo A',
          '--label',
          'shared',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    const second = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          repoB,
          '--name',
          'Repo B',
          '--label',
          'shared',
          '--label',
          'only-b',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    const projectA = (first.result as { project: { id: string } }).project.id;
    const projectB = (second.result as { project: { id: string } }).project.id;

    // CLI 进程（本调用）退出后 Host 仍存活：下一调用直接连接并读到持久对象。
    const listPage1 = successResult(
      await runApp(env, ['project', 'list', '--limit', '1', '--data-root', root, '--json']),
      'project.list',
    );
    const records1 = listPage1.records as { id: string; labels: string[] }[];
    expect(records1).toHaveLength(1);
    expect(listPage1.limit).toBe(1);
    const nextCursor = listPage1.nextCursor as string;
    expect(typeof nextCursor).toBe('string');

    const listPage2 = successResult(
      await runApp(env, [
        'project',
        'list',
        '--limit',
        '1',
        '--cursor',
        nextCursor,
        '--data-root',
        root,
        '--json',
      ]),
      'project.list',
    );
    const records2 = listPage2.records as { id: string }[];
    expect(records2).toHaveLength(1);
    expect([records1[0]?.id, records2[0]?.id].sort()).toEqual([projectA, projectB].sort());
    expect(listPage2.nextCursor).toBeNull();

    const filtered = successResult(
      await runApp(env, [
        'project',
        'list',
        '--label',
        'only-b',
        '--data-root',
        root,
        '--json',
      ]),
      'project.list',
    );
    expect((filtered.records as { id: string }[]).map((record) => record.id)).toEqual([projectB]);

    const detail = successResult(
      await runApp(env, ['project', 'get', projectA, '--data-root', root, '--json']),
      'project.get',
    );
    expect((detail.project as { id: string }).id).toBe(projectA);
    expect((detail.binding as { canonicalPath: string }).canonicalPath).toBe(realpathSync(repoA));

    const labels = successResult(
      await runApp(env, ['project', 'labels', '--data-root', root, '--json']),
      'project.labels',
    );
    const labelRows = labels.labels as { label: string; projectCount: number }[];
    expect(labelRows).toEqual(
      expect.arrayContaining([
        { label: 'shared', projectCount: 2 },
        { label: 'only-b', projectCount: 1 },
      ]),
    );
  });

  it('project edit：CAS 成功写入 revision 与事件；陈旧 revision 返回 conflict 且对象不变', async () => {
    const root = useRoot();
    const registered = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          repoA,
          '--name',
          'Before',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    const projectId = (registered.result as { project: { id: string } }).project.id;

    const edited = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'edit',
          projectId,
          '--revision',
          '1',
          '--name',
          'After',
          '--label',
          'renamed',
          '--data-root',
          root,
          '--json',
        ]),
        'project.edit',
      ),
    );
    const editedProject = edited.result as { project: { id: string; revision: number; displayName: string; labels: string[] } };
    expect(editedProject.project.revision).toBe(2);
    expect(editedProject.project.displayName).toBe('After');

    const probeHandle = probe();
    try {
      const row = probeHandle.projectRow(projectId);
      expect(row?.display_name).toBe('After');
      expect(row?.revision).toBe(2);
      expect(JSON.parse(String(row?.labels))).toEqual(['renamed']);
      expect(probeHandle.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'project.metadata_updated',
      ]);
    } finally {
      probeHandle.close();
    }

    // 陈旧 revision：服务端 rejected 回执（业务写事务前决定），对象与事件不变。
    const stale = await runApp(env, [
      'project',
      'edit',
      projectId,
      '--revision',
      '1',
      '--name',
      'Should Not Apply',
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(stale, 1, 'conflict');

    const probeAfter = probe();
    try {
      const row = probeAfter.projectRow(projectId);
      expect(row?.display_name).toBe('After');
      expect(row?.revision).toBe(2);
      expect(probeAfter.counts().state_events).toBe(2);
    } finally {
      probeAfter.close();
    }
  });

  it('显式相同 commandId 重放原回执；不同参数复用 ID 得 conflict；符号链接别名不重复建项目', async () => {
    const root = useRoot();
    const commandId = randomUUID();
    const baseArgs = [
      'project',
      'register',
      repoA,
      '--name',
      'Idempotent Repo',
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ];
    const first = receiptOf(successResult(await runApp(env, baseArgs), 'project.register'));
    expect(first.replayed).toBe(false);
    const projectId = (first.result as { project: { id: string } }).project.id;

    const replay = receiptOf(successResult(await runApp(env, baseArgs), 'project.register'));
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(first.commandId);
    expect(replay.resultRef).toBe(first.resultRef);

    const differentParams = await runApp(env, [
      'project',
      'register',
      repoA,
      '--name',
      'Different Name',
      '--command-id',
      commandId,
      '--data-root',
      root,
      '--json',
    ]);
    const conflictError = failureOf(differentParams, 1, 'conflict');
    expect(conflictError?.details?.reason).toBe('idempotency_key_reuse');

    // 符号链接别名复用同一规范路径：不新增项目/绑定/事件。
    const alias = join(env.sandboxRoot, 'repo-a-alias');
    symlinkSync(repoA, alias, 'dir');
    const viaAlias = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          alias,
          '--name',
          'Alias Name',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    expect((viaAlias.result as { status: string }).status).toBe('already_exists');
    expect((viaAlias.result as { project: { id: string } }).project.id).toBe(projectId);

    const probeHandle = probe();
    try {
      expect(probeHandle.counts().projects).toBe(1);
      expect(probeHandle.counts().repository_bindings).toBe(1);
      expect(probeHandle.counts().state_events).toBe(1);
    } finally {
      probeHandle.close();
    }
  });

  it('非法仓库与未知项目：退出码/错误与 Host 契约一致，零副作用', async () => {
    const root = useRoot();
    const missing = join(env.sandboxRoot, 'does-not-exist');
    const invalid = await runApp(env, [
      'project',
      'register',
      missing,
      '--name',
      'Missing',
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(invalid, 2, 'invalid_input');

    // 先注册一个项目以创建库，再查询未知项目。
    const registered = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          repoA,
          '--name',
          'Known',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    expect((registered.result as { project: { id: string } }).project.id).toBeDefined();

    const unknownId = randomUUID();
    const unknown = await runApp(env, [
      'project',
      'get',
      unknownId,
      '--data-root',
      root,
      '--json',
    ]);
    failureOf(unknown, 1, 'forbidden');

    const probeHandle = probe();
    try {
      expect(probeHandle.counts().projects).toBe(1);
    } finally {
      probeHandle.close();
    }
  });

  it('解析失败在任何 I/O 之前拒绝（退出码 2，零数据根副作用）', async () => {
    const root = useRoot();
    const bad = await runApp(env, ['project', 'get', 'not-a-uuid', '--data-root', root, '--json']);
    expect(bad.result.exitCode).toBe(2);
    const envelope = parseEnvelope(bad);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('invalid_input');
    expect(envelope.command).toBe('project.get');
    // 解析失败不得启动 Host、不得创建数据根。
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);

    // F-017 起 events 观察已接线；其解析失败（缺 scope）同样在任何 I/O 前拒绝，
    // 不发现 Host、不创建数据根。
    const eventsParse = await runApp(env, ['events', '--data-root', root, '--json']);
    expect(eventsParse.result.exitCode).toBe(2);
    const eventsEnvelope = parseEnvelope(eventsParse);
    expect(eventsEnvelope.error?.code).toBe('invalid_input');
    expect(eventsEnvelope.command).toBe('events.observe');
    expect(existsSync(join(root, 'host', 'discovery.json'))).toBe(false);
  });

  it('人类输出与 JSON 分离；源仓库 tracked/untracked 文件未被改写', async () => {
    const root = useRoot();
    const home = env.childEnv().HOME as string;
    const beforeStatus = gitStatus(repoA, home);
    const beforeFiles = listRepoFiles(repoA);

    const human = await runApp(env, [
      'project',
      'register',
      repoA,
      '--name',
      'Human Mode',
      '--data-root',
      root,
    ]);
    expect(human.result.exitCode, human.stderr).toBe(0);
    expect(human.stdout).not.toBe('');
    expect(human.stdout.trim().split('\n')).toHaveLength(1);
    expect(human.stdout).toContain('project register');
    expect(human.stdout).not.toContain('"ok"');

    const probeHandle = probe();
    try {
      expect(probeHandle.counts().projects).toBe(1);
    } finally {
      probeHandle.close();
    }

    expect(gitStatus(repoA, home)).toBe(beforeStatus);
    expect(listRepoFiles(repoA)).toEqual(beforeFiles);
    expect(existsSync(join(repoA, '.shiploop'))).toBe(false);

    // 停止后进程确实退出，且发现/凭据清理（测试自有两进程语义的收尾证据）。
    const discovery = JSON.parse(
      readFileSync(join(root, 'host', 'discovery.json'), 'utf8'),
    ) as { pid: number };
    usedRoots.length = 0; // 由本用例显式停止并核验。
    const stopped = collectIo();
    const stopResult = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: stopped.io as HostCliIo,
      env: {},
    });
    expect(stopResult.exitCode, stopped.stderr()).toBe(0);
    await waitProcessGone(discovery.pid);
  });
});
