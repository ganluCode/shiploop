/**
 * P07-1 / F-010 组合隔离场景：旧写入者停止未知 + 遗留 Git 锁/外部漂移在
 * 同一夹具下叠加，用真实写入屏障证明恢复观察与旧写入者的竞争重叠。
 *
 * 验收面（.dag_context.json F-010 第 2 条）：
 * - Runner 执行中强杀 Host；受控工具组按监督者断连升级自灭后，测试在
 *   worktree 内启动一个脱离受控组的真实旧写入者（TERM 免疫、持续写
 *   heartbeat），并把持久占用身份篡改为指向它（PID/旧标识场景）——恢复
 *   停止身份不符→不猜杀、不确认（stop_unconfirmed），旧写入者在恢复观察
 *   期间持续真实写入（竞争重叠），其写入同时构成恢复核对观测到的外部
 *   工作区漂移；
 * - 叠加遗留 Git 锁（index.lock）：恢复核对证据同时记录停止未知、漂移与
 *   锁缺口；诊断与隔离经 HostClient 与 CLI 一致展示、下一步被阻塞；
 * - 旧结果被 fence（迟到 runtime 结果按过期执行身份忽略）、未启动新执行、
 *   未删除代码（worktree 与 heartbeat 现场保留）；
 * - 修复前置事实（外部停止旧写入者、移除遗留锁）后不自动继续；受控重启
 *   重评恢复（reprobe 确认停止、锁/漂移缺口消失）后，录制水位等不可补证
 *   事实保持隔离——继续仍需显式授权，且显式 CLI resume 被失败关闭拒绝，
 *   不绕过未核事实；预算/Attempt/启动计数全程不变。
 *
 * 真实 Host/SQLite/Git/受控进程；零模型请求。平台进程探测场景仅 darwin。
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { openFaultBarrierFixture, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';

const fixtures: FaultBarrierFixture[] = [];
const clients: HostClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) {
      await fixture.forceDispose();
      throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result)}`);
    }
  }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const attempt = (f: FaultBarrierFixture) => f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
const budget = (f: FaultBarrierFixture) =>
  f.q('SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');

function latestObservation(f: FaultBarrierFixture, attemptId: string): Record<string, any> | undefined {
  const row = f.probe.database.prepare(`SELECT payload FROM state_events WHERE event_type = 'work.recovery.updated'
    AND attempt_id = ? ORDER BY sequence DESC LIMIT 1`).get(attemptId) as { payload: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.payload) as Record<string, any>;
}

async function diagnostic(f: FaultBarrierFixture): Promise<Record<string, any>> {
  const id = (f.q('SELECT diagnostic_ref FROM attempts ORDER BY number DESC LIMIT 1') as { diagnostic_ref: string }).diagnostic_ref;
  const file = await createArtifactFileStore({ dataRoot: f.fixture.box.dataRoot }).openFinalRead({ projectId: f.fixture.projectId, artifactId: id });
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

async function runCliJson(args: readonly string[], dataRoot: string): Promise<Record<string, unknown>> {
  let stdout = '';
  const result = await runAppCli({ args: [...args, '--data-root', dataRoot], env: {}, io: { stdout: text => { stdout += text; }, stderr: () => undefined } });
  expect(result.exitCode, stdout).toBe(0);
  const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  return envelope.result as Record<string, unknown>;
}

/** 显式继续被拒绝时的 CLI 失败信封（退出码非 0，ok=false）。 */
async function runCliFailure(args: readonly string[], dataRoot: string): Promise<{ exitCode: number; envelope: { ok: boolean; code?: string } }> {
  let stdout = '';
  const result = await runAppCli({ args: [...args, '--data-root', dataRoot], env: {}, io: { stdout: text => { stdout += text; }, stderr: () => undefined } });
  const envelope = JSON.parse(stdout) as { ok: boolean; code?: string };
  expect(result.exitCode).not.toBe(0);
  expect(envelope.ok).toBe(false);
  return { exitCode: result.exitCode, envelope };
}

/** 真实 /bin/ps 清点进程组成员（与生产停止探测同一事实源）。 */
function groupMembers(pgid: number): number[] {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
  return rows.trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== pgid)
    .map(([pid]) => pid!);
}

/** 脱离受控组的真实旧写入者：TERM 免疫、在 worktree 持续写 heartbeat。 */
function spawnLegacyWriter(worktree: string): { pid: number } {
  const script = [
    "const fs=require('node:fs')",
    "process.on('SIGTERM',()=>{})",
    "fs.writeFileSync('worker.pid',String(process.pid))",
    "fs.appendFileSync('heartbeat.txt','legacy\\n')",
    "setInterval(()=>fs.appendFileSync('heartbeat.txt','legacy\\n'),20)",
  ].join(';');
  const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
    cwd: worktree, env: {}, detached: true, stdio: 'ignore',
  });
  child.unref();
  if (child.pid === undefined) throw new Error('旧写入者启动失败');
  return { pid: child.pid };
}

describe.skipIf(process.platform !== 'darwin')('P07-1 F-010 combined isolation: unknown old writer + leftover Git lock', () => {
  it('[case:f010-combined-unknown-writer-lock] fences the overlapping race, keeps isolation without auto-continuation, and refuses explicit resume while recording facts stay unrepairable', async () => {
    const f = await openFaultBarrierFixture({ prefix: 'shiploop-p07f010c-' });
    fixtures.push(f);
    const projectId = f.fixture.projectId;
    const runId = f.fixture.runId;

    /* Runner 执行中边界：受控工具进程在写、Attempt 未完成。 */
    const child = await f.spawnHost(f.buildChildConfig('runner-barrier'), 'f010-combined');
    await waitFor(() => f.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    await waitFor(() => f.workspaceRow() !== undefined, '受管工作区就绪', 40_000);
    const workspace = f.q('SELECT canonical_path, git_common_dir FROM managed_workspaces') as { canonical_path: string; git_common_dir: string };
    const heartbeat = join(workspace.canonical_path, 'heartbeat.txt');
    await waitFor(() => existsSync(join(workspace.canonical_path, 'worker.pid')) && existsSync(heartbeat),
      '受控工具进程登记', 30_000);
    const toolWriterPid = Number(readFileSync(join(workspace.canonical_path, 'worker.pid'), 'utf8'));
    const toolGroup = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(toolWriterPid)], { encoding: 'utf8' }).trim());
    const oldAttempt = attempt(f);
    expect(oldAttempt).toMatchObject({ status: expect.stringMatching(/^(preparing|executing)$/) });
    const countAtKill = Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim());
    const budgetAtKill = budget(f);
    await f.collectEvidence('f010-combined-isolation', 'before');

    expect(child.kill('SIGKILL')).toBe(true);
    expect((await child.exited).signal).toBe('SIGKILL');
    /* 受控工具组按监督者断连升级自行收尾；这之后仍存活的真实写入者才是
     * 本场景的旧写入者（脱离受控组，无监督者会替恢复杀它）。 */
    await waitFor(() => groupMembers(toolGroup).length === 0 && !alive(toolWriterPid), '受控工具组自行收尾', 20_000);

    /* 旧写入者接管 worktree 写入；篡改持久占用身份指向它（PID/旧标识：
     * startTime 不可核对）——恢复不得按 pid 猜杀真实进程。 */
    const legacy = spawnLegacyWriter(workspace.canonical_path);
    const legacyPid = legacy.pid;
    f.registerControlled({ pid: legacyPid, label: 'f010-legacy-writer', policy: 'cancel' });
    await waitFor(() => existsSync(heartbeat) && statSync(heartbeat).size > 0
      && readFileSync(join(workspace.canonical_path, 'worker.pid'), 'utf8') === String(legacyPid),
      '旧写入者接管写入', 15_000);
    expect(alive(legacyPid)).toBe(true);
    f.probe.database.prepare('UPDATE workspace_leases SET process_identity = ?').run(
      JSON.stringify({ schemaVersion: 2, launchId: randomUUID(), pid: legacyPid,
        processGroupId: legacyPid, startTime: 'unrelated-process-start' }));

    /* 第二类故障：遗留 Git 锁（外部遗留 index.lock，非本产品写入）。 */
    const leftoverLock = join(workspace.git_common_dir, 'index.lock');
    writeFileSync(leftoverLock, 'stale external lock\n');

    /* 重启 #1：持久身份与真实进程不符→恢复不猜杀（stop_unconfirmed）；
     * 旧写入者持续写入构成恢复期工作区漂移，叠加遗留锁。 */
    const restart1 = await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), 'f010-combined-restart1');
    await waitFor(() => {
      const row = latestObservation(f, oldAttempt.id);
      return row !== undefined && Array.isArray(row.gaps) && row.gaps.includes('stop_unconfirmed');
    }, '恢复观察记录 stop_unconfirmed', 60_000);
    await waitFor(() => f.q('SELECT status FROM attempts WHERE id = ?', oldAttempt.id)?.status === 'interrupted',
      '重启 fence 旧 Attempt', 30_000);

    /* 屏障证明竞争重叠：stop_unconfirmed 已落库时旧写入者仍在真实写入。 */
    const sizeAtObservation = statSync(heartbeat).size;
    await waitFor(() => statSync(heartbeat).size > sizeAtObservation, '恢复观察期间旧写入者仍在写入（竞争重叠）', 30_000);
    expect(alive(legacyPid)).toBe(true);
    const report = await diagnostic(f);
    expect(report).toMatchObject({ status: 'quarantined', taskPassed: false, newAttemptCreated: false });
    expect(report.gaps).toEqual(expect.arrayContaining(['stop_unconfirmed', 'git_lock_present']));

    /* 诊断与隔离：HostClient 与 CLI 一致，下一步明确被阻塞。 */
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot,
      timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
    clients.push(client);
    const viaClient = await client.getRunRecovery(projectId, runId);
    expect(viaClient.startup.observations[0]).toMatchObject({ attemptId: oldAttempt.id, stopConfirmed: false });
    expect(viaClient.startup.workspace).toMatchObject({ status: 'quarantined' });
    const resumeStep = viaClient.startup.nextSteps.find(step => step.action === 'execution.resume')!;
    expect(resumeStep).toMatchObject({ executable: false });
    expect(resumeStep.blockedBy).toEqual(expect.arrayContaining(['stop_unconfirmed', 'workspace_quarantined', 'quarantined_occupancy']));
    const viaCli = await runCliJson(['execution', 'recovery', runId, '--project', projectId, '--json'],
      f.fixture.box.dataRoot) as unknown as { startup: { nextSteps: unknown[] } };
    expect(viaCli.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(viaClient.startup.nextSteps)));

    /* 旧结果被 fence：迟到 runtime 结果按过期执行身份忽略。 */
    const lifecycle = createSqliteAttemptLifecycleStore(f.probe, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.fixture.box.root] }),
      nowUtcMs: () => Date.now(),
    });
    expect(lifecycle.apply({
      projectId, runId: oldAttempt.run_id, taskId: oldAttempt.task_id, attemptId: oldAttempt.id,
      owner: oldAttempt.owner_id, hostInstanceId: oldAttempt.host_instance_id,
      executionVersion: oldAttempt.execution_version, notificationId: `f010-late-${oldAttempt.id}`,
      kind: 'runtime_completed', exitCode: 0, evidenceRef: f.fixture.requirementArtifactId,
    })).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });

    /* 未启动新执行、未删除代码：Attempt/启动计数不变，现场文件保留。 */
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(f.q("SELECT status FROM tasks WHERE id = 't-1'").status).not.toBe('passed');
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(existsSync(heartbeat)).toBe(true);
    expect(budget(f)).toEqual(budgetAtKill);

    /* 前置事实未修复时，显式授权也不能绕过隔离。 */
    const request = { projectId, runId, expectedRevision: (f.q('SELECT revision FROM runs') as { revision: number }).revision };
    await expect(client.resumeExecution(request)).rejects.toMatchObject({
      code: expect.stringMatching(/recovery_unsafe|occupancy_unresolved|startup_recovery|resource_busy/),
    });
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });

    /* 修复前置事实：外部停止旧写入者，移除遗留锁。 */
    try { process.kill(legacyPid, 'SIGKILL'); } catch { /* 已退出 */ }
    await waitFor(() => !alive(legacyPid) && groupMembers(legacyPid).length === 0, '旧写入者实际停止', 15_000);
    rmSync(leftoverLock, { force: true });

    /* 修复后不自动继续：无新 Attempt、无新 Runtime 启动、Run 不回调度。 */
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    expect((f.q('SELECT status FROM runs') as { status: string }).status).not.toBe('queued');

    /* 关闭重启 #1，受控重启 #2 重评恢复：reprobe 确认停止、锁/漂移缺口
     * 消失；但录制水位等不可补证事实保持隔离，Run 不自动派发。 */
    /* 关闭重启 #1：隔离未解除时装配级 close 按设计失败关闭（quiesce 未
     * 确认即退出非 0，不借 close 释锁、不绕过未确认停止）；进程退出本身
     * 释放 OS 写锁，供重启 #2 接管。 */
    restart1.send({ kind: 'close' });
    const exit1 = await restart1.exited;
    expect(exit1.code).toBe(1);
    expect(exit1.signal).toBeNull();
    const restart2 = await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), 'f010-combined-restart2');
    await waitFor(() => latestObservation(f, oldAttempt.id)?.stopConfirmed === true, 'reprobe 确认旧写入者停止', 90_000);
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(f.q('SELECT status FROM attempts WHERE id = ?', oldAttempt.id)).toEqual({ status: 'interrupted' });
    expect(f.q('SELECT status FROM managed_workspaces').status).toBe('quarantined');
    expect(f.q("SELECT COUNT(*) AS n FROM tasks WHERE status = 'passed'")).toEqual({ n: 0 });
    const postRepair = await diagnostic(f);
    expect(postRepair).toMatchObject({ status: 'quarantined' });
    expect(postRepair.gaps).not.toContain('stop_unconfirmed');
    expect(postRepair.gaps).not.toContain('git_lock_present');
    expect(postRepair.gaps).toEqual(expect.arrayContaining(['recording_watermark_missing']));

    /* 继续仍需显式授权：显式 CLI resume 被失败关闭拒绝——不可补证的录制
     * 事实不允许绕过隔离；持久事实与预算保持不变。 */
    const revision = (f.q('SELECT revision FROM runs') as { revision: number }).revision;
    const refused = await runCliFailure(['execution', 'resume', '--project', projectId, '--run', runId,
      '--revision', String(revision), '--json'], f.fixture.box.dataRoot);
    expect(refused.exitCode).not.toBe(0);
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(f.q("SELECT status FROM tasks WHERE id = 't-1'").status).not.toBe('passed');
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim())).toBe(countAtKill);
    expect(existsSync(heartbeat)).toBe(true);
    expect(budget(f)).toEqual(budgetAtKill);
    await f.collectEvidence('f010-combined-isolation', 'after');

    /* 测试收尾（与 p03-9 同一纪律）：先撤隔离租约再协作关闭重启 #2；
     * 这不是产品操作，只是把现场交还给测试清理。 */
    f.probe.database.prepare('DELETE FROM workspace_leases').run();
    restart2.send({ kind: 'close' });
    const exit2 = await restart2.exited;
    expect(exit2.code).toBe(0);
    expect(exit2.signal).toBeNull();
  }, 420_000);
});
