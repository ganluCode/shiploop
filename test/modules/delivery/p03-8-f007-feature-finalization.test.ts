import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeatureFinalizationService } from '../../../packages/core/src/application/feature-finalization.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

describe('F-007 Feature finalization', () => {
  const boxes: Array<{ close: () => void }> = [];
  afterEach(() => { for (const box of boxes.splice(0).reverse()) box.close(); });

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
