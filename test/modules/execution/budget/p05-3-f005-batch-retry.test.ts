import { describe, expect, it } from 'vitest';
import { BUDGET, openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';

describe('P05-3 F-005 fixed Batch retry', () => {
  it('[case:fixed-batch-multi-member-retry] retries every fixed member in one parent Batch without resetting budget identity', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 },
    });
    try {
      const secondFeatureId = await addApprovedFeature(fixture);
      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [fixture.featureId, secondFeatureId],
        budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      if (preview.status !== 'ready') return;
      const started = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId],
        budget: { ...fixture.budget },
        previewDigest: preview.previewDigest,
      }, { scope: fixture.scope });
      expect(started.status).toBe('accepted');
      if (started.status !== 'accepted' || !('batchId' in started)) return;
      const batchId = started.batchId;
      fixture.reopen();
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM run_dispatch_intents WHERE batch_id = ?').get(batchId)).toEqual({ count: 2 });
      fixture.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'test_failed' WHERE batch_id = ?").run(batchId);
      const before = fixture.session.database.prepare(
        'SELECT scope_snapshot, budget_snapshot, deadline_at, runs_created, runtime_starts FROM execution_batches WHERE id = ?',
      ).get(batchId) as Record<string, unknown>;
      const originalRuns = fixture.session.database.prepare(
        'SELECT feature_id, work_key, dispatch_ordinal FROM runs WHERE batch_id = ? ORDER BY feature_id',
      ).all(batchId) as { feature_id: string; work_key: string; dispatch_ordinal: number }[];

      const retried = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId],
        retryBatchId: batchId,
      }, { scope: fixture.scope });
      expect(retried.status).toBe('completed');
      if (retried.status !== 'completed') return;

      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual({ count: 1 });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM batch_budget_revisions WHERE batch_id = ?').get(batchId)).toEqual({ count: 1 });
      expect(fixture.session.database.prepare('SELECT runs_created, runtime_starts FROM execution_batches WHERE id = ?').get(batchId)).toEqual({ runs_created: 4, runtime_starts: 0 });
      expect(fixture.session.database.prepare('SELECT feature_id, work_key, dispatch_ordinal, status FROM runs WHERE batch_id = ? ORDER BY feature_id, dispatch_ordinal').all(batchId)).toEqual([
        { feature_id: originalRuns[0]!.feature_id, work_key: originalRuns[0]!.work_key, dispatch_ordinal: 1, status: 'failed' },
        { feature_id: originalRuns[0]!.feature_id, work_key: originalRuns[0]!.work_key, dispatch_ordinal: 2, status: 'queued' },
        { feature_id: originalRuns[1]!.feature_id, work_key: originalRuns[1]!.work_key, dispatch_ordinal: 1, status: 'failed' },
        { feature_id: originalRuns[1]!.feature_id, work_key: originalRuns[1]!.work_key, dispatch_ordinal: 2, status: 'queued' },
      ]);
      expect(fixture.session.database.prepare(
        'SELECT scope_snapshot, budget_snapshot, deadline_at, runs_created, runtime_starts FROM execution_batches WHERE id = ?',
      ).get(batchId)).toEqual({ ...before, runs_created: 4 });
    } finally {
      fixture.close();
    }
  });

  it('[case:fixed-batch-retry-budget-boundary] does not reset the parent maxRuns budget when a full-member retry no longer fits', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 3, maxTotalAttempts: 4, maxRuntimeStarts: 4 },
    });
    try {
      const secondFeatureId = await addApprovedFeature(fixture);
      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [fixture.featureId, secondFeatureId], budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      if (preview.status !== 'ready') return;
      const started = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId], budget: { ...fixture.budget }, previewDigest: preview.previewDigest,
      }, { scope: fixture.scope });
      expect(started.status).toBe('accepted');
      if (started.status !== 'accepted' || !('batchId' in started)) return;
      const batchId = started.batchId;
      fixture.session.database.prepare("UPDATE runs SET status = 'failed' WHERE batch_id = ?").run(batchId);
      const retried = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId], retryBatchId: batchId,
      }, { scope: fixture.scope });
      expect(retried.status).toBe('rejected');
      expect((retried as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('budget_exhausted');
      expect(fixture.session.database.prepare('SELECT runs_created, deadline_at FROM execution_batches WHERE id = ?').get(batchId)).toEqual({
        runs_created: 2, deadline_at: fixture.budget.batch.deadlineUtcMs,
      });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE batch_id = ?').get(batchId)).toEqual({ count: 2 });
    } finally {
      fixture.close();
    }
  });

  it('[case:fixed-batch-retry-scope-reject] rejects a retry that omits a frozen member without creating a Run', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 },
    });
    try {
      const secondFeatureId = await addApprovedFeature(fixture);
      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [fixture.featureId, secondFeatureId],
        budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      if (preview.status !== 'ready') return;
      const started = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId, secondFeatureId], budget: { ...fixture.budget }, previewDigest: preview.previewDigest,
      }, { scope: fixture.scope });
      expect(started.status).toBe('accepted');
      if (started.status !== 'accepted' || !('batchId' in started)) return;
      const batchId = started.batchId;
      fixture.session.database.prepare("UPDATE runs SET status = 'failed' WHERE batch_id = ?").run(batchId);
      const before = fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE batch_id = ?').get(batchId);
      const rejected = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId], retryBatchId: batchId,
      }, { scope: fixture.scope });
      expect(rejected.status).toBe('rejected');
      expect((rejected as { error: { details?: { reason?: string } } }).error.details?.reason).toBe('retry_scope_mismatch');
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE batch_id = ?').get(batchId)).toEqual(before);
    } finally {
      fixture.close();
    }
  });
});

async function addApprovedFeature(fixture: Awaited<ReturnType<typeof openBudgetFixture>>): Promise<string> {
  const db = fixture.session.database;
  const phase = db.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
  const imported = await fixture.submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title: 'Second fixed member', description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: 'second-task', title: 'Second task', acceptance: { criteria: ['ok'] }, dependsOn: [] }],
    },
  }, { scope: fixture.scope, expectedRevision: phase.revision });
  expect(imported.status).toBe('completed');
  if (imported.status !== 'completed') throw new Error('second feature import failed');
  const featureId = (imported.result as { feature: { id: string } }).feature.id;
  const feature = db.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(featureId) as { plan_digest: string; revision: number };
  const decision = await fixture.submit('feature.plan.decide', {
    featureId, planDigest: feature.plan_digest, decision: 'approve', reason: 'fixed batch test',
  }, { scope: fixture.scope, expectedRevision: feature.revision });
  expect(decision.status).toBe('completed');
  return featureId;
}
