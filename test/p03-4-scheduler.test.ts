import { describe, expect, it, vi } from 'vitest';
import { createWorkScheduler } from '../packages/core/src/application/work-scheduler.ts';
import { createSqliteSchedulerStore } from '../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { createSqliteTaskDagStore } from '../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createTaskDagService } from '../packages/core/src/application/task-dag.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { persistVerifiedPassFixture } from './helpers/p03-4/task-dag-state-fixture.ts';

function schedulerOptions(f: Awaited<ReturnType<typeof openClaimFixture>>) {
  return { store: createSqliteSchedulerStore(f.box.session, { nowUtcMs: () => NOW }),
    dag: createTaskDagService({ store: createSqliteTaskDagStore(f.box.session), nowMs: () => NOW }),
    intervalMs: 100, pageSize: 1, maxPages: 1, maxWakeups: 2 };
}

// A clock with explicit callbacks avoids wall-clock waits and leaked services.
function manualTimers() {
  let next = 0;
  const callbacks = new Map<number, () => void>();
  return { callbacks, setTimeout(callback: () => void, _delay: number) {
    const id = ++next; callbacks.set(id, callback); return id;
  }, clearTimeout(handle: unknown) { callbacks.delete(handle as number); },
  fire() {
    const [id, callback] = callbacks.entries().next().value!;
    callbacks.delete(id); callback();
  } };
}

describe('F-006 bounded Work Scheduler', () => {
  it('discovers a lost wakeup from SQLite and persists a capability gap without claiming', async () => {
    const f = await openClaimFixture();
    const scheduler = createWorkScheduler(schedulerOptions(f));
    try {
      const claim = vi.spyOn(f.store(), 'claimTask');
      const result = await scheduler.scan();
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ runId: f.ids.runId, reason: 'scheduler_capability_missing',
        capabilityGaps: ['workspace_input_preparation', 'committed_claim_consumer'] });
      expect(scheduler.inspect(f.ids.projectId, f.ids.runId)!).toMatchObject({ runId: f.ids.runId, reason: 'scheduler_capability_missing' });
      expect(f.box.session.database.prepare('SELECT reason, status FROM runs').get())
        .toEqual({ reason: 'scheduler_capability_missing', status: 'queued' });
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(claim).not.toHaveBeenCalled();
      const before = f.snapshot();
      await scheduler.scan();
      expect(f.snapshot()).toEqual(before);
    } finally { await scheduler.close(); f.box.close(); }
  });

  it('coalesces wakes and reentrant scans and consumes a fresh receipt only after commit', async () => {
    const f = await openClaimFixture([[], []]);
    const claims = f.store();
    const consume = vi.fn(async (receipt) => {
      expect(f.box.session.database.inTransaction).toBe(false);
      expect(f.box.session.database.prepare('SELECT id FROM attempts WHERE id = ?').get(receipt.attempt.id))
        .toEqual({ id: receipt.attempt.id });
      expect(receipt.attempt.taskId).toBe('t-1');
      scheduler.wake(f.ids.projectId, f.ids.runId);
      expect(scheduler.scan()).toBe(scanning);
    });
    const claim = vi.spyOn(claims, 'claimTask');
    const scheduler = createWorkScheduler({ ...schedulerOptions(f), claims,
      prepareClaim: async ({ taskId }) => f.input(Number(taskId.slice(2)) - 1), consumeClaim: consume });
    let scanning: ReturnType<typeof scheduler.scan>;
    try {
      scheduler.wake(f.ids.projectId, f.ids.runId);
      scheduler.wake(f.ids.projectId, f.ids.runId);
      scanning = scheduler.scan();
      expect(scheduler.scan()).toBe(scanning);
      await scanning;
      await scheduler.scan();
      expect(consume).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally { await scheduler.close(); f.box.close(); }
  });

  it('emits one durable final-verification handoff and never marks the Run complete', async () => {
    const f = await openClaimFixture();
    const snapshot = f.input().inputSnapshot;
    persistVerifiedPassFixture(f.box, f.ids, 't-1', snapshot);
    const onHandoff = vi.fn(async () => undefined);
    const scheduler = createWorkScheduler({ ...schedulerOptions(f), pageSize: 2, onHandoff });
    try {
      expect((await scheduler.scan()).runs[0]).toMatchObject({ reason: 'all_passed', claimed: false,
        handoff: { handoffKey: `${f.ids.runId}:feature_final_verification` } });
      expect((await scheduler.scan()).runs[0]).toMatchObject({ reason: 'all_passed', handoff: null });
      expect(onHandoff).toHaveBeenCalledTimes(1);
      expect(f.box.session.database.prepare('SELECT status, reason FROM runs').get())
        .toEqual({ status: 'queued', reason: 'feature_final_verification_handed_off' });
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally { await scheduler.close(); f.box.close(); }
  });
  it('uses explicit compensation ticks and clears timers and queued wakes on close', async () => {
    const f = await openClaimFixture();
    const timers = manualTimers();
    const scheduler = createWorkScheduler({ ...schedulerOptions(f), timers });
    try {
      scheduler.start();
      expect(timers.callbacks.size).toBe(1);
      timers.fire();
      await scheduler.scan();
      expect(scheduler.inspect(f.ids.projectId, f.ids.runId)!.reason).toBe('scheduler_capability_missing');
      scheduler.wake(f.ids.projectId, f.ids.runId);
      await scheduler.close();
      expect(timers.callbacks.size).toBe(0);
      expect(scheduler.wake(f.ids.projectId, f.ids.runId)).toBe(false);
      expect((await scheduler.scan()).closed).toBe(true);
      expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    } finally { await scheduler.close(); f.box.close(); }
  });
});
