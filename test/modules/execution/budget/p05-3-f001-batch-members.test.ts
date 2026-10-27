import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteExecutionAccess } from '../../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { BUDGET, openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const DIGEST = 'ab'.repeat(32);

function runInput(batchId: string, featureId: string, runId = randomUUID()) {
  return {
    projectId: 'project-not-used',
    batchId,
    featureId,
    runId,
    purpose: 'execute',
    inputSnapshot: {},
    configSnapshot: {},
    status: 'queued',
    scopeDigest: DIGEST,
    workKey: `work-${featureId}`,
    dispatchOrdinal: 1,
    maxAttemptsPerRun: 2,
    runTimeLimitMs: 60_000,
    reason: null,
  };
}

describe('P05-3 F-001 execution batch members', () => {
  it('[case:multi-member-batch-run-membership] writes a frozen multi-feature member set and rejects a non-member Run', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      const secondFeatureId = randomUUID();
      const existing = db.prepare('SELECT * FROM features WHERE id = ?').get(fixture.featureId) as Record<string, unknown>;
      db.prepare(
        'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) ' +
          "VALUES (?, ?, ?, 1, ?, ?, 'Second', 'ready', 'approved', NULL, '[]', '[]', ?)",
      ).run(
        secondFeatureId,
        existing.created_at,
        fixture.projectId,
        existing.updated_at,
        existing.phase_id,
        existing.plan_digest,
      );

      const access = createSqliteExecutionAccess(fixture.session, { nowUtcMs: () => 1_900_000_100_000 });
      const batchId = 'batch-multi';
      const batch = fixture.session.transactWrite('test.batch.members', () => access.insertExecutionBatchInTransaction({
        projectId: fixture.projectId,
        phaseId: String(existing.phase_id),
        featureId: fixture.featureId,
        batchId,
        scopeSnapshot: { featureIds: [fixture.featureId, secondFeatureId], previewDigest: DIGEST },
        configSnapshot: {},
        budgetSnapshot: { schemaVersion: 1, ...BUDGET },
        status: 'queued',
        runsCreated: 1,
        reason: null,
      }));

      expect(batch.featureId).toBe(fixture.featureId);
      expect(db.prepare('SELECT feature_id FROM execution_batch_members WHERE batch_id = ? ORDER BY member_ordinal').all(batchId))
        .toEqual([{ feature_id: fixture.featureId }, { feature_id: secondFeatureId }]);

      const secondRun = fixture.session.transactWrite('test.run.member', () => access.insertExecutionRunInTransaction({
        ...runInput(batchId, secondFeatureId),
        projectId: fixture.projectId,
      }));
      expect(secondRun.featureId).toBe(secondFeatureId);

      expect(() => fixture.session.transactWrite('test.run.non-member', () => access.insertExecutionRunInTransaction({
        ...runInput(batchId, randomUUID()),
        projectId: fixture.projectId,
      }))).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE batch_id = ?').get(batchId)).toEqual({ count: 1 });
    } finally {
      fixture.close();
    }
  });

  it('[case:multi-member-batch-atomic-constraints] rejects duplicate member rows atomically and keeps the frozen member set immutable', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      const secondFeatureId = randomUUID();
      const existing = db.prepare('SELECT * FROM features WHERE id = ?').get(fixture.featureId) as Record<string, unknown>;
      db.prepare(
        'INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) ' +
          "VALUES (?, ?, ?, 1, ?, ?, 'Second', 'ready', 'approved', NULL, '[]', '[]', ?)",
      ).run(secondFeatureId, existing.created_at, fixture.projectId, existing.updated_at, existing.phase_id, existing.plan_digest);
      db.prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) ' +
          "VALUES ('batch-fixed', ?, ?, 1, ?, ?, ?, ?, '{}', 'queued', 1, ?, 1, 0, 0, 0, ?)",
      ).run(1_900_000_100_000, fixture.projectId, 1_900_000_100_000, existing.phase_id, fixture.featureId,
        JSON.stringify({ featureIds: [fixture.featureId] }), JSON.stringify({ schemaVersion: 1, ...BUDGET }), BUDGET.batch.deadlineUtcMs);
      const before = db.prepare('SELECT COUNT(*) AS count FROM execution_batches').get();
      expect(() => fixture.session.transactWrite('test.batch.duplicate-members', (transactionDb) => {
        transactionDb.prepare(
          'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) ' +
            "VALUES ('batch-duplicate', ?, ?, 1, ?, ?, ?, ?, '{}', 'succeeded', 1, ?, 1, 0, 0, 0, ?)",
        ).run(1_900_000_100_000, fixture.projectId, 1_900_000_100_000, existing.phase_id, fixture.featureId,
          JSON.stringify({ featureIds: [fixture.featureId, fixture.featureId] }), JSON.stringify({ schemaVersion: 1, ...BUDGET }), BUDGET.batch.deadlineUtcMs);
      })).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual(before);
      const memberBatchId = String((db.prepare('SELECT batch_id FROM execution_batch_members ORDER BY batch_id LIMIT 1').get() as { batch_id: string }).batch_id);
      expect(() => db.prepare('UPDATE execution_batch_members SET feature_id = ? WHERE batch_id = ?').run(secondFeatureId, memberBatchId))
        .toThrow(/immutable/);
      expect(() => db.prepare('UPDATE execution_batches SET scope_snapshot = \'{}\' WHERE id = ?').run(memberBatchId))
        .toThrow(/immutable/);
    } finally {
      fixture.close();
    }
  });

  it('[case:member-ownership-validation] rejects missing, cross-project and cross-phase members before creating a Batch', async () => {
    const fixture = await openBudgetFixture();
    try {
      const db = fixture.session.database;
      const existing = db.prepare('SELECT * FROM features WHERE id = ?').get(fixture.featureId) as Record<string, unknown>;
      const crossPhase = 'phase-cross';
      const crossPhaseFeature = 'feature-cross-phase';
      const otherProject = 'project-other';
      const otherPhase = 'phase-other';
      const otherFeature = 'feature-other-project';
      db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES (?, 1, ?, 1, 1, 'Other phase', 'open', '[]')")
        .run(crossPhase, fixture.projectId);
      db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs, plan_digest) VALUES (?, 1, ?, 1, 1, ?, 'Cross phase', 'ready', 'approved', '[]', '[]', ?)")
        .run(crossPhaseFeature, fixture.projectId, crossPhase, existing.plan_digest);
      db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, 1, 1, 1, 'Other project', 'active', '[]')")
        .run(otherProject);
      db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES (?, 1, ?, 1, 1, 'Other project phase', 'open', '[]')")
        .run(otherPhase, otherProject);
      db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs, plan_digest) VALUES (?, 1, ?, 1, 1, ?, 'Other project feature', 'ready', 'approved', '[]', '[]', ?)")
        .run(otherFeature, otherProject, otherPhase, existing.plan_digest);
      const access = createSqliteExecutionAccess(fixture.session, { nowUtcMs: () => 1_900_000_100_000 });
      const base = {
        projectId: fixture.projectId,
        phaseId: String(existing.phase_id),
        featureId: fixture.featureId,
        scopeSnapshot: { featureIds: [fixture.featureId] },
        configSnapshot: {},
        budgetSnapshot: { schemaVersion: 1, ...BUDGET },
        status: 'queued' as const,
        runsCreated: 1,
        reason: null,
      };
      for (const [batchId, memberId] of [
        ['batch-missing-member', 'feature-missing'],
        ['batch-cross-phase-member', crossPhaseFeature],
        ['batch-cross-project-member', otherFeature],
      ] as const) {
        expect(() => fixture.session.transactWrite(`test.${batchId}`, () => access.insertExecutionBatchInTransaction({
          ...base,
          batchId,
          scopeSnapshot: { featureIds: [fixture.featureId, memberId] },
        }))).toThrow();
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_batches').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM execution_batch_members').get()).toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  it('[case:migrate-v37-batch-members-backfill] upgrades a v37 database and preserves the Batch, Run and dispatch intent facts', async () => {
    const sandbox = createTempSandbox('shiploop-p05-3-migration-');
    const session = openSqliteStorageSession({ path: `${sandbox.path}/state.db` });
    try {
      await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 37) });
      const db = session.database;
      db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-old', 1, 1, 1, 'Old', 'active', '[]')").run();
      db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES ('phase-old', 1, 'project-old', 1, 1, 'Old', 'open', '[]')").run();
      db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, labels, source_refs) VALUES ('feature-old', 1, 'project-old', 1, 1, 'phase-old', 'Old', 'ready', 'approved', '[]', '[]')").run();
      db.prepare(
        'INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) ' +
          "VALUES ('batch-old', 10, 'project-old', 1, 10, 'phase-old', 'feature-old', '{\"featureIds\":[\"feature-old\"],\"previewDigest\":\"old\"}', '{}', 'queued', 1, '{\"legacy\":true}', 1, 2, 3, 4, 9999999999999)",
      ).run();
      db.prepare(
        'INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) ' +
          "VALUES ('run-old', 11, 'project-old', 1, 11, 'batch-old', 'feature-old', 'execute', '{}', '{}', 'queued', ?, 'old-work', 1, 2, 60000, 1)",
      ).run(DIGEST);
      db.prepare(
        "INSERT INTO run_dispatch_intents (id, created_at, project_id, updated_at, feature_id, batch_id, run_id, source, authorization_digest, enqueued_at) VALUES (?, 12, ?, 12, ?, ?, ?, 'start', ?, 12)",
      ).run('intent-old', 'project-old', 'feature-old', 'batch-old', 'run-old', DIGEST);

      await migrateSqliteStorage(session);
      expect(db.prepare('SELECT feature_id, member_ordinal FROM execution_batch_members WHERE batch_id = ?').all('batch-old'))
        .toEqual([{ feature_id: 'feature-old', member_ordinal: 1 }]);
      expect(db.prepare('SELECT runs_created, attempts_created, runtime_starts, no_progress_runs, status FROM execution_batches WHERE id = ?').get('batch-old'))
        .toEqual({ runs_created: 1, attempts_created: 2, runtime_starts: 3, no_progress_runs: 4, status: 'queued' });
      expect(db.prepare('SELECT id FROM runs WHERE id = ?').get('run-old')).toEqual({ id: 'run-old' });
      expect(db.prepare('SELECT id FROM run_dispatch_intents WHERE id = ?').get('intent-old')).toEqual({ id: 'intent-old' });
    } finally {
      session.close();
      sandbox.cleanup();
    }
  });
});
