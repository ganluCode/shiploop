/**
 * P03-9 / F-016：真实 Host 强杀、恢复核对与控制竞争集成。
 *
 * 验收边界（.dag_context.json F-016）：
 * - 真实 Host/SQLite/Git/受控进程；在 Runtime 挂起、Verifier 等待及结果边界
 *   强杀自有 Host，普通测试零模型/零真实凭据；
 * - 重开后先恢复核对再放行：遗留 Attempt 保持 interrupted、安全 Run 不自动
 *   完成、workspace/Git/文件与历史通过记录保留；
 * - 旧子进程仍写文件、持久身份不确定、旧 owner/version 迟到结果、恢复中 Git
 *   外部变更/遗留锁均有实际占用/拒绝断言，不以父进程退出代替停止证据；
 * - Host 命令重复/并发 resume 只创建一个新 Attempt、复用一个 worktree、至多
 *   一次启动；预算与 deadline 不重置，换 Session 不能绕过隔离；
 * - 故障组有界屏障/超时、finally 精确回收受控进程并核验退出。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
  type ManagedChild,
} from '../../helpers/host/index.ts';
import { git } from '../../helpers/git-repo.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

const HOST_CHILD = fileURLToPath(new URL('../../helpers/p03-9/recovery-host-child.ts', import.meta.url));
const QUICK_SCRIPT = {
  schemaVersion: 1,
  steps: [{ op: 'message', role: 'assistant', text: 'F-016 quick' }],
  result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
} as const;
const QUICK_TOOL_COMMANDS = { 'quick-writer': { argv: [process.execPath, '--no-warnings', '-e',
  "require('node:fs').writeFileSync('tool-boundary.txt','tool result before settlement\n')"],
  environment: {}, timeoutMs: 10_000 } } as const;
const QUICK_TOOL_SCRIPT = {
  schemaVersion: 1,
  steps: [{ op: 'tool_command', name: 'quick-writer' }, { op: 'message', role: 'assistant', text: 'F-016 quick tool' }],
  result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
} as const;

interface Entry {
  readonly env: IsolatedHostEnvironment;
  fixture?: BindingFixture;
  readonly children: ManagedChild[];
  readonly clients: HostClient[];
  readonly probes: SqliteStorageSession[];
  readonly workerPids: number[];
}
const entries: Entry[] = [];

afterEach(async () => {
  for (const entry of entries.splice(0)) {
    for (const client of entry.clients.splice(0)) client.close();
    for (const probe of entry.probes.splice(0)) probe.close();
    for (const pid of entry.workerPids.splice(0)) killWorker(pid);
    for (const child of entry.children.splice(0)) {
      if (child.isAlive()) await child.verifyStopped({ stepMs: 500 }).catch(() => undefined);
    }
    // 恢复未确认停止时测试失败路径也必须先精确回收受控工具进程，再删临时根。
    if (entry.fixture) for (const worker of findWorkers(entry.fixture.box.root)) killWorker(worker);
    entry.fixture?.close();
    await entry.env.dispose();
  }
});

function findWorkers(root: string): number[] {
  const found: number[] = [];
  const walk = (path: string, depth: number): void => {
    if (depth > 6) return;
    try {
      for (const name of readdirSync(path)) {
        const full = join(path, name);
        if (name === 'worker.pid') {
          const pid = Number(readFileSync(full, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 1) found.push(pid);
          continue;
        }
        try { if (statSync(full).isDirectory()) walk(full, depth + 1); } catch { /* 已消失 */ }
      }
    } catch { /* 已删除 */ }
  };
  walk(root, 0);
  return found;
}

function killWorker(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 无独立组 */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function runtimeStarts(markerDir: string): Array<Record<string, unknown>> {
  const path = join(markerDir, 'runtime-starts.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function q(probe: SqliteStorageSession, sql: string, ...params: unknown[]): any {
  return probe.database.prepare(sql).get(...params as never[]);
}

function attemptRows(probe: SqliteStorageSession): Array<Record<string, any>> {
  return probe.database.prepare(`SELECT id, task_id, status, execution_stage, owner_id, host_instance_id,
    execution_version, invocation_id, session_id, run_id, diagnostic_ref, revision FROM attempts ORDER BY number`).all() as Array<Record<string, any>>;
}

function workspace(probe: SqliteStorageSession): { id: string; canonical_path: string; status: string; branch: string; base_commit: string } {
  return q(probe, 'SELECT id, canonical_path, status, branch, base_commit FROM managed_workspaces');
}

function budget(probe: SqliteStorageSession): Record<string, any> {
  return q(probe, 'SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches');
}

function recoveryPayloads(probe: SqliteStorageSession): Array<Record<string, any>> {
  return (probe.database.prepare("SELECT payload FROM state_events WHERE event_type = 'work.recovery.updated' ORDER BY sequence")
    .all() as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as Record<string, any>);
}

async function diagnosticOf(fixture: BindingFixture, probe: SqliteStorageSession,
  attemptId: string): Promise<Record<string, any>> {
  const row = q(probe, 'SELECT diagnostic_ref FROM attempts WHERE id = ?', attemptId) as { diagnostic_ref: string };
  const verifier = createArtifactVerifier({ artifacts: createSqliteArtifactStore(probe),
    files: createArtifactFileStore({ dataRoot: fixture.box.dataRoot }), limits: { maxReadBytes: 4_000_000 } });
  const artifact = await verifier.readVerifiedContent(fixture.projectId, row.diagnostic_ref);
  return JSON.parse(Buffer.from(artifact.content).toString()) as Record<string, any>;
}

function setup(): Entry {
  const entry: Entry = {
    env: createIsolatedHostEnvironment({ prefix: 'shiploop-f016-' }),
    children: [], clients: [], probes: [], workerPids: [],
  };
  entries.push(entry);
  return entry;
}

async function prepareFixture(entry: Entry): Promise<{ fixture: BindingFixture; markerDir: string; probe: SqliteStorageSession }> {
  const fixture = await openBindingFixture();
  entry.fixture = fixture;
  const markerDir = join(fixture.box.root, 'f016-markers');
  mkdirSync(markerDir, { recursive: true });
  fixture.session.close();
  const probe = openSqliteStorageSession({ path: fixture.box.dbPath });
  entry.probes.push(probe);
  return { fixture, markerDir, probe };
}

async function spawnHost(env: IsolatedHostEnvironment, config: Record<string, unknown>, label: string): Promise<ManagedChild> {
  const child = env.processes.spawn({
    scriptPath: HOST_CHILD,
    config,
    cwd: env.sandboxRoot,
    env: env.childEnv(),
    label,
    readyTimeoutMs: 30_000,
    requireInside: env.sandboxRoot,
  });
  await child.waitReady(30_000);
  child.releaseGo();
  await child.waitMessage('host_ready', 30_000);
  return child;
}

async function killHost(child: ManagedChild): Promise<void> {
  expect(child.kill('SIGKILL')).toBe(true);
  const exit = await child.exited;
  expect(exit.signal).toBe('SIGKILL');
}

function lifecycle(probe: SqliteStorageSession, root: string) {
  return createSqliteAttemptLifecycleStore(probe, {
    workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [root] }),
    nowUtcMs: () => Date.now(),
  });
}

function lateResult(
  probe: SqliteStorageSession,
  fixture: BindingFixture,
  attempt: Record<string, any>,
): Record<string, any> {
  return lifecycle(probe, fixture.box.root).apply({
    projectId: fixture.projectId, runId: attempt.run_id, taskId: attempt.task_id,
    attemptId: attempt.id, owner: attempt.owner_id, hostInstanceId: attempt.host_instance_id,
    executionVersion: attempt.execution_version, notificationId: `f016-late-${attempt.id}`,
    kind: 'runtime_completed', exitCode: 0, evidenceRef: fixture.requirementArtifactId,
  });
}

describe.skipIf(process.platform !== 'darwin')('P03-9 / F-016 real Host kill recovery', () => {
  it('SIGKILLs a Host with a hung Runtime and keeps the still-writing tool group occupied until recovery proof', async () => {
    const entry = setup();
    const { fixture, markerDir, probe } = await prepareFixture(entry);
    const before = budget(probe);
    const workerScript = [
      "const fs=require('node:fs')",
      "fs.writeFileSync('worker.pid',String(process.pid))",
      "process.on('SIGTERM',()=>{})",
      "fs.appendFileSync('heartbeat.txt','x')",
      "setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),20)",
    ].join(';');
    const config = {
      dataRoot: fixture.box.dataRoot,
      markerDir,
      gates: ['hold'],
      stopGraceMs: 200,
      stopConfirmMs: 1_000,
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'F-016 runtime hung' },
          { op: 'tool_command', name: 'writer' },
          { op: 'await_gate', name: 'hold' },
        ],
      },
      toolCommands: { writer: { argv: [process.execPath, '--no-warnings', '-e', workerScript], environment: {}, timeoutMs: 120_000 } },
    };
    const first = await spawnHost(entry.env, config, 'f016-host-runtime');
    entry.children.push(first);
    // Host ready is not Runtime ready: real supervised Git preparation exceeds
    // 20s under the four-worker Feature union. Keep a bounded admission budget.
    const admissionStarted = Date.now();
    await waitFor(() => runtimeStarts(markerDir).length === 1, '首个 Runtime 启动身份', 40_000).catch(error => {
      throw new Error(`Runtime admission diagnostic: ${JSON.stringify({
        runs: probe.database.prepare('SELECT status, reason FROM runs').all(),
        attempts: attemptRows(probe),
        claims: probe.database.prepare('SELECT state, claim_version FROM run_dispatch_claims').all(),
        leases: probe.database.prepare('SELECT state, resource_key FROM workspace_leases').all(),
        hostAlive: first.isAlive(),
      })}`, { cause: error });
    });
    process.stdout.write(`Runtime admission elapsed ms: ${Date.now() - admissionStarted}\n`);
    await waitFor(() => {
      const managed = q(probe, 'SELECT canonical_path FROM managed_workspaces') as { canonical_path: string } | undefined;
      return managed !== undefined && existsSync(join(managed.canonical_path, 'worker.pid'));
    }, '受控工具进程登记 worker.pid');
    const managed = workspace(probe);
    const workerPid = Number(readFileSync(join(managed.canonical_path, 'worker.pid'), 'utf8'));
    entry.workerPids.push(workerPid);
    const heartbeat = join(managed.canonical_path, 'heartbeat.txt');
    const sizeBeforeKill = statSync(heartbeat).size;
    const afterStart = budget(probe);

    await killHost(first);
    // 父 Host 已死不是停止证据：旧工具继续写文件，占用仍在。
    expect(alive(workerPid)).toBe(true);
    await waitFor(() => statSync(heartbeat).size > sizeBeforeKill, 'Host 死后旧工具继续写文件');
    const runningAttempt = attemptRows(probe)[0]!;
    expect(runningAttempt).toMatchObject({ status: expect.stringMatching(/^(preparing|executing)$/), task_id: 't-1' });
    expect(attemptRows(probe)).toHaveLength(1);

    // 重开真实 Host：先核对旧进程/Git/记录水位，再暴露调度；未确认记录水位不放行 resume。
    const restart = await spawnHost(entry.env, { ...config, script: QUICK_SCRIPT, gates: [] }, 'f016-host-restart');
    entry.children.push(restart);
    await waitFor(() => !alive(workerPid), '恢复核验停止旧受控工具组');
    expect(attemptRows(probe)[0]).toMatchObject({ id: runningAttempt.id, status: 'interrupted' });
    expect(attemptRows(probe)).toHaveLength(1);
    expect(q(probe, 'SELECT status FROM tasks')).toEqual({ status: 'running' });
    expect(q(probe, "SELECT status FROM tasks WHERE status = 'passed'")).toBeUndefined();
    expect(q(probe, 'SELECT status, reason FROM runs')).toMatchObject({ status: 'interrupted', reason: 'restart_recovery' });
    expect(workspace(probe)).toMatchObject({ id: managed.id, status: 'quarantined' });
    expect(probe.database.prepare("SELECT state FROM workspace_leases").all()).toEqual([
      { state: 'quarantined' }, { state: 'quarantined' }, { state: 'quarantined' },
    ]);
    expect(recoveryPayloads(probe).some(payload => payload.stopConfirmed === true)).toBe(true);
    // P04-9 F-007: the restarted Host fences the persisted Run consumer as well as its three resource leases.
    const dispatch = q(probe, 'SELECT id, claim_version, state FROM run_dispatch_claims');
    expect(dispatch).toMatchObject({ claim_version: 1, state: 'quarantined' });
    expect(q(probe, 'SELECT claim_id, claim_version, state FROM execution_slot_claims'))
      .toEqual({ claim_id: dispatch.id, claim_version: dispatch.claim_version, state: 'quarantined' });
    const diagnostic = await diagnosticOf(fixture, probe, runningAttempt.id);
    expect(diagnostic).toMatchObject({ kind: 'work-recovery-reconciliation', status: 'quarantined' });
    expect(diagnostic.gaps).toEqual(expect.arrayContaining(['recording_watermark_missing']));
    // 安全 Run 等待显式恢复，不自动创建 Attempt/结算成功；文件保留。
    expect(existsSync(join(managed.canonical_path, 'heartbeat.txt'))).toBe(true);
    expect(runtimeStarts(markerDir)).toHaveLength(1);
    expect(lateResult(probe, fixture, runningAttempt)).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });

    const client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    entry.clients.push(client);
    const run = q(probe, 'SELECT revision FROM runs') as { revision: number };
    await expect(client.resumeExecution({
      projectId: fixture.projectId, runId: fixture.runId, expectedRevision: run.revision,
    })).rejects.toMatchObject({ code: 'resource_busy' });
    expect(attemptRows(probe)).toHaveLength(1);
    expect(runtimeStarts(markerDir)).toHaveLength(1);
    const settled = budget(probe);
    expect(settled).toEqual(afterStart);
    expect(settled.deadline_at).toBe(before.deadline_at);
    expect(settled.budget_snapshot).toBe(before.budget_snapshot);
  }, 90_000);

  it('refuses to signal a live tool group whose persisted start identity is uncertain after the Host kill', async () => {
    const entry = setup();
    const { fixture, markerDir, probe } = await prepareFixture(entry);
    // 工具命令进程再派生一个脱离受控组的真实子进程：父 Host/监督者退出后它仍写文件，
    // 用于证明“父进程退出”不能代替停止证据；身份不确定时恢复不得猜杀它。
    const workerScript = [
      "const fs=require('node:fs')",
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['--no-warnings','-e',\"const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('worker.pid',String(process.pid));fs.appendFileSync('heartbeat.txt','x');setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),20)\"],{detached:true,stdio:'ignore'})",
      'child.unref()',
      'setInterval(()=>{},1000)',
    ].join(';');
    const config = {
      dataRoot: fixture.box.dataRoot,
      markerDir,
      gates: ['hold'],
      stopGraceMs: 200,
      stopConfirmMs: 500,
      script: {
        schemaVersion: 1,
        steps: [{ op: 'message', role: 'assistant', text: 'F-016 identity boundary' },
          { op: 'tool_command', name: 'writer' }, { op: 'await_gate', name: 'hold' }],
      },
      toolCommands: { writer: { argv: [process.execPath, '--no-warnings', '-e', workerScript], environment: {}, timeoutMs: 120_000 } },
    };
    const first = await spawnHost(entry.env, config, 'f016-host-identity');
    entry.children.push(first);
    await waitFor(() => runtimeStarts(markerDir).length === 1, 'Runtime 启动', 40_000);
    await waitFor(() => {
      const managed = q(probe, 'SELECT canonical_path FROM managed_workspaces') as { canonical_path: string } | undefined;
      return managed !== undefined && existsSync(join(managed.canonical_path, 'worker.pid'));
    }, '受控工具进程登记');
    const managed = workspace(probe);
    const workerPid = Number(readFileSync(join(managed.canonical_path, 'worker.pid'), 'utf8'));
    entry.workerPids.push(workerPid);
    const heartbeat = join(managed.canonical_path, 'heartbeat.txt');

    await killHost(first);
    expect(alive(workerPid)).toBe(true);
    // 清理首个受控工具组后，保留一个真实活动、但持久 startTime 已不可核对的旧执行组。
    killWorker(workerPid);
    await waitFor(() => !alive(workerPid), '首个受控工具组实际停止');
    const launchId = randomUUID();
    const legacy = spawn(process.execPath, ['--no-warnings', '-e', [
      "const fs=require('node:fs')",
      "process.on('SIGTERM',()=>{})",
      "fs.writeFileSync('worker.pid',String(process.pid))",
      "fs.appendFileSync('heartbeat.txt','legacy')",
      "setInterval(()=>fs.appendFileSync('heartbeat.txt','legacy'),20)",
    ].join(';'), launchId], { cwd: managed.canonical_path, env: {}, detached: true, stdio: 'ignore' });
    legacy.unref();
    if (legacy.pid === undefined) throw new Error('legacy 进程启动失败');
    const legacyPid = legacy.pid;
    entry.workerPids.push(legacyPid);
    await waitFor(() => existsSync(join(managed.canonical_path, 'worker.pid'))
      && readFileSync(join(managed.canonical_path, 'worker.pid'), 'utf8') === String(legacyPid), '旧执行组登记');
    // 持久身份与真实进程不再可核对：恢复不得按 pid/pgid 猜测并擅自杀进程。
    const uncertain = { schemaVersion: 2, launchId, pid: legacyPid, processGroupId: legacyPid, startTime: 'unrelated-process-start' };
    probe.database.prepare('UPDATE workspace_leases SET process_identity = ?').run(JSON.stringify(uncertain));

    const restart = await spawnHost(entry.env, { ...config, script: QUICK_SCRIPT, gates: [] }, 'f016-host-uncertain');
    entry.children.push(restart);
    const sizeAtRestart = statSync(heartbeat).size;
    await waitFor(() => statSync(heartbeat).size > sizeAtRestart, '身份不确定时旧工具仍实际占用');
    expect(alive(legacyPid)).toBe(true);
    expect(attemptRows(probe)[0]).toMatchObject({ id: expect.any(String), status: 'interrupted' });
    expect(attemptRows(probe)).toHaveLength(1);
    expect(q(probe, 'SELECT status, reason FROM runs')).toMatchObject({ status: 'interrupted', reason: 'restart_recovery' });
    expect(workspace(probe)).toMatchObject({ id: managed.id, status: 'quarantined' });
    const payloads = recoveryPayloads(probe);
    expect(payloads.some(payload => payload.stopConfirmed === false
      && Array.isArray(payload.gaps) && payload.gaps.includes('stop_unconfirmed'))).toBe(true);
    expect(runtimeStarts(markerDir)).toHaveLength(1);

    const client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    entry.clients.push(client);
    const run = q(probe, 'SELECT revision FROM runs') as { revision: number };
    await expect(client.resumeExecution({
      projectId: fixture.projectId, runId: fixture.runId, expectedRevision: run.revision,
    })).rejects.toMatchObject({ code: 'resource_busy' });
    expect(attemptRows(probe)).toHaveLength(1);
    expect(runtimeStarts(markerDir)).toHaveLength(1);
  }, 90_000);

  it('after a verifier-boundary kill resumes once through the Host command and preserves cumulative budget', async () => {
    const entry = setup();
    const { fixture, markerDir, probe } = await prepareFixture(entry);
    const initial = budget(probe);
    const config = { dataRoot: fixture.box.dataRoot, markerDir, gates: [], script: QUICK_TOOL_SCRIPT,
      toolCommands: QUICK_TOOL_COMMANDS };
    const first = await spawnHost(entry.env, config, 'f016-host-verifier');
    entry.children.push(first);
    await waitFor(() => runtimeStarts(markerDir).length === 1, 'Runtime 启动');
    await waitFor(() => attemptRows(probe)[0]?.status === 'verifying', 'Attempt 进入待验收边界');
    const verified = attemptRows(probe)[0]!;
    const managed = workspace(probe);
    expect(verified).toMatchObject({ status: 'verifying', execution_stage: 'verification' });
    expect(q(probe, 'SELECT recording_watermark FROM sessions WHERE attempt_id = ?', verified.id).recording_watermark).toEqual(expect.any(Number));
    const before = budget(probe);

    await killHost(first);
    // Verifier 等待边界强杀：结果已产生但未验收/未提交，Task 不得自动通过。
    expect(q(probe, 'SELECT status FROM tasks')).toEqual({ status: 'running' });
    const restart = await spawnHost(entry.env, config, 'f016-host-resume');
    entry.children.push(restart);
    await waitFor(() => attemptRows(probe)[0]?.status === 'interrupted', '遗留 Attempt 被 fence');
    expect(attemptRows(probe)).toHaveLength(1);
    expect(q(probe, 'SELECT status, reason FROM runs')).toMatchObject({ status: 'paused' });
    expect(workspace(probe)).toMatchObject({ id: managed.id, status: 'retained' });
    expect(probe.database.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get()).toEqual({ n: 0 });
    expect(q(probe, "SELECT status FROM tasks WHERE status = 'passed'")).toBeUndefined();
    expect(lateResult(probe, fixture, verified)).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });

    // Host 命令并发 resume：仅一个事务成功；之后只创建一个新 Attempt、复用同一 worktree。
    const client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    entry.clients.push(client);
    // 恢复核对已将 Run 置于 paused/restart_recovery；调度器对该状态只报告
    // run_control_blocked，不改写权威恢复原因。显式 resume 直接以当前 revision 竞争。
    expect(q(probe, 'SELECT status, reason FROM runs')).toMatchObject({ status: 'paused',
      reason: expect.stringMatching(/^(restart_recovery|verification_not_assembled)$/) });
    const run = q(probe, 'SELECT revision FROM runs') as { revision: number };
    const resumed = await client.resumeExecution({
      projectId: fixture.projectId, runId: fixture.runId, expectedRevision: run.revision,
    });
    const competed = await client.resumeExecution({
      projectId: fixture.projectId, runId: fixture.runId, expectedRevision: run.revision,
    }).catch(error => error as { code?: string });
    expect(resumed).toMatchObject({ status: 'completed', result: expect.objectContaining({ resumed: true }) });
    expect(competed).toMatchObject({ status: 'rejected', error: { code: 'conflict',
      details: { reason: expect.stringMatching(/^(stale_revision|not_resumable)$/) } } });
    await waitFor(() => attemptRows(probe).length === 2, '仅创建一个新 Attempt');
    await waitFor(() => runtimeStarts(markerDir).length === 2, '新 Attempt 至多一次 Runtime 启动');
    await waitFor(() => attemptRows(probe)[1]?.status === 'verifying', '新 Attempt 进入待验收');
    expect(attemptRows(probe)[0]).toMatchObject({ id: verified.id, status: 'interrupted' });
    expect(attemptRows(probe)[1]!.session_id).not.toBe(verified.session_id);
    expect(q(probe, 'SELECT COUNT(*) AS n FROM managed_workspaces')).toEqual({ n: 1 });
    expect(workspace(probe).id).toBe(managed.id);
    const after = budget(probe);
    expect(after.deadline_at).toBe(initial.deadline_at);
    expect(after.budget_snapshot).toBe(initial.budget_snapshot);
    expect(after.attempts_created).toBe(Number(before.attempts_created) + 1);
    expect(after.runtime_starts).toBe(Number(before.runtime_starts) + 1);
    expect(runtimeStarts(markerDir).map(item => item.attemptId)).toEqual([verified.id, attemptRows(probe)[1]!.id]);
    expect(new Set(runtimeStarts(markerDir).map(item => item.invocationId)).size).toBe(2);
  }, 90_000);

  it('SIGKILLs a Host with events finished but result unsettled and refuses recovery after external Git drift and a leftover lock', async () => {
    const entry = setup();
    const { fixture, markerDir, probe } = await prepareFixture(entry);
    const config = {
      dataRoot: fixture.box.dataRoot,
      markerDir,
      gates: ['result-gate'],
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'tool_command', name: 'quick-writer' },
          { op: 'write_file', path: 'result-boundary.txt', content: 'written before result settlement\n' },
          { op: 'message', role: 'assistant', text: 'F-016 result boundary' },
        ],
        lifecycle: { result: { gate: 'result-gate' } },
      },
      toolCommands: QUICK_TOOL_COMMANDS,
    };
    const first = await spawnHost(entry.env, config, 'f016-host-result');
    entry.children.push(first);
    await waitFor(() => runtimeStarts(markerDir).length === 1, 'Runtime 启动');
    await waitFor(() => {
      const managed = q(probe, 'SELECT canonical_path FROM managed_workspaces') as { canonical_path: string } | undefined;
      return managed !== undefined && existsSync(join(managed.canonical_path, 'result-boundary.txt'));
    }, '工具/文件结果已发生');
    const managed = workspace(probe);
    await waitFor(() => attemptRows(probe)[0]?.status === 'preparing' || attemptRows(probe)[0]?.status === 'executing', '结果未结算的活跃 Attempt');
    await waitFor(() => (probe.database.prepare('SELECT process_identity FROM workspace_leases').get() as { process_identity: string | null }).process_identity !== null, '工具停止身份已持久化');

    await killHost(first);
    // 结果已发生但未落回执：文件保留，Task 仍未通过且没有自动新 Attempt。
    expect(readFileSync(join(managed.canonical_path, 'result-boundary.txt'), 'utf8')).toBe('written before result settlement\n');
    expect(attemptRows(probe)).toHaveLength(1);

    // 恢复前制造外部 HEAD 漂移与遗留 Git 锁；恢复必须拒绝放行且不删除锁/不自动完成。
    const root = managed.canonical_path;
    const tree = git(['rev-parse', 'HEAD^{tree}'], root).trim();
    const unrelated = git(['-c', 'user.name=External', '-c', 'user.email=external@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'external unrelated history'], root).trim();
    const oldHead = git(['rev-parse', 'HEAD'], root).trim();
    git(['update-ref', `refs/heads/${managed.branch}`, unrelated, oldHead], root);
    git(['reset', '--hard', unrelated], root);
    const gitDir = git(['rev-parse', '--absolute-git-dir'], root).trim();
    const lockPath = join(gitDir, 'index.lock');
    writeFileSync(lockPath, 'leftover lock from external verifier');

    const restart = await spawnHost(entry.env, config, 'f016-host-git-drift');
    entry.children.push(restart);
    await waitFor(() => attemptRows(probe)[0]?.status === 'interrupted', '遗留 Attempt 被 fence');
    expect(attemptRows(probe)).toHaveLength(1);
    expect(q(probe, "SELECT status FROM tasks WHERE status = 'passed'")).toBeUndefined();
    expect(q(probe, 'SELECT status, reason FROM runs')).toMatchObject({ status: 'interrupted', reason: 'restart_recovery' });
    expect(workspace(probe)).toMatchObject({ id: managed.id, status: 'quarantined' });
    expect(probe.database.prepare("SELECT state FROM workspace_leases").all()).toEqual([
      { state: 'quarantined' }, { state: 'quarantined' }, { state: 'quarantined' },
    ]);
    const diagnostic = await diagnosticOf(fixture, probe, attemptRows(probe)[0]!.id);
    expect(diagnostic).toMatchObject({ kind: 'work-recovery-reconciliation', status: 'quarantined' });
    expect(diagnostic.gaps).toEqual(expect.arrayContaining(['head_not_descended_from_base', 'git_lock_present']));
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('leftover lock from external verifier');
    expect(runtimeStarts(markerDir)).toHaveLength(1);

    // 恢复门控未开放：显式 resume 被拒绝且不写新 Attempt。
    const client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    entry.clients.push(client);
    const run = q(probe, 'SELECT revision FROM runs') as { revision: number };
    await expect(client.resumeExecution({
      projectId: fixture.projectId, runId: fixture.runId, expectedRevision: run.revision,
    })).rejects.toMatchObject({ code: 'resource_busy' });
    expect(attemptRows(probe)).toHaveLength(1);
    expect(runtimeStarts(markerDir)).toHaveLength(1);
  }, 90_000);
});
