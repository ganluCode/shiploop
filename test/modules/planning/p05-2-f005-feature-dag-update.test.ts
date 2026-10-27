import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_700_001_000_000;

function seed(session: ReturnType<typeof openSqliteStorageSession>): void {
  const db = session.database;
  db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name, status, labels) VALUES ('project-a', ?, ?, 'A', 'active', '[]')").run(NOW, NOW);
  db.prepare("INSERT INTO phases (id, created_at, project_id, updated_at, title, status, labels) VALUES ('phase-a', ?, 'project-a', ?, 'A', 'open', '[]')").run(NOW, NOW);
  const insert = db.prepare("INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status) VALUES (?, ?, 'project-a', ?, 'phase-a', ?, 'draft', 'draft', '[]', '[]', 'not_requested')");
  for (const id of ['feature-a', 'feature-b', 'feature-c']) insert.run(id, NOW, NOW, id);
}

async function withSession(fn: (session: ReturnType<typeof openSqliteStorageSession>) => void): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p052-f005-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  try {
    await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
    seed(session);
    fn(session);
  } finally {
    session.close();
    sandbox.cleanup();
  }
}

describe('P05-2 F-005 atomic Feature DAG update', () => {
  it('[case:dag-update-atomic-multi-edge] commits A/B -> C and increments Phase once', async () => {
    await withSession((session) => {
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW });
      atomic.transact('test.dag.update', (tx) => {
        const result = tx.updateFeatureDag({ projectId: 'project-a', phaseId: 'phase-a', expectedRevision: 1, edges: [
          { featureId: 'feature-c', dependsOnId: 'feature-b' },
          { featureId: 'feature-c', dependsOnId: 'feature-a' },
        ] });
        expect(result.phase.revision).toBe(2);
        expect(result.edges.map((edge) => [edge.featureId, edge.dependsOnId])).toEqual([
          ['feature-c', 'feature-a'], ['feature-c', 'feature-b'],
        ]);
        tx.appendPlanEvent({ projectId: 'project-a', eventType: 'feature.dag.updated', aggregateType: 'phase', aggregateId: 'phase-a', aggregateRevision: 2, payload: { dagUpdated: true } });
      });
      expect(session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-a')).toEqual({ revision: 2 });
      expect(session.database.prepare('SELECT feature_id, depends_on_id FROM feature_dependencies ORDER BY feature_id, depends_on_id').all()).toEqual([
        { feature_id: 'feature-c', depends_on_id: 'feature-a' },
        { feature_id: 'feature-c', depends_on_id: 'feature-b' },
      ]);
      expect(session.database.prepare("SELECT event_type, aggregate_revision, payload FROM state_events WHERE event_type = 'feature.dag.updated'").get()).toMatchObject({ aggregate_revision: 2, payload: '{"dagUpdated":true}' });
    });
  });

  it('[case:dag-update-cycle-rollback] rejects a cycle without changing Phase or edges', async () => {
    await withSession((session) => {
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW });
      expect(() => atomic.transact('test.dag.update', (tx) => tx.updateFeatureDag({
        projectId: 'project-a', phaseId: 'phase-a', expectedRevision: 1,
        edges: [
          { featureId: 'feature-a', dependsOnId: 'feature-b' },
          { featureId: 'feature-b', dependsOnId: 'feature-a' },
        ],
      }))).toThrow();
      expect(session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-a')).toEqual({ revision: 1 });
      expect(session.database.prepare('SELECT COUNT(*) AS count FROM feature_dependencies').get()).toEqual({ count: 0 });
    });
  });

  it('[case:dag-update-active-batch-protection] rejects changing prerequisites of an active scoped Feature', async () => {
    await withSession((session) => {
      session.database.prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ).run('batch-a', NOW, 'project-a', NOW, 'phase-a', 'feature-c',
        JSON.stringify({ schemaVersion: 1, featureIds: ['feature-c'] }), JSON.stringify({ schemaVersion: 1 }), 'queued', JSON.stringify({ schemaVersion: 1 }), NOW + 3_600_000);
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW });
      expect(() => atomic.transact('test.dag.update', (tx) => tx.updateFeatureDag({
        projectId: 'project-a', phaseId: 'phase-a', expectedRevision: 1,
        edges: [{ featureId: 'feature-c', dependsOnId: 'feature-a' }],
      }))).toThrow(/活动 Batch|active_batch_scope/);
      expect(session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-a')).toEqual({ revision: 1 });
    });
  });
  it('[case:dag-update-invalid-baseline] rejects a changed baseline for an existing edge before writing', async () => {
    await withSession((session) => {
      session.database.prepare("INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES ('edge-1', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', 'feature-a', 'baseline-a')").run(NOW, NOW);
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => NOW });
      expect(() => atomic.transact('test.dag.update', (tx) => tx.updateFeatureDag({
        projectId: 'project-a', phaseId: 'phase-a', expectedRevision: 1,
        edges: [{ featureId: 'feature-c', dependsOnId: 'feature-a', codeBaselineRef: 'baseline-b' }],
      }))).toThrow(/baseline/i);
      expect(session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-a')).toEqual({ revision: 1 });
      expect(session.database.prepare('SELECT code_baseline_ref FROM feature_dependencies WHERE id = ?').get('edge-1')).toEqual({ code_baseline_ref: 'baseline-a' });
    });
  });
});
