import { describe, expect, it } from 'vitest';
import { evaluateFeatureFinalApproval } from '../../../packages/core/src/application/feature-final-approval.ts';
import { verifyFeaturePlanApprovalInTransaction } from '../../../packages/core/src/application/plan-approval-verification.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const CODE = 'b'.repeat(64);
const AT = 1_900_000_100_000;

describe('F-006 Feature final approval gate', () => {
  it('aggregates approval and block rows from every Feature Task in SQLite', async () => {
    const fixture = await openBudgetFixture(undefined, [
      { id: 't-1', title: 'one', acceptance: { criteria: ['one'] }, dependsOn: [] },
      { id: 't-2', title: 'two', acceptance: { criteria: ['two'] }, dependsOn: [] },
    ]);
    try {
      const planDigest = (fixture.session.database.prepare('SELECT plan_digest FROM features WHERE id = ?')
        .get(fixture.featureId) as { plan_digest: string }).plan_digest;
      fixture.session.transactWrite('f006.seed-block', db => {
        db.prepare(`INSERT INTO task_approval_items
          (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
           responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
          VALUES (?, ?, ?, ?, ?, 1, ?, 'block', 'second task is blocked', 'owner', ?, NULL, '[]', 'pending', ?, '[]')`)
          .run('f006-block', AT, fixture.projectId, fixture.featureId, 't-2', AT, planDigest, fixture.owner.principalId);
      });

      const blocked = fixture.services.atomic.transact('f006.evaluate-block', transaction => {
        const approval = verifyFeaturePlanApprovalInTransaction(transaction, fixture.projectId, fixture.featureId);
        const items = transaction.listTaskApprovalItems(fixture.projectId, 't-1');
        const all = transaction.getFeaturePlan(fixture.projectId, fixture.featureId).tasks.flatMap(task =>
          transaction.listTaskApprovalItems(fixture.projectId, task.id));
        expect(items).toHaveLength(0);
        return evaluateFeatureFinalApproval(transaction, approval, { codeDigest: CODE }, all);
      });
      expect(blocked.valid).toBe(false);
      expect(blocked.reason).toBe('manual_block');
      expect(blocked.blockingItems.map(item => item.taskId)).toEqual(['t-2']);

      fixture.session.transactWrite('f006.replace-block-with-approval', db => {
        db.prepare(`UPDATE task_approval_items SET status = 'unblocked', decision = 'unblock',
          decision_actor = ?, decision_reason = 'cleared', decided_at = ?, revision = 2, updated_at = ?
          WHERE id = 'f006-block'`).run(fixture.owner.principalId, AT + 1, AT + 1);
        db.prepare(`INSERT INTO task_approval_items
          (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
           responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
           decision, decision_actor, decision_reason, decision_code_digest, decision_artifact_refs, decided_at)
          VALUES (?, ?, ?, ?, ?, 2, ?, 'approval', 'final code review', 'owner', ?, ?, '[]', 'approved', ?,
           'approve', ?, 'approved for delivery', ?, '[]', ?)`)
          .run('f006-approval', AT + 2, fixture.projectId, fixture.featureId, 't-1', AT + 2,
            planDigest, CODE, fixture.owner.principalId, fixture.owner.principalId, CODE, AT + 2);
      });

      const approved = fixture.services.atomic.transact('f006.evaluate-approved', transaction => {
        const approval = verifyFeaturePlanApprovalInTransaction(transaction, fixture.projectId, fixture.featureId);
        const all = transaction.getFeaturePlan(fixture.projectId, fixture.featureId).tasks.flatMap(task =>
          transaction.listTaskApprovalItems(fixture.projectId, task.id));
        return evaluateFeatureFinalApproval(transaction, approval, { codeDigest: CODE }, all);
      });
      expect(approved.valid).toBe(true);
      expect(approved.approval?.id).toBe('f006-approval');

      // A new block is read from the authoritative transaction after the prior
      // green evaluation and invalidates that old success.
      fixture.session.transactWrite('f006.add-late-block', db => {
        db.prepare(`INSERT INTO task_approval_items
          (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
           responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
          VALUES (?, ?, ?, ?, ?, 1, ?, 'block', 'late policy hold', 'owner', ?, NULL, '[]', 'pending', ?, '[]')`)
          .run('f006-late-block', AT + 3, fixture.projectId, fixture.featureId, 't-1', AT + 3, planDigest, fixture.owner.principalId);
      });
      const lateBlocked = fixture.services.atomic.transact('f006.reread-late-block', transaction => {
        const approval = verifyFeaturePlanApprovalInTransaction(transaction, fixture.projectId, fixture.featureId);
        const all = transaction.getFeaturePlan(fixture.projectId, fixture.featureId).tasks.flatMap(task =>
          transaction.listTaskApprovalItems(fixture.projectId, task.id));
        return evaluateFeatureFinalApproval(transaction, approval, { codeDigest: CODE }, all);
      });
      expect(lateBlocked.valid).toBe(false);
      expect(lateBlocked.reason).toBe('manual_block');
    } finally {
      fixture.close();
    }
  });

  it('refuses the controlled commit when the final Feature approval is stale', async () => {
    const fixture = await gitCommitFixture();
    fixture.authorization = { ...fixture.authorization, finalApprovalCurrent: false };
    await expect(fixture.execute()).rejects.toThrow('approval_not_current');
  });
});
