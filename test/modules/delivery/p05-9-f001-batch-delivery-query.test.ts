import { describe, expect, it } from 'vitest';
import { deriveBatchDeliveryItemStatus } from '../../../packages/core/src/ports/batch-delivery-query.ts';
import { createSqliteBatchDeliveryQueryStore } from '../../../packages/core/src/adapters/sqlite/batch-delivery-query-store.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';


describe('Batch delivery status projection', () => {
  it('[case:completed] only reports completed after delivery evidence succeeds', () => {
    expect(deriveBatchDeliveryItemStatus({
      featureStatus: 'completed',
      deliveryStatus: 'succeeded',
      taskStatuses: ['passed'],
      runStatus: 'succeeded',
      approvalStatus: 'approved',
      integrationBlocked: false,
      stopStatus: null,
      budgetExhausted: false,
      manualBlock: false,
    })).toBe('completed');
  });

  it('[case:budget-exhausted] preserves budget exhaustion before generic in-progress', () => {
    expect(deriveBatchDeliveryItemStatus({
      featureStatus: 'running',
      deliveryStatus: 'not_requested',
      taskStatuses: ['running'],
      runStatus: 'running',
      approvalStatus: 'none',
      integrationBlocked: false,
      stopStatus: null,
      budgetExhausted: true,
      manualBlock: false,
    })).toBe('budget_exhausted');
  });

  it('[case:cancelled] preserves confirmed cancellation', () => {
    expect(deriveBatchDeliveryItemStatus({
      featureStatus: 'partial',
      deliveryStatus: 'not_requested',
      taskStatuses: ['cancelled'],
      runStatus: 'cancelled',
      approvalStatus: 'none',
      integrationBlocked: false,
      stopStatus: 'stopped',
      budgetExhausted: false,
      manualBlock: false,
    })).toBe('cancelled');
  });

  it('[case:sqlite-consistent-read] aggregates the fixed batch without changing persisted counters', async () => {
    const fixture = await openBudgetFixture();
    try {
      const ids = await fixture.start();
      const before = fixture.snapshot();
      const store = createSqliteBatchDeliveryQueryStore(fixture.session, { nowUtcMs: () => NOW });
      const first = store.readBatchDeliveryView(fixture.projectId, ids.batchId, { afterId: null, limit: 10 });
      const second = store.readBatchDeliveryView(fixture.projectId, ids.batchId, { afterId: null, limit: 10 });
      expect(first).toBeDefined();
      expect(second).toEqual(first);
      expect(first?.batch.featureIds).toEqual([fixture.featureId]);
      expect(first?.records).toHaveLength(1);
      expect(fixture.snapshot()).toEqual(before);
    } finally {
      fixture.close();
    }
  });
});
