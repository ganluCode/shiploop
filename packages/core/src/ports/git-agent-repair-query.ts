import type { GitAgentRepairView } from './git-agent-repair-store.js';
import type { GitOperationDetailResult, PublicGitOperationRecord } from './git-operation-query.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import type { PlanListRequest, PlanListResultBase } from './queries.js';
import { validateStableId, validationError, type ValidationContext } from './validation.js';

export const GIT_REPAIRS_LIST_OPERATION = 'git.repairs.list' as const;
export const GIT_REPAIR_GET_OPERATION = 'git.repairs.get' as const;
export const GIT_REPAIR_QUERY_OPERATIONS = [GIT_REPAIRS_LIST_OPERATION, GIT_REPAIR_GET_OPERATION] as const;
export type GitAgentRepairQueryOperation = typeof GIT_REPAIR_QUERY_OPERATIONS[number];

export interface PublicGitAgentRepairAttempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly status: 'running' | 'modified' | 'no_change' | 'failed' | 'cancelled';
  readonly changedPaths: readonly string[];
  readonly consumedTokens: number | null;
  readonly runtimeMs: number | null;
  readonly failureCode: string | null;
  readonly startedAt: string;
  readonly stoppedAt: string | null;
}

export interface PublicGitAgentRepairRecord {
  readonly repairId: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly parentBatchId: string;
  readonly sourceOperationId: string;
  readonly runId: string | null;
  readonly authorizationDigest: string;
  readonly authorizationVersion: number;
  readonly blockedReason: string | null;
  readonly source: {
    readonly failureKind: string;
    readonly evidenceId: string;
    readonly inputDigest: string;
  };
  readonly target: { readonly repoIdentity: string; readonly baselineCommitSha: string };
  readonly workspaceId: string;
  readonly conflictFiles: readonly string[];
  readonly writablePaths: readonly string[];
  readonly intentId: string;
  readonly verificationStrategyId: string;
  readonly budget: {
    readonly remainingAttempts: number;
    readonly remainingTokens: number;
    readonly remainingRuntimeMs: number;
    readonly deadline: string;
  };
  readonly attempts: readonly PublicGitAgentRepairAttempt[];
  readonly sourceOperation: PublicGitOperationRecord | null;
  readonly candidateOperation: PublicGitOperationRecord | null;
}

export interface GitAgentRepairListResult extends PlanListResultBase {
  readonly scope: 'git-repair-list';
  readonly records: readonly PublicGitAgentRepairRecord[];
}

export interface GitAgentRepairDetailResult {
  readonly repair: PublicGitAgentRepairRecord;
}

export interface GitAgentRepairQueryReadStore {
  readGitAgentRepair(projectId: unknown, repairId: unknown): GitAgentRepairView | undefined;
  listGitAgentRepairs(projectId: unknown, request: PlanListRequest): {
    readonly records: readonly GitAgentRepairView[];
    readonly nextCursor: string | null;
  };
}

export function toPublicGitAgentRepairRecord(
  view: GitAgentRepairView,
  sourceOperation: PublicGitOperationRecord | null = null,
  candidateOperation: PublicGitOperationRecord | null = null,
): PublicGitAgentRepairRecord {
  return {
    repairId: view.receipt.repairId,
    projectId: view.request.projectId,
    featureId: view.request.featureId,
    parentBatchId: view.receipt.parentBatchId,
    sourceOperationId: view.request.source.operationId,
    runId: view.receipt.runId,
    authorizationDigest: view.receipt.authorizationDigest,
    authorizationVersion: view.authorizationVersion,
    blockedReason: view.blockedReason,
    source: {
      failureKind: view.request.source.failureKind,
      evidenceId: view.request.source.evidenceId,
      inputDigest: view.request.source.inputDigest,
    },
    target: {
      repoIdentity: view.request.target.repoIdentity,
      baselineCommitSha: view.request.target.baselineCommitSha,
    },
    workspaceId: view.request.workspace.workspaceId,
    conflictFiles: [...view.request.conflictFiles],
    writablePaths: [...view.request.writablePaths],
    intentId: view.request.intent.intentId,
    verificationStrategyId: view.request.verification.strategyId,
    budget: {
      remainingAttempts: view.request.budget.remainingAttempts,
      remainingTokens: view.request.budget.remainingTokens,
      remainingRuntimeMs: view.request.budget.remainingRuntimeMs,
      deadline: new Date(view.request.budget.deadlineUtcMs).toISOString(),
    },
    attempts: view.attempts.map(attempt => ({
      attemptId: attempt.id,
      runId: attempt.runId,
      status: attempt.output?.status ?? 'running',
      changedPaths: attempt.output?.changedPaths ?? [],
      consumedTokens: attempt.output?.usage.consumedTokens ?? null,
      runtimeMs: attempt.output?.usage.runtimeMs ?? null,
      failureCode: attempt.output?.failureCode ?? null,
      startedAt: new Date(attempt.startedAtUtcMs).toISOString(),
      stoppedAt: attempt.stoppedAtUtcMs === null ? null : new Date(attempt.stoppedAtUtcMs).toISOString(),
    })),
    sourceOperation,
    candidateOperation,
  };
}

export function validateGitAgentRepairListSelector(input: Record<string, unknown>, operation: string): void {
  const context: ValidationContext = { operation, entity: { type: 'git_operation' } };
  validateStableId(input.projectId, context, 'projectId');
}

export function validatePublicGitAgentRepairRecord(value: unknown, operation: string = GIT_REPAIR_GET_OPERATION): PublicGitAgentRepairRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ operation }, 'repair', 'object_required');
  }
  const record = value as PublicGitAgentRepairRecord;
  if (record.projectId === undefined || record.repairId === undefined || !Array.isArray(record.attempts)) {
    throw validationError({ operation }, 'repair', 'malformed');
  }
  return record;
}

export function validateGitAgentRepairQueryResult(value: unknown, operation: GitAgentRepairQueryOperation): GitAgentRepairListResult | GitAgentRepairDetailResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError({ operation }, 'response', 'object_required');
  }
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw validationError({ operation }, 'schemaVersion', 'unsupported_schema_version');
  }
  if (operation === GIT_REPAIR_GET_OPERATION) {
    return { repair: validatePublicGitAgentRepairRecord(object.repair, operation) };
  }
  if (object.scope !== 'git-repair-list' || !Array.isArray(object.records) ||
      (object.nextCursor !== null && typeof object.nextCursor !== 'string') || typeof object.limit !== 'number') {
    throw validationError({ operation }, 'response', 'malformed');
  }
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'git-repair-list',
    records: object.records.map(item => validatePublicGitAgentRepairRecord(item, operation)),
    nextCursor: object.nextCursor as string | null,
    limit: object.limit as number,
  };
}
