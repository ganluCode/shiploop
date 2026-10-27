import type { WorkResourceIdentity, WorkResourceSnapshot } from './work-resources.js';
import { validateWorkResourceIdentity } from './work-resources.js';
import type { WorkspaceOperationCommit } from './workspace.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validatePositiveInteger, validationError } from './validation.js';

export const WORKSPACE_RETENTION_REASONS = ['authentication_failed', 'rate_limited', 'protocol_error', 'execution_error',
  'verification_failed', 'timed_out', 'cancelled', 'partial', 'approval_waiting', 'interrupted', 'planning_delivered'] as const;
export type WorkspaceRetentionReason = typeof WORKSPACE_RETENTION_REASONS[number];
export type WorkspaceRetentionStop = 'not_started' | 'confirmed' | 'unknown';
export interface WorkspaceRetentionInput {
  readonly identity: WorkResourceIdentity;
  readonly runId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedWorkspaceRevision: number;
  readonly reason: WorkspaceRetentionReason;
  readonly evidenceRefs: readonly string[];
}
export interface WorkspaceRetentionIntent {
  readonly commit: WorkspaceOperationCommit;
  readonly resources: WorkResourceSnapshot;
  readonly attemptRevision: number;
  readonly unstarted: boolean;
  readonly preparationStopped: boolean;
  readonly previouslyReleased: boolean;
}
export interface WorkspaceRetentionStore {
  begin(input: WorkspaceRetentionInput): WorkspaceRetentionIntent;
  finish(input: WorkspaceRetentionInput, intent: WorkspaceRetentionIntent, stop: WorkspaceRetentionStop,
    evidenceRef: string, stopToken?: object): WorkspaceOperationCommit;
  quarantine(input: WorkspaceRetentionInput, intent: WorkspaceRetentionIntent): void;
}
export function validateWorkspaceRetentionInput(value: unknown): WorkspaceRetentionInput {
  const context = { operation: 'Workspace.retain' };
  const raw = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(raw, ['identity', 'runId', 'taskId', 'workspaceId', 'operationId', 'expectedWorkspaceRevision', 'reason', 'evidenceRefs'], context, 'input');
  if (typeof raw.reason !== 'string' || !WORKSPACE_RETENTION_REASONS.includes(raw.reason as WorkspaceRetentionReason)) throw validationError(context, 'reason', 'unsupported_retention_reason');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length < 1 || raw.evidenceRefs.length > 49) throw validationError(context, 'evidenceRefs', 'Expected bounded evidence references');
  return { identity: validateWorkResourceIdentity(raw.identity),
    runId: validateStableId(raw.runId, context, 'runId'), taskId: validateStableId(raw.taskId, context, 'taskId'),
    workspaceId: validateStableId(raw.workspaceId, context, 'workspaceId'), operationId: validateStableId(raw.operationId, context, 'operationId'),
    expectedWorkspaceRevision: validatePositiveInteger(raw.expectedWorkspaceRevision, context, 'expectedWorkspaceRevision'),
    reason: raw.reason as WorkspaceRetentionReason, evidenceRefs: raw.evidenceRefs.map(v => validateStableId(v, context, 'evidenceRef')) };
}
