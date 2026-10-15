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
 * - 步骤词汇固定八种：read_input（读取获准输入）/ read_file / write_file
 *   （真实读写 workspace 相对位置）/ message / tool（关联消息与工具事件）/
 *   usage（synthetic 用量事件）/ fail（受控失败注入）/ tool_command（F-004
 *   受控真实工具命令：只以名称引用可信装配批准的命令定义，脚本绝不携带
 *   argv/环境/shell 等可执行内容）；未知操作一律拒绝；
 * - 工作区路径复用 validateArtifactLocator 的 POSIX 相对位置规则（拒绝
 *   绝对路径、反斜杠、. 与 .. 段、NUL），词法越界在脚本校验期即拒绝；
 * - 有界性：脚本序列化字节、步骤数量、单步正文（write_file content）与
 *   全部正文合计全部显式有限；message 文本受事件预览上限约束（≤200），
 *   超长脚本无法进入执行器；
 * - 结果声明使用 F-001 终态词汇（completed/failed/cancelled/timed_out，
 *   不存在 passed——Task 验收是 Core 职责）；退出码/信号/耗时/用量未知
 *   必须为显式 null；脚本内 usage 只提供计数，basis 由执行器固定
 *   synthetic（脚本无法冒充供应商真实计量）；
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
  'tool_command',
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
  | { readonly op: 'fail'; readonly reason: string };

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
    default:
      throw validationError(SCRIPT_CONTEXT, `${field}.op`, 'unknown_script_op');
  }
}

/**
 * 脚本校验：只接受可信装配注入的纯数据对象；字符串/模块说明符/函数/数组
 * 一律拒绝（脚本永不从 Host 请求、项目配置或任意用户文件加载执行）。
 */
export function validateFakeRuntimeScript(value: unknown): FakeRuntimeScriptV1 {
  const field = 'script';
  const raw = requirePlainObject(value, SCRIPT_CONTEXT, field);
  rejectUnknownKeys(raw, ['schemaVersion', 'steps', 'result'], SCRIPT_CONTEXT, field);
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
  let serialized: string;
  try {
    serialized = JSON.stringify({ schemaVersion: 1, steps, result });
  } catch (error) {
    throw validationError(SCRIPT_CONTEXT, field, '脚本必须可序列化为 JSON', error);
  }
  if (Buffer.byteLength(serialized, 'utf8') > FAKE_RUNTIME_SCRIPT_MAX_BYTES) {
    throw validationError(SCRIPT_CONTEXT, field, '超出脚本长度上限');
  }
  return { schemaVersion: FAKE_RUNTIME_SCRIPT_SCHEMA_VERSION, steps, result };
}
