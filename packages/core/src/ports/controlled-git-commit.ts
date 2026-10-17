import type { GitOperationRegisterInput, GitOperationRecord } from './git-operations.js';
import type { ConfirmedGitIdentity } from './delivery-policy.js';
import type { WorkspaceBaseline } from './workspace.js';
import type { WorkspaceContentEntry } from './workspace-inspector.js';
import type { WorkResourceIdentity } from './work-resources.js';

/** Issued by trusted Core orchestration, never deserialized from a Runtime/Host payload.
 * readAuthorization must re-read current verification, approval, policy, permission and
 * owner/version on EVERY call. Missing, stale or incomplete evidence must not return true.
 * The caller keeps existing Work leases throughout; this executor never releases them.
 */
export interface GitCommitAuthorization {
  readonly intent: Omit<GitOperationRegisterInput, 'candidateTree'>;
  readonly baseline: WorkspaceBaseline;
  readonly resourceIdentity: WorkResourceIdentity;
  /** Exact evidence-covered file paths, not directories/pathspecs. Includes deletions. */
  readonly allowedPaths: readonly string[];
  readonly verificationPassed: boolean;
  readonly approvalCurrent: boolean;
  readonly commitAuthorized: boolean;
  /** Trusted Feature-level final human gate. Omitted only for legacy non-delivery callers. */
  readonly finalApprovalCurrent?: boolean;
}
export interface GitCommitRequest { readonly projectId: string; readonly operationId: string }
export interface ControlledGitCommitService {
  commit(request: GitCommitRequest): Promise<GitOperationRecord>;
}
export interface GitCommitFacts {
  readonly head: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly committer: { readonly name: string; readonly email: string };
}
export interface GitCommitCommandResult {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly reason: string | null;
}
export interface GitCommitDriverSession {
  facts(): Promise<GitCommitFacts>;
  stagedPaths(): Promise<readonly string[]>;
  unstagedPaths(): Promise<readonly string[]>;
  stage(paths: readonly string[]): Promise<void>;
  tree(): Promise<string>;
  /** Reject index blobs/modes differing from the verified working bytes (e.g. clean filters). */
  verifyIndex(entries: readonly WorkspaceContentEntry[]): Promise<void>;
  commit(message: string, identity: ConfirmedGitIdentity): Promise<GitCommitCommandResult>;
}
export interface GitCommitDriver {
  open(baseline: WorkspaceBaseline, admit: () => void): GitCommitDriverSession;
}
export class GitCommitProcessError extends Error {
  constructor(readonly reason: string, readonly stopConfirmed: boolean,
    readonly exitCode: number | null = null) {
    super(`GitCommit.process: ${reason}`); this.name = 'GitCommitProcessError';
  }
}
/** Exact message, including a durable operation association for subsequent reconciliation. */
export function gitOperationCommitMessage(message: string, operationId: string): string {
  return `${message.replace(/\n+$/, '')}\n\nShipLoop-Operation: ${operationId}\n`;
}
