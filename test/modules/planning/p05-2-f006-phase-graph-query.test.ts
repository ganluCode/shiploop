import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { derivePhaseFeatureBlockers } from '../../../packages/core/src/ports/queries.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';

const NOW = 1_700_001_000_000;

async function withGraphStore(
  fn: (store: ReturnType<typeof createSqliteQueryStore>) => void,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p052-f006-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
    const db = session.database;
    db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('project-a', ?, ?, 'A', 'active', '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES ('phase-a', ?, 'project-a', ?, 'A', 'open', '[]')").run(NOW, NOW);
    const insertFeature = db.prepare("INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status) VALUES (?, ?, 'project-a', ?, 'phase-a', ?, ?, ?, '[]', '[]', 'not_requested')");
    insertFeature.run('feature-a', NOW, NOW, 'A', 'completed', 'approved');
    insertFeature.run('feature-b', NOW, NOW, 'B', 'completed', 'approved');
    insertFeature.run('feature-c', NOW, NOW, 'C', 'draft', 'draft');
    db.prepare("INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES ('edge-a', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', 'feature-a', NULL), ('edge-b', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', 'feature-b', NULL)").run(NOW, NOW, NOW, NOW);
    fn(createSqliteQueryStore(session));
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

describe('P05-2 F-006 Phase graph blocker projection', () => {
  it('[case:phase-graph-blocker-order] returns stable blockers without treating completion as integration', () => {
    const blockers = derivePhaseFeatureBlockers({
      readiness: {
        featureId: 'feature-c', dependencyCompleted: true, dependencyCompletion: 'complete',
        integrationReady: false, dependencyIntegrationReady: false, ready: false, reason: 'integration_not_ready',
      },
      taskCount: 2, planStatus: 'approved', activeBatch: false, missingCodeBaseline: true, missingDependencyIds: [],
    });
    expect(blockers).toEqual(['code_baseline_missing', 'integration_not_ready']);
  });

  it('[case:phase-graph-plan-and-scope-blockers] reports plan and active scope blockers deterministically', () => {
    expect(derivePhaseFeatureBlockers({
      readiness: {
        featureId: 'feature-c', dependencyCompleted: false, dependencyCompletion: 'failed',
        integrationReady: false, dependencyIntegrationReady: false, ready: false, reason: 'dependency_failed',
      },
      taskCount: 0, planStatus: 'draft', activeBatch: true, missingCodeBaseline: false, missingDependencyIds: [],
    })).toEqual(['no_tasks', 'plan_not_approved', 'dependency_failed', 'active_batch_scope']);
  });

  it('[case:phase-graph-sqlite-consistent-view] reads A/B/C and stable edges from one query projection', async () => {
    await withGraphStore((store) => {
      const view = store.readPhaseGraphView('project-a', 'phase-a');
      expect(view?.phase.id).toBe('phase-a');
      expect(view?.features.map((feature) => feature.id)).toEqual(['feature-a', 'feature-b', 'feature-c']);
      expect(view?.dependencies.map((edge) => [edge.featureId, edge.dependsOnId])).toEqual([
        ['feature-c', 'feature-a'], ['feature-c', 'feature-b'],
      ]);
      expect(view?.taskCounts).toEqual({});
      expect(view?.activeFeatureIds).toEqual([]);
    });
  });

  it('[case:phase-graph-query-authorized-pagination] returns dependency and integration axes with a bound cursor', async () => {
    const box = createCommandsTestFixture({ prefix: 'shiploop-p052-f006-query-' });
    const harness = await box.openTransactionalHarness();
    try {
      const db = harness.session.database;
      db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('project-q', ?, ?, 'Q', 'active', '[]')").run(NOW, NOW);
      db.prepare("INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES ('phase-q', ?, 'project-q', ?, 'Q', 'open', '[]')").run(NOW, NOW);
      const insertFeature = db.prepare("INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status) VALUES (?, ?, 'project-q', ?, 'phase-q', ?, 'completed', 'approved', '[]', '[]', 'not_requested')");
      insertFeature.run('feature-a', NOW, NOW, 'A');
      insertFeature.run('feature-b', NOW, NOW, 'B');
      insertFeature.run('feature-c', NOW, NOW, 'C');
      db.prepare("UPDATE features SET plan_status = 'draft' WHERE id = 'feature-c'").run();
      db.prepare("INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES ('edge-a', ?, 'project-q', 1, ?, 'phase-q', 'feature-c', 'feature-a', NULL), ('edge-b', ?, 'project-q', 1, ?, 'phase-q', 'feature-c', 'feature-b', NULL)").run(NOW, NOW, NOW, NOW);
    } finally {
      harness.close();
    }
    const app = await box.openApplication();
    try {
      const first = await app.queryService.getPhaseGraph(box.localOwner(), { projectId: 'project-q', phaseId: 'phase-q', limit: 2 });
      expect(first.scope).toBe('phase-graph');
      expect(first.features.map((feature) => feature.id)).toEqual(['feature-a', 'feature-b']);
      expect(first.dependencies.map((edge) => [edge.featureId, edge.dependsOnId])).toEqual([
        ['feature-c', 'feature-a'], ['feature-c', 'feature-b'],
      ]);
      expect(first.nextCursor).toMatch(/^plcur_v1_/);
      const c = (await app.queryService.getPhaseGraph(box.localOwner(), {
        projectId: 'project-q', phaseId: 'phase-q', limit: 2, cursor: first.nextCursor,
      })).readiness.find((item) => item.featureId === 'feature-c');
      expect(c).toMatchObject({
        dependencyCompleted: true, dependencyIntegrationReady: false, ready: false,
        blockers: ['no_tasks', 'plan_not_approved', 'code_baseline_missing', 'integration_not_ready'],
      });
    } finally {
      app.close();
      box.cleanup();
      expect(box.cleaned).toBe(true);
    }
  });
});
