/**
 * P03-3 / F-001 执行预算契约：有限分层预算的运行时校验与纯预算判定（ports 层，纯函数）。
 *
 * 设计依据：core-design/04 §6.1（分层预算：Batch maxRuns/maxTotalAttempts/
 * maxRuntimeStarts/maxNoProgressRuns/固定绝对 deadline；Run maxAttempts 与时间上限；
 * Task maxCodeAttempts 与有效输入版本；计数与对象创建同事务、重启不从进程变量清零）、
 * §6（默认 maxCodeAttempts=3 即首次+最多两次修复；费用未知时不能用 0 证明未超预算）、
 * core-design/11 §3.2（budget_snapshot 至少含 schemaVersion、四个计数上限及可选
 * token/cost 限额；必需计数上限为有限正整数；不得用空 JSON 表示无限预算）。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件系统/网络/环境。所有“当前时间”以调用方显式传入的
 *   nowUtcMs / referenceNowUtcMs 参与（deadline 判定确定性可测）；
 * - 预算必须**有限**：四个 Batch 计数上限、Run 尝试上限、deadline 与 token 上限
 *   均为有限安全整数（cost 允许小数但必须为有限正数）；必需字段缺失、非有限、
 *   非整数、非安全整数、越界与跨层不一致一律带字段定位与机器 reason 码拒绝，
 *   绝不默认补 0/Infinity；
 * - 未知 token/cost 用量保留未知：维度 remaining/exhausted 为 null 并进入
 *   unconfirmedDimensions，不用零费用证明仍有额度；未配置资源上限不产生该维度
 *   （不虚构 0 限额）；
 * - 判定覆盖临界值：used == limit 恰好耗尽（拒绝新预占）、used == limit-1 恰余
 *   一次、now == deadline 恰好到达即耗尽；
 * - maxCodeAttempts 默认含首次共三次（DEFAULT_TASK_MAX_CODE_ATTEMPTS=3）；
 *   maxAttemptsPerTask 保持**总 Attempt 上限**语义（不是代码尝试上限），两者同时
 *   生效按 min 解析并显式标记绑定方，旧字段不被重解释。
 *
 * 数值上限为本阶段实施契约值（设计未给定），见 docs/p03-3-execution-budget-contract.md
 * §数值范围与请求核对记录。
 *
 * 本模块不实现（后续任务）：SQLite 存储/迁移（F-002）、授权命令与回执（F-003+）、
 * 预占/结算写路径（F-006..F-008）、修订 CAS（F-009）与查询（F-010）。
 */
import { StorageError } from './errors.js';
import { isPlainObject } from './validation.js';
import type { ValidationContext } from './validation.js';

/** 预算校验操作名（结构化错误 operation；纯函数保持操作身份一致）。 */
export const EXECUTION_BUDGET_VALIDATION_OPERATION = 'ExecutionBudget.validate';

/** 预算快照（budget_snapshot）结构版本；未知/未来版本 fail-closed 拒绝。 */
export const BUDGET_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Task 代码尝试上限缺省：含首次共三次（首次代码执行 + 最多两次代码修复）。
 * 这是新策略定义（core-design/04 §6），不套用旧 rework_count，也不改写
 * maxAttemptsPerTask 的总 Attempt 上限语义。
 */
export const DEFAULT_TASK_MAX_CODE_ATTEMPTS = 3;

/* ----------------------------- 数值范围（实施契约值） ----------------------------- */

/** Batch maxRuns：1..1_000。 */
export const BATCH_MAX_RUNS_MIN = 1;
export const BATCH_MAX_RUNS_MAX = 1_000;
/** Batch maxTotalAttempts：1..100_000。 */
export const BATCH_MAX_TOTAL_ATTEMPTS_MIN = 1;
export const BATCH_MAX_TOTAL_ATTEMPTS_MAX = 100_000;
/** Batch maxRuntimeStarts：1..100_000。 */
export const BATCH_MAX_RUNTIME_STARTS_MIN = 1;
export const BATCH_MAX_RUNTIME_STARTS_MAX = 100_000;
/** Batch maxNoProgressRuns：1..1_000。 */
export const BATCH_MAX_NO_PROGRESS_RUNS_MIN = 1;
export const BATCH_MAX_NO_PROGRESS_RUNS_MAX = 1_000;
/** 绝对 UTC deadline（epoch 毫秒）：正的安全整数。 */
export const BATCH_DEADLINE_UTC_MS_MIN = 1;
/** Run maxAttemptsPerRun：1..100。 */
export const RUN_MAX_ATTEMPTS_MIN = 1;
export const RUN_MAX_ATTEMPTS_MAX = 100;
/** Run runTimeLimitMs：1 秒 .. 7 天。 */
export const RUN_TIME_LIMIT_MS_MIN = 1_000;
export const RUN_TIME_LIMIT_MS_MAX = 604_800_000;
/** Task maxCodeAttempts：1..100（与 settings executionLimits 同一契约范围）。 */
export const TASK_MAX_CODE_ATTEMPTS_MIN = 1;
export const TASK_MAX_CODE_ATTEMPTS_MAX = 100;
/** Task maxAttemptsPerTask（总 Attempt 上限）：1..100（与 settings 同一契约范围）。 */
export const TASK_MAX_ATTEMPTS_PER_TASK_MIN = 1;
export const TASK_MAX_ATTEMPTS_PER_TASK_MAX = 100;

/* --------------------------------- 类型 --------------------------------- */

/** Batch 层有限预算：四个计数上限 + 绝对 UTC deadline + 可选资源总额上限。 */
export interface BatchBudgetLimits {
  readonly maxRuns: number;
  readonly maxTotalAttempts: number;
  readonly maxRuntimeStarts: number;
  readonly maxNoProgressRuns: number;
  /** 绝对 UTC 截止时间（epoch 毫秒；持久绝对时间，暂停不自动延长）。 */
  readonly deadlineUtcMs: number;
  /** 可选 token 总额上限（有限安全正整数）。 */
  readonly maxTokenTotal?: number;
  /** 可选费用总额上限（有限正数；允许小数，币种/单位由调用方约定）。 */
  readonly maxCostTotal?: number;
}

/** Run 层上限：单 Run 尝试上限与时间上限（新 Run 重置，但仍受父 Batch 累计上限）。 */
export interface RunBudgetLimits {
  readonly maxAttemptsPerRun: number;
  readonly runTimeLimitMs: number;
}

/** 一次执行授权携带的完整预算提案（Batch + Run 两层）。 */
export interface ExecutionBudgetProposal {
  readonly batch: BatchBudgetLimits;
  readonly run: RunBudgetLimits;
}

/** Batch 累计用量（计数必须已知；资源用量可为未知）。 */
export interface BatchBudgetUsage {
  readonly runsCreated: number;
  readonly attemptsCreated: number;
  readonly runtimeStarts: number;
  readonly noProgressRuns: number;
  /** token 已知用量；null/缺省 = 未知（不用 0 冒充）。 */
  readonly tokenUsed?: number | null;
  /** 费用已知用量；null/缺省 = 未知（不用 0 冒充）。 */
  readonly costUsed?: number | null;
}

export type BudgetCounterDimension =
  | 'maxRuns'
  | 'maxTotalAttempts'
  | 'maxRuntimeStarts'
  | 'maxNoProgressRuns';
export type BudgetResourceDimension = 'maxTokenTotal' | 'maxCostTotal';
export type BudgetRunDimension = 'maxAttemptsPerRun' | 'runTimeLimitMs';
export type BudgetDimension =
  | BudgetCounterDimension
  | BudgetResourceDimension
  | BudgetRunDimension
  | 'deadlineUtcMs';

/** 单个维度的判定状态；used/remaining/exhausted 为 null 表示未知。 */
export interface BudgetDimensionStatus {
  readonly limit: number;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly exhausted: boolean | null;
}

export interface BudgetExhaustionReason {
  readonly dimension: BudgetDimension;
  readonly reason: 'counter_exhausted' | 'deadline_reached' | 'resource_exhausted';
  readonly limit: number;
  readonly used: number | null;
}

/** Batch 预算对新预占的判定：计数与 deadline 已知即可判定；资源未知维度单独列出。 */
export interface BatchBudgetReservationDecision {
  readonly allowed: boolean;
  readonly reasons: readonly BudgetExhaustionReason[];
  readonly dimensions: Readonly<
    Record<BudgetCounterDimension | 'deadlineUtcMs', BudgetDimensionStatus>
  > & {
    readonly maxTokenTotal?: BudgetDimensionStatus;
    readonly maxCostTotal?: BudgetDimensionStatus;
  };
  /** 配置了资源上限但用量未知的维度（保留未知，不证明仍有额度）。 */
  readonly unconfirmedDimensions: readonly BudgetResourceDimension[];
}

/** Run 级预算判定（尝试计数 + 时间上限；未启动时时间维度未知）。 */
export interface RunBudgetReservationDecision {
  readonly allowed: boolean;
  readonly reasons: readonly BudgetExhaustionReason[];
  readonly dimensions: Readonly<Record<'maxAttemptsPerRun' | 'runTimeLimitMs', BudgetDimensionStatus>>;
}

/** Task 尝试上限解析输入：null/缺省 = 未提供。 */
export interface TaskAttemptCapsInput {
  readonly maxCodeAttempts?: number | null;
  readonly maxAttemptsPerTask?: number | null;
}

/**
 * Task 尝试上限解析结果：
 * - maxCodeAttempts：解析后的代码尝试上限（缺省 DEFAULT_TASK_MAX_CODE_ATTEMPTS）；
 * - maxAttemptsPerTask：总 Attempt 上限（未配置 = null；语义保持，不改写为代码上限）；
 * - effectiveMaxCodeAttempts：两者同时生效按 min 解析出的有效代码尝试上限；
 * - rule：显式标记绑定方（谁决定了有效上限），供审计与展示解释。
 */
export interface TaskAttemptCaps {
  readonly maxCodeAttempts: number;
  readonly maxAttemptsPerTask: number | null;
  readonly effectiveMaxCodeAttempts: number;
  readonly rule:
    | 'code_cap_default'
    | 'code_cap_only'
    | 'total_cap_only'
    | 'code_cap_binds'
    | 'total_cap_binds'
    | 'equal'
    | 'code_cap_default_bounded_by_total';
}

/** 预算快照形态（budget_snapshot）：schemaVersion=1 + Batch/Run 上限（不可变副本）。 */
export interface ExecutionBudgetSnapshot {
  readonly schemaVersion: typeof BUDGET_SNAPSHOT_SCHEMA_VERSION;
  readonly batch: BatchBudgetLimits;
  readonly run: RunBudgetLimits;
}

/* -------------------------------- 错误工具 -------------------------------- */

function budgetError(
  context: ValidationContext,
  field: string,
  reason: string,
  message: string,
): StorageError {
  return new StorageError('validation', context.operation, `${context.operation}: ${field} ${message}`, {
    entity: context.entity,
    details: { field, reason },
  });
}

/** 拒绝白名单之外的键（机器 reason 码：unknown_key）。 */
function rejectBudgetUnknownKeys(
  object: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: ValidationContext,
  field: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) {
      throw budgetError(context, field, 'unknown_key', `包含未知字段 ${key}（预算契约不接受任意对象）`);
    }
  }
}

function requireBudgetObject(value: unknown, context: ValidationContext, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw budgetError(context, field, 'invalid_type', '必须是 JSON 对象');
  }
  return value;
}

/**
 * 有限安全整数校验（必需字段）：缺失(required) → 类型(invalid_type) →
 * 非有限(not_finite) → 非整数(not_integer) → 非安全整数(not_safe_integer) →
 * 越界(out_of_range)。拒绝顺序保证 reason 码确定可测。
 */
function requireFiniteSafeInteger(
  value: unknown,
  context: ValidationContext,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    throw budgetError(context, field, 'required', '是必需的预算字段（预算必须有限，不默认补值）');
  }
  if (typeof value !== 'number') {
    throw budgetError(context, field, 'invalid_type', '必须是数字');
  }
  if (!Number.isFinite(value)) {
    throw budgetError(context, field, 'not_finite', '必须是有限数值（Infinity/NaN 不是预算）');
  }
  if (!Number.isInteger(value)) {
    throw budgetError(context, field, 'not_integer', '必须是整数');
  }
  if (!Number.isSafeInteger(value)) {
    throw budgetError(context, field, 'not_safe_integer', '必须是安全整数（|值| ≤ 2^53-1）');
  }
  if (value < min || value > max) {
    throw budgetError(context, field, 'out_of_range', `必须在 ${min}..${max} 范围内`);
  }
  return value;
}

/** 可选有限安全整数（缺省/null = 未提供）。 */
function optionalFiniteSafeInteger(
  value: unknown,
  context: ValidationContext,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireFiniteSafeInteger(value, context, field, min, max);
}

/** 可选有限正数（允许小数；用于费用上限）。 */
function optionalFinitePositiveNumber(
  value: unknown,
  context: ValidationContext,
  field: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw budgetError(context, field, 'invalid_type', '必须是数字');
  }
  if (!Number.isFinite(value)) {
    throw budgetError(context, field, 'not_finite', '必须是有限数值（Infinity/NaN 不是预算）');
  }
  if (value <= 0) {
    throw budgetError(context, field, 'out_of_range', '必须是正数');
  }
  return value;
}

/* ------------------------------ Batch / Run 校验 ------------------------------ */

const BATCH_BUDGET_KEYS = [
  'maxRuns',
  'maxTotalAttempts',
  'maxRuntimeStarts',
  'maxNoProgressRuns',
  'deadlineUtcMs',
  'maxTokenTotal',
  'maxCostTotal',
] as const;
const RUN_LIMIT_KEYS = ['maxAttemptsPerRun', 'runTimeLimitMs'] as const;

/**
 * Batch 层有限预算校验（纯函数，输入边界 unknown）：
 * 必需计数上限与绝对 UTC deadline 缺失/非有限/非安全整数/越界一律结构化拒绝；
 * 可选 token/cost 总额上限同样必须有限为正（token 须安全整数；cost 允许小数）。
 */
export function validateBatchBudgetLimits(value: unknown, context: ValidationContext): BatchBudgetLimits {
  const object = requireBudgetObject(value, context, 'budget');
  rejectBudgetUnknownKeys(object, BATCH_BUDGET_KEYS, context, 'budget');
  const result: {
    maxRuns: number;
    maxTotalAttempts: number;
    maxRuntimeStarts: number;
    maxNoProgressRuns: number;
    deadlineUtcMs: number;
    maxTokenTotal?: number;
    maxCostTotal?: number;
  } = {
    maxRuns: requireFiniteSafeInteger(object.maxRuns, context, 'budget.maxRuns', BATCH_MAX_RUNS_MIN, BATCH_MAX_RUNS_MAX),
    maxTotalAttempts: requireFiniteSafeInteger(
      object.maxTotalAttempts,
      context,
      'budget.maxTotalAttempts',
      BATCH_MAX_TOTAL_ATTEMPTS_MIN,
      BATCH_MAX_TOTAL_ATTEMPTS_MAX,
    ),
    maxRuntimeStarts: requireFiniteSafeInteger(
      object.maxRuntimeStarts,
      context,
      'budget.maxRuntimeStarts',
      BATCH_MAX_RUNTIME_STARTS_MIN,
      BATCH_MAX_RUNTIME_STARTS_MAX,
    ),
    maxNoProgressRuns: requireFiniteSafeInteger(
      object.maxNoProgressRuns,
      context,
      'budget.maxNoProgressRuns',
      BATCH_MAX_NO_PROGRESS_RUNS_MIN,
      BATCH_MAX_NO_PROGRESS_RUNS_MAX,
    ),
    deadlineUtcMs: requireFiniteSafeInteger(
      object.deadlineUtcMs,
      context,
      'budget.deadlineUtcMs',
      BATCH_DEADLINE_UTC_MS_MIN,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  const maxTokenTotal = optionalFiniteSafeInteger(
    object.maxTokenTotal,
    context,
    'budget.maxTokenTotal',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (maxTokenTotal !== undefined) {
    result.maxTokenTotal = maxTokenTotal;
  }
  const maxCostTotal = optionalFinitePositiveNumber(object.maxCostTotal, context, 'budget.maxCostTotal');
  if (maxCostTotal !== undefined) {
    result.maxCostTotal = maxCostTotal;
  }
  return result;
}

/** Run 层上限校验（纯函数，输入边界 unknown）：尝试上限与时间上限均为必需有限安全整数。 */
export function validateRunBudgetLimits(value: unknown, context: ValidationContext): RunBudgetLimits {
  const object = requireBudgetObject(value, context, 'run');
  rejectBudgetUnknownKeys(object, RUN_LIMIT_KEYS, context, 'run');
  return {
    maxAttemptsPerRun: requireFiniteSafeInteger(
      object.maxAttemptsPerRun,
      context,
      'run.maxAttemptsPerRun',
      RUN_MAX_ATTEMPTS_MIN,
      RUN_MAX_ATTEMPTS_MAX,
    ),
    runTimeLimitMs: requireFiniteSafeInteger(
      object.runTimeLimitMs,
      context,
      'run.runTimeLimitMs',
      RUN_TIME_LIMIT_MS_MIN,
      RUN_TIME_LIMIT_MS_MAX,
    ),
  };
}

const PROPOSAL_KEYS = ['batch', 'run'] as const;

export interface ExecutionBudgetProposalOptions {
  /** 可选参考时间：提供时校验 deadline 尚未到达（deadline ≤ now 即拒绝）。 */
  readonly referenceNowUtcMs?: number;
}

/**
 * 完整执行授权预算提案校验（纯函数）：Batch + Run 两层各自校验后做跨层一致性检查：
 * - maxNoProgressRuns ≤ maxRuns（无进展 Run 是 Run 的子集，上限不得大于总数）；
 * - maxTotalAttempts ≥ maxRuns（每个获准 Run 至少预算一次尝试意图）；
 * - maxRuntimeStarts ≥ maxRuns（每个获准 Run 至少预算一次 Runtime 启动意图）；
 * - run.maxAttemptsPerRun ≤ batch.maxTotalAttempts（单 Run 尝试上限不得超过整批总尝试上限）；
 * - 提供 referenceNowUtcMs 时，绝对 deadline 必须尚未到达。
 * 任何不一致带字段定位与 inconsistent_limits / deadline_passed 拒绝，不静默收紧。
 */
export function validateExecutionBudgetProposal(
  value: unknown,
  context: ValidationContext,
  options: ExecutionBudgetProposalOptions = {},
): ExecutionBudgetProposal {
  const object = requireBudgetObject(value, context, 'proposal');
  rejectBudgetUnknownKeys(object, PROPOSAL_KEYS, context, 'proposal');
  const batch = validateBatchBudgetLimits(object.batch, context);
  const run = validateRunBudgetLimits(object.run, context);

  if (batch.maxNoProgressRuns > batch.maxRuns) {
    throw budgetError(
      context,
      'budget.maxNoProgressRuns',
      'inconsistent_limits',
      `maxNoProgressRuns（${batch.maxNoProgressRuns}）不得超过 maxRuns（${batch.maxRuns}；无进展 Run 是 Run 的子集）`,
    );
  }
  if (batch.maxTotalAttempts < batch.maxRuns) {
    throw budgetError(
      context,
      'budget.maxTotalAttempts',
      'inconsistent_limits',
      `总尝试上限（${batch.maxTotalAttempts}）低于 Run 上限（${batch.maxRuns}；每个获准 Run 至少预算一次尝试）`,
    );
  }
  if (batch.maxRuntimeStarts < batch.maxRuns) {
    throw budgetError(
      context,
      'budget.maxRuntimeStarts',
      'inconsistent_limits',
      `Runtime 启动上限（${batch.maxRuntimeStarts}）低于 Run 上限（${batch.maxRuns}；每个获准 Run 至少预算一次启动）`,
    );
  }
  if (run.maxAttemptsPerRun > batch.maxTotalAttempts) {
    throw budgetError(
      context,
      'run.maxAttemptsPerRun',
      'inconsistent_limits',
      `单 Run 尝试上限（${run.maxAttemptsPerRun}）超过整批总尝试上限（${batch.maxTotalAttempts}）`,
    );
  }
  if (options.referenceNowUtcMs !== undefined) {
    const now = requireFiniteSafeInteger(
      options.referenceNowUtcMs,
      context,
      'referenceNowUtcMs',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (batch.deadlineUtcMs <= now) {
      throw budgetError(
        context,
        'budget.deadlineUtcMs',
        'deadline_passed',
        `绝对 deadline（${batch.deadlineUtcMs}）已到达或过期（参考时间 ${now}）`,
      );
    }
  }
  return { batch, run };
}

const SNAPSHOT_KEYS = ['schemaVersion', 'batch', 'run'] as const;

/**
 * 预算快照形态校验（budget_snapshot；F-002 存储层持久化前的同一权威校验）：
 * schemaVersion 必须精确等于 BUDGET_SNAPSHOT_SCHEMA_VERSION（数字但不等于 →
 * unsupported_schema_version；非数字 → invalid_schema_version），内部上限走
 * validateBatchBudgetLimits / validateRunBudgetLimits 同一套规则（不另立第二套）。
 */
export function validateExecutionBudgetSnapshot(
  value: unknown,
  context: ValidationContext,
): ExecutionBudgetSnapshot {
  const object = requireBudgetObject(value, context, 'budgetSnapshot');
  rejectBudgetUnknownKeys(object, SNAPSHOT_KEYS, context, 'budgetSnapshot');
  if (typeof object.schemaVersion !== 'number' || !Number.isInteger(object.schemaVersion)) {
    throw budgetError(
      context,
      'budgetSnapshot.schemaVersion',
      'invalid_schema_version',
      `必须是整数（本版本仅支持 ${BUDGET_SNAPSHOT_SCHEMA_VERSION}）`,
    );
  }
  if (object.schemaVersion !== BUDGET_SNAPSHOT_SCHEMA_VERSION) {
    throw budgetError(
      context,
      'budgetSnapshot.schemaVersion',
      'unsupported_schema_version',
      `未知或不支持的预算快照版本（本版本仅支持 ${BUDGET_SNAPSHOT_SCHEMA_VERSION}）`,
    );
  }
  const snapshotContext: ValidationContext = { operation: context.operation, entity: context.entity };
  const batch = validateWithFieldPrefix('budgetSnapshot.batch', () =>
    validateBatchBudgetLimits(object.batch, snapshotContext));
  const run = validateWithFieldPrefix('budgetSnapshot.run', () =>
    validateRunBudgetLimits(object.run, snapshotContext));
  return { schemaVersion: BUDGET_SNAPSHOT_SCHEMA_VERSION, batch, run };
}

/** 字段前缀包装：把内部校验错误的 details.field 加上快照定位前缀后重抛。 */
function validateWithFieldPrefix<T>(prefix: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof StorageError && error.kind === 'validation') {
      const field = typeof error.details?.field === 'string' ? error.details.field : '';
      // 剥离内部根段（budget./run.）后加快照定位前缀：budget.maxRuns →
      // budgetSnapshot.batch.maxRuns。
      const stripped = field === 'budget' || field === 'run' ? '' : field.replace(/^(budget|run)\./, '');
      throw new StorageError(error.kind, error.operation, error.message, {
        entity: error.entity,
        details: { ...error.details, field: stripped === '' ? prefix : `${prefix}.${stripped}` },
      });
    }
    throw error;
  }
}

/* --------------------------- Task 尝试上限解析 --------------------------- */

const TASK_CAPS_KEYS = ['maxCodeAttempts', 'maxAttemptsPerTask'] as const;

/**
 * Task 尝试上限解析（纯函数）：
 * - maxCodeAttempts 缺省 = DEFAULT_TASK_MAX_CODE_ATTEMPTS（含首次共三次）；
 * - maxAttemptsPerTask 保持总 Attempt 上限语义（null = 未配置），绝不被重解释为
 *   代码尝试上限；
 * - 两者同时生效按 min 解析出 effectiveMaxCodeAttempts（代码尝试是总 Attempt 的
 *   子集），rule 显式标记绑定方。
 */
export function resolveTaskAttemptCaps(value: unknown, context: ValidationContext): TaskAttemptCaps {
  const object = requireBudgetObject(value, context, 'input');
  rejectBudgetUnknownKeys(object, TASK_CAPS_KEYS, context, 'input');
  const maxCodeAttempts = optionalFiniteSafeInteger(
    object.maxCodeAttempts,
    context,
    'maxCodeAttempts',
    TASK_MAX_CODE_ATTEMPTS_MIN,
    TASK_MAX_CODE_ATTEMPTS_MAX,
  ) ?? DEFAULT_TASK_MAX_CODE_ATTEMPTS;
  const maxAttemptsPerTask =
    optionalFiniteSafeInteger(
      object.maxAttemptsPerTask,
      context,
      'maxAttemptsPerTask',
      TASK_MAX_ATTEMPTS_PER_TASK_MIN,
      TASK_MAX_ATTEMPTS_PER_TASK_MAX,
    ) ?? null;

  const codeCapProvided = object.maxCodeAttempts !== undefined && object.maxCodeAttempts !== null;
  const effectiveMaxCodeAttempts =
    maxAttemptsPerTask === null ? maxCodeAttempts : Math.min(maxCodeAttempts, maxAttemptsPerTask);

  let rule: TaskAttemptCaps['rule'];
  if (maxAttemptsPerTask === null) {
    rule = codeCapProvided ? 'code_cap_only' : 'code_cap_default';
  } else if (!codeCapProvided) {
    rule = maxAttemptsPerTask < DEFAULT_TASK_MAX_CODE_ATTEMPTS ? 'total_cap_binds' : 'code_cap_default_bounded_by_total';
  } else if (maxCodeAttempts < maxAttemptsPerTask) {
    rule = 'code_cap_binds';
  } else if (maxAttemptsPerTask < maxCodeAttempts) {
    rule = 'total_cap_binds';
  } else {
    rule = 'equal';
  }
  return { maxCodeAttempts, maxAttemptsPerTask, effectiveMaxCodeAttempts, rule };
}

/* ------------------------------ 纯预算判定 ------------------------------ */

function requireKnownCounter(value: unknown, context: ValidationContext, field: string): number {
  if (typeof value !== 'number') {
    throw budgetError(context, field, 'invalid_type', '已用计数必须是数字（未知计数不属于计数维度）');
  }
  if (!Number.isFinite(value)) {
    throw budgetError(context, field, 'not_finite', '已用计数必须是有限数值');
  }
  if (!Number.isSafeInteger(value)) {
    throw budgetError(context, field, 'not_safe_integer', '已用计数必须是安全整数');
  }
  if (value < 0) {
    throw budgetError(context, field, 'out_of_range', '已用计数必须是非负整数');
  }
  return value;
}

/** 资源用量：null/缺省 = 未知；已知则必须为有限非负数（允许小数）。 */
function readResourceUsage(
  value: unknown,
  context: ValidationContext,
  field: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw budgetError(context, field, 'invalid_type', '资源用量必须是数字或 null（未知）');
  }
  if (!Number.isFinite(value)) {
    throw budgetError(context, field, 'not_finite', '资源用量必须是有限数值');
  }
  if (value < 0) {
    throw budgetError(context, field, 'out_of_range', '资源用量必须是非负数');
  }
  return value;
}

function requireNowUtcMs(value: unknown, context: ValidationContext): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw budgetError(context, 'nowUtcMs', 'not_safe_integer', '必须是有限安全非负整数（显式时间，不读时钟）');
  }
  return value;
}

/**
 * Batch 预算对新预占的纯判定（确定性；nowUtcMs 显式传入）：
 * - 计数维度：used ≥ limit 即耗尽（== 恰好到达也拒绝新预占），remaining 下限 0；
 * - deadline：nowUtcMs ≥ deadlineUtcMs 即耗尽（恰好到达即耗尽）；
 * - 资源维度：配置上限且用量未知 → 维度未知 + unconfirmedDimensions（不进入
 *   reasons、不证明仍有额度）；已知则按上限比较。
 */
export function evaluateBatchBudgetReservation(
  budget: BatchBudgetLimits,
  usage: unknown,
  nowUtcMs: number,
): BatchBudgetReservationDecision {
  const context: ValidationContext = { operation: EXECUTION_BUDGET_VALIDATION_OPERATION };
  const object = requireBudgetObject(usage, context, 'usage');
  rejectBudgetUnknownKeys(
    object,
    ['runsCreated', 'attemptsCreated', 'runtimeStarts', 'noProgressRuns', 'tokenUsed', 'costUsed'],
    context,
    'usage',
  );
  const now = requireNowUtcMs(nowUtcMs, context);

  const reasons: BudgetExhaustionReason[] = [];
  const counter = (dimension: BudgetCounterDimension, limit: number, used: number): BudgetDimensionStatus => {
    const exhausted = used >= limit;
    if (exhausted) {
      reasons.push({ dimension, reason: 'counter_exhausted', limit, used });
    }
    return { limit, used, remaining: Math.max(0, limit - used), exhausted };
  };

  const dimensions = {
    maxRuns: counter('maxRuns', budget.maxRuns, requireKnownCounter(object.runsCreated, context, 'usage.runsCreated')),
    maxTotalAttempts: counter(
      'maxTotalAttempts',
      budget.maxTotalAttempts,
      requireKnownCounter(object.attemptsCreated, context, 'usage.attemptsCreated'),
    ),
    maxRuntimeStarts: counter(
      'maxRuntimeStarts',
      budget.maxRuntimeStarts,
      requireKnownCounter(object.runtimeStarts, context, 'usage.runtimeStarts'),
    ),
    maxNoProgressRuns: counter(
      'maxNoProgressRuns',
      budget.maxNoProgressRuns,
      requireKnownCounter(object.noProgressRuns, context, 'usage.noProgressRuns'),
    ),
    deadlineUtcMs: (() => {
      const exhausted = now >= budget.deadlineUtcMs;
      if (exhausted) {
        reasons.push({ dimension: 'deadlineUtcMs', reason: 'deadline_reached', limit: budget.deadlineUtcMs, used: now });
      }
      return {
        limit: budget.deadlineUtcMs,
        used: now,
        remaining: Math.max(0, budget.deadlineUtcMs - now),
        exhausted,
      };
    })(),
  };

  const unconfirmedDimensions: BudgetResourceDimension[] = [];
  const resource = (
    dimension: BudgetResourceDimension,
    limit: number | undefined,
    used: number | null,
  ): BudgetDimensionStatus | undefined => {
    if (limit === undefined) {
      return undefined;
    }
    if (used === null) {
      unconfirmedDimensions.push(dimension);
      return { limit, used: null, remaining: null, exhausted: null };
    }
    const exhausted = used >= limit;
    if (exhausted) {
      reasons.push({ dimension, reason: 'resource_exhausted', limit, used });
    }
    return { limit, used, remaining: Math.max(0, limit - used), exhausted };
  };

  const maxTokenTotal = resource('maxTokenTotal', budget.maxTokenTotal, readResourceUsage(object.tokenUsed, context, 'usage.tokenUsed'));
  const maxCostTotal = resource('maxCostTotal', budget.maxCostTotal, readResourceUsage(object.costUsed, context, 'usage.costUsed'));

  const decision: BatchBudgetReservationDecision = {
    allowed: reasons.length === 0,
    reasons,
    dimensions: maxTokenTotal === undefined && maxCostTotal === undefined
      ? dimensions
      : { ...dimensions, ...(maxTokenTotal === undefined ? {} : { maxTokenTotal }), ...(maxCostTotal === undefined ? {} : { maxCostTotal }) },
    unconfirmedDimensions,
  };
  return decision;
}

/**
 * Run 级纯预算判定：尝试计数（used ≥ limit 即耗尽）与时间上限
 * （elapsed ≥ limit 即耗尽，恰好到达即耗尽；startedAtUtcMs=null 时时间维度未知）。
 */
export function evaluateRunBudgetReservation(
  limits: RunBudgetLimits,
  state: { attemptsCreated: number; startedAtUtcMs: number | null },
  nowUtcMs: number,
): RunBudgetReservationDecision {
  const context: ValidationContext = { operation: EXECUTION_BUDGET_VALIDATION_OPERATION };
  const attempts = requireKnownCounter(state.attemptsCreated, context, 'state.attemptsCreated');
  const now = requireNowUtcMs(nowUtcMs, context);
  let startedAtUtcMs: number | null = null;
  if (state.startedAtUtcMs !== undefined && state.startedAtUtcMs !== null) {
    startedAtUtcMs = requireNowUtcMs(state.startedAtUtcMs, context);
    if (now < startedAtUtcMs) {
      throw budgetError(
        context,
        'state.startedAtUtcMs',
        'inconsistent_state',
        'startedAtUtcMs 晚于 nowUtcMs（时间状态不一致）',
      );
    }
  }

  const reasons: BudgetExhaustionReason[] = [];
  const attemptsExhausted = attempts >= limits.maxAttemptsPerRun;
  if (attemptsExhausted) {
    reasons.push({
      dimension: 'maxAttemptsPerRun',
      reason: 'counter_exhausted',
      limit: limits.maxAttemptsPerRun,
      used: attempts,
    });
  }
  const elapsed = startedAtUtcMs === null ? null : now - startedAtUtcMs;
  const timeExhausted = elapsed === null ? null : elapsed >= limits.runTimeLimitMs;
  if (timeExhausted === true) {
    reasons.push({
      dimension: 'runTimeLimitMs',
      reason: 'deadline_reached',
      limit: limits.runTimeLimitMs,
      used: elapsed,
    });
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    dimensions: {
      maxAttemptsPerRun: {
        limit: limits.maxAttemptsPerRun,
        used: attempts,
        remaining: Math.max(0, limits.maxAttemptsPerRun - attempts),
        exhausted: attemptsExhausted,
      },
      runTimeLimitMs: {
        limit: limits.runTimeLimitMs,
        used: elapsed,
        remaining: elapsed === null ? null : Math.max(0, limits.runTimeLimitMs - elapsed),
        exhausted: timeExhausted,
      },
    },
  };
}

/**
 * Task 代码尝试纯判定：used ≥ effectiveMaxCodeAttempts 即拒绝新代码尝试
 * （恰好到达即耗尽；首次代码执行计入 used）。仅判定代码尝试维度；总 Attempt
 * 上限由调用方按同一累计计数另行判定（两者同时生效，互不替代）。
 */
export function evaluateTaskCodeAttemptReservation(
  caps: Pick<TaskAttemptCaps, 'effectiveMaxCodeAttempts'>,
  codeAttemptsUsed: number,
): {
  readonly allowed: boolean;
  readonly used: number;
  readonly remaining: number;
  readonly limit: number;
  readonly reason?: 'code_attempts_exhausted';
} {
  const context: ValidationContext = { operation: EXECUTION_BUDGET_VALIDATION_OPERATION };
  const used = requireKnownCounter(codeAttemptsUsed, context, 'codeAttemptsUsed');
  const limit = requireFiniteSafeInteger(
    caps.effectiveMaxCodeAttempts,
    context,
    'effectiveMaxCodeAttempts',
    TASK_MAX_CODE_ATTEMPTS_MIN,
    TASK_MAX_CODE_ATTEMPTS_MAX,
  );
  const exhausted = used >= limit;
  return exhausted
    ? { allowed: false, used, remaining: 0, limit, reason: 'code_attempts_exhausted' }
    : { allowed: true, used, remaining: limit - used, limit };
}
