/**
 * P03-3 / F-010 执行预算只读授权查询契约（ports 层）。
 *
 * 设计依据：core-design/04 §6.1（累计预算/剩余额度可查询、绝对 deadline 持久、
 * 用量未知保留未知）与 core-design/08 §2（getBatch 只读展示；查询绝不扣预算、
 * 不发业务事件、不唤醒执行）；F-009 契约 §6「查询面（F-010：Batch/修订历史
 * 读取查询）」。
 *
 * 不变量：
 * - 全部内容取自持久状态的单一一致读视图（ExecutionBudgetQueryReadStore，
 *   适配器以 BEGIN DEFERRED 读事务实现）；查询面零写入、零事件、零唤醒；
 * - 公开形状只暴露身份/上限/计数/时间等结构化事实：绝不携带 scope/config/
 *   input 快照正文、秘密配置、任意文件内容或开发机绝对路径；
 * - 未启动/无耗时/无退出信息/无 token、cost 用量一律 null（明确未知），不以
 *   0 冒充；启动预占（runtimeStartsReserved）与已知实际用量（usage）分开
 *   呈现（当前结算账本无用量列，实际用量恒未知）；
 * - accepted/queued 等未验收状态原样展示（status 原值），绝不推导为验收
 *   成功；passed/firstPassedAt 只反映受信领域事实。
 */
import { validateStableId } from './validation.js';
import type { ValidationContext } from './validation.js';
import { StorageError } from './errors.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import {
  evaluateBatchBudgetReservation,
  evaluateRunBudgetReservation,
  evaluateTaskCodeAttemptReservation,
  resolveTaskAttemptCaps,
} from './execution-budget.js';
import type {
  BudgetCounterDimension,
  BudgetDimension,
  BudgetResourceDimension,
  BudgetDimensionStatus,
  ExecutionBudgetSnapshot,
  RunBudgetLimits,
  TaskAttemptCaps,
} from './execution-budget.js';
import { EXECUTION_RUN_NOT_READY_REASON } from './execution-start.js';
import {
  RUN_NO_PROGRESS_EXHAUSTION_REASON,
  isExecutionTerminalStatus,
} from './execution-store.js';
import type {
  BatchBudgetRevisionRecord,
  ExecutionBatchRecord,
  ExecutionBatchStatus,
  RunRecord,
} from './execution-store.js';
import type { TaskStatus } from './plan-store.js';
import type { PlanListRequest, PlanRecordPage, SettingsScopeSnapshot } from './queries.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与 Host 路由共用；Host 接线属 F-011）
 * ------------------------------------------------------------------ */

export const EXECUTION_BUDGET_GET_OPERATION = 'execution.budget.get' as const;
export const EXECUTION_BUDGET_REVISIONS_OPERATION = 'execution.budget.revisions' as const;

export const EXECUTION_BUDGET_QUERY_OPERATIONS = [
  EXECUTION_BUDGET_GET_OPERATION,
  EXECUTION_BUDGET_REVISIONS_OPERATION,
] as const;

export type ExecutionBudgetQueryOperation = (typeof EXECUTION_BUDGET_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 阻塞原因（冻结词汇：预算派生判定 + 持久控制原因）
 * ------------------------------------------------------------------ */

export const EXECUTION_BUDGET_BLOCK_REASONS = [
  'counter_exhausted',
  'deadline_reached',
  'resource_exhausted',
  'code_attempts_exhausted',
  'budget_exhausted',
  'scheduler_not_assembled',
  'runtime_not_found',
] as const;
export type ExecutionBudgetBlockReasonCode = (typeof EXECUTION_BUDGET_BLOCK_REASONS)[number];

/** 阻塞维度：预算维度 + Task 层上限（代码尝试/总 Attempt）。 */
export type ExecutionBudgetBlockDimension = BudgetDimension | 'maxCodeAttempts' | 'maxAttemptsPerTask';

/**
 * 一条结构化阻塞原因：layer/layerId 定位受阻层级与真实身份；预算派生条目
 * 携带 dimension/limit/used（与 budget_exhausted 冲突词汇同源的定位信息）；
 * 持久控制条目（无进展耗尽、调度器未装配）只有 reason。
 */
export interface PublicExecutionBudgetBlockReason {
  readonly layer: 'batch' | 'run' | 'task';
  readonly layerId: string;
  readonly reason: ExecutionBudgetBlockReasonCode;
  readonly dimension?: ExecutionBudgetBlockDimension;
  readonly limit?: number;
  readonly used?: number | null;
}

/* ------------------------------------------------------------------ *
 * 公开形状
 * ------------------------------------------------------------------ */

/** Batch 层视图：固定单 Feature 范围 + 当前预算 + 累计用量 + 派生额度状态。 */
export interface PublicExecutionBudgetBatchView {
  readonly id: string;
  readonly projectId: string;
  readonly phaseId: string;
  readonly featureId: string;
  /** 固定授权成员集合；featureId 是兼容的首成员身份。 */
  readonly featureIds: readonly string[];
  readonly status: ExecutionBatchStatus;
  /** 当前预算版本（修订后递增；修订历史见 execution.budget.revisions）。 */
  readonly budgetRevision: number;
  /** 当前批准预算完整快照（schemaVersion=1；旧 Run 冻结上限见 runs[].limits）。 */
  readonly budget: ExecutionBudgetSnapshot;
  /** 绝对 deadline（UTC epoch 毫秒；暂停不自动延长）。 */
  readonly deadlineAtUtcMs: number;
  /**
   * 各维度已用/剩余/是否耗尽：计数维度恒已知；deadline 维度 used=查询参考
   * 时间、remaining=剩余毫秒；资源维度用量未知时 used/remaining/exhausted
   * 为 null（保留未知，不填零）。
   */
  readonly dimensions: Readonly<
    Record<BudgetCounterDimension | 'deadlineUtcMs', BudgetDimensionStatus>
  > & {
    readonly maxTokenTotal?: BudgetDimensionStatus;
    readonly maxCostTotal?: BudgetDimensionStatus;
  };
  /** 配置了资源上限但用量未知的维度（不以零费用证明仍有额度）。 */
  readonly unconfirmedDimensions: readonly BudgetResourceDimension[];
  /** Runtime 启动预占累计计数（F-007 账本与计数同事务一致；不是实际用量）。 */
  readonly runtimeStartsReserved: number;
  /** 已知实际用量（token/cost）：当前结算账本无用量列，恒 null（未知）。 */
  readonly usage: { readonly tokenUsed: number | null; readonly costUsed: number | null };
  /** 持久控制原因（如无进展耗尽的 budget_exhausted；创建标记等非阻塞原因原样保留）。 */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Run 层视图：派发身份 + 冻结上限快照 + 计数/时间事实（未启动保持 null）。 */
export interface PublicExecutionBudgetRunView {
  readonly id: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly purpose: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly status: ExecutionBatchStatus;
  /** 派发时冻结的 Run 上限（旧 Run 快照不随后续预算修订改变）。 */
  readonly limits: RunBudgetLimits;
  readonly dimensions: Readonly<
    Record<'maxAttemptsPerRun' | 'runTimeLimitMs', BudgetDimensionStatus>
  >;
  readonly attemptsCreated: number;
  /** 启动时间：未启动 = null（不填零）。 */
  readonly startedAt: string | null;
  /** 退出信息：尚无结算 = null。 */
  readonly endedAt: string | null;
  /** 已知耗时毫秒：未启动/未知 = null（不以 0 冒充）。 */
  readonly elapsedMs: number | null;
  /** 持久控制原因（如 scheduler_not_assembled）。 */
  readonly reason: string | null;
  readonly createdAt: string;
}

/** Task 层视图：累计尝试计数 + 策略副本/有效配置解析出的上限与剩余。 */
export interface PublicExecutionBudgetTaskView {
  readonly taskId: string;
  readonly featureId?: string;
  readonly status: TaskStatus;
  /** 首次受信通过事实时间（只反映受信 Verifier 写入；未通过 = null）。 */
  readonly firstPassedAt: string | null;
  /** 总 Attempt（limit null = 未配置总上限，remaining 同为 null 而非 0）。 */
  readonly attempts: {
    readonly used: number;
    readonly limit: number | null;
    readonly remaining: number | null;
  };
  /** 代码尝试（含首次；上限来自 Task 策略副本，缺省含首次共三次）。 */
  readonly codeAttempts: {
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
  };
  /** 上限解析明细（绑定方显式可审计）。 */
  readonly caps: TaskAttemptCaps;
}

/** execution.budget.get 结果（一致读视图的纯序列化投影）。 */
export interface ExecutionBudgetStatusResult {
  readonly schemaVersion: number;
  readonly scope: 'execution-budget';
  readonly batch: PublicExecutionBudgetBatchView;
  readonly runs: readonly PublicExecutionBudgetRunView[];
  readonly tasks: readonly PublicExecutionBudgetTaskView[];
  readonly blockingReasons: readonly PublicExecutionBudgetBlockReason[];
}

/** 预算修订记录公开形状（不可变审计行；时间 ISO UTC）。 */
export interface PublicBatchBudgetRevisionRecord {
  readonly id: string;
  readonly batchId: string;
  readonly version: number;
  /** 该版本预算完整快照（初始 version=1 与历史版本逐行留存）。 */
  readonly budget: ExecutionBudgetSnapshot;
  readonly deadlineAtUtcMs: number;
  readonly approvedBy: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** execution.budget.revisions 结果（复用既有有界分页/受控游标规则）。 */
export interface BudgetRevisionListResult {
  readonly schemaVersion: number;
  readonly scope: 'budget-revision-list';
  readonly records: readonly PublicBatchBudgetRevisionRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

/* ------------------------------------------------------------------ *
 * 一致读视图与窄读取端口（adapters 层实现；应用层授权完成后调用）
 * ------------------------------------------------------------------ */

/** Task 层持久事实行（执行计数列 + 策略副本；副本正文不进入公开形状）。 */
export interface ExecutionBudgetTaskRow {
  readonly taskId: string;
  readonly featureId?: string;
  readonly status: TaskStatus;
  readonly firstPassedAtUtcMs: number | null;
  readonly attemptCounter: number;
  readonly codeAttemptsUsed: number;
  /** Task 策略副本（仅解析 maxCodeAttempts；正文不序列化到输出）。 */
  readonly executionConfig: Readonly<Record<string, unknown>>;
}

/**
 * 执行预算一致读视图：Batch 行 + 全部 Run 行 + 固定范围内 Task 计数 +
 * 全局/项目当前配置（总 Attempt 上限解析用）在同一 DEFERRED 读事务内取得。
 */
export interface ExecutionBudgetView {
  readonly batch: ExecutionBatchRecord;
  readonly runs: readonly RunRecord[];
  readonly tasks: readonly ExecutionBudgetTaskRow[];
  readonly settings: {
    readonly global: SettingsScopeSnapshot | null;
    readonly project: SettingsScopeSnapshot | null;
  };
}

/**
 * 执行预算查询窄读取端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（可见性与存在性折叠由应用层统一为 not_found，不泄漏存在性）；
 * 修订列表沿用计划分页的可见范围谓词与键集分页形态。
 */
export interface ExecutionBudgetQueryReadStore {
  readExecutionBudgetView(projectId: unknown, batchId: unknown): ExecutionBudgetView | undefined;
  findExecutionBatchRecord(projectId: unknown, batchId: unknown): ExecutionBatchRecord | undefined;
  listBatchBudgetRevisionRecords(
    visibility: unknown,
    projectId: unknown,
    batchId: unknown,
    request: PlanListRequest,
  ): PlanRecordPage<BatchBudgetRevisionRecord>;
}

/* ------------------------------------------------------------------ *
 * 纯序列化投影（确定性；不读时钟——参考时间显式传入）
 * ------------------------------------------------------------------ */

const OPERATION = 'ExecutionBudgetQuery.build';

function corrupt(message: string, cause?: unknown): StorageError {
  return new StorageError('corrupt', OPERATION, `${OPERATION}: ${message}`, {
    entity: { type: 'execution_batch' },
    ...(cause === undefined ? {} : { cause }),
  });
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw corrupt(`${field} 必须是非负安全整数（持久计数/时间损坏）`);
  }
  return value;
}

/** 从不可变授权快照读取成员，绝不重新解析当前 Phase 范围。 */
export function readFixedExecutionBatchFeatureIds(batch: ExecutionBatchRecord): readonly string[] {
  const raw: unknown = batch.scopeSnapshot.featureIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16 ||
      raw.some(id => typeof id !== 'string') || new Set(raw).size !== raw.length || !raw.includes(batch.featureId)) {
    throw corrupt('Batch 固定 Feature 范围损坏');
  }
  try {
    return raw.map(id => validateStableId(id, { operation: OPERATION }, 'featureIds'));
  } catch (cause) {
    throw corrupt('Batch 固定 Feature 身份损坏', cause);
  }
}

function isoOr(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export interface ExecutionBudgetStatusBuildOptions {
  /** 查询参考时间（UTC 毫秒；调用方显式传入，本函数不读时钟）。 */
  readonly nowUtcMs: number;
  /** 总 Attempt 上限（有效配置 executionLimits.maxAttemptsPerTask；null = 未配置）。 */
  readonly maxAttemptsPerTask: number | null;
}

function batchBudgetBlockEntries(
  batch: ExecutionBatchRecord,
  decision: ReturnType<typeof evaluateBatchBudgetReservation>,
): PublicExecutionBudgetBlockReason[] {
  const entries: PublicExecutionBudgetBlockReason[] = decision.reasons.map((reason) => ({
    layer: 'batch',
    layerId: batch.id,
    reason: reason.reason,
    dimension: reason.dimension,
    limit: reason.limit,
    used: reason.used,
  }));
  if (batch.reason === RUN_NO_PROGRESS_EXHAUSTION_REASON) {
    entries.push({ layer: 'batch', layerId: batch.id, reason: 'budget_exhausted' });
  }
  return entries;
}

/**
 * 一致读视图 → 公开结果（纯函数投影）：
 * - 计数维度直接由持久累计计数判定；资源维度用量恒未知（保留未知）；
 * - Run 时间维度对已结束 Run 以 ended_at 冻结耗时，对未启动 Run 保持未知；
 * - 阻塞原因聚合顺序：Batch 预算判定 → Batch 持久控制原因 → 非终态 Run
 *   预算/控制原因 → Task 尝试上限（只读推导，绝不产生写入）。
 */
export function buildExecutionBudgetStatus(
  view: ExecutionBudgetView,
  options: ExecutionBudgetStatusBuildOptions,
): ExecutionBudgetStatusResult {
  const now = requirePositiveSafeInteger(options.nowUtcMs, 'nowUtcMs');
  const batch = view.batch;
  const featureIds = readFixedExecutionBatchFeatureIds(batch);
  if (view.runs.some(run => run.batchId !== batch.id || run.projectId !== batch.projectId || !featureIds.includes(run.featureId)) ||
      view.tasks.some(task => (featureIds.length > 1 && task.featureId === undefined) || (task.featureId !== undefined && !featureIds.includes(task.featureId)))) {
    throw corrupt('预算查询成员不属于固定 Batch 范围');
  }

  const batchDecision = evaluateBatchBudgetReservation(
    batch.budgetSnapshot.batch,
    {
      runsCreated: batch.runsCreated,
      attemptsCreated: batch.attemptsCreated,
      runtimeStarts: batch.runtimeStarts,
      noProgressRuns: batch.noProgressRuns,
      tokenUsed: null,
      costUsed: null,
    },
    now,
  );

  const blockingReasons: PublicExecutionBudgetBlockReason[] = [
    ...batchBudgetBlockEntries(batch, batchDecision),
  ];

  const runs: PublicExecutionBudgetRunView[] = view.runs.map((run) => {
    // 已结束 Run 的耗时以退出信息冻结；未启动保持未知（不读墙钟伪造耗时）。
    const runNow = run.endedAtUtcMs ?? now;
    const runDecision = evaluateRunBudgetReservation(
      { maxAttemptsPerRun: run.maxAttemptsPerRun, runTimeLimitMs: run.runTimeLimitMs },
      { attemptsCreated: run.attemptsCreated, startedAtUtcMs: run.startedAtUtcMs },
      runNow,
    );
    if (!isExecutionTerminalStatus(run.status)) {
      for (const reason of runDecision.reasons) {
        blockingReasons.push({
          layer: 'run',
          layerId: run.id,
          reason: reason.reason,
          dimension: reason.dimension,
          limit: reason.limit,
          used: reason.used,
        });
      }
      if ((run.reason === EXECUTION_RUN_NOT_READY_REASON || run.reason === 'runtime_not_found') && run.startedAtUtcMs === null) {
        blockingReasons.push({ layer: 'run', layerId: run.id, reason: run.reason });
      }
    }
    return {
      id: run.id,
      batchId: run.batchId,
      featureId: run.featureId,
      purpose: run.purpose,
      workKey: run.workKey,
      dispatchOrdinal: run.dispatchOrdinal,
      status: run.status,
      limits: { maxAttemptsPerRun: run.maxAttemptsPerRun, runTimeLimitMs: run.runTimeLimitMs },
      dimensions: runDecision.dimensions,
      attemptsCreated: run.attemptsCreated,
      startedAt: isoOr(run.startedAtUtcMs),
      endedAt: isoOr(run.endedAtUtcMs),
      elapsedMs:
        run.startedAtUtcMs === null ? null : runNow - requirePositiveSafeInteger(run.startedAtUtcMs, 'startedAtUtcMs'),
      reason: run.reason,
      createdAt: new Date(requirePositiveSafeInteger(run.createdAtUtcMs, 'createdAtUtcMs')).toISOString(),
    };
  });

  const tasks: PublicExecutionBudgetTaskView[] = view.tasks.map((row) => {
    const context: ValidationContext = {
      operation: OPERATION,
      entity: { type: 'task', id: row.taskId },
    };
    const rawMaxCodeAttempts: unknown = row.executionConfig.maxCodeAttempts;
    const caps = resolveTaskAttemptCaps(
      {
        ...(rawMaxCodeAttempts === undefined || rawMaxCodeAttempts === null
          ? {}
          : { maxCodeAttempts: rawMaxCodeAttempts }),
        maxAttemptsPerTask: options.maxAttemptsPerTask,
      },
      context,
    );
    const codeDecision = evaluateTaskCodeAttemptReservation(caps, row.codeAttemptsUsed);
    if (codeDecision.reason !== undefined) {
      blockingReasons.push({
        layer: 'task',
        layerId: row.taskId,
        reason: 'code_attempts_exhausted',
        dimension: 'maxCodeAttempts',
        limit: codeDecision.limit,
        used: codeDecision.used,
      });
    }
    const totalLimit = caps.maxAttemptsPerTask;
    const totalUsed = requirePositiveSafeInteger(row.attemptCounter, 'attemptCounter');
    if (totalLimit !== null && totalUsed >= totalLimit) {
      blockingReasons.push({
        layer: 'task',
        layerId: row.taskId,
        reason: 'counter_exhausted',
        dimension: 'maxAttemptsPerTask',
        limit: totalLimit,
        used: totalUsed,
      });
    }
    return {
      taskId: row.taskId,
      ...(row.featureId === undefined ? {} : { featureId: row.featureId }),
      status: row.status,
      firstPassedAt: isoOr(row.firstPassedAtUtcMs),
      attempts: {
        used: totalUsed,
        limit: totalLimit,
        remaining: totalLimit === null ? null : Math.max(0, totalLimit - totalUsed),
      },
      codeAttempts: {
        used: codeDecision.used,
        limit: codeDecision.limit,
        remaining: codeDecision.remaining,
      },
      caps,
    };
  });

  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'execution-budget',
    batch: {
      id: batch.id,
      projectId: batch.projectId,
      phaseId: batch.phaseId,
      featureId: batch.featureId,
      featureIds,
      status: batch.status,
      budgetRevision: batch.budgetRevision,
      budget: batch.budgetSnapshot,
      deadlineAtUtcMs: batch.deadlineAtUtcMs,
      dimensions: batchDecision.dimensions,
      unconfirmedDimensions: batchDecision.unconfirmedDimensions,
      runtimeStartsReserved: batch.runtimeStarts,
      usage: { tokenUsed: null, costUsed: null },
      reason: batch.reason,
      createdAt: new Date(requirePositiveSafeInteger(batch.createdAtUtcMs, 'createdAtUtcMs')).toISOString(),
      updatedAt: new Date(requirePositiveSafeInteger(batch.updatedAtUtcMs, 'updatedAtUtcMs')).toISOString(),
    },
    runs,
    tasks,
    blockingReasons,
  };
}

/** 预算修订记录公开投影（时间 ISO UTC；预算快照原样保留审计前后值）。 */
export function toPublicBatchBudgetRevisionRecord(
  record: BatchBudgetRevisionRecord,
): PublicBatchBudgetRevisionRecord {
  return {
    id: record.id,
    batchId: record.batchId,
    version: record.version,
    budget: record.budgetSnapshot,
    deadlineAtUtcMs: record.deadlineAtUtcMs,
    approvedBy: record.approvedBy,
    reason: record.reason,
    createdAt: new Date(requirePositiveSafeInteger(record.createdAtUtcMs, 'createdAtUtcMs')).toISOString(),
  };
}
