/**
 * P03-9 / F-004 分层时间上限契约（ports 层，纯函数，无 I/O）。
 *
 * 设计依据：P03-9 PRD FR-1（Run/Batch、Session、单工具与 Verifier 检查各自
 * 有独立时间上限）、core-design/04 §6.1（Batch 绝对 deadline 与 Run 时间上限
 * 持久化；暂停/重启不重置）、core-design/14（Core 拥有预算/停止核验，超时与
 * 用户取消是不同事实）。
 *
 * 不变量：
 * - 纯函数：不读时钟/文件系统/网络/环境；“当前时间”与持久开始时间由调用方
 *   显式传入，因此 deadline 判定可确定性测试；
 * - 每层都必须有限：Session/工具/检查上限为有限正整数，Run/Batch 使用持久
 *   绝对时间；缺字段、非整数、越界一律带字段定位拒绝，不默认补 Infinity；
 * - Session、Run、Batch 形成嵌套截止：Run 从持久 startedAt 计算，Batch 使用
 *   绝对 deadline，二者都不因暂停、重启、resume、新 Session 或仅收尾重试
 *   重置；任何一层到达即整体到期，不能被另一层剩余额度绕过；
 * - 工具/检查层是 Session 内的子额度：实际值取自身配置与 Session 剩余额度
 *   的较小者；自身上限先到即按该层超时归因，Session 先到则按 Session 归因；
 * - 本模块不启动进程、不持久化、不取消执行；停止仍走既有受监督 CommandProcess
 *   路径。
 */
import { StorageError } from './errors.js';
import { isPlainObject } from './validation.js';
import type { ValidationContext } from './validation.js';

/** 分层时间上限的受控层词汇（与 RuntimeTimeoutFact.layer 同源）。 */
export const EXECUTION_TIME_LIMIT_LAYERS = ['session', 'tool', 'check', 'run', 'batch'] as const;
export type ExecutionTimeLimitLayer = (typeof EXECUTION_TIME_LIMIT_LAYERS)[number];

/** 有效截止实际由哪一层决定（只有 Session/Run/Batch 决定整体到期）。 */
export type ExecutionDeadlineLayer = 'session' | 'run' | 'batch';

/** 未配置政策时的有限缺省（不是无限等待的授权）。 */
export const DEFAULT_WORK_TIME_LIMIT_MS = 60_000;
export const DEFAULT_TOOL_TIME_LIMIT_MS = 30_000;

export interface ExecutionDeadlineInput {
  /** 判定时刻（UTC epoch 毫秒）。 */
  readonly nowUtcMs: number;
  /** Session 总时长上限（毫秒）。 */
  readonly sessionTimeLimitMs: number;
  /** 单工具上限（毫秒；null/缺省表示未配置，由适配器自身有限上限约束）。 */
  readonly toolTimeLimitMs?: number | null;
  /** 单检查上限（毫秒；null/缺省表示使用检查定义自身的有限 timeout）。 */
  readonly checkTimeLimitMs?: number | null;
  /** Run 的持久开始时间；null 表示尚未启动的新 Run（以 now 作为开始）。 */
  readonly runStartedAtUtcMs: number | null;
  readonly runTimeLimitMs: number;
  /** Batch 的持久绝对截止时间（毫秒）。 */
  readonly batchDeadlineUtcMs: number;
}

export interface ExecutionDeadlines {
  readonly nowUtcMs: number;
  readonly sessionDeadlineUtcMs: number;
  readonly runDeadlineUtcMs: number;
  readonly batchDeadlineUtcMs: number;
  /** Session/Run/Batch 中最早的截止时间。 */
  readonly effectiveDeadlineUtcMs: number;
  readonly effectiveLayer: ExecutionDeadlineLayer;
  readonly remainingMs: number;
  /** Session 内可用的工具上限（自身配置与 Session 剩余额度取较小者）。 */
  readonly toolTimeoutMs: number | null;
  /** Session 内可用的检查上限（自身配置与 Session 剩余额度取较小者）。 */
  readonly checkTimeoutMs: number | null;
  readonly expired: boolean;
  /** 已到期的层（Session/Run/Batch；确定性顺序）。 */
  readonly expiredLayers: readonly ExecutionDeadlineLayer[];
}

const OPERATION = 'ExecutionTimeLimits.resolve';
const CONTEXT: ValidationContext = { operation: OPERATION };

function fail(field: string, reason: string, message: string, value?: unknown): never {
  throw new StorageError('validation', OPERATION, `${OPERATION}: ${field} ${message}`, {
    details: { field, reason, ...(value === undefined ? {} : { value }) },
  });
}

function finitePositive(value: unknown, field: string): number {
  if (value === undefined || value === null) fail(field, 'required', '是必需的时间上限（不默认无限）');
  if (typeof value !== 'number') fail(field, 'invalid_type', '必须是数字');
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(field, 'invalid_limit', '必须是 ≥1 的安全整数（毫秒）');
  }
  return value;
}

function nullablePositive(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return finitePositive(value, field);
}

/**
 * 解析并校验一次执行的嵌套截止时间。输入为 unknown；失败一律带字段定位。
 *
 * `runStartedAtUtcMs` 为 null 时以 `nowUtcMs` 作为新 Run 的开始（同一调用内
 * 稳定）；已持久化的 Run 必须传真实开始时间，暂停/重启/新 Session 不得改写。
 */
export function resolveExecutionDeadlines(value: unknown): ExecutionDeadlines {
  if (!isPlainObject(value)) fail('input', 'invalid_type', '必须是 JSON 对象');
  const known = new Set([
    'nowUtcMs', 'sessionTimeLimitMs', 'toolTimeLimitMs', 'checkTimeLimitMs',
    'runStartedAtUtcMs', 'runTimeLimitMs', 'batchDeadlineUtcMs',
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail(`input.${key}`, 'unknown_key', '不是受控的时间上限字段');
  }
  const nowUtcMs = finitePositive(value.nowUtcMs, 'input.nowUtcMs');
  const sessionTimeLimitMs = finitePositive(value.sessionTimeLimitMs, 'input.sessionTimeLimitMs');
  const toolTimeLimitMs = nullablePositive(value.toolTimeLimitMs, 'input.toolTimeLimitMs');
  const checkTimeLimitMs = nullablePositive(value.checkTimeLimitMs, 'input.checkTimeLimitMs');
  const runStartedAtUtcMs = value.runStartedAtUtcMs === null
    ? nowUtcMs
    : finitePositive(value.runStartedAtUtcMs, 'input.runStartedAtUtcMs');
  if (runStartedAtUtcMs > nowUtcMs) {
    fail('input.runStartedAtUtcMs', 'run_start_after_now', '不得晚于判定时刻（持久开始时间已损坏）');
  }
  const runTimeLimitMs = finitePositive(value.runTimeLimitMs, 'input.runTimeLimitMs');
  const batchDeadlineUtcMs = finitePositive(value.batchDeadlineUtcMs, 'input.batchDeadlineUtcMs');

  const sessionDeadlineUtcMs = nowUtcMs + sessionTimeLimitMs;
  const runDeadlineUtcMs = runStartedAtUtcMs + runTimeLimitMs;
  const layered: ReadonlyArray<readonly [ExecutionDeadlineLayer, number]> = [
    ['session', sessionDeadlineUtcMs],
    ['run', runDeadlineUtcMs],
    ['batch', batchDeadlineUtcMs],
  ];
  const effective = layered.reduce((earliest, candidate) =>
    candidate[1] <= earliest[1] ? candidate : earliest);
  const remainingMs = Math.max(0, effective[1] - nowUtcMs);
  const expiredLayers = layered.filter(([, deadline]) => deadline <= nowUtcMs).map(([layer]) => layer);
  return {
    nowUtcMs,
    sessionDeadlineUtcMs,
    runDeadlineUtcMs,
    batchDeadlineUtcMs,
    effectiveDeadlineUtcMs: effective[1],
    effectiveLayer: effective[0],
    remainingMs,
    toolTimeoutMs: toolTimeLimitMs === null ? null : Math.min(toolTimeLimitMs, Math.max(1, sessionTimeLimitMs)),
    checkTimeoutMs: checkTimeLimitMs === null ? null : Math.min(checkTimeLimitMs, Math.max(1, sessionTimeLimitMs)),
    expired: expiredLayers.length > 0,
    expiredLayers,
  };
}

/**
 * 某一层实际可用的有界等待时间：自身上限、Session 剩余额度（由调用方传入
 * 的剩余毫秒）与父截止剩余取较小者；已到期返回 0，调用方不得启动新执行。
 */
export function resolveLayerTimeoutMs(input: {
  readonly limitMs: number | null;
  readonly sessionRemainingMs: number;
  readonly parentRemainingMs: number;
}): number {
  const limit = input.limitMs === null ? Number.POSITIVE_INFINITY : finitePositive(input.limitMs, 'limitMs');
  if (!Number.isFinite(input.sessionRemainingMs) || input.sessionRemainingMs < 0
    || !Number.isFinite(input.parentRemainingMs) || input.parentRemainingMs < 0) {
    fail('remaining', 'invalid_remaining', '剩余时间必须是非负有限数值');
  }
  if (input.sessionRemainingMs === 0 || input.parentRemainingMs === 0) return 0;
  return Math.max(1, Math.min(limit, input.sessionRemainingMs, input.parentRemainingMs));
}
