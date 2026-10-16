/**
 * P03-4 / F-009 调度诊断 CLI 正式构建入口验收（`npm run build` 产物
 * `packages/cli/dist/bin.js`，与生产同一入口 + 真实临时 Host + 真实执行数据）。
 *
 * 验收面（.dag_context.json F-009 第 4 条）：
 * - 从正式构建 CLI 入口以临时 Host 验证正常查询（schedule/attempts/diagnostics）
 *   与关键错误（非法 ID → 退出码 2；不存在实体 → not_found 退出码 1）；
 * - 重复查询不认领、不扣额、不启动 Runtime（持久表逐字节一致）；
 * - 帮助信息说明本 Feature（P03-4）尚无完整执行/验证闭环。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME（沙箱 HOME/数据根）。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost } from '../packages/host/src/index.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../packages/core/src/adapters/sqlite/execution-store.ts';
import type { AttemptRecord } from '../packages/core/src/ports/attempt-store.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

let fixture: ClaimFixture | undefined;
let host: RunningHost | undefined;
let attempt: AttemptRecord | undefined;
let tablesBefore: Record<string, unknown[]> | undefined;

/** 干净树下先构建真实 dist（CLI bin + Host dist/start.js 启动入口）。 */
beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);

  fixture = await openClaimFixture([[], ['t-1']]);
  const box = fixture.box;
  attempt = fixture.store().claimTask(fixture.input()).receipt.attempt;
  const resourceIdentity = {
    projectId: attempt.projectId,
    attemptId: attempt.id,
    owner: attempt.owner,
    hostInstanceId: attempt.hostInstanceId,
    executionVersion: attempt.executionVersion,
  };
  box.session.transactWrite('launch', () => {
    createSqliteExecutionAccess(box.session, { nowUtcMs: () => NOW }).reserveRuntimeStartInTransaction({
      projectId: attempt!.projectId,
      batchId: fixture!.ids.batchId,
      runId: attempt!.runId,
      startKey: attempt!.id,
    });
    const resources = createSqliteWorkResourceAccess(box.session, {
      workspaceAuthority: fixture!.authority,
      nowUtcMs: () => NOW,
    });
    resources.beginLaunchInTransaction(resourceIdentity);
    resources.confirmLaunchInTransaction(resourceIdentity, {
      launchId: '10000000-0000-4000-8000-0000000000fa',
      pid: 130,
      processGroupId: 130,
      startTime: 'start-f009-built',
    });
  });
  const lifecycle = createSqliteAttemptLifecycleStore(box.session, {
    workspaceAuthority: fixture.authority,
    nowUtcMs: () => NOW + 1,
  });
  const identity = { ...resourceIdentity, runId: attempt.runId, taskId: attempt.taskId };
  expect(lifecycle.apply({ ...identity, notificationId: 'started', kind: 'executing' }))
    .toMatchObject({ disposition: 'applied' });
  expect(lifecycle.apply({
    ...identity,
    owner: 'stale-owner',
    notificationId: 'late-0',
    kind: 'runtime_completed',
    exitCode: 0,
    evidenceRef: attempt.inputRef,
  })).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });

  tablesBefore = fixture.snapshot();
  host = await startHost({
    dataRoot: box.box.dataRoot,
    capabilityCatalog: box.box.capabilityCatalog,
    env: {},
  });
}, 570_000);

afterAll(async () => {
  const running = host;
  host = undefined;
  if (running !== undefined) {
    // The fixture registers a synthetic PID but launches no actual process.
    // Retire only its test-owned leases; preserve the production stop gate.
    if (fixture !== undefined && attempt !== undefined) {
      fixture.box.session.transactWrite('fixture.retireSyntheticOccupancy', () => {
        fixture!.box.session.database.prepare('DELETE FROM workspace_leases WHERE project_id = ? AND owner_id = ?')
          .run(attempt!.projectId, attempt!.id);
      });
    }
    await running.close();
  }
  const box = fixture;
  fixture = undefined;
  if (box !== undefined) {
    box.box.close();
  }
});

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；不继承开发机 SHIPLOOP_* 覆盖）。
 * 必须异步 spawn：测试进程内的 Host HTTP 服务依赖本进程事件循环，spawnSync
 * 阻塞事件循环会让子进程请求超时（owner_unknown/unreachable 假象）。
 */
function runBuiltCli(args: readonly string[]): Promise<CliOutcome> {
  const box = fixture;
  if (box === undefined) {
    throw new Error('fixture 未就绪');
  }
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: box.box.box.homeDir,
    TMPDIR: box.box.box.root,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', box.box.box.dataRoot],
      { cwd: box.box.box.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectSpawn(failure);
        return;
      }
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

describe('F-009 诊断 CLI 正式构建入口（dist/bin.js + 临时 Host）', () => {
  it('正常查询：schedule/attempts/diagnostics 经构建入口返回结构化结果', async () => {
    const box = fixture;
    if (box === undefined || attempt === undefined) {
      throw new Error('fixture 未就绪');
    }
    const schedule = okResult(
      await runBuiltCli(['execution', 'schedule', box.ids.runId, '--project', box.box.projectId, '--json']),
      'execution.schedule',
    );
    expect(schedule.operation).toBe('execution.run.schedule');
    expect(schedule.run).toMatchObject({ id: box.ids.runId, status: 'queued' });
    expect(schedule.readiness).toMatchObject({
      state: 'blocked',
      resourceBusyTaskIds: ['t-1'],
      allPassedPendingFinalVerification: false,
    });
    expect(schedule.completion).toMatchObject({ featureVerified: false, delivered: false });

    const attempts = okResult(
      await runBuiltCli(['execution', 'attempts', 't-1', '--project', box.box.projectId, '--json']),
      'execution.attempts',
    );
    const records = attempts.records as readonly { record: Record<string, unknown> }[];
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      id: attempt.id,
      runId: box.ids.runId,
      status: 'executing',
      executionStage: 'runtime',
    });

    const diagnostics = okResult(
      await runBuiltCli(['execution', 'diagnostics', attempt.id, '--project', box.box.projectId, '--json']),
      'execution.diagnostics',
    );
    expect(diagnostics.records).toHaveLength(1);
    expect((diagnostics.records as readonly Record<string, unknown>[])[0]).toMatchObject({
      attemptId: attempt.id,
      reason: 'stale_execution_identity',
    });
  });

  it('关键错误：非法 ID 退出码 2；不存在实体 not_found 退出码 1', async () => {
    const box = fixture;
    if (box === undefined) {
      throw new Error('fixture 未就绪');
    }
    const badId = await runBuiltCli([
      'execution', 'schedule', 'not-a-uuid', '--project', box.box.projectId, '--json',
    ]);
    expect(badId.status).toBe(2);
    const badIdEnvelope = JSON.parse(badId.stdout) as EnvelopeShape;
    expect(badIdEnvelope.error?.code).toBe('invalid_input');
    expect(badIdEnvelope.error?.details?.reason).toBe('invalid_run_id');

    const missing = await runBuiltCli([
      'execution', 'schedule', randomUUID(), '--project', box.box.projectId, '--json',
    ]);
    expect(missing.status).toBe(1);
    const missingEnvelope = JSON.parse(missing.stdout) as EnvelopeShape;
    expect(missingEnvelope.error?.code).toBe('not_found');
  });

  it('重复查询零副作用（持久表逐字节一致），帮助声明无完整执行/验证闭环', async () => {
    const box = fixture;
    if (box === undefined || attempt === undefined || tablesBefore === undefined) {
      throw new Error('fixture 未就绪');
    }
    for (let round = 0; round < 2; round += 1) {
      okResult(
        await runBuiltCli(['execution', 'schedule', box.ids.runId, '--project', box.box.projectId, '--json']),
        'execution.schedule',
      );
      okResult(
        await runBuiltCli(['execution', 'attempts', 't-1', '--project', box.box.projectId, '--json']),
        'execution.attempts',
      );
    }
    expect(box.snapshot()).toEqual(tablesBefore);

    // 帮助（无 --data-root）：列出诊断子命令并声明本 Feature 尚无完整执行/验证闭环。
    const help = spawnSync(process.execPath, [CLI_BIN, 'execution', '--help'], {
      cwd: box.box.box.root,
      env: { PATH: process.env.PATH ?? '', HOME: box.box.box.homeDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('execution schedule <runId>');
    expect(help.stdout).toContain('execution attempts <taskId>');
    expect(help.stdout).toContain('execution diagnostics <attemptId>');
    expect(help.stdout).toContain('尚无完整执行/验证闭环');
  });
});
