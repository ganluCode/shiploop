import { describe, expect, it, vi } from 'vitest';
import { createIntegrationVerificationService } from '../../../packages/core/src/application/integration-verification.ts';
import type { VerificationPlan } from '../../../packages/core/src/ports/verification-plan.ts';

const SHA = (letter: string) => letter.repeat(40);
const DIGEST = (letter: string) => letter.repeat(64);

const verificationPlan: VerificationPlan = {
  status: 'ready', mode: 'full_fallback', affectedModules: ['core'], coveredModules: ['core'],
  selectedCheckKeys: ['combined'], selectedChecks: [{ checkKey: 'combined', scope: 'project', kind: 'command',
    argv: ['node', 'verify.js'], cwdRef: null, environmentRef: null, timeout: 1000, required: true, requirementRefs: ['core'] }],
  unselectedCheckKeys: [], reasonCode: 'candidate_missing', reason: 'combined verification', candidateDigest: null,
  candidateRejection: { reason: 'candidate_missing', detail: 'combined' },
};

function fixture() {
  const executionPlan = { integrationId: 'execution-plan-1', target: { baseCommit: SHA('b') }, mergeOrder: ['feature-a'], inputDigest: DIGEST('e') };
  const workspace = {
    workspaceId: 'workspace-1', ownerId: 'owner-1', ownerVersion: 1, path: '/tmp/integration', gitCommonDir: '/tmp/.git',
    repoIdentity: 'repo-1', targetBase: SHA('b'), plan: executionPlan, status: 'succeeded', currentHead: SHA('c'), steps: [{ ordinal: 1,
      featureId: 'feature-a', inputSha: SHA('a'), parentBefore: SHA('b'), parents: [SHA('b'), SHA('a')], commitSha: SHA('c'), treeSha: SHA('d'), status: 'succeeded' }],
    facts: { head: SHA('c'), tree: SHA('d'), parents: [SHA('b'), SHA('a')], statusPorcelain: '', unresolvedPaths: [] },
  };
  const operation = {
    intent: { operationId: 'operation-1', operationType: 'integration', ownerId: 'owner-1', budgetSnapshot: { sourcePlanId: 'source-plan-1', sourcePlanRevision: 3, ownerVersion: 1 }, integrationPlan: executionPlan },
    status: 'pending', revision: 7, intentDigest: DIGEST('i'), actualCommit: null, actualTree: null, integrationResult: null,
  } as any;
  const sourcePlan = {
    integrationId: 'source-plan-1', revision: 4, frozenAtUtcMs: 10, targetBaseline: SHA('b'), inputDigest: 'c'.repeat(64),
    integrationResult: { operationId: 'operation-1', ownerId: 'owner-1', ownerVersion: 1, operationStatus: 'pending', commitSha: null, treeSha: null, verificationEvidence: null, llmNoConflictText: null },
    verificationScope: ['combined'],
    blockReasons: [], staleReasons: [], status: 'blocked',
  } as any;
  const state = { operation, sourcePlan, sourceResult: null as any, finalized: null as any, statuses: [] as unknown[] };
  const tx = {
    getGitOperation: () => state.operation,
    getIntegrationPlan: () => state.sourcePlan,
    updateIntegrationPlanResult: vi.fn((input: any) => {
      state.sourceResult = input.integrationResult;
      state.sourcePlan = { ...state.sourcePlan, revision: state.sourcePlan.revision + 1, integrationResult: input.integrationResult, status: 'integration_passed' };
      return state.sourcePlan;
    }),
    updateIntegrationPlanStatus: vi.fn((input: any) => {
      state.sourcePlan = { ...state.sourcePlan, revision: state.sourcePlan.revision + 1, status: input.status, blockReasons: input.blockReasons };
      return state.sourcePlan;
    }),
    finalizeGitOperation: vi.fn((input: any) => {
      state.finalized = input;
      state.operation = { ...state.operation, status: input.status, revision: state.operation.revision + 1, integrationResult: input.integrationResult ?? null };
      return { operation: state.operation, settled: true };
    }),
  } as any;
  const atomic = { transact: vi.fn((_operation: string, callback: (tx: any) => unknown) => callback(tx)) } as any;
  const journal = { read: vi.fn(() => ({ outcome: 'pending_verification', reason: null, workspace, steps: workspace.steps })) } as any;
  return { executionPlan, workspace, operation, sourcePlan, state, tx, atomic, journal };
}

function request() {
  return { projectId: 'project-1', operationId: 'operation-1', ownerId: 'owner-1', ownerVersion: 1,
    verificationPlan, targets: ['combined'] } as const;
}

describe('P05-7 F-005 integration verification', () => {
  it('[case:integration-verification-settles-source-plan-and-operation-atomically] uses the journal candidate and writes both digest domains in one settlement', async () => {
    const f = fixture();
    const executor = { start: vi.fn(async () => ({ status: 'passed' as const, stopped: true,
      commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: 'c'.repeat(64), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: 'a'.repeat(64) }, verificationResult: { id: 'result-ref', digest: 'b'.repeat(64) } })) };
    const service = createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true, nowUtcMs: () => 99 });
    const result = await service.run(request());
    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'passed', reason: 'verified' });
    expect(executor.start).toHaveBeenCalledWith(expect.objectContaining({ sourcePlanId: 'source-plan-1', inputDigest: 'c'.repeat(64), workspace: f.workspace }));
    expect(f.tx.updateIntegrationPlanResult).toHaveBeenCalledTimes(1);
    expect(f.tx.finalizeGitOperation).toHaveBeenCalledTimes(1);
    expect(f.state.sourceResult.verificationEvidence).toEqual({ evidenceId: 'result-ref', evidenceDigest: 'b'.repeat(64),
      planRef: { id: 'plan-ref', digest: 'a'.repeat(64) }, resultRef: { id: 'result-ref', digest: 'b'.repeat(64) } });
    expect(f.state.finalized.integrationResult.inputDigest).toBe(DIGEST('e'));
    expect(f.state.finalized.integrationResult.inputDigest).not.toBe(DIGEST('s'));
    expect(result.integration?.status).toBe('integration_passed');
    const replay = await service.run(request());
    expect(replay).toMatchObject({ outcome: 'passed', reason: 'verified' });
    expect(executor.start).toHaveBeenCalledTimes(1);
  });

  it('[case:integration-verification-failed-retains-workspace-and-does-not-unlock] records a failed verification as blocked', async () => {
    const f = fixture();
    const executor = { start: async () => ({ status: 'failed' as const, stopped: true,
      commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: 'c'.repeat(64), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: 'a'.repeat(64) }, verificationResult: { id: 'result-ref', digest: 'b'.repeat(64) } }) };
    await createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true }).run(request());
    expect(f.state.finalized.status).toBe('failed');
    expect(f.state.finalized.workspacePreserved).toBe(true);
    expect(f.tx.updateIntegrationPlanStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', blockReasons: ['verification_failed'] }));
  });

  it('[case:integration-verification-binds-frozen-identities-and-evidence-references] publishes the Core-bound integration identity and both immutable evidence references', async () => {
    const f = fixture();
    const executor = { start: async () => ({ status: 'passed' as const, stopped: true,
      integrationId: 'execution-plan-1', targetBaseline: SHA('b'), commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: 'c'.repeat(64), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: 'a'.repeat(64) }, verificationResult: { id: 'result-ref', digest: 'b'.repeat(64) } }) };
    const result = await createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true }).run(request());
    expect(result.outcome).toBe('passed');
    expect(f.state.sourceResult).toMatchObject({ integrationId: 'execution-plan-1', inputDigest: 'c'.repeat(64), targetBaseline: SHA('b'),
      verificationEvidence: { planRef: { id: 'plan-ref', digest: 'a'.repeat(64) }, resultRef: { id: 'result-ref', digest: 'b'.repeat(64) } } });
    expect(f.state.finalized.integrationResult).toMatchObject({ integrationId: 'execution-plan-1', inputDigest: DIGEST('e'), targetBaseline: SHA('b'),
      verificationEvidence: { planRef: { id: 'plan-ref', digest: 'a'.repeat(64) }, resultRef: { id: 'result-ref', digest: 'b'.repeat(64) } } });
  });

  it('[case:integration-verification-rejects-frozen-check-scope-drift] keeps the operation pending when the requested checks differ from the frozen plan', async () => {
    const f = fixture();
    const executor = { start: vi.fn(async () => ({ status: 'passed' as const, stopped: true,
      commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: 'c'.repeat(64), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: 'a'.repeat(64) }, verificationResult: { id: 'result-ref', digest: 'b'.repeat(64) } })) };
    const service = createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true });
    const result = await service.run({ ...request(), targets: ['other-check'] });
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'verification_plan_unavailable' });
    expect(executor.start).not.toHaveBeenCalled();
    expect(f.tx.finalizeGitOperation).not.toHaveBeenCalled();
  });

  it('[case:integration-verification-rejects-result-identity-drift] blocks a verifier result whose explicit integration identity differs', async () => {
    const f = fixture();
    const executor = { start: async () => ({ status: 'passed' as const, stopped: true,
      integrationId: 'wrong-integration', commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: 'c'.repeat(64), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: 'a'.repeat(64) }, verificationResult: { id: 'result-ref', digest: 'b'.repeat(64) } }) };
    const result = await createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true }).run(request());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'verification_evidence_incomplete' });
    expect(f.tx.finalizeGitOperation).not.toHaveBeenCalled();
    expect(f.tx.updateIntegrationPlanStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', blockReasons: ['integration_evidence_incomplete'] }));
  });

  it.each(['failure', 'late-success'] as const)(
    '[case:integration-verification-late-%s-fenced] never publishes or changes the plan after authorization is revoked', async mode => {
      const f = fixture();
      let authorized = true;
      const executor = { start: async () => {
        authorized = false;
        if (mode === 'failure') throw new Error('late verifier failure');
        return { status: 'passed' as const, stopped: true, commitSha: SHA('c'), treeSha: SHA('d'),
          inputDigest: 'c'.repeat(64), targetBase: SHA('b'), verificationPlan: { id: 'plan-ref', digest: DIGEST('a') },
          verificationResult: { id: 'result-ref', digest: DIGEST('b') } };
      } };
      const result = await createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal,
        executor, readAuthorization: () => authorized }).run(request());
      expect(result.outcome).toBe('blocked');
      expect(f.tx.updateIntegrationPlanStatus).not.toHaveBeenCalled();
      expect(f.tx.updateIntegrationPlanResult).not.toHaveBeenCalled();
      expect(f.tx.finalizeGitOperation).not.toHaveBeenCalled();
    });

  it('[case:integration-verification-stop-unconfirmed-keeps-pending-facts] blocks without settling the Git operation', async () => {
    const f = fixture();
    const executor = { start: async () => ({ status: 'passed' as const, stopped: false,
      commitSha: SHA('c'), treeSha: SHA('d'), inputDigest: DIGEST('s'), targetBase: SHA('b'),
      verificationPlan: { id: 'plan-ref', digest: DIGEST('p') }, verificationResult: { id: 'result-ref', digest: DIGEST('r') } }) };
    const result = await createIntegrationVerificationService({ atomic: f.atomic, journal: f.journal, executor, readAuthorization: () => true }).run(request());
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'verification_stop_unconfirmed' });
    expect(f.tx.finalizeGitOperation).not.toHaveBeenCalled();
    expect(f.tx.updateIntegrationPlanStatus).toHaveBeenCalledWith(expect.objectContaining({ blockReasons: ['verification_stop_unconfirmed'] }));
  });
});
