import { describe, expect, it } from 'vitest';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { createSqlitePhaseDeliveryApprovalStore } from '../../../packages/core/src/adapters/sqlite/phase-delivery-approval-store.ts';
import { createBatchLeafFinalizationService, type BatchFinalizationBatchSnapshot, type BatchFinalizationLeafEvidence } from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createPhaseDeliveryApprovalService } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import { buildPhaseDeliveryScope, phaseScopeLeaf } from '../../helpers/p05-9/phase-delivery-scope.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function batch(projectId: string, batchId: string, overrides: Partial<BatchFinalizationBatchSnapshot> = {}): BatchFinalizationBatchSnapshot {
  return {
    schemaVersion: 1, projectId, phaseId: 'phase-1', batchId, revision: 3, status: 'succeeded', approved: true,
    featureIds: ['feature-a', 'feature-b'], dependencies: [], targetBaseline: SHA('b'),
    approvedInputs: [{ inputId: 'input-a', digest: DIGEST('a') }, { inputId: 'input-b', digest: DIGEST('b') }],
    verificationScope: ['combined-tests'], strategySummary: { mode: 'deterministic' },
    ...overrides,
  };
}

function evidence(featureId: string, letter: string): BatchFinalizationLeafEvidence {
  return {
    featureId, featureStatus: 'completed', deliveryStatus: 'succeeded', revision: 4, commitSha: SHA(letter), repoIdentity: 'repo-1',
    coveredInputs: [{ inputId: `input-${letter}`, digest: DIGEST(letter) }], evidenceId: `evidence-${featureId}`,
    evidenceDigest: DIGEST(letter), evidenceFresh: true, commitExists: true, branchHead: SHA(letter),
  };
}

describe('P05-9 F-004 SQLite Phase delivery approval', () => {
  it('[case:phase-delivery-approval-atomic-sqlite-binding] persists approval, Phase pointer and audit event atomically', async () => {
    const fixture = await openBudgetFixture();
    try {
      const started = await fixture.start();
      fixture.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(started.runId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const candidates = createSqliteBatchFinalizationCandidateStore(fixture.session, { nowUtcMs: () => 1_900_000_300_000 });
      const finalization = createBatchLeafFinalizationService({
        batches: { read: () => batch(fixture.projectId, started.batchId) },
        leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
        candidates,
        integrate: async () => ({ status: 'succeeded' as const, commitSha: SHA('c'), treeSha: SHA('d'), evidenceId: 'integration-evidence', evidenceDigest: DIGEST('e'), workspacePreserved: true }),
        verify: async () => ({ status: 'passed' as const, evidenceId: 'verification-evidence', evidenceDigest: DIGEST('f') }),
      });
      const finalized = await finalization.run({ projectId: fixture.projectId, batchId: started.batchId, commandId: 'delivery-command-1' });
      expect(finalized.candidate?.status).toBe('ready_for_phase_approval');
      const candidate = candidates.read(fixture.projectId, started.batchId, 'delivery-command-1')!;
      const approvals = createSqlitePhaseDeliveryApprovalStore(fixture.session, { nowUtcMs: () => 1_900_000_400_000 });
      const service = createPhaseDeliveryApprovalService({
        approvals,
        snapshots: { read: () => ({
          candidate,
          batch: {
            projectId: fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, revision: 3, status: 'succeeded', approved: true,
            scopeDigest: candidate.scopeDigest, inputDigest: candidate.inputDigest,
            budgetSummary: { budgetRevision: 1, attemptsUsed: 1, deadlineAt: 1_900_000_000_000 },
            stopSummary: { status: 'confirmed', digest: DIGEST('q') },
            codeSummary: { targetBaseline: candidate.targetBaseline, integrationCommit: candidate.integration!.commitSha, treeSha: candidate.integration!.treeSha },
            planSummary: { planDigest: DIGEST('p'), featureIds: candidate.leafFeatureIds }, manualBlock: false,
          },
          phaseScope: buildPhaseDeliveryScope({
            projectId: fixture.projectId, phaseId: 'phase-1',
            phaseRevision: (fixture.session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number }).revision,
            featureIds: ['feature-a', 'feature-b'],
            batches: [{ batchId: started.batchId, revision: 3, featureIds: ['feature-a', 'feature-b'] }],
            approvedInputs: candidate.approvedInputs,
            targetBaseline: candidate.targetBaseline,
            leaves: candidate.leaves.map(leaf => phaseScopeLeaf(leaf.featureId, {
              commitSha: leaf.commitSha, evidenceId: leaf.evidenceId, evidenceDigest: leaf.evidenceDigest,
              coveredInputs: leaf.coveredInputs, repoIdentity: leaf.repoIdentity, revision: leaf.revision,
            })),
          }),
        }) },
      });
      const result = await service.approve({
        projectId: fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, candidateId: candidate.candidateId,
        commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 3, expectedCandidateRevision: candidate.revision,
      });
      expect(result.status).toBe('approved');
      expect(fixture.session.database.prepare('SELECT delivery_status, delivery_approval_id, delivery_candidate_id, delivery_batch_id FROM phases WHERE id = ?').get('phase-1')).toMatchObject({
        delivery_status: 'approved', delivery_approval_id: candidate.candidateId === result.approval?.candidateId ? result.approval.approvalId : null,
        delivery_candidate_id: candidate.candidateId, delivery_batch_id: started.batchId,
      });
      expect(fixture.session.database.prepare("SELECT event_type, aggregate_type, aggregate_id FROM state_events WHERE event_type = 'phase.delivery.approved'").get()).toMatchObject({ event_type: 'phase.delivery.approved', aggregate_type: 'phase', aggregate_id: 'phase-1' });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_approvals').get()).toEqual({ count: 1 });
      expect(fixture.session.database.prepare("SELECT operation, status, command_id FROM command_receipts WHERE operation = 'phase.delivery.approve'").get()).toMatchObject({ operation: 'phase.delivery.approve', status: 'completed', command_id: 'approve-command-1' });
    } finally {
      fixture.close();
    }
  });

  it('[case:phase-delivery-approval-command-channel-phase-cas] 命令通道写入时复核冻结 Phase revision 与 Feature DAG 摘要，漂移即拒绝', async () => {
    const fixture = await openBudgetFixture();
    try {
      const started = await fixture.start();
      const batchReal = fixture.session.database.prepare('SELECT revision, status FROM execution_batches WHERE id = ?').get(started.batchId) as { revision: number; status: string };
      fixture.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(started.runId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      // 真实 DB 中 feature-a/b 为叶子，fixture 主 Feature 依前置存在；依赖边先不插入，用于隔离 DAG 漂移。
      const insertFeature = fixture.session.database.prepare(`INSERT OR IGNORE INTO features
        (id, created_at, project_id, updated_at, phase_id, title, status, plan_status, labels, source_refs, delivery_status)
        VALUES (?, ?, ?, ?, 'phase-1', ?, 'completed', 'approved', '[]', '[]', 'succeeded')`);
      insertFeature.run('feature-a', 1_900_000_000_000, fixture.projectId, 1_900_000_000_000, 'feature-a');
      insertFeature.run('feature-b', 1_900_000_000_000, fixture.projectId, 1_900_000_000_000, 'feature-b');

      const candidates = createSqliteBatchFinalizationCandidateStore(fixture.session, { nowUtcMs: () => 1_900_000_300_000 });
      const finalization = createBatchLeafFinalizationService({
        batches: { read: () => batch(fixture.projectId, started.batchId, { revision: batchReal.revision }) },
        leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
        candidates,
        integrate: async () => ({ status: 'succeeded' as const, commitSha: SHA('c'), treeSha: SHA('d'), evidenceId: 'integration-evidence', evidenceDigest: DIGEST('e'), workspacePreserved: true }),
        verify: async () => ({ status: 'passed' as const, evidenceId: 'verification-evidence', evidenceDigest: DIGEST('f') }),
      });
      const finalized = await finalization.run({ projectId: fixture.projectId, batchId: started.batchId, commandId: 'delivery-command-f012' });
      const candidate = candidates.read(fixture.projectId, started.batchId, 'delivery-command-f012')!;
      expect(finalized.candidate?.status).toBe('ready_for_phase_approval');

      const approvals = createSqlitePhaseDeliveryApprovalStore(fixture.session, { nowUtcMs: () => 1_900_000_400_000 });
      const phaseRow = fixture.session.database.prepare('SELECT revision FROM phases WHERE id = ?').get('phase-1') as { revision: number };
      const dependencies = [{ featureId: 'feature-a', dependsOnId: fixture.featureId }];
      const scopeWith = (phaseRevision: number) => buildPhaseDeliveryScope({
        projectId: fixture.projectId, phaseId: 'phase-1', phaseRevision,
        featureIds: [fixture.featureId, 'feature-a', 'feature-b'], dependencies,
        batches: [{ batchId: started.batchId, revision: batchReal.revision, featureIds: ['feature-a', 'feature-b'] }],
        approvedInputs: candidate.approvedInputs,
        targetBaseline: candidate.targetBaseline,
        leaves: candidate.leaves.map(leaf => phaseScopeLeaf(leaf.featureId, {
          commitSha: leaf.commitSha, evidenceId: leaf.evidenceId, evidenceDigest: leaf.evidenceDigest,
          coveredInputs: leaf.coveredInputs, repoIdentity: leaf.repoIdentity, revision: leaf.revision,
        })),
      });
      const snapshotWith = (phaseRevision: number) => ({
        candidate,
        batch: {
          projectId: fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, revision: batchReal.revision, status: 'succeeded' as const, approved: true,
          scopeDigest: candidate.scopeDigest, inputDigest: candidate.inputDigest,
          budgetSummary: { budgetRevision: 1, attemptsUsed: 1, deadlineAt: 1_900_000_000_000 },
          stopSummary: { status: 'confirmed' as const, digest: DIGEST('q') },
          codeSummary: { targetBaseline: candidate.targetBaseline }, planSummary: { featureIds: candidate.leafFeatureIds }, manualBlock: false,
        },
        phaseScope: scopeWith(phaseRevision),
      });
      const approveVia = (service: ReturnType<typeof createPhaseDeliveryApprovalService>, commandId: string) => service.approve({
        projectId: fixture.projectId, phaseId: 'phase-1', batchId: started.batchId, candidateId: candidate.candidateId,
        commandId, actorId: 'owner-1', expectedBatchRevision: batchReal.revision, expectedCandidateRevision: candidate.revision,
        commandContext: { requestDigest: DIGEST('3'), issuedAt: new Date(1_900_000_350_000).toISOString() },
      });

      // 快照声明 a→fixture 依赖边；DB 尚无该边，但 Phase revision 漂移先被拒绝。
      const stalePhase = createPhaseDeliveryApprovalService({ approvals, snapshots: { read: () => snapshotWith(phaseRow.revision + 1) } });
      await expect(approveVia(stalePhase, 'f012-phase-stale')).rejects.toThrow(/Phase revision 已漂移/);
      expect(fixture.session.database.prepare('SELECT delivery_status FROM phases WHERE id = ?').get('phase-1')).toEqual({ delivery_status: 'not_requested' });

      // Phase revision 一致，但快照声明的 DAG 与真实 DB 不一致：拒绝。
      const dagDrift = createPhaseDeliveryApprovalService({ approvals, snapshots: { read: () => snapshotWith(phaseRow.revision) } });
      await expect(approveVia(dagDrift, 'f012-dag-stale')).rejects.toThrow(/Feature DAG 已漂移/);
      expect(fixture.session.database.prepare('SELECT delivery_status FROM phases WHERE id = ?').get('phase-1')).toEqual({ delivery_status: 'not_requested' });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_approvals').get()).toEqual({ count: 0 });

      // 补齐真实依赖边后，冻结事实与 DB 一致，命令通道批准成功。
      fixture.session.database.prepare(`INSERT INTO feature_dependencies
        (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id)
        VALUES ('dep-f012', 1_900_000_000_000, ?, 1, 1_900_000_000_000, 'phase-1', 'feature-a', ?)`)
        .run(fixture.projectId, fixture.featureId);
      const exact = createPhaseDeliveryApprovalService({ approvals, snapshots: { read: () => snapshotWith(phaseRow.revision) } });
      const approved = await approveVia(exact, 'f012-phase-approve');
      expect(approved.status).toBe('approved');
      expect(fixture.session.database.prepare('SELECT delivery_status, delivery_candidate_id FROM phases WHERE id = ?').get('phase-1')).toEqual({
        delivery_status: 'approved', delivery_candidate_id: candidate.candidateId,
      });
      const persisted = fixture.session.database.prepare('SELECT phase_revision, dag_digest FROM phase_delivery_approvals WHERE candidate_id = ?').get(candidate.candidateId) as { phase_revision: number; dag_digest: string };
      expect(persisted).toMatchObject({ phase_revision: phaseRow.revision, dag_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    } finally {
      fixture.close();
    }
  });
});
