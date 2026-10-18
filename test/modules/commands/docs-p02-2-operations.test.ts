/**
 * F-019 文档核验：`docs/p02-2-operations.md` 的应用命令/查询/事件示例必须与真实
 * dist CLI（`runAppCli`，即 `packages/cli/dist/bin.js` 同一路径）一致，
 * `docs/p02-2-handoff.md` 必须指向真实可复用的 Core 端口、Host 路由、HostClient
 * 方法、迁移版本与事件种类。
 *
 * 定位：F-019 只交付文档（+ 本守护）；为避免文档与实现漂移，本套件在真实临时
 * 仓库/数据根与真实 Host 子进程上，跑通操作说明记录的纵向命令
 * （注册 → 配置 CAS → 重放/查回执 → 快照 → 游标恢复），并用独立只读探针核对
 * 持久状态。同时用纯解析面/常量交叉核对文档记录的命令、参数、退出码、事件与
 * 安全边界。不新增业务实现、不扩大 P02-2 交付范围、不依赖预存 dist。
 *
 * 运行前提：macOS（flock）；beforeAll 显式编译原生锁适配器。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OPERATIONS_DOC_PATH = 'docs/p02-2-operations.md';
const HANDOFF_DOC_PATH = 'docs/p02-2-handoff.md';
const README_PATH = 'README.md';
const F018_EVIDENCE_PATH = 'docs/acceptance/evidence-p02-2/f018-regression-evidence.md';

const operationsDoc = readFileSync(resolve(REPO_ROOT, OPERATIONS_DOC_PATH), 'utf-8');
const handoffDoc = readFileSync(resolve(REPO_ROOT, HANDOFF_DOC_PATH), 'utf-8');
const readmeDoc = readFileSync(resolve(REPO_ROOT, README_PATH), 'utf-8');

const REGISTER_HOOKS = fileURLToPath(
  new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url),
);
/** 带可信能力目录的 TS 测试 Host 入口（配置策略需此夹具；生产入口目录为空）。 */
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('../../helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: REPO_ROOT, timeout: 60_000 });
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
): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args,
    io: collected.io,
    env: env.childEnv(),
    launch: {
      entryArgv: catalogEntryArgv(),
      childEnv: env.childEnv(),
      pollIntervalMs: 50,
    },
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

const GLOBAL_PAYLOAD = {
  schemaVersion: 2,
  policies: { executionLimits: { maxConcurrentWorks: 1, workTimeoutMs: 600_000 } },
} as const;

describe('F-019 P02-2 操作说明与接口交接文档', () => {
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

  beforeEach(() => {
    env = createIsolatedHostEnvironment({ prefix: 'shiploop-f019-docs-' });
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

  it('操作说明记录的纵向命令在真实临时仓库/数据根可复跑（注册/CAS/重放/查回执/快照/游标恢复）', async () => {
    const root = useRoot();

    // 1) 注册：完成回执 + 持久项目/事件。
    const registered = receiptOf(
      successResult(
        await runApp(env, [
          'project',
          'register',
          repoA,
          '--name',
          'Docs Repo',
          '--label',
          'demo',
          '--data-root',
          root,
          '--json',
        ]),
        'project.register',
      ),
    );
    expect(registered.status).toBe('completed');
    expect(registered.replayed).toBe(false);
    const projectId = (registered.result as { project: { id: string } }).project.id;

    // 2) 显式 commandId 创建全局配置（insert-only）。
    const createCommandId = randomUUID();
    const globalFile = join(env.sandboxRoot, 'global.json');
    writeFileSync(globalFile, JSON.stringify(GLOBAL_PAYLOAD), 'utf8');
    const createArgs = [
      'config',
      'create',
      '--scope',
      'global',
      '--input',
      globalFile,
      '--command-id',
      createCommandId,
      '--data-root',
      root,
      '--json',
    ];
    const created = receiptOf(successResult(await runApp(env, createArgs), 'config.create'));
    expect(created.status).toBe('completed');
    expect((created.result as { revision: number }).revision).toBe(1);

    // 3) 同一信封重放：命中持久回执，零副作用。
    const replay = receiptOf(successResult(await runApp(env, createArgs), 'config.create'));
    expect(replay.replayed).toBe(true);
    expect(replay.resultRef).toBe(created.resultRef);

    // 4) CAS 更新：revision 提升；同 commandId 不同参数 conflict。
    const updateFile = join(env.sandboxRoot, 'global-update.json');
    writeFileSync(
      updateFile,
      JSON.stringify({ schemaVersion: 2, policies: { executionLimits: { maxConcurrentWorks: 3 } } }),
      'utf8',
    );
    const updateCommandId = randomUUID();
    const updateArgs = [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '1',
      '--input',
      updateFile,
      '--command-id',
      updateCommandId,
      '--data-root',
      root,
      '--json',
    ];
    const updated = receiptOf(successResult(await runApp(env, updateArgs), 'config.update'));
    expect(updated.operation).toBe('settings.global.update');
    expect((updated.result as { revision: number }).revision).toBe(2);

    const conflict = await runApp(env, [
      'config',
      'update',
      '--scope',
      'global',
      '--revision',
      '2',
      '--input',
      updateFile,
      '--command-id',
      updateCommandId,
      '--data-root',
      root,
      '--json',
    ]);
    expect(conflict.result.exitCode, conflict.stderr).toBe(1);
    expect(parseEnvelope(conflict).error?.code).toBe('conflict');
    expect(parseEnvelope(conflict).error?.details?.reason).toBe('idempotency_key_reuse');

    // 5) 超时/响应丢失后查回执：按 commandId 取回原 completed 回执与 resultRef。
    const fetched = receiptOf(
      successResult(
        await runApp(env, ['receipt', 'get', createCommandId, '--data-root', root, '--json']),
        'receipt.get',
      ),
    );
    expect(fetched.status).toBe('completed');
    expect(fetched.commandId).toBe(createCommandId);
    expect(fetched.resultRef).toBe(created.resultRef);

    // 6) 授权快照：先取水位，再显式游标补读建连前写入的事件。
    const snapshotInvocation = await runApp(env, [
      'events',
      '--project',
      projectId,
      '--snapshot-only',
      '--data-root',
      root,
      '--json',
    ]);
    expect(snapshotInvocation.result.exitCode, snapshotInvocation.stderr).toBe(0);
    const snapshotRecords = parseRecords(snapshotInvocation.stdout);
    expect(snapshotRecords.map((record) => record.result?.kind)).toEqual([
      'snapshot',
      'observation_end',
    ]);
    const cursor = (snapshotRecords[0]?.result?.snapshot as { watermark: { cursor: string } })
      .watermark.cursor;
    expect(cursor).toMatch(/^evcur_v1_/);

    const edit = await runApp(env, [
      'project',
      'edit',
      projectId,
      '--revision',
      '1',
      '--name',
      'Docs Repo Renamed',
      '--data-root',
      root,
      '--json',
    ]);
    expect(edit.result.exitCode, edit.stderr).toBe(0);

    const resumed = await runApp(env, [
      'events',
      '--project',
      projectId,
      '--cursor',
      cursor,
      '--snapshot-only',
      '--data-root',
      root,
      '--json',
    ]);
    expect(resumed.result.exitCode, resumed.stderr).toBe(0);
    const resumedRecords = parseRecords(resumed.stdout);
    expect(resumedRecords.map((record) => record.result?.kind)).toEqual([
      'snapshot',
      'event',
      'snapshot',
      'observation_end',
    ]);
    const observed = resumedRecords[1]?.result?.event as {
      type: string;
      sequence: number;
      aggregate: { id: string; revision: number };
    };

    // 7) 与持久状态一致：配置 revision、回执行、事件逐条对应。
    const probeHandle = probe();
    try {
      expect(probeHandle.settingsRow('global')?.revision).toBe(2);
      expect(probeHandle.projectRow(projectId)?.display_name).toBe('Docs Repo Renamed');
      expect(probeHandle.stateEvents().map((event) => event.event_type)).toEqual([
        'project.registered',
        'settings.global_created',
        'settings.global_updated',
        'project.metadata_updated',
      ]);
      expect(observed.type).toBe('project.metadata_updated');
      expect(observed.aggregate).toEqual({ type: 'project', id: projectId, revision: 2 });
      expect(observed.sequence).toBe(probeHandle.maxSequence());
    } finally {
      probeHandle.close();
    }

    // 8) 停止 Host 仍只有显式命令（观察退出不停止 Host）。
    const stop = await runHostCli({
      args: ['host', 'stop', '--data-root', root, '--json'],
      io: collectIo().io as HostCliIo,
      env: {},
    });
    expect(stop.exitCode, 'host stop 应取得三证据并退出 0').toBe(0);
  });

  it('操作说明记录的命令、参数、退出码、事件与安全边界与真实实现一致', () => {
    // 命令面与真实实现逐项对应。
    for (const command of [
      'project register',
      'project list',
      'project get',
      'project edit',
      'project labels',
      'config create',
      'config update',
      'config get',
      'config effective',
      'config export',
      'receipt get',
      'events',
    ]) {
      expect(operationsDoc).toContain(command);
    }
    // 只声明已实现能力，不编造基线/Run/模型参数。
    expect(operationsDoc).not.toMatch(/shiploop\s+(run|feature|baseline)\b/);
    expect(operationsDoc).not.toContain('--model');

    // 使用真实构建入口（dist/bin.js）。
    expect(operationsDoc).toContain('packages/cli/dist/bin.js');
    expect(operationsDoc).toContain('node packages/cli/dist/bin.js');

    // 参数名与真实解析面一致。
    for (const token of [
      '--data-root',
      '--json',
      '--command-id',
      '--revision',
      '--scope',
      '--project',
      '--input',
      '--cursor',
      '--snapshot-only',
      '--follow',
      '--label',
      '--match',
      '--limit',
    ]) {
      expect(operationsDoc).toContain(token);
    }
    // 分页默认值/上限（P01 常量）与文档一致。
    expect(operationsDoc).toContain('`50`');
    expect(operationsDoc).toContain('`1..200`');

    // 五档退出码与关键诊断码。
    for (const token of [
      '退出码 0',
      '退出码 1',
      '退出码 2',
      '退出码 3',
      '退出码 4',
      'conflict',
      'unsupported',
      'snapshot_required',
      'observation_interrupted',
      'stream_overflow',
      'forbidden',
      'not_found',
      'corrupt_state',
      'completed',
      'accepted',
    ]) {
      expect(operationsDoc).toContain(token);
    }

    // P02-2 事件类型白名单全部记录。
    for (const eventType of [
      'project.registered',
      'project.metadata_updated',
      'settings.global_created',
      'settings.project_created',
      'settings.global_updated',
      'settings.project_updated',
    ]) {
      expect(operationsDoc).toContain(eventType);
    }

    // 安全边界与未实现能力。
    for (const token of [
      'macOS',
      '可信本机',
      '同用户',
      '不防',
      '强 OS 沙箱',
      'project init',
      'Skills',
      'accept:p02',
      'not_run',
    ]) {
      expect(operationsDoc).toContain(token);
    }

    // 文档引用真实存在的测试与证据文件。
    expect(operationsDoc).toContain('test/modules/cli/app-cli-execute.test.ts');
    expect(operationsDoc).toContain('test/modules/cli/app-cli-config-execute.test.ts');
    expect(operationsDoc).toContain('test/modules/commands/docs-p02-2-operations.test.ts');
    expect(() => readFileSync(resolve(REPO_ROOT, F018_EVIDENCE_PATH), 'utf-8')).not.toThrow();

    // 运行产物不含开发机绝对路径或真实凭据/64hex。
    expect(operationsDoc).not.toContain('/Users/ganlu');
    expect(operationsDoc).not.toMatch(/[0-9a-f]{64}/);
    expect(operationsDoc).not.toMatch(/Bearer\s+[0-9a-fA-F]{16,}/);
  });

  it('交接文档指向真实 Core 端口/路由/HostClient/迁移/事件，README 记录交付入口', () => {
    for (const surface of [
      'shiploop-core/assembly',
      'openCoreApplication',
      'TrustedPrincipal',
      'commandService.submit',
      'commandReceiptsService',
      'queryService',
      'AtomicCommandStore',
      'CommandTransaction',
      'ConsistentSnapshotStore',
      'StateEventReadStore',
      'shiploop-core/protocol',
      'shiploop-host',
      'connectToHost',
      'ensureHostRunning',
      'HostClient',
    ]) {
      expect(handoffDoc).toContain(surface);
    }

    for (const route of [
      'POST /v1/commands',
      'GET /v1/receipts/:commandId',
      'GET /v1/results/:resultRef',
      'GET /v1/snapshot',
      'GET /v1/events',
    ]) {
      expect(handoffDoc).toContain(route);
    }

    // 迁移版本与事件种类。
    expect(handoffDoc).toContain('command_receipts');
    expect(handoffDoc).toMatch(/v3/);
    for (const eventType of [
      'project.registered',
      'project.metadata_updated',
      'settings.global_created',
      'settings.project_created',
      'settings.global_updated',
      'settings.project_updated',
    ]) {
      expect(handoffDoc).toContain(eventType);
    }

    // 待实现能力与阶段边界如实交接。
    for (const boundary of [
      'project init',
      'Scheduler',
      'Runner',
      'Pi SDK',
      'accept:p02',
      'not_run',
      'macOS',
      '强 OS 沙箱',
    ]) {
      expect(handoffDoc).toContain(boundary);
    }

    // README 记录 P02-2 交付入口与本文档。
    expect(readmeDoc).toContain('docs/p02-2-operations.md');
    expect(readmeDoc).toContain('docs/p02-2-handoff.md');

    // 交接文档与 README 不含开发机路径或真实凭据样例。
    expect(handoffDoc).not.toContain('/Users/ganlu');
    expect(handoffDoc).not.toMatch(/[0-9a-f]{64}/);
  });
});
