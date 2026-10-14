import { createHash } from 'node:crypto';
import { validateStableId } from './validation.js';
import type { WorkResourceIdentity, WorkWorkspaceAuthority, VerifiedWorkWorkspace } from './work-resources.js';
import type { RepositoryBindingRecord } from './state-store.js';
import type { CommandProcessIdentity } from './command-process.js';
import type { WorkspaceBaseline, WorkspaceOperationCommit, WorkspaceOperationResult } from './workspace.js';
import type { WorkspaceInspection } from './workspace-inspector.js';

export function deriveManagedFeatureBranch(projectId: string, featureId: string): string {
  const context = { operation: 'Workspace.prepare.branch' };
  validateStableId(projectId, context, 'projectId');
  validateStableId(featureId, context, 'featureId');
  return `shiploop/feature/${createHash('sha256').update(JSON.stringify([projectId, featureId])).digest('hex')}`;
}

export interface PreparationWorkspaceAuthority extends WorkWorkspaceAuthority {
  /** Reserves a PathService-derived location before a Git worktree exists. */
  verifyPreparation(binding: RepositoryBindingRecord, featureId: string): Promise<VerifiedWorkWorkspace>;
}
export interface WorkspacePreparationInput {
  readonly identity: WorkResourceIdentity;
  readonly runId: string;
  readonly taskId: string;
  readonly claimKey: string;
  readonly operationId: string;
  readonly workspaceId: string;
}
export interface WorkspacePreparationAuthorization {
  readonly binding: RepositoryBindingRecord;
  readonly featureId: string;
  readonly baseCommit: string;
}
export interface WorkspacePreparationOutcome {
  readonly inspection: WorkspaceInspection | null;
  readonly result: Omit<WorkspaceOperationResult, 'evidenceRefs' | 'errorRef'>;
  readonly reason: string | null;
  /** Includes an attempted mutating Git command, uncertain stop, or changed metadata. */
  readonly isolated: boolean;
}
export interface PreparationDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}
/** Durable admission facts, not Runtime/session recovery authority. */
export interface WorkspacePreparationJournal {
  readonly directoryIdentity: PreparationDirectoryIdentity | null;
  readonly expectedHead: string;
  readonly unfinishedProcesses: readonly CommandProcessIdentity[];
}
export interface WorkspacePreparationCheckpoint extends WorkspacePreparationJournal {
  recordDirectory(identity: PreparationDirectoryIdentity): void;
  recordProcess(identity: CommandProcessIdentity): void;
  recordStop(identity: CommandProcessIdentity): void;
}
export interface WorkspacePreparationStore {
  readAuthorization(input: WorkspacePreparationInput): WorkspacePreparationAuthorization;
  begin(input: WorkspacePreparationInput, baseline: WorkspaceBaseline): WorkspaceOperationCommit;
  readJournal(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit): WorkspacePreparationJournal;
  recordCheckpoint(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit,
    kind: 'directory' | 'process' | 'stop', value: PreparationDirectoryIdentity | CommandProcessIdentity): void;
  assertCurrent(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit): void;
  finish(input: WorkspacePreparationInput, intent: WorkspaceOperationCommit, outcome: WorkspacePreparationOutcome, evidenceRef: string): WorkspaceOperationCommit;
  quarantine(input: WorkspacePreparationInput, intent?: WorkspaceOperationCommit): void;
}
export interface FeatureWorktreePreparer {
  prepare(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline, operationId: string,
    admit: () => void, checkpoint: WorkspacePreparationCheckpoint): Promise<WorkspacePreparationOutcome>;
}
