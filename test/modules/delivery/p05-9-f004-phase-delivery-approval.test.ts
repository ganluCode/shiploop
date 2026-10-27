import { describe, expect, it } from 'vitest';
import {
  createPhaseDeliveryApprovalService,
  type PhaseDeliveryApprovalCandidateSnapshot,
  type PhaseDeliveryApprovalRecord,
  type PhaseDeliveryApprovalStore,
} from '../../../packages/core/src/application/phase-delivery-approval.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

function candidate(overrides: Partial<PhaseDeliveryApprovalCandidateSnapshot> = {}): PhaseDeliveryApprovalCandidateSnapshot {
  return {
    schemaVersion: 1,
    revision: 3,
    candidateId: 'candidate-1',
    commandId: 'delivery-command-1',
    projectId: 'project-1',
    phaseId: 'phase-1',
    batchId: 'batch-1',
    batchRevision: 4,
    scopeDigest: DIGEST('s'),
    inputDigest: DIGEST('i'),
    targetBaseline: SHA('b'),
    approvedInputs: [{ inputId: 'input-1', digest: DIGEST('a') }],
    leafFeatureIds: ['feature-a', 'feature-b'],
    mergeOrder: ['feature-a', 'feature-b'],
    leaves: [
      { featureId: 'feature-a', revision: 2, commitSha: SHA('c'), repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: DIGEST('a') }], evidenceId: 'evidence-a', evidenceDigest: DIGEST('e') },
      { featureId: 'feature-b', revision: 2, commitSha: SHA('d'), repoIdentity: 'repo-1', coveredInputs: [{ inputId: 'input-1', digest: DIGEST('a') }], evidenceId: 'evidence-b', evidenceDigest: DIGEST('f') },
    ],
    verificationScope: ['combined-tests'],
    strategySummary: { mode: 'deterministic' },
    status: 'ready_for_phase_approval',
    integration: { status: 'succeeded', commitSha: SHA('g'), treeSha: SHA('t'), evidenceId: 'integration-evidence', evidenceDigest: DIGEST('g'), workspacePreserved: true },
    verification: { status: 'passed', evidenceId: 'verification-evidence', evidenceDigest: DIGEST('h') },
    workspacePreserved: true,
    ...overrides,
  };
}

function snapshot(candidateValue = candidate()) {
  return {
    candidate: candidateValue,
    batch: {
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', revision: 4,
      status: 'succeeded' as const, approved: true,
      scopeDigest: DIGEST('s'), inputDigest: DIGEST('i'),
      budgetSummary: { budgetRevision: 2, maxAttempts: 4, attemptsUsed: 2, deadlineAt: 1_900_000_000_000 },
      stopSummary: { status: 'confirmed' as const, digest: DIGEST('q') },
      codeSummary: { targetBaseline: SHA('b'), integrationCommit: SHA('g'), treeSha: SHA('t') },
      planSummary: { planDigest: DIGEST('p'), featureIds: ['feature-a', 'feature-b'] },
      manualBlock: false,
    },
  };
}

function store() {
  let record: PhaseDeliveryApprovalRecord | null = null;
  const calls = { create: 0, invalidate: 0 };
  const value: PhaseDeliveryApprovalStore = {
    read: () => record,
    create: input => { calls.create += 1; record = input; return input; },
    invalidate: (approval, reason) => { calls.invalidate += 1; record = { ...approval, status: 'invalidated', invalidationReason: reason }; return record; },
  };
  return { value, calls, get record() { return record; } };
}

describe('P05-9 F-004 Phase delivery approval', () => {
  it('[case:phase-delivery-approval-binds-frozen-summary] approves only a fresh verified candidate and stores all delivery identities', async () => {
    const persistence = store();
    const service = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot() },
      approvals: persistence.value,
    });

    const result = await service.approve({
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', candidateId: 'candidate-1',
      commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 4, expectedCandidateRevision: 3,
    });

    expect(result.status).toBe('approved');
    expect(result.approval).toMatchObject({
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', candidateId: 'candidate-1',
      candidateRevision: 3, batchRevision: 4, integrationCommitSha: SHA('g'), treeSha: SHA('t'),
      verificationEvidenceId: 'verification-evidence', budgetSummary: snapshot().batch.budgetSummary,
      codeSummary: snapshot().batch.codeSummary, planSummary: snapshot().batch.planSummary,
      status: 'approved', actorId: 'owner-1',
    });
    expect(persistence.calls.create).toBe(1);
  });

  it('[case:phase-delivery-approval-rejects-stale-and-blocked] invalidates an existing approval when the current summary is stale or manually blocked', async () => {
    const persistence = store();
    const current = snapshot();
    persistence.value.read = () => persistence.record;
    const service = createPhaseDeliveryApprovalService({
      snapshots: { read: () => ({ ...current, batch: { ...current.batch, revision: 5, manualBlock: true } }) },
      approvals: persistence.value,
    });

    const first = await service.approve({
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', candidateId: 'candidate-1',
      commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 4, expectedCandidateRevision: 3,
    });

    expect(first).toMatchObject({ status: 'rejected', reason: 'stale_revision' });
    expect(persistence.calls.create).toBe(0);
  });

  it('[case:phase-delivery-approval-rejects-duplicate-and-cross-phase] keeps existing facts on duplicate and foreign references', async () => {
    const persistence = store();
    const service = createPhaseDeliveryApprovalService({ snapshots: { read: () => snapshot() }, approvals: persistence.value });
    const request = { projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', candidateId: 'candidate-1', commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 4, expectedCandidateRevision: 3 } as const;
    expect((await service.approve(request)).status).toBe('approved');
    const duplicate = await service.approve({ ...request, commandId: 'approve-command-2', actorId: 'owner-2' });
    expect(duplicate).toMatchObject({ status: 'rejected', reason: 'already_approved' });
    const foreign = await service.approve({ ...request, phaseId: 'phase-2', commandId: 'approve-command-3' });
    expect(foreign).toMatchObject({ status: 'rejected', reason: 'cross_phase' });
    expect(persistence.calls.create).toBe(1);
  });

  it('[case:phase-delivery-approval-rejects-empty-summary] rejects an empty leaf summary without changing the approval store', async () => {
    const persistence = store();
    const service = createPhaseDeliveryApprovalService({
      snapshots: { read: () => snapshot(candidate({ leafFeatureIds: [], leaves: [], mergeOrder: [] })) },
      approvals: persistence.value,
    });
    const result = await service.approve({
      projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', candidateId: 'candidate-1',
      commandId: 'approve-command-1', actorId: 'owner-1', expectedBatchRevision: 4, expectedCandidateRevision: 3,
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'empty_summary' });
    expect(persistence.calls.create).toBe(0);
  });
});
