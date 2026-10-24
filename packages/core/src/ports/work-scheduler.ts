import type { TaskClaimResult, TaskClaimStore, TaskClaimReceipt } from './task-claim.js';
import type { TaskDagReason, TaskDagResult } from './task-dag.js';
import type { RunRecord } from './execution-store.js';
export interface SchedulerRunRef {
  readonly projectId: string;
  readonly runId: string;
}

/** 固定 Batch 候选页使用的稳定 keyset 游标。 */
export interface SchedulerBatchScanCursor {
  readonly projectId: string;
  readonly batchId: string;
  readonly memberOrdinal: number;
  readonly createdAt: number;
  readonly rowid: number;
  readonly featureId: string;
  readonly runId: string;
}

export interface SchedulerBatchCandidate extends SchedulerRunRef {
  readonly phaseId: string;
  readonly batchId: string;
  readonly featureId: string;
  /** 候选来自 Batch 成员表和活动 Run；依赖/代码前置由 Feature DAG 端口另行评估。 */
  readonly source: 'fixed_batch';
}

/** 固定 Batch 候选页。 */
export interface SchedulerBatchCandidatePage {
  readonly candidates: readonly SchedulerBatchCandidate[];
  readonly hasMore: boolean;
  readonly nextCursor: SchedulerBatchScanCursor | null;
}

/**
 * 稳定补扫游标：由「来源优先级 + 该来源不可变排序键」组成。
 * 派发意图（rank 0）按 `enqueued_at, rowid`，其余活动 Run（rank 1）按
 * `created_at, rowid`；两者在 SQLite 中都不可变，因此重放同一游标返回同一页。
 */
export interface SchedulerScanCursor extends SchedulerRunRef {
  readonly rank: number;
  readonly key1: number;
  readonly key2: number;
}

export interface SchedulerPage {
  readonly runs: readonly SchedulerRunRef[];
  readonly hasMore: boolean;
  /** 下一页的稳定游标；`hasMore=false` 时为 null。 */
  readonly nextCursor?: SchedulerScanCursor | null;
}

export interface SchedulerStore {
  /**
   * Reads a bounded, stable page of active Runs. A null cursor starts a fresh scan.
   * 数据来源是持久 Run 与派发意图事实：未派发的 queued Run 即使没有内存唤醒
   * 也能被发现，续跑中的 Run 仍按既有活动状态进入候选。
   */
  listActiveRuns(input: { readonly after: SchedulerScanCursor | null; readonly limit: number }): SchedulerPage;
  /** Reads active Run candidates belonging to one immutable fixed Batch scope. */
  listBatchCandidates(input: {
    readonly projectId: string;
    readonly batchId: string;
    readonly after: SchedulerBatchScanCursor | null;
    readonly limit: number;
  }): SchedulerBatchCandidatePage;
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

/** 受限 finalization Run 的调度消费者；返回是否可记录一次性 handoff。 */
export interface SchedulerFinalization {
  execute(handoff: SchedulerHandoff): Promise<{ readonly recordHandoff: boolean }>;
}

/** P03-9 / F-012：handoff 后的审批/提交/完成消费者；不得触发编码或 Runtime。 */
export interface SchedulerFinalizationCompletion {
  execute(handoff: SchedulerHandoff): Promise<unknown>;
}

/**
 * P05-1 / F-005 planning Run 的派发消费者端口（按 Run purpose 路由，复用既有
 * 队列/Run 认领/槽位/资源记录）：prepare 事务外派生认领输入（含 F-004 输入
 * 准备与启动前重核）；claims 在自有短写事务内原子认领；consume 只在回执已
 * 提交后调用（Runtime 启动属于事务外后续）。planning Task 不进入编码 DAG。
 */
export interface SchedulerPlanningPorts {
  /** 派生 planning 认领输入（不满足 readiness/输入准备失败时抛错）。 */
  prepare(ref: SchedulerRunRef): Promise<unknown>;
  /** planning 原子认领存储（一次调用=一次已提交事务）。 */
  claims: { claimPlanningTask(input: unknown): TaskClaimResult };
  /** 回执已提交后的消费者（后续 Runtime 启动在此事务外发生）。 */
  consume(receipt: TaskClaimReceipt, ref: SchedulerRunRef): Promise<void>;
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
  /** finalization-only Run 在编码认领前分流；未装配时保持既有 capability gap。 */
  readonly finalization?: SchedulerFinalization;
  /** handoff 已记录后继续审批/提交；仅在 Run 仍可调度时调用。 */
  readonly finalizationCompletion?: SchedulerFinalizationCompletion;
  /**
   * 资源准入前置核对（无副作用）。返回有界原因即表示当前不可消费；
   * 目前用于 finalization-only Run 的槽位/资源准入，避免其绕过单槽与项目 Work 门控。
   */
  readonly admission?: { check(ref: SchedulerRunRef): string | null };
  /**
   * P05-1 / F-005：planning Run（purpose=plan）的派发消费者端口。未装配时
   * 调度器保留 capability gap（planning_consumer）并记录可查询原因，不把
   * planning Task 送入编码 DAG，也不自行准备输入或认领。
   */
  readonly planning?: SchedulerPlanningPorts;
  /**
   * 每个候选 Run 在 DAG 评估/认领之前的受信短操作（当前用于 F-006 派发归属与
   * 槽位收尾）。失败不得阻止补扫；调用方自己保留可查询原因。
   */
  readonly beforeRun?: (ref: SchedulerRunRef) => void | Promise<void>;
  readonly intervalMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxWakeups?: number;
  readonly timers?: SchedulerTimers;
}

export type { TaskClaimResult };
