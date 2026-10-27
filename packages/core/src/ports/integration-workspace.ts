import type { ConfirmedGitIdentity } from './delivery-policy.js';
import type { IntegrationExecutionPlan } from './integration-execution-plan.js';

export const INTEGRATION_WORKSPACE_STATUSES = ['ready', 'succeeded', 'blocked', 'unknown', 'cleaned'] as const;
export type IntegrationWorkspaceStatus = typeof INTEGRATION_WORKSPACE_STATUSES[number];

export type IntegrationWorkspaceReason =
  | 'source_dirty'
  | 'target_head_drift'
  | 'repo_identity_changed'
  | 'source_common_dir_changed'
  | 'input_missing'
  | 'input_not_approved'
  | 'workspace_dirty'
  | 'workspace_not_clean'
  | 'workspace_head_drift'
  | 'git_lock_present'
  | 'merge_conflict'
  | 'unresolved_index'
  | 'merge_failed'
  | 'commit_facts_mismatch'
  | 'path_changed'
  | 'source_changed'
  | 'workspace_not_owned'
  | 'workspace_missing'
  | 'workspace_already_cleaned'
  | 'stop_unconfirmed'
  | 'operation_unknown'
  | 'git_failed'
  | 'workspace_creation_failed';

export interface IntegrationWorkspaceOwner {
  readonly ownerId: string;
  readonly ownerVersion: number;
}

export interface IntegrationWorkspaceStep {
  readonly ordinal: number;
  readonly featureId: string;
  readonly inputSha: string;
  readonly parentBefore: string;
  readonly parents: readonly string[];
  readonly commitSha: string;
  readonly treeSha: string;
  readonly status: 'succeeded';
}

export interface IntegrationWorkspaceFacts {
  readonly head: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly statusPorcelain: string;
  readonly unresolvedPaths: readonly string[];
}

export interface IntegrationWorkspaceHandle {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly ownerVersion: number;
  readonly path: string;
  readonly gitCommonDir: string;
  readonly repoIdentity: string;
  readonly targetBase: string;
  readonly plan: IntegrationExecutionPlan;
  readonly gitIdentity: ConfirmedGitIdentity;
  readonly status: IntegrationWorkspaceStatus;
  readonly currentHead: string;
  readonly steps: readonly IntegrationWorkspaceStep[];
  readonly facts: IntegrationWorkspaceFacts;
}

export interface IntegrationWorkspacePrepareInput {
  readonly plan: IntegrationExecutionPlan;
  readonly integrationPath: string;
  readonly owner: IntegrationWorkspaceOwner;
  readonly gitIdentity: ConfirmedGitIdentity;
  readonly signal?: AbortSignal;
  /** Core admission recheck immediately before every external mutation, outside any DB transaction. */
  readonly beforeWrite?: () => void;
  /** Persist observed parent/tree facts after each input, outside external Git I/O. */
  readonly onStep?: (workspace: IntegrationWorkspaceHandle) => void;
}

export interface IntegrationWorkspaceOutcome {
  readonly status: IntegrationWorkspaceStatus;
  readonly reason: IntegrationWorkspaceReason | null;
  readonly workspace: IntegrationWorkspaceHandle | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface IntegrationMergeOutcome extends IntegrationWorkspaceOutcome {
  readonly steps: readonly IntegrationWorkspaceStep[];
}

export interface IntegrationWorkspaceAdapter {
  prepare(input: IntegrationWorkspacePrepareInput): Promise<IntegrationWorkspaceOutcome>;
  merge(workspace: IntegrationWorkspaceHandle): Promise<IntegrationMergeOutcome>;
  cleanup(workspace: IntegrationWorkspaceHandle): Promise<IntegrationWorkspaceOutcome>;
}
