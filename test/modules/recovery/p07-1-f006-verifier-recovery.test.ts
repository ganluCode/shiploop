import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createSqliteVerificationStore } from '../../../packages/core/src/adapters/sqlite/verification-store.ts';
import { openFaultBarrierFixture, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';

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
const attempt = (f: FaultBarrierFixture) => f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
const budget = (f: FaultBarrierFixture) => f.q('SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');
async function fixture(dependentTask = false) {
  const f = await openFaultBarrierFixture({ prefix: 'shiploop-p07f006-', dependentTask });
  fixtures.push(f);
  return f;
}
async function kill(f: FaultBarrierFixture) {
  const child = f.children.at(-1)!;
  expect(child.kill('SIGKILL')).toBe(true);
  expect((await child.exited).signal).toBe('SIGKILL');
}
async function assertQuarantined(f: FaultBarrierFixture) {
  await waitFor(() => attempt(f)?.status === 'interrupted', '旧 Attempt 被 fence', 30_000);
  expect(f.q("SELECT status FROM tasks WHERE id = 't-1'").status).toMatch(/^(running|pending)$/);
  expect(f.q('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
  expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
  expect(f.runtimeStarts()).toHaveLength(1);
  expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
}

describe.skipIf(process.platform !== 'darwin')('P07-1 F-006 real Verifier recovery', () => {
  it('[case:p07-verifier-orphan] stops the persistent Verifier and TERM-ignoring descendant on restart, retaining incomplete evidence and fencing late publication', async () => {
    const f = await fixture(true);
    const config = f.buildChildConfig('verifier-barrier');
    const descendantPath = join(f.markerDir, 'verifier-descendant');
    config.verifier = { ...(config.verifier as object), descendantPath };
    await f.spawnHost(config, 'f006-orphan');
    await waitFor(() => existsSync(`${descendantPath}.pid`) && existsSync(descendantPath), 'Verifier 后代写入', 90_000);
    const marker = f.verifierMarker()!;
    const descendant = Number(readFileSync(`${descendantPath}.pid`, 'utf8'));
    const saved = f.q('SELECT process_identity FROM verification_processes');
    expect(JSON.parse(saved.process_identity)).toMatchObject({ pid: expect.any(Number), startTime: expect.any(String) });
    const oldAttempt = attempt(f);
    const before = budget(f);
    await kill(f);
    const size = statSync(descendantPath).size;
    await waitFor(() => statSync(descendantPath).size > size, 'Host 退出后 Verifier 后代仍在写入');
    await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), 'f006-orphan-restart');
    await waitFor(() => !alive(marker.pid) && !alive(descendant), '持久 Verifier 与后代全部停止', 30_000);
    await assertQuarantined(f);
    expect(budget(f)).toEqual(before);
    const store = createSqliteVerificationStore(f.probe);
    const batch = store.listAttemptVerificationBatches(f.fixture.projectId, oldAttempt.id)[0]!;
    expect(batch.status).toBe('running');
    expect(() => store.saveCheckResult({ projectId: f.fixture.projectId, batchId: batch.id,
      resultId: 'late-result', checkKey: 'tests', status: 'passed', exitCode: 0, signal: null,
      timedOut: false, outputArtifactId: null, outputTail: null, startedAtUtcMs: Date.now(), endedAtUtcMs: Date.now() }))
      .toThrow(/stale.*identity/i);
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot }); clients.push(client);
    const resumed = await client.resumeExecution({ projectId: f.fixture.projectId, runId: f.fixture.runId,
      expectedRevision: f.q('SELECT revision FROM runs').revision }).catch(error => ({ status: 'rejected', code: error.code }));
    expect(resumed.status).toBe('rejected');
    expect(f.q('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.q("SELECT status FROM tasks WHERE id = 't-2'").status).not.toBe('passed');
    expect(f.q("SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-2'")).toEqual({ n: 0 });
    await f.collectEvidence('verifier-orphan', 'after');
  }, 150_000);

  it('[case:p07-exited-uncommitted] exit 0 before result persistence is incomplete evidence and never passes on restart', async () => {
    const f = await fixture();
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierExitBarrier: true }), 'f006-exited');
    await child.waitMessage('verifier_command_exited', 90_000);
    expect(f.q('SELECT COUNT(*) AS n FROM check_results')).toEqual({ n: 0 });
    expect(f.q('SELECT status FROM verification_batches')).toEqual({ status: 'running' });
    expect(alive(f.verifierMarker()!.pid)).toBe(false);
    await kill(f);
    await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), 'f006-exited-restart');
    await assertQuarantined(f);
    expect(f.q('SELECT COUNT(*) AS n FROM check_results')).toEqual({ n: 0 });
    await f.collectEvidence('exited-uncommitted', 'after');
  }, 150_000);

  it('[case:p07-check-saved-unfinalized] a saved passed CheckResult cannot substitute for a finalized complete batch after Host loss', async () => {
    const f = await fixture(true);
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierBatchBarrier: true }), 'f006-check-saved');
    await child.waitMessage('verifier_check_saved', 90_000);
    expect(f.q('SELECT status FROM check_results')).toEqual({ status: 'passed' });
    expect(f.q('SELECT status FROM verification_batches')).toEqual({ status: 'running' });
    const outputId = f.q('SELECT output_artifact_id FROM check_results').output_artifact_id;
    expect(f.q('SELECT status FROM artifacts WHERE id = ?', outputId)).toEqual({ status: 'ready' });
    await kill(f);
    await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), 'f006-check-saved-restart');
    await assertQuarantined(f);
    expect(f.q('SELECT status FROM verification_batches')).toEqual({ status: 'running' });
    expect(f.q("SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-2'")).toEqual({ n: 0 });
    await f.collectEvidence('check-saved-unfinalized', 'after');
  }, 150_000);

  it('[case:p07-complete-revalidate] a complete durable batch permits explicit bounded revalidation with a new Attempt and cumulative budget', async () => {
    const f = await fixture();
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierCompletionBarrier: true }), 'f006-complete');
    await child.waitMessage('verifier_batch_finalized', 90_000);
    const old = attempt(f);
    expect(f.q('SELECT status FROM verification_batches')).toEqual({ status: 'passed' });
    const output = f.q('SELECT output_artifact_id FROM check_results');
    const actual = f.q('SELECT status, size_bytes FROM artifacts WHERE id = ?', output.output_artifact_id);
    expect(actual.status).toBe('ready');
    expect(actual.size_bytes).toBeGreaterThan(0);
    const file = await createArtifactFileStore({ dataRoot: f.fixture.box.dataRoot }).openFinalRead({
      projectId: f.fixture.projectId, artifactId: output.output_artifact_id });
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toContain('SHIPLOOP_NODE_CHECK_RESULT=');
    const before = budget(f);
    const workspace = f.workspaceRow()!;
    await kill(f);
    const restarted = await f.spawnHost(f.buildChildConfig('normal'), 'f006-complete-restart');
    expect(attempt(f)).toMatchObject({ id: old.id, status: 'interrupted' });
    expect(f.q('SELECT status FROM tasks')).toEqual({ status: 'pending' });
    const diagnostic = async () => {
      const file = await createArtifactFileStore({ dataRoot: f.fixture.box.dataRoot }).openFinalRead({
        projectId: f.fixture.projectId, artifactId: attempt(f).diagnostic_ref });
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    expect(f.q('SELECT COUNT(*) AS n FROM workspace_leases'), JSON.stringify(await diagnostic())).toEqual({ n: 0 });
    expect(f.workspaceRow()).toMatchObject({ id: workspace.id, status: 'retained' });
    expect(budget(f)).toEqual(before);
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot }); clients.push(client);
    const request = { projectId: f.fixture.projectId, runId: f.fixture.runId,
      expectedRevision: f.q('SELECT revision FROM runs').revision };
    expect(await client.resumeExecution(request)).toMatchObject({ status: 'completed', result: { resumed: true } });
    expect((await client.resumeExecution(request)).status).toBe('rejected');
    await restarted.waitMessage('verifier_completion', 90_000);
    expect(f.q('SELECT status FROM tasks')).toEqual({ status: 'passed' });
    expect(f.q('SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(attempt(f)).toMatchObject({ status: 'succeeded', number: 2 });
    expect(f.q('SELECT COUNT(*) AS n FROM verification_batches')).toEqual({ n: 2 });
    expect(f.q('SELECT COUNT(*) AS n FROM check_results')).toEqual({ n: 2 });
    expect(f.runtimeStarts()).toHaveLength(2);
    expect(f.workspaceRow()!.id).toBe(workspace.id);
    expect(budget(f)).toEqual({ ...before, attempts_created: before.attempts_created + 1, runtime_starts: before.runtime_starts + 1 });
    await f.collectEvidence('complete-revalidate', 'after');
  }, 180_000);

  it.each(['corrupt-output', 'code-drift'] as const)('[case:p07-%s] refuses changed durable evidence before completion and retains isolation on restart', async mutation => {
    const f = await fixture();
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierCompletionBarrier: true }), `f006-${mutation}`);
    await child.waitMessage('verifier_batch_finalized', 90_000);
    const outputId = f.q('SELECT output_artifact_id FROM check_results').output_artifact_id;
    if (mutation === 'corrupt-output') {
      writeFileSync(join(f.fixture.box.dataRoot, deriveArtifactFinalRelativePath({
        projectId: f.fixture.projectId, artifactId: outputId })), 'damaged output');
    } else {
      writeFileSync(join(f.workspaceRow()!.canonical_path, 'external-change.txt'), 'external change');
    }
    child.send({ kind: 'release_verifier_batch_finalized' });
    expect(await child.waitMessage('verifier_error', 30_000)).toMatchObject({ name: 'StorageError' });
    expect(f.q('SELECT status FROM tasks')).toEqual({ status: 'running' });
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    await kill(f);
    await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), `f006-${mutation}-restart`);
    await assertQuarantined(f);
    await f.collectEvidence(mutation, 'after');
  }, 150_000);

  it('[case:p07-human-gate] a human block added after machine checks persists through completion without releasing dependencies', async () => {
    const f = await fixture(true);
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierCompletionBarrier: true }), 'f006-human');
    await child.waitMessage('verifier_batch_finalized', 90_000);
    const current = attempt(f);
    const snapshot = JSON.parse(current.input_snapshot);
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot }); clients.push(client);
    expect(await client.submitTaskApprovalBlock({ projectId: f.fixture.projectId, taskId: current.task_id,
      planDigest: snapshot.approval.planDigest, expectedRevision: f.q('SELECT revision FROM tasks').revision,
      kind: 'block', description: 'Owner must confirm verification result', responsibleParty: 'owner' }))
      .toMatchObject({ status: 'completed' });
    child.send({ kind: 'release_verifier_batch_finalized' });
    expect(await child.waitMessage('verifier_completion', 30_000)).toMatchObject({ outcome: 'passed',
      receipt: { waitingFor: 'approval' } });
    expect(f.q('SELECT status, manual_block FROM tasks')).toEqual({ status: 'running', manual_block: 1 });
    expect(f.q('SELECT status FROM attempts')).toEqual({ status: 'verifying' });
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(f.q("SELECT COUNT(*) AS n FROM task_approval_items WHERE status = 'pending'")).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(f.q("SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-2'")).toEqual({ n: 0 });
    expect(f.q("SELECT status FROM tasks WHERE id = 't-2'").status).not.toBe('passed');
  }, 120_000);

  it('[case:p07-zero-tests] a real exit 0 with zero collected tests persists inconclusive and cannot commit or pass', async () => {
    const f = await fixture();
    const config = f.buildChildConfig('normal');
    config.verifier = { ...(config.verifier as object), testCount: 0 };
    const child = await f.spawnHost(config, 'f006-zero-tests');
    expect(await child.waitMessage('verifier_result', 90_000)).toMatchObject({ status: 'inconclusive',
      checks: [{ status: 'inconclusive', reason: 'invalid_result_protocol' }] });
    expect(f.q('SELECT status, exit_code FROM check_results')).toEqual({ status: 'inconclusive', exit_code: 0 });
    expect(f.q('SELECT status FROM tasks')).toEqual({ status: 'running' });
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
  }, 120_000);
});
