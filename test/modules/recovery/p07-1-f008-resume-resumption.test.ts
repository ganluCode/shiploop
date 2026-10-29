/**
 * P07-1 / F-008：显式恢复的重新授权、同 Task 来源核对与预算接续。
 *
 * 验收边界（.dag_context.json F-008）：
 * - 真实 Host/SQLite/Git/受控 Runtime；Task commit 已落盘、回执事务前强杀 Host；
 * - 重启诊断保留隔离后，用户显式 resume 才触发受信补回执：复用 F-007 已核对
 *   的 matched 副作用事实，不重启模型、不重复提交、不新增 Attempt/启动计数；
 * - 未核对（unknown）副作用不能借 resume 绕过隔离；同 commandId/同摘要回放
 *   原回执，不同摘要 conflict；不同命令竞争同一 expectedRevision 至多一个成功；
 * - 后续获准执行代码无变化时沿用 no_change；预算/deadline 累计不清零。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { openFaultBarrierFixture, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';

const fixtures: FaultBarrierFixture[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) { await fixture.forceDispose(); throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result)}`); }
  }
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/* 真实恢复结算含多次受界工作区检查/制品发布（实测 ~13s）：客户端提交预算
 * 覆盖单次完整结算+重验，不做任何服务端行为放宽。 */
async function connect(f: FaultBarrierFixture): Promise<HostClient> {
  const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot,
    timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
  clients.push(client);
  return client;
}
const attempt = (f: FaultBarrierFixture) => f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
const budget = (f: FaultBarrierFixture) => f.q('SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');
async function diagnostic(f: FaultBarrierFixture) {
  const id = f.q('SELECT diagnostic_ref FROM attempts ORDER BY number DESC LIMIT 1').diagnostic_ref;
  const file = await createArtifactFileStore({ dataRoot: f.fixture.box.dataRoot }).openFinalRead({ projectId: f.fixture.projectId, artifactId: id });
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function restartIntoQuarantine(f: FaultBarrierFixture, evidence: 'intact' | 'missing-inspection', label: string) {
  const child = await f.spawnHost(f.buildChildConfig('git-barrier'), label);
  await waitFor(() => f.gitMarker() !== undefined, 'Task commit 已落盘', 90_000);
  const marker = f.gitMarker()!;
  const workspace = f.q('SELECT * FROM managed_workspaces');
  const old = f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
  const operation = f.q('SELECT * FROM git_operations WHERE attempt_id = ?', old.id);
  const count = git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim();
  expect(child.kill('SIGKILL')).toBe(true);
  expect((await child.exited).signal).toBe('SIGKILL');
  unlinkSync(f.gitHoldPath);
  await waitFor(() => !alive(marker.pid) && !existsSync(join(workspace.git_common_dir, 'index.lock')), '旧 Git/hook 停止');
  if (evidence === 'missing-inspection') {
    const ref = JSON.parse(operation.verification_refs).find((ref: { kind: string }) => ref.kind === 'artifact');
    unlinkSync(join(f.fixture.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.fixture.projectId, artifactId: ref.id })));
  }
  const restarted = await f.spawnHost(f.buildChildConfig('normal'), `${label}-restart`);
  await waitFor(() => attempt(f)?.status === 'interrupted', '重启诊断 fence 旧 Attempt', 60_000);
  const report = await diagnostic(f);
  expect(report).toMatchObject({ status: 'quarantined', taskPassed: false, newAttemptCreated: false,
    gitOperations: [{ operationId: operation.id, outcome: evidence === 'intact' ? 'matched' : 'unknown',
      reasonCode: evidence === 'intact' ? null : 'verification_evidence_missing' }] });
  expect(report.gaps).toContain('git_receipt_recovery_required');
  expect(f.q('SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
  const runStatus = f.q('SELECT status, reason FROM runs').status;
  expect(['interrupted', 'paused']).toContain(runStatus);
  expect(f.q('SELECT attempts_created, runtime_starts, budget_snapshot FROM execution_batches'))
    .toEqual({ attempts_created: 1, runtime_starts: 1, budget_snapshot: budget(f).budget_snapshot });
  return { marker, workspace, old, operation, count, restarted, runStatus };
}

describe.skipIf(process.platform !== 'darwin')('P07-1 F-008 explicit resume after Task commit recovery', () => {
  it('[case:f008-matched-resume-settles] settles the matched receipt on explicit resume, then completes with no_change and cumulative budget', async () => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f008-' });
    fixtures.push(f);
    const scene = await restartIntoQuarantine(f, 'intact', 'f008-settle');
    const before = budget(f);
    const client = await connect(f);
    const resumed = await client.resumeExecution({ projectId: f.fixture.projectId, runId: f.fixture.runId,
      expectedRevision: f.q('SELECT revision FROM runs').revision });
    expect(resumed).toMatchObject({ status: 'completed', replayed: false, result: { resumed: true, runtimeStarts: 0, attemptsCreated: 0 } });
    // 结算复用 matched 事实：不重放 Git、不启动模型，隔离释放、现场保留。
    expect(f.q('SELECT status, actual_commit, actual_tree FROM git_operations WHERE id = ?', scene.operation.id))
      .toEqual({ status: 'succeeded', actual_commit: scene.marker.head, actual_tree: scene.operation.candidate_tree });
    expect(f.q('SELECT status FROM managed_workspaces')).toEqual({ status: 'retained' });
    expect(f.q('SELECT head_commit FROM managed_workspaces')).toEqual({ head_commit: scene.marker.head });
    expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state IN ('held', 'quarantined')")).toEqual({ n: 0 });
    expect(f.q('SELECT status FROM attempts WHERE id = ?', scene.old.id)).toEqual({ status: 'interrupted' });
    expect(f.q('SELECT status FROM runs')).toEqual({ status: 'queued' });
    // 后续获准执行：新 Attempt 复用原 worktree，代码无变化沿用 no_change。
    await scene.restarted.waitMessage('verifier_completion', 120_000).catch(error => {
      throw new Error(`${String(error)}\nF008-DUMP ${JSON.stringify({
        task: f.q('SELECT id, status, execution_version FROM tasks'),
        attempts: f.q("SELECT COUNT(*) AS n, GROUP_CONCAT(number || ':' || status || ':' || execution_stage || ':' || COALESCE(error_kind,'-')) AS list FROM attempts"),
        run: f.q('SELECT status, reason, revision FROM runs'),
        claims: f.q("SELECT GROUP_CONCAT(claim_version || ':' || state) AS list FROM run_dispatch_claims"),
        leases: f.q("SELECT COUNT(*) AS n, GROUP_CONCAT(state) AS list FROM workspace_leases"),
        slots: f.q("SELECT GROUP_CONCAT(state) AS list FROM execution_slot_claims"),
        gitOperations: f.q("SELECT GROUP_CONCAT(status) AS list FROM git_operations"),
        workspaceOp: f.q("SELECT status, substr(result_json, 1, 400) AS result FROM workspace_operations ORDER BY created_at DESC LIMIT 1"),
        preparationReceipts: f.q("SELECT COUNT(*) AS n FROM command_receipts WHERE principal_id = 'core-workspace-stop'"),
        runtimeStarts: f.runtimeStarts().length,
      })}`);
    });
    expect(f.q("SELECT status FROM tasks WHERE id = 't-1'")).toEqual({ status: 'passed' });
    expect(f.q('SELECT GROUP_CONCAT(status) AS list FROM (SELECT status FROM attempts ORDER BY number)'))
      .toEqual({ list: 'interrupted,succeeded' });
    const rework = f.q("SELECT g.status, g.actual_commit, g.operation_type FROM git_operations g JOIN attempts a ON a.id = g.attempt_id WHERE a.number = 2");
    expect(rework).toEqual({ status: 'no_change', actual_commit: scene.marker.head, operation_type: 'task_commit' });
    expect(git(['rev-list', '--count', 'HEAD'], scene.workspace.canonical_path).trim()).toBe(scene.count);
    expect(f.runtimeStarts()).toHaveLength(2);
    expect(f.q('SELECT id FROM managed_workspaces')).toEqual({ id: scene.workspace.id });
    const after = budget(f);
    expect(after).toMatchObject({ attempts_created: before.attempts_created + 1,
      runtime_starts: before.runtime_starts + 1, deadline_at: before.deadline_at,
      budget_snapshot: before.budget_snapshot });
    expect(f.q("SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-1'")).toEqual({ n: 2 });
  }, 240_000);

  it('[case:f008-unknown-effect-resume-refused] refuses to bypass isolation when the side effect is unverified', async () => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f008-' });
    fixtures.push(f);
    const scene = await restartIntoQuarantine(f, 'missing-inspection', 'f008-refuse');
    const before = budget(f);
    const client = await connect(f);
    const request = { projectId: f.fixture.projectId, runId: f.fixture.runId,
      expectedRevision: f.q('SELECT revision FROM runs').revision };
    for (let i = 0; i < 2; i += 1) {
      const rejected = await client.resumeExecution(request).then(receipt => ({ status: receipt.status }),
        error => ({ status: 'rejected', reason: JSON.stringify(error?.details ?? error) }));
      expect(rejected.status).toBe('rejected');
      if ('reason' in rejected) expect(rejected.reason).toMatch(/recovery_unsafe|occupancy_unresolved|startup_recovery/);
    }
    expect(f.q('SELECT status, actual_commit FROM git_operations WHERE id = ?', scene.operation.id))
      .toEqual({ status: 'pending', actual_commit: null });
    expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
    expect(f.q('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
    expect(f.q('SELECT status FROM runs')).toEqual({ status: scene.runStatus });
    expect(f.q("SELECT COUNT(*) AS n FROM attempts")).toEqual({ n: 1 });
    expect(f.q("SELECT status FROM tasks WHERE id = 't-1'").status).not.toBe('passed');
    expect(budget(f)).toEqual(before);
    expect(f.runtimeStarts()).toHaveLength(1);
  }, 240_000);

  it('[case:f008-resume-replay-conflict] replays the original receipt, conflicts on a different digest, and admits at most one racing resume', async () => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f008-' });
    fixtures.push(f);
    await restartIntoQuarantine(f, 'intact', 'f008-idempotent');
    const client = await connect(f);
    const base = { projectId: f.fixture.projectId, runId: f.fixture.runId };
    const revision = f.q('SELECT revision FROM runs').revision;
    // 不同命令争用同一（结算前）expectedRevision：至多一个恢复成功。
    const racers = await Promise.allSettled([
      client.resumeExecution({ ...base, expectedRevision: revision }),
      client.resumeExecution({ ...base, expectedRevision: revision }),
    ]);
    const fulfilled = racers.filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof client.resumeExecution>>> =>
      entry.status === 'fulfilled');
    const completed = fulfilled.filter(entry => entry.value.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(racers).toHaveLength(2);
    const winner = completed[0]!.value;
    // 同 commandId/同摘要：返回原回执；不同摘要：conflict。
    const replay = await client.resumeExecution({ ...base, expectedRevision: revision },
      { commandId: winner.commandId, issuedAt: winner.issuedAt });
    expect(replay.replayed).toBe(true);
    expect(replay).toMatchObject({ status: 'completed', commandId: winner.commandId, requestDigest: winner.requestDigest });
    await expect(client.resumeExecution({ ...base, expectedRevision: revision + 5 },
      { commandId: winner.commandId, issuedAt: winner.issuedAt }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(f.q("SELECT COUNT(*) AS n FROM git_operations WHERE status = 'succeeded'")).toEqual({ n: 1 });
    expect(f.q("SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.resumed'"))
      .toEqual({ n: 1 });
    expect(f.q('SELECT status FROM runs')).toEqual({ status: 'queued' });
  }, 240_000);
});
