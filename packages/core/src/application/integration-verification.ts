import { isDeepStrictEqual } from 'node:util';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { StorageError } from '../ports/errors.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { GitIntegrationJournal, IntegrationExecutionObservation } from '../ports/git-integration-journal.js';
import type { PersistedIntegrationPlan } from '../ports/integration-plan-store.js';
import type { IntegrationResult } from '../ports/integration-plan.js';
import type {
  IntegrationVerificationExecutionInput,
  IntegrationVerificationExecutionResult,
  IntegrationVerificationExecutor,
  IntegrationVerificationRequest,
  IntegrationVerificationResult,
  IntegrationVerificationService,
} from '../ports/integration-verification.js';
import { INTEGRATION_VERIFICATION_STATUSES } from '../ports/integration-verification.js';
import { validatePositiveInteger, validateSha256Digest, validateStableId } from '../ports/validation.js';

const OPERATION = 'IntegrationVerification';

type Candidate = {
  readonly operation: GitOperationRecord;
  readonly sourcePlan: PersistedIntegrationPlan;
  readonly sourcePlanId: string;
  readonly observation: IntegrationExecutionObservation;
};

function fail(reason: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new StorageError('conflict', `${OPERATION}.run`, '组合验证不可继续', { details: { reason, ...details } });
}

function blocked(
  reason: IntegrationVerificationResult['reason'],
  integration: PersistedIntegrationPlan | null = null,
  operation: GitOperationRecord | null = null,
): IntegrationVerificationResult {
  return { outcome: 'blocked', reason, integration, operation };
}

function validateRequest(request: IntegrationVerificationRequest): void {
  validateStableId(request.projectId, { operation: `${OPERATION}.validate` }, 'projectId');
  validateStableId(request.operationId, { operation: `${OPERATION}.validate` }, 'operationId');
  validateStableId(request.ownerId, { operation: `${OPERATION}.validate` }, 'ownerId');
  validatePositiveInteger(request.ownerVersion, { operation: `${OPERATION}.validate` }, 'ownerVersion');
  if (!request.verificationPlan || request.verificationPlan.status !== 'ready'
    || request.verificationPlan.selectedChecks.length === 0
    || request.verificationPlan.selectedChecks.some(check => check.required && !request.verificationPlan.selectedCheckKeys.includes(check.checkKey))) {
    fail('verification_plan_unavailable');
  }
  if (!Array.isArray(request.targets) || request.targets.length === 0
    || request.targets.some(target => typeof target !== 'string' || target.length === 0)) {
    fail('verification_plan_unavailable');
  }
}

function sourcePlanIdOf(operation: GitOperationRecord): string {
  const value = operation.intent.budgetSnapshot?.sourcePlanId;
  return validateStableId(value, { operation: `${OPERATION}.sourcePlan` }, 'sourcePlanId');
}

function sourcePlanRevisionOf(operation: GitOperationRecord): number {
  return validatePositiveInteger(operation.intent.budgetSnapshot?.sourcePlanRevision,
    { operation: `${OPERATION}.sourcePlan` }, 'sourcePlanRevision');
}

function assertCandidate(
  transaction: CommandTransaction,
  request: IntegrationVerificationRequest,
  journal: GitIntegrationJournal,
  authorize?: (tx: CommandTransaction, request: IntegrationVerificationRequest, operation: GitOperationRecord) => boolean,
): Candidate {
  const operation = transaction.getGitOperation(request.projectId, request.operationId);
  if (operation.intent.operationType !== 'integration' || operation.intent.integrationPlan === null
    || operation.intent.integrationPlan === undefined) fail('operation_not_integration');
  if (operation.status !== 'pending') fail('operation_not_pending');
  if (operation.intent.ownerId !== request.ownerId
    || operation.intent.budgetSnapshot?.ownerVersion !== request.ownerVersion) fail('owner_fenced');
  if (authorize && authorize(transaction, request, operation) !== true) fail('authorization_not_current');
  const observation = journal.read(transaction, request.projectId, request.operationId);
  if (observation === null) fail('candidate_missing');
  if (observation.outcome !== 'pending_verification' || observation.workspace === null
    || observation.workspace.status !== 'succeeded') fail('candidate_not_ready');
  const executionPlan = operation.intent.integrationPlan;
  const workspace = observation.workspace;
  if (workspace.targetBase !== executionPlan.target.baseCommit
    || workspace.currentHead !== workspace.facts.head
    || workspace.facts.statusPorcelain !== ''
    || workspace.facts.unresolvedPaths.length !== 0
    || workspace.steps.length !== executionPlan.mergeOrder.length
    || !isDeepStrictEqual(workspace.plan, executionPlan)) fail('candidate_not_ready');
  const sourcePlanId = sourcePlanIdOf(operation);
  const sourcePlanRevision = sourcePlanRevisionOf(operation);
  const sourcePlan = transaction.getIntegrationPlan(request.projectId, sourcePlanId);
  const sourceResult = sourcePlan.integrationResult;
  if (sourcePlan.frozenAtUtcMs === null || sourcePlanRevision + 1 !== sourcePlan.revision
    || sourcePlan.targetBaseline !== executionPlan.target.baseCommit
    || sourceResult?.operationId !== request.operationId
    || sourceResult?.ownerId !== request.ownerId
    || sourceResult?.ownerVersion !== request.ownerVersion
    || sourceResult?.operationStatus !== 'pending') fail('source_plan_changed');
  return { operation, sourcePlan, sourcePlanId, observation };
}

function validateExecutionResult(value: IntegrationVerificationExecutionResult): void {
  const oid = (candidate: unknown): candidate is string => typeof candidate === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate);
  if (!value || !(INTEGRATION_VERIFICATION_STATUSES as readonly string[]).includes(value.status)
    || value.stopped !== true || !oid(value.commitSha) || !oid(value.treeSha)
    || !oid(value.targetBase) || typeof value.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.inputDigest)) {
    fail(value?.stopped === false ? 'verification_stop_unconfirmed' : 'verification_evidence_incomplete');
  }
  for (const [field, ref] of [['verificationPlan', value.verificationPlan], ['verificationResult', value.verificationResult]] as const) {
    if (!ref || typeof ref !== 'object') fail('verification_evidence_incomplete', { field });
    validateStableId(ref.id, { operation: `${OPERATION}.evidence` }, `${field}.id`);
    validateSha256Digest(ref.digest, { operation: `${OPERATION}.evidence` }, `${field}.digest`);
  }
}

function oldIntegrationResult(
  candidate: Candidate,
  result: IntegrationVerificationExecutionResult,
): IntegrationResult {
  return {
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    verificationEvidence: {
      evidenceId: result.verificationResult.id,
      evidenceDigest: result.verificationResult.digest,
      planRef: { ...result.verificationPlan },
      resultRef: { ...result.verificationResult },
    },
    llmNoConflictText: null,
    operationId: candidate.operation.intent.operationId,
    ownerId: candidate.operation.intent.ownerId,
    ownerVersion: candidate.operation.intent.budgetSnapshot?.ownerVersion as number,
    operationStatus: result.status === 'passed' ? 'succeeded' : 'failed',
  };
}

function executionResult(candidate: Candidate, result: IntegrationVerificationExecutionResult) {
  return {
    commitSha: result.commitSha,
    treeSha: result.treeSha,
    inputDigest: candidate.operation.intent.integrationPlan!.inputDigest,
    verificationEvidence: {
      evidenceId: result.verificationResult.id,
      evidenceDigest: result.verificationResult.digest,
    },
  };
}

export function createIntegrationVerificationService(deps: {
  readonly atomic: AtomicCommandStore;
  readonly journal: GitIntegrationJournal;
  readonly executor: IntegrationVerificationExecutor;
  readonly readAuthorization: (
    tx: CommandTransaction,
    request: IntegrationVerificationRequest,
    operation: GitOperationRecord,
  ) => boolean;
  readonly nowUtcMs?: () => number;
}): IntegrationVerificationService {
  if (!deps || typeof deps.atomic?.transact !== 'function' || typeof deps.journal?.read !== 'function'
    || typeof deps.executor?.start !== 'function' || typeof deps.readAuthorization !== 'function') throw new TypeError(`${OPERATION}.create: dependencies missing`);
  const now = deps.nowUtcMs ?? Date.now;

  async function run(request: IntegrationVerificationRequest): Promise<IntegrationVerificationResult> {
    validateRequest(request);
    const settled = deps.atomic.transact(`${OPERATION}.replay`, tx => {
      const operation = tx.getGitOperation(request.projectId, request.operationId);
      const sourcePlanId = operation.intent.budgetSnapshot?.sourcePlanId;
      if (!['succeeded', 'failed'].includes(operation.status) || typeof sourcePlanId !== 'string') return null;
      const integration = tx.getIntegrationPlan(request.projectId, sourcePlanId);
      if (operation.status === 'succeeded' && integration.status === 'integration_passed') {
        return { outcome: 'passed', reason: 'verified', integration, operation } satisfies IntegrationVerificationResult;
      }
      if (operation.status === 'failed' && integration.status === 'blocked') {
        return { outcome: 'failed', reason: 'verification_failed', integration, operation } satisfies IntegrationVerificationResult;
      }
      return null;
    });
    if (settled !== null) return settled;
    let candidate: Candidate;
    try {
      candidate = deps.atomic.transact(`${OPERATION}.admit`, tx => assertCandidate(tx, request, deps.journal, deps.readAuthorization));
    } catch (error) {
      if (error instanceof StorageError && error.details?.reason === 'authorization_not_current') {
        return blocked('authorization_not_current');
      }
      if (error instanceof StorageError && error.details?.reason === 'candidate_missing') return blocked('candidate_missing');
      if (error instanceof StorageError && error.details?.reason === 'candidate_not_ready') return blocked('candidate_not_ready');
      throw error;
    }

    let execution: IntegrationVerificationExecutionResult;
    const persistBlocked = (
      reason: IntegrationVerificationResult['reason'],
      blockReason: 'integration_evidence_incomplete' | 'verification_stop_unconfirmed',
    ): IntegrationVerificationResult => {
      try {
        const integration = deps.atomic.transact(`${OPERATION}.block`, tx => {
          const current = tx.getIntegrationPlan(request.projectId, candidate.sourcePlanId);
          if (current.integrationResult?.operationId !== request.operationId
            || current.integrationResult?.operationStatus !== 'pending') return current;
          return tx.updateIntegrationPlanStatus({
            projectId: request.projectId, integrationId: candidate.sourcePlanId, expectedRevision: current.revision,
            status: 'blocked', blockReasons: [...new Set([...current.blockReasons, blockReason])],
            staleReasons: current.staleReasons, operationId: request.operationId,
            ownerId: request.ownerId, ownerVersion: request.ownerVersion,
          });
        });
        return blocked(reason, integration, candidate.operation);
      } catch { return blocked(reason, candidate.sourcePlan, candidate.operation); }
    };
    const executionInput: IntegrationVerificationExecutionInput = {
      projectId: request.projectId,
      operationId: request.operationId,
      sourcePlanId: candidate.sourcePlanId,
      targetBaseline: candidate.sourcePlan.targetBaseline,
      inputDigest: candidate.sourcePlan.inputDigest,
      workspace: candidate.observation.workspace!,
      plan: request.verificationPlan,
      targets: [...request.targets],
    };
    try {
      execution = await deps.executor.start(executionInput);
    } catch {
      return persistBlocked('verification_evidence_incomplete', 'integration_evidence_incomplete');
    }
    try {
      validateExecutionResult(execution);
      const workspace = candidate.observation.workspace!;
      if (execution.commitSha !== workspace.currentHead || execution.treeSha !== workspace.facts.tree
        || execution.targetBase !== candidate.sourcePlan.targetBaseline
        || execution.inputDigest !== candidate.sourcePlan.inputDigest) {
        fail('input_digest_mismatch');
      }
    } catch (error) {
      if (error instanceof StorageError && error.details?.reason === 'verification_stop_unconfirmed') {
        return persistBlocked('verification_stop_unconfirmed', 'verification_stop_unconfirmed');
      }
      if (error instanceof StorageError && error.details?.reason === 'input_digest_mismatch') {
        return persistBlocked('input_digest_mismatch', 'integration_evidence_incomplete');
      }
      if (error instanceof StorageError && error.details?.reason === 'verification_plan_unavailable') return persistBlocked('verification_plan_unavailable', 'integration_evidence_incomplete');
      if (error instanceof StorageError && error.details?.reason === 'verification_evidence_incomplete') return persistBlocked('verification_evidence_incomplete', 'integration_evidence_incomplete');
      return persistBlocked('verification_evidence_incomplete', 'integration_evidence_incomplete');
    }

    try {
      return deps.atomic.transact(`${OPERATION}.settle`, tx => {
        const current = assertCandidate(tx, request, deps.journal, deps.readAuthorization);
        if (current.operation.revision !== candidate.operation.revision
          || current.sourcePlan.revision !== candidate.sourcePlan.revision
          || !isDeepStrictEqual(current.observation, candidate.observation)) fail('source_changed');
        const workspace = current.observation.workspace!;
        const passed = execution.status === 'passed';
        const integrationResult = oldIntegrationResult(current, execution);
        const source = tx.updateIntegrationPlanResult({
          projectId: request.projectId, integrationId: current.sourcePlanId, expectedRevision: current.sourcePlan.revision,
          operationId: request.operationId, ownerId: request.ownerId, ownerVersion: request.ownerVersion,
          integrationResult,
        });
        let settledPlan = source;
        if (!passed) {
          settledPlan = tx.updateIntegrationPlanStatus({
            projectId: request.projectId, integrationId: current.sourcePlanId, expectedRevision: source.revision,
            status: 'blocked', blockReasons: [...new Set([...source.blockReasons, 'verification_failed'])],
            staleReasons: source.staleReasons, operationId: request.operationId,
            ownerId: request.ownerId, ownerVersion: request.ownerVersion,
          });
        }
        const settled = tx.finalizeGitOperation({
          operationId: request.operationId, projectId: request.projectId, expectedRevision: current.operation.revision,
          status: passed ? 'succeeded' : 'failed', actualCommit: workspace.currentHead, actualTree: workspace.facts.tree,
          exitCode: passed ? 0 : 1, durationMs: null, reasonCode: passed ? null : 'verification_failed',
          deliveryStatus: 'not_requested', settledAtUtcMs: now(), integrationResult: passed ? executionResult(current, execution) : undefined,
          recoveryState: 'preserved', workspacePreserved: true,
        });
        return {
          outcome: passed ? 'passed' : 'failed', reason: passed ? 'verified' : 'verification_failed',
          integration: settledPlan, operation: settled.operation,
        } satisfies IntegrationVerificationResult;
      });
    } catch (error) {
      if (error instanceof StorageError && ['source_changed', 'stale_revision', 'owner_fenced', 'operation_fenced'].includes(String(error.details?.reason))) {
        return blocked('settlement_conflict', candidate.sourcePlan, candidate.operation);
      }
      throw error;
    }
  }

  return { run };
}
