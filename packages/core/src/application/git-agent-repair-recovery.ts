import type { GitAgentRepairRuntimeOutput } from '../ports/git-agent-repair.js';
import type { GitAgentRepairService } from './git-agent-repair.js';
import {
  decideGitAgentRepairRecovery,
  validateGitAgentRepairRecoveryObservation,
  validateGitAgentRepairRecoveryRequest,
  type GitAgentRepairRecoveryDecision,
  type GitAgentRepairRecoveryObservation,
  type GitAgentRepairRecoveryRequest,
} from '../ports/git-agent-recovery.js';

export interface GitAgentRepairRecoveryDependencies {
  readonly repair: Pick<GitAgentRepairService, 'read' | 'settle' | 'hold'>;
  /** Trusted Core census. It must perform stop, workspace, Git, operation and side-effect checks in that order. */
  readonly observe: (request: GitAgentRepairRecoveryRequest) => Promise<GitAgentRepairRecoveryObservation>;
  /** Optional existing Git operation reconciler. It never starts a commit. */
  readonly reconcileOperation?: (request: GitAgentRepairRecoveryRequest, observation: GitAgentRepairRecoveryObservation) => Promise<{
    readonly status: 'succeeded' | 'no_change' | 'failed' | 'unknown' | 'pending';
    readonly matched: boolean;
  }>;
  readonly nowUtcMs?: () => number;
}

export interface GitAgentRepairRecoveryResult {
  readonly decision: GitAgentRepairRecoveryDecision;
  readonly repair: ReturnType<GitAgentRepairService['read']>;
  readonly settled: boolean;
  readonly reconciled: boolean;
  readonly canCreateAttempt: boolean;
}

function holdReason(reason: GitAgentRepairRecoveryDecision['reason']): Parameters<GitAgentRepairService['hold']>[2] | null {
  switch (reason) {
    case 'stop_unconfirmed': return 'stop_unconfirmed';
    case 'budget_exhausted': return 'budget_exhausted';
    case 'stale_owner':
    case 'workspace_mismatch':
    case 'git_facts_mismatch':
    case 'reconciliation_required':
    case 'operation_pending':
    case 'operation_reconciled':
    case 'attempt_not_found':
    case 'already_settled':
    case 'cancelled':
    case 'runtime_interrupted':
    case 'deadline_exceeded':
      return 'identity_or_lock';
  }
}

function recoveryOutput(
  request: GitAgentRepairRecoveryRequest,
  reason: Exclude<GitAgentRepairRecoveryDecision, { action: 'reconcile' | 'reconciled' }>['reason'],
  attempt: ReturnType<GitAgentRepairService['read']>['attempts'][number],
): GitAgentRepairRuntimeOutput {
  const status = reason === 'cancelled' ? 'cancelled' : 'failed';
  const failureCode = reason === 'cancelled' || reason === 'deadline_exceeded' || reason === 'budget_exhausted'
    ? reason : 'process_exited';
  return {
    schemaVersion: 1,
    repairId: request.repairId,
    status,
    changedPaths: [],
    // No trustworthy partial usage survives a crash. Consuming the admitted grant
    // prevents a restart from refunding an unknown provider/tool side effect.
    usage: { consumedTokens: attempt.maxTokens, runtimeMs: attempt.maxRuntimeMs },
    failureCode,
  };
}

/**
 * Durable GitAgent recovery gate. It diagnoses one admitted Attempt and either
 * settles it conservatively or returns an explicit reconciliation/manual boundary.
 * It never starts a Runtime, commits Git, or releases a resource directly.
 */
export function createGitAgentRepairRecoveryService(
  deps: GitAgentRepairRecoveryDependencies,
) {
  if (!deps || typeof deps.repair?.read !== 'function' || typeof deps.repair.settle !== 'function'
    || typeof deps.repair.hold !== 'function' || typeof deps.observe !== 'function') {
    throw new TypeError('GitAgentRepairRecovery dependencies are required');
  }
  const now = deps.nowUtcMs ?? Date.now;

  return {
    async recover(rawRequest: unknown): Promise<GitAgentRepairRecoveryResult> {
      const request = validateGitAgentRepairRecoveryRequest({ ...rawRequest as object, nowUtcMs: (rawRequest as { nowUtcMs?: unknown }).nowUtcMs ?? now() });
      const current = deps.repair.read(request.projectId, request.repairId);
      const observation = validateGitAgentRepairRecoveryObservation(await deps.observe(request));
      const decision = decideGitAgentRepairRecovery(request, observation, current);

      if (decision.action === 'reconcile') {
        if (deps.reconcileOperation === undefined) {
          return { decision: { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false }, repair: current, settled: false, reconciled: false, canCreateAttempt: false };
        }
        const reconciliation = await deps.reconcileOperation(request, observation);
        if (reconciliation.matched && (reconciliation.status === 'succeeded' || reconciliation.status === 'no_change')) {
          return {
            decision: { action: 'reconciled', reason: 'operation_reconciled', allowNewAttempt: false },
            repair: current, settled: false, reconciled: true, canCreateAttempt: false,
          };
        }
        return {
          decision: { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false },
          repair: current, settled: false, reconciled: false, canCreateAttempt: false,
        };
      }
      if (decision.action !== 'retryable') {
        const hold = holdReason(decision.reason);
        const repair = hold === null || decision.reason === 'stale_owner' || decision.reason === 'already_settled'
          ? current : deps.repair.hold(request.projectId, request.repairId, hold);
        return { decision, repair, settled: false, reconciled: false, canCreateAttempt: false };
      }

      const attempt = current.attempts.find(item => item.id === request.attemptId);
      if (attempt === undefined) {
        const blocked: GitAgentRepairRecoveryDecision = { action: 'blocked', reason: 'attempt_not_found', allowNewAttempt: false };
        return { decision: blocked, repair: current, settled: false, reconciled: false, canCreateAttempt: false };
      }
      // The store rechecks owner/version and dispatch fencing in its short transaction.
      const repair = deps.repair.settle(
        { projectId: request.projectId, repairId: request.repairId, attemptId: request.attemptId,
          ownerId: request.ownerId, hostInstanceId: request.hostInstanceId, authorizationVersion: request.authorizationVersion },
        recoveryOutput(request, decision.reason, attempt),
        { stopped: true },
      );
      return { decision, repair, settled: true, reconciled: false,
        canCreateAttempt: repair.blockedReason === null
          && decision.reason !== 'deadline_exceeded' && decision.reason !== 'budget_exhausted' };
    },
  };
}

export type GitAgentRepairRecoveryService = ReturnType<typeof createGitAgentRepairRecoveryService>;
