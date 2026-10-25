import type { CommandTransaction } from './atomic-commands.js';
import type { IntegrationWorkspaceHandle, IntegrationWorkspaceStep } from './integration-workspace.js';

/** Internal Core request. Authorization and paths are supplied only by trusted assembly. */
export interface IntegrationStartRequest {
  readonly projectId: string;
  readonly operationId: string;
  readonly commandId: string;
  readonly expectedFeatureRevision: number;
  readonly inputDigest: string;
}

export interface IntegrationExecutionObservation {
  readonly outcome: 'merging' | 'pending_verification' | 'blocked' | 'unknown';
  readonly reason: string | null;
  readonly workspace: IntegrationWorkspaceHandle | null;
  readonly steps: readonly IntegrationWorkspaceStep[];
}

/** Append-only evidence attached to the existing Git operation, never a second lifecycle.
 * All methods run within the caller's CommandTransaction. No external I/O is allowed.
 * Private workspace/process information must not be exposed through public event payloads.
 */
export interface GitIntegrationJournal {
  claim(transaction: CommandTransaction, request: IntegrationStartRequest, requestDigest: string): void;
  read(transaction: CommandTransaction, projectId: string, operationId: string): IntegrationExecutionObservation | null;
  append(transaction: CommandTransaction, projectId: string, operationId: string,
    expectedRevision: number, observation: IntegrationExecutionObservation): void;
}
