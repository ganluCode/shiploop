import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { GitIntegrationJournal } from '../ports/git-integration-journal.js';
import type { GitAgentRepairClaim, GitAgentRepairView, GitAgentRepairHold } from '../ports/git-agent-repair-store.js';
import type { GitAgentRuntimeAdapter } from '../ports/git-agent-runtime.js';
import { createGitAgentRuntimeRequest } from '../ports/git-agent-runtime.js';
import { createGitAgentRepairRequest } from '../ports/git-agent-repair.js';
import { gitAgentIntegrationCommitPlan, readGitAgentIntegrationCommitBinding } from '../ports/git-agent-integration-commit.js';
import { stableStringify } from '../ports/feature-plan.js';
import type { GitAgentRepairService } from './git-agent-repair.js';
import type { GitAgentCandidateFinalizationService } from './git-agent-candidate-finalization.js';
import { runGitAgentRepairAttempt } from './git-agent-repair-attempt-runner.js';

const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');

/** One consumer of the durable repair queue, never a coding DAG consumer. Runtime
 * admission remains in the existing store. A replay reconciles the candidate and
 * never launches another model, reserves budget, or clears the first hold. */
export function createGitAgentIntegrationRepairConsumer(deps: {
  readonly repair: Pick<GitAgentRepairService, 'read' | 'claim' | 'settle' | 'hold'>;
  readonly runtime?: GitAgentRuntimeAdapter;
  readonly candidates: GitAgentCandidateFinalizationService;
  /** Re-reads persisted source evidence and current owner, credential reference,
   * workspace, policy and approval. It must not execute Git or start a model. */
  readonly admit: (repair: GitAgentRepairView) => GitAgentRepairHold | null;
  readonly readFailure: (repair: GitAgentRepairView) => {
    readonly source: GitOperationRecord; readonly observation: ReturnType<GitIntegrationJournal['read']>;
    readonly evidenceId: string; readonly combinedRepairApproved: boolean;
  };
  readonly nowUtcMs?: () => number;
}) {
  const now = deps.nowUtcMs ?? Date.now;
  return { async consume(input: { readonly claim: GitAgentRepairClaim; readonly invocationId: string; readonly executionVersion: number; readonly signal?: AbortSignal }) {
    const { claim } = input;
    const view = deps.repair.read(claim.projectId, claim.repairId);
    const block = (reason: GitAgentRepairHold, detail: string = reason) => {
      deps.repair.hold(claim.projectId, claim.repairId, reason);
      return { outcome: 'blocked' as const, reason: detail, operation: null, successorUnlocked: false };
    };
    if (view.blockedReason !== null) return { outcome: 'blocked' as const, reason: view.blockedReason, operation: null, successorUnlocked: false };
    const previous = view.attempts.find(a => a.id === claim.attemptId);
    if (previous && (previous.ownerId !== claim.ownerId || previous.hostInstanceId !== claim.hostInstanceId
      || previous.authorizationVersion !== claim.authorizationVersion)) return { outcome: 'blocked' as const, reason: 'stale_owner', operation: null, successorUnlocked: false };
    let hold: GitAgentRepairHold | null;
    try {
      if (previous === undefined) {
        const failure = deps.readFailure(view);
        if (!gitAgentIntegrationFailureAllowed(view, failure.source, failure.observation, failure.combinedRepairApproved, failure.evidenceId)) return block('identity_or_lock', 'failure_not_authorized');
      }
      hold = deps.admit(view);
    } catch { return block('identity_or_lock'); }
    if (hold !== null) return block(hold);
    if (previous) {
      if (previous.stoppedAtUtcMs === null) return block('stop_unconfirmed');
      return deps.candidates.finalize({ projectId: claim.projectId, repairId: claim.repairId, attemptId: previous.id });
    }
    if (deps.runtime === undefined) return block('invalid_runtime_output', 'git_agent_driver_unavailable');
    if (input.signal?.aborted) return block('identity_or_lock');
    createGitAgentRuntimeRequest({ authorization: view.request, claim, invocationId: input.invocationId, executionVersion: input.executionVersion });
    const admission = deps.repair.claim(claim);
    if (admission === null) return { outcome: 'pending' as const, reason: 'admission_not_created', operation: null, successorUnlocked: false };
    // The adapter gets only the admitted remainder; retries cannot reuse the original grant.
    try {
      const { schemaVersion: _schema, authorizationDigest: _auth, commandDigest: _command, ...body } = view.request;
      const authorization = createGitAgentRepairRequest({ ...body, budget: { remainingAttempts: 1,
        remainingTokens: admission.maxTokens, remainingRuntimeMs: admission.maxRuntimeMs,
        deadlineUtcMs: admission.deadlineUtcMs } }, { nowUtcMs: now() });
      const request = createGitAgentRuntimeRequest({ authorization, claim, invocationId: input.invocationId, executionVersion: input.executionVersion });
      const completion = await runGitAgentRepairAttempt(deps.runtime, request, admission, {
        repair: deps.repair, claim, ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!completion.completion?.candidateDelivered || !completion.settled) {
        const code = completion.output?.failureCode;
        return block(!completion.settled ? 'stop_unconfirmed' : code === 'budget_exhausted' ? 'budget_exhausted'
          : completion.completion?.result.failure?.classification === 'out_of_scope' ? 'out_of_scope' : 'invalid_runtime_output');
      }
      return deps.candidates.finalize({ projectId: claim.projectId, repairId: claim.repairId, attemptId: admission.id });
    } catch {
      // Admission is durable; a failed startup or settlement never proves the writer stopped.
      return block('stop_unconfirmed');
    }
  } };
}

/** Failure-source admission is deterministic and shared by the consumer/finalizer.
 * Mere failure text cannot authorize a model. Combined-check repair additionally
 * requires a trusted explicit approval outside this function. */
export function gitAgentIntegrationFailureAllowed(repair: GitAgentRepairView, source: GitOperationRecord,
  observation: ReturnType<GitIntegrationJournal['read']>, combinedRepairApproved: boolean, evidenceId: string): boolean {
  const request = repair.request;
  const plan = source.intent.integrationPlan;
  if (!plan || source.intent.projectId !== request.projectId || source.intent.operationId !== request.source.operationId
    || source.intent.operationType !== request.source.operationType || source.intentDigest !== request.source.operationDigest
    || plan.integrationId !== request.source.integrationId || plan.inputDigest !== request.source.inputDigest
    || source.intent.featureId !== request.featureId || source.intent.runId !== request.runId
    || source.intent.expectedHead !== request.target.baselineCommitSha
    || plan.phaseId !== request.phaseId || plan.batchId !== request.parentBatchId || plan.successorFeatureId !== request.featureId
    || plan.target.baseCommit !== request.target.baselineCommitSha || plan.target.repoIdentity !== request.target.repoIdentity
    || request.workspace.workspaceId !== plan.integrationId || request.workspace.workspaceDigest !== hash({
      repoIdentity: source.intent.repoIdentity, worktreePath: source.intent.worktreePath,
      inputDigest: plan.inputDigest, baselineCommitSha: source.intent.expectedHead,
    })) return false;
  if (evidenceId !== request.source.evidenceId) return false;
  const conflict = request.source.failureKind === 'conflict';
  const reasons = conflict ? ['merge_conflict', 'integration_conflict'] : ['combined_verification_failed', 'combined_check_failed', 'verification_failed'];
  if (!conflict && !combinedRepairApproved) return false;
  if (source.status === 'failed' && source.workspacePreserved && reasons.includes(source.reasonCode ?? '')) {
    return request.source.evidenceId === source.intent.operationId && request.source.evidenceDigest === hash(source.receipt);
  }
  return conflict && source.status === 'pending' && observation?.outcome === 'blocked'
    && observation.workspace !== null && reasons.includes(observation.reason ?? '')
    && request.source.evidenceDigest === hash(observation);
}

/** Publish fixed evidence only after independent Git/Artifact checks and one Core
 * transaction. The original failure receipt is retained; only a pending source
 * operation may receive a new receipt. No predecessor/Task/DAG/budget is written. */
export function createGitAgentIntegrationEvidencePublisher(deps: {
  readonly atomic: AtomicCommandStore;
  readonly repair: Pick<GitAgentRepairService, 'read'>;
  readonly verify: (repair: GitAgentRepairView, operation: GitOperationRecord) => Promise<boolean>;
  readonly authorize: (tx: CommandTransaction, repair: GitAgentRepairView, operation: GitOperationRecord) => boolean;
  readonly nowUtcMs?: () => number;
}) {
  return { async publish(repair: GitAgentRepairView, operation: GitOperationRecord): Promise<boolean> {
    if (repair.blockedReason !== null || operation.status !== 'succeeded' || operation.actualCommit === null || operation.actualTree === null
      || operation.integrationResult?.verificationEvidence?.planRef === undefined
      || operation.integrationResult.verificationEvidence.resultRef === undefined) return false;
    const binding = readGitAgentIntegrationCommitBinding(operation.intent);
    if (!binding || binding.repairId !== repair.request.repairId || binding.authorizationDigest !== repair.request.authorizationDigest
      || binding.sourceOperationId !== repair.request.source.operationId || binding.sourceInputDigest !== repair.request.source.inputDigest) return false;
    const verified = operation.integrationResult;
    if (verified.commitSha !== operation.actualCommit || verified.treeSha !== operation.actualTree
      || verified.inputDigest !== operation.intent.integrationPlan?.inputDigest
      || !isDeepStrictEqual(verified.verificationEvidence?.planRef, binding.verification.planRef)
      || !isDeepStrictEqual(verified.verificationEvidence?.resultRef, binding.verification.resultRef)) return false;
    if (!await deps.verify(repair, operation)) return false;
    const latestRepair = deps.repair.read(repair.request.projectId, repair.request.repairId);
    if (!isDeepStrictEqual(latestRepair, repair)) return false;
    return deps.atomic.transact('GitAgentIntegration.publish', tx => {
      if (!deps.authorize(tx, repair, operation)) return false;
      const candidate = tx.getGitOperation(repair.request.projectId, operation.intent.operationId);
      const source = tx.getGitOperation(repair.request.projectId, repair.request.source.operationId);
      if (!isDeepStrictEqual(candidate, operation) || !['pending', 'failed', 'succeeded'].includes(source.status)
        || source.intentDigest !== repair.request.source.operationDigest || source.intent.integrationPlan == null) return false;
      if (!isDeepStrictEqual(candidate.intent.integrationPlan, gitAgentIntegrationCommitPlan(repair, source.intent.integrationPlan))) return false;
      const planId = source.intent.budgetSnapshot?.sourcePlanId;
      if (typeof planId !== 'string') return false;
      const plan = tx.getIntegrationPlan(repair.request.projectId, planId);
      const previous = plan.integrationResult;
      if (previous?.operationId !== source.intent.operationId || previous.ownerId !== source.intent.ownerId
        || candidate.intent.budgetSnapshot?.sourcePlanInputDigest !== plan.inputDigest
        || previous.ownerVersion !== source.intent.budgetSnapshot?.ownerVersion || plan.frozenAtUtcMs === null
        || plan.status === 'stale' || plan.staleReasons.length > 0 || plan.targetBaseline !== repair.request.target.baselineCommitSha) return false;
      const evidence = candidate.integrationResult!.verificationEvidence!;
      const result = { commitSha: candidate.actualCommit, treeSha: candidate.actualTree, verificationEvidence: evidence,
        integrationId: source.intent.integrationPlan.integrationId, inputDigest: plan.inputDigest, targetBaseline: plan.targetBaseline,
        llmNoConflictText: null, operationId: source.intent.operationId, ownerId: previous.ownerId,
        ownerVersion: previous.ownerVersion, operationStatus: 'succeeded' as const };
      if (previous.operationStatus === 'succeeded') return plan.status === 'integration_passed' && isDeepStrictEqual(previous, result);
      if (candidate.intent.budgetSnapshot?.sourcePlanRevision !== plan.revision) return false;
      const settled = tx.updateIntegrationPlanResult({ projectId: repair.request.projectId, integrationId: planId,
        expectedRevision: plan.revision, operationId: source.intent.operationId, ownerId: previous.ownerId,
        ownerVersion: previous.ownerVersion, integrationResult: result });
      if (source.status === 'pending') tx.finalizeGitOperation({ projectId: repair.request.projectId, operationId: source.intent.operationId,
        expectedRevision: source.revision, status: 'succeeded', actualCommit: candidate.actualCommit, actualTree: candidate.actualTree,
        exitCode: 0, durationMs: null, reasonCode: null, deliveryStatus: 'not_requested', settledAtUtcMs: (deps.nowUtcMs ?? Date.now)(),
        integrationResult: { ...candidate.integrationResult!, inputDigest: source.intent.integrationPlan.inputDigest,
          integrationId: source.intent.integrationPlan.integrationId }, recoveryState: 'preserved', workspacePreserved: true });
      return settled.status === 'integration_passed';
    });
  } };
}
