import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFeatureFinalizationService } from '../../../packages/core/src/application/feature-finalization.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import {
  EXECUTION_BATCH_TERMINAL_EVENT_TYPE,
  EXECUTION_RUN_TERMINAL_EVENT_TYPE,
  TASK_ACTION_REQUIRED_EVENT_TYPE,
  TASK_TERMINAL_EVENT_TYPE,
  mapStateEvent,
} from '../../../packages/core/src/ports/events.ts';
import { openBudgetFixture, BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';

describe('P07-4 F-005 authoritative result events', () => {
  it('[case:run-and-budget-terminal] freezes Run and Batch result axes in the settlement transaction and deduplicates replay', async () => {
    const fixture = await openBudgetFixture({
      ...BUDGET,
      batch: { ...BUDGET.batch, maxNoProgressRuns: 1 },
    });
    try {
      const ids = await fixture.start();
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
      fixture.session.database.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
      const access = createSqliteExecutionAccess(fixture.session, { nowUtcMs: () => NOW + 10 });
      const run = fixture.session.database.prepare('SELECT revision FROM runs WHERE id = ?').get(ids.runId) as { revision: number };
      const settleInput = {
        projectId: ids.projectId, batchId: ids.batchId, runId: ids.runId, runRevision: run.revision,
        resultKey: `f005-${randomUUID()}`, outcome: 'failed' as const, reason: 'runtime_failed',
      };
      const settled = fixture.session.transactWrite('f005.settle', () => access.settleExecutionRunOutcomeInTransaction(settleInput));
      const events = fixture.session.database.prepare(
        `SELECT event_type, aggregate_type, aggregate_id, aggregate_revision, payload
         FROM state_events WHERE event_type IN (?, ?) ORDER BY sequence`,
      ).all(EXECUTION_RUN_TERMINAL_EVENT_TYPE, EXECUTION_BATCH_TERMINAL_EVENT_TYPE) as Array<Record<string, unknown>>;
      expect(events).toHaveLength(2);
      expect(JSON.parse(String(events[0]!.payload))).toMatchObject({
        schemaVersion: 1, status: 'failed', resultCategory: 'budget_exhausted', resultRef: settled.id,
        batchId: ids.batchId, featureId: fixture.featureId,
      });
      expect(JSON.parse(String(events[1]!.payload))).toMatchObject({
        schemaVersion: 1, status: 'failed', resultCategory: 'budget_exhausted', resultRef: settled.id,
        batchId: ids.batchId, featureId: fixture.featureId,
      });
      expect(fixture.session.database.prepare('SELECT status, reason FROM execution_batches WHERE id = ?').get(ids.batchId))
        .toEqual({ status: 'failed', reason: 'budget_exhausted' });
      fixture.session.transactWrite('f005.replay', () => access.settleExecutionRunOutcomeInTransaction(settleInput));
      expect(fixture.session.database.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type IN (?, ?)")
        .get(EXECUTION_RUN_TERMINAL_EVENT_TYPE, EXECUTION_BATCH_TERMINAL_EVENT_TYPE)).toEqual({ count: 2 });
    } finally {
      fixture.close();
    }
  });

  it('[case:feature-finalization-result] records Feature delivery outcome with immutable references and terminal Run/Batch events', async () => {
    const fixture = await openBudgetFixture();
    try {
      const ids = await fixture.start();
      const db = fixture.session.database;
      db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
      db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(fixture.featureId);
      db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
      db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
      const service = createFeatureFinalizationService({
        atomic: fixture.services.atomic,
        verify: async () => ({ passed: false, reason: 'verification_failed' }),
        readApproval: vi.fn(),
      });
      const result = await service.finalize({
        projectId: ids.projectId, featureId: fixture.featureId, batchId: ids.batchId, runId: ids.runId, operationId: null,
      });
      expect(result.outcome).toBe('partial');
      const event = db.prepare("SELECT payload FROM state_events WHERE event_type = 'feature.finalization_blocked'").get() as { payload: string };
      expect(JSON.parse(event.payload)).toEqual({
        schemaVersion: 1, outcome: 'partial', deliveryStatus: 'not_requested', reasonCode: 'verification_failed',
        runId: ids.runId, batchId: ids.batchId, operationId: null,
      });
      expect(db.prepare("SELECT payload FROM state_events WHERE event_type = 'execution.run.ended'").get()).toBeDefined();
      expect(db.prepare("SELECT payload FROM state_events WHERE event_type = 'execution.batch.ended'").get()).toBeDefined();
    } finally {
      fixture.close();
    }
  });

  it('[case:result-event-rollback] rolls back terminal business state when the corresponding result event cannot be written', async () => {
    const fixture = await openBudgetFixture();
    try {
      const ids = await fixture.start();
      const db = fixture.session.database;
      db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
      db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(fixture.featureId);
      db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
      db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
      db.exec(`CREATE TRIGGER f005_result_event_failure BEFORE INSERT ON state_events
        WHEN NEW.event_type = 'execution.run.ended' BEGIN SELECT RAISE(ABORT, 'result_event_failure'); END`);
      const service = createFeatureFinalizationService({
        atomic: fixture.services.atomic,
        verify: async () => ({ passed: true, reason: 'passed' }),
        readApproval: async () => ({ valid: true, reason: 'approved' }),
        commit: { commit: async () => ({ intent: { operationId: 'f005-op' }, deliveryStatus: 'succeeded', status: 'succeeded' } as never) },
      });
      await expect(service.finalize({
        projectId: ids.projectId, featureId: fixture.featureId, batchId: ids.batchId, runId: ids.runId, operationId: 'f005-op',
      })).rejects.toThrow('result_event_failure');
      db.exec('DROP TRIGGER f005_result_event_failure');
      expect(db.prepare('SELECT status FROM features WHERE id = ?').get(fixture.featureId)).toEqual({ status: 'running' });
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(ids.runId)).toEqual({ status: 'running' });
      expect(db.prepare('SELECT status FROM execution_batches WHERE id = ?').get(ids.batchId)).toEqual({ status: 'running' });
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type IN ('feature.finalized', 'execution.run.ended', 'execution.batch.ended')").get())
        .toEqual({ count: 0 });
    } finally {
      try { fixture.session.database.exec('DROP TRIGGER IF EXISTS f005_result_event_failure'); } catch { /* fixture is closing */ }
      fixture.close();
    }
  });

  it('[case:public-result-event-validation] maps versioned Task and manual-action payloads without reading current entity state', () => {
    const base = {
      id: 'aaaaaaaa-1111-4222-8333-444444444444', sequence: 9, aggregateRevision: 4,
      projectId: '12345678-1234-4123-8234-1234567890ab', occurredAtUtcMs: NOW,
    };
    expect(mapStateEvent({ ...base, eventType: TASK_TERMINAL_EVENT_TYPE, aggregateType: 'task', aggregateId: 'task-1',
      payload: { schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: 'attempt-1', runId: 'run-1', resultRef: 'verification-1' } })).toMatchObject({
      type: TASK_TERMINAL_EVENT_TYPE,
      payload: { schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: 'attempt-1', runId: 'run-1' },
    });
    expect(mapStateEvent({ ...base, eventType: TASK_ACTION_REQUIRED_EVENT_TYPE, aggregateType: 'task', aggregateId: 'task-1',
      payload: { schemaVersion: 1, action: 'manual_review', itemId: 'approval-1', reason: 'approval_required' } })).toMatchObject({
      type: TASK_ACTION_REQUIRED_EVENT_TYPE,
      payload: { schemaVersion: 1, action: 'manual_review', itemId: 'approval-1', reason: 'approval_required' },
    });
  });
});
