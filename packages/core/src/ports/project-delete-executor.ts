/** Trusted deletion executor inputs. No client-provided filesystem targets. */
import type { TrustedPrincipal } from './authorization.js';
import type { ProjectDeleteExecutorIdentity, ProjectDeleteOperation, ProjectDeleteStep } from './project-delete.js';

export interface ProjectDeleteFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
export interface ProjectDeleteFileTarget {
  readonly relativePath: string;
  readonly identity: ProjectDeleteFileIdentity;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly ancestors: Readonly<Record<string, ProjectDeleteFileIdentity>>;
}
export interface ProjectDeleteFilePlan {
  readonly manifestDigest: string;
  readonly bodies: readonly ProjectDeleteFileTarget[];
  readonly staging: readonly ProjectDeleteFileTarget[];
}
export interface ProjectDeleteFiles {
  /** Read-only: capture all fixed targets before the first removal. Missing is a failure. */
  prepare(operation: ProjectDeleteOperation): ProjectDeleteFilePlan;
  /** Synchronous checks and unlink; no await between the final identity check and effect. */
  remove(target: ProjectDeleteFileTarget, guard: () => void): void;
  /** Missing is allowed only against an already durable, manifest-bound plan. */
  verifyRemoved(target: ProjectDeleteFileTarget): void;
  assertWorkspacePath(projectId: string, featureId: string, registeredPath: string): void;
  verifyEmpty(operation: ProjectDeleteOperation, plan: ProjectDeleteFilePlan): void;
}
export interface ProjectDeleteExecuteInput {
  readonly principal: TrustedPrincipal;
  readonly operationId: string;
  readonly owner: string;
  readonly expectedFence: number;
  /** Trusted supervisor proof, never inferred from a PID or lease expiry. */
  readonly previousExecutorStopped: boolean;
}
export interface ProjectDeleteExecutor {
  execute(input: ProjectDeleteExecuteInput): Promise<ProjectDeleteOperation>;
}
export interface ProjectDeleteCheckpoints {
  priorWorkspaceRemoval(identity: ProjectDeleteExecutorIdentity, workspaceId: string): import('./workspace-cleaner.js').WorkspaceCleanerVerified | null;
  assertCurrent(principal: TrustedPrincipal, identity: ProjectDeleteExecutorIdentity): ProjectDeleteOperation;
  readCheckpoints(identity: ProjectDeleteExecutorIdentity, step: ProjectDeleteStep): Readonly<Record<string, unknown>>;
  checkpoint(identity: ProjectDeleteExecutorIdentity, step: ProjectDeleteStep, key: string, value: unknown): void;
}
