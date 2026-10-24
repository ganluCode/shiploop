import { describe, expect, it } from 'vitest';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { acquireInput, openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';
import { publishPreparedInputFixture } from '../../helpers/p03-4/task-dag-state-fixture.ts';

const NOW = 1_900_000_100_000;

describe('P05-4 F-006 多 Feature 派发恢复隔离', () => {
  it('[case:startup-recovery-isolates-feature-lease] 同项目另一 Feature 的租约不能阻止当前 Feature 安全释放', async () => {
    const f = await openSlotFixture();
    try {
      const db = f.box.session.database;
      const runB = db.prepare('SELECT id, batch_id FROM runs WHERE id = ?').get(f.runB.runId) as { id: string; batch_id: string };
      const inputB = publishPreparedInputFixture({ ...f.box, featureId: f.runB.featureId },
        { batchId: runB.batch_id, runId: runB.id }, 't-peer');
      const attemptId = 'attempt-feature-b-recovery';
      const digest = inputB.digests.snapshotDigest;

      f.box.session.transactWrite('test.feature-b-lease', () => {
        db.prepare(`UPDATE tasks SET status = 'running', execution_version = 1, updated_at = ? WHERE feature_id = ? AND id = 't-peer'`)
          .run(NOW, f.runB.featureId);
        db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
          number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
          VALUES (?, ?, ?, ?, ?, ?, 't-peer', 1, 'owner-b', 'host-b', 1, ?, ?, ?, ?)`)
          .run(attemptId, NOW, NOW, f.projectId, f.runB.featureId, f.runB.runId, NOW + 10_000,
            JSON.stringify(inputB), digest, inputB.group.snapshot.artifactId);
        db.prepare(`INSERT INTO workspace_leases (id, created_at, project_id, updated_at, resource_key,
          resource_kind, owner_kind, owner_id, host_instance_id, execution_version, state, lease_until)
          VALUES ('feature-b-workspace-lease', ?, ?, ?, 'feature-b:workspace', 'workspace', 'attempt', ?, 'host-b', 1, 'held', ?)`)
          .run(NOW, f.projectId, NOW, attemptId, NOW + 10_000);
      });

      f.box.session.transactWrite('test.acquire-feature-a', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const census = createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: () => NOW }).fence();

      expect(census.dispatchBlocked).toBe(true);
      expect(f.claimRows().find(row => row.id === f.claimA)).toMatchObject({ state: 'released' });
      expect(f.slotRows().find(row => row.claim_id === f.claimA)).toMatchObject({ state: 'released' });
      expect(f.claimRows().find(row => row.id === f.claimB)).toMatchObject({ state: 'quarantined' });
      expect(f.box.session.database.prepare('SELECT state FROM workspace_leases WHERE id = ?')
        .get('feature-b-workspace-lease')).toMatchObject({ state: 'quarantined' });
    } finally {
      f.close();
    }
  });
});
