import type { AttemptRecord } from './attempt-store.js';
import type { ArtifactRecord } from './artifact-store.js';
import type { GitCommitFacts } from './controlled-git-commit.js';
import type { GitOperationRecord } from './git-operations.js';
import type { WorkStartupRecoveryEvidence } from './work-startup-recovery.js';
import type { ManagedWorkspaceRecord, WorkspaceBaseline, WorkspaceOperationRecord } from './workspace.js';
import type { WorkSessionRecord } from './work-session.js';
import type { WorkResourceSnapshot } from './work-resources.js';

/** P03-9 / F-006：恢复诊断证据的持久 JSON 身份。 */
export const WORK_RECOVERY_RECONCILIATION_KIND = 'work-recovery-reconciliation';
export const WORK_RECOVERY_RECONCILIATION_SCHEMA_VERSION = 1;

/** Read-only Git/worktree observations for conservative restart diagnosis. */
export interface RecoveryGitReader {
  locks(baseline: WorkspaceBaseline): Promise<readonly string[]>;
  facts(projectId: string, baseline: WorkspaceBaseline): Promise<GitCommitFacts>;
  isAncestor(projectId: string, baseline: WorkspaceBaseline, ancestor: string, descendant: string): Promise<boolean>;
}

export interface WorkRecoveryReconciliationSnapshot {
  /** Original interrupted Attempt; recovery never creates another one. */
  readonly attempt: AttemptRecord;
  readonly runStatus: string;
  /** Adapter snapshot seal across asynchronous inspection/publication. */
  readonly recoveryFingerprint?: string;
  readonly dispatchGaps?: readonly string[];
  readonly workspace: ManagedWorkspaceRecord | null;
  readonly session: WorkSessionRecord | null;
  /** Read without the task execution-version equality gate that fencing intentionally revoked. */
  readonly resources: WorkResourceSnapshot;
  readonly artifacts: readonly ArtifactRecord[];
  readonly pendingGitOperations: readonly GitOperationRecord[];
  readonly pendingWorkspaceOperations: readonly WorkspaceOperationRecord[];
  readonly alreadyReconciled: boolean;
  readonly priorEvidenceRef: string | null;
}

export interface WorkRecoveryReconciliationWorkspaceFacts {
  readonly id: string;
  readonly status: 'retained' | 'quarantined';
  readonly canonicalPath: string;
  readonly repoIdentity: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly registrationDigest: string;
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly ignoredCount: number;
  readonly retainedTrackedCount: number;
  readonly retainedUntrackedCount: number;
  readonly locks: readonly string[];
}

export interface WorkRecoveryReconciliationRecordingFacts {
  readonly sessionId: string | null;
  readonly status: string | null;
  readonly watermark: number | null;
  readonly gaps: readonly string[];
  readonly artifactsChecked: number;
}

/** Native archive references are inspected as immutable metadata, never opened for continuation. */
export interface WorkRecoveryNativeArchiveFacts {
  readonly sessionStorageKind: string | null;
  readonly sessionFormatVersion: string | null;
  readonly sourceArchiveRef: string | null;
  readonly sourceDigest: string | null;
  readonly sourceVerified: boolean;
  readonly singleWriter: 'confirmed_stopped' | 'never_started' | 'not_referenced';
  readonly opened: false;
}

export interface WorkRecoveryRuntimeFacts {
  /** Durable launch authorization is the Attempt invocation receipt. */
  readonly launchReceipt: 'present' | 'missing';
  /** A stopped Session is the durable stop receipt; started/ended remain occupied or incomplete. */
  readonly stopReceipt: 'confirmed' | 'missing' | 'not_applicable';
  readonly sessionId: string | null;
  readonly sessionStatus: string | null;
  readonly providerSessionId: string | null;
  readonly nativeSessionOccupied: boolean;
  readonly processIdentity: 'confirmed' | 'missing' | 'not_applicable';
  readonly lastActivityAtUtcMs: number | null;
}

export type WorkRecoveryGitOperationOutcome = 'matched' | 'not_executed' | 'unknown';

export interface WorkRecoveryGitOperationFacts {
  readonly operationId: string;
  readonly outcome: WorkRecoveryGitOperationOutcome;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  readonly reasonCode: string | null;
}

/** Immutable, artifact-backed diagnosis of one interrupted Attempt. */
export interface WorkRecoveryReconciliationEvidence {
  readonly schemaVersion: typeof WORK_RECOVERY_RECONCILIATION_SCHEMA_VERSION;
  readonly kind: typeof WORK_RECOVERY_RECONCILIATION_KIND;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly status: 'reconciled' | 'quarantined';
  readonly gaps: readonly string[];
  readonly startupGaps: readonly string[];
  readonly workspace: WorkRecoveryReconciliationWorkspaceFacts | null;
  readonly recording: WorkRecoveryReconciliationRecordingFacts;
  readonly runtime: WorkRecoveryRuntimeFacts;
  readonly native: WorkRecoveryNativeArchiveFacts;
  readonly gitOperations: readonly WorkRecoveryGitOperationFacts[];
  readonly taskPassed: false;
  readonly newAttemptCreated: false;
  /** Manual operator actions are durable with the diagnosis when recovery is unsafe. */
  readonly manualNextSteps: readonly string[];
  readonly observedAtUtcMs: number;
}

export type WorkRecoveryRelease =
  | { readonly mode: 'none' }
  | { readonly mode: 'unstarted' }
  | { readonly mode: 'stopped'; readonly token: object };

export interface WorkRecoveryReconciliationStore {
  load(source: WorkStartupRecoveryEvidence): WorkRecoveryReconciliationSnapshot;
  /** Artifact is already durable; this transaction persists the outcome and releases only the matching holder. */
  finish(source: WorkStartupRecoveryEvidence, evidence: WorkRecoveryReconciliationEvidence,
    evidenceRef: string, release: WorkRecoveryRelease, expectedFingerprint?: string): void;
  /** Persist the diagnosis, keep Run interrupted and retain/quarantine the recovered occupancy. */
  quarantine(source: WorkStartupRecoveryEvidence, evidence: WorkRecoveryReconciliationEvidence,
    evidenceRef: string, expectedFingerprint?: string): void;
}

export interface WorkRecoveryReconciliationResult {
  readonly status: 'reconciled' | 'quarantined';
  readonly gaps: readonly string[];
  readonly evidenceRef: string | null;
  readonly alreadyReconciled: boolean;
}
