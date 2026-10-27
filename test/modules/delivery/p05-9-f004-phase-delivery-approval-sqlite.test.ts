import { describe, expect, it } from 'vitest';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { createSqlitePhaseDeliveryApprovalStore } from '../../../packages/core/src/adapters/sqlite/phase-delivery-approval-store.ts';
import { createBatchLeafFinalizationService, type BatchFinalizationBatchSnapshot, type BatchFinalizationLeafEvidence } from '../../../packages/core/src/application/batch-leaf-finalization.ts';
import { createPhaseDeliveryApprovalService } from '../../../packages/core/src/application/phase-delivery-approval.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function batch(projectId: string, batchId: string): BatchFinalizationBatchSnapshot {
  return {
    schemaVersion: 1, projectId, phaseId: 'phase-1', batchId, revision: 3, status: 'succeeded', approved: true,
    featureIds: ['feature-a', 'feature-b'], dependencies: [], targetBaseline: SHA('b'),
    approvedInputs: [{ inputId: 'input-a', digest: DIGEST('a') }, { inputId: 'input-b', digest: DIGEST('b') }],
    verificationScope: ['combined-tests'], strategySummary: { mode: 'deterministic' },
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
});
