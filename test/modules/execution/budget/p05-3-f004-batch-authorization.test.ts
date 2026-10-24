import { describe, expect, it } from 'vitest';
import { openBudgetFixture, BUDGET } from '../../../helpers/p03-3/budget-fixture.ts';

describe('P05-3 F-004 multi-member execution authorization', () => {
  it('[case:multi-member-atomic-authorization] creates one fixed Batch, one Run per member, budget evidence, events and intents', async () => {
    const fixture = await openBudgetFixture({ ...BUDGET, batch: { ...BUDGET.batch, maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2 } });
    try {
      const db = fixture.session.database;
      const phase = db.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
      const imported = await fixture.submit('feature.plan.import', {
        phaseId: 'phase-1',
        plan: { schemaVersion: 1, feature: { title: 'second', description: null, labels: [], sourceRefs: [] }, tasks: [{ id: 'second-task', title: 'second task', acceptance: { criteria: ['ok'] }, dependsOn: [] }] },
      }, { scope: fixture.scope, expectedRevision: phase.revision });
      expect(imported.status).toBe('completed');
      const secondFeatureId = (imported as { result: { feature: { id: string } } }).result.feature.id;
      const second = db.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(secondFeatureId) as { plan_digest: string; revision: number };
      const approval = await fixture.submit('feature.plan.decide', {
        featureId: secondFeatureId, planDigest: second.plan_digest, decision: 'approve', reason: 'test authorization',
      }, { scope: fixture.scope, expectedRevision: second.revision });
      expect(approval.status).toBe('completed');

      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [fixture.featureId, secondFeatureId], budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      expect(preview.scope).toMatchObject({ memberFeatureIds: expect.arrayContaining([fixture.featureId, secondFeatureId]) });
      const started = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId], budget: { ...fixture.budget }, previewDigest: preview.previewDigest,
      }, { scope: fixture.scope });
      if (started.status !== 'accepted') throw new Error(`multi start rejected: ${JSON.stringify(started)}`);
      const batchId = (started as { batchId: string }).batchId;
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_batches WHERE id = ?').get(batchId)).toEqual({ count: 1 });
      expect(db.prepare('SELECT runs_created FROM execution_batches WHERE id = ?').get(batchId)).toEqual({ runs_created: 2 });
      expect(db.prepare('SELECT feature_id, status, dispatch_ordinal FROM runs WHERE batch_id = ? ORDER BY feature_id').all(batchId)).toHaveLength(2);
      expect(db.prepare('SELECT COUNT(*) AS count FROM batch_budget_revisions WHERE batch_id = ?').get(batchId)).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM run_dispatch_intents WHERE batch_id = ?').get(batchId)).toEqual({ count: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM state_events WHERE event_type = ?').get('execution.run.dispatched')).toEqual({ count: 2 });
    } finally {
      fixture.close();
    }
  });

  it('[case:multi-member-active-batch-race] rejects a competing authorization without creating a second Batch', async () => {
    const fixture = await openBudgetFixture();
    try {
      const preview = await fixture.services.preview.previewExecution(fixture.projectId, { featureIds: [fixture.featureId], budget: { ...fixture.budget } });
      expect(preview.status).toBe('ready');
      const first = await fixture.submit('execution.start', { featureIds: [fixture.featureId], budget: { ...fixture.budget }, previewDigest: preview.previewDigest }, { scope: fixture.scope });
      expect(first.status).toBe('accepted');
      const second = await fixture.submit('execution.start', { featureIds: [fixture.featureId], budget: { ...fixture.budget }, previewDigest: preview.previewDigest }, { scope: fixture.scope });
      expect(second.status).toBe('rejected');
      expect((second as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('preview_stale');
      expect(dbCount(fixture, 'execution_batches')).toBe(1);
      expect(dbCount(fixture, 'runs')).toBe(1);
    } finally {
      fixture.close();
    }
  });
});

function dbCount(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, table: string): number {
  return (fixture.session.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
