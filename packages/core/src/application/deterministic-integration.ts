import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { StorageError } from '../ports/errors.js';
import { isUuidV4 } from '../ports/commands.js';
import { stableCanonicalJson } from '../ports/command-receipts.js';
import { evaluateBatchBudgetReservation } from '../ports/execution-budget.js';
import { normalizeFeatureResourceSet, validateFeatureResourceLeaseRecord } from '../ports/feature-resources.js';
import type { FeatureResourceLeaseRecord, FeatureResourceSet } from '../ports/feature-resources.js';
import { validateGitOperationRegisterInput } from '../ports/git-operations.js';
import type { GitOperationRegisterInput } from '../ports/git-operations.js';
import type { GitIntegrationJournal, IntegrationExecutionObservation, IntegrationStartRequest } from '../ports/git-integration-journal.js';
import { validateIntegrationObservation } from '../ports/git-integration-observation.js';
import type { IntegrationWorkspaceAdapter } from '../ports/integration-workspace.js';
import { validatePositiveInteger, validateSha256Digest, validateStableId } from '../ports/validation.js';

const OP = 'DeterministicIntegration.start';
function fail(reason: string): never { throw new StorageError('conflict', OP, reason, { details: { reason } }); }

/** Trusted Core facts, never accepted from a Runtime or command payload. */
export interface IntegrationStartAuthorization {
  readonly intent: GitOperationRegisterInput;
  /** Reader rechecks the frozen Batch scope, approved input/evidence digests, target,
   * predecessor SHAs/revisions and repository binding in this same transaction.
   * A changed branch HEAD invalidates the old evidence instead of substituting its SHA.
   */
  readonly approvalCurrent: boolean;
  /** Parent fixed-Batch budget, including token/cost limits if configured. */
  readonly budgetAllowed: boolean;
  readonly ownerVersion: number;
  readonly resourceSet: FeatureResourceSet;
  readonly leases: readonly FeatureResourceLeaseRecord[];
  readonly writerIdentity: Readonly<Record<string, unknown>>;
}

export interface DeterministicIntegrationService {
  start(request: IntegrationStartRequest): Promise<IntegrationExecutionObservation>;
}

export function createDeterministicIntegrationService(deps: {
  readonly atomic: AtomicCommandStore;
  readonly journal: GitIntegrationJournal;
  readonly workspace: IntegrationWorkspaceAdapter;
  readonly readAuthorization: (tx: CommandTransaction, request: IntegrationStartRequest) => IntegrationStartAuthorization;
  /** External process verification; must confirm this exact writer identity stopped. */
  readonly verifyWriterStopped: (authorization: IntegrationStartAuthorization) => Promise<boolean>;
  readonly nowUtcMs?: () => number;
}): DeterministicIntegrationService {
  const now = deps.nowUtcMs ?? Date.now;
  function current(tx: CommandTransaction, request: IntegrationStartRequest, original?: IntegrationStartAuthorization) {
    const auth = structuredClone(deps.readAuthorization(tx, request));
    const intent = validateGitOperationRegisterInput(auth.intent);
    const plan = intent.integrationPlan;
    if (intent.operationType !== 'integration' || plan == null || plan.integrationResult !== null
      || intent.operationId !== request.operationId || intent.projectId !== request.projectId
      || intent.featureId !== plan.successorFeatureId || intent.runId !== plan.runId
      || plan.projectId !== request.projectId || intent.expectedHead !== plan.target.baseCommit
      || intent.repoIdentity !== plan.target.repoIdentity || intent.codeDigest !== plan.inputDigest
      || intent.worktreePath === plan.target.canonicalPath || intent.attemptId !== null) fail('authorization_identity_mismatch');
    if (plan.inputDigest !== request.inputDigest) fail('input_digest_mismatch');
    if (auth.approvalCurrent !== true) fail('approval_not_current');
    if (auth.budgetAllowed !== true) fail('budget_exhausted');
    validatePositiveInteger(auth.ownerVersion, { operation: OP }, 'ownerVersion');
    if (intent.budgetSnapshot?.ownerVersion !== auth.ownerVersion) fail('owner_fenced');
    const sourcePlanId = validateStableId(intent.budgetSnapshot?.sourcePlanId, { operation: OP }, 'sourcePlanId');
    const sourceRevision = validatePositiveInteger(intent.budgetSnapshot?.sourcePlanRevision, { operation: OP }, 'sourcePlanRevision');
    const source = tx.getIntegrationPlan(request.projectId, sourcePlanId);
    const ownPending = source.integrationResult?.operationId === request.operationId
      && source.integrationResult.operationStatus === 'pending'
      && source.integrationResult.ownerId === intent.ownerId && source.integrationResult.ownerVersion === auth.ownerVersion;
    if (source.frozenAtUtcMs === null || source.revision !== sourceRevision + (ownPending ? 1 : 0)
      || !ownPending && (source.status !== 'dependency_passed' || source.integrationResult !== null)
      || source.batchId !== plan.batchId || source.phaseId !== plan.phaseId || source.successorFeatureId !== intent.featureId
      || source.targetBaseline !== plan.target.baseCommit || !isDeepStrictEqual(source.approvedInputs, plan.approvedInputs)
      || !isDeepStrictEqual(source.mergeOrder, plan.mergeOrder) || !isDeepStrictEqual(source.verificationScope, plan.verificationScope)
      || !isDeepStrictEqual(source.predecessors, plan.predecessors.map(predecessor => ({
        projectId: predecessor.projectId, phaseId: predecessor.phaseId, featureId: predecessor.featureId,
        dependencyPassed: predecessor.dependencyPassed, coveredInputIds: predecessor.coveredInputIds, ancestorVerified: true,
        delivery: predecessor.delivery === null ? null : { commitSha: predecessor.delivery.commitSha,
          evidenceId: predecessor.delivery.evidenceId, evidenceDigest: predecessor.delivery.evidenceDigest },
      })))) fail('frozen_plan_changed');
    const revisions = intent.budgetSnapshot?.predecessorRevisions;
    if (revisions === null || typeof revisions !== 'object' || Array.isArray(revisions)) fail('predecessor_revision_missing');
    for (const predecessor of plan.predecessors) {
      const currentFeature = tx.getFeaturePlan(request.projectId, predecessor.featureId).feature;
      if (currentFeature.revision !== (revisions as Record<string, unknown>)[predecessor.featureId]
        || currentFeature.phaseId !== plan.phaseId || currentFeature.status !== 'completed'
        || currentFeature.deliveryStatus !== 'succeeded') fail('predecessor_changed');
    }
    const feature = tx.getFeaturePlan(request.projectId, intent.featureId).feature;
    if (feature.revision !== request.expectedFeatureRevision || intent.expectedFeatureRevision !== feature.revision) fail('stale_revision');
    const binding = tx.getRepositoryBinding(request.projectId);
    if (binding.id !== intent.repositoryBindingId || binding.repoIdentity !== intent.repoIdentity
      || binding.canonicalPath !== plan.target.canonicalPath || binding.gitCommonDir !== plan.target.gitCommonDir) fail('repo_identity_changed');
    const run = tx.getExecutionRun(request.projectId, intent.runId);
    const batch = tx.getExecutionBatch(request.projectId, plan.batchId);
    if (run.batchId !== batch.id || run.featureId !== intent.featureId || batch.featureId !== intent.featureId
      || batch.phaseId !== plan.phaseId || !['queued', 'running'].includes(batch.status)
      || !['queued', 'running'].includes(run.status)) fail('execution_not_current');
    const budget = evaluateBatchBudgetReservation(batch.budgetSnapshot.batch, {
      runsCreated: batch.runsCreated, attemptsCreated: batch.attemptsCreated,
      runtimeStarts: batch.runtimeStarts, noProgressRuns: batch.noProgressRuns,
    }, now());
    // Deterministic Git does not reserve a model start or a new Run/Attempt.
    // Existing cumulative ceilings and the original absolute deadlines still gate it.
    if (!budget.allowed || batch.deadlineAtUtcMs <= now()
      || run.startedAtUtcMs !== null && run.startedAtUtcMs + run.runTimeLimitMs <= now()) fail('budget_exhausted');
    const resources = normalizeFeatureResourceSet(auth.resourceSet);
    const leases = auth.leases.map(validateFeatureResourceLeaseRecord);
    if (resources.projectId !== request.projectId
      || !resources.resources.some(resource => resource.kind === 'feature_code_shared' && resource.key === `project:${request.projectId}:feature-code`)
      || !resources.resources.some(resource => resource.kind === 'worktree_write_exclusive'
        && resource.key === `project:${request.projectId}:worktree:${plan.integrationId}`)) fail('workspace_not_held');
    for (const resource of resources.resources) {
      const matching = leases.filter(lease => lease.resource.key === resource.key && lease.state !== 'released');
      if (resource.accessMode === 'exclusive' && matching.some(lease => lease.ownerId !== intent.ownerId
        || lease.ownerVersion !== auth.ownerVersion || lease.state !== 'held')) fail('workspace_not_held');
      if (!matching.some(lease => isDeepStrictEqual(lease.resource, resource) && lease.projectId === request.projectId
        && lease.ownerId === intent.ownerId && lease.ownerVersion === auth.ownerVersion
        && lease.state === 'held' && lease.leaseUntilUtcMs > now())) fail('workspace_not_held');
    }
    if (original && !isDeepStrictEqual(auth, original)) fail('authorization_changed');
    return { ...auth, intent };
  }

  return { async start(raw) {
    if (!raw || Object.keys(raw).some(key => !['projectId', 'operationId', 'commandId', 'expectedFeatureRevision', 'inputDigest'].includes(key))) fail('invalid_request');
    const request = structuredClone(raw);
    validateStableId(request.projectId, { operation: OP }, 'projectId');
    validateSha256Digest(request.operationId, { operation: OP }, 'operationId');
    validateSha256Digest(request.inputDigest, { operation: OP }, 'inputDigest');
    validatePositiveInteger(request.expectedFeatureRevision, { operation: OP }, 'expectedFeatureRevision');
    if (!isUuidV4(request.commandId)) fail('invalid_command_id');
    const { commandId: _command, ...body } = request;
    const requestDigest = createHash('sha256').update(stableCanonicalJson(body)).digest('hex');
    const authorization = deps.atomic.transact(OP, tx => current(tx, request));
    if (await deps.verifyWriterStopped(authorization) !== true) fail('previous_writer_stop_unconfirmed');
    const started = deps.atomic.transact(OP, tx => {
      current(tx, request, authorization);
      const registered = tx.registerGitOperation(authorization.intent);
      deps.journal.claim(tx, request, requestDigest);
      if (registered.created) {
        const sourcePlanId = authorization.intent.budgetSnapshot!.sourcePlanId as string;
        const source = tx.getIntegrationPlan(request.projectId, sourcePlanId);
        tx.updateIntegrationPlanResult({ projectId: request.projectId, integrationId: sourcePlanId,
          expectedRevision: source.revision, operationId: request.operationId, ownerId: authorization.intent.ownerId,
          ownerVersion: authorization.ownerVersion, integrationResult: {
            commitSha: null, treeSha: null, verificationEvidence: null, llmNoConflictText: null,
            operationId: request.operationId, operationStatus: 'pending', ownerId: authorization.intent.ownerId,
            ownerVersion: authorization.ownerVersion,
          } });
      }
      if (!registered.created) {
        const recorded = deps.journal.read(tx, request.projectId, request.operationId);
        if (recorded && recorded.outcome !== 'merging') return { operation: registered.operation, recorded };
        fail('reconciliation_required');
      }
      return { operation: registered.operation, recorded: null };
    });
    if (started.recorded) return started.recorded;
    const check = () => deps.atomic.transact(OP, tx => {
      current(tx, request, authorization);
      const operation = tx.getGitOperation(request.projectId, request.operationId);
      if (operation.status !== 'pending' || operation.revision !== started.operation.revision
        || operation.intentDigest !== started.operation.intentDigest) fail('operation_fenced');
    });
    const record = (observation: IntegrationExecutionObservation) => deps.atomic.transact(OP, tx => {
      current(tx, request, authorization);
      deps.journal.append(tx, request.projectId, request.operationId, started.operation.revision, observation);
      return observation;
    });
    check();
    const prepared = await deps.workspace.prepare({ plan: authorization.intent.integrationPlan!,
      integrationPath: authorization.intent.worktreePath,
      owner: { ownerId: authorization.intent.ownerId, ownerVersion: authorization.ownerVersion },
      gitIdentity: authorization.intent.gitIdentity, beforeWrite: check,
      onStep: workspace => { record({ outcome: 'merging', reason: null, workspace, steps: workspace.steps }); },
    });
    check();
    if (prepared.status !== 'ready' || !prepared.workspace) {
      return record({ outcome: prepared.status === 'unknown' ? 'unknown' : 'blocked', reason: prepared.reason,
        workspace: prepared.workspace, steps: prepared.workspace?.steps ?? [] });
    }
    validateIntegrationObservation({ outcome: 'merging', reason: null, workspace: prepared.workspace, steps: [] }, authorization.intent);
    const merged = await deps.workspace.merge(prepared.workspace);
    check();
    return record({ outcome: merged.status === 'succeeded' ? 'pending_verification' : merged.status === 'unknown' ? 'unknown' : 'blocked',
      reason: merged.reason, workspace: merged.workspace, steps: merged.steps });
    // Never finalize/unlock, clean a workspace, modify main, or roll back predecessor delivery here.
    // Exceptions after durable intent require read-only reconciliation; start never retries Git I/O.
  } };
}
