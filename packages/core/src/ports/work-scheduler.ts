import type { TaskClaimResult, TaskClaimStore, TaskClaimReceipt } from './task-claim.js';
import type { TaskDagReason, TaskDagResult } from './task-dag.js';
import type { RunRecord } from './execution-store.js';

export interface SchedulerRunRef {
  readonly projectId: string;
  readonly runId: string;
}

export interface SchedulerPage {
  readonly runs: readonly SchedulerRunRef[];
  readonly hasMore: boolean;
}

export interface SchedulerStore {
  /** Reads a bounded, stable page of active Runs. A null cursor starts a fresh scan. */
  listActiveRuns(input: { readonly after: SchedulerRunRef | null; readonly limit: number }): SchedulerPage;
  /** Persists a bounded diagnostic without changing lifecycle state. */
  recordRunReason(projectId: string, runId: string, reason: string): void;
  /** Returns whether the stable handoff key has already been delivered. */
  isFinalVerificationHandoffClaimed(projectId: string, runId: string): boolean;
  /** Records a successfully delivered handoff exactly once. */
  recordFinalVerificationHandoff(projectId: string, runId: string): boolean;
  readRun(projectId: string, runId: string): RunRecord;
}

export interface SchedulerCandidate {
  readonly run: RunRecord;
  readonly dag: TaskDagResult;
}

export interface SchedulerClaimContext {
  readonly candidate: SchedulerCandidate;
  readonly taskId: string;
}

export interface SchedulerHandoff {
  readonly handoffKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly featureId: string;
}

export interface SchedulerRunResult {
  readonly projectId: string;
  readonly runId: string;
  readonly reason: TaskDagReason | 'scheduler_capability_missing' | 'claim_rejected' | 'handoff_delivery_failed';
  readonly capabilityGaps: readonly string[];
  readonly claimed: boolean;
  readonly handoff: SchedulerHandoff | null;
}

export interface SchedulerScanResult {
  readonly closed: boolean;
  readonly pages: number;
  readonly bounded: boolean;
  readonly runs: readonly SchedulerRunResult[];
}

export interface SchedulerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkSchedulerOptions {
  readonly store: SchedulerStore;
  readonly dag: { evaluate(projectId: unknown, runId: unknown): TaskDagResult };
  readonly claims?: TaskClaimStore;
  /** Prepares the opaque claim input outside the SQLite claim transaction. */
  readonly prepareClaim?: (context: SchedulerClaimContext) => Promise<unknown>;
  /** Called only after claimTask has returned a committed receipt. */
  readonly consumeClaim?: (receipt: TaskClaimReceipt, context: SchedulerClaimContext) => Promise<void>;
  readonly onHandoff?: (handoff: SchedulerHandoff) => Promise<void>;
  readonly intervalMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxWakeups?: number;
  readonly timers?: SchedulerTimers;
}

export type { TaskClaimResult };
