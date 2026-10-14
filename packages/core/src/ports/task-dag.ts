import type { AttemptRecord } from './attempt-store.js';
import type { ExecutionBatchRecord, RunRecord } from './execution-store.js';
import type { FeaturePlanSnapshot, PhaseRecord, PlanApprovalRecord } from './plan-store.js';
import type { PreparationSettingsScopeSnapshot as SettingsScopeSnapshotLike } from './execution-input-prepare.js';

/** 就绪判定原因冻结词汇（派生视图只读事实；P03-4 / F-008 起经协议入口供 Host 线校验复用）。 */
export const TASK_DAG_REASONS = [
  'ready',
  'all_passed',
  'invalid_graph',
  'waiting_approval',
  'dependency_failed',
  'dependency_pending',
  'resource_busy',
  'budget_exhausted',
  'run_not_active',
  'run_control_blocked',
  'batch_not_active',
  'batch_control_blocked',
  'project_not_active',
  'phase_not_executable',
] as const;
export type TaskDagReason = (typeof TASK_DAG_REASONS)[number];

export interface TaskDagTaskResult {
  readonly taskId: string;
  readonly reason: TaskDagReason;
  readonly dependencyIds: readonly string[];
}
export interface TaskDagResult {
  readonly projectId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly reason: TaskDagReason;
  readonly diagnostic: string | null;
  readonly readyTaskIds: readonly string[];
  readonly tasks: readonly TaskDagTaskResult[];
  readonly handoff: 'feature_final_verification' | null;
}
export interface TaskDagView {
  readonly projectStatus: string;
  readonly phase: PhaseRecord;
  readonly plan: FeaturePlanSnapshot;
  readonly run: RunRecord;
  readonly batch: ExecutionBatchRecord;
  readonly approvals: readonly PlanApprovalRecord[];
  readonly settings: { readonly global: SettingsScopeSnapshotLike | null; readonly project: SettingsScopeSnapshotLike | null };
  readonly facts: readonly {
    readonly taskId: string; readonly kind: 'coding' | 'planning'; readonly manualBlock: boolean;
    readonly executionVersion: number; readonly attemptCounter: number; readonly codeAttemptsUsed: number;
    readonly attempts: readonly AttemptRecord[];
  }[];
  readonly inputs: readonly { readonly artifactId: string; readonly version: number; readonly contentHash: string }[];
  readonly inputsAvailable: boolean;
  readonly resourceBusy: boolean;
}

/** Reads one SQLite snapshot, or reuses the caller's transaction for future claiming. */
export interface TaskDagStore {
  readTaskDagView(projectId: unknown, runId: unknown): TaskDagView;
}
