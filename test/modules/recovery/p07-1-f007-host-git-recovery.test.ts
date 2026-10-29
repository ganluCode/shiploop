import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { openFaultBarrierFixture, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';

const fixtures: FaultBarrierFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const cleanup = await f.cleanup();
    if (!cleanup.ok) { await f.forceDispose(); throw new Error(JSON.stringify(cleanup)); }
  }
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function diagnostic(f: FaultBarrierFixture) {
  const id = f.q('SELECT diagnostic_ref FROM attempts ORDER BY number DESC LIMIT 1').diagnostic_ref;
  const file = await createArtifactFileStore({ dataRoot: f.fixture.box.dataRoot }).openFinalRead({ projectId: f.fixture.projectId, artifactId: id });
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe.skipIf(process.platform !== 'darwin')('P07 F-007 real Host commit recovery', () => {
  it.each(['intact', 'missing-inspection'] as const)('[case:task-restart-%s] keeps the original intent and fenced owner after SIGKILL at the real Task commit boundary', async evidence => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, dependentTask: true, prefix: 'shiploop-p07f007-' });
    fixtures.push(f);
    const child = await f.spawnHost(f.buildChildConfig('git-barrier'), `f007-${evidence}`);
    await waitFor(() => f.gitMarker() !== undefined, 'Task commit 已落盘', 90_000);
    const marker = f.gitMarker()!;
    const workspace = f.q('SELECT * FROM managed_workspaces');
    const old = f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
    const operation = f.q('SELECT * FROM git_operations WHERE attempt_id = ?', old.id);
    const count = git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim();
    const claim = join(workspace.git_common_dir, 'shiploop-baseline.claim');
    const claimBytes = readFileSync(claim, 'utf8');
    expect(operation).toMatchObject({ status: 'pending', actual_commit: null, operation_type: 'task_commit' });
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await child.exited).signal).toBe('SIGKILL');
    // Let the already launched Git/hook finish; never launch another commit.
    unlinkSync(f.gitHoldPath);
    await waitFor(() => !alive(marker.pid) && !existsSync(join(workspace.git_common_dir, 'index.lock')), '旧 Git/hook 停止');
    if (evidence === 'missing-inspection') {
      const ref = JSON.parse(operation.verification_refs).find((ref: { kind: string }) => ref.kind === 'artifact');
      unlinkSync(join(f.fixture.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.fixture.projectId, artifactId: ref.id })));
    }
    const before = f.q('SELECT attempts_created, runtime_starts, budget_snapshot FROM execution_batches');
    await f.spawnHost(f.buildChildConfig('normal', { verifier: null }), `f007-${evidence}-restart`);
    const report = await diagnostic(f);
    expect(report).toMatchObject({ status: 'quarantined', taskPassed: false, newAttemptCreated: false,
      gitOperations: [{ operationId: operation.id, outcome: evidence === 'intact' ? 'matched' : 'unknown',
        actualCommit: marker.head, actualTree: operation.candidate_tree,
        reasonCode: evidence === 'intact' ? null : 'verification_evidence_missing' }] });
    expect(report.gaps).toContain('git_receipt_recovery_required');
    expect(f.q('SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(f.q("SELECT status FROM tasks WHERE id = 't-1'").status).not.toBe('passed');
    expect(f.q("SELECT COUNT(*) AS n FROM attempts WHERE task_id = 't-2'")).toEqual({ n: 0 });
    expect(f.q('SELECT attempts_created, runtime_starts, budget_snapshot FROM execution_batches')).toEqual(before);
    expect(f.q('SELECT status, actual_commit FROM git_operations WHERE id = ?', operation.id)).toEqual({ status: 'pending', actual_commit: null });
    expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
    expect(readFileSync(claim, 'utf8')).toBe(claimBytes);
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim()).toBe(count);
    expect(git(['rev-parse', 'HEAD'], workspace.canonical_path).trim()).toBe(marker.head);
    // The persisted original operation cannot use its old Task execution fence.
    expect(() => createSqliteGitOperationStore(f.probe).finalizeGitOperation({ projectId: f.fixture.projectId,
      operationId: operation.id, expectedRevision: operation.revision, status: 'succeeded', actualCommit: marker.head,
      actualTree: operation.candidate_tree, exitCode: null, durationMs: null, reasonCode: null,
      deliveryStatus: 'not_requested', settledAtUtcMs: Date.now() })).toThrow(/stale/i);
  }, 150_000);
});
