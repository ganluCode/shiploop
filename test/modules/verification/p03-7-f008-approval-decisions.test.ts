import { describe, expect, it } from 'vitest';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';

const digest = 'a'.repeat(64);
const base = {
  schemaVersion: 5,
  commandId: '11111111-1111-4111-8111-111111111111',
  issuedAt: '2026-10-11T17:45:49.000Z',
  scope: { kind: 'project', projectId: '00000000-0000-4000-8000-000000000001' },
  expectedRevision: 1,
};

describe('F-008 task approval item decisions', () => {
  for (const operation of ['task.approval.approve', 'task.approval.reject', 'task.approval.unblock'] as const) {
    it(`${operation} accepts a bound decision payload`, () => {
      expect(() => validateCommandEnvelope({
        ...base,
        operation,
        payload: {
          taskId: '00000000-0000-4000-8000-000000000002',
          itemId: '00000000-0000-4000-8000-000000000003',
          planDigest: digest,
          codeDigest: digest,
          artifactRefs: [{ artifactId: '00000000-0000-4000-8000-000000000004', contentHash: digest }],
          reason: 'reviewed by the responsible party',
        },
      })).not.toThrow();
    });
  }

  it('does not accept client supplied decision identity', () => {
    expect(() => validateCommandEnvelope({
      ...base,
      operation: 'task.approval.approve',
      payload: {
        taskId: '00000000-0000-4000-8000-000000000002', itemId: '00000000-0000-4000-8000-000000000003', planDigest: digest,
        codeDigest: digest, artifactRefs: [], reason: null,
        principalId: 'forged-principal', decisionActor: 'forged-actor',
      },
    })).toThrow(/结构校验|未知字段|unknown/i);
  });
});

describe('F-008 real command path', () => {
  it.each(['task.approval.approve', 'task.approval.reject', 'task.approval.unblock'] as const)(
    '%s commits one item decision without execution side effects', async operation => {
      const fixture = await openBudgetFixture();
      try {
        const feature = fixture.session.database.prepare<[string], { plan_digest: string }>(
          'SELECT plan_digest FROM features WHERE id = ?',
        ).get(fixture.featureId)!;
        const itemId = '00000000-0000-4000-8000-000000000099';
        fixture.session.transactWrite('f008.seed-item', database => {
          database.prepare(
            `INSERT INTO task_approval_items
              (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
               responsible_party, plan_digest, code_digest, artifact_refs, status, created_by,
               decision_artifact_refs)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'Review the task', 'owner', ?, ?, '[]', 'pending', ?, '[]')`,
          ).run(itemId, 1_900_000_100_000, fixture.projectId, fixture.featureId, 't-1',
            1_900_000_100_000, operation === 'task.approval.unblock' ? 'block' : 'approval', feature.plan_digest, digest, fixture.owner.principalId);
        });
        if (operation === 'task.approval.unblock') {
          fixture.session.database.prepare('UPDATE tasks SET manual_block = 1 WHERE project_id = ? AND id = ?').run(fixture.projectId, 't-1');
        }
        const before = {
          runs: fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number },
          attempts: fixture.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get() as { count: number },
          starts: fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runtime_start_reservations').get() as { count: number },
        };
        const receipt = await fixture.services.commands.submit(fixture.owner, fixture.envelope(operation, {
          taskId: 't-1', itemId, planDigest: feature.plan_digest, codeDigest: digest, artifactRefs: [], reason: 'reviewed',
        }, { scope: fixture.scope, expectedRevision: 1 }));
        expect(receipt.status).toBe('completed');
        const completed = receipt as { status: 'completed'; result: unknown };
        expect(completed.result).toMatchObject({ decision: operation.slice('task.approval.'.length), executionStarted: false, runtimeCalled: false });
        expect(fixture.session.database.prepare('SELECT status, decision, decision_actor, decision_reason, revision FROM task_approval_items WHERE id = ?').get(itemId))
          .toMatchObject({ status: operation === 'task.approval.approve' ? 'approved' : operation === 'task.approval.reject' ? 'rejected' : 'unblocked', decision: operation.slice('task.approval.'.length), decision_actor: fixture.owner.principalId, decision_reason: 'reviewed', revision: 2 });
        expect(fixture.session.database.prepare('SELECT manual_block FROM tasks WHERE id = ?').get('t-1'))
          .toEqual({ manual_block: 0 });

        expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual(before.runs);
        expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual(before.attempts);
        expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM runtime_start_reservations').get()).toEqual(before.starts);
      } finally {
        fixture.close();
      }
    },
  );

  it('does not let a capable but unassigned principal decide an item', async () => {
    const fixture = await openBudgetFixture();
    try {
      const feature = fixture.session.database.prepare<[string], { plan_digest: string }>(
        'SELECT plan_digest FROM features WHERE id = ?',
      ).get(fixture.featureId)!;
      const itemId = '00000000-0000-4000-8000-000000000098';
      fixture.session.transactWrite('f008.seed-unassigned-item', database => {
        database.prepare(
          `INSERT INTO task_approval_items
            (id, created_at, project_id, feature_id, task_id, revision, updated_at, kind, description,
             responsible_party, plan_digest, code_digest, artifact_refs, status, created_by, decision_artifact_refs)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'approval', 'Review the task', 'reviewer-a', ?, ?, '[]', 'pending', ?, '[]')`,
        ).run(itemId, 1_900_000_100_000, fixture.projectId, fixture.featureId, 't-1', 1_900_000_100_000, feature.plan_digest, digest, fixture.owner.principalId);
      });
      await expect(fixture.services.commands.submit(fixture.owner, fixture.envelope('task.approval.approve', {
        taskId: 't-1', itemId, planDigest: feature.plan_digest, codeDigest: digest, artifactRefs: [], reason: 'reviewed',
      }, { scope: fixture.scope, expectedRevision: 1 }))).rejects.toThrow(/forbidden|责任主体|授权被拒绝/);
    } finally {
      fixture.close();
    }
  });
});
