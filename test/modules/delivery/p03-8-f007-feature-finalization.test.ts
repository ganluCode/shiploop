import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeatureFinalizationService } from '../../../packages/core/src/application/feature-finalization.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';

describe('F-007 Feature finalization', () => {
  const boxes: Array<{ close: () => void }> = [];
  afterEach(() => { for (const box of boxes.splice(0).reverse()) box.close(); });

  it.each([
    { passed: true, approved: true, parentStatus: 'succeeded', commits: 2 },
    { passed: false, approved: true, parentStatus: 'failed', commits: 1 },
    { passed: true, approved: false, parentStatus: 'queued', commits: 1 },
  ])('shared Batch settles children independently ($parentStatus, approved=$approved)', async scenario => {
    const box = await openBudgetFixture(); boxes.push(box);
    const db = box.session.database;
    const other = 'feature-other';
    db.prepare(`INSERT INTO features(id,created_at,project_id,revision,updated_at,phase_id,title,status,plan_status,description,labels,source_refs,plan_digest)
      SELECT ?,created_at,project_id,1,updated_at,phase_id,'Other','running',plan_status,description,labels,source_refs,plan_digest
      FROM features WHERE id=?`).run(other, box.featureId);
    db.prepare(`INSERT INTO tasks(id,created_at,project_id,revision,updated_at,feature_id,title,status,
      complexity,description,labels,acceptance,requirements_refs,execution_config,config_source,config_source_key)
      SELECT 'task-other',created_at,project_id,1,updated_at,?,'Other Task','passed',
        complexity,description,labels,acceptance,requirements_refs,execution_config,config_source,config_source_key
      FROM tasks WHERE id='t-1'`).run(other);
    // The finalization primitive needs only approved membership and passed Tasks;
    // this fixture does not claim to prove Runtime or Git authorization.
    db.prepare("UPDATE tasks SET status='passed' WHERE project_id=?").run(box.projectId);
    const access = createSqliteExecutionAccess(box.session, { nowUtcMs: () => NOW });
    const batchId = 'shared-closeout';
    box.session.transactWrite('test.sharedBatch', () => {
      access.insertExecutionBatchInTransaction({ projectId: box.projectId, phaseId: 'phase-1', featureId: box.featureId,
        batchId, scopeSnapshot: { featureIds: [box.featureId, other] }, configSnapshot: {},
        budgetSnapshot: { schemaVersion: 1, ...BUDGET }, status: 'queued', runsCreated: 2, reason: null });
      for (const [featureId, runId] of [[box.featureId, 'child-a'], [other, 'child-b']]) {
        access.insertExecutionRunInTransaction({ projectId: box.projectId, batchId, featureId, runId, purpose: 'execute',
          inputSnapshot: {}, configSnapshot: {}, status: 'queued', scopeDigest: 'a'.repeat(64), workKey: runId,
          dispatchOrdinal: 1, maxAttemptsPerRun: 2, runTimeLimitMs: 60_000, reason: null });
      }
    });
    const verify = vi.fn(async input => ({ passed: input.featureId === box.featureId || scenario.passed, reason: 'verification_result' }));
    const commit = vi.fn(async ({ operationId }) => ({ intent: { operationId }, deliveryStatus: 'succeeded', status: 'succeeded' } as any));
    const service = createFeatureFinalizationService({ atomic: box.atomic, verify,
      readApproval: async input => ({ valid: input.featureId === box.featureId || scenario.approved, reason: 'approval_result' }), commit: { commit } });
    const firstInput = { projectId: box.projectId, featureId: box.featureId, batchId, runId: 'child-a', operationId: 'git-a' };
    const first = await service.finalize(firstInput);
    expect(first).toMatchObject({ feature: { status: 'completed' }, run: { status: 'succeeded' }, batch: { status: 'queued' } });
    expect(db.prepare('SELECT status FROM runs WHERE id=?').get('child-b')).toEqual({ status: 'queued' });
    await service.finalize(firstInput);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE execution_batches SET status='paused',revision=revision+1 WHERE id=?").run(batchId);
    await expect(service.finalize({ ...firstInput, featureId: other, runId: 'child-b', operationId: 'git-b' }))
      .rejects.toThrow('Shared Batch control');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE execution_batches SET status='queued',revision=revision+1 WHERE id=?").run(batchId);
    const last = await service.finalize({ ...firstInput, featureId: other, runId: 'child-b', operationId: 'git-b' });
    expect(last.batch.status).toBe(scenario.parentStatus);
    await service.finalize(firstInput);
    expect(commit).toHaveBeenCalledTimes(scenario.commits);
    expect(db.prepare("SELECT count(*) AS n FROM state_events WHERE event_type='execution.batch.ended' AND aggregate_id=?").get(batchId))
      .toEqual({ n: scenario.parentStatus === 'queued' ? 0 : 1 });
  });

  it('完成 Feature、execute Run 和单 Feature Batch，重复调用不重复验证或提交', async () => {
    const box = await openBudgetFixture();
    boxes.push(box);
    const { projectId, featureId } = box;
    const ids = await box.start();
    const db = box.session.database;
    db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
    db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(featureId);
    db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
    db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
    const verify = vi.fn(async () => ({ passed: true, reason: 'full_verification_passed' }));
    const readApproval = vi.fn(async () => ({ valid: true, reason: 'approval_current' }));
    const commit = vi.fn(async () => ({ intent: { operationId: 'op-final-1' }, deliveryStatus: 'succeeded', status: 'succeeded' } as any));
    const service = createFeatureFinalizationService({ atomic: box.services.atomic, verify, readApproval, commit: { commit } });

    const first = await service.finalize({ projectId, featureId, batchId: ids.batchId, runId: ids.runId, operationId: 'op-final-1' });
    const second = await service.finalize({ projectId, featureId, batchId: ids.batchId, runId: ids.runId, operationId: 'op-final-1' });

    expect(first.outcome).toBe('completed');
    expect(first.deliveryStatus).toBe('succeeded');
    expect(first.feature.status).toBe('completed');
    expect(first.run.status).toBe('succeeded');
    expect(first.batch.status).toBe('succeeded');
    expect(second).toMatchObject({ outcome: 'completed', deliveryStatus: 'succeeded' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(readApproval).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'feature.finalized'").get()).toEqual({ count: 1 });
  });

  it('最终检查失败保存 partial，且不调用审批或提交', async () => {
    const box = await openBudgetFixture(); boxes.push(box);
    const ids = await box.start(); const db = box.session.database;
    db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
    db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(box.featureId);
    db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
    db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
    const readApproval = vi.fn(); const commit = vi.fn();
    const result = await createFeatureFinalizationService({ atomic: box.services.atomic, verify: async () => ({ passed: false, reason: 'verification_failed' }), readApproval, commit: { commit } }).finalize({ projectId: box.projectId, featureId: box.featureId, batchId: ids.batchId, runId: ids.runId, operationId: 'op-final-2' });
    expect(result).toMatchObject({ outcome: 'partial', deliveryStatus: 'not_requested', feature: { status: 'partial' }, run: { status: 'failed' }, batch: { status: 'failed' } });
    expect(readApproval).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });

  it('缺少最终审批保持 awaiting_approval，并保留 Task 历史', async () => {
    const box = await openBudgetFixture(); boxes.push(box);
    const ids = await box.start(); const db = box.session.database;
    db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
    db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(box.featureId);
    db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
    db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
    const result = await createFeatureFinalizationService({ atomic: box.services.atomic, verify: async () => ({ passed: true, reason: 'passed' }), readApproval: async () => ({ valid: false, reason: 'approval_required' }) }).finalize({ projectId: box.projectId, featureId: box.featureId, batchId: ids.batchId, runId: ids.runId, operationId: null });
    expect(result).toMatchObject({ outcome: 'awaiting_approval', feature: { status: 'awaiting_approval' }, run: { status: 'paused' }, batch: { status: 'paused' } });
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(ids.taskId)).toEqual({ status: 'passed' });
  });

  it('提交未知时独立保留 pending deliveryStatus，并防止并发重复提交', async () => {
    const box = await openBudgetFixture(); boxes.push(box);
    const ids = await box.start(); const db = box.session.database;
    db.prepare("UPDATE tasks SET status = 'passed', revision = revision + 1 WHERE id = ?").run(ids.taskId);
    db.prepare("UPDATE features SET status = 'running', revision = revision + 1 WHERE id = ?").run(box.featureId);
    db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
    db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
    const commit = vi.fn(async () => { throw new Error('delivery_outcome_unknown'); });
    const service = createFeatureFinalizationService({ atomic: box.services.atomic, verify: async () => ({ passed: true, reason: 'passed' }), readApproval: async () => ({ valid: true, reason: 'current' }), commit: { commit } });
    const input = { projectId: box.projectId, featureId: box.featureId, batchId: ids.batchId, runId: ids.runId, operationId: 'op-final-3' };
    const [first, second] = await Promise.all([service.finalize(input), service.finalize(input)]);
    expect(first).toMatchObject({ outcome: 'partial', deliveryStatus: 'pending', feature: { status: 'partial', deliveryStatus: 'pending' } });
    expect(second).toMatchObject({ outcome: 'partial', deliveryStatus: 'pending' });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
