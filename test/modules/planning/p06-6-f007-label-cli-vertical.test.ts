/**
 * P06-6 / F-007：四层标签查询 CLI 纵向（真实 Host 子进程 + HostClient + SQLite）。
 *
 * 验收面（经 `runAppCli`，与 dist/bin.js 同一执行路径）：
 * - `phase list --label ... --match any|all` 经真实 Host 返回过滤结果（JSON 与
 *   人类可读两种输出）；
 * - `execution runs` 空项目返回空页（scope=run-list、默认 limit、nextCursor=null）；
 * - `project labels` 兼容旧无参形态（项目层计数）与新 `--entity` 四层计数形态；
 * - 非法 `--match` 在连接 Host 之前以退出码 2 结构化拒绝；
 * - CLI 只经 Host 公共客户端发请求：不打开状态库、不读取凭据、不运行模型。
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

describe('F-007 四层标签查询 CLI 纵向（真实 Host + SQLite）', () => {
  let env: IsolatedHostEnvironment;
  let dataRoot: string;
  let repoA: string;
  const usedRoots: string[] = [];

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f007-' });
    dataRoot = env.dataRoot('app').canonicalRoot;
    usedRoots.push(dataRoot);
    const home = env.childEnv().HOME as string;
    repoA = join(env.sandboxRoot, 'repo-a');
    initGitRepo(repoA);
    writeFileSync(join(repoA, 'README.md'), '# Repo A\n', 'utf8');
    commitAll(repoA, 'init A', { home });
  });

  afterEach(async () => {
    for (const root of usedRoots.splice(0)) {
      await stopHostBestEffort(root);
    }
    await env.dispose();
  });

  async function runApp(args: readonly string[]): Promise<{ result: AppCliRunResult; stdout: () => string; stderr: () => string }> {
    const collected = collectIo();
    const result = await runAppCli({
      args,
      io: collected.io,
      env: {},
      launch: { entryArgv: tsEntryArgv(), childEnv: env.childEnv(), pollIntervalMs: 50 },
    });
    return { result, stdout: collected.stdout, stderr: collected.stderr };
  }

  function envelopeOf(stdoutText: string): { ok: boolean; result?: Record<string, unknown>; error?: { code: string } } {
    expect(stdoutText.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
    return JSON.parse(stdoutText) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
  }

  async function seedProject(): Promise<string> {
    const invocation = await runApp([
      'project', 'register', repoA, '--name', 'F-007 纵向', '--data-root', dataRoot, '--json',
    ]);
    expect(invocation.result.exitCode, invocation.stderr()).toBe(0);
    const envelope = envelopeOf(invocation.stdout());
    const receipt = envelope.result as { status?: string; result?: { project?: { id?: string } } };
    expect(receipt.status).toBe('completed');
    const projectId = receipt.result?.project?.id;
    expect(typeof projectId).toBe('string');
    return projectId as string;
  }

  it('phase create 带标签 → phase list 标签筛选（JSON/人类输出）→ 计数 → execution runs 空页', async () => {
    const projectId = await seedProject();

    // Phase 建立带标签（JSON 回执内嵌标签）。
    const created = await runApp([
      'phase', 'create', '--project', projectId, '--title', '阶段一',
      '--label', 'alpha', '--label', 'beta', '--data-root', dataRoot, '--json',
    ]);
    expect(created.result.exitCode, created.stderr()).toBe(0);
    const createdReceipt = envelopeOf(created.stdout()).result as {
      status?: string; result?: { phase?: { id?: string } };
    };
    expect(createdReceipt.status).toBe('completed');
    const phaseId = createdReceipt.result?.phase?.id;
    expect(typeof phaseId).toBe('string');

    // JSON：any/all 筛选与不命中。
    const anyList = await runApp([
      'phase', 'list', '--project', projectId, '--label', 'beta', '--match', 'any',
      '--data-root', dataRoot, '--json',
    ]);
    expect(anyList.result.exitCode, anyList.stderr()).toBe(0);
    const anyResult = envelopeOf(anyList.stdout()).result as { scope: string; records: { id: string }[]; nextCursor: string | null; limit: number };
    expect(anyResult.scope).toBe('phase-list');
    expect(anyResult.records.map((record) => record.id)).toEqual([phaseId]);
    expect(anyResult.nextCursor).toBeNull();

    const allList = await runApp([
      'phase', 'list', '--project', projectId, '--label', 'beta', '--label', 'alpha', '--match', 'all',
      '--data-root', dataRoot, '--json',
    ]);
    expect((envelopeOf(allList.stdout()).result as { records: { id: string }[] }).records.map((r) => r.id))
      .toEqual([phaseId]);

    const missList = await runApp([
      'phase', 'list', '--project', projectId, '--label', 'missing',
      '--data-root', dataRoot, '--json',
    ]);
    expect((envelopeOf(missList.stdout()).result as { records: unknown[] }).records).toEqual([]);

    // 人类可读输出：包含命令名词与 Phase ID。
    const human = await runApp([
      'phase', 'list', '--project', projectId, '--label', 'alpha', '--data-root', dataRoot,
    ]);
    expect(human.result.exitCode, human.stderr()).toBe(0);
    expect(human.stdout()).toContain('phase list');
    expect(human.stdout()).toContain(phaseId as string);

    // 四层计数：project labels --entity phase。
    const counts = await runApp([
      'project', 'labels', '--entity', 'phase', '--project', projectId,
      '--data-root', dataRoot, '--json',
    ]);
    expect(counts.result.exitCode, counts.stderr()).toBe(0);
    const countsResult = envelopeOf(counts.stdout()).result as { entity: string; labels: { label: string; count: number }[] };
    expect(countsResult.entity).toBe('phase');
    expect(countsResult.labels).toEqual([
      { label: 'alpha', count: 1 },
      { label: 'beta', count: 1 },
    ]);

    // 兼容：无参 project labels（项目层计数）继续工作。
    const legacy = await runApp(['project', 'labels', '--data-root', dataRoot, '--json']);
    expect(legacy.result.exitCode, legacy.stderr()).toBe(0);
    expect(envelopeOf(legacy.stdout()).result).toEqual({ labels: [] });

    // Run 层列表：空项目空页（新集合根）。
    const runs = await runApp([
      'execution', 'runs', '--project', projectId, '--data-root', dataRoot, '--json',
    ]);
    expect(runs.result.exitCode, runs.stderr()).toBe(0);
    const runsResult = envelopeOf(runs.stdout()).result as { scope: string; records: unknown[]; nextCursor: string | null; limit: number };
    expect(runsResult).toEqual({ schemaVersion: 5, scope: 'run-list', records: [], nextCursor: null, limit: 50 });
    const runsHuman = await runApp([
      'execution', 'runs', '--project', projectId, '--data-root', dataRoot,
    ]);
    expect(runsHuman.stdout()).toContain('run');

    // 非法 --match：连接前退出码 2 结构化拒绝。
    const invalid = await runApp([
      'phase', 'list', '--project', projectId, '--match', 'mix',
      '--data-root', dataRoot, '--json',
    ]);
    expect(invalid.result.exitCode).toBe(2);
    expect(envelopeOf(invalid.stdout()).error?.code).toBe('invalid_input');
  });
});

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
