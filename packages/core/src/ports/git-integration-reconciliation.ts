import type { AtomicCommandStore, CommandTransaction } from './atomic-commands.js';
import type { IntegrationExecutionObservation } from './git-integration-journal.js';
import type { GitOperationIntent, GitOperationRecord } from './git-operations.js';
import type { IntegrationWorkspaceHandle, IntegrationWorkspaceStep } from './integration-workspace.js';

export interface GitIntegrationReconciliationRequest {
  readonly projectId: string;
  readonly operationId: string;
}

/** Trusted Core facts supplied by the current owner reader. */
export interface GitIntegrationRecoveryAuthorization {
  readonly intent: GitOperationIntent;
  readonly ownerVersion: number;
  readonly approvalCurrent: boolean;
}

export interface GitIntegrationTargetFacts {
  readonly head: string;
  readonly repoIdentity: string;
  readonly gitCommonDir: string;
  readonly statusPorcelain: string;
}

/** Read-only facts from the integration worktree. The reader must never mutate Git. */
export interface GitIntegrationWorkspaceFacts {
  readonly workspace: IntegrationWorkspaceHandle | null;
  readonly steps: readonly IntegrationWorkspaceStep[];
  readonly target: GitIntegrationTargetFacts;
}

export interface GitIntegrationRecoveryReader {
  inspect(input: {
    readonly projectId: string;
    readonly operation: GitOperationRecord;
    readonly observation: IntegrationExecutionObservation | null;
  }): Promise<GitIntegrationWorkspaceFacts>;
}

export type GitIntegrationReconciliationOutcome = 'pending' | 'matched' | 'blocked' | 'unknown';

export interface GitIntegrationReconciliation {
  readonly outcome: GitIntegrationReconciliationOutcome;
  readonly reasonCode: string | null;
  readonly operation: GitOperationRecord;
  readonly observation: IntegrationExecutionObservation | null;
}

export interface GitIntegrationReconciliationService {
  reconcile(request: GitIntegrationReconciliationRequest): Promise<GitIntegrationReconciliation>;
}

export interface GitIntegrationReconciliationDependencies {
  readonly atomic: AtomicCommandStore;
  readonly reader: GitIntegrationRecoveryReader;
  readonly journal: import('./git-integration-journal.js').GitIntegrationJournal;
  readonly readAuthorization: (request: GitIntegrationReconciliationRequest) => GitIntegrationRecoveryAuthorization;
  readonly verifyWriterStopped: (authorization: GitIntegrationRecoveryAuthorization) => Promise<boolean>;
  readonly nowUtcMs?: () => number;
}

export type GitIntegrationReconciliationTransaction = CommandTransaction;
