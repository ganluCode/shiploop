/**
 * P03-6 / F-003 FakeRuntime 声明式脚本契约（ports 契约层：类型、常量与纯
 * 校验函数，无任何 I/O）。
 *
 * 设计依据：input/p03-fake-runtime.md FR-2（显式测试装配的 FakeRuntime
 * 脚本；测试专用脚本不成为任意用户 shell 注入入口；模拟 token 明确
 * test/synthetic）与 task F-003 验收（脚本仅由可信测试装配注入；脚本长度、
 * 操作数量、单次正文和总输出有界）。
 *
 * 契约要点：
 * - 脚本是纯数据（plain object），带 schemaVersion 严格白名单；绝不是模块
 *   说明符、文件路径、shell 文本或函数——本层只校验数据形态，任何可执行
 *   来源在校验边界即拒绝；
 * - 步骤词汇固定十种：read_input（读取获准输入）/ read_file / write_file
 *   （真实读写 workspace 相对位置）/ message / tool（关联消息与工具事件）/
 *   usage（synthetic 用量事件）/ fail（受控失败注入）/ tool_command（F-004
 *   受控真实工具命令：只以名称引用可信装配批准的命令定义，脚本绝不携带
 *   argv/环境/shell 等可执行内容）/ await_gate 与 raise（F-005：挂起在
 *   命名门闩上的可控等待与意外异常注入；门闩本体由可信装配注入，脚本只
 *   引用名称）；未知操作一律拒绝；
 * - 工作区路径复用 validateArtifactLocator 的 POSIX 相对位置规则（拒绝
 *   绝对路径、反斜杠、. 与 .. 段、NUL），词法越界在脚本校验期即拒绝；
 * - 有界性：脚本序列化字节、步骤数量、单步正文（write_file content）与
 *   全部正文合计全部显式有限；message 文本受事件预览上限约束（≤200），
 *   超长脚本无法进入执行器；
 * - 结果声明使用 F-001 终态词汇（completed/failed/cancelled/timed_out，
 *   不存在 passed——Task 验收是 Core 职责）；退出码/信号/耗时/用量未知
 *   必须为显式 null；脚本内 usage 只提供计数，basis 由执行器固定
 *   synthetic（脚本无法冒充供应商真实计量）；
 * - F-005 可选 lifecycle 节（纯数据）：独立操控事件结束（endGate）、最终
 *   结果（gate 挂起 / terminalOverride 词汇外终态注入）、取消接受
 *   （acceptOnly：回执单独接受而不中断运行）与停止证据（gate 延迟 /
 *   unconfirmed 监督边界故障注入表现为未知）；events 子节提供确定性事件
 *   故障（drop 丢失留缺口 / duplicate 原样重投 / reorderAt 相邻乱序），
 *   序号为 1..100_000 有界整数且矛盾组合（同一序号既丢又重等）拒绝；
 *   terminalOverride 必须是词汇外 token（词汇内值不是故障）；
 * - 校验失败抛 StorageError(kind='validation')（装配/测试侧错误），返回值
 *   与输入对象完全分离（调用方后续修改不影响已校验副本）。
 *
 * 实现者：adapters/fake-runtime.ts（真实文件 I/O 与有界异步事件句柄）。
 * 本层不实现任何执行、不导入 fs/SDK/ORM。
 */
import { validateExecutionInputPurpose } from './execution-input.js';
import {
  RUNTIME_EVENT_ROLES,
  RUNTIME_EVENT_TEXT_MAX_LENGTH,
  RUNTIME_EXECUTION_MAX_EVENTS_LIMIT,
  RUNTIME_TERMINAL_STATES,
} from './runtime-execution.js';
import type {
  RuntimeEventRole,
  RuntimeTerminalState,
} from './runtime-execution.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateArtifactLocator,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本与有界常量
 * ------------------------------------------------------------------ */

export const FAKE_RUNTIME_SCRIPT_SCHEMA_VERSION = 1;

/** 脚本序列化（JSON）字节上限。 */
export const FAKE_RUNTIME_SCRIPT_MAX_BYTES = 1_048_576;
/** 脚本步骤数量上限。 */
export const FAKE_RUNTIME_SCRIPT_MAX_STEPS = 256;
/** 单步正文（write_file content）字节上限。 */
export const FAKE_RUNTIME_STEP_BODY_MAX_BYTES = 262_144;
/** 全部步骤正文（write_file content + message text）合计字节上限。 */
export const FAKE_RUNTIME_SCRIPT_TOTAL_BODY_MAX_BYTES = 1_048_576;
/** message 文本上限与事件预览上限一致（文本即预览，不放大）。 */
export const FAKE_RUNTIME_MESSAGE_TEXT_MAX_LENGTH = RUNTIME_EVENT_TEXT_MAX_LENGTH;

/** Fake 用量 basis 固定 synthetic：模拟 token 绝不冒充真实模型消费。 */
export const FAKE_RUNTIME_USAGE_BASIS = 'synthetic' as const;

/* ------------------------------------------------------------------ *
 * 脚本形态（已校验）
 * ------------------------------------------------------------------ */

export const FAKE_RUNTIME_SCRIPT_OPS = [
  'read_input', 'read_file', 'write_file', 'message', 'tool', 'usage', 'fail',
  'tool_command', 'await_gate', 'raise',
] as const;
export type FakeRuntimeScriptOp = (typeof FAKE_RUNTIME_SCRIPT_OPS)[number];

export type FakeRuntimeScriptStep =
  | { readonly op: 'read_input'; readonly purpose: string }
  | { readonly op: 'read_file'; readonly path: string }
  | { readonly op: 'write_file'; readonly path: string; readonly content: string }
  | { readonly op: 'message'; readonly role: RuntimeEventRole; readonly text: string }
  | { readonly op: 'tool'; readonly name: string; readonly exitCode: number | null }
  /** F-004：只引用可信装配批准的命令定义名；argv/环境/超时等在装配侧固定。 */
  | { readonly op: 'tool_command'; readonly name: string }
  | {
      readonly op: 'usage';
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly costUsdMicros: number | null;
    }
  | { readonly op: 'fail'; readonly reason: string }
  /** F-005：挂起在命名门闩上；门闩本体由可信装配注入，脚本只引用名称。 */
  | { readonly op: 'await_gate'; readonly name: string }
  /** F-005：意外异常注入（非受控 fail；执行器折算 internal_error）。 */
  | { readonly op: 'raise'; readonly reason: string };

/* ------------------------------------------------------------------ *
 * F-005 lifecycle：事件结束 / 结果 / 取消接受 / 停止证据独立操控（纯数据）
 * ------------------------------------------------------------------ */

/** 事件故障序号上限（与单次执行事件数量上限一致）。 */
export const FAKE_RUNTIME_EVENT_FAULT_MAX_SEQUENCE = RUNTIME_EXECUTION_MAX_EVENTS_LIMIT;
/** 单一故障序号列表条目上限。 */
export const FAKE_RUNTIME_EVENT_FAULT_MAX_INDEXES = 64;

export interface FakeRuntimeScriptLifecycleEvents {
  /** 不投递的 1 基事件序号（序列照常推进形成缺口，水位含缺口）。 */
  readonly drop?: readonly number[];
  /** 原样重复投递的 1 基事件序号（同 eventId/sequence 再次出现）。 */
  readonly duplicate?: readonly number[];
  /** 相邻乱序：暂存该序号事件，先投递下一事件再投递它。 */
  readonly reorderAt?: number;
  /** 事件通道关闭挂起的门闩名（结果可先于事件结束结算：结果先到）。 */
  readonly endGate?: string;
}

export interface FakeRuntimeScriptLifecycleResult {
  /** 结果结算挂起的门闩名（事件可先结束而结果未结算：事件先结束）。 */
  readonly gate?: string;
  /** 词汇外终态注入（必须是终态词汇之外的 token；会话层 unknown_terminal）。 */
  readonly terminalOverride?: string;
}

export interface FakeRuntimeScriptLifecycleCancel {
  /** 只接受 true：首次取消只返回接受回执，不中断运行、不自动确认停止。 */
  readonly acceptOnly?: true;
}

export interface FakeRuntimeScriptLifecycleStopped {
  /** 停止证据结算挂起的门闩名（释放后才核验实际停止）。 */
  readonly gate?: string;
  /** 只接受 true：监督边界故障注入，stopped 结算 confirmed=false（未知）。 */
  readonly unconfirmed?: true;
}

export interface FakeRuntimeScriptLifecycle {
  readonly events?: FakeRuntimeScriptLifecycleEvents;
  readonly result?: FakeRuntimeScriptLifecycleResult;
  readonly cancel?: FakeRuntimeScriptLifecycleCancel;
  readonly stopped?: FakeRuntimeScriptLifecycleStopped;
}

/** 脚本内 usage 只携带计数；basis 由执行器固定 synthetic。 */
export interface FakeRuntimeScriptUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
}

/** 结束结果声明：终态词汇与 F-001 一致；不存在 Task passed。 */
export interface FakeRuntimeScriptResult {
  readonly terminal: RuntimeTerminalState;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly usage: FakeRuntimeScriptUsage | null;
}

export interface FakeRuntimeScriptV1 {
  readonly schemaVersion: typeof FAKE_RUNTIME_SCRIPT_SCHEMA_VERSION;
  readonly steps: readonly FakeRuntimeScriptStep[];
  readonly result: FakeRuntimeScriptResult;
  /** F-005 可选生命周期故障节（增量扩展；缺席即无故障的 F-003/F-004 行为）。 */
  readonly lifecycle?: FakeRuntimeScriptLifecycle;
}

/** 汇总脚本引用的全部门闩名（await_gate 步骤 + lifecycle 各节；装配期核对）。 */
export function collectFakeRuntimeGateRefs(script: FakeRuntimeScriptV1): readonly string[] {
  const refs = new Set<string>();
  for (const step of script.steps) {
    if (step.op === 'await_gate') refs.add(step.name);
  }
  const lifecycle = script.lifecycle;
  if (lifecycle?.events?.endGate !== undefined) refs.add(lifecycle.events.endGate);
  if (lifecycle?.result?.gate !== undefined) refs.add(lifecycle.result.gate);
  if (lifecycle?.stopped?.gate !== undefined) refs.add(lifecycle.stopped.gate);
  return [...refs];
}

/* ------------------------------------------------------------------ *
 * 校验（纯函数；StorageError validation；返回值与输入分离）
 * ------------------------------------------------------------------ */

const SCRIPT_CONTEXT: ValidationContext = { operation: 'FakeRuntimeScript.validate' };

const REASON_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function reasonToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REASON_TOKEN.test(value)) {
    throw validationError(SCRIPT_CONTEXT, field, '必须是受控原因标识（token 形态）');
  }
  return value;
}

function nullableReasonToken(value: unknown, field: string): string | null {
  if (value === null) return null;
  return reasonToken(value, field);
}

function nullableCount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(SCRIPT_CONTEXT, field, '必须是 null 或非负整数（未知不填 0）');
  }
  return value;
}

function nullableExitCode(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw validationError(SCRIPT_CONTEXT, field, '必须是 null 或 0-255 整数');
  }
  return value;
}

function scriptUsage(value: unknown, field: string): FakeRuntimeScriptUsage {
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['inputTokens', 'outputTokens', 'costUsdMicros'], SCRIPT_CONTEXT, field);
  return {
    inputTokens: nullableCount(raw.inputTokens, `${field}.inputTokens`),
    outputTokens: nullableCount(raw.outputTokens, `${field}.outputTokens`),
    costUsdMicros: nullableCount(raw.costUsdMicros, `${field}.costUsdMicros`),
  };
}

function scriptResult(value: unknown): FakeRuntimeScriptResult {
  const field = 'script.result';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(
    raw,
    ['terminal', 'reason', 'exitCode', 'signal', 'durationMs', 'usage'],
    SCRIPT_CONTEXT,
    field,
  );
  if (typeof raw.terminal !== 'string' ||
      !(RUNTIME_TERMINAL_STATES as readonly string[]).includes(raw.terminal)) {
    throw validationError(SCRIPT_CONTEXT, `${field}.terminal`, 'unknown_terminal');
  }
  return {
    terminal: raw.terminal as RuntimeTerminalState,
    reason: nullableReasonToken(raw.reason, `${field}.reason`),
    exitCode: nullableExitCode(raw.exitCode, `${field}.exitCode`),
    signal: nullableReasonToken(raw.signal, `${field}.signal`),
    durationMs: nullableCount(raw.durationMs, `${field}.durationMs`),
    usage: raw.usage === null ? null : scriptUsage(raw.usage, `${field}.usage`),
  };
}

/** 默认结果：步骤全部完成且未声明结果时 completed/exitCode 0/未知指标 null。 */
export const FAKE_RUNTIME_DEFAULT_RESULT: FakeRuntimeScriptResult = Object.freeze({
  terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: null, usage: null,
});

interface StepAccumulator {
  totalBodyBytes: number;
}

function scriptStep(value: unknown, field: string, acc: StepAccumulator): FakeRuntimeScriptStep {
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  if (typeof raw.op !== 'string' || !(FAKE_RUNTIME_SCRIPT_OPS as readonly string[]).includes(raw.op)) {
    throw validationError(SCRIPT_CONTEXT, `${field}.op`, 'unknown_script_op');
  }
  switch (raw.op) {
    case 'read_input':
      rejectUnknownKeys(raw, ['op', 'purpose'], SCRIPT_CONTEXT, field);
      return { op: 'read_input',
        purpose: validateExecutionInputPurpose(raw.purpose, SCRIPT_CONTEXT, `${field}.purpose`) };
    case 'read_file':
      rejectUnknownKeys(raw, ['op', 'path'], SCRIPT_CONTEXT, field);
      return { op: 'read_file',
        path: validateArtifactLocator(raw.path, SCRIPT_CONTEXT, `${field}.path`) };
    case 'write_file': {
      rejectUnknownKeys(raw, ['op', 'path', 'content'], SCRIPT_CONTEXT, field);
      const path = validateArtifactLocator(raw.path, SCRIPT_CONTEXT, `${field}.path`);
      if (typeof raw.content !== 'string') {
        throw validationError(SCRIPT_CONTEXT, `${field}.content`, '必须是 UTF-8 字符串正文');
      }
      const bytes = Buffer.byteLength(raw.content, 'utf8');
      if (bytes > FAKE_RUNTIME_STEP_BODY_MAX_BYTES) {
        throw validationError(SCRIPT_CONTEXT, `${field}.content`, '超出单步正文上限');
      }
      acc.totalBodyBytes += bytes;
      return { op: 'write_file', path, content: raw.content };
    }
    case 'message': {
      rejectUnknownKeys(raw, ['op', 'role', 'text'], SCRIPT_CONTEXT, field);
      if (typeof raw.role !== 'string' || !(RUNTIME_EVENT_ROLES as readonly string[]).includes(raw.role)) {
        throw validationError(SCRIPT_CONTEXT, `${field}.role`, 'invalid_role');
      }
      if (typeof raw.text !== 'string' || raw.text.length === 0 ||
          raw.text.length > FAKE_RUNTIME_MESSAGE_TEXT_MAX_LENGTH) {
        throw validationError(SCRIPT_CONTEXT, `${field}.text`, '超出消息文本上限（与事件预览一致）');
      }
      acc.totalBodyBytes += Buffer.byteLength(raw.text, 'utf8');
      return { op: 'message', role: raw.role as RuntimeEventRole, text: raw.text };
    }
    case 'tool': {
      rejectUnknownKeys(raw, ['op', 'name', 'exitCode'], SCRIPT_CONTEXT, field);
      return { op: 'tool',
        name: reasonToken(raw.name, `${field}.name`),
        exitCode: nullableExitCode(raw.exitCode, `${field}.exitCode`) };
    }
    case 'tool_command':
      rejectUnknownKeys(raw, ['op', 'name'], SCRIPT_CONTEXT, field);
      return { op: 'tool_command', name: reasonToken(raw.name, `${field}.name`) };
    case 'usage': {
      rejectUnknownKeys(raw, ['op', 'inputTokens', 'outputTokens', 'costUsdMicros'], SCRIPT_CONTEXT, field);
      return { op: 'usage',
        inputTokens: nullableCount(raw.inputTokens, `${field}.inputTokens`),
        outputTokens: nullableCount(raw.outputTokens, `${field}.outputTokens`),
        costUsdMicros: nullableCount(raw.costUsdMicros, `${field}.costUsdMicros`) };
    }
    case 'fail':
      rejectUnknownKeys(raw, ['op', 'reason'], SCRIPT_CONTEXT, field);
      return { op: 'fail', reason: reasonToken(raw.reason, `${field}.reason`) };
    case 'await_gate':
      rejectUnknownKeys(raw, ['op', 'name'], SCRIPT_CONTEXT, field);
      return { op: 'await_gate', name: reasonToken(raw.name, `${field}.name`) };
    case 'raise':
      rejectUnknownKeys(raw, ['op', 'reason'], SCRIPT_CONTEXT, field);
      return { op: 'raise', reason: reasonToken(raw.reason, `${field}.reason`) };
    default:
      throw validationError(SCRIPT_CONTEXT, `${field}.op`, 'unknown_script_op');
  }
}

/* ------------------------------------------------------------------ *
 * F-005 lifecycle 校验（纯函数；严格键白名单与矛盾组合拒绝）
 * ------------------------------------------------------------------ */

function faultSeqIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 1 || value > FAKE_RUNTIME_EVENT_FAULT_MAX_SEQUENCE) {
    throw validationError(SCRIPT_CONTEXT, field, '必须是有界 1 基事件序号');
  }
  return value;
}

function faultSeqIndexList(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length > FAKE_RUNTIME_EVENT_FAULT_MAX_INDEXES) {
    throw validationError(SCRIPT_CONTEXT, field, '必须是有界序号数组');
  }
  const list = value.map((entry, index) => faultSeqIndex(entry, `${field}[${index}]`));
  if (new Set(list).size !== list.length) {
    throw validationError(SCRIPT_CONTEXT, field, '不允许重复序号');
  }
  return list;
}

function lifecycleEvents(value: unknown): FakeRuntimeScriptLifecycleEvents {
  const field = 'script.lifecycle.events';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['drop', 'duplicate', 'reorderAt', 'endGate'], SCRIPT_CONTEXT, field);
  const drop = raw.drop === undefined
    ? undefined : faultSeqIndexList(raw.drop, `${field}.drop`);
  const duplicate = raw.duplicate === undefined
    ? undefined : faultSeqIndexList(raw.duplicate, `${field}.duplicate`);
  const reorderAt = raw.reorderAt === undefined
    ? undefined : faultSeqIndex(raw.reorderAt, `${field}.reorderAt`);
  const dropped = new Set(drop ?? []);
  const duplicated = new Set(duplicate ?? []);
  for (const entry of dropped) {
    if (duplicated.has(entry)) {
      throw validationError(SCRIPT_CONTEXT, field, '同一序号不能既丢失又重复');
    }
  }
  if (reorderAt !== undefined && (dropped.has(reorderAt) || duplicated.has(reorderAt))) {
    throw validationError(SCRIPT_CONTEXT, `${field}.reorderAt`, '乱序序号不能同时丢失或重复');
  }
  return {
    ...(drop === undefined ? {} : { drop }),
    ...(duplicate === undefined ? {} : { duplicate }),
    ...(reorderAt === undefined ? {} : { reorderAt }),
    ...(raw.endGate === undefined ? {} : { endGate: reasonToken(raw.endGate, `${field}.endGate`) }),
  };
}

function lifecycleResult(value: unknown): FakeRuntimeScriptLifecycleResult {
  const field = 'script.lifecycle.result';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['gate', 'terminalOverride'], SCRIPT_CONTEXT, field);
  const terminalOverride = raw.terminalOverride === undefined
    ? undefined : reasonToken(raw.terminalOverride, `${field}.terminalOverride`);
  if (terminalOverride !== undefined &&
      (RUNTIME_TERMINAL_STATES as readonly string[]).includes(terminalOverride)) {
    throw validationError(SCRIPT_CONTEXT, `${field}.terminalOverride`, '必须是词汇外终态');
  }
  return {
    ...(raw.gate === undefined ? {} : { gate: reasonToken(raw.gate, `${field}.gate`) }),
    ...(terminalOverride === undefined ? {} : { terminalOverride }),
  };
}

function lifecycleCancel(value: unknown): FakeRuntimeScriptLifecycleCancel {
  const field = 'script.lifecycle.cancel';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['acceptOnly'], SCRIPT_CONTEXT, field);
  if (raw.acceptOnly !== undefined && raw.acceptOnly !== true) {
    throw validationError(SCRIPT_CONTEXT, `${field}.acceptOnly`, '只接受 true（false 无意义）');
  }
  return raw.acceptOnly === true ? { acceptOnly: true } : {};
}

function lifecycleStopped(value: unknown): FakeRuntimeScriptLifecycleStopped {
  const field = 'script.lifecycle.stopped';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['gate', 'unconfirmed'], SCRIPT_CONTEXT, field);
  if (raw.unconfirmed !== undefined && raw.unconfirmed !== true) {
    throw validationError(SCRIPT_CONTEXT, `${field}.unconfirmed`, '只接受 true（false 无意义）');
  }
  return {
    ...(raw.gate === undefined ? {} : { gate: reasonToken(raw.gate, `${field}.gate`) }),
    ...(raw.unconfirmed === true ? { unconfirmed: true } : {}),
  };
}

function scriptLifecycle(value: unknown): FakeRuntimeScriptLifecycle {
  const field = 'script.lifecycle';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['events', 'result', 'cancel', 'stopped'], SCRIPT_CONTEXT, field);
  return {
    ...(raw.events === undefined ? {} : { events: lifecycleEvents(raw.events) }),
    ...(raw.result === undefined ? {} : { result: lifecycleResult(raw.result) }),
    ...(raw.cancel === undefined ? {} : { cancel: lifecycleCancel(raw.cancel) }),
    ...(raw.stopped === undefined ? {} : { stopped: lifecycleStopped(raw.stopped) }),
  };
}

/**
 * 脚本校验：只接受可信装配注入的纯数据对象；字符串/模块说明符/函数/数组
 * 一律拒绝（脚本永不从 Host 请求、项目配置或任意用户文件加载执行）。
 */
export function validateFakeRuntimeScript(value: unknown): FakeRuntimeScriptV1 {
  const field = 'script';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['schemaVersion', 'steps', 'result', 'lifecycle'], SCRIPT_CONTEXT, field);
  if (raw.schemaVersion !== FAKE_RUNTIME_SCRIPT_SCHEMA_VERSION) {
    throw validationError(SCRIPT_CONTEXT, `${field}.schemaVersion`, 'unsupported_schema_version');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length > FAKE_RUNTIME_SCRIPT_MAX_STEPS) {
    throw validationError(SCRIPT_CONTEXT, `${field}.steps`, '必须是有界步骤数组');
  }
  const acc: StepAccumulator = { totalBodyBytes: 0 };
  const steps = raw.steps.map((step, index) => scriptStep(step, `${field}.steps[${index}]`, acc));
  if (acc.totalBodyBytes > FAKE_RUNTIME_SCRIPT_TOTAL_BODY_MAX_BYTES) {
    throw validationError(SCRIPT_CONTEXT, `${field}.steps`, '超出脚本总正文上限');
  }
  const result = raw.result === undefined ? { ...FAKE_RUNTIME_DEFAULT_RESULT } : scriptResult(raw.result);
  const lifecycle = raw.lifecycle === undefined ? undefined : scriptLifecycle(raw.lifecycle);
  let serialized: string;
  try {
    serialized = JSON.stringify({
      schemaVersion: 1, steps, result,
      ...(lifecycle === undefined ? {} : { lifecycle }),
    });
  } catch (error) {
    throw validationError(SCRIPT_CONTEXT, field, '脚本必须可序列化为 JSON', error);
  }
  if (Buffer.byteLength(serialized, 'utf8') > FAKE_RUNTIME_SCRIPT_MAX_BYTES) {
    throw validationError(SCRIPT_CONTEXT, field, '超出脚本长度上限');
  }
  return {
    schemaVersion: FAKE_RUNTIME_SCRIPT_SCHEMA_VERSION, steps, result,
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}
