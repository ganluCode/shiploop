/**
 * P03-4 / F-009 调度诊断与 Attempt 审计 CLI 纵向（真实临时 Host + 真实 SQLite +
 * 真实执行数据；经 `runAppCli`，与 dist/bin.js 同一执行路径；命令只经过 Host）。
 *
 * 验收面（.dag_context.json F-009）：
 * - 沿用既有 CLI 子命令与 HostClient 只读入口：按 Run/Task/Attempt 查询稳定候选、
 *   阻塞原因、执行版本、阶段与占用状态（execution schedule/attempts/diagnostics）；
 * - 结构化输出区分 Runtime 结果待验证（verifying）、审批等待与资源隔离（held
 *   占用 + resource_busy），accepted/无 ready/执行文本成功不显示为交付成功；
 * - 非法 ID/分页参数在连接前以退出码 2 拒绝；跨项目/不存在实体折叠 not_found
 *   （退出码 1，不泄漏存在性）；Host 不可达（启动超时）为退出码 3；CLI 只经
 *   Host 访问，不打开 SQLite、不解析日志；
 * - 重复查询零副作用：不认领、不扣额、不启动 Runtime（持久表逐字节一致）。
 *
 * 正式构建 CLI 入口验收见 `p03-4-cli-schedule-built.test.ts`。
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import { startHost } from '../packages/host/src/index.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';
import type { AttemptRecord } from '../packages/core/src/ports/attempt-store.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);
const STUB_ENTRY = fileURLToPath(new URL('./helpers/host/stub-entry.ts', import.meta.url));

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, CATALOG_HOST_ENTRY];
}

/* ------------------------------------------------------------------ *
 * 夹具：真实执行数据（认领 Attempt + 占用 + 迟到通知诊断）+ 真实 Host
 * ------------------------------------------------------------------ */

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

let activeHost: RunningHost | undefined;
let activeFixture: ClaimFixture | undefined;

afterEach(async () => {
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    await host.close();
  }
  const fixture = activeFixture;
  activeFixture = undefined;
  if (fixture !== undefined) {
    fixture.box.close();
  }
});

/** 认领 t-1 并推进到 executing（占用 held），再注入三条旧 owner 迟到通知（只写诊断）。 */
function seedAttemptWithDiagnostics(fixture: ClaimFixture): AttemptRecord {
  const box = fixture.box;
  const attempt = fixture.store().claimTask(fixture.input()).receipt.attempt;
  const resourceIdentity = {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
  box.session.transactWrite('launch', () => {
    createSqliteExecutionAccess(box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt.projectId,
      batchId: fixture.ids.batchId,
      runId: attempt.runId,
      startKey: attempt.id,
    });
    const resources = createSqliteWorkResourceAccess(box.session, {
      workspaceAuthority: fixture.authority,
      nowUtcMs: () => NOW,
    });
    resources.beginLaunchInTransaction(resourceIdentity);
    resources.confirmLaunchInTransaction(resourceIdentity, {
      launchId: '10000000-0000-4000-8000-0000000000f9',
      pid: 129,
      processGroupId: 129,
      startTime: 'start-f009',
    });
  });
  const lifecycle = createSqliteAttemptLifecycleStore(box.session, {
    workspaceAuthority: fixture.authority,
    nowUtcMs: () => NOW + 1,
  });
  const identity = { ...resourceIdentity, runId: attempt.runId, taskId: attempt.taskId };
  expect(lifecycle.apply({ ...identity, notificationId: 'started', kind: 'executing' }))
    .toMatchObject({ disposition: 'applied' });
  for (let index = 0; index < 3; index += 1) {
    expect(lifecycle.apply({
      ...identity,
      owner: 'stale-owner',
      notificationId: `late-${index}`,
      kind: 'runtime_completed',
      exitCode: 0,
      evidenceRef: attempt.inputRef,
    })).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
  }
  return attempt;
}

interface WiredCli {
  readonly fixture: ClaimFixture;
  readonly host: RunningHost;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly projectIdB: string;
  readonly runId: string;
  readonly attempt: AttemptRecord;
  readonly tablesBefore: Record<string, unknown[]>;
}

async function openWiredCli(): Promise<WiredCli> {
  const fixture = await openClaimFixture([[], ['t-1']]);
  activeFixture = fixture;
  const box = fixture.box;
  const attempt = seedAttemptWithDiagnostics(fixture);

  const registeredB = await box.submit('project.register', {
    repositoryPath: box.box.repoDirB,
    displayName: 'F-009 Repo B',
    description: null,
    labels: [],
  }, { scope: { kind: 'registration' } });
  if (registeredB.status !== 'completed') {
    throw new Error(`夹具项目 B 注册失败：${JSON.stringify(registeredB)}`);
  }
  const projectIdB = (registeredB.result as { project: { id: string } }).project.id;

  const tablesBefore = fixture.snapshot();
  const host = await startHost({
    dataRoot: box.box.dataRoot,
    capabilityCatalog: box.box.capabilityCatalog,
    env: {},
  });
  activeHost = host;
  return {
    fixture,
    host,
    dataRoot: box.box.dataRoot,
    projectId: box.projectId,
    projectIdB,
    runId: fixture.ids.runId,
    attempt,
    tablesBefore,
  };
}

/* ------------------------------------------------------------------ *
 * runAppCli 驱动（与 p03-3 纵向同一纪律：收集 stdout/stderr，无注入 env）
 * ------------------------------------------------------------------ */

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

async function runApp(dataRoot: string, args: readonly string[]): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    io: collected.io,
    env: {},
    launch: { entryArgv: tsEntryArgv(), pollIntervalMs: 50 },
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

function failureOf(
  invocation: AppInvocation,
  exitCode: number,
  code: string,
): NonNullable<EnvelopeShape['error']> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as NonNullable<EnvelopeShape['error']>;
  expect(error?.code).toBe(code);
  return error;
}

/* ------------------------------------------------------------------ *
 * A. 正常查询：Run 调度 / Attempt 归属 / 诊断审计
 * ------------------------------------------------------------------ */

describe('F-009 诊断 CLI 纵向（真实 Host + SQLite）', () => {
  it('execution schedule：稳定候选/阻塞原因/执行版本/阶段/占用原样展示，不显示为交付成功', async () => {
    const s = await openWiredCli();
    const json = await runApp(s.dataRoot, [
      'execution', 'schedule', s.runId, '--project', s.projectId, '--json',
    ]);
    const result = successResult(json, 'execution.schedule');
    expect(result.operation).toBe('execution.run.schedule');
    const run = result.run as Record<string, unknown>;
    expect(run).toMatchObject({
      id: s.runId,
      projectId: s.projectId,
      batchId: s.fixture.ids.batchId,
      status: 'queued',
      startedAt: null,
      endedAt: null,
    });
    // 认领持有占用：如实 blocked/resource_busy，不伪造 ready。
    const readiness = result.readiness as Record<string, unknown>;
    expect(readiness.state).toBe('blocked');
    expect(readiness.readyTaskIds).toEqual([]);
    expect(readiness.allPassedPendingFinalVerification).toBe(false);
    expect(readiness.resourceBusyTaskIds).toEqual(['t-1']);
    expect(readiness.waitingApprovalTaskIds).toEqual([]);
    expect(readiness.heldResourceKeys).not.toEqual([]);
    const completion = result.completion as Record<string, unknown>;
    expect(completion).toMatchObject({ featureVerified: false, delivered: false });
    expect(String(completion.note)).toContain('尚无完整执行/验证闭环');
    const tasks = result.tasks as readonly Record<string, unknown>[];
    expect(tasks.map((task) => task.taskId)).toEqual(['t-1', 't-2']);
    expect(tasks[0]).toMatchObject({ status: 'running', reason: 'resource_busy', executionVersion: 1 });
    expect(tasks[0]?.latestAttempt).toMatchObject({
      id: s.attempt.id,
      status: 'executing',
      executionStage: 'runtime',
    });
    const occupancy = result.occupancy as readonly Record<string, unknown>[];
    expect(occupancy.length).toBeGreaterThan(0);
    expect(occupancy[0]).toMatchObject({ attemptId: s.attempt.id, runId: s.runId, state: 'held' });

    // 人类行：脱敏事实字段 + 不交付边界说明。
    const human = await runApp(s.dataRoot, [
      'execution', 'schedule', s.runId, '--project', s.projectId,
    ]);
    expect(human.result.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain(`shiploop execution schedule: run=${s.runId}`);
    expect(human.stdout).toContain('readiness=blocked');
    expect(human.stdout).toContain('不代表交付成功');
    expect(human.stdout).not.toContain(s.fixture.box.box.homeDir);
  });

  it('execution attempts：Attempt 归属（Run/owner/host/围栏版本）与分页游标链', async () => {
    const s = await openWiredCli();
    const first = await runApp(s.dataRoot, [
      'execution', 'attempts', 't-1', '--project', s.projectId, '--limit', '1', '--json',
    ]);
    const page1 = successResult(first, 'execution.attempts');
    expect(page1.operation).toBe('execution.attempts.list');
    expect(page1.projectId).toBe(s.projectId);
    expect(page1.taskId).toBe('t-1');
    const records1 = page1.records as readonly Record<string, unknown>[];
    expect(records1).toHaveLength(1);
    const record = records1[0]?.record as Record<string, unknown>;
    expect(record).toMatchObject({
      id: s.attempt.id,
      runId: s.runId,
      taskId: 't-1',
      number: 1,
      owner: 'owner-1',
      hostInstanceId: 'host-1',
      executionVersion: 1,
      status: 'executing',
      executionStage: 'runtime',
    });
    const completion = page1.completion as Record<string, unknown>;
    expect(completion).toMatchObject({ featureVerified: false, delivered: false });

    // 游标链：nextCursor 之后为空页（单 Attempt），不产生重复记录。
    const cursor = page1.nextCursor;
    if (cursor !== null) {
      const second = await runApp(s.dataRoot, [
        'execution', 'attempts', 't-1', '--project', s.projectId,
        '--limit', '1', '--cursor', String(cursor), '--json',
      ]);
      const page2 = successResult(second, 'execution.attempts');
      expect(page2.records).toEqual([]);
      expect(page2.nextCursor).toBeNull();
    }

    // 空 Task（无 Attempt）如实为空，不伪造审计行。
    const empty = await runApp(s.dataRoot, [
      'execution', 'attempts', 't-2', '--project', s.projectId, '--json',
    ]);
    const emptyResult = successResult(empty, 'execution.attempts');
    expect(emptyResult.records).toEqual([]);
  });

  it('execution diagnostics：迟到通知诊断（固定原因/摘要/时间）原样展示', async () => {
    const s = await openWiredCli();
    const invocation = await runApp(s.dataRoot, [
      'execution', 'diagnostics', s.attempt.id, '--project', s.projectId, '--json',
    ]);
    const result = successResult(invocation, 'execution.diagnostics');
    expect(result.operation).toBe('execution.attempt.diagnostics');
    const records = result.records as readonly Record<string, unknown>[];
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({
        attemptId: s.attempt.id,
        projectId: s.projectId,
        reason: 'stale_execution_identity',
      });
      expect(String(record.notificationDigest)).toMatch(/^[0-9a-f]{64}$/);
      // 诊断不保留原通知身份/正文/路径。
      expect(Object.keys(record).sort()).toEqual(
        ['attemptId', 'id', 'notificationDigest', 'occurredAt', 'projectId', 'reason'],
      );
    }
  });

  it('重复查询零副作用：不认领、不扣额、不启动 Runtime（持久表逐字节一致）', async () => {
    const s = await openWiredCli();
    for (let round = 0; round < 2; round += 1) {
      const schedule = await runApp(s.dataRoot, [
        'execution', 'schedule', s.runId, '--project', s.projectId, '--json',
      ]);
      successResult(schedule, 'execution.schedule');
      const attempts = await runApp(s.dataRoot, [
        'execution', 'attempts', 't-1', '--project', s.projectId, '--json',
      ]);
      successResult(attempts, 'execution.attempts');
      const diagnostics = await runApp(s.dataRoot, [
        'execution', 'diagnostics', s.attempt.id, '--project', s.projectId, '--json',
      ]);
      successResult(diagnostics, 'execution.diagnostics');
    }
    expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
  });

  /* ---------------------------------------------------------------- *
   * B. 关键错误：输入/分页/归属折叠/连接
   * ---------------------------------------------------------------- */

  it('非法 ID/分页参数在连接前以退出码 2 拒绝（invalid_input，稳定 reason）', async () => {
    const s = await openWiredCli();
    const badRun = await runApp(s.dataRoot, [
      'execution', 'schedule', 'not-a-uuid', '--project', s.projectId, '--json',
    ]);
    const runError = failureOf(badRun, 2, 'invalid_input');
    expect(runError.details?.reason).toBe('invalid_run_id');

    const badAttempt = await runApp(s.dataRoot, [
      'execution', 'diagnostics', 'not-a-uuid', '--project', s.projectId, '--json',
    ]);
    expect(failureOf(badAttempt, 2, 'invalid_input').details?.reason).toBe('invalid_attempt_id');

    const badLimit = await runApp(s.dataRoot, [
      'execution', 'attempts', 't-1', '--project', s.projectId, '--limit', '0', '--json',
    ]);
    expect(failureOf(badLimit, 2, 'invalid_input').details?.reason).toBe('invalid_limit');

    const badCursor = await runApp(s.dataRoot, [
      'execution', 'attempts', 't-1', '--project', s.projectId,
      '--cursor', 'plcur_v1_tampered', '--json',
    ]);
    expect(failureOf(badCursor, 2, 'invalid_input').details?.reason).toBe('invalid_cursor');
  });

  it('不存在/跨项目目标折叠 not_found（退出码 1，不泄漏存在性）', async () => {
    const s = await openWiredCli();
    const missingRun = await runApp(s.dataRoot, [
      'execution', 'schedule', randomUUID(), '--project', s.projectId, '--json',
    ]);
    const missingError = failureOf(missingRun, 1, 'not_found');

    const crossProject = await runApp(s.dataRoot, [
      'execution', 'schedule', s.runId, '--project', s.projectIdB, '--json',
    ]);
    const crossError = failureOf(crossProject, 1, 'not_found');
    // 跨项目与不存在实体的公开错误面逐字段一致（不泄漏存在性/归属）。
    expect(crossError).toEqual(missingError);

    const crossAttempts = await runApp(s.dataRoot, [
      'execution', 'attempts', 't-1', '--project', s.projectIdB, '--json',
    ]);
    failureOf(crossAttempts, 1, 'not_found');

    const missingAttempt = await runApp(s.dataRoot, [
      'execution', 'diagnostics', randomUUID(), '--project', s.projectId, '--json',
    ]);
    failureOf(missingAttempt, 1, 'not_found');
  });

  it('Host 不可达（启动候选驻留不就绪 → start_timeout）为退出码 3', async () => {
    const sandbox = createTempSandbox('shiploop-f009-unreachable-', { outside: [repoRoot] });
    try {
      const dataRoot = join(sandbox.path, 'data-root');
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      const collected = collectIo();
      const result = await runAppCli({
        args: [
          'execution', 'schedule', randomUUID(), '--project', randomUUID(),
          '--data-root', dataRoot, '--start-timeout-ms', '1000', '--json',
        ],
        io: collected.io,
        env: {},
        launch: {
          entryArgv: ['--import', REGISTER_HOOKS, STUB_ENTRY, 'linger'],
          pollIntervalMs: 50,
        },
      });
      expect(result.exitCode, collected.stderr()).toBe(3);
      const envelope = JSON.parse(collected.stdout()) as EnvelopeShape;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('start_timeout');
    } finally {
      sandbox.cleanup();
    }
  }, 30_000);
});
