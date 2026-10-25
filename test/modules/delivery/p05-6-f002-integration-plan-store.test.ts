import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteIntegrationPlanStore } from '../../../packages/core/src/adapters/sqlite/integration-plan-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { IntegrationPlanInput } from '../../../packages/core/src/ports/integration-plan.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_700_000_500_000;
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const sandbox = createTempSandbox('shiploop-f002-');
  try { return await fn(sandbox.path); } finally { sandbox.cleanup(); }
}

function planInput(): IntegrationPlanInput {
  return {
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: 'feature-c',
    targetBaseline: 'c'.repeat(40),
    predecessors: [
      {
        projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-a', dependencyPassed: true,
        delivery: { commitSha: SHA, evidenceId: 'delivery-a', evidenceDigest: DIGEST },
        coveredInputIds: ['input-a'], ancestorVerified: true,
      },
      {
        projectId: 'project-a', phaseId: 'phase-a', featureId: 'feature-b', dependencyPassed: true,
        delivery: { commitSha: 'd'.repeat(40), evidenceId: 'delivery-b', evidenceDigest: 'e'.repeat(64) },
        coveredInputIds: ['input-b'], ancestorVerified: true,
      },
    ],
    approvedInputs: [{ inputId: 'input-a', digest: '1'.repeat(64) }, { inputId: 'input-b', digest: '2'.repeat(64) }],
    mergeOrder: ['feature-a', 'feature-b'], verificationScope: ['typecheck', 'integration-tests'],
    strategySummary: { conflictPolicy: 'deterministic-only', maxAttempts: 1 }, integrationResult: null,
  };
}

function seedScope(session: ReturnType<typeof openSqliteStorageSession>): void {
  session.transactWrite('f002.seed', (db) => {
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-b', ?, 1, ?, 'B', 'active', '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) VALUES ('phase-a', ?, 'project-a', 1, ?, 'Phase A', 'open', NULL, '[]')").run(NOW, NOW);
    db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) VALUES ('phase-b', ?, 'project-b', 1, ?, 'Phase B', 'open', NULL, '[]')").run(NOW, NOW);
    const insertFeature = db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest, delivery_status) VALUES (?, ?, ?, 1, ?, ?, ?, 'completed', 'approved', NULL, '[]', '[]', NULL, 'succeeded')");
    for (const id of ['feature-a', 'feature-b', 'feature-c']) insertFeature.run(id, NOW, 'project-a', NOW, 'phase-a', id);
    insertFeature.run('feature-other', NOW, 'project-b', NOW, 'phase-b', 'other');
    db.prepare("INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) VALUES ('batch-a', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', '{\"featureIds\":[\"feature-c\"]}', '{}', 'succeeded', 1, '{}', 0, 0, 0, 0, ?)").run(NOW, NOW, NOW + 1000);
  });
}

async function openMigrated(path: string) {
  const session = openSqliteStorageSession({ path });
  await migrateSqliteStorage(session, { nowUtcMs: () => NOW });
  seedScope(session);
  return session;
}

describe('P05-6 F-002 integration plan SQLite storage', () => {
  it('[case:integration-persistence-reopen] persists the frozen plan and every predecessor snapshot across reopen', async () => {
    await withSandbox(async (root) => {
      const path = join(root, 'state.db');
      const first = await openMigrated(path);
      const atomic = createSqliteAtomicCommandStore(first, { nowUtcMs: () => NOW + 1 });
      const created = atomic.transact('integration.create', (tx) => tx.createIntegrationPlan(planInput()));
      expect(created.revision).toBe(1);
      expect(created.frozenAtUtcMs).toBeNull();
      const frozen = atomic.transact('integration.freeze', (tx) => tx.freezeIntegrationPlan({
        projectId: 'project-a', integrationId: created.integrationId, expectedRevision: created.revision,
      }));
      expect(frozen.revision).toBe(2);
      expect(frozen.frozenAtUtcMs).toBe(NOW + 1);
      expect(first.database.prepare('SELECT COUNT(*) AS count FROM integration_predecessor_snapshots WHERE plan_id = ?').get(created.integrationId)).toEqual({ count: 2 });
      first.close();

      const reopened = openSqliteStorageSession({ path });
      try {
        const plan = createSqliteIntegrationPlanStore(reopened).readIntegrationPlan('project-a', created.integrationId);
        expect(plan).toMatchObject({ integrationId: created.integrationId, inputDigest: created.inputDigest, revision: 2, status: 'dependency_passed' });
        expect(plan?.mergeOrder).toEqual(['feature-a', 'feature-b']);
        expect(plan?.predecessors.map((item) => item.delivery?.commitSha)).toEqual([SHA, 'd'.repeat(40)]);
      } finally { reopened.close(); }
    });
  });

  it('[case:integration-ownership-and-rollback] rejects missing or cross-project predecessors without half a plan', async () => {
    await withSandbox(async (root) => {
      const session = await openMigrated(join(root, 'state.db'));
      try {
        const atomic = createSqliteAtomicCommandStore(session);
        expect(() => atomic.transact('integration.cross-project', (tx) => tx.createIntegrationPlan({
          ...planInput(), predecessors: [{ ...planInput().predecessors[0]!, projectId: 'project-b' }, planInput().predecessors[1]!],
        }))).toThrowError(expect.objectContaining({ kind: 'validation' }));
        expect(() => atomic.transact('integration.missing', (tx) => tx.createIntegrationPlan({
          ...planInput(), predecessors: [{ ...planInput().predecessors[0]!, featureId: 'missing-feature' }, planInput().predecessors[1]!], mergeOrder: ['missing-feature', 'feature-b'],
        }))).toThrowError(expect.objectContaining({ kind: 'not_found' }));
        expect(session.database.prepare('SELECT COUNT(*) AS count FROM integration_plans').get()).toEqual({ count: 0 });
        expect(session.database.prepare('SELECT COUNT(*) AS count FROM integration_predecessor_snapshots').get()).toEqual({ count: 0 });
      } finally { session.close(); }
    });
  });

  it('[case:integration-cas-and-result] freezes by revision CAS and records only a complete integration result', async () => {
    await withSandbox(async (root) => {
      const session = await openMigrated(join(root, 'state.db'));
      try {
        const atomic = createSqliteAtomicCommandStore(session);
        const created = atomic.transact('integration.create', (tx) => tx.createIntegrationPlan(planInput()));
        expect(() => atomic.transact('integration.freeze-stale', (tx) => tx.freezeIntegrationPlan({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: 2 }))).toThrowError(expect.objectContaining({ kind: 'conflict' }));
        expect(session.database.prepare('SELECT revision, frozen_at FROM integration_plans WHERE id = ?').get(created.integrationId)).toEqual({ revision: 1, frozen_at: null });
        const frozen = atomic.transact('integration.freeze', (tx) => tx.freezeIntegrationPlan({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: 1 }));
        const passed = atomic.transact('integration.result', (tx) => tx.updateIntegrationPlanResult({
          projectId: 'project-a', integrationId: created.integrationId, expectedRevision: frozen.revision,
          integrationResult: { commitSha: 'f'.repeat(40), treeSha: '1'.repeat(40), verificationEvidence: { evidenceId: 'check', evidenceDigest: DIGEST }, llmNoConflictText: null },
        }));
        expect(passed.status).toBe('integration_passed');
        expect(passed.revision).toBe(3);
        expect(() => atomic.transact('integration.result-stale', (tx) => tx.updateIntegrationPlanResult({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: 2, integrationResult: null }))).toThrowError(expect.objectContaining({ kind: 'conflict' }));
      } finally { session.close(); }
    });
  });

  it('[case:integration-atomic-rollback] rolls back the plan, snapshots and migration event boundary together', async () => {
    await withSandbox(async (root) => {
      const session = await openMigrated(join(root, 'state.db'));
      try {
        const atomic = createSqliteAtomicCommandStore(session);
        expect(() => atomic.transact('integration.rollback', (tx) => {
          tx.createIntegrationPlan(planInput());
          throw new Error('injected integration failure');
        })).toThrow('injected integration failure');
        expect(session.database.prepare('SELECT COUNT(*) AS count FROM integration_plans').get()).toEqual({ count: 0 });
        expect(session.database.prepare('SELECT COUNT(*) AS count FROM integration_predecessor_snapshots').get()).toEqual({ count: 0 });
      } finally { session.close(); }
    });
  });
});
