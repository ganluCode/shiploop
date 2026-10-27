import { describe, expect, it, vi } from 'vitest';
import {
  createBatchLeafFinalizationService,
  type BatchFinalizationBatchSnapshot,
  type BatchFinalizationLeafEvidence,
  type BatchFinalizationCandidateStore,
} from '../../../packages/core/src/application/batch-leaf-finalization.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function snapshot(overrides: Partial<BatchFinalizationBatchSnapshot> = {}): BatchFinalizationBatchSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    revision: 3,
    status: 'succeeded',
    approved: true,
    featureIds: ['feature-a', 'feature-b'],
    dependencies: [],
    targetBaseline: SHA('b'),
    approvedInputs: [
      { inputId: 'input-a', digest: DIGEST('a') },
      { inputId: 'input-b', digest: DIGEST('b') },
    ],
    verificationScope: ['combined-tests', 'typecheck'],
    strategySummary: { mode: 'deterministic' },
    ...overrides,
  };
}

function evidence(featureId: string, letter: string, overrides: Partial<BatchFinalizationLeafEvidence> = {}): BatchFinalizationLeafEvidence {
  return {
    featureId,
    featureStatus: 'completed',
    deliveryStatus: 'succeeded',
    revision: 4,
    commitSha: SHA(letter),
    repoIdentity: 'repo-1',
    coveredInputs: [{ inputId: `input-${letter}`, digest: DIGEST(letter) }],
    evidenceId: `delivery-${featureId}`,
    evidenceDigest: DIGEST(letter),
    evidenceFresh: true,
    commitExists: true,
    branchHead: SHA(letter),
    ...overrides,
  };
}

function store(): BatchFinalizationCandidateStore & {
  candidates: Map<string, any>;
  create: ReturnType<typeof vi.fn>;
  recordIntegration: ReturnType<typeof vi.fn>;
  recordVerification: ReturnType<typeof vi.fn>;
} {
  const candidates = new Map<string, any>();
  const create = vi.fn((candidate: any) => {
    const previous = candidates.get(candidate.candidateId);
    if (previous) return previous;
    candidates.set(candidate.candidateId, candidate);
    return candidate;
  });
  const recordIntegration = vi.fn((candidateId: string, result: any) => {
    const next = { ...candidates.get(candidateId), integration: result, status: result.status === 'succeeded' ? 'awaiting_verification' : result.status === 'unknown' ? 'reconciliation_required' : 'blocked' };
    candidates.set(candidateId, next);
    return next;
  });
  const recordVerification = vi.fn((candidateId: string, result: any) => {
    const next = { ...candidates.get(candidateId), verification: result, status: result.status === 'passed' ? 'ready_for_phase_approval' : 'blocked' };
    candidates.set(candidateId, next);
    return next;
  });
  return { candidates, create, recordIntegration, recordVerification, read: vi.fn((projectId: string, batchId: string, commandId: string) => [...candidates.values()].find(candidate => candidate.projectId === projectId && candidate.batchId === batchId && candidate.commandId === commandId) ?? null), createCandidate: create, recordIntegrationResult: recordIntegration, recordVerificationResult: recordVerification } as unknown as BatchFinalizationCandidateStore & any;
}

describe('P05-9 F-002 parallel leaf finalization', () => {
  it('[case:leaf-finalization-freezes-all-leaves] enumerates leaves and persists one immutable candidate with fixed inputs', async () => {
    const persistence = store();
    const service = createBatchLeafFinalizationService({
      batches: { read: () => snapshot() },
      leaves: { read: (_project, featureId) => featureId === 'feature-a' ? evidence(featureId, 'a') : evidence(featureId, 'b') },
      candidates: persistence,
    });

    const result = await service.prepare({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });

    expect(result.status).toBe('candidate_created');
    expect(result.candidate?.leafFeatureIds).toEqual(['feature-a', 'feature-b']);
    expect(result.candidate?.mergeOrder).toEqual(['feature-a', 'feature-b']);
    expect(result.candidate?.targetBaseline).toBe(SHA('b'));
    expect(result.candidate?.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persistence.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.candidate)).not.toContain('branchHead');
  });

  it.each([
    ['missing', { commitSha: null, commitExists: false }],
    ['failed', { featureStatus: 'failed' as const }],
    ['stale', { evidenceFresh: false }],
    ['drift', { branchHead: SHA('c') }],
  ])('[case:leaf-finalization-blocks-%s] rejects unsafe leaf evidence with structured reasons', async (_name, patch) => {
    const persistence = store();
    const service = createBatchLeafFinalizationService({
      batches: { read: () => snapshot() },
      leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b', patch) },
      candidates: persistence,
    });

    const result = await service.prepare({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });

    expect(result.status).toBe('blocked');
    expect(result.blockReasons.length).toBeGreaterThan(0);
    expect(persistence.create).not.toHaveBeenCalled();
  });

  it('[case:leaf-finalization-runs-integration-and-verification] produces approval candidate only after both external stages pass', async () => {
    const persistence = store();
    const integrate = vi.fn(async () => ({ status: 'succeeded' as const, commitSha: SHA('d'), treeSha: SHA('e'), evidenceId: 'git-evidence', evidenceDigest: DIGEST('e'), workspacePreserved: true }));
    const verify = vi.fn(async () => ({ status: 'passed' as const, evidenceId: 'combined-result', evidenceDigest: DIGEST('f') }));
    const service = createBatchLeafFinalizationService({
      batches: { read: () => snapshot() },
      leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
      candidates: persistence,
      integrate,
      verify,
    });

    const result = await service.run({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });

    expect(result.status).toBe('ready_for_phase_approval');
    expect(integrate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(persistence.recordIntegration).toHaveBeenCalledTimes(1);
    expect(persistence.recordVerification).toHaveBeenCalledTimes(1);
  });

  it('[case:leaf-finalization-replays-command] repeats the stored fact without integrating again', async () => {
    const persistence = store();
    const integrate = vi.fn(async () => ({ status: 'succeeded' as const, commitSha: SHA('d'), treeSha: SHA('e'), evidenceId: 'git-evidence', evidenceDigest: DIGEST('e'), workspacePreserved: true }));
    const verify = vi.fn(async () => ({ status: 'passed' as const, evidenceId: 'combined-result', evidenceDigest: DIGEST('f') }));
    const service = createBatchLeafFinalizationService({
      batches: { read: () => snapshot() },
      leaves: { read: (_project, featureId) => evidence(featureId, featureId === 'feature-a' ? 'a' : 'b') },
      candidates: persistence,
      integrate,
      verify,
    });

    const first = await service.run({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });
    const replay = await service.run({ projectId: 'project-1', batchId: 'batch-1', commandId: 'command-1' });

    expect(replay).toEqual(first);
    expect(integrate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
