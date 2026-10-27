import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { budgetServices, BUDGET, openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import type { ExecutionBudgetProposal } from '../../../../packages/core/src/ports/execution-budget.ts';
import type { ExecutionPreviewResult } from '../../../../packages/core/src/ports/execution-preview.ts';

class PreviewBarrier {
  private waiters = 0;
  private released = false;
  private readonly releasePromise: Promise<void>;
  private release!: () => void;

  constructor(private readonly expected: number) {
    this.releasePromise = new Promise<void>((resolve) => { this.release = resolve; });
  }

  async wait(): Promise<void> {
    this.waiters += 1;
    if (this.waiters === this.expected) {
      this.released = true;
      this.release();
    }
    await this.releasePromise;
  }

  get reached(): boolean {
    return this.released && this.waiters === this.expected;
  }
}

type BudgetFixture = Awaited<ReturnType<typeof openBudgetFixture>>;

type ImportedFeature = { id: string; planDigest: string; revision: number };

async function addApprovedFeature(fixture: BudgetFixture, title: string): Promise<ImportedFeature> {
  const db = fixture.session.database;
  const phase = db.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
  const imported = await fixture.submit('feature.plan.import', {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title, description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: `${title}-task`, title, acceptance: { criteria: ['cross-layer batch'] }, dependsOn: [] }],
    },
  }, { scope: fixture.scope, expectedRevision: phase.revision });
  if (imported.status !== 'completed') throw new Error(`feature import failed: ${JSON.stringify(imported)}`);
  const featureId = (imported.result as { feature: { id: string } }).feature.id;
  const row = db.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(featureId) as {
    plan_digest: string;
    revision: number;
  };
  const approved = await fixture.submit('feature.plan.decide', {
    featureId,
    planDigest: row.plan_digest,
    decision: 'approve',
    reason: 'F-008 cross-layer fixture',
  }, { scope: fixture.scope, expectedRevision: row.revision });
  if (approved.status !== 'completed') throw new Error(`feature approval failed: ${JSON.stringify(approved)}`);
  return { id: featureId, planDigest: row.plan_digest, revision: row.revision + 1 };
}

function addFeatureDependency(fixture: BudgetFixture, featureId: string, dependsOnId: string, id: string = randomUUID()): void {
  fixture.session.database.prepare(
    'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) ' +
      "VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?, NULL)",
  ).run(id, 1_900_000_100_000, fixture.projectId, 1_900_000_100_000, featureId, dependsOnId);
}

function previewMembers(preview: ExecutionPreviewResult): readonly string[] {
  if (!('memberFeatureIds' in preview.scope)) throw new Error('expected P05 scope');
  return preview.scope.memberFeatureIds;
}

function startPayload(featureIds: readonly string[], budget: ExecutionBudgetProposal, previewDigest: string) {
  return { featureIds: [...featureIds], budget, previewDigest };
}

describe('P05-3 F-008 cross-layer fixed Batch', () => {
  it('[case:phase-closure-real-sqlite] Phase preview keeps the A/B/C dependency closure and exposes the dependency blocker', async () => {
    const fixture = await openBudgetFixture();
    try {
      const b = await addApprovedFeature(fixture, 'feature-b');
      const c = await addApprovedFeature(fixture, 'feature-c');
      addFeatureDependency(fixture, c.id, fixture.featureId, 'edge-c-a');
      addFeatureDependency(fixture, c.id, b.id, 'edge-c-b');

      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        phaseId: 'phase-1',
        featureIds: [],
        budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('blocked');
      expect(previewMembers(preview)).toHaveLength(3);
      expect(previewMembers(preview)).toEqual(expect.arrayContaining([fixture.featureId, b.id, c.id]));
      expect(preview.blocked).toEqual(expect.arrayContaining([
        { kind: 'feature_dependency', featureId: c.id, reason: 'dependency_pending' },
      ]));
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  it('[case:fixed-scope-phase-append] freezes A/B/C scope and budget while D waits for a new Batch', async () => {
    const budget = {
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 3, maxTotalAttempts: 3, maxRuntimeStarts: 3 },
    };
    const fixture = await openBudgetFixture(budget);
    try {
      const b = await addApprovedFeature(fixture, 'feature-b');
      const c = await addApprovedFeature(fixture, 'feature-c');
      const initialPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        phaseId: 'phase-1', featureIds: [], budget,
      });
      expect(initialPreview.status).toBe('ready');
      const initialMembers = previewMembers(initialPreview);
      expect(initialMembers).toHaveLength(3);
      const first = await fixture.submit('execution.start', startPayload(initialMembers, budget, initialPreview.previewDigest!), {
        scope: fixture.scope,
      });
      expect(first.status).toBe('accepted');
      if (first.status !== 'accepted' || !('batchId' in first)) throw new Error('first Batch was not accepted');
      const batchId = first.batchId;

      await addApprovedFeature(fixture, 'feature-d');
      const during = await fixture.services.preview.previewExecution(fixture.projectId, { phaseId: 'phase-1', featureIds: [], budget });
      expect(previewMembers(during)).toHaveLength(4);
      expect(during.status).toBe('blocked');
      expect(during.blocked).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'active_batch_in_phase', batchId }),
      ]));

      fixture.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'scripted_runtime_failure' WHERE batch_id = ?").run(batchId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'failed', reason = 'scripted_runtime_failure' WHERE id = ?").run(batchId);
      const oldBeforeNewAuthorization = fixture.session.database.prepare(
        'SELECT scope_snapshot, budget_snapshot, deadline_at, runs_created, attempts_created, runtime_starts, no_progress_runs ' +
          'FROM execution_batches WHERE id = ?',
      ).get(batchId);
      const oldMembers = fixture.session.database.prepare(
        'SELECT feature_id, member_ordinal FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal',
      ).all(batchId);

      const newBudget = { ...budget, batch: { ...budget.batch, maxRuns: 4, maxTotalAttempts: 4, maxRuntimeStarts: 4 } };
      const nextPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
        phaseId: 'phase-1', featureIds: [], budget: newBudget,
      });
      expect(nextPreview.status).toBe('ready');
      expect(previewMembers(nextPreview)).toHaveLength(4);
      const second = await fixture.submit('execution.start', startPayload(previewMembers(nextPreview), newBudget, nextPreview.previewDigest!), {
        scope: fixture.scope,
      });
      expect(second.status).toBe('accepted');
      if (second.status !== 'accepted' || !('batchId' in second)) throw new Error('new Batch was not accepted');
      expect(second.batchId).not.toBe(batchId);
      expect(fixture.session.database.prepare(
        'SELECT scope_snapshot, budget_snapshot, deadline_at, runs_created, attempts_created, runtime_starts, no_progress_runs ' +
          'FROM execution_batches WHERE id = ?',
      ).get(batchId)).toEqual(oldBeforeNewAuthorization);
      expect(fixture.session.database.prepare(
        'SELECT feature_id, member_ordinal FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal',
      ).all(batchId)).toEqual(oldMembers);
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches WHERE status IN (\'queued\', \'running\', \'pausing\', \'cancelling\', \'paused\', \'interrupted\')').get())
        .toEqual({ count: 1 });
      expect(fixture.session.database.prepare('SELECT feature_id FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal').all(second.batchId))
        .toEqual(expect.arrayContaining([{ feature_id: fixture.featureId }, { feature_id: b.id }, { feature_id: c.id }]));
    } finally {
      fixture.close();
    }
  });

  it('[case:concurrent-start-barrier-cas] two SQLite writers pass the preview barrier but commit one Batch and one dispatch intent', async () => {
    const fixture = await openBudgetFixture();
    const barrier = new PreviewBarrier(2);
    const secondSession = openSqliteStorageSession({ path: fixture.box.dbPath });
    try {
      const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
        featureIds: [fixture.featureId], budget: { ...fixture.budget },
      });
      expect(preview.status).toBe('ready');
      fixture.setPreviewBarrier(barrier);
      const secondServices = budgetServices(secondSession, {
        workspaceRoots: [fixture.box.root, fixture.box.repoDirA],
        previewBarrier: barrier,
      });

      const results = await Promise.allSettled([
        fixture.services.commands.submit(fixture.owner, fixture.envelope('execution.start', startPayload([fixture.featureId], fixture.budget, preview.previewDigest!), { scope: fixture.scope })),
        secondServices.commands.submit(fixture.owner, fixture.envelope('execution.start', startPayload([fixture.featureId], fixture.budget, preview.previewDigest!), { scope: fixture.scope })),
      ]);
      expect(barrier.reached).toBe(true);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled').map(result => result.value);
      const rejectedPromises = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const accepted = fulfilled.filter(result => result.status === 'accepted');
      const rejected = fulfilled.filter(result => result.status === 'rejected');
      if (accepted.length !== 1 || (rejected.length + rejectedPromises.length) !== 1) {
        throw new Error(`concurrent start outcomes: ${JSON.stringify(results, (_key, value) => value instanceof Error ? { name: value.name, message: value.message, code: (value as { code?: unknown }).code, details: (value as { details?: unknown }).details } : value)}`);
      }
      if (rejectedPromises.length === 1) {
        expect(rejectedPromises[0]!.reason).toMatchObject({ code: 'conflict', details: { reason: 'execution_in_progress' } });
      } else {
        expect(rejected[0]).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
      }
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual({ count: 1 });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM run_dispatch_intents').get()).toEqual({ count: 1 });
    } finally {
      secondSession.close();
      fixture.close();
    }
  });

  it('[case:preview-drift-zero-side-effects] rejects revision, approval, dependency, strategy, code and budget drift without new facts', async () => {
    const scenarios = ['feature-revision', 'plan-approval', 'dependency', 'strategy', 'code-baseline', 'budget'] as const;
    for (const scenario of scenarios) {
      const fixture = await openBudgetFixture();
      try {
        let secondFeature: ImportedFeature | undefined;
        let selectedFeatureIds = [fixture.featureId];
        if (scenario === 'dependency') {
          secondFeature = await addApprovedFeature(fixture, 'dependency-target');
          selectedFeatureIds = [fixture.featureId, secondFeature.id];
        }
        const preview = await fixture.services.preview.previewExecution(fixture.projectId, {
          featureIds: selectedFeatureIds, budget: { ...fixture.budget },
        });
        expect(preview.status).toBe('ready');
        const db = fixture.session.database;
        let requestedBudget = fixture.budget;
        if (scenario === 'feature-revision') db.prepare("UPDATE features SET revision = revision + 1, plan_digest = ? WHERE id = ?").run('f'.repeat(64), fixture.featureId);
        if (scenario === 'plan-approval') db.prepare("UPDATE features SET plan_status = 'draft' WHERE id = ?").run(fixture.featureId);
        if (scenario === 'dependency') {
          addFeatureDependency(fixture, fixture.featureId, secondFeature!.id, `edge-${randomUUID()}`);
          db.prepare("UPDATE features SET status = 'failed' WHERE id = ?").run(secondFeature!.id);
          db.prepare('UPDATE phases SET revision = revision + 1 WHERE id = ?').run('phase-1');
        }
        if (scenario === 'strategy') db.prepare(
          "UPDATE tasks SET execution_config = ?, config_source = 'task_override', config_source_key = 'drift', revision = revision + 1 WHERE feature_id = ?",
        ).run('{"runtime":"pi","provider":"anthropic","model":"drifted"}', fixture.featureId);
        if (scenario === 'code-baseline') writeFileSync(join(fixture.box.repoDirA, `f008-code-drift-${randomUUID()}.txt`), 'code baseline drift\n');
        if (scenario === 'budget') requestedBudget = {
          ...fixture.budget,
          batch: {
            ...fixture.budget.batch,
            maxRuns: fixture.budget.batch.maxRuns + 1,
            maxTotalAttempts: fixture.budget.batch.maxTotalAttempts + 1,
            maxRuntimeStarts: fixture.budget.batch.maxRuntimeStarts + 1,
          },
        };
        const beforeStart = fixture.snapshot();
        if (scenario === 'dependency') {
          expect(db.prepare('SELECT feature_id, depends_on_id FROM feature_dependencies').all()).toHaveLength(1);
          const driftedPreview = await fixture.services.preview.previewExecution(fixture.projectId, {
            featureIds: selectedFeatureIds, budget: { ...fixture.budget },
          });
          expect(driftedPreview.status, scenario).toBe('blocked');
        }
        const result = await fixture.submit('execution.start', startPayload(selectedFeatureIds, requestedBudget, preview.previewDigest!), { scope: fixture.scope });
        expect(result, scenario).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'preview_stale' } } });
        expect({ ...fixture.snapshot(), command_receipts: [] }).toEqual({ ...beforeStart, command_receipts: [] });
      } finally {
        fixture.close();
      }
    }
  });

  it('[case:retry-budget-exhaustion] keeps the parent Batch budget and facts when a retry has no remaining Run capacity', async () => {
    const budget = {
      ...BUDGET,
      batch: { ...BUDGET.batch, maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1 },
      run: { ...BUDGET.run, maxAttemptsPerRun: 1 },
    };
    const fixture = await openBudgetFixture(budget);
    try {
      const first = await fixture.start();
      fixture.session.database.prepare("UPDATE runs SET status = 'failed', reason = 'scripted_runtime_failure' WHERE id = ?").run(first.runId);
      const beforeRetry = fixture.snapshot();
      const retry = await fixture.submit('execution.start', {
        featureIds: [fixture.featureId], retryBatchId: first.batchId,
      }, { scope: fixture.scope });
      expect(retry).toMatchObject({ status: 'rejected', error: { details: { reason: 'budget_exhausted' } } });
      expect({ ...fixture.snapshot(), command_receipts: [] }).toEqual({ ...beforeRetry, command_receipts: [] });
    } finally {
      fixture.close();
    }
  });
});
