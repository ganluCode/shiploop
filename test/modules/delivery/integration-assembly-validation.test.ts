import { expect, it, vi } from 'vitest';
import { validateIntegrationPlanFacts } from '../../../packages/core/src/adapters/integration-assembly.ts';
import { createFeatureDeliveryCommandHandler } from '../../../packages/core/src/application/feature-delivery-commands.ts';
import type { FeatureDeliveryDependencies } from '../../../packages/core/src/application/feature-delivery-commands.ts';

const facts = () => ({
  batches: { readApprovedBatch: vi.fn(() => undefined) },
  predecessors: { readEvidence: vi.fn(() => undefined) },
  scheduler: {
    candidates: { list: vi.fn(() => ({ candidates: [], hasMore: false, nextCursor: null })) },
    dispatch: { reserve: vi.fn(() => ({ outcome: 'blocked' as const, operationId: null })) },
  },
});

it('[case:assembly-rejects-invalid-facts] rejects missing or incorrectly typed fact readers before exposing generation', () => {
  for (const value of [undefined, null, {}, Promise.resolve(facts()),
    { ...facts(), batches: null }, { ...facts(), batches: {} },
    { ...facts(), batches: { readApprovedBatch: true } },
    { ...facts(), predecessors: null }, { ...facts(), predecessors: {} },
    { ...facts(), predecessors: { readEvidence: 'private credential text' } }]) {
    expect(() => validateIntegrationPlanFacts(value)).toThrow(expect.objectContaining({
      kind: 'validation', details: { field: 'integrationPlanFactory', reason: 'integration_fact_adapters_required' },
    }));
    try { validateIntegrationPlanFacts(value); } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private credential text');
    }
  }
});

it('[case:assembly-rejects-invalid-scheduler] rejects a partial scheduler instead of publishing an unusable application', () => {
  for (const scheduler of [null, {}, { candidates: {}, dispatch: { reserve() {} } },
    { candidates: { list() {} }, dispatch: null },
    { candidates: { list: 'private credential text' }, dispatch: { reserve() {} } },
    { candidates: { list() {} }, dispatch: { reserve: 1 } }]) {
    expect(() => validateIntegrationPlanFacts({ ...facts(), scheduler })).toThrow(expect.objectContaining({
      kind: 'validation', details: { field: 'integrationPlanFactory', reason: 'integration_scheduler_adapters_required' },
    }));
  }
});

it('[case:assembly-validation-no-io] validates complete and event-only facts without executing any reader or dispatch', () => {
  const value = facts();
  validateIntegrationPlanFacts(value);
  validateIntegrationPlanFacts({ batches: value.batches, predecessors: value.predecessors });
  for (const call of [value.batches.readApprovedBatch, value.predecessors.readEvidence,
    value.scheduler.candidates.list, value.scheduler.dispatch.reserve]) expect(call).not.toHaveBeenCalled();
});

it('[case:assembly-invalid-integration-driver] rejects an explicitly malformed integration driver at command service construction', () => {
  const deps: FeatureDeliveryDependencies = {
    verify: vi.fn(), readIntent: vi.fn(), commit: { commit: vi.fn() }, reconciliation: { reconcile: vi.fn() },
  };
  for (const integrationStart of [null, {}, { start: true }]) {
    expect(() => createFeatureDeliveryCommandHandler({ atomicStore: {} as never,
      dependencies: { ...deps, integrationStart } as unknown as FeatureDeliveryDependencies, nowUtcMs: () => 1,
    })).toThrow(/integration start/i);
  }
  expect(deps.verify).not.toHaveBeenCalled();
  expect(deps.commit.commit).not.toHaveBeenCalled();
});
