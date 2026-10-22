import { describe, expect, it } from 'vitest';
import { createExecutionResumeService } from '../../../packages/core/src/application/execution-resume.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../../../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { acquireInput, openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';

function resumeService(f: Awaited<ReturnType<typeof openSlotFixture>>, now: number) {
  return createExecutionResumeService({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => now }),
    dag: createSqliteTaskDagStore(f.box.session), attempts: createSqliteAttemptAccess(f.box.session),
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: () => now,
  });
}

describe('P04-9 F-007 explicit resume dispatch guard', () => {
  it('[case:resume-occupied] 仅改 Run 为 paused 不能绕过未核对派发归属；准备与写事务分别拒绝', async () => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.slot', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'restart_recovery' WHERE id = ?").run(f.runA.runId);
      expect(await resumeService(f, f.now()).prepareExecutionResume(f.projectId, { runId: f.runA.runId, batchId: null }))
        .toMatchObject({ kind: 'not_resumable', reason: 'occupancy_unresolved' });
      const run = f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?').get(f.runA.runId) as { revision: number };
      expect(() => f.box.session.transactWrite('test.resume', () => createSqliteExecutionAccess(f.box.session, { nowUtcMs: f.now })
        .resumeExecutionInTransaction({ projectId: f.projectId, targetKind: 'run', targetId: f.runA.runId,
          expectedRevision: run.revision, workspace: null })))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'occupancy_unresolved' }) }));
      expect(f.counts().attempts).toBe(0);
      expect(f.slotRows()[0]).toMatchObject({ state: 'held' });
    } finally { f.close(); }
  });

  it('[case:resume-original-deadline] 受信释放后显式继续仍使用原绝对 deadline 和父预算', async () => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.slot', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const before = f.box.session.database.prepare('SELECT * FROM execution_batches ORDER BY id').all();
      createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }).fence();
      f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'restart_recovery' WHERE id = ?").run(f.runA.runId);
      expect(await resumeService(f, f.now() + 3_600_001).prepareExecutionResume(f.projectId, { runId: f.runA.runId, batchId: null }))
        .toMatchObject({ kind: 'not_resumable', reason: 'budget_exhausted' });
      expect(f.box.session.database.prepare('SELECT * FROM execution_batches ORDER BY id').all()).toEqual(before);
      expect(f.counts().attempts).toBe(0);
      expect(f.slotRows()[0]).toMatchObject({ state: 'released' });
    } finally { f.close(); }
  });
});
