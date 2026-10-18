import type { WorkspaceLeaseRecord } from './attempt-store.js';
import type { CommandProcessIdentity } from './command-process.js';
import type { RepositoryBindingRecord } from './state-store.js';
import { StorageError } from './errors.js';
import { isUuidV4 } from './commands.js';
import { rejectUnknownKeys, requirePlainObject, validateStableId, validatePositiveInteger } from './validation.js';

export interface WorkResourceIdentity {
  readonly projectId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
}
export interface VerifiedWorkWorkspace {
  readonly binding: RepositoryBindingRecord;
  readonly authorizedRoot: string;
  readonly canonicalPath: string;
  readonly resourceKey: string;
}
/** Tokens are admitted only by the issuing trusted authority, never by their JSON shape. */
export interface WorkWorkspaceAuthority {
  verify(binding: RepositoryBindingRecord, path: unknown): Promise<VerifiedWorkWorkspace>;
  inspect(token: unknown): VerifiedWorkWorkspace;
}
export interface WorkResourceSnapshot {
  readonly identity: WorkResourceIdentity;
  readonly invocationId: string | null;
  readonly processIdentity: CommandProcessIdentity | null;
  readonly leases: readonly WorkspaceLeaseRecord[];
}
export interface WorkResourceAccess {
  read(identity: unknown): WorkResourceSnapshot;
  /** P03-9 / F-006: read a fenced historical Attempt without reviving its task write version. */
  readForRecovery(identity: unknown): WorkResourceSnapshot;
  /** Trusted recovery release; requires the same exact snapshot verified by the stop verifier. */
  releaseRecoveredStoppedInTransaction(identity: unknown, evidence: unknown): void;
  /** Only for an Attempt whose launch was never authorized or confirmed. */
  releaseRecoveredUnstartedInTransaction(identity: unknown): void;
  quarantineRecoveredInTransaction(identity: unknown): WorkResourceSnapshot;
  acquireInTransaction(identity: unknown, workspace: unknown, leaseUntilUtcMs: unknown): WorkResourceSnapshot;
  renewInTransaction(identity: unknown, leaseUntilUtcMs: unknown): WorkResourceSnapshot;
  quarantineInTransaction(identity: unknown): WorkResourceSnapshot;
  expireInTransaction(): number;
  beginLaunchInTransaction(identity: unknown): { readonly authorized: boolean; readonly invocationId: string | null };
  confirmLaunchInTransaction(identity: unknown, processIdentity: unknown): { readonly authorized: boolean };
  releaseUnstartedInTransaction(identity: unknown): void;
  releaseStoppedInTransaction(identity: unknown, evidence: unknown): void;
}
export function validateWorkResourceIdentity(value: unknown): WorkResourceIdentity {
  const context = { operation: 'WorkResources.identity' };
  const raw = requirePlainObject(value, context, 'identity');
  rejectUnknownKeys(raw, ['projectId', 'attemptId', 'owner', 'hostInstanceId', 'executionVersion'], context, 'identity');
  if (!Number.isSafeInteger(raw.executionVersion)) throw new StorageError('validation', context.operation, 'Invalid execution version');
  return { projectId: validateStableId(raw.projectId, context, 'projectId'),
    attemptId: validateStableId(raw.attemptId, context, 'attemptId'), owner: validateStableId(raw.owner, context, 'owner'),
    hostInstanceId: validateStableId(raw.hostInstanceId, context, 'hostInstanceId'),
    executionVersion: validatePositiveInteger(raw.executionVersion, context, 'executionVersion') };
}
export function validateWorkProcessIdentity(value: unknown): CommandProcessIdentity {
  const context = { operation: 'WorkResources.processIdentity' };
  const raw = requirePlainObject(value, context, 'processIdentity');
  rejectUnknownKeys(raw, ['launchId', 'pid', 'processGroupId', 'startTime'], context, 'processIdentity');
  if (typeof raw.launchId !== 'string' || !isUuidV4(raw.launchId)
    || !Number.isSafeInteger(raw.pid) || Number(raw.pid) < 1 || raw.processGroupId !== raw.pid
    || typeof raw.startTime !== 'string' || !raw.startTime.trim() || raw.startTime.length > 128
    || /[\0-\x1f\x7f]/.test(raw.startTime)) {
    throw new StorageError('validation', context.operation, 'Invalid supervised process identity');
  }
  return { launchId: raw.launchId, pid: Number(raw.pid), processGroupId: Number(raw.processGroupId), startTime: raw.startTime };
}

export interface WorkResourceStopVerifier {
  verify(snapshot: WorkResourceSnapshot): Promise<object | null>;
  inspect(token: unknown): WorkResourceSnapshot;
}
