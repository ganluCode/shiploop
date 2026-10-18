/**
 * F-017 CLI 事件观察纵向验收（契约 §8/§9/§12.1/§12.2/§12.3）——真实 Host 子进程 +
 * 真实 SQLite/Git 仓库，驱动应用命令执行层 `runAppCli`（dist/bin.js 同一路径）：
 *
 * - snapshot-only：先取授权快照与水位，再从水位之后补读一页后退出（exit 0）；
 *   JSON 观察模式为 NDJSON 记录流（snapshot/event/observation_end），不混入普通日志；
 * - 显式 `--cursor` 恢复：建连前写入的事件按序补读，eventId 与持久 state_events
 *   行一致；观察到事件后重取快照，投影与 Core 当前状态一致；
 * - follow（默认）：实时事件投递；Abort（Ctrl+C 语义）只结束本次观察——退出码 4、
 *   终态记录 error.code='observation_interrupted' 含最后游标；Host 未停止、已提交
 *   命令未取消，独立客户端仍可查询同一 Host；
 * - 未知/不可见项目 forbidden（exit 1）；非法游标与跨 scope 游标 invalid_input（exit 2）。
 *
 * 说明：真实 Host 生产装配的可续读下界恒 0（§9.4，无注入缝），「游标过期
 * snapshot_required」在真实 Host 上不可达；CLI 侧 snapshot_required/stream_overflow/
 * 断线续读分支由 test/modules/cli/app-cli-events-scripted.test.ts 经真实 HTTP 可编排对端覆盖
 * （与 F-013 客户端分支测试同一夹具形态）。
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
} from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
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
/** 生产逻辑 TS 测试 Host 入口（事件观察不需要能力目录：配置命令本套件不用）。 */
const DETACHED_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

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

interface ObserveOverrides {
  readonly quietMs?: number;
  readonly drainBudgetMs?: number;
  readonly maxSnapshotReloads?: number;
}

interface RunAppOptions {
  readonly signal?: AbortSignal;
  readonly observe?: ObserveOverrides;
}

async function runApp(
  env: IsolatedHostEnvironment,
  args: readonly string[],
  options: RunAppOptions = {},
): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    env: env.childEnv(),
    launch: {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: env.childEnv(),
      pollIntervalMs: 50,
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.observe !== undefined ? { observe: options.observe } : {}),
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

/** 启动中的观察调用：立即返回 promise 与实时输出读取器（follow/中断测试用）。 */
function startApp(
  env: IsolatedHostEnvironment,
  args: readonly string[],
  options: RunAppOptions = {},
): { promise: Promise<AppInvocation>; stdout: () => string; stderr: () => string } {
  const collected = collectIo();
  const promise = runAppCli({
    args,
    io: collected.io,
    env: env.childEnv(),
    launch: {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: env.childEnv(),
      pollIntervalMs: 50,
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.observe !== undefined ? { observe: options.observe } : {}),
  }).then((result) => ({ result, stdout: collected.stdout(), stderr: collected.stderr() }));
  return { promise, stdout: collected.stdout, stderr: collected.stderr };
}

/** NDJSON 观察记录（每行一个 {ok,command,result|error} 信封）。 */
interface ObserveRecord {
  ok: boolean;
  command: string | null;
  result?: { kind?: string } & Record<string, unknown>;
  error?: { code: string; message: string; commandId?: string; details?: Record<string, unknown> };
}

function parseRecords(stdout: string): ObserveRecord[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as ObserveRecord);
}

function recordKinds(records: ObserveRecord[]): string[] {
  return records.map((record) =>
    record.ok ? String(record.result?.kind) : `error:${String(record.error?.code)}`,
  );
}

async function waitForCondition(check: () => boolean, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`条件在 ${budgetMs}ms 预算内未满足`);
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

describe('F-017 CLI 事件观察（真实 Host 子进程 + SQLite + Git）', () => {
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

  async function registerProject(): Promise<string> {
    const root = useRoot();
    const invocation = await runApp(env, [
      'project',
      'register',
      repoA,
      '--name',
      'Observe Repo',
      '--data-root',
      root,
      '--json',
    ]);
    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    const envelope = JSON.parse(invocation.stdout) as {
      result: { result: { project: { id: string } } };
    };
    return envelope.result.result.project.id;
  }

  /** snapshot-only 取快照并返回水位游标（供显式恢复）。 */
  async function snapshotCursor(projectId: string): Promise<string> {
    const root = useRoot();
    const invocation = await runApp(env, [
      'events',
      '--project',
      projectId,
      '--snapshot-only',
      '--data-root',
      root,
      '--json',
    ]);
    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    const records = parseRecords(invocation.stdout);
    const snapshot = records[0]?.result?.snapshot as { watermark: { cursor: string } };
    return snapshot.watermark.cursor;
  }

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f017-' });
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

  it('snapshot-only：授权快照 + 水位记录后退出（exit 0），NDJSON 可解析且无事件积压', async () => {
    const root = useRoot();
    const projectId = await registerProject();

    const invocation = await runApp(
      env,
      ['events', '--project', projectId, '--snapshot-only', '--data-root', root, '--json'],
      { observe: { quietMs: 200 } },
    );
    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual(['snapshot', 'observation_end']);

    const snapshot = records[0]?.result?.snapshot as {
      scope: unknown;
      watermark: { sequence: number; cursor: string };
      project: { id: string; revision: number };
      readAt: string;
    };
    expect(snapshot.scope).toEqual({ kind: 'project', projectId });
    expect(snapshot.project.id).toBe(projectId);
    expect(snapshot.project.revision).toBe(1);
    expect(snapshot.watermark.sequence).toBe(1);
    expect(snapshot.watermark.cursor).toMatch(/^evcur_v1_[A-Za-z0-9_-]+$/);
    expect(typeof snapshot.readAt).toBe('string');

    const end = records[1]?.result as Record<string, unknown>;
    expect(end.reason).toBe('snapshot_only');
    expect(end.eventsObserved).toBe(0);

    // 与持久状态一致：恰一条注册事件，sequence=1（水位覆盖）。
    const probeHandle = probe();
    try {
      const events = probeHandle.stateEvents();
      expect(events.map((event) => event.event_type)).toEqual(['project.registered']);
      expect(events[0]?.sequence).toBe(1);
      expect(probeHandle.projectRow(projectId)?.revision).toBe(1);
    } finally {
      probeHandle.close();
    }
    // stderr 不含认证材料；stdout 每行都是可解析 JSON（NDJSON 纪律）。
    expect(invocation.stderr).not.toMatch(/[0-9a-f]{64}/);
  });

  it('显式游标恢复：建连前写入的事件按序补读，eventId/revision 与持久数据一致，观察后重取快照', async () => {
    const root = useRoot();
    const projectId = await registerProject();
    const cursor = await snapshotCursor(projectId);

    // 建连前写入：元数据编辑（revision 1 → 2，事件 sequence 2）。
    const edit = await runApp(env, [
      'project',
      'edit',
      projectId,
      '--revision',
      '1',
      '--name',
      'Observed Rename',
      '--data-root',
      root,
      '--json',
    ]);
    expect(edit.result.exitCode, edit.stderr).toBe(0);

    const invocation = await runApp(
      env,
      ['events', '--project', projectId, '--cursor', cursor, '--snapshot-only', '--data-root', root, '--json'],
      { observe: { quietMs: 200 } },
    );
    expect(invocation.result.exitCode, invocation.stderr).toBe(0);
    const records = parseRecords(invocation.stdout);
    expect(recordKinds(records)).toEqual(['snapshot', 'event', 'snapshot', 'observation_end']);

    // 初始快照在补读前取得（已含编辑后状态，水位 sequence=2）。
    const initialSnapshot = records[0]?.result?.snapshot as {
      watermark: { sequence: number };
      project: { revision: number };
    };
    expect(initialSnapshot.watermark.sequence).toBe(2);
    expect(initialSnapshot.project.revision).toBe(2);

    // 事件记录与持久 state_events 行一一对应（不是提示文本）。
    const eventRecord = records[1]?.result?.event as {
      eventId: string;
      sequence: number;
      type: string;
      scope: unknown;
      aggregate: { type: string; id: string; revision: number };
      payload: { changedFields: string[] };
    };
    const probeHandle = probe();
    try {
      const events = probeHandle.stateEvents();
      expect(events.map((event) => event.event_type)).toEqual([
        'project.registered',
        'project.metadata_updated',
      ]);
      const persisted = events[1];
      expect(eventRecord.eventId).toBe(persisted?.id);
      expect(eventRecord.sequence).toBe(persisted?.sequence);
      expect(eventRecord.type).toBe('project.metadata_updated');
      expect(eventRecord.scope).toEqual({ kind: 'project', projectId });
      expect(eventRecord.aggregate).toEqual({ type: 'project', id: projectId, revision: 2 });
      expect(eventRecord.payload.changedFields).toEqual(['displayName']);
      // 重取的最终快照投影与 Core 当前持久状态一致。
      const finalSnapshot = records[2]?.result?.snapshot as {
        project: { revision: number; displayName: string };
        watermark: { sequence: number };
      };
      expect(finalSnapshot.project.revision).toBe(probeHandle.projectRow(projectId)?.revision);
      expect(finalSnapshot.project.displayName).toBe('Observed Rename');
      expect(finalSnapshot.watermark.sequence).toBe(events.length);
    } finally {
      probeHandle.close();
    }
    expect((records[3]?.result as Record<string, unknown>).eventsObserved).toBe(1);
  });

  it('follow：实时投递；Abort（Ctrl+C 语义）只结束本次观察（exit 4），Host 与已提交命令不受影响', async () => {
    const root = useRoot();
    const projectId = await registerProject();
    const cursor = await snapshotCursor(projectId);

    const controller = new AbortController();
    const follow = startApp(
      env,
      ['events', '--project', projectId, '--cursor', cursor, '--data-root', root, '--json'],
      { signal: controller.signal },
    );

    // 观察期间由独立 CLI 调用提交编辑（游标保证即使在建连前提交也会补读投递）。
    const edit = await runApp(env, [
      'project',
      'edit',
      projectId,
      '--revision',
      '1',
      '--name',
      'Followed Rename',
      '--data-root',
      root,
      '--json',
    ]);
    expect(edit.result.exitCode, edit.stderr).toBe(0);

    await waitForCondition(() => follow.stdout().includes('project.metadata_updated'));
    controller.abort();
    const invocation = await follow.promise;

    expect(invocation.result.exitCode, invocation.stderr).toBe(4);
    const records = parseRecords(invocation.stdout);
    const eventRecords = records.filter((record) => record.result?.kind === 'event');
    expect(eventRecords).toHaveLength(1);
    const observed = eventRecords[0]?.result?.event as { eventId: string; sequence: number };
    expect(observed.sequence).toBe(2);

    // 终态记录：observation_interrupted + 最后游标/最后事件 ID；不显示为 completed。
    const terminal = records.at(-1);
    expect(terminal?.ok).toBe(false);
    expect(terminal?.error?.code).toBe('observation_interrupted');
    expect(terminal?.error?.details?.cursor).toBe(cursor);
    expect(terminal?.error?.details?.lastEventId).toBe(observed.eventId);
    expect(invocation.stderr).toContain('observation_interrupted');

    // Host 未停止、命令未取消：独立客户端仍可查询同一 Host 与已提交命令结果。
    const get = await runApp(env, ['project', 'get', projectId, '--data-root', root, '--json']);
    expect(get.result.exitCode, get.stderr).toBe(0);
    const probeHandle = probe();
    try {
      expect(probeHandle.projectRow(projectId)?.revision).toBe(2);
      expect(probeHandle.counts().state_events).toBe(2);
    } finally {
      probeHandle.close();
    }
  });

  it('未知项目 forbidden（exit 1）；非法游标与跨 scope 游标 invalid_input（exit 2）', async () => {
    const root = useRoot();
    const projectId = await registerProject();

    // 未知/不可见项目：快照授权统一 forbidden（不区分不存在，避免 projectId 探测）。
    const forbidden = await runApp(env, [
      'events',
      '--project',
      randomUUID(),
      '--snapshot-only',
      '--data-root',
      root,
      '--json',
    ]);
    expect(forbidden.result.exitCode, forbidden.stderr).toBe(1);
    const forbiddenRecords = parseRecords(forbidden.stdout);
    expect(forbiddenRecords).toHaveLength(1);
    expect(forbiddenRecords[0]?.error?.code).toBe('forbidden');

    // 非法游标形态：客户端本地拒绝（exit 2），不产生 /v1/events 请求。
    const invalid = await runApp(env, [
      'events',
      '--project',
      projectId,
      '--cursor',
      'bogus-cursor',
      '--data-root',
      root,
      '--json',
    ]);
    expect(invalid.result.exitCode, invalid.stderr).toBe(2);
    expect(parseRecords(invalid.stdout)[0]?.error?.code).toBe('invalid_input');

    // 跨 scope 游标：全局水位游标用于项目流，服务端按 §9.3 判非法（400 invalid_input）。
    const globalSnapshot = await runApp(
      env,
      ['events', '--global', '--snapshot-only', '--data-root', root, '--json'],
      { observe: { quietMs: 200 } },
    );
    expect(globalSnapshot.result.exitCode, globalSnapshot.stderr).toBe(0);
    const globalCursor = (
      parseRecords(globalSnapshot.stdout)[0]?.result?.snapshot as {
        watermark: { cursor: string };
      }
    ).watermark.cursor;
    const mismatch = await runApp(env, [
      'events',
      '--project',
      projectId,
      '--cursor',
      globalCursor,
      '--snapshot-only',
      '--data-root',
      root,
      '--json',
    ]);
    expect(mismatch.result.exitCode, mismatch.stderr).toBe(2);
    expect(parseRecords(mismatch.stdout).at(-1)?.error?.code).toBe('invalid_input');
  });

  it('人类模式：快照行为人类行，stdout 无 JSON 信封；观察命令解析失败仍零 I/O（exit 2）', async () => {
    const root = useRoot();
    const projectId = await registerProject();

    const human = await runApp(
      env,
      ['events', '--project', projectId, '--snapshot-only', '--data-root', root],
      { observe: { quietMs: 200 } },
    );
    expect(human.result.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain('shiploop events: snapshot');
    expect(human.stdout).toContain('watermark=1');
    expect(human.stdout).not.toContain('"ok"');

    // 解析失败（缺 scope）在任何 Host 发现/连接之前拒绝；新数据根零副作用。
    const freshRoot = join(env.sandboxRoot, 'fresh-root');
    const parseFailure = await runApp(env, ['events', '--data-root', freshRoot, '--json']);
    expect(parseFailure.result.exitCode).toBe(2);
    expect(existsSync(join(freshRoot, 'host', 'discovery.json'))).toBe(false);
  });
});
