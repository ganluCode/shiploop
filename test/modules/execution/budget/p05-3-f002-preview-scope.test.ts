import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import { createSqlitePlanAccess } from '../../../../packages/core/src/adapters/sqlite/plan-store.ts';

const NOW = 1_900_000_200_000;

function insertFeature(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, id: string, phaseId = 'phase-1'): void {
  const db = fixture.session.database;
  const existing = db.prepare('SELECT * FROM features WHERE id = ?').get(fixture.featureId) as Record<string, unknown>;
  db.prepare(
    'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest, delivery_status) ' +
      "VALUES (?, ?, ?, 1, ?, ?, ?, 'ready', 'approved', NULL, '[]', '[]', ?, 'not_requested')",
  ).run(id, existing.created_at, fixture.projectId, existing.updated_at, phaseId, id, existing.plan_digest);
}

describe('P05-3 F-002 execution preview scope', () => {
  it('[case:preview-scope-closure-and-identities] resolves a stable dependency closure in one read view', async () => {
    const fixture = await openBudgetFixture();
    try {
      const dependency = randomUUID();
      insertFeature(fixture, dependency);
      fixture.session.database.prepare(
        'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL)',
      ).run(randomUUID(), NOW, fixture.projectId, NOW, 'phase-1', dependency, fixture.featureId);

      const plans = createSqlitePlanAccess(fixture.session, { nowUtcMs: () => NOW });
      const explicit = plans.readExecutionPreviewScopeView(fixture.projectId, {
        phaseId: null,
        featureIds: [dependency],
      });
      expect(explicit?.selection).toMatchObject({
        phaseId: null,
        requestedFeatureIds: [dependency],
        memberFeatureIds: [fixture.featureId, dependency],
      });
      expect(explicit?.members.map((member) => ({
        id: member.feature.id,
        revision: member.entity.revision,
        planDigest: member.entity.planDigest,
      }))).toEqual([
        { id: fixture.featureId, revision: expect.any(Number), planDigest: expect.any(String) },
        { id: dependency, revision: expect.any(Number), planDigest: expect.any(String) },
      ]);
      expect(explicit?.featureDependencies.map((edge) => [edge.featureId, edge.dependsOnId])).toEqual([
        [dependency, fixture.featureId],
      ]);

      const phase = plans.readExecutionPreviewScopeView(fixture.projectId, {
        phaseId: 'phase-1',
        featureIds: [],
      });
      expect(phase?.selection.memberFeatureIds).toEqual(explicit?.selection.memberFeatureIds);
      expect(phase?.members.map((member) => member.feature.id).sort()).toEqual([fixture.featureId, dependency].sort());
    } finally {
      fixture.close();
    }
  });

  it('[case:preview-scope-rejects-cross-phase-and-cycle] rejects invalid persisted scope graphs', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES ('phase-2', ?, ?, 1, ?, 'Other phase', 'open', '[]')")
        .run(NOW, fixture.projectId, NOW);
      const foreignPhaseFeature = randomUUID();
      insertFeature(fixture, foreignPhaseFeature, 'phase-2');
      const plans = createSqlitePlanAccess(fixture.session);
      expect(() => plans.readExecutionPreviewScopeView(fixture.projectId, {
        phaseId: null,
        featureIds: [fixture.featureId, foreignPhaseFeature],
      })).toThrow(/同一 Phase|cross_phase/);

      const second = randomUUID();
      insertFeature(fixture, second);
      db.prepare(
        'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL), (?, ?, ?, 1, ?, ?, ?, ?, NULL)',
      ).run(randomUUID(), NOW, fixture.projectId, NOW, 'phase-1', fixture.featureId, second,
        randomUUID(), NOW, fixture.projectId, NOW, 'phase-1', second, fixture.featureId);
      expect(() => plans.readExecutionPreviewScopeView(fixture.projectId, {
        phaseId: 'phase-1',
        featureIds: [],
      })).toThrow(/环|cycle|DAG/);
    } finally {
      fixture.close();
    }
  });

  it('[case:preview-payload-selectors] rejects missing, mixed, empty and duplicate selectors at the command boundary', async () => {
    const fixture = await openBudgetFixture();
    try {
      const invalid = [
        { budget: fixture.budget },
        { phaseId: 'phase-1', featureIds: [fixture.featureId], budget: fixture.budget },
        { phaseId: 'phase-1', featureIds: [], budget: fixture.budget },
        { featureIds: [fixture.featureId, fixture.featureId], budget: fixture.budget },
      ];
      for (const payload of invalid) {
        await expect(fixture.submit('execution.preview', payload, { scope: fixture.scope }))
          .rejects.toMatchObject({ code: 'invalid_input' });
      }

      const phaseReceipt = await fixture.submit('execution.preview', {
        phaseId: 'phase-1', budget: fixture.budget,
      }, { scope: fixture.scope });
      expect(phaseReceipt.status).toBe('completed');
    } finally {
      fixture.close();
    }
  });
});
