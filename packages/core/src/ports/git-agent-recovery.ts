import type { GitOperationStatus } from './git-operations.js';
import type { GitAgentRepairClaim, GitAgentRepairView } from './git-agent-repair-store.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';

export const GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION = 1 as const;

export const GIT_AGENT_REPAIR_RECOVERY_PHASES = [
  'before_runtime', 'after_runtime', 'verification', 'before_commit', 'after_commit', 'before_receipt',
] as const;
export type GitAgentRepairRecoveryPhase = typeof GIT_AGENT_REPAIR_RECOVERY_PHASES[number];

export const GIT_AGENT_REPAIR_RECOVERY_REASONS = [
  'cancelled', 'deadline_exceeded', 'budget_exhausted', 'stop_unconfirmed',
  'reconciliation_required', 'stale_owner', 'workspace_mismatch', 'git_facts_mismatch',
  'operation_pending', 'operation_reconciled', 'runtime_interrupted', 'attempt_not_found', 'already_settled',
] as const;
export type GitAgentRepairRecoveryReason = typeof GIT_AGENT_REPAIR_RECOVERY_REASONS[number];

export type GitAgentRepairRecoveryOperation = {
  readonly status: GitOperationStatus | 'absent';
  readonly operationId: string | null;
  readonly expectedHead: string | null;
  readonly candidateTree: string | null;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  /** Core Git reconciliation has independently matched the persisted intent. */
  readonly intentMatched: boolean;
};

export type GitAgentRepairRecoveryObservation = {
  readonly schemaVersion: typeof GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION;
  readonly phase: GitAgentRepairRecoveryPhase;
  readonly processStopped: boolean;
  readonly processIdentity: string | null;
  readonly workspace: {
    readonly repoIdentity: string;
    readonly head: string;
    readonly tree: string;
  };
  readonly operation: GitAgentRepairRecoveryOperation;
  /** Side effects outside Core Git; unknown means manual reconciliation is required. */
  readonly externalSideEffect: 'none' | 'matched' | 'unknown';
};

export type GitAgentRepairRecoveryRequest = GitAgentRepairClaim & {
  readonly schemaVersion: typeof GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION;
  readonly phase: GitAgentRepairRecoveryPhase;
  readonly commandId: string;
  readonly claimKey: string;
  readonly repoIdentity: string;
  readonly baselineCommitSha: string;
  readonly requestedOutcome: 'cancelled' | 'crashed' | 'deadline_exceeded' | 'budget_exhausted';
  readonly nowUtcMs: number;
  readonly deadlineUtcMs: number;
  readonly remainingAttempts: number;
  readonly remainingTokens: number;
  readonly remainingRuntimeMs: number;
};

export type GitAgentRepairRecoveryDecision =
  | { readonly action: 'retryable'; readonly reason: GitAgentRepairRecoveryReason; readonly allowNewAttempt: true }
  | { readonly action: 'reconcile'; readonly reason: 'operation_pending'; readonly allowNewAttempt: false }
  | { readonly action: 'reconciled'; readonly reason: 'operation_reconciled'; readonly allowNewAttempt: false }
  | { readonly action: 'blocked'; readonly reason: GitAgentRepairRecoveryReason; readonly allowNewAttempt: false };

const context: ValidationContext = { operation: 'GitAgentRepairRecovery' };
function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const raw = requirePlainObject(value, context, field);
  rejectUnknownKeys(raw, keys, context, field);
  return raw;
}
function id(value: unknown, field: string): string {
  return validateStableId(value, context, field);
}
function positive(value: unknown, field: string): number {
  return validatePositiveInteger(value, context, field);
}
function nonNegative(value: unknown, field: string): number {
  return validateNonNegativeInteger(value, context, field);
}
function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw validationError(context, field, 'invalid_git_object_id');
  }
  return value;
}

export function validateGitAgentRepairRecoveryRequest(value: unknown): GitAgentRepairRecoveryRequest {
  const raw = object(value, [
    'schemaVersion', 'projectId', 'repairId', 'attemptId', 'ownerId', 'hostInstanceId',
    'authorizationVersion', 'phase', 'commandId', 'claimKey', 'repoIdentity', 'baselineCommitSha', 'requestedOutcome', 'nowUtcMs', 'deadlineUtcMs',
    'remainingAttempts', 'remainingTokens', 'remainingRuntimeMs',
  ], 'request');
  if (raw.schemaVersion !== GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION) {
    throw validationError(context, 'schemaVersion', 'unsupported_schema_version');
  }
  if (!GIT_AGENT_REPAIR_RECOVERY_PHASES.includes(raw.phase as GitAgentRepairRecoveryPhase)) {
    throw validationError(context, 'phase', 'invalid_recovery_phase');
  }
  const nowUtcMs = nonNegative(raw.nowUtcMs, 'nowUtcMs');
  const deadlineUtcMs = nonNegative(raw.deadlineUtcMs, 'deadlineUtcMs');
  return {
    schemaVersion: GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION,
    projectId: id(raw.projectId, 'projectId'), repairId: id(raw.repairId, 'repairId'), attemptId: id(raw.attemptId, 'attemptId'),
    ownerId: id(raw.ownerId, 'ownerId'), hostInstanceId: id(raw.hostInstanceId, 'hostInstanceId'),
    authorizationVersion: positive(raw.authorizationVersion, 'authorizationVersion'),
    phase: raw.phase as GitAgentRepairRecoveryPhase,
    commandId: id(raw.commandId, 'commandId'), claimKey: id(raw.claimKey, 'claimKey'),
    repoIdentity: typeof raw.repoIdentity === 'string' && raw.repoIdentity.length > 0 ? raw.repoIdentity : (() => { throw validationError(context, 'repoIdentity', 'non_empty_string_required'); })(),
    baselineCommitSha: sha(raw.baselineCommitSha, 'baselineCommitSha'),
    requestedOutcome: raw.requestedOutcome === 'cancelled' || raw.requestedOutcome === 'crashed'
      || raw.requestedOutcome === 'deadline_exceeded' || raw.requestedOutcome === 'budget_exhausted'
      ? raw.requestedOutcome : (() => { throw validationError(context, 'requestedOutcome', 'invalid_recovery_outcome'); })(),
    nowUtcMs, deadlineUtcMs,
    remainingAttempts: nonNegative(raw.remainingAttempts, 'remainingAttempts'),
    remainingTokens: nonNegative(raw.remainingTokens, 'remainingTokens'),
    remainingRuntimeMs: nonNegative(raw.remainingRuntimeMs, 'remainingRuntimeMs'),
  };
}

export function validateGitAgentRepairRecoveryObservation(value: unknown): GitAgentRepairRecoveryObservation {
  const raw = object(value, [
    'schemaVersion', 'phase', 'processStopped', 'processIdentity', 'workspace', 'operation', 'externalSideEffect',
  ], 'observation');
  if (raw.schemaVersion !== GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION) {
    throw validationError(context, 'observation.schemaVersion', 'unsupported_schema_version');
  }
  if (!GIT_AGENT_REPAIR_RECOVERY_PHASES.includes(raw.phase as GitAgentRepairRecoveryPhase)) {
    throw validationError(context, 'observation.phase', 'invalid_recovery_phase');
  }
  if (typeof raw.processStopped !== 'boolean') throw validationError(context, 'observation.processStopped', 'boolean_required');
  const workspace = object(raw.workspace, ['repoIdentity', 'head', 'tree'], 'observation.workspace');
  const operation = object(raw.operation, [
    'status', 'operationId', 'expectedHead', 'candidateTree', 'actualCommit', 'actualTree', 'intentMatched',
  ], 'observation.operation');
  const statuses: readonly (GitOperationStatus | 'absent')[] = ['absent', 'pending', 'succeeded', 'no_change', 'failed', 'unknown'];
  if (!statuses.includes(operation.status as GitOperationStatus | 'absent')) throw validationError(context, 'observation.operation.status', 'invalid_operation_status');
  if (typeof operation.intentMatched !== 'boolean') throw validationError(context, 'observation.operation.intentMatched', 'boolean_required');
  if (raw.externalSideEffect !== 'none' && raw.externalSideEffect !== 'matched' && raw.externalSideEffect !== 'unknown') {
    throw validationError(context, 'observation.externalSideEffect', 'invalid_external_side_effect');
  }
  return {
    schemaVersion: GIT_AGENT_REPAIR_RECOVERY_SCHEMA_VERSION,
    phase: raw.phase as GitAgentRepairRecoveryPhase,
    processStopped: raw.processStopped,
    processIdentity: raw.processIdentity === null ? null : id(raw.processIdentity, 'observation.processIdentity'),
    workspace: { repoIdentity: String(workspace.repoIdentity), head: sha(workspace.head, 'observation.workspace.head'), tree: sha(workspace.tree, 'observation.workspace.tree') },
    operation: {
      status: operation.status as GitOperationStatus | 'absent',
      operationId: operation.operationId === null ? null : id(operation.operationId, 'observation.operation.operationId'),
      expectedHead: operation.expectedHead === null ? null : sha(operation.expectedHead, 'observation.operation.expectedHead'),
      candidateTree: operation.candidateTree === null ? null : sha(operation.candidateTree, 'observation.operation.candidateTree'),
      actualCommit: operation.actualCommit === null ? null : sha(operation.actualCommit, 'observation.operation.actualCommit'),
      actualTree: operation.actualTree === null ? null : sha(operation.actualTree, 'observation.operation.actualTree'),
      intentMatched: operation.intentMatched,
    },
    externalSideEffect: raw.externalSideEffect,
  };
}

/** Pure recovery gate. It never starts a Runtime, commits Git, or releases a resource. */
export function decideGitAgentRepairRecovery(
  requestValue: unknown,
  observationValue: unknown,
  current?: Pick<GitAgentRepairView, 'attempts' | 'blockedReason'>,
): GitAgentRepairRecoveryDecision {
  const request = validateGitAgentRepairRecoveryRequest(requestValue);
  const observation = validateGitAgentRepairRecoveryObservation(observationValue);
  const attempt = current?.attempts.find(item => item.id === request.attemptId);
  if (current !== undefined && attempt === undefined) return { action: 'blocked', reason: 'attempt_not_found', allowNewAttempt: false };
  if (current?.blockedReason !== null && current?.blockedReason !== undefined) {
    return { action: 'blocked', reason: current.blockedReason === 'budget_exhausted' ? 'budget_exhausted' : current.blockedReason === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'reconciliation_required', allowNewAttempt: false };
  }
  if (attempt !== undefined && (attempt.ownerId !== request.ownerId || attempt.hostInstanceId !== request.hostInstanceId
    || attempt.authorizationVersion !== request.authorizationVersion)) return { action: 'blocked', reason: 'stale_owner', allowNewAttempt: false };
  if (attempt?.stoppedAtUtcMs !== null && attempt?.stoppedAtUtcMs !== undefined) {
    return { action: 'blocked', reason: 'already_settled', allowNewAttempt: false };
  }
  if (!observation.processStopped) return { action: 'blocked', reason: 'stop_unconfirmed', allowNewAttempt: false };
  if (observation.workspace.repoIdentity !== request.repoIdentity) return { action: 'blocked', reason: 'workspace_mismatch', allowNewAttempt: false };
  if ((observation.operation.status === 'absent' || observation.operation.status === 'failed')
    && observation.workspace.head !== request.baselineCommitSha) return { action: 'blocked', reason: 'git_facts_mismatch', allowNewAttempt: false };
  if (observation.externalSideEffect !== 'none' && observation.operation.status === 'absent') {
    return { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false };
  }
  if (observation.workspace.repoIdentity.length === 0) return { action: 'blocked', reason: 'workspace_mismatch', allowNewAttempt: false };
  if (observation.externalSideEffect === 'unknown') return { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false };
  if (observation.operation.status === 'unknown') return { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false };
  if (observation.operation.status === 'pending') return { action: 'reconcile', reason: 'operation_pending', allowNewAttempt: false };
  if (observation.operation.status === 'succeeded' || observation.operation.status === 'no_change') {
    return observation.operation.intentMatched
      ? { action: 'reconciled', reason: 'operation_reconciled', allowNewAttempt: false }
      : { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false };
  }
  if (request.nowUtcMs >= request.deadlineUtcMs || request.requestedOutcome === 'deadline_exceeded') {
    return { action: 'retryable', reason: 'deadline_exceeded', allowNewAttempt: true };
  }
  if (request.requestedOutcome === 'budget_exhausted'
    || request.remainingAttempts < 1 || request.remainingTokens < 1 || request.remainingRuntimeMs < 1) {
    return { action: 'retryable', reason: 'budget_exhausted', allowNewAttempt: true };
  }
  if (request.phase === 'after_commit' || request.phase === 'before_receipt') {
    return { action: 'blocked', reason: 'reconciliation_required', allowNewAttempt: false };
  }
  return { action: 'retryable', reason: request.requestedOutcome === 'cancelled' ? 'cancelled' : 'runtime_interrupted', allowNewAttempt: true };
}
