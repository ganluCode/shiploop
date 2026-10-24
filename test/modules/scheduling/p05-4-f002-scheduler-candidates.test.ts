import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteFeatureDagStore } from '../../../packages/core/src/adapters/sqlite/feature-dag-store.ts';
import { createSqliteSchedulerStore } from '../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { evaluateFeatureDag } from '../../../packages/core/src/ports/feature-dag.ts';
import { BUDGET, openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const NOW = 1_900_000_400_000;
const DIGEST = 'ab'.repeat(32);

function insertFeature(fixture: Awaited<ReturnType<typeof openBudgetFixture>>, featureId: string): void {
  const row = fixture.session.database.prepare('SELECT * FROM features WHERE id = ?').get(fixture.featureId) as Record<string, unknown>;
  fixture.session.database.prepare(
    'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) ' +
      "VALUES (?, ?, ?, 1, ?, ?, 'Candidate', 'ready', 'approved', NULL, '[]', '[]', ?)",
  ).run(featureId, row.created_at, fixture.projectId, row.updated_at, row.phase_id, row.plan_digest);
}

function runInput(projectId: string, batchId: string, featureId: string, runId: string) {
  return { projectId, batchId, featureId, runId, purpose: 'execute', inputSnapshot: {}, configSnapshot: {},
    status: 'queued', scopeDigest: DIGEST, workKey: `work-${featureId}`, dispatchOrdinal: 1,
    maxAttemptsPerRun: 2, runTimeLimitMs: 60_000, reason: null };
}

describe('P05-4 F-002 fixed Batch candidate scan', () => {
  it('[case:fixed-batch-members-stable-page] scans every active member in stable pages and excludes terminal runs', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      const secondFeatureId = randomUUID();
      const thirdFeatureId = randomUUID();
      insertFeature(fixture, secondFeatureId);
      insertFeature(fixture, thirdFeatureId);
      const existing = db.prepare('SELECT phase_id FROM features WHERE id = ?').get(fixture.featureId) as { phase_id: string };
      const access = createSqliteExecutionAccess(fixture.session, { nowUtcMs: () => NOW });
      const batchId = 'batch-f002-fixed';
      fixture.session.transactWrite('test.f002.batch', () => access.insertExecutionBatchInTransaction({
        projectId: fixture.projectId, phaseId: existing.phase_id, featureId: fixture.featureId, batchId,
        scopeSnapshot: { featureIds: [fixture.featureId, secondFeatureId, thirdFeatureId], previewDigest: DIGEST },
        configSnapshot: { approval: { planDigest: DIGEST, checkPolicyDigest: DIGEST } },
        budgetSnapshot: { schemaVersion: 1, ...BUDGET }, status: 'queued', runsCreated: 3, reason: null,
      }));
      const runA = fixture.session.transactWrite('test.f002.run-a', () => access.insertExecutionRunInTransaction(
        runInput(fixture.projectId, batchId, fixture.featureId, 'run-f002-a')),
      );
      const runB = fixture.session.transactWrite('test.f002.run-b', () => access.insertExecutionRunInTransaction(
        runInput(fixture.projectId, batchId, secondFeatureId, 'run-f002-b')),
      );
      const runC = fixture.session.transactWrite('test.f002.run-c', () => access.insertExecutionRunInTransaction(
        runInput(fixture.projectId, batchId, thirdFeatureId, 'run-f002-c')),
      );
      db.prepare("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = ?").run(NOW, runC.id);

      const store = createSqliteSchedulerStore(fixture.session, { nowUtcMs: () => NOW });
      const before = JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all());
      const first = store.listBatchCandidates({ projectId: fixture.projectId, batchId, after: null, limit: 1 });
      expect(first.candidates).toHaveLength(1);
      expect(first.candidates[0]).toMatchObject({ projectId: fixture.projectId, batchId, featureId: fixture.featureId, runId: runA.id });
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toMatchObject({ batchId, memberOrdinal: 1, featureId: fixture.featureId, runId: runA.id });
      const second = store.listBatchCandidates({ projectId: fixture.projectId, batchId, after: first.nextCursor, limit: 1 });
      expect(second.candidates).toHaveLength(1);
      expect(second.candidates[0]).toMatchObject({ projectId: fixture.projectId, batchId, featureId: secondFeatureId, runId: runB.id });
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      expect(store.listBatchCandidates({ projectId: fixture.projectId, batchId, after: null, limit: 10 }).candidates)
        .toEqual([...first.candidates, ...second.candidates]);
      expect(JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all())).toBe(before);
    } finally { fixture.close(); }
  });
  it('[case:feature-dag-dependency-and-code-gate] uses the persisted Feature DAG and keeps a dependent Feature blocked without integration evidence', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      const featureA = randomUUID();
      const featureB = randomUUID();
      const featureC = randomUUID();
      insertFeature(fixture, featureA);
      insertFeature(fixture, featureB);
      insertFeature(fixture, featureC);
      db.prepare("UPDATE features SET status = 'completed' WHERE id IN (?, ?)").run(featureA, featureB);
      const phaseId = (db.prepare('SELECT phase_id FROM features WHERE id = ?').get(fixture.featureId) as { phase_id: string }).phase_id;
      db.prepare(
        'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL)',
      ).run('edge-c-to-a', NOW, fixture.projectId, NOW, phaseId, featureC, featureA);
      db.prepare(
        'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL)',
      ).run('edge-c-to-b', NOW, fixture.projectId, NOW, phaseId, featureC, featureB);
      const graph = evaluateFeatureDag(createSqliteFeatureDagStore(fixture.session).readFeatureDag(fixture.projectId, phaseId));
      expect(graph.readyFeatureIds).toHaveLength(3);
      expect(graph.readyFeatureIds).toEqual(expect.arrayContaining([fixture.featureId, featureA, featureB]));
      expect(graph.readiness.find(item => item.featureId === featureC)).toMatchObject({
        dependencyCompleted: true,
        dependencyIntegrationReady: false,
        ready: false,
        reason: 'integration_not_ready',
      });
    } finally { fixture.close(); }
  });
});
