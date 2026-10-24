import { describe, expect, it, vi } from 'vitest';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
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

function store(runs: readonly RunRecord[], recordRunReason = vi.fn()): SchedulerStore {
  return {
    listActiveRuns: () => ({
      runs: runs.map(item => ({ projectId: item.projectId, runId: item.id })),
      hasMore: false,
      nextCursor: null,
    }),
    listBatchCandidates: () => ({ candidates: [], hasMore: false, nextCursor: null }),
    recordRunReason,
    isFinalVerificationHandoffClaimed: () => false,
    recordFinalVerificationHandoff: () => false,
    readRun: (_projectId, runId) => runs.find(item => item.id === runId)!,
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

function claimResult() {
  return { replayed: false, receipt: {} } as never;
}

describe('P05-4 F-004 WorkScheduler Feature admission', () => {
  it('[case:approved-feature-overlap] 批准并发 2 时两个 Feature 在屏障处重叠执行', async () => {
    const candidates = [run('run-a', 'feature-a'), run('run-b', 'feature-b')];
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    const prepareClaim = vi.fn(async ({ candidate }: { candidate: { run: RunRecord } }) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 'task-1' };
    });
    const scheduler = createWorkScheduler({
      store: store(candidates),
      dag: { evaluate: (projectId, runId) => {
        const item = candidates.find(candidate => candidate.id === runId)!;
        return readyDag(String(projectId), String(runId), item.featureId);
      } },
      claims: { claimTask: () => claimResult() },
      prepareClaim,
      consumeClaim: async () => undefined,
      featureConcurrency: () => 2,
    });

    const result = await scheduler.scan();
    expect(result.runs).toHaveLength(2);
    expect(prepareClaim).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it('[case:approved-feature-serial] 批准并发 1 时 Feature 仍串行派发', async () => {
    const candidates = [run('run-a', 'feature-a'), run('run-b', 'feature-b')];
    let active = 0;
    let maximum = 0;
    const scheduler = createWorkScheduler({
      store: store(candidates),
      dag: { evaluate: (projectId, runId) => {
        const item = candidates.find(candidate => candidate.id === runId)!;
        return readyDag(String(projectId), String(runId), item.featureId);
      } },
      claims: { claimTask: () => claimResult() },
      prepareClaim: async ({ candidate }: { candidate: { run: RunRecord } }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 'task-1' };
      },
      consumeClaim: async () => undefined,
      featureConcurrency: () => 1,
    });

    await scheduler.scan();
    expect(maximum).toBe(1);
    await scheduler.close();
  });

  it('[case:dependency-blocks-before-claim] 依赖未就绪时不准备 Claim 并持久化阻塞原因', async () => {
    const candidate = run('run-c', 'feature-c');
    const recordRunReason = vi.fn();
    const prepareClaim = vi.fn(async () => ({ projectId: candidate.projectId, runId: candidate.id, taskId: 'task-1' }));
    const scheduler = createWorkScheduler({
      store: {
        ...store([candidate], recordRunReason),
        readBatch: () => ({ phaseId: 'phase-1', configSnapshot: { concurrency: { maxConcurrentFeatures: 2 } } } as never),
      },
      featureDag: {
        evaluate: () => ({
          readiness: [{ featureId: 'feature-c', dependencyCompleted: false, dependencyCompletion: 'pending',
            integrationReady: false, dependencyIntegrationReady: false, ready: false, reason: 'dependency_pending' }],
          readyFeatureIds: [],
        } as never),
      },
      dag: { evaluate: () => readyDag(candidate.projectId, candidate.id, candidate.featureId) },
      claims: { claimTask: () => claimResult() },
      prepareClaim,
      consumeClaim: async () => undefined,
      featureConcurrency: () => 2,
    });

    const result = await scheduler.scan();
    expect(result.runs[0]).toMatchObject({ reason: 'dependency_pending', claimed: false });
    expect(prepareClaim).not.toHaveBeenCalled();
    expect(recordRunReason).toHaveBeenCalledWith(candidate.projectId, candidate.id, 'dependency_pending');
    await scheduler.close();
  });

  it('[case:scheduler-exception-retains-scene] 批次快照异常只记录有界原因，不进入认领', async () => {
    const candidate = run('run-broken', 'feature-broken');
    const recordRunReason = vi.fn();
    const scheduler = createWorkScheduler({
      store: {
        ...store([candidate], recordRunReason),
        readBatch: () => { throw new Error('corrupt batch'); },
      },
      dag: { evaluate: () => { throw new Error('DAG must not run after scheduler admission failure'); } },
      claims: { claimTask: () => claimResult() },
      prepareClaim: async () => ({ projectId: candidate.projectId, runId: candidate.id, taskId: 'task-1' }),
      consumeClaim: async () => undefined,
    });

    const result = await scheduler.scan();
    expect(result.runs[0]).toMatchObject({ reason: 'scheduler_exception', claimed: false });
    expect(recordRunReason).toHaveBeenCalledWith(candidate.projectId, candidate.id, 'scheduler_exception');
    await scheduler.close();
  });
});
