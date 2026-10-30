import type { TrustedPrincipal } from './authorization.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from './commands.js';
import type { ProjectDeleteInventory } from './project-delete-preview.js';

export type ProjectDeleteEnvelope = Extract<ValidatedCommandEnvelope, { operation: import('./data-lifecycle.js').DataLifecycleOperation }>;
export const PROJECT_DELETE_STEPS = ['artifact_bodies', 'artifact_staging', 'managed_worktrees'] as const;
export type ProjectDeleteStep = (typeof PROJECT_DELETE_STEPS)[number];
export interface ProjectDeleteManifest {
  readonly databaseDigestAfterAccept: string;
  readonly inventory: ProjectDeleteInventory;
  readonly objects: ProjectDeleteInventory['objects'];
  readonly retained: ProjectDeleteInventory['retained'];
}
export interface ProjectDeleteOperation {
  readonly operationId: string;
  readonly projectId: string;
  readonly status: 'intent' | 'running' | 'failed' | 'purging' | 'completed';
  readonly owner: string | null;
  readonly fence: number;
  readonly manifestDigest: string;
  /** Cleared at completion; only the minimal operation identity remains. */
  readonly manifest: ProjectDeleteManifest | null;
  readonly failedStep: string | null;
  readonly steps: readonly { step: ProjectDeleteStep; status: 'pending' | 'completed' | 'failed'; evidenceDigest: string | null }[];
}
export interface ProjectDeleteExecutorIdentity {
  readonly operationId: string;
  readonly owner: string;
  readonly fence: number;
}
/** Trusted file observer supplied by composition, never accepted in a client payload.
 * It must inspect the fixed manifest and verify absence of all listed targets, while
 * preserving source repositories/branches/backups. Unknown/partial facts return false.
 */
export type ProjectDeleteExternalVerifier = (operation: ProjectDeleteOperation) => Promise<boolean>;
export interface ProjectDeleteStore {
  findReceipt(principal: TrustedPrincipal, commandId: string, digest: string): CommandReceipt | undefined;
  accept(principal: TrustedPrincipal, envelope: ProjectDeleteEnvelope, digest: string, inventory: ProjectDeleteInventory): CommandReceipt;
  get(principal: TrustedPrincipal, operationId: string): ProjectDeleteOperation;
  /** Replacement is a trusted control decision after positively confirming the old executor stopped. */
  claim(principal: TrustedPrincipal, operationId: string, owner: string, expectedFence: number, previousExecutorStopped: boolean): ProjectDeleteOperation;
  recordStep(identity: ProjectDeleteExecutorIdentity, step: ProjectDeleteStep, status: 'completed' | 'failed', evidenceDigest: string): void;
  finish(identity: ProjectDeleteExecutorIdentity, verifyExternal: ProjectDeleteExternalVerifier): Promise<ProjectDeleteOperation>;
}
export interface ProjectDeleteCommandHandler {
  submit(principal: TrustedPrincipal, envelope: ProjectDeleteEnvelope, digest: string): Promise<CommandReceipt>;
}
