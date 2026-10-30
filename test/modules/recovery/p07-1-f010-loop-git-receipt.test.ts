/**
 * P07-1 / F-010 代表性闭环二：真实 Task commit 已落盘、回执事务未持久化时
 * 终止 Host，重启核对后经默认 Core/Host/CLI 显式继续完成授权收尾。
 *
 * 验收面（.dag_context.json F-010 第 1 条，Git 回执半边）：
 * - 条件 post-commit 钩子在真实 commit 落盘后阻塞回执事务，强杀 Host；
 * - 重启诊断隔离旧 Attempt 并把副作用核对为 matched（不自动结算、不补提交）；
 * - 同一事实经真实 loopback HostClient、CLI JSON 与同库 Core 三通道一致，
 *   pending 回执可见；显式继续经默认 CLI（execution resume）触发受信结算；
 * - 最终一致性：Git commit 数与强杀时完全一致（不重复提交）、HEAD 即原提交、
 *   原回执补记 succeeded、后续获准执行沿用 no_change 不再制造新提交、
 *   worktree 代码保留、预算累计、Run 终态、进程树缺席。
 *
 * 真实 Host/SQLite/Git/受控进程；零模型请求。平台进程探测场景仅 darwin。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { openFaultBarrierFixture, RUNTIME_TARGET, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';
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

async function runCliJson(args: readonly string[], dataRoot: string): Promise<Record<string, unknown>> {
  let stdout = '';
  const { runAppCli } = await import('../../../packages/cli/src/app-execute.ts');
  const result = await runAppCli({ args: [...args, '--data-root', dataRoot], env: {}, io: { stdout: text => { stdout += text; }, stderr: () => undefined } });
  expect(result.exitCode, stdout).toBe(0);
  const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  return envelope.result as Record<string, unknown>;
}

describe.skipIf(process.platform !== 'darwin')('P07-1 F-010 representative closed loop: durable commit without receipt', () => {
  it('[case:f010-git-receipt-loop] settles the matched receipt on explicit CLI resume and completes without duplicate commits', async () => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f010b-' });
    fixtures.push(f);
    const projectId = f.fixture.projectId;
    const runId = f.fixture.runId;

    /* 真实 commit 落盘、回执事务前的精确边界。 */
    const child = await f.spawnHost(f.buildChildConfig('git-barrier'), 'f010-git');
    await waitFor(() => f.gitMarker() !== undefined, 'Task commit 已落盘', 90_000);
    const marker = f.gitMarker()!;
    const workspace = f.q('SELECT canonical_path, git_common_dir FROM managed_workspaces') as { canonical_path: string; git_common_dir: string };
    const oldAttempt = attempt(f);
    const operation = f.q('SELECT * FROM git_operations WHERE attempt_id = ?', oldAttempt.id);
    expect(operation).toMatchObject({ status: 'pending', actual_commit: null, operation_type: 'task_commit' });
    const countAtKill = Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim());
    const headAtKill = git(['rev-parse', 'HEAD'], workspace.canonical_path).trim();
    expect(headAtKill).toBe(marker.head);
    await f.collectEvidence('f010-git-receipt-loop', 'before');
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await child.exited).signal).toBe('SIGKILL');
    /* 放行钩子让已启动的 Git/hook 自然结束；不得再发起新提交。 */
    unlinkSync(f.gitHoldPath);
    await waitFor(() => !alive(marker.pid) && !existsSync(join(workspace.git_common_dir, 'index.lock')), '旧 Git/hook 停止', 30_000);
    const budgetAtKill = budget(f);

    /* 重启：隔离旧 Attempt，副作用核对 matched，回执保持 pending。 */
    const restart = await f.spawnHost(f.buildChildConfig('normal'), 'f010-git-restart');
    await waitFor(() => f.q('SELECT status FROM attempts WHERE id = ?', oldAttempt.id)?.status === 'interrupted',
      '重启 fence 旧 Attempt', 60_000);
    await waitFor(() => {
      const row = f.q(`SELECT json_extract(payload, '$.evidenceRef') AS ref FROM state_events
        WHERE event_type = 'work.recovery.updated' AND attempt_id = ?
        ORDER BY sequence DESC LIMIT 1`, oldAttempt.id) as { ref: string | null } | undefined;
      return row?.ref != null;
    }, '启动恢复观察发布', 60_000);
    expect(f.q('SELECT status, actual_commit FROM git_operations WHERE id = ?', operation.id))
      .toEqual({ status: 'pending', actual_commit: null });
    expect(f.q('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
    expect(['interrupted', 'paused']).toContain((f.q('SELECT status FROM runs') as { status: string }).status);
    expect(budget(f)).toEqual(budgetAtKill);
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim())).toBe(countAtKill);

    /* 三通道查询：pending 回执一致可见；pending 回执走显式 resume 结算。 */
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot,
      timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
    clients.push(client);
    const viaClient = await client.getRunRecovery(projectId, runId);
    expect(viaClient.run).toMatchObject({ runId });
    expect(['interrupted', 'paused']).toContain(viaClient.run.status);
    expect(viaClient.startup.interruptedAttempts.map(entry => entry.attemptId)).toEqual([oldAttempt.id]);
    expect(viaClient.startup.pendingGitOperations).toEqual([
      expect.objectContaining({ operationId: operation.id, kind: 'task_commit', status: 'pending', attemptId: oldAttempt.id }),
    ]);
    expect(viaClient.startup.workspace).toMatchObject({ status: 'quarantined' });
    expect(viaClient.startup.nextSteps).toEqual([
      { action: 'execution.resume', executable: true, blockedBy: [] },
    ]);
    const viaCli = await runCliJson(['execution', 'recovery', runId, '--project', projectId, '--json'],
      f.fixture.box.dataRoot) as unknown as {
      runId: string;
      startup: { pendingGitOperations: { operationId: string; status: string }[]; nextSteps: unknown[] };
    };
    expect(viaCli).toMatchObject({ runId });
    /* CLI 投影与 HostClient 视图在各自暴露的身份字段上一致。 */
    expect(viaCli.startup.pendingGitOperations)
      .toEqual(viaClient.startup.pendingGitOperations.map(entry => ({
        attemptId: entry.attemptId, kind: entry.kind, operationId: entry.operationId, status: entry.status,
      })));
    expect(viaCli.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(viaClient.startup.nextSteps)));

    /* 显式继续经默认 CLI：受信结算 matched 回执，不重放 Git。 */
    const revision = (f.q('SELECT revision FROM runs') as { revision: number }).revision;
    const resumed = await runCliJson(['execution', 'resume', '--project', projectId, '--run', runId,
      '--revision', String(revision), '--json'], f.fixture.box.dataRoot) as unknown as {
      operation: string; outcome: string; runIds: string[];
    };
    expect(resumed).toMatchObject({ operation: 'execution.resume', outcome: 'resumed' });
    expect(resumed.runIds).toContain(runId);
    expect(f.q('SELECT status, actual_commit FROM git_operations WHERE id = ?', operation.id))
      .toEqual({ status: 'succeeded', actual_commit: marker.head });
    /* 隔离解除：工作区不再 quarantined（新 Attempt 随后可能立即重新持有）。 */
    expect(f.q('SELECT status FROM managed_workspaces').status).not.toBe('quarantined');

    /* 后续获准执行：代码无变化沿用 no_change，不制造第二个提交。 */
    await restart.waitMessage('verifier_completion', 150_000);
    await waitFor(() => (f.q("SELECT status FROM tasks WHERE id = 't-1'") as { status: string }).status === 'passed',
      '结算后新 Attempt 完成验证', 60_000);
    /* 恢复保持解除：Run 不再处于 interrupted/paused，回到正常调度/终态。 */
    await waitFor(() => {
      const row = f.q('SELECT status, reason FROM runs') as { status: string; reason: string | null };
      return !['interrupted', 'paused'].includes(row.status) && row.reason !== 'restart_recovery';
    }, `恢复保持解除（实际 ${JSON.stringify(f.q('SELECT status, reason FROM runs'))}）`, 120_000);
    const finalRun = f.q('SELECT status, reason FROM runs') as { status: string; reason: string | null };
    expect(['queued', 'running', 'succeeded']).toContain(finalRun.status);
    expect(finalRun.reason).not.toBe('restart_recovery');

    /* 最终一致性：Attempt 序列 / 回执 / 预算 / Git / worktree / 进程树。 */
    expect(f.q("SELECT GROUP_CONCAT(status, ',') AS list FROM (SELECT status FROM attempts ORDER BY number)"))
      .toEqual({ list: 'interrupted,succeeded' });
    const newAttempt = f.q("SELECT id FROM attempts WHERE task_id = 't-1' AND status = 'succeeded'");
    const followUp = f.q('SELECT operation_type, status, actual_commit FROM git_operations WHERE attempt_id = ?', newAttempt.id);
    expect(followUp).toEqual({ operation_type: 'task_commit', status: 'no_change', actual_commit: marker.head });
    expect(Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim())).toBe(countAtKill);
    expect(git(['rev-parse', 'HEAD'], workspace.canonical_path).trim()).toBe(marker.head);
    expect(readFileSync(join(workspace.canonical_path, RUNTIME_TARGET.path), 'utf8')).toBe(RUNTIME_TARGET.content);
    expect(git(['status', '--porcelain'], workspace.canonical_path).trim()).toBe('');
    const after = budget(f);
    expect(after).toEqual({ ...budgetAtKill, attempts_created: 2, runtime_starts: 2 });
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 2 });
    expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state IN ('held','quarantined')")).toEqual({ n: 0 });
    expect(f.runtimeStarts()).toHaveLength(2);
    expect(alive(marker.pid)).toBe(false);
    const verifier = f.verifierMarker();
    if (verifier !== undefined) expect(alive(verifier.pid)).toBe(false);
    expect(f.workerPids().every(pid => !alive(pid))).toBe(true);
    await f.collectEvidence('f010-git-receipt-loop', 'after');

    restart.send({ kind: 'close' });
    const exit = await restart.exited;
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  }, 360_000);
});
