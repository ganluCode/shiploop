import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteIntegrationPlanQueryStore } from '../../../packages/core/src/adapters/sqlite/integration-plan-query-store.ts';
import { createSqliteIntegrationPlanStore } from '../../../packages/core/src/adapters/sqlite/integration-plan-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { IntegrationPlanInput } from '../../../packages/core/src/ports/integration-plan.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_700_000_600_000;
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function seedScope(session: ReturnType<typeof openSqliteStorageSession>): void {
  session.transactWrite('f005-query.seed', (db) => {
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) VALUES ('phase-a', ?, 'project-a', 1, ?, 'Phase A', 'open', NULL, '[]')").run(NOW, NOW);
    const feature = db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest, delivery_status) VALUES (?, ?, 'project-a', 1, ?, 'phase-a', ?, 'completed', 'approved', NULL, '[]', '[]', NULL, 'succeeded')");
    for (const id of ['feature-a', 'feature-b', 'feature-c']) feature.run(id, NOW, NOW, id);
    db.prepare("INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) VALUES ('batch-a', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', '{\"featureIds\":[\"feature-c\"]}', '{}', 'succeeded', 1, '{}', 0, 0, 0, 0, ?)").run(NOW, NOW, NOW + 1000);
  });
}

function input(): IntegrationPlanInput {
  return {
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: 'feature-c', targetBaseline: 'c'.repeat(40),
    predecessors: [
      { projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true, delivery: { commitSha: SHA, evidenceId: 'delivery-a', evidenceDigest: DIGEST }, coveredInputIds: ['input-a'], ancestorVerified: true },
      { projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependencyPassed: true, delivery: { commitSha: 'd'.repeat(40), evidenceId: 'delivery-b', evidenceDigest: 'e'.repeat(64) }, coveredInputIds: ['input-b'], ancestorVerified: true },
    ],
    approvedInputs: [{ inputId: 'input-a', digest: '1'.repeat(64) }, { inputId: 'input-b', digest: '2'.repeat(64) }],
    mergeOrder: ['feature-a', 'feature-b'], verificationScope: ['typecheck', 'integration-tests'], strategySummary: { conflictPolicy: 'deterministic-only', maxAttempts: 1 }, integrationResult: null,
  };
}

describe('P05-6 F-005 integration plan SQLite query', () => {
  it('[case:integration-query-sqlite-reopen] reads only frozen facts consistently after SQLite reopen', async () => {
    const sandbox = createTempSandbox('shiploop-f005-query-');
    const path = join(sandbox.path, 'state.db');
    try {
      const first = openSqliteStorageSession({ path });
      await migrateSqliteStorage(first, { nowUtcMs: () => NOW });
      seedScope(first);
      const atomic = createSqliteAtomicCommandStore(first, { nowUtcMs: () => NOW + 1 });
      const created = atomic.transact('integration.create', tx => tx.createIntegrationPlan(input()));
      const frozen = atomic.transact('integration.freeze', tx => tx.freezeIntegrationPlan({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: created.revision }));
      const firstView = createSqliteIntegrationPlanQueryStore(createSqliteIntegrationPlanStore(first)).readIntegrationPlanView('project-a', frozen.integrationId);
      expect(firstView?.plan.targetBaseline).toBe('c'.repeat(40));
      expect(firstView?.predecessors.map(item => item.commitSha)).toEqual([SHA, 'd'.repeat(40)]);
      expect(firstView?.plan.mergeOrder).toEqual(['feature-a', 'feature-b']);
      first.close();

      const reopened = openSqliteStorageSession({ path });
      try {
        const secondView = createSqliteIntegrationPlanQueryStore(createSqliteIntegrationPlanStore(reopened)).readIntegrationPlanView('project-a', frozen.integrationId);
        expect(secondView).toEqual(firstView);
        expect(createSqliteIntegrationPlanQueryStore(createSqliteIntegrationPlanStore(reopened)).readIntegrationPlanView('project-b', frozen.integrationId)).toBeUndefined();
      } finally {
        reopened.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});
