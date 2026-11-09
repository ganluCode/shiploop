import { describe, expect, it } from 'vitest';
import type { IntegrationPlanGenerationService } from '../../../packages/core/src/application/integration-plan-generation.ts';
import {
  createIntegrationPlanScheduler,
  type IntegrationPlanDispatchIntent,
  type IntegrationPlanDispatchReservation,
  type IntegrationPlanScheduleCandidatePage,
} from '../../../packages/core/src/application/integration-plan-scheduler.ts';
import { createIntegrationPlan } from '../../../packages/core/src/ports/integration-plan.ts';
import type { PersistedIntegrationPlan } from '../../../packages/core/src/ports/integration-plan-store.ts';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function plan(overrides: Record<string, unknown> = {}): PersistedIntegrationPlan {
  const value = createIntegrationPlan({
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: 'feature-c',
    targetBaseline: SHA,
    predecessors: [{ projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true,
      delivery: { commitSha: 'c'.repeat(40), evidenceId: 'delivery-a', evidenceDigest: DIGEST },
      coveredInputIds: ['input-a'], ancestorVerified: true }],
    approvedInputs: [{ inputId: 'input-a', digest: DIGEST }], mergeOrder: ['feature-a'],
    verificationScope: ['typecheck'], strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
    ...overrides,
  });
  return { ...value, revision: 2, createdAtUtcMs: 10, updatedAtUtcMs: 10, frozenAtUtcMs: 11 };
}

function harness(current: PersistedIntegrationPlan = plan()) {
  const generated: PersistedIntegrationPlan[] = [];
  const reservations: IntegrationPlanDispatchIntent[] = [];
  const generation: IntegrationPlanGenerationService = {
    generate: () => ({ plan: current, created: false, frozen: current.frozenAtUtcMs !== null, reused: true }),
    status: () => ({ plan: current, status: current.status, blockReasons: current.blockReasons, staleReasons: current.staleReasons }),
  };
  const dispatch = {
    reserve(intent: IntegrationPlanDispatchIntent): IntegrationPlanDispatchReservation {
      reservations.push(intent);
      return { outcome: 'created', operationId: intent.integrationId };
    },
  };
  const scheduler = createIntegrationPlanScheduler({ generation, dispatch });
  return { scheduler, generation, reservations, generated };
}

function page(...batchIds: string[]): IntegrationPlanScheduleCandidatePage {
  return { candidates: batchIds.map(batchId => ({ projectId: 'project-a', batchId })), hasMore: false, nextCursor: null };
}

describe('P05-6 F-006 integration plan scheduler', () => {
  it('[case:integration-scheduler-finalized-event-idempotent] 成功交付事件只重评估一次并复用唯一集成身份', async () => {
    const h = harness();
    const event = { projectId: 'project-a', featureId: 'feature-a', batchId: 'batch-a', outcome: 'completed' as const, deliveryStatus: 'succeeded' as const };
    const [first, second] = await Promise.all([
      h.scheduler.onFeatureFinalized(event),
      h.scheduler.onFeatureFinalized({ ...event, eventSequence: 99 }),
    ]);
    expect(first.state).toBe('dispatchable');
    expect(second.state).toBe('dispatchable');
    expect(h.reservations).toHaveLength(1);
    expect(h.reservations[0]).toMatchObject({ integrationId: first.integrationId, inputDigest: first.inputDigest, planRevision: 2 });
  });

  it('[case:integration-scheduler-ignores-blocked-event] 非成功交付事件只留下可查询阻塞结果，不创建集成意图', async () => {
    const h = harness();
    const result = await h.scheduler.onFeatureFinalized({ projectId: 'project-a', featureId: 'feature-a', batchId: 'batch-a', outcome: 'partial', deliveryStatus: 'failed' });
    expect(result.state).toBe('dependency_blocked');
    expect(result.reason).toBe('feature_delivery_not_succeeded');
    expect(h.reservations).toHaveLength(0);
  });

  it('[case:integration-scheduler-bounded-compensation-scan] 丢失唤醒由稳定候选页补偿，扫描保持有界且重复候选不重复派发', async () => {
    const h = harness();
    let reads = 0;
    const result = await h.scheduler.scan({
      limit: 1,
      candidates: { list: ({ after, limit }) => {
        reads += 1;
        expect(limit).toBe(1);
        if (after === null) return { ...page('batch-a'), hasMore: true, nextCursor: { batchId: 'batch-a' } };
        return { candidates: [], hasMore: true, nextCursor: { batchId: 'batch-a' } };
      } },
    });
    expect(result.bounded).toBe(true);
    expect(result.pages).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(reads).toBe(1);
    expect(h.reservations).toHaveLength(1);

    const replay = await h.scheduler.scan({ limit: 1, candidates: { list: () => page('batch-a') } });
    expect(replay.results[0]?.state).toBe('dispatchable');
    expect(h.reservations).toHaveLength(1);
  });

  it('[case:integration-scheduler-dispatch-blocked-state] 计划状态和资源忙状态保持可区分且不调用模型', async () => {
    const blocked = harness({ ...plan(), status: 'blocked', blockReasons: ['dependency_not_passed'], staleReasons: [] });
    const blockedResult = await blocked.scheduler.reevaluate({ projectId: 'project-a', batchId: 'batch-a', trigger: 'scan' });
    expect(blockedResult.state).toBe('dependency_blocked');
    expect(blocked.reservations).toHaveLength(0);

    const busy = harness();
    const busyScheduler = createIntegrationPlanScheduler({
      generation: busy.generation,
      dispatch: { reserve: () => ({ outcome: 'resource_busy', operationId: null, reason: 'execution_slot_unavailable' }) },
    });
    const busyResult = await busyScheduler.reevaluate({ projectId: 'project-a', batchId: 'batch-a', trigger: 'event' });
    expect(busyResult.state).toBe('resource_busy');
    expect(busyResult.reason).toBe('execution_slot_unavailable');
  });
});
