import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSqliteGitOperationQueryStore } from '../../../packages/core/src/adapters/sqlite/git-operation-query-store.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { openBudgetFixture, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { recordVerifiedPass } from '../../helpers/p03-4/task-dag-state-fixture.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

async function fixture() {
  const box = await openBudgetFixture();
  const ids = await box.start();
  recordVerifiedPass(box, ids, ids.taskId);
  const db = box.session.database;
  const binding = db.prepare('SELECT id, repo_identity FROM repository_bindings WHERE project_id = ?')
    .get(box.projectId) as { id: string; repo_identity: string };
  const feature = db.prepare('SELECT revision, phase_id FROM features WHERE project_id = ? AND id = ?')
    .get(box.projectId, box.featureId) as { revision: number; phase_id: string };
  const inputDigest = DIGEST('a');
  const coveredDigest = computeCoveredInputDigest([{ inputId: 'input-a', digest: inputDigest }]);
  const plan = createIntegrationExecutionPlan({
    projectId: box.projectId,
    phaseId: feature.phase_id,
    batchId: ids.batchId,
    runId: ids.runId,
    successorFeatureId: box.featureId,
    target: {
      baseCommit: SHA('b'),
      repoIdentity: binding.repo_identity,
      canonicalPath: '/private/repository',
      gitCommonDir: '/private/repository/.git',
    },
    predecessors: [{
      projectId: box.projectId,
      phaseId: feature.phase_id,
      batchId: ids.batchId,
      runId: ids.runId,
      featureId: box.featureId,
      dependencyPassed: true,
      delivery: {
        commitSha: SHA('c'),
        repoIdentity: binding.repo_identity,
        inputDigest: coveredDigest,
        evidenceId: 'delivery-a',
        evidenceDigest: DIGEST('d'),
      },
      coveredInputIds: ['input-a'],
    }],
    approvedInputs: [{ inputId: 'input-a', digest: inputDigest }],
    mergeOrder: [box.featureId],
    verificationScope: ['typecheck', 'combined-tests'],
    integrationResult: null,
  });

  box.session.transactWrite('p05-7.f002.seed-plan', dbx => {
    dbx.prepare(`INSERT INTO integration_plans
      (id, created_at, project_id, revision, updated_at, phase_id, batch_id, successor_feature_id,
       target_baseline, input_digest, mode, merge_order, approved_inputs, verification_scope,
       strategy_summary, integration_result, status, block_reasons, stale_reasons, frozen_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'reuse_single_predecessor', ?, ?, ?, '{}', NULL,
        'dependency_passed', '[]', '[]', ?)`)
      .run(plan.integrationId, NOW, box.projectId, NOW, feature.phase_id, ids.batchId, box.featureId,
        plan.target.baseCommit, plan.inputDigest, JSON.stringify(plan.mergeOrder),
        JSON.stringify(plan.approvedInputs), JSON.stringify(plan.verificationScope), NOW);
    dbx.prepare(`INSERT INTO integration_predecessor_snapshots
      (id, created_at, project_id, plan_id, phase_id, feature_id, predecessor_ordinal,
       dependency_passed, delivery_commit, delivery_evidence_id, delivery_evidence_digest,
       covered_input_ids, ancestor_verified)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'delivery-a', ?, '["input-a"]', 1)`)
      .run(randomUUID(), NOW, box.projectId, plan.integrationId, feature.phase_id, box.featureId,
        SHA('c'), DIGEST('d'));
  });

  const intent = (overrides: Record<string, unknown> = {}) => ({
    operationId: plan.integrationId,
    projectId: box.projectId,
    featureId: box.featureId,
    runId: ids.runId,
    attemptId: null,
    executionVersion: 1,
    operationType: 'integration',
    repositoryBindingId: binding.id,
    repoIdentity: binding.repo_identity,
    worktreePath: '/private/integration-worktree',
    expectedHead: plan.target.baseCommit,
    candidateTree: null,
    codeDigest: DIGEST('e'),
    verificationRefs: [],
    approvalRefs: [],
    message: 'deterministic integration',
    gitIdentity: { name: 'Test User', email: 'test@example.com', confirmed: true },
    deliveryPolicyDigest: DIGEST('f'),
    runtimeSource: null,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    integrationPlan: plan,
    budgetSnapshot: { runtimeStarts: 1, owner: 'owner-1' },
    expectedFeatureRevision: feature.revision,
    ...overrides,
  });
  const store = createSqliteGitOperationStore(box.session, { nowUtcMs: () => NOW + 1 });
  return { box, db, ids, plan, intent, store };
}

describe('P05-7 F-002 integration Git operation persistence', () => {
  it('[case:integration-registers-frozen-intent] stores the immutable integration snapshot and is idempotent', async () => {
    const f = await fixture();
    try {
      const first = f.store.registerGitOperation(f.intent());
      const replay = f.store.registerGitOperation(f.intent());
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(first.operation.intent.integrationPlan?.target.baseCommit).toBe(f.plan.target.baseCommit);
      expect(first.operation.intent.budgetSnapshot).toEqual({ runtimeStarts: 1, owner: 'owner-1' });
      expect(() => f.store.registerGitOperation(f.intent({ budgetSnapshot: { runtimeStarts: 2 } })))
        .toThrow(expect.objectContaining({ kind: 'conflict', details: expect.objectContaining({ reason: 'intent_conflict' }) }));
      expect(f.db.prepare('SELECT worktree_path, integration_plan, budget_snapshot FROM git_operations WHERE id = ?').get(f.plan.integrationId))
        .toMatchObject({ worktree_path: '/private/integration-worktree' });
    } finally { f.box.close(); }
  });

  it('[case:integration-settles-and-queries-safely] atomically records result/projection and hides local paths', async () => {
    const f = await fixture();
    try {
      f.store.registerGitOperation(f.intent());
      const result = {
        commitSha: SHA('1'), treeSha: SHA('2'), inputDigest: f.plan.inputDigest,
        verificationEvidence: { evidenceId: 'combined-check', evidenceDigest: DIGEST('3') },
      };
      const settled = f.store.finalizeGitOperation({
        operationId: f.plan.integrationId, projectId: f.box.projectId, expectedRevision: 1,
        status: 'succeeded', actualCommit: result.commitSha, actualTree: result.treeSha,
        exitCode: 0, durationMs: 12, reasonCode: null, deliveryStatus: 'not_requested',
        settledAtUtcMs: NOW + 2, integrationResult: result, recoveryState: 'cleaned', workspacePreserved: false,
      });
      expect(settled.operation.integrationResult).toEqual(result);
      expect(f.db.prepare('SELECT status, integration_result FROM integration_plans WHERE id = ?').get(f.plan.integrationId))
        .toMatchObject({ status: 'integration_passed', integration_result: JSON.stringify(result) });
      const page = createSqliteGitOperationQueryStore(f.box.session)
        .listGitOperationRecordsByProject!({ kind: 'all' }, f.box.projectId, { afterId: null, limit: 1 });
      expect(page.records).toHaveLength(1);
      const publicRecord = (await import('../../../packages/core/src/ports/git-operation-query.ts')).toPublicGitOperationRecord(page.records[0]!);
      expect(publicRecord.integration?.targetBase).toBe(f.plan.target.baseCommit);
      expect(JSON.stringify(publicRecord)).not.toContain('/private/');
      expect(JSON.stringify(publicRecord)).not.toContain('runtimeStarts');
    } finally { f.box.close(); }
  });

  it('[case:integration-unknown-and-corrupt-are-fail-closed] keeps unknown facts empty and rejects corrupt rows', async () => {
    const f = await fixture();
    try {
      f.store.registerGitOperation(f.intent());
      f.store.finalizeGitOperation({
        operationId: f.plan.integrationId, projectId: f.box.projectId, expectedRevision: 1,
        status: 'unknown', actualCommit: null, actualTree: null, exitCode: null, durationMs: null,
        reasonCode: 'writer_lost', deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 2,
        recoveryState: 'preserved', workspacePreserved: true,
      });
      expect(f.store.getGitOperation(f.box.projectId, f.plan.integrationId)).toMatchObject({
        status: 'unknown', actualCommit: null, actualTree: null, exitCode: null, durationMs: null,
        recoveryState: 'preserved', workspacePreserved: true,
      });
      f.db.exec('DROP TRIGGER git_operations_terminal_immutable');
      f.db.prepare('UPDATE git_operations SET integration_result = ? WHERE id = ?').run('{"bad":1}', f.plan.integrationId);
      expect(() => f.store.getGitOperation(f.box.projectId, f.plan.integrationId))
        .toThrow(expect.objectContaining({ kind: 'corrupt' }));
    } finally { f.box.close(); }
  });
});
