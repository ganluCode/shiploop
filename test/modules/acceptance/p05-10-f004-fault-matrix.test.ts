import { describe, expect, it } from 'vitest';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { createSqliteWorkStartupRecoveryStore } from '../../../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { acquireInput, openSlotFixture, slotIdentity } from '../../helpers/p04-9/slot-fixture.ts';
import type { RunRecord } from '../../../packages/core/src/ports/execution-store.ts';
import type { SchedulerStore } from '../../../packages/core/src/ports/work-scheduler.ts';

const NOW = 1_700_000_000_000;

function run(id: string, featureId = id): RunRecord {
  return {
    id,
    createdAtUtcMs: NOW,
    projectId: 'project-1',
    revision: 1,
    updatedAtUtcMs: NOW,
    batchId: 'batch-1',
    featureId,
    purpose: 'execute',
    labels: [],
    inputSnapshot: {},
    configSnapshot: {},
    status: 'queued',
    scopeDigest: 'a'.repeat(64),
    workKey: `work-${id}`,
    dispatchOrdinal: 1,
    maxAttemptsPerRun: 1,
    runTimeLimitMs: 60_000,
    attemptsCreated: 0,
    reason: null,
    startedAtUtcMs: null,
    endedAtUtcMs: null,
    pauseRequestedAtUtcMs: null,
  };
}

function readyDag(projectId: string, runId: string, featureId: string) {
  return {
    projectId,
    runId,
    featureId,
    reason: 'ready' as const,
    diagnostic: null,
    readyTaskIds: ['task-1'],
    tasks: [],
    handoff: null,
  };
}

function schedulerStore(runs: readonly RunRecord[]): SchedulerStore {
  return {
    listActiveRuns: () => ({
      runs: runs.map(item => ({ projectId: item.projectId, runId: item.id })),
      hasMore: false,
      nextCursor: null,
    }),
    listBatchCandidates: () => ({ candidates: [], hasMore: false, nextCursor: null }),
    recordRunReason: () => undefined,
    isFinalVerificationHandoffClaimed: () => false,
    recordFinalVerificationHandoff: () => false,
    readRun: (_projectId, runId) => runs.find(item => item.id === runId)!,
  };
}

describe('P05-10 F-004 Feature concurrency and recovery fault matrix', () => {
  it('[case:f004-default-feature-concurrency] 默认并发上限为 1，两个就绪 Feature 不重叠执行', async () => {
    const candidates = [run('run-a', 'feature-a'), run('run-b', 'feature-b')];
    let active = 0;
    let maximum = 0;
    const scheduler = createWorkScheduler({
      store: schedulerStore(candidates),
      dag: { evaluate: (projectId, runId) => {
        const candidate = candidates.find(item => item.id === runId)!;
        return readyDag(String(projectId), String(runId), candidate.featureId);
      } },
      claims: { claimTask: () => ({ replayed: false, receipt: {} }) as never },
      prepareClaim: async ({ candidate }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 'task-1' };
      },
      consumeClaim: async () => undefined,
    });

    await scheduler.scan();
    expect(maximum).toBe(1);
    await scheduler.close();
  });

  it('[case:f004-approved-concurrency-is-bounded-by-slot] 显式并发 2 允许重叠，但默认执行槽位 1 仍拒绝第二个 Feature', async () => {
    const candidates = [run('run-a', 'feature-a'), run('run-b', 'feature-b')];
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    const scheduler = createWorkScheduler({
      store: schedulerStore(candidates),
      dag: { evaluate: (projectId, runId) => {
        const candidate = candidates.find(item => item.id === runId)!;
        return readyDag(String(projectId), String(runId), candidate.featureId);
      } },
      claims: { claimTask: () => ({ replayed: false, receipt: {} }) as never },
      prepareClaim: async ({ candidate }) => {
        entered += 1;
        if (entered === 2) release();
        await bothEntered;
        return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 'task-1' };
      },
      consumeClaim: async () => undefined,
      featureConcurrency: () => 2,
    });

    const scan = scheduler.scan();
    await scan;
    expect(entered).toBe(2);
    await scheduler.close();

    const f = await openSlotFixture();
    try {
      const defaultSlots = createSqliteExecutionSlotAccess(f.box.session, { capacity: 1, nowUtcMs: f.now });
      f.box.session.transactWrite('test.f004.default-slot-a', () => defaultSlots.acquireInTransaction(acquireInput(f, 'A')));
      expect(() => f.box.session.transactWrite('test.f004.default-slot-b', () => defaultSlots.acquireInTransaction(acquireInput(f, 'B'))))
        .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'execution_slot_unavailable' }) }));
      expect(f.slotRows()).toHaveLength(1);

      const approvedSlots = createSqliteExecutionSlotAccess(f.box.session, { capacity: 2, nowUtcMs: f.now });
      const second = f.box.session.transactWrite('test.f004.approved-slot-b', () => approvedSlots.acquireInTransaction(acquireInput(f, 'B')));
      expect(second.slotIndex).toBe(1);
      expect(f.slotRows().filter(row => row.state === 'held')).toHaveLength(2);
    } finally {
      f.close();
    }
  });

  it('[case:f004-shared-resource-exclusion] 共享迁移/契约资源按统一顺序整组互斥，独立资源可以并行占用', async () => {
    const f = await openSlotFixture();
    try {
      const resources = createSqliteFeatureResourceAccess(f.box.session, { nowUtcMs: f.now });
      const ordered = resources.normalize({
        projectId: f.projectId,
        resources: [
          { kind: 'contract', key: 'contract:public-api' },
          { kind: 'migration', key: 'migration:schema' },
        ],
      });
      expect(ordered.resources.map(resource => resource.kind)).toEqual(['migration', 'contract']);

      f.box.session.transactWrite('test.f004.resource-a', () => resources.acquireInTransaction({
        resourceSet: ordered,
        owner: { ownerId: f.claimA, ownerVersion: 1 },
        leaseUntilUtcMs: f.now() + 60_000,
      }));
      const independent = resources.normalize({ projectId: f.projectId, resources: [{ kind: 'contract', key: 'contract:other-api' }] });
      f.box.session.transactWrite('test.f004.resource-independent', () => resources.acquireInTransaction({
        resourceSet: independent,
        owner: { ownerId: f.claimB, ownerVersion: 1 },
        leaseUntilUtcMs: f.now() + 60_000,
      }));
      expect(() => f.box.session.transactWrite('test.f004.resource-conflict', () => resources.acquireInTransaction({
        resourceSet: ordered,
        owner: { ownerId: f.claimB, ownerVersion: 1 },
        leaseUntilUtcMs: f.now() + 60_000,
      }))).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'resource_occupied' }) }));
      expect(f.box.session.database.prepare("SELECT state FROM feature_resource_leases WHERE state = 'held'").all()).toHaveLength(3);
    } finally {
      f.close();
    }
  });

  it('[case:f004-duplicate-dispatch-replay] 重复派发命令只重放同一认领回执，不重复创建 Attempt、槽位或预算记录', async () => {
    const f = await openClaimFixture();
    try {
      const first = f.store().claimTask(f.input());
      const before = f.snapshot();
      const replay = f.store().claimTask(f.input());
      expect(replay).toEqual({ replayed: true, receipt: first.receipt });
      expect(f.snapshot()).toEqual(before);
      expect(first.receipt.dispatch).toMatchObject({ claimVersion: 1 });
      expect(first.receipt.attempt).toMatchObject({ owner: 'owner-1', hostInstanceId: 'host-1' });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 1 });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM execution_slot_claims').get()).toEqual({ count: 1 });
    } finally {
      f.box.close();
    }
  });

  it('[case:f004-old-owner-cannot-release-current-slot] 新 owner 占用槽位后，旧 owner 的迟到释放被围栏拒绝并保留当前事实', async () => {
    const f = await openSlotFixture();
    try {
      const access = createSqliteExecutionSlotAccess(f.box.session, { capacity: 1, nowUtcMs: f.now });
      const first = f.box.session.transactWrite('test.f004.owner-a-acquire', () => access.acquireInTransaction(acquireInput(f, 'A')));
      f.box.session.transactWrite('test.f004.owner-a-release', () => access.releaseInTransaction(slotIdentity(f, first)));
      const current = f.box.session.transactWrite('test.f004.owner-b-acquire', () => access.acquireInTransaction(acquireInput(f, 'B')));

      expect(() => f.box.session.transactWrite('test.f004.late-old-owner-release', () => access.releaseInTransaction({
        ...slotIdentity(f, current), ownerId: 'owner-a', hostInstanceId: 'host-a',
      }))).toThrow(expect.objectContaining({ kind: 'ownership' }));
      expect(access.read({ projectId: f.projectId, slotId: current.id })).toMatchObject({ state: 'held', ownerId: 'owner-b', hostInstanceId: 'host-b' });
    } finally {
      f.close();
    }
  });

  it('[case:f004-expiry-restart-retains-quarantine] 租约到期和重启核对保留隔离，未确认旧执行停止前不得重新分配写入者', async () => {
    const f = await openSlotFixture();
    try {
      f.box.session.transactWrite('test.f004.expiring-acquire', () => f.access.acquireInTransaction(acquireInput(f, 'A', f.now() + 1)));
      const run = f.box.session.database.prepare('SELECT batch_id FROM runs WHERE id = ?').get(f.runA.runId) as { batch_id: string };
      f.box.session.database.prepare(`INSERT INTO runtime_start_reservations (id, created_at, updated_at, project_id, batch_id, run_id, start_key)
        VALUES ('f004-uncertain-start', ?, ?, ?, ?, ?, 'f004-uncertain-start')`).run(f.now(), f.now(), f.projectId, run.batch_id, f.runA.runId);
      f.tick(2);

      const census = createSqliteWorkStartupRecoveryStore(f.box.session, { nowUtcMs: f.now }).fence();
      expect(census.dispatchBlocked).toBe(true);
      expect(f.claimRows().find(row => row.id === f.claimA)).toMatchObject({ state: 'quarantined' });
      expect(f.slotRows().find(row => row.claim_id === f.claimA)).toMatchObject({ state: 'quarantined' });
      expect(() => f.box.session.transactWrite('test.f004.no-reassign-after-restart', () => f.access.acquireInTransaction(acquireInput(f, 'B'))))
        .toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(f.slotRows().some(row => row.state === 'held')).toBe(false);
    } finally {
      f.close();
    }
  });
});
