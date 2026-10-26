import { describe, expect, it } from 'vitest';
import { createSqliteBatchFinalizationCandidateStore } from '../../../packages/core/src/adapters/sqlite/batch-finalization-candidate-store.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import {
  createBatchLeafFinalizationService,
  type BatchFinalizationBatchSnapshot,
  type BatchFinalizationLeafEvidence,
  type BatchFinalizationCandidateStore,
} from '../../../packages/core/src/application/batch-leaf-finalization.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function snapshot(status: BatchFinalizationBatchSnapshot['status']): BatchFinalizationBatchSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    revision: 3,
    status,
    approved: true,
    featureIds: ['feature-a', 'feature-b'],
    dependencies: [],
    targetBaseline: SHA('b'),
    approvedInputs: [
      { inputId: 'input-a', digest: DIGEST('a') },
      { inputId: 'input-b', digest: DIGEST('b') },
    ],
    verificationScope: ['combined-tests'],
    strategySummary: { mode: 'deterministic' },
  };
}

function evidence(featureId: string, letter: string): BatchFinalizationLeafEvidence {
  return {
    featureId,
    featureStatus: 'completed',
    deliveryStatus: 'succeeded',
    revision: 4,
    commitSha: SHA(letter),
    repoIdentity: 'repo-1',
    coveredInputs: [{ inputId: `input-${letter}`, digest: DIGEST(letter) }],
    evidenceId: `evidence-${featureId}`,
    evidenceDigest: DIGEST(letter),
    evidenceFresh: true,
    commitExists: true,
    branchHead: SHA(letter),
  };
}

function store(): BatchFinalizationCandidateStore {
  const candidates = new Map<string, any>();
  return {
    read: (projectId, batchId, commandId) => [...candidates.values()].find(candidate =>
      candidate.projectId === projectId && candidate.batchId === batchId && candidate.commandId === commandId) ?? null,
    createCandidate: candidate => {
      candidates.set(candidate.candidateId, candidate);
      return candidate;
    },
    recordIntegrationResult: (candidateId, result) => {
      const current = candidates.get(candidateId)!;
      const next = { ...current, integration: result, status: result.status === 'succeeded' ? 'awaiting_verification' : 'blocked' };
      candidates.set(candidateId, next);
      return next;
    },
    recordVerificationResult: (candidateId, result) => {
      const current = candidates.get(candidateId)!;
      const next = { ...current, verification: result, status: result.status === 'passed' ? 'ready_for_phase_approval' : 'blocked' };
      candidates.set(candidateId, next);
      return next;
    },
  };
}

describe('P05-9 F-003 batch delivery lifecycle gates', () => {
  it.each(['queued', 'running'] as const)('[case:delivery-candidate-requires-terminal-batch] does not create a Phase candidate for a %s Batch', async status => {
    const persistence = store();
    const service = createBatchLeafFinalizationService({
      batches: { read: () => snapshot(status) },
      leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
      candidates: persistence,
    });

    const result = await service.prepare({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });

    expect(result).toEqual({ status: 'blocked', blockReasons: ['batch_not_terminal'], candidate: null });
  });

  it('[case:delivery-candidate-persists-cas-and-replays] persists the frozen candidate and serializes lifecycle transitions with revision CAS', async () => {
    const fixture = await openBudgetFixture();
    try {
      const started = await fixture.start();
      fixture.session.database.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(started.runId);
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'succeeded' WHERE id = ?").run(started.batchId);
      const stored = createSqliteBatchFinalizationCandidateStore(fixture.session, { nowUtcMs: () => 1_900_000_200_000 });
      const batch = { ...snapshot('succeeded'), projectId: fixture.projectId, phaseId: 'phase-1', batchId: started.batchId };
      const service = createBatchLeafFinalizationService({
        batches: { read: () => batch },
        leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
        candidates: stored,
        integrate: async () => ({ status: 'succeeded' as const, commitSha: SHA('d'), treeSha: SHA('e'), evidenceId: 'git-evidence', evidenceDigest: DIGEST('e'), workspacePreserved: true }),
        verify: async () => ({ status: 'passed' as const, evidenceId: 'combined-evidence', evidenceDigest: DIGEST('f') }),
      });

      const first = await service.run({ projectId: fixture.projectId, batchId: started.batchId, commandId: 'delivery-command-1' });
      expect(first.status).toBe('ready_for_phase_approval');
      expect(stored.read(fixture.projectId, started.batchId, 'delivery-command-1')).toMatchObject({
        status: 'ready_for_phase_approval',
        batchId: started.batchId,
        workspacePreserved: true,
      });
      const replay = await service.run({ projectId: fixture.projectId, batchId: started.batchId, commandId: 'delivery-command-1' });
      expect(replay).toEqual(first);
      expect(fixture.session.database.prepare('SELECT revision, status FROM phase_delivery_candidates WHERE project_id = ? AND batch_id = ?').get(fixture.projectId, started.batchId))
        .toEqual({ revision: 3, status: 'ready_for_phase_approval' });
      expect(fixture.session.database.prepare('SELECT COUNT(*) AS count FROM phase_delivery_candidates').get()).toEqual({ count: 1 });
    } finally {
      fixture.close();
    }
  });
});
