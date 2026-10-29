import type { CommandProcessIdentity, CommandProcessPort } from './command-process.js';
import type { PlanningStartupRecoveryResult } from './planning-recovery.js';
import type { WorkRecoveryReconciliationResult } from './work-recovery-reconciliation.js';

/** Startup evidence is Core-owned; it never grants resume or releases a workspace. */
export interface WorkStartupRecoveryTarget {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly executionVersion: number;
  readonly executionStage: string;
  readonly processIdentity: CommandProcessIdentity | null;
  readonly verificationProcesses?: readonly CommandProcessIdentity[];
  readonly gaps: readonly string[];
}
export interface WorkStartupRecoveryEvidence extends WorkStartupRecoveryTarget {
  readonly schemaVersion: 1;
  readonly kind: 'work-startup-recovery';
  readonly stopConfirmed: boolean;
  readonly observedAtUtcMs: number;
  readonly workspaceReconciled: false;
  /** Monotonic observation revision; schemaVersion remains the evidence contract version. */
  readonly observationRevision?: number;
  readonly observationKind?: 'initial' | 'reprobe';
  readonly previousObservationAtUtcMs?: number | null;
}
export interface WorkStartupRecoveryStore {
  /** Short transaction: scan, quarantine and revoke old write eligibility before process I/O. */
  fence(): { readonly targets: readonly WorkStartupRecoveryTarget[]; readonly limited: boolean;
    readonly retained: boolean; readonly dispatchBlocked?: boolean; readonly reconcilable: readonly WorkStartupRecoveryEvidence[] };
  /** Resume Artifact publication from the durable observation, without repeating stop I/O. */
  readObservation(target: WorkStartupRecoveryTarget): WorkStartupRecoveryEvidence | null;
  /** Persist a fresh observation for the same fenced identity; historical observations remain immutable. */
  observed(evidence: WorkStartupRecoveryEvidence, evidenceRef: string | null): void;
  failed(): void;
  /** P05-1 / F-010：该 Attempt 是否已被规划恢复补完为终态（跳过通用逐个核对）。 */
  planningCompletionFinalized?(attemptId: string): boolean;
}
export interface WorkStartupRecoveryOptions {
  readonly store: WorkStartupRecoveryStore;
  readonly process: Pick<CommandProcessPort, 'recoverStop'>;
  readonly publishEvidence: (projectId: string, evidence: WorkStartupRecoveryEvidence) => Promise<string>;
  /** P03-9 / F-006: optional Git/worktree/recording reconciliation after stopped evidence exists. */
  readonly reconcile?: (evidence: WorkStartupRecoveryEvidence) => Promise<WorkRecoveryReconciliationResult>;
  /** P05-1 / F-010：规划窗口恢复（在 fence 之后、通用逐个核对之前执行）。 */
  readonly planning?: { readonly recover: () => Promise<PlanningStartupRecoveryResult> };
  readonly nowUtcMs?: () => number;
}
export interface WorkStartupRecoveryState {
  readonly status: 'idle' | 'recovering' | 'complete' | 'blocked';
  readonly reason: 'startup_recovery' | 'workspace_reconciliation_required' | 'scan_limit' | 'recovery_failed' | 'planning_recovery_required' | null;
}
