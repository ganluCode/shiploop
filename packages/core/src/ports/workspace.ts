import type { CommandReceipt } from './commands.js';
import { ATTEMPT_EXECUTION_STAGES } from './attempt-store.js';
import type { AttemptExecutionStage } from './attempt-store.js';
import type { WorkResourceIdentity } from './work-resources.js';
import { validateWorkResourceIdentity } from './work-resources.js';
import { validatePersistableCommandReceipt } from './command-receipts.js';
import { StorageError } from './errors.js';
import {
  rejectUnknownKeys, requirePlainObject, requireNonEmptyString, validateStableId,
  validateSha256Digest, validatePositiveInteger, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const WORKSPACE_STATUSES = ['preparing', 'ready', 'retained', 'quarantined', 'cleanup_pending', 'cleaned'] as const;
export type WorkspaceStatus = typeof WORKSPACE_STATUSES[number];
export const WORKSPACE_OPERATION_KINDS = ['prepare', 'retain', 'cleanup'] as const;
export type WorkspaceOperationKind = typeof WORKSPACE_OPERATION_KINDS[number];
export const WORKSPACE_OPERATION_STATUSES = ['pending', 'succeeded', 'failed', 'blocked'] as const;
export type WorkspaceOperationStatus = typeof WORKSPACE_OPERATION_STATUSES[number];
export const WORKSPACE_EVENT_TYPE = 'workspace.operation_updated' as const;

/** Immutable confirmed baseline; verified HEAD/code are recorded separately. No lease copy. */
export interface WorkspaceBaseline {
  readonly repositoryBindingId: string;
  readonly repositoryBindingRevision: number;
  readonly repoIdentity: string;
  readonly canonicalPath: string;
  readonly gitCommonDir: string;
  readonly branch: string;
  readonly baseCommit: string;
}
export interface ManagedWorkspaceRecord extends WorkspaceBaseline {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly preparationOperationId: string;
  readonly status: WorkspaceStatus;
  readonly headCommit: string | null;
  readonly codeDigest: string | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly runId: string;
  readonly attemptId: string;
}
export interface WorkspaceOperationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly identity: WorkResourceIdentity;
  readonly kind: WorkspaceOperationKind;
  readonly executionStage: AttemptExecutionStage;
  readonly principalId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly status: WorkspaceOperationStatus;
  readonly result: WorkspaceOperationResult | null;
  readonly revision: number;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}
/** Bounded, non-sensitive evidence only, not arbitrary output/env/credential JSON. */
export interface WorkspaceOperationResult {
  readonly evidenceRefs: readonly string[];
  readonly errorRef: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}
export interface BeginWorkspaceOperationInput {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly featureId: string;
  readonly kind: WorkspaceOperationKind;
  readonly identity: WorkResourceIdentity;
  readonly executionStage: AttemptExecutionStage;
  readonly expectedWorkspaceRevision: number | null;
  readonly baseline: WorkspaceBaseline;
  readonly receipt: CommandReceipt;
}
export interface FinishWorkspaceOperationInput {
  readonly operationId: string;
  readonly identity: WorkResourceIdentity;
  readonly expectedRevision: number;
  readonly expectedWorkspaceRevision: number;
  readonly status: Exclude<WorkspaceOperationStatus, 'pending'>;
  readonly workspaceStatus: WorkspaceStatus;
  readonly headCommit: string | null;
  readonly codeDigest: string | null;
  readonly result: WorkspaceOperationResult;
  readonly receipt: CommandReceipt;
}
export interface WorkspacePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface WorkspaceOperationCommit {
  readonly workspace: ManagedWorkspaceRecord;
  readonly operation: WorkspaceOperationRecord;
  readonly receipt: CommandReceipt;
  readonly replay: boolean;
}
/** All mutations are synchronous primitives inside the caller's short write transaction. */
export interface WorkspaceOperationAccess {
  readWorkspace(projectId: unknown, featureId: unknown): ManagedWorkspaceRecord | null;
  readOperation(projectId: unknown, operationId: unknown): WorkspaceOperationRecord | null;
  listWorkspaces(input: unknown): WorkspacePage<ManagedWorkspaceRecord>;
  listOperations(input: unknown): WorkspacePage<WorkspaceOperationRecord>;
  beginInTransaction(input: unknown): WorkspaceOperationCommit;
  finishInTransaction(input: unknown): WorkspaceOperationCommit;
}

const context: ValidationContext = { operation: 'Workspace', entity: { type: 'workspace' } };
function integer(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw validationError(context, field, 'Invalid integer');
  return Number(value);
}
function string(value: unknown, field: string): string {
  const result = requireNonEmptyString(value, context, field);
  if (result.length > 4096 || /[\0-\x1f\x7f]/.test(result)) throw validationError(context, field, 'Invalid bounded string');
  return result;
}
function canonicalPath(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result.startsWith('/') || result === '/' || result.endsWith('/') || result.split('/').slice(1).some(p => !p || p === '.' || p === '..')) {
    throw validationError(context, field, 'Expected canonical absolute path');
  }
  return result;
}
export function validateWorkspaceCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw validationError(context, 'commit', 'Invalid Git object ID');
  return value;
}
export function workspaceMember<T extends readonly string[]>(value: unknown, members: T, field: string): T[number] {
  if (typeof value !== 'string' || !members.includes(value)) throw validationError(context, field, 'Unsupported value');
  return value as T[number];
}
export function validateWorkspaceBaseline(value: unknown): WorkspaceBaseline {
  const raw = requirePlainObject(value, context, 'baseline');
  rejectUnknownKeys(raw, ['repositoryBindingId', 'repositoryBindingRevision', 'repoIdentity', 'canonicalPath', 'gitCommonDir', 'branch', 'baseCommit'], context, 'baseline');
  const branch = string(raw.branch, 'branch');
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..')
    || branch.includes('@{') || /[\s~^:?*\[\\]/.test(branch) || branch.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) {
    throw validationError(context, 'branch', 'Invalid branch name');
  }
  return {
    repositoryBindingId: validateStableId(raw.repositoryBindingId, context, 'repositoryBindingId'),
    repositoryBindingRevision: integer(raw.repositoryBindingRevision, 'repositoryBindingRevision'),
    repoIdentity: string(raw.repoIdentity, 'repoIdentity'), canonicalPath: canonicalPath(raw.canonicalPath, 'canonicalPath'), gitCommonDir: canonicalPath(raw.gitCommonDir, 'gitCommonDir'),
    branch, baseCommit: validateWorkspaceCommit(raw.baseCommit),
  };
}
function receipt(value: unknown, identity: WorkResourceIdentity): CommandReceipt {
  const result = validatePersistableCommandReceipt(value, 'Workspace.receipt');
  // The command is completed when this persistence step is committed, not when Git succeeds.
  if (result.status !== 'completed' || result.scope.kind !== 'project' || result.scope.projectId !== identity.projectId) {
    throw new StorageError('ownership', 'Workspace', 'Expected completed command receipt in the same project');
  }
  return result;
}
export function validateBeginWorkspaceOperation(value: unknown): BeginWorkspaceOperationInput {
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['operationId', 'workspaceId', 'featureId', 'kind', 'identity', 'executionStage', 'expectedWorkspaceRevision', 'baseline', 'receipt'], context, 'input');
  const identity = validateWorkResourceIdentity(raw.identity);
  return { operationId: validateStableId(raw.operationId, context, 'operationId'), workspaceId: validateStableId(raw.workspaceId, context, 'workspaceId'),
    featureId: validateStableId(raw.featureId, context, 'featureId'), kind: workspaceMember(raw.kind, WORKSPACE_OPERATION_KINDS, 'kind'), identity,
    executionStage: workspaceMember(raw.executionStage, ATTEMPT_EXECUTION_STAGES, 'executionStage'),
    expectedWorkspaceRevision: raw.expectedWorkspaceRevision === null ? null : integer(raw.expectedWorkspaceRevision, 'expectedWorkspaceRevision'),
    baseline: validateWorkspaceBaseline(raw.baseline), receipt: receipt(raw.receipt, identity) };
}
export function validateWorkspaceOperationResult(value: unknown): WorkspaceOperationResult {
  const raw = requirePlainObject(value, context, 'result');
  rejectUnknownKeys(raw, ['evidenceRefs', 'errorRef', 'startedAtUtcMs', 'endedAtUtcMs', 'durationMs', 'exitCode', 'signal'], context, 'result');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length > 50) throw validationError(context, 'evidenceRefs', 'Expected bounded evidence list');
  const optionalInteger = (field: string, min = 0) => raw[field] === null ? null : integer(raw[field], field, min);
  const startedAtUtcMs = optionalInteger('startedAtUtcMs'), endedAtUtcMs = optionalInteger('endedAtUtcMs');
  if (startedAtUtcMs !== null && endedAtUtcMs !== null && endedAtUtcMs < startedAtUtcMs) throw validationError(context, 'endedAtUtcMs', 'Invalid time interval');
  return { evidenceRefs: raw.evidenceRefs.map(v => validateStableId(v, context, 'evidenceRef')),
    errorRef: raw.errorRef === null ? null : validateStableId(raw.errorRef, context, 'errorRef'), startedAtUtcMs, endedAtUtcMs,
    durationMs: optionalInteger('durationMs'), exitCode: raw.exitCode === null ? null : integer(raw.exitCode, 'exitCode', -2147483648),
    signal: raw.signal === null ? null : string(raw.signal, 'signal') };
}
export function validateFinishWorkspaceOperation(value: unknown): FinishWorkspaceOperationInput {
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['operationId', 'identity', 'expectedRevision', 'expectedWorkspaceRevision', 'status', 'workspaceStatus', 'headCommit', 'codeDigest', 'result', 'receipt'], context, 'input');
  const identity = validateWorkResourceIdentity(raw.identity);
  return { operationId: validateStableId(raw.operationId, context, 'operationId'), identity,
    expectedRevision: integer(raw.expectedRevision, 'expectedRevision'), expectedWorkspaceRevision: integer(raw.expectedWorkspaceRevision, 'expectedWorkspaceRevision'),
    status: workspaceMember(raw.status, ['succeeded', 'failed', 'blocked'] as const, 'status'), workspaceStatus: workspaceMember(raw.workspaceStatus, WORKSPACE_STATUSES, 'workspaceStatus'),
    headCommit: raw.headCommit === null ? null : validateWorkspaceCommit(raw.headCommit), codeDigest: raw.codeDigest === null ? null : validateSha256Digest(raw.codeDigest, context, 'codeDigest'),
    result: validateWorkspaceOperationResult(raw.result), receipt: receipt(raw.receipt, identity) };
}
export function validateWorkspacePage(value: unknown): { projectId: string; cursor: string | null; limit: number; featureId: string | null } {
  const raw = requirePlainObject(value, context, 'page');
  rejectUnknownKeys(raw, ['projectId', 'featureId', 'cursor', 'limit'], context, 'page');
  const limit = raw.limit === undefined ? 100 : validatePositiveInteger(raw.limit, context, 'limit');
  if (limit > 500) throw validationError(context, 'limit', 'Maximum page size is 500');
  return { projectId: validateStableId(raw.projectId, context, 'projectId'), featureId: raw.featureId == null ? null : validateStableId(raw.featureId, context, 'featureId'),
    cursor: raw.cursor == null ? null : validateStableId(raw.cursor, context, 'cursor'), limit };
}
