import { describe, expect, it } from 'vitest';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { createWorkStartupRecovery } from '../../../packages/core/src/application/work-startup-recovery.ts';
import { acquireInput, openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';

describe('P04-9 F-007 dispatch startup recovery', () => {
  it('[case:slot-without-attempt] 未授权启动的占槽在重启核对后释放，重复重启不重复记账', async () => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const budget = f.box.session.database.prepare('SELECT * FROM execution_batches ORDER BY id').all();
      for (let restart = 0; restart < 2; restart++) {
        f.reopen();
        const startup = createWorkStartupRecovery({
          store: createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }),
          process: { recoverStop: async () => { throw new Error('must not signal an unstarted claim'); } },
          publishEvidence: async () => { throw new Error('no Attempt evidence'); },
        });
        expect(await startup.recover()).toEqual({ status: 'complete', reason: null });
        expect(f.slotRows()).toEqual([expect.objectContaining({ state: 'released' })]);
        expect(f.claimRows().every(row => row.state === 'released')).toBe(true);
        expect(f.box.session.database.prepare('SELECT status FROM runs ORDER BY id').all())
          .toEqual([{ status: 'queued' }, { status: 'queued' }]);
        expect(f.box.session.database.prepare('SELECT * FROM execution_batches ORDER BY id').all()).toEqual(budget);
        expect(f.counts().attempts).toBe(0);
      }
    } finally { f.close(); }
  });

  it.each(['released', 'quarantined'])('[case:clock-rollback-%s] 恢复时钟早于认领获得时刻仍完成受信释放或隔离，不回拨持久时间', async state => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const persistedAt = f.now() + 1_000;
      f.box.session.database.prepare('UPDATE run_dispatch_claims SET updated_at = ? WHERE id = ?').run(persistedAt, f.claimA);
      f.box.session.database.prepare('UPDATE execution_slot_claims SET updated_at = ? WHERE claim_id = ?').run(persistedAt, f.claimA);
      if (state === 'quarantined') {
        const run = f.box.session.database.prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.runA.runId) as { batch_id: string };
        f.box.session.database.prepare(`INSERT INTO runtime_start_reservations (id, created_at, updated_at, project_id, batch_id, run_id, start_key)
          VALUES ('rollback-launch', ?, ?, ?, ?, ?, 'rollback-launch')`).run(f.now(), f.now(), f.projectId, run.batch_id, f.runA.runId);
      }
      const census = createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: () => f.now() - 60_000 }).fence();
      expect(census.dispatchBlocked).toBe(state === 'quarantined');
      expect(f.claimRows().find(row => row.id === f.claimA)).toMatchObject({ state, settled_at: persistedAt, updated_at: persistedAt });
      expect(f.slotRows()[0]).toMatchObject({ state, released_at: state === 'released' ? persistedAt : null, updated_at: persistedAt });
      expect(f.counts().attempts).toBe(0);
    } finally { f.close(); }
  });

  it('[case:unstarted-contradiction] 无 Attempt 但有启动预占的矛盾现场保留槽位并给出原因', async () => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      const run = f.box.session.database.prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.runA.runId) as { batch_id: string };
      f.box.session.database.prepare(`INSERT INTO runtime_start_reservations (id, created_at, updated_at, project_id, batch_id, run_id, start_key)
        VALUES ('uncertain-launch', ?, ?, ?, ?, ?, 'uncertain-launch')`).run(f.now(), f.now(), f.projectId, run.batch_id, f.runA.runId);
      const census = createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }).fence();
      expect(census.dispatchBlocked).toBe(true);
      expect(f.slotRows()[0]).toMatchObject({ state: 'quarantined', reason: 'dispatch_unstarted_evidence_incomplete' });
      expect(f.claimRows().find(row => row.id === f.claimA)).toMatchObject({ state: 'quarantined' });
    } finally { f.close(); }
  });

  it.each(['cancelled', 'succeeded', 'failed'])('[case:terminal-%s] 终态无 Attempt 的槽位可受信释放但不重开 Run', async status => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A')));
      f.box.session.database.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(status, f.now(), f.runA.runId);
      const before = f.box.session.database.prepare('SELECT * FROM runs WHERE id = ?').get(f.runA.runId);
      createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }).fence();
      expect(f.slotRows()[0]).toMatchObject({ state: 'released' });
      expect(f.box.session.database.prepare('SELECT * FROM runs WHERE id = ?').get(f.runA.runId)).toEqual(before);
      expect(() => f.box.session.transactWrite('test.cannot-requeue', () => f.access.acquireInTransaction(acquireInput(f, 'A')))).toThrow();
    } finally { f.close(); }
  });
});
