/**
 * P03-3 / F-012 执行授权 CLI 纯视图层：预算文档解析/参数映射与结果结构化输出。
 *
 * 纯函数模块（无 I/O）：
 * - 预算文档解析：`--input` 的用户预算 JSON → 既有 HostClient 的完整有限预算
 *   （`ExecutionBudgetProposal` 形态）。缺少预算、非法日期/整数、越界、未知键、
 *   有效并发大于一与形态错误在任何 I/O 之前以稳定 reason 拒绝（输入错误不发
 *   启动请求，由纵向用例复核）；日期接受 epoch 毫秒整数或 ISO-8601 UTC 日期
 *   并映射为 epoch 毫秒；服务端仍是预算语义的单一权威复核方；
 * - 结果视图：把 HostClient 已线校验的回执/查询结果投影为 CLI 结构化输出，
 *   区分 accepted、尚未执行、预算耗尽与业务完成四态，显示真实 Batch/Run ID
 *   与剩余额度；accepted 的提交成功输出不被描述为 Feature 已验收通过；
 * - 人类行：脱敏事实字段；不打印正文、凭据、秘密或开发机路径。
 *
 * 范围边界：预览不是授权（authorization.confirmed 恒 false）；本模块不发起
 * wait/cancel/resume，也不把 task prepare 升级为执行授权。
 */
import { AppCliParseError } from './args.js';
import type { AppCliCommand, AppCliCommandId, AppCliParseReason } from './args.js';
import type {
  BudgetRevisionListResult,
  ExecutionBudgetStatusResult,
  ExecutionPreviewResult,
} from 'shiploop-host';

/* ------------------------------------------------------------------ *
 * 输入守护上下文（与 decisions.ts 同一错误口径）
 * ------------------------------------------------------------------ */

export interface ExecutionInputContext {
  readonly command: AppCliCommand;
  readonly commandId?: AppCliCommandId | null;
  readonly json?: boolean;
}

function failInput(
  context: ExecutionInputContext,
  reason: AppCliParseReason,
  field: string,
): never {
  throw new AppCliParseError(
    'invalid_input',
    reason,
    {
      command: context.command,
      commandId: context.commandId ?? null,
      json: context.json ?? false,
    },
    field,
  );
}

/* ------------------------------------------------------------------ *
 * 完整有限预算文档（用户输入 → HostClient budget）
 * ------------------------------------------------------------------ */

/** 映射后的完整有限预算（ExecutionBudgetProposal 线形态；不含并发声明）。 */
export interface ExecutionBudgetWire {
  readonly batch: {
    readonly maxRuns: number;
    readonly maxTotalAttempts: number;
    readonly maxRuntimeStarts: number;
    readonly maxNoProgressRuns: number;
    readonly deadlineUtcMs: number;
    readonly maxTokenTotal?: number;
    readonly maxCostTotal?: number;
  };
  readonly run: {
    readonly maxAttemptsPerRun: number;
    readonly runTimeLimitMs: number;
  };
}

/**
 * 数值范围镜像 core ports/execution-budget 契约值（Host 公共面未导出常量，
 * 不另立数值语义）；服务端权威校验器仍完整复核，客户端只做参数把关。
 */
const BATCH_MAX_RUNS_RANGE: readonly [number, number] = [1, 1_000];
const BATCH_MAX_TOTAL_ATTEMPTS_RANGE: readonly [number, number] = [1, 100_000];
const BATCH_MAX_RUNTIME_STARTS_RANGE: readonly [number, number] = [1, 100_000];
const BATCH_MAX_NO_PROGRESS_RUNS_RANGE: readonly [number, number] = [1, 1_000];
const RUN_MAX_ATTEMPTS_RANGE: readonly [number, number] = [1, 100];
const RUN_TIME_LIMIT_MS_RANGE: readonly [number, number] = [1_000, 604_800_000];
/** 并发上限镜像 settings-schema（1..16）；大于一即本版本明确拒绝。 */
const MAX_CONCURRENT_WORKS_RANGE: readonly [number, number] = [1, 16];

const BUDGET_DOCUMENT_KEYS = ['batch', 'run', 'concurrency'] as const;
const BATCH_BUDGET_KEYS = [
  'maxRuns',
  'maxTotalAttempts',
  'maxRuntimeStarts',
  'maxNoProgressRuns',
  'deadlineUtcMs',
  'maxTokenTotal',
  'maxCostTotal',
] as const;
const BATCH_REQUIRED_KEYS = [
  'maxRuns',
  'maxTotalAttempts',
  'maxRuntimeStarts',
  'maxNoProgressRuns',
  'deadlineUtcMs',
] as const;
const RUN_BUDGET_KEYS = ['maxAttemptsPerRun', 'runTimeLimitMs'] as const;
const CONCURRENCY_KEYS = ['maxConcurrentWorks'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  context: ExecutionInputContext,
  field: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    failInput(context, 'invalid_budget', field);
  }
  return value;
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  context: ExecutionInputContext,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      failInput(context, 'unknown_input_field', key);
    }
  }
}

function readInteger(
  object: Record<string, unknown>,
  key: string,
  context: ExecutionInputContext,
  field: string,
  range: readonly [number, number],
): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    failInput(context, 'invalid_integer', field);
  }
  if (value < range[0] || value > range[1]) {
    failInput(context, 'integer_out_of_range', field);
  }
  return value;
}

/**
 * deadline 参数映射：epoch 毫秒安全整数（≥ 1）或 ISO-8601 UTC 日期字符串
 * （映射为 epoch 毫秒）；其余一律 invalid_budget_date / invalid_integer。
 */
function readDeadlineUtcMs(
  object: Record<string, unknown>,
  context: ExecutionInputContext,
  field: string,
): number {
  const value = object.deadlineUtcMs;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      failInput(context, 'invalid_integer', field);
    }
    if (value < 1) {
      failInput(context, 'invalid_budget_date', field);
    }
    return value;
  }
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      failInput(context, 'invalid_budget_date', field);
    }
    return parsed;
  }
  failInput(context, 'invalid_budget_date', field);
}

/**
 * 解析用户预算文档（严格未知键拒绝）：
 * `{ batch: {...}, run: {...}, concurrency?: { maxConcurrentWorks } }`。
 * concurrency 是用户声明的有效并发：大于一即 concurrency_not_supported，
 * 不进入请求体（执行面固定单并发，服务端另有权威并发政策复核）。
 */
export function parseExecutionBudgetDocument(
  value: Record<string, unknown>,
  context: ExecutionInputContext,
): ExecutionBudgetWire {
  rejectUnknownKeys(value, BUDGET_DOCUMENT_KEYS, context);
  if (value.batch === undefined) {
    failInput(context, 'missing_budget', 'batch');
  }
  if (value.run === undefined) {
    failInput(context, 'missing_budget', 'run');
  }
  const batch = requireRecord(value.batch, context, 'batch');
  const run = requireRecord(value.run, context, 'run');
  rejectUnknownKeys(batch, BATCH_BUDGET_KEYS, context);
  rejectUnknownKeys(run, RUN_BUDGET_KEYS, context);
  for (const key of BATCH_REQUIRED_KEYS) {
    if (batch[key] === undefined) {
      failInput(context, 'missing_budget', `batch.${key}`);
    }
  }
  for (const key of RUN_BUDGET_KEYS) {
    if (run[key] === undefined) {
      failInput(context, 'missing_budget', `run.${key}`);
    }
  }

  const maxRuns = readInteger(batch, 'maxRuns', context, 'batch.maxRuns', BATCH_MAX_RUNS_RANGE);
  const maxTotalAttempts = readInteger(
    batch, 'maxTotalAttempts', context, 'batch.maxTotalAttempts', BATCH_MAX_TOTAL_ATTEMPTS_RANGE,
  );
  const maxRuntimeStarts = readInteger(
    batch, 'maxRuntimeStarts', context, 'batch.maxRuntimeStarts', BATCH_MAX_RUNTIME_STARTS_RANGE,
  );
  const maxNoProgressRuns = readInteger(
    batch, 'maxNoProgressRuns', context, 'batch.maxNoProgressRuns', BATCH_MAX_NO_PROGRESS_RUNS_RANGE,
  );
  const deadlineUtcMs = readDeadlineUtcMs(batch, context, 'batch.deadlineUtcMs');
  const maxAttemptsPerRun = readInteger(
    run, 'maxAttemptsPerRun', context, 'run.maxAttemptsPerRun', RUN_MAX_ATTEMPTS_RANGE,
  );
  const runTimeLimitMs = readInteger(
    run, 'runTimeLimitMs', context, 'run.runTimeLimitMs', RUN_TIME_LIMIT_MS_RANGE,
  );

  let maxTokenTotal: number | undefined;
  if (batch.maxTokenTotal !== undefined) {
    if (typeof batch.maxTokenTotal !== 'number' || !Number.isSafeInteger(batch.maxTokenTotal)) {
      failInput(context, 'invalid_integer', 'batch.maxTokenTotal');
    }
    if (batch.maxTokenTotal < 1) {
      failInput(context, 'integer_out_of_range', 'batch.maxTokenTotal');
    }
    maxTokenTotal = batch.maxTokenTotal;
  }
  let maxCostTotal: number | undefined;
  if (batch.maxCostTotal !== undefined) {
    if (typeof batch.maxCostTotal !== 'number' || !Number.isFinite(batch.maxCostTotal) || batch.maxCostTotal <= 0) {
      failInput(context, 'invalid_budget', 'batch.maxCostTotal');
    }
    maxCostTotal = batch.maxCostTotal;
  }

  if (value.concurrency !== undefined) {
    const concurrency = requireRecord(value.concurrency, context, 'concurrency');
    rejectUnknownKeys(concurrency, CONCURRENCY_KEYS, context);
    const declared = concurrency.maxConcurrentWorks;
    if (typeof declared !== 'number' || !Number.isSafeInteger(declared)) {
      failInput(context, 'invalid_integer', 'concurrency.maxConcurrentWorks');
    }
    if (declared < MAX_CONCURRENT_WORKS_RANGE[0]) {
      failInput(context, 'integer_out_of_range', 'concurrency.maxConcurrentWorks');
    }
    if (declared > 1) {
      failInput(context, 'concurrency_not_supported', 'concurrency.maxConcurrentWorks');
    }
  }

  return {
    batch: {
      maxRuns,
      maxTotalAttempts,
      maxRuntimeStarts,
      maxNoProgressRuns,
      deadlineUtcMs,
      ...(maxTokenTotal !== undefined ? { maxTokenTotal } : {}),
      ...(maxCostTotal !== undefined ? { maxCostTotal } : {}),
    },
    run: { maxAttemptsPerRun, runTimeLimitMs },
  };
}

/* ------------------------------------------------------------------ *
 * 执行状态四态（accepted / 尚未执行 / 预算耗尽 / 业务完成）
 * ------------------------------------------------------------------ */

export type ExecutionStateView =
  | 'accepted'
  | 'not_executed'
  | 'budget_exhausted'
  | 'business_completed';

export interface ExecutionStatesView {
  readonly accepted: boolean;
  readonly notExecuted: boolean;
  readonly budgetExhausted: boolean;
  readonly businessCompleted: boolean;
}

/**
 * 从权威预算查询派生执行状态四态（纯投影，不改写权威事实）：
 * - business_completed：固定范围内全部 Task 已受信通过（业务完成 ≠ accepted）；
 * - budget_exhausted：阻塞原因或任一维度耗尽（预算耗尽）；
 * - not_executed：尚无 Runtime 启动预占且全部 Run 未启动（尚未执行）；
 * - accepted：授权已受理（Batch 已创建）之外的其余情形。
 */
export function deriveExecutionState(
  status: ExecutionBudgetStatusResult,
): { readonly state: ExecutionStateView; readonly states: ExecutionStatesView } {
  const anyDimensionExhausted = (
    dimensions: Readonly<Record<string, { readonly exhausted: boolean | null }>>,
  ): boolean => Object.values(dimensions).some((dimension) => dimension.exhausted === true);
  const budgetExhausted =
    status.blockingReasons.some((reason) => reason.reason === 'budget_exhausted') ||
    anyDimensionExhausted(status.batch.dimensions) ||
    status.runs.some((run) => anyDimensionExhausted(run.dimensions));
  const businessCompleted =
    status.tasks.length > 0 && status.tasks.every((task) => task.status === 'passed');
  const notExecuted =
    status.batch.runtimeStartsReserved === 0 && status.runs.every((run) => run.startedAt === null);
  const states: ExecutionStatesView = {
    accepted: true,
    notExecuted,
    budgetExhausted,
    businessCompleted,
  };
  const state: ExecutionStateView = businessCompleted
    ? 'business_completed'
    : budgetExhausted
      ? 'budget_exhausted'
      : notExecuted
        ? 'not_executed'
        : 'accepted';
  return { state, states };
}

/* ------------------------------------------------------------------ *
 * execution.preview 结果视图
 * ------------------------------------------------------------------ */

export interface ExecutionPreviewView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly operation: 'execution.preview';
  readonly projectId: string;
  readonly featureIds: readonly string[];
  readonly status: 'ready' | 'no_work' | 'blocked';
  readonly noWorkReason: string | null;
  readonly blocked: readonly unknown[];
  readonly previewDigest: string | null;
  /** 预览不是授权：confirmed 恒 false；执行须 execution start 显式确认。 */
  readonly authorization: {
    readonly confirmed: false;
    readonly note: string;
  };
  readonly execution: {
    readonly started: false;
    readonly runtimeExecution: false;
  };
  readonly summary: ExecutionPreviewResult['summary'];
  readonly generatedAtUtcMs: number;
}

export function buildExecutionPreviewView(
  commandId: string,
  replayed: boolean,
  result: ExecutionPreviewResult,
): ExecutionPreviewView {
  return {
    commandId,
    replayed,
    operation: 'execution.preview',
    projectId: result.projectId,
    featureIds: result.scope.featureIds,
    status: result.status,
    noWorkReason: result.noWorkReason,
    blocked: result.blocked,
    previewDigest: result.previewDigest,
    authorization: {
      confirmed: false,
      note: '预览不是授权：必须以 execution start --confirm --preview-digest 显式授权后才创建执行',
    },
    execution: { started: false, runtimeExecution: false },
    summary: result.summary,
    generatedAtUtcMs: result.generatedAtUtcMs,
  };
}

export function formatExecutionPreviewView(view: ExecutionPreviewView): string {
  const marker = view.replayed ? '（replayed）' : '';
  if (view.status === 'ready') {
    return (
      `shiploop execution preview: status=ready feature=${view.featureIds.join(',')} ` +
      `digest=${String(view.previewDigest)} tasks=${String(view.summary?.plan.taskCount ?? 0)} ` +
      `pending=${String(view.summary?.plan.pendingTaskIds.length ?? 0)} ` +
      `（预览不是授权；执行需 execution start --confirm --preview-digest）${marker}\n`
    );
  }
  if (view.status === 'no_work') {
    return (
      `shiploop execution preview: status=no_work reason=${String(view.noWorkReason)} ` +
      `（无待执行工作；未创建执行实体）${marker}\n`
    );
  }
  const kinds = view.blocked
    .map((reason) => (isPlainRecord(reason) && typeof reason.kind === 'string' ? reason.kind : 'unknown'))
    .join(',');
  return (
    `shiploop execution preview: status=blocked reasons=${kinds} ` +
    `（阻塞未解除；未授权执行）${marker}\n`
  );
}

/* ------------------------------------------------------------------ *
 * execution.start（accepted）结果视图
 * ------------------------------------------------------------------ */

export interface ExecutionStartIdentity {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly featureIds: readonly string[];
  readonly previewDigest: string | null;
  readonly retryBatchId: string | null;
}

export interface ExecutionStartView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly operation: 'execution.start';
  readonly status: 'accepted';
  readonly executionState: 'accepted';
  readonly featureIds: readonly string[];
  /** 真实授权 Batch 身份（=operationId，不是合成操作）。 */
  readonly batchId: string;
  /** 真实 Run 身份。 */
  readonly runId: string;
  readonly operationId: string;
  readonly authorization: {
    readonly confirmed: true;
    readonly previewDigest: string | null;
    readonly retryBatchId: string | null;
  };
  /** accepted 只代表提交成功：未执行、未结算、不代表 Feature 验收结果。 */
  readonly completion: {
    readonly featureVerified: false;
    readonly businessCompleted: false;
    readonly note: string;
  };
}

export function buildExecutionStartView(
  identity: ExecutionStartIdentity,
  receipt: {
    readonly operationId: string;
    readonly batchId: string;
    readonly runId: string;
  },
): ExecutionStartView {
  return {
    commandId: identity.commandId,
    replayed: identity.replayed,
    operation: 'execution.start',
    status: 'accepted',
    executionState: 'accepted',
    featureIds: identity.featureIds,
    batchId: receipt.batchId,
    runId: receipt.runId,
    operationId: receipt.operationId,
    authorization: {
      confirmed: true,
      previewDigest: identity.previewDigest,
      retryBatchId: identity.retryBatchId,
    },
    completion: {
      featureVerified: false,
      businessCompleted: false,
      note: 'accepted 仅表示执行授权提交成功：尚未执行、未验收，不代表 Feature 完成或业务完成',
    },
  };
}

export function formatExecutionStartView(view: ExecutionStartView): string {
  const marker = view.replayed ? '（replayed）' : '';
  return (
    `shiploop execution start: accepted batch=${view.batchId} run=${view.runId} ` +
    `（提交成功；尚未执行、未验收，不代表 Feature 完成）${marker}\n`
  );
}

/* ------------------------------------------------------------------ *
 * execution.budget 查询结果视图（真实 Batch/Run ID + 剩余额度）
 * ------------------------------------------------------------------ */

export interface ExecutionBudgetView {
  readonly operation: 'execution.budget.get';
  readonly executionState: ExecutionStateView;
  readonly states: ExecutionStatesView;
  /** 权威一致读视图（Batch/Run/Task 身份、各层上限与已用/剩余、阻塞原因）。 */
  readonly budget: ExecutionBudgetStatusResult;
  /** 有界修订历史（初始授权与历次显式修订）。 */
  readonly revisions: BudgetRevisionListResult;
}

export function buildExecutionBudgetView(
  status: ExecutionBudgetStatusResult,
  revisions: BudgetRevisionListResult,
): ExecutionBudgetView {
  const { state, states } = deriveExecutionState(status);
  return {
    operation: 'execution.budget.get',
    executionState: state,
    states,
    budget: status,
    revisions,
  };
}

export function formatExecutionBudgetView(view: ExecutionBudgetView): string {
  const { budget, revisions } = view;
  const dimensions = Object.entries(budget.batch.dimensions)
    .map(([key, dimension]) =>
      dimension.exhausted === null
        ? `${key}=unknown`
        : `${key}=${String(dimension.remaining)}/${String(dimension.limit)}`,
    )
    .join(' ');
  const runs = budget.runs
    .map((run) => `  run=${run.id} status=${run.status} reason=${run.reason ?? 'none'} started=${run.startedAt ?? 'none'}`)
    .join('\n');
  const blocking = budget.blockingReasons.length === 0
    ? 'none'
    : budget.blockingReasons.map((reason) => reason.reason).join(',');
  return [
    `shiploop execution budget: state=${view.executionState} batch=${budget.batch.id} ` +
      `status=${budget.batch.status} budgetRevision=${budget.batch.budgetRevision}`,
    runs,
    `  remaining: ${dimensions}`,
    `  usage: token=${budget.batch.usage.tokenUsed ?? 'unknown'} cost=${budget.batch.usage.costUsed ?? 'unknown'} ` +
      `runtimeStartsReserved=${budget.batch.runtimeStartsReserved}`,
    `  blocking=${blocking} revisions=${revisions.records.length}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.revise（预算显式修订）结果视图
 * ------------------------------------------------------------------ */

export interface ExecutionReviseView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly operation: 'execution.budget.revise';
  readonly batchId: string;
  readonly budgetRevision: number;
  readonly approvedBy: string;
  readonly reason: string;
  readonly revisedAt: string;
  readonly previous: {
    readonly version: number;
    readonly deadlineAtUtcMs: number;
    readonly budget: unknown;
  };
  readonly revised: {
    readonly version: number;
    readonly deadlineAtUtcMs: number;
    readonly budget: unknown;
  };
}

function requireRevisionSnapshot(value: unknown, field: string): {
  readonly version: number;
  readonly deadlineAtUtcMs: number;
  readonly budget: unknown;
} {
  if (!isPlainRecord(value) || typeof value.version !== 'number' || typeof value.deadlineAtUtcMs !== 'number') {
    throw new Error(`unexpected_revision_result_shape:${field}`);
  }
  return { version: value.version, deadlineAtUtcMs: value.deadlineAtUtcMs, budget: value.budget };
}

export function buildExecutionReviseView(
  commandId: string,
  replayed: boolean,
  result: unknown,
): ExecutionReviseView {
  if (
    !isPlainRecord(result) ||
    typeof result.batchId !== 'string' ||
    typeof result.budgetRevision !== 'number' ||
    typeof result.approvedBy !== 'string' ||
    typeof result.reason !== 'string' ||
    typeof result.revisedAt !== 'string'
  ) {
    throw new Error('unexpected_revision_result_shape');
  }
  return {
    commandId,
    replayed,
    operation: 'execution.budget.revise',
    batchId: result.batchId,
    budgetRevision: result.budgetRevision,
    approvedBy: result.approvedBy,
    reason: result.reason,
    revisedAt: result.revisedAt,
    previous: requireRevisionSnapshot(result.previous, 'previous'),
    revised: requireRevisionSnapshot(result.revised, 'revised'),
  };
}

export function formatExecutionReviseView(view: ExecutionReviseView): string {
  const marker = view.replayed ? '（replayed）' : '';
  return (
    `shiploop execution revise: batch=${view.batchId} budgetRevision=${view.budgetRevision} ` +
    `previous=${view.previous.version}（修订绑定 expectedRevision 与理由；不启动执行）${marker}\n`
  );
}
