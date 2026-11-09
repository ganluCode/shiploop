import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createGitAgentIntegrationRepairConsumer, gitAgentIntegrationFailureAllowed, createGitAgentIntegrationEvidencePublisher } from '../../../packages/core/src/application/git-agent-integration-repair.ts';
import { createGitAgentCandidateFinalizationService } from '../../../packages/core/src/application/git-agent-candidate-finalization.ts';
import { createGitAgentRepairRequest, computeGitAgentRepairBaselineDigest } from '../../../packages/core/src/ports/git-agent-repair.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { gitAgentIntegrationCommitPlan, gitAgentIntegrationCommitResult } from '../../../packages/core/src/ports/git-agent-integration-commit.ts';
import { gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import type { GitOperationRecord } from '../../../packages/core/src/ports/git-operations.ts';
import type { GitAgentRepairClaim, GitAgentRepairView } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import type { GitAgentCandidateFinalizationDependencies } from '../../../packages/core/src/application/git-agent-candidate-finalization.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';
import type { GitAgentRuntimeRequest, GitAgentRuntimeHandle } from '../../../packages/core/src/ports/git-agent-runtime.ts';
import type { AtomicCommandStore } from '../../../packages/core/src/ports/atomic-commands.ts';

const sha = (c: string) => c.repeat(40), digest = (c: string) => c.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
function fixture() {
  const approvedInputs = [{ inputId: 'input-1', digest: digest('1') }];
  const sourcePlan = createIntegrationExecutionPlan({ projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'source-run', successorFeatureId: 'feature-1',
    target: { repoIdentity: 'repo-1', baseCommit: sha('a'), canonicalPath: '/managed/source', gitCommonDir: '/managed/source/.git' },
    predecessors: [{ projectId: 'project-1', phaseId: 'phase-1', batchId: 'batch-1', runId: 'source-run', featureId: 'predecessor-1', dependencyPassed: true,
      coveredInputIds: ['input-1'], delivery: { commitSha: sha('b'), repoIdentity: 'repo-1', inputDigest: computeCoveredInputDigest(approvedInputs), evidenceId: 'delivery-1', evidenceDigest: digest('2') } }],
    approvedInputs, mergeOrder: ['predecessor-1'], verificationScope: ['check-1'], integrationResult: null });
  const source = { intent: { operationId: sourcePlan.integrationId, projectId: 'project-1', runId: 'source-run', featureId: 'feature-1', operationType: 'integration',
    integrationPlan: sourcePlan, expectedHead: sha('a'), repoIdentity: 'repo-1', worktreePath: '/managed/integration', ownerId: 'source-owner',
    budgetSnapshot: { sourcePlanId: 'business-plan', ownerVersion: 1 } },
    intentDigest: digest('3'), status: 'failed', workspacePreserved: true, reasonCode: 'merge_conflict', receipt: { status: 'failed' } } as unknown as GitOperationRecord;
  const request = createGitAgentRepairRequest({ projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'source-run', repairId: 'repair-1', commandId: 'command-1',
    source: { projectId: 'project-1', phaseId: 'phase-1', parentBatchId: 'batch-1', featureId: 'feature-1', runId: 'source-run', integrationId: sourcePlan.integrationId,
      operationId: source.intent.operationId, operationType: 'integration', operationDigest: source.intentDigest, inputDigest: sourcePlan.inputDigest,
      failureKind: 'conflict', evidenceId: source.intent.operationId, evidenceDigest: hash(source.receipt) },
    target: { repoIdentity: 'repo-1', baselineCommitSha: sha('a'), baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: 'repo-1', baselineCommitSha: sha('a') }) },
    workspace: { workspaceId: sourcePlan.integrationId, workspaceDigest: hash({ repoIdentity: 'repo-1', worktreePath: '/managed/integration', inputDigest: sourcePlan.inputDigest, baselineCommitSha: sha('a') }) }, conflictFiles: ['src/a.ts'], writablePaths: ['src/a.ts'],
    intent: { intentId: 'intent-1', digest: digest('5') }, verification: { strategyId: 'strategy-1', digest: digest('6') },
    budget: { remainingAttempts: 3, remainingTokens: 100, remainingRuntimeMs: 10000, deadlineUtcMs: 100000 } }, { nowUtcMs: 0 });
  const claim: GitAgentRepairClaim = { projectId: 'project-1', repairId: 'repair-1', attemptId: 'attempt-1', ownerId: 'owner-1', hostInstanceId: 'host-1', authorizationVersion: 1 };
  const output = { schemaVersion: 1 as const, repairId: request.repairId, status: 'modified' as const, changedPaths: ['src/a.ts'], usage: { consumedTokens: 2, runtimeMs: 3 }, failureCode: null };
  const admission = { id: claim.attemptId, ...claim, runId: 'repair-run', dispatch: { claimId: 'claim-1', claimVersion: 1, slotId: 'slot-1' }, startedAtUtcMs: 1,
    maxTokens: 20, maxRuntimeMs: 100, deadlineUtcMs: 1000, stoppedAtUtcMs: null, output: null };
  const view: GitAgentRepairView = { request, receipt: { repairId: request.repairId, parentBatchId: 'batch-1', runId: 'repair-run', authorizationDigest: request.authorizationDigest, blockedReason: null },
    authorizationVersion: 1, blockedReason: null, attempts: [{ ...admission, output, stoppedAtUtcMs: 2 }] };
  const baseline = { repositoryBindingId: 'binding-1', repositoryBindingRevision: 1, repoIdentity: 'repo-1', canonicalPath: '/managed/integration',
    gitCommonDir: '/managed/source/.git', branch: 'HEAD', baseCommit: sha('a') };
  const inspection = { complete: true, repository: { ...baseline, headCommit: sha('a') }, conflictMarkerPaths: [],
    statusPorcelainBase64: Buffer.from('UU src/a.ts\0').toString('base64'), contents: { tracked: [{ path: 'src/a.ts', state: 'present', digest: digest('7'), mode: 420 }], untracked: [], ignored: [], directories: [] } } as unknown as WorkspaceInspection;
  const before = { ...inspection, conflictMarkerPaths: ['src/a.ts'], contents: { ...inspection.contents,
    tracked: inspection.contents.tracked.map(entry => ({ ...entry, digest: digest('8') })) } };
  const plan = gitAgentIntegrationCommitPlan(view, sourcePlan);
  const evidence = { kind: 'verification_result' as const, id: 'result-1', digest: digest('9') };
  const planEvidence = { kind: 'artifact' as const, id: 'verification-plan', digest: digest('a') };
  const intent = { operationId: plan.integrationId, projectId: 'project-1', featureId: 'feature-1', runId: 'repair-run', attemptId: null,
    operationType: 'integration_commit', integrationPlan: plan, expectedHead: sha('a'), repoIdentity: 'repo-1', worktreePath: baseline.canonicalPath,
    verificationRefs: [evidence, planEvidence], gitIdentity: { name: 'User', email: 'user@example.com', confirmed: true }, message: 'Repair integration',
    candidateTree: sha('c'), budgetSnapshot: { sourcePlanId: 'business-plan', sourcePlanRevision: 3, sourcePlanInputDigest: digest('e'),
      gitAgentRepair: { repairId: 'repair-1', authorizationDigest: request.authorizationDigest, sourceOperationId: source.intent.operationId,
        sourceInputDigest: sourcePlan.inputDigest, parents: [sha('a'), sha('b')], verification: { planRef: { id: 'verification-plan', digest: digest('a') }, resultRef: { id: evidence.id, digest: evidence.digest } } } } } as unknown as GitOperationRecord['intent'];
  const candidate = { status: 'succeeded', intent, actualCommit: sha('d'), actualTree: sha('c'), reasonCode: null,
    integrationResult: gitAgentIntegrationCommitResult(intent, sha('d'), sha('c')) } as GitOperationRecord;
  let committed = false;
  const gitPerson = { name: intent.gitIdentity.name, email: intent.gitIdentity.email };
  const facts = () => committed ? { head: sha('d'), tree: sha('c'), parents: [sha('a'), sha('b')], message: gitOperationCommitMessage(intent.message, intent.operationId), author: gitPerson, committer: gitPerson }
    : { head: sha('a'), tree: sha('a'), parents: [], message: 'base', author: intent.gitIdentity, committer: intent.gitIdentity };
  const repair = { read: vi.fn(() => view), claim: vi.fn(() => admission), settle: vi.fn(() => view), hold: vi.fn() };
  const publish = vi.fn(async () => true);
  const verify = vi.fn(async () => ({ outcome: 'passed' as const, evidence, planEvidence, reason: null, hold: null }));
  const commit = vi.fn(async () => { committed = true; return candidate; });
  const deps = { repair, inspector: { inspect: vi.fn(async () => committed ? { ...inspection, repository: { ...inspection.repository, headCommit: sha('d') }, statusPorcelainBase64: '' } : inspection) }, driver: { open: () => ({ facts: async () => facts(), isAncestor: async () => true }) },
    readBaseline: () => baseline, readAuthorization: () => ({ intent, baseline, allowedPaths: ['src/a.ts'], verificationPassed: true, approvalCurrent: true, commitAuthorized: true }),
    verify, commit: { commit }, operations: { getGitOperation: vi.fn(() => committed ? candidate : null) },
    integration: { readContext: () => ({ source, before }), assertCurrent: vi.fn(() => true), publish } } as unknown as GitAgentCandidateFinalizationDependencies;
  const finalize = vi.fn(async () => ({ outcome: 'committed' as const, reason: null, operation: candidate, successorUnlocked: true }));
  const runtime = { start: vi.fn(async (r: GitAgentRuntimeRequest): Promise<GitAgentRuntimeHandle> => ({ result: Promise.resolve({ schemaVersion: 1 as const, repairId: 'repair-1', execution: r.execution,
    terminal: 'completed' as const, changedPaths: ['src/a.ts'], verification: { strategyId: r.authorization.verification.strategyId, strategyDigest: r.authorization.verification.digest, outputDigest: null, exitCode: null },
    usage: { consumedTokens: 2, runtimeMs: 3 }, failure: null, stop: { confirmed: true, detail: null } }), stopped: Promise.resolve({ confirmed: true, detail: null }), cancel: vi.fn(async () => ({ accepted: true, reason: null })) })) };
  const consumerDeps = { repair, runtime, candidates: { finalize }, admit: vi.fn(() => null),
    readFailure: () => ({ source, observation: null, evidenceId: source.intent.operationId, combinedRepairApproved: false }), nowUtcMs: () => 1 };
  return { view, source, sourcePlan, plan, claim, admission, before, inspection, candidate, repair, publish, verify, commit, deps, runtime, finalize, consumerDeps,
    input: { claim, invocationId: 'invocation-1', executionVersion: 1 }, candidateRequest: { projectId: 'project-1', repairId: 'repair-1', attemptId: 'attempt-1' } };
}

describe('DAG F-011 integration candidate chain', () => {
  it('[case:repair-integration-commit-and-replay] publishes only after a controlled integration commit and reuses it on replay', async () => {
    const f = fixture(), service = createGitAgentCandidateFinalizationService(f.deps);
    expect(await service.finalize(f.candidateRequest)).toMatchObject({ outcome: 'committed', successorUnlocked: true });
    expect(await service.finalize(f.candidateRequest)).toMatchObject({ outcome: 'committed', successorUnlocked: true });
    expect(f.commit).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledWith(f.view, f.candidate);
    expect(f.plan.integrationId).not.toBe(f.sourcePlan.integrationId);
    expect(gitAgentIntegrationCommitPlan(structuredClone(f.view), f.sourcePlan).integrationId).toBe(f.plan.integrationId);
  });
  it('[case:repair-integration-missing-publication] a commit alone cannot unlock a successor', async () => {
    const f = fixture(); f.publish.mockResolvedValue(false);
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'integration_not_verified', successorUnlocked: false });
  });
  it('[case:repair-integration-conflict-markers] rereads conflict markers despite modified runtime output', async () => {
    const f = fixture(); Object.assign(f.inspection, { conflictMarkerPaths: ['src/a.ts'] });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'unresolved_conflict' });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('[case:repair-integration-prestaged-input] pre-existing deterministic merge paths do not enlarge the model write grant', async () => {
    const f = fixture();
    const entry = { ...f.inspection.contents.tracked[0]!, path: 'src/merged.ts' };
    Object.assign(f.before, { contents: { ...f.before.contents, tracked: [...f.before.contents.tracked, entry] } });
    Object.assign(f.inspection, { statusPorcelainBase64: Buffer.from('UU src/a.ts\0M  src/merged.ts\0').toString('base64'),
      contents: { ...f.inspection.contents, tracked: [...f.inspection.contents.tracked, { ...entry, digest: digest('f') }] } });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'candidate_scope_mismatch' });
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('[case:repair-integration-prestaged-unchanged] retains authorized deterministic merge bytes while limiting model deltas', async () => {
    const f = fixture();
    const entry = { ...f.inspection.contents.tracked[0]!, path: 'src/merged.ts' };
    Object.assign(f.before, { contents: { ...f.before.contents, tracked: [...f.before.contents.tracked, entry] } });
    Object.assign(f.inspection, { statusPorcelainBase64: Buffer.from('UU src/a.ts\0M  src/merged.ts\0').toString('base64'), contents: { ...f.inspection.contents, tracked: [...f.inspection.contents.tracked, entry] } });
    const authorization = f.deps.readAuthorization({} as never);
    Object.assign(f.deps, { readAuthorization: () => ({ ...authorization, allowedPaths: ['src/a.ts', 'src/merged.ts'] }) });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'committed' });
    expect(f.verify).toHaveBeenCalledWith(expect.objectContaining({ changedPaths: ['src/a.ts'] }));
  });
  it('[case:repair-integration-coverage-remains-blocked] a repaired prefix cannot unlock when another frozen predecessor is missing', async () => {
    const f = fixture(); const open = f.deps.driver.open;
    Object.assign(f.deps, { driver: { open: (...args: Parameters<typeof open>) => ({ ...open(...args), isAncestor: async (ancestor: string) => ancestor !== sha('b') }) } });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'integration_coverage_incomplete', successorUnlocked: false });
    expect(f.commit).toHaveBeenCalledTimes(1); expect(f.publish).not.toHaveBeenCalled();
  });
  it('[case:repair-integration-plan-evidence-required] a result reference alone cannot stand in for the frozen Core verification plan', async () => {
    const f = fixture(); const verification = await f.verify(); f.verify.mockResolvedValue({ ...verification, planEvidence: undefined as never });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'integration_input_changed' });
    expect(f.commit).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('[case:repair-integration-input-drift] a changed source digest prevents verification and commit', async () => {
    const f = fixture(); Object.assign(f.source, { intentDigest: digest('f') });
    expect(await createGitAgentCandidateFinalizationService(f.deps).finalize(f.candidateRequest)).toMatchObject({ outcome: 'blocked', reason: 'integration_input_changed' });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
  });
});

describe('DAG F-011 repair consumer', () => {
  it.each(['git_lock_present', 'input_missing', 'repo_identity_changed', null])('[case:repair-deterministic-failure-%s] never starts a model for deterministic failures', async reason => {
    const f = fixture(); Object.assign(f.source, { reasonCode: reason }); Object.assign(f.view, { attempts: [] });
    expect(await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input)).toMatchObject({ outcome: 'blocked', reason: 'failure_not_authorized' });
    expect(f.repair.claim).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled();
  });
  it('[case:repair-consumer-narrowed-budget] passes only admitted remaining budget and settles before candidate finalization', async () => {
    const f = fixture(); Object.assign(f.view, { attempts: [] });
    expect(await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input)).toMatchObject({ outcome: 'committed' });
    expect(f.runtime.start).toHaveBeenCalledWith(expect.objectContaining({ authorization: expect.objectContaining({ budget: { remainingAttempts: 1, remainingTokens: 20, remainingRuntimeMs: 100, deadlineUtcMs: 1000 } }) }));
    expect(f.repair.settle.mock.invocationCallOrder[0]).toBeLessThan(f.finalize.mock.invocationCallOrder[0]!);
  });
  it('[case:repair-consumer-replay-no-start] a settled admission only rechecks the candidate', async () => {
    const f = fixture(); await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input);
    expect(f.finalize).toHaveBeenCalledTimes(1); expect(f.repair.claim).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled();
  });
  it('[case:repair-consumer-replay-after-publication] source success after publication cannot restart or invalidate the settled repair', async () => {
    const f = fixture(); Object.assign(f.source, { status: 'succeeded', reasonCode: null });
    expect(await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input)).toMatchObject({ outcome: 'committed' });
    expect(f.repair.claim).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled(); expect(f.repair.hold).not.toHaveBeenCalled();
  });
  it('[case:repair-consumer-missing-driver] missing driver persists a hold before admission', async () => {
    const f = fixture(); Object.assign(f.view, { attempts: [] });
    expect(await createGitAgentIntegrationRepairConsumer({ ...f.consumerDeps, runtime: undefined }).consume(f.input)).toMatchObject({ outcome: 'blocked', reason: 'git_agent_driver_unavailable' });
    expect(f.repair.hold).toHaveBeenCalledWith('project-1', 'repair-1', 'invalid_runtime_output'); expect(f.repair.claim).not.toHaveBeenCalled();
  });
  it('[case:repair-consumer-unconfirmed-stop] no finalization after an unconfirmed stop', async () => {
    const f = fixture(); Object.assign(f.view, { attempts: [] });
    const start = f.runtime.start.getMockImplementation()!;
    f.runtime.start.mockImplementation(async request => ({ ...await start(request), stopped: Promise.resolve({ confirmed: false, detail: 'unknown' }) }));
    expect(await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input)).toMatchObject({ outcome: 'blocked', reason: 'stop_unconfirmed' });
    expect(f.finalize).not.toHaveBeenCalled();
  });
  it('[case:repair-consumer-credential-hold] trusted credential rejection has no runtime or budget admission', async () => {
    const f = fixture(); Object.assign(f.view, { attempts: [] });
    f.consumerDeps.admit.mockReturnValue('identity_or_lock' as never);
    expect(await createGitAgentIntegrationRepairConsumer(f.consumerDeps).consume(f.input)).toMatchObject({ outcome: 'blocked', reason: 'identity_or_lock' });
    expect(f.repair.claim).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled();
  });
  it('[case:repair-combined-checks-require-approval] combined verification failure requires an explicit trusted approval', () => {
    const f = fixture(); Object.assign(f.source, { reasonCode: 'verification_failed' });
    const view = { ...f.view, request: { ...f.view.request, source: { ...f.view.request.source, failureKind: 'combined_verification_failed' as const } } };
    expect(gitAgentIntegrationFailureAllowed(view, f.source, null, false, f.source.intent.operationId)).toBe(false);
    expect(gitAgentIntegrationFailureAllowed(view, f.source, null, true, f.source.intent.operationId)).toBe(true);
  });
});

describe('DAG F-011 fixed evidence publication', () => {
  function publisherFixture() {
    const f = fixture();
    let plan: any = { revision: 3, frozenAtUtcMs: 1, targetBaseline: sha('a'), status: 'blocked', staleReasons: [], inputDigest: digest('e'),
      integrationResult: { operationId: f.source.intent.operationId, ownerId: 'source-owner', ownerVersion: 1, operationStatus: 'failed' } };
    const update = vi.fn((input: any) => { plan = { ...plan, revision: plan.revision + 1, status: 'integration_passed', integrationResult: input.integrationResult }; return plan; });
    const finalize = vi.fn(); const authorize = vi.fn(() => true); const verify = vi.fn(async () => true);
    const atomic = { transact: (_name: string, fn: (tx: any) => unknown) => fn({ getGitOperation: (_p: string, id: string) => id === f.source.intent.operationId ? f.source : f.candidate,
      getIntegrationPlan: () => plan, updateIntegrationPlanResult: update, finalizeGitOperation: finalize }) } as unknown as AtomicCommandStore;
    const service = createGitAgentIntegrationEvidencePublisher({ atomic, repair: f.repair, verify, authorize });
    return { ...f, service, update, finalizeSource: finalize, authorize, evidenceVerify: verify, get planState() { return plan; } };
  }
  it('[case:repair-publication-fixed-cas-and-replay] binds the source input domain, keeps failed receipt, and publishes once', async () => {
    const f = publisherFixture(); const sourceBefore = structuredClone(f.source);
    expect(await f.service.publish(f.view, f.candidate)).toBe(true);
    expect(await f.service.publish(f.view, f.candidate)).toBe(true);
    expect(f.update).toHaveBeenCalledTimes(1); expect(f.finalizeSource).not.toHaveBeenCalled(); expect(f.source).toEqual(sourceBefore);
    expect(f.planState.integrationResult).toMatchObject({ inputDigest: digest('e'), integrationId: f.sourcePlan.integrationId,
      commitSha: sha('d'), treeSha: sha('c'), verificationEvidence: { planRef: { id: 'verification-plan' }, resultRef: { id: 'result-1' } } });
  });
  it.each(['verification', 'authorization', 'revision', 'hold'] as const)('[case:repair-publication-rejects-%s] failed publication leaves the source plan untouched', async reason => {
    const f = publisherFixture();
    if (reason === 'verification') f.evidenceVerify.mockResolvedValue(false);
    if (reason === 'authorization') f.authorize.mockReturnValue(false);
    if (reason === 'revision') f.planState.revision++;
    if (reason === 'hold') Object.assign(f.view, { blockedReason: 'requirements_tradeoff' });
    expect(await f.service.publish(f.view, f.candidate)).toBe(false); expect(f.update).not.toHaveBeenCalled(); expect(f.finalizeSource).not.toHaveBeenCalled();
  });
});
