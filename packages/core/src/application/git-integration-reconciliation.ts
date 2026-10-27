import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../ports/errors.js';
import { validateStableId } from '../ports/validation.js';
import { validateIntegrationObservation } from '../ports/git-integration-observation.js';
import type {
  GitIntegrationReconciliation,
  GitIntegrationReconciliationDependencies,
  GitIntegrationReconciliationRequest,
  GitIntegrationReconciliationService,
  GitIntegrationRecoveryAuthorization,
  GitIntegrationWorkspaceFacts,
} from '../ports/git-integration-reconciliation.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { IntegrationExecutionObservation } from '../ports/git-integration-journal.js';
import type { IntegrationWorkspaceStep } from '../ports/integration-workspace.js';

const OP = 'GitIntegration.reconcile';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function fail(reason: string): never {
  throw new StorageError('conflict', OP, reason, { details: { reason } });
}

function terminalOutcome(operation: GitOperationRecord): GitIntegrationReconciliation['outcome'] {
  if (operation.status === 'succeeded' || operation.status === 'no_change') return 'matched';
  if (operation.status === 'unknown') return 'unknown';
  return 'blocked';
}

function result(
  outcome: GitIntegrationReconciliation['outcome'],
  reasonCode: string | null,
  operation: GitOperationRecord,
  observation: IntegrationExecutionObservation | null,
): GitIntegrationReconciliation {
  return { outcome, reasonCode, operation, observation };
}

function errorReason(error: unknown): string {
  if (error instanceof StorageError && typeof error.details?.reason === 'string') return error.details.reason;
  if (error && typeof error === 'object' && 'reason' in error && typeof (error as { reason?: unknown }).reason === 'string') {
    return (error as { reason: string }).reason;
  }
  return 'integration_facts_unavailable';
}

function sameAuthorization(
  operation: GitOperationRecord,
  authorization: GitIntegrationRecoveryAuthorization,
): boolean {
  return isDeepStrictEqual(authorization.intent, operation.intent)
    && authorization.intent.operationType === 'integration'
    && authorization.intent.integrationPlan !== null
    && authorization.intent.integrationPlan !== undefined
    && authorization.intent.budgetSnapshot?.ownerVersion === authorization.ownerVersion;
}

function expectedStepPrefix(
  plan: NonNullable<GitOperationRecord['intent']['integrationPlan']>,
  steps: readonly IntegrationWorkspaceStep[],
): boolean {
  if (steps.length > plan.mergeOrder.length) return false;
  let parent = plan.target.baseCommit;
  for (const [index, step] of steps.entries()) {
    const featureId = plan.mergeOrder[index];
    const predecessor = plan.predecessors.find(item => item.featureId === featureId);
    const inputSha = predecessor?.delivery?.commitSha;
    if (!featureId || !inputSha || !OID.test(step.commitSha) || !OID.test(step.treeSha)
      || step.ordinal !== index + 1 || step.featureId !== featureId || step.inputSha !== inputSha
      || step.parentBefore !== parent || step.parents.length !== 2
      || step.parents[0] !== parent || step.parents[1] !== inputSha || step.status !== 'succeeded') return false;
    parent = step.commitSha;
  }
  return true;
}

function workspaceMatches(
  operation: GitOperationRecord,
  facts: GitIntegrationWorkspaceFacts,
  authorization: GitIntegrationRecoveryAuthorization,
): string | null {
  const plan = operation.intent.integrationPlan!;
  const workspace = facts.workspace;
  if (!workspace) return null;
  if (workspace.path !== operation.intent.worktreePath || workspace.ownerId !== operation.intent.ownerId
    || workspace.ownerVersion !== authorization.ownerVersion || workspace.repoIdentity !== operation.intent.repoIdentity
    || workspace.gitCommonDir !== plan.target.gitCommonDir || workspace.targetBase !== plan.target.baseCommit
    || !isDeepStrictEqual(workspace.plan, plan) || workspace.gitIdentity.name !== operation.intent.gitIdentity.name
    || workspace.gitIdentity.email !== operation.intent.gitIdentity.email || workspace.gitIdentity.confirmed !== true) {
    return 'workspace_identity_mismatch';
  }
  if (workspace.facts.head !== workspace.currentHead || workspace.facts.statusPorcelain !== ''
    || workspace.facts.unresolvedPaths.length > 0) {
    return workspace.facts.unresolvedPaths.length > 0 ? 'merge_conflict' : 'workspace_dirty';
  }
  if (!isDeepStrictEqual(workspace.steps, facts.steps)) return 'workspace_steps_mismatch';
  if (!expectedStepPrefix(plan, facts.steps)) return 'integration_step_mismatch';
  const expectedHead = facts.steps.at(-1)?.commitSha ?? plan.target.baseCommit;
  if (workspace.currentHead !== expectedHead || workspace.facts.head !== expectedHead) return 'workspace_head_drift';
  return null;
}

function mergeObservation(
  facts: GitIntegrationWorkspaceFacts,
  outcome: IntegrationExecutionObservation['outcome'],
  reason: string | null,
): IntegrationExecutionObservation | null {
  if (!facts.workspace) return null;
  return {
    outcome,
    reason,
    workspace: outcome === 'pending_verification' ? { ...facts.workspace, status: 'succeeded' } : facts.workspace,
    steps: facts.steps,
  };
}

/**
 * Reconciles an interrupted deterministic integration using only persisted intent
 * and read-only Git facts. It never calls merge/commit/cleanup and never releases
 * a Work or Git claim. Completion means that a pending-verification observation
 * was durably reconstructed; the verification service still owns delivery success.
 */
export function createGitIntegrationReconciliationService(
  deps: GitIntegrationReconciliationDependencies,
): GitIntegrationReconciliationService {

  function readState(request: GitIntegrationReconciliationRequest) {
    return deps.atomic.transact(`${OP}.read`, tx => ({
      operation: tx.getGitOperation(request.projectId, request.operationId),
      observation: deps.journal.read(tx, request.projectId, request.operationId),
    }));
  }

  return {
    async reconcile(rawRequest) {
      if (!rawRequest || Object.keys(rawRequest).some(key => !['projectId', 'operationId'].includes(key))) {
        fail('invalid_request');
      }
      const request = { projectId: validateStableId(rawRequest.projectId, { operation: OP }, 'projectId'),
        operationId: validateStableId(rawRequest.operationId, { operation: OP }, 'operationId') };
      let state = readState(request);
      if (state.operation.intent.operationType !== 'integration' || state.operation.intent.integrationPlan == null) {
        fail('operation_not_integration');
      }
      if (state.operation.status !== 'pending') {
        return result(terminalOutcome(state.operation), state.operation.reasonCode, state.operation, state.observation);
      }

      let authorization: GitIntegrationRecoveryAuthorization;
      try { authorization = structuredClone(deps.readAuthorization(request)); }
      catch { return result('blocked', 'authorization_unavailable', state.operation, state.observation); }
      if (!sameAuthorization(state.operation, authorization) || authorization.approvalCurrent !== true) {
        return result('blocked', 'authorization_changed', state.operation, state.observation);
      }
      if (await deps.verifyWriterStopped(authorization) !== true) {
        return result('unknown', 'previous_writer_stop_unconfirmed', state.operation, state.observation);
      }
      const afterStop = deps.readAuthorization(request);
      if (!sameAuthorization(state.operation, afterStop) || afterStop.approvalCurrent !== true) {
        return result('blocked', 'authorization_changed', state.operation, state.observation);
      }

      let facts: GitIntegrationWorkspaceFacts;
      try {
        facts = await deps.reader.inspect({ projectId: request.projectId, operation: state.operation, observation: state.observation });
      } catch (error) {
        const reason = errorReason(error);
        return result(reason === 'stop_unconfirmed' || reason === 'operation_unknown' ? 'unknown' : 'blocked',
          reason, state.operation, state.observation);
      }
      const plan = state.operation.intent.integrationPlan!;
      if (facts.target.repoIdentity !== plan.target.repoIdentity || facts.target.gitCommonDir !== plan.target.gitCommonDir) {
        return result('blocked', 'repo_identity_changed', state.operation, state.observation);
      }
      if (facts.target.head !== plan.target.baseCommit) {
        return result('blocked', 'target_head_drift', state.operation, state.observation);
      }
      if (facts.target.statusPorcelain !== '') {
        return result('blocked', 'source_dirty', state.operation, state.observation);
      }
      if (!facts.workspace) {
        return result('pending', state.observation === null ? 'commit_not_observed' : 'workspace_missing', state.operation, state.observation);
      }
      const workspaceReason = workspaceMatches(state.operation, facts, authorization);
      if (workspaceReason !== null) {
        const observation = mergeObservation(facts, 'blocked', workspaceReason);
        return result('blocked', workspaceReason, state.operation, observation ?? state.observation);
      }
      if (state.observation && state.observation.steps.length > facts.steps.length) {
        return result('blocked', 'persisted_steps_ahead_of_git', state.operation, state.observation);
      }
      if (state.observation && !isDeepStrictEqual(state.observation.steps, facts.steps.slice(0, state.observation.steps.length))) {
        return result('blocked', 'persisted_step_mismatch', state.operation, state.observation);
      }

      const complete = facts.steps.length === plan.mergeOrder.length;
      const recovered = mergeObservation(facts, complete ? 'pending_verification' : 'merging', null);
      if (recovered === null) return result('pending', 'workspace_missing', state.operation, state.observation);
      try { validateIntegrationObservation(recovered, state.operation.intent); }
      catch { return result('blocked', 'integration_facts_invalid', state.operation, state.observation); }
      if (state.observation?.outcome === 'pending_verification'
        && isDeepStrictEqual(state.observation, recovered)) {
        return result('matched', null, state.operation, state.observation);
      }
      if (!complete && facts.steps.length === 0 && facts.workspace.currentHead === plan.target.baseCommit) {
        return result('pending', 'no_side_effect_observed', state.operation, state.observation);
      }

      const settled = deps.atomic.transact(`${OP}.settle`, tx => {
        const current = tx.getGitOperation(request.projectId, request.operationId);
        const observed = deps.journal.read(tx, request.projectId, request.operationId);
        if (current.status !== 'pending') return { operation: current, observation: observed, outcome: terminalOutcome(current) as GitIntegrationReconciliation['outcome'], reasonCode: current.reasonCode };
        const currentAuthorization = deps.readAuthorization(request);
        if (!sameAuthorization(current, currentAuthorization) || currentAuthorization.approvalCurrent !== true) {
          return { operation: current, observation: observed, outcome: 'blocked' as const, reasonCode: 'authorization_changed' };
        }
        if (observed && isDeepStrictEqual(observed, recovered)) {
          return { operation: current, observation: observed, outcome: complete ? 'matched' as const : 'pending' as const, reasonCode: null };
        }
        deps.journal.append(tx, request.projectId, request.operationId, current.revision, recovered);
        return { operation: tx.getGitOperation(request.projectId, request.operationId), observation: recovered,
          outcome: complete ? 'matched' as const : 'pending' as const, reasonCode: null };
      });
      return result(settled.outcome, settled.reasonCode, settled.operation, settled.observation);
    },
  };
}

/** Short alias used by adapters that name the operation after its domain. */
export const createIntegrationReconciliationService = createGitIntegrationReconciliationService;
