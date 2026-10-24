import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';
import { publishPreparedInputFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';
import { git } from '../../helpers/git-repo.ts';
import { BUDGET } from '../../helpers/p03-3/budget-fixture.ts';

const NOW = 1_900_000_100_000;

function insertAttempt(
  f: Awaited<ReturnType<typeof openSlotFixture>>,
  input: ReturnType<typeof publishPreparedInputFixture>,
  value: { featureId: string; runId: string; taskId: string; attemptId: string; owner: string; host: string; version: number },
): void {
  const db = f.box.session.database;
  db.prepare("UPDATE tasks SET status = 'running', execution_version = ?, updated_at = ? WHERE id = ?")
    .run(value.version, NOW, value.taskId);
  db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(value.attemptId, NOW, NOW, f.projectId, value.featureId, value.runId, value.taskId,
      value.owner, value.host, value.version, NOW + 10_000, JSON.stringify(input), input.digests.snapshotDigest,
      input.group.snapshot.artifactId);
}

describe('P05-4 F-005 Feature worktree ownership', () => {
  it('[case:feature-workspace-leases-isolated] different Features hold independent leases in separate real worktrees', async () => {
    const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const f = await openSlotFixture({ ...BUDGET, batch: { ...batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 4 } });
    const worktrees: string[] = [];
    try {
      const db = f.box.session.database;
      const runA = db.prepare('SELECT id, batch_id FROM runs WHERE id = ?').get(f.runA.runId) as { id: string; batch_id: string };
      const runB = db.prepare('SELECT id, batch_id FROM runs WHERE id = ?').get(f.runB.runId) as { id: string; batch_id: string };
      const boxA = { ...f.box, featureId: f.runA.featureId };
      const boxB = { ...f.box, featureId: f.runB.featureId };
      const inputA = publishPreparedInputFixture(boxA, { batchId: runA.batch_id, runId: runA.id }, 't-1');
      const inputB = publishPreparedInputFixture(boxB, { batchId: runB.batch_id, runId: runB.id }, 't-peer');
      const pathA = join(f.box.box.root, 'feature-a-worktree');
      const pathB = join(f.box.box.root, 'feature-b-worktree');
      git(['worktree', 'add', '-b', `shiploop/f005-a-${randomUUID()}`, pathA, 'HEAD'], f.box.box.repoDirA);
      git(['worktree', 'add', '-b', `shiploop/f005-b-${randomUUID()}`, pathB, 'HEAD'], f.box.box.repoDirA);
      worktrees.push(pathA, pathB);
      const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root] });
      const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.projectId);
      const workspaceA = await authority.verify(binding, pathA);
      const workspaceB = await authority.verify(binding, pathB);
      insertAttempt(f, inputA, { featureId: f.runA.featureId, runId: runA.id, taskId: 't-1', attemptId: 'attempt-f005-a', owner: 'owner-a', host: 'host-a', version: 1 });
      insertAttempt(f, inputB, { featureId: f.runB.featureId, runId: runB.id, taskId: 't-peer', attemptId: 'attempt-f005-b', owner: 'owner-b', host: 'host-b', version: 1 });
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
      const leaseA = f.box.session.transactWrite('test.f005.feature-a', () => resources.acquireInTransaction({ projectId: f.projectId, attemptId: 'attempt-f005-a', owner: 'owner-a', hostInstanceId: 'host-a', executionVersion: 1 }, workspaceA, NOW + 10_000));
      const leaseB = f.box.session.transactWrite('test.f005.feature-b', () => resources.acquireInTransaction({ projectId: f.projectId, attemptId: 'attempt-f005-b', owner: 'owner-b', hostInstanceId: 'host-b', executionVersion: 1 }, workspaceB, NOW + 10_000));
      expect(leaseA.leases).toHaveLength(3);
      expect(leaseB.leases).toHaveLength(3);
      expect(new Set([leaseA.leases[2]!.resourceKey, leaseB.leases[2]!.resourceKey]).size).toBe(2);
      expect(db.prepare('SELECT count(*) AS n FROM workspace_leases').get()).toEqual({ n: 6 });
    } finally {
      for (const path of worktrees.reverse()) {
        try { git(['worktree', 'remove', '--force', path], f.box.box.repoDirA); } catch { /* preserve the test failure scene */ }
      }
      f.close();
    }
  }, 60_000);

  it('[case:same-feature-second-writer-rejected] same Feature cannot acquire a second writer while the first lease remains held', async () => {
    const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const f = await openSlotFixture({ ...BUDGET, batch: { ...batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 4 } });
    const worktrees: string[] = [];
    try {
      const db = f.box.session.database;
      const run = db.prepare('SELECT id, batch_id FROM runs WHERE id = ?').get(f.runA.runId) as { id: string; batch_id: string };
      const input = publishPreparedInputFixture({ ...f.box, featureId: f.runA.featureId }, { batchId: run.batch_id, runId: run.id }, 't-1');
      const pathA = join(f.box.box.root, 'feature-same-a');
      const pathB = join(f.box.box.root, 'feature-same-b');
      git(['worktree', 'add', '-b', `shiploop/f005-same-a-${randomUUID()}`, pathA, 'HEAD'], f.box.box.repoDirA);
      git(['worktree', 'add', '-b', `shiploop/f005-same-b-${randomUUID()}`, pathB, 'HEAD'], f.box.box.repoDirA);
      worktrees.push(pathA, pathB);
      const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root] });
      const binding = createSqliteStateAccess(f.box.session).getRepositoryBinding(f.projectId);
      const workspaceA = await authority.verify(binding, pathA);
      const workspaceB = await authority.verify(binding, pathB);
      insertAttempt(f, input, { featureId: f.runA.featureId, runId: run.id, taskId: 't-1', attemptId: 'attempt-f005-first', owner: 'owner-first', host: 'host-first', version: 1 });
      const resources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
      f.box.session.transactWrite('test.f005.same-first', () => resources.acquireInTransaction({ projectId: f.projectId, attemptId: 'attempt-f005-first', owner: 'owner-first', hostInstanceId: 'host-first', executionVersion: 1 }, workspaceA, NOW + 10_000));
      db.prepare("UPDATE attempts SET status = 'succeeded', execution_stage = 'verification', ended_at = ?, exit_code = 0 WHERE id = 'attempt-f005-first'").run(NOW);
      db.prepare("UPDATE tasks SET status = 'running', execution_version = 2, revision = revision + 1 WHERE id = 't-1'").run();
      db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
        number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
        VALUES ('attempt-f005-second', ?, ?, ?, ?, ?, 't-1', 2, 'owner-second', 'host-second', 2, ?, ?, ?, ?)`)
        .run(NOW, NOW, f.projectId, f.runA.featureId, run.id, NOW + 10_000, JSON.stringify(input), input.digests.snapshotDigest, input.group.snapshot.artifactId);
      expect(() => f.box.session.transactWrite('test.f005.same-second', () => resources.acquireInTransaction({ projectId: f.projectId, attemptId: 'attempt-f005-second', owner: 'owner-second', hostInstanceId: 'host-second', executionVersion: 2 }, workspaceB, NOW + 10_000)))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'resource_busy' }) }));
      expect(db.prepare('SELECT count(*) AS n FROM workspace_leases').get()).toEqual({ n: 3 });
    } finally {
      for (const path of worktrees.reverse()) {
        try { git(['worktree', 'remove', '--force', path], f.box.box.repoDirA); } catch { /* preserve the test failure scene */ }
      }
      f.close();
    }
  }, 60_000);
});
