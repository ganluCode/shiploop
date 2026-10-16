/**
 * P03-6 / F-003 确定性 FakeRuntime 文件执行器（adapters 层：真实临时
 * workspace 文件 I/O 与有界异步事件句柄；无 SDK/网络/登录/模型）。
 *
 * 设计依据：input/p03-fake-runtime.md FR-2（FakeRuntime 只替代模型决策，
 * 文件真实执行；校验必需输入及权限；不打开业务库、不自行设 passed；不同
 * Task 独立上下文）与 task F-003 验收五条。
 *
 * 不变量：
 * - 脚本只来自可信测试装配注入的纯数据对象（构造时经
 *   validateFakeRuntimeScript 终验）；本模块没有任何从 Host 请求、项目
 *   配置、文件路径或模块说明符加载脚本的入口；
 * - 每次 start 创建独立的运行现场（事件通道、op log、输出计数、取消
 *   信号都是闭包内新对象）；适配器实例只持有不可变脚本与已 realpath
 *   的工作区根白名单——不同 Task/Attempt 不共享任何可变状态；
 * - 事件关联：eventId/messageId/toolCallId 全部由关联 token 派生
 *   （SHA-256(sessionId, attemptId, executionVersion, invocationId) 截断
 *   24 hex），调用方可凭请求身份独立重算核验；序列从 1 严格递增，时间
 *   来自注入时钟的 UTC ISO；
 * - 有界异步通道：事件缓冲按数量与字节双上限，生产者（脚本循环）在缓冲
 *   满时 await 背压；消费者停滞不会无限积累正文；cancel 关闭通道并解除
 *   等待中的生产者与消费者，结算 cancelled 结果（幂等、只结算一次）；
 * - 输出预算：事件字节与 write_file 正文字节合计计入
 *   request.limits.maxOutputBytes，超限在相应操作之前失败
 *   （output_limit_exceeded），不截断、不换成功；
 * - 文件安全三层防线（沿用 F-010/input-source-files 模式）：脚本校验期
 *   词法拒绝越界；操作前 realpath 最近现存祖先必须位于已 realpath 的
 *   获准根内（符号链接祖先逃逸 → path_escape）；叶子 lstat 符号链接一律
 *   拒绝（symlink_escape）；只读目标按 mode 位预检拒绝（write_denied，
 *   不依赖 euid）；父目录缺失 parent_missing、文件缺失 file_missing。
 *   检查与操作之间的并发替换窗口由「单写入者 + 可信项目」前提收窄，
 *   本适配器不宣称强 OS 沙箱；
 * - Fake 不接触 Core 状态库（不导入 SQLite/ORM/状态存取模块）、不决定
 *   Task 验收（结果终态词汇无 passed）、不执行 shell/模块/任意命令；
 * - F-004 受控真实工具命令步骤（tool_command）：脚本步骤只以名称引用可信
 *   装配批准的命令定义（argv/白名单环境/stdin/有限超时与输入输出上限在
 *   装配侧校验并快照固定，脚本绝不携带可执行内容）；进程启动复用注入的
 *   CommandProcess 端口（不新建进程监督系统、不 import child_process），
 *   launchId/PID/PGID/OS 启动身份经 Core 回调提交后才由既有握手放行命令，
 *   提交失败命令不执行且运行受控失败；工具输出以滚动摘要并行有界消费
 *   （不累积全文），tool_finished 事件如实携带 toolCallId、退出码/信号、
 *   实际原因、已知保留输出字节与最后活动时间；Runtime stopped 只有在脚
 *   本步骤结束且所有登记受控工具进程组核验停止后才 confirmed——父退子活、
 *   身份核验失败与进程监督丢失均报告 confirmed=false；cancel 向活动工具
 *   句柄传播，走既有身份匹配升级终止路径；
 * - 用量：脚本声明的计数一律以 basis 'synthetic' 发出；未知计数为 null；
 *   durationMs 不测量真实时钟（取脚本声明或 null），保证同脚本同输入
 *   产生可核对的同一操作顺序与同一事件序列。
 * - F-005 可控故障与生命周期脚本（全部纯数据声明 + 装配注入门闩，无随机
 *   睡眠）：
 *   · await_gate 步骤挂起在命名门闩上，取消有界中断等待（acceptOnly 模式
 *     下取消不中断，由门闩释放收尾）；raise 步骤注入意外异常（折算
 *     internal_error，区别于受控 fail）；
 *   · startFailure 装配选项使 start 按受控 kind/reason 抛出（启动抛错）；
 *   · lifecycle.events：drop 丢失留序列缺口（水位照常推进）、duplicate
 *     原样重投同 eventId/sequence、reorderAt 相邻乱序、endGate 延迟通道
 *     关闭（结果先到）；
 *   · lifecycle.result：gate 延迟结果结算（事件先结束；通道先关闭再挂起
 *     结果）、terminalOverride 产出词汇外终态（会话层 unknown_terminal）；
 *   · lifecycle.cancel.acceptOnly：首次取消只返回接受回执而不中断运行/
 *     确认停止（再次取消走真实取消语义）；
 *   · lifecycle.stopped：gate 延迟停止证据结算（释放后才聚合真实受控组
 *     核验结果，不以预设布尔冒充进程已退出）、unconfirmed 注入监督边界
 *     故障（confirmed=false + stop_verification_fault，如实表现为未知）；
 *   · 请求携带非 new 恢复选择时首事件为 diagnostic fake_fresh_execution，
 *     如实声明确定性全新执行，不冒充 SDK 检查点/对话续接验收；
 *   · 门闩仅由可信装配经 gates 选项注入（脚本引用的名称在装配期核对），
 *     无远端/环境/文件触发入口。
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, realpathSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CommandProcessError } from '../ports/command-process.js';
import type {
  CommandProcessHandle,
  CommandProcessIdentity,
  CommandProcessPort,
  CommandProcessStop,
} from '../ports/command-process.js';
import {
  isExecutionInputBindingError,
} from '../ports/execution-input-binding.js';
import type { BoundExecutionInputReader } from '../ports/execution-input-binding.js';
import { validateFakeRuntimeScript, collectFakeRuntimeGateRefs } from '../ports/fake-runtime-script.js';
import type {
  FakeRuntimeScriptStep,
  FakeRuntimeScriptV1,
} from '../ports/fake-runtime-script.js';
import type { ProviderCapabilityDescriptor } from '../ports/runtime-capabilities.js';
import { RuntimeError, RUNTIME_ERROR_KINDS } from '../ports/runtime-execution.js';
import type {
  RuntimeAdapter,
  RuntimeErrorKind,
  RuntimeTerminalState,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeHandle,
  RuntimeStopEvidence,
} from '../ports/runtime-execution.js';
import { RUNTIME_ADAPTER_CONTRACT_VERSION } from '../ports/runtime-registry.js';
import type { RuntimeAdapterDescriptor } from '../ports/runtime-registry.js';
import { TRUSTED_PROJECT_ISOLATION } from '../ports/settings-schema.js';
import { requireSafeRecordKey } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

const OPERATION = 'FakeRuntime';

/** 稳定 runtime ID（与可信配置目录/注册描述符一致）。 */
export const FAKE_RUNTIME_ID = 'fake';

/** 事件缓冲硬上限（装配只能收窄，不能放宽）。 */
export const FAKE_RUNTIME_BUFFER_MAX_EVENTS_CAP = 1_024;
export const FAKE_RUNTIME_BUFFER_MAX_BYTES_CAP = 1_048_576;
const DEFAULT_BUFFER_MAX_EVENTS = 64;
const DEFAULT_BUFFER_MAX_BYTES = 262_144;

/** read_file 单文件读取字节上限（超限在读取前拒绝）。 */
export const FAKE_RUNTIME_READ_FILE_MAX_BYTES = 1_048_576;

/** 受控运行失败原因词汇（result.reason / op log 使用）。 */
export const FAKE_RUNTIME_FAILURE_REASONS = [
  'input_reader_missing', 'input_missing', 'unbound_input_read', 'input_read_failed',
  'file_missing', 'file_too_large', 'not_regular_file', 'read_denied',
  'parent_missing', 'target_is_directory', 'write_denied',
  'path_escape', 'symlink_escape', 'output_limit_exceeded',
  'tool_identity_commit_failed', 'tool_launch_failed', 'tool_stop_unconfirmed',
  'internal_error',
  /* F-005：await_gate 被取消中断的 op log 原因（不作为 result.reason）。 */
  'cancelled',
] as const;

/* ------------------------------------------------------------------ *
 * F-005 测试专用门闩与启动故障装配选项
 * ------------------------------------------------------------------ */

/**
 * 测试专用门闩：释放前 wait() 挂起；release() 幂等。只由可信测试装配经
 * gates 选项注入，脚本以名称引用——无任何远端/环境/文件触发入口。
 */
export interface FakeRuntimeGate {
  wait(): Promise<void>;
  readonly released: boolean;
}

export interface FakeRuntimeGateControl extends FakeRuntimeGate {
  release(): void;
}

export function createFakeRuntimeGate(): FakeRuntimeGateControl {
  let released = false;
  let wake!: () => void;
  const promise = new Promise<void>((resolve) => { wake = resolve; });
  return {
    get released() { return released; },
    wait: () => promise,
    release: () => {
      if (released) return;
      released = true;
      wake();
    },
  };
}

/** F-005 启动抛错注入：start 按受控 kind/reason 抛 RuntimeError。 */
export interface FakeRuntimeStartFailure {
  readonly kind: RuntimeErrorKind;
  readonly reason: string;
}

/** F-004：tool_command 步骤引用的可信装配批准命令定义（装配侧校验并快照）。 */
export interface FakeRuntimeToolCommandDefinition {
  /** 字面 argv（绝不拼接 shell；首元素为可执行文件）。 */
  readonly argv: readonly string[];
  /** 白名单环境（只含批准值，绝不继承 Host 环境）。 */
  readonly environment?: Readonly<Record<string, string>>;
  /** 有限标准输入字节。 */
  readonly stdin?: Uint8Array;
  /** 有限工具超时（毫秒；1..3_600_000）。 */
  readonly timeoutMs: number;
  /** 序列化启动输入 + stdin 上限（默认 65_536）。 */
  readonly maxInputBytes?: number;
  /** 合并 stdout/stderr 保留上限（默认 1_048_576，上限 8_388_608）。 */
  readonly maxOutputBytes?: number;
}

/** F-004：身份提交回调上下文——工具调用与当前 Attempt 关联。 */
export interface FakeRuntimeToolLaunchContext {
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly attemptId: string | undefined;
}

/**
 * F-004：Core 身份提交回调。launchId/PID/PGID/OS 启动身份先经本回调提交到
 * 当前 Attempt/占用，返回匹配 launchId 才放行命令；回调拒绝/超时/返回不符
 * 即 confirmation_failed，命令不执行。Runtime 本身不打开 SQLite。
 */
export type FakeRuntimeCommitCommandIdentity = (
  identity: CommandProcessIdentity,
  context: FakeRuntimeToolLaunchContext,
) => Promise<{ readonly launchId: string }>;

/** F-004 工具命令定义的有界常量（与 CommandProcess 端口冻结上限一致）。 */
export const FAKE_RUNTIME_TOOL_TIMEOUT_MS_MAX = 3_600_000;
export const FAKE_RUNTIME_TOOL_MAX_INPUT_BYTES = 65_536;
export const FAKE_RUNTIME_TOOL_MAX_OUTPUT_BYTES_CAP = 8_388_608;
export const FAKE_RUNTIME_TOOL_DEFAULT_OUTPUT_BYTES = 1_048_576;
const TOOL_ARGV_MAX_ITEMS = 256;
const TOOL_ENV_MAX_ENTRIES = 64;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 单条操作记录（无时间戳：同脚本同输入两次运行可逐条全等核对）。 */
export interface FakeRuntimeOpRecord {
  readonly index: number;
  readonly op: string;
  /** 操作目标：用途 / 工作区相对路径 / 工具名（脱敏，绝无绝对路径）。 */
  readonly target: string;
  readonly outcome: 'ok' | 'failed';
  readonly reason: string | null;
  readonly bytes: number | null;
  readonly digest: string | null;
  /** F-004 tool_command 记录：工具调用关联与真实结果。 */
  readonly toolCallId?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly lastActivityAtUtc?: string | null;
  readonly droppedOutputBytes?: number;
  readonly stopConfirmed?: boolean;
}

/** 事件缓冲高水位（背压验证证据）。 */
export interface FakeRuntimeBufferHighWater {
  readonly events: number;
  readonly bytes: number;
}

/** Fake 句柄：F-001 契约句柄 + 测试检查面（op log 与缓冲高水位）。 */
export interface FakeRuntimeHandle extends RuntimeHandle {
  readonly inspection: {
    readonly opLog: () => readonly FakeRuntimeOpRecord[];
    readonly highWater: () => FakeRuntimeBufferHighWater;
  };
}

export interface FakeRuntimeAssembly {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly adapter: RuntimeAdapter;
}

export interface FakeRuntimeOptions {
  /** 可信测试装配注入的声明式脚本（纯数据对象；构造时终验）。 */
  readonly script: unknown;
  /** 获准工作区根白名单：rootId → 绝对路径（构造时 realpath 固定）。 */
  readonly workspaceRoots: Readonly<Record<string, string>>;
  /** 描述符 provider/model 面（必须与可信配置目录一致）。 */
  readonly providers: readonly ProviderCapabilityDescriptor[];
  /** 受限输入读取能力：实例或按请求解析；缺失时 read_input 显式失败。 */
  readonly reader?: BoundExecutionInputReader |
    ((request: RuntimeExecutionRequest) => BoundExecutionInputReader | undefined);
  readonly adapterVersion?: string;
  /** 注入时钟（UTC epoch ms）；缺省 Date.now。 */
  readonly nowUtcMs?: () => number;
  /** 事件缓冲上限（只能收窄硬上限）。 */
  readonly buffer?: { readonly maxEvents?: number; readonly maxBytes?: number };
  /**
   * F-004：可信装配批准的命令定义（名称 → 定义）。脚本 tool_command 步骤
   * 只能引用此处批准的名称；定义在装配时逐项校验并快照，调用方事后篡改
   * 不影响已批准内容。
   */
  readonly toolCommands?: Readonly<Record<string, FakeRuntimeToolCommandDefinition>>;
  /** F-004：既有 CommandProcess 端口（注入复用；脚本含 tool_command 时必需）。 */
  readonly commandProcess?: CommandProcessPort;
  /** F-004：Core 身份提交回调（脚本含 tool_command 时必需）。 */
  readonly commitCommandIdentity?: FakeRuntimeCommitCommandIdentity;
  /**
   * F-005：可信测试装配注入的命名门闩。脚本经 await_gate 步骤与 lifecycle
   * 的 endGate/result.gate/stopped.gate 以名称引用；脚本引用未装配名称在
   * 装配期 fail-fast。
   */
  readonly gates?: Readonly<Record<string, FakeRuntimeGate>>;
  /** F-005：启动抛错注入（start 按受控 kind/reason 拒绝）。 */
  readonly startFailure?: FakeRuntimeStartFailure;
}

/**
 * 事件关联 token：SHA-256(sessionId, attemptId, executionVersion,
 * invocationId) 截断 24 hex。事件/消息/工具标识全部由它派生，调用方凭
 * 请求身份独立重算即可核验事件归属本次 Session/Attempt/执行代次。
 */
export function fakeRuntimeCorrelationToken(request: {
  readonly sessionId: string;
  readonly identity: { readonly purpose: string; readonly attemptId?: string };
  readonly executionVersion: number;
  readonly invocationId: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([
      request.sessionId, request.identity.attemptId,
      request.executionVersion, request.invocationId,
    ]))
    .digest('hex')
    .slice(0, 24);
}

/* ------------------------------------------------------------------ *
 * 有界异步事件通道（数量/字节双上限 + 背压 + 关闭唤醒）
 * ------------------------------------------------------------------ */

/** 适配器线形事件：payload 不携带 kind（外层 kind 判别；会话层校验拒绝冗余键）。 */
type WireRuntimeEvent = Omit<RuntimeEvent, 'payload'> & { readonly payload: Record<string, unknown> };

interface BoundedChannel {
  /** 生产者：缓冲满时 await 背压；返回 false 表示通道已关闭（取消）。 */
  push(value: WireRuntimeEvent, bytes: number): Promise<boolean>;
  /** 尽力非阻塞入队（失败路径诊断；满/关闭即丢弃）。 */
  tryPush(value: WireRuntimeEvent, bytes: number): boolean;
  close(): void;
  iterable(): AsyncIterable<unknown>;
  highWater(): FakeRuntimeBufferHighWater;
}

function createBoundedChannel(maxEvents: number, maxBytes: number): BoundedChannel {
  const items: WireRuntimeEvent[] = [];
  const sizes: number[] = [];
  let bytesUsed = 0;
  let closed = false;
  let highEvents = 0;
  let highBytes = 0;
  const producerWaiters: Array<() => void> = [];
  const consumerWaiters: Array<() => void> = [];
  const wakeProducers = (): void => { for (const wake of producerWaiters.splice(0)) wake(); };
  const wakeConsumers = (): void => { for (const wake of consumerWaiters.splice(0)) wake(); };
  return {
    async push(value: RuntimeEvent, bytes: number): Promise<boolean> {
      while (!closed && (items.length >= maxEvents || bytesUsed + bytes > maxBytes)) {
        await new Promise<void>((resolve) => producerWaiters.push(resolve));
      }
      if (closed) return false;
      items.push(value);
      sizes.push(bytes);
      bytesUsed += bytes;
      if (items.length > highEvents) highEvents = items.length;
      if (bytesUsed > highBytes) highBytes = bytesUsed;
      wakeConsumers();
      return true;
    },
    tryPush(value: RuntimeEvent, bytes: number): boolean {
      if (closed || items.length >= maxEvents || bytesUsed + bytes > maxBytes) return false;
      items.push(value);
      sizes.push(bytes);
      bytesUsed += bytes;
      if (items.length > highEvents) highEvents = items.length;
      if (bytesUsed > highBytes) highBytes = bytesUsed;
      wakeConsumers();
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      wakeProducers();
      wakeConsumers();
    },
    iterable(): AsyncIterable<unknown> {
      let consumed = false;
      return {
        [Symbol.asyncIterator]() {
          if (consumed) throw new RuntimeError('protocol', 'events_already_consumed');
          consumed = true;
          const next = async (): Promise<IteratorResult<unknown>> => {
            while (items.length === 0 && !closed) {
              await new Promise<void>((resolve) => consumerWaiters.push(resolve));
            }
            if (items.length === 0) return { value: undefined, done: true };
            const value = items.shift() as WireRuntimeEvent;
            bytesUsed -= sizes.shift() as number;
            wakeProducers();
            return { value, done: false };
          };
          return { next };
        },
      };
    },
    highWater(): FakeRuntimeBufferHighWater {
      return { events: highEvents, bytes: highBytes };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 文件目标解析（三层防线：词法 → realpath 祖先 → 叶子 lstat）
 * ------------------------------------------------------------------ */

type FsFailureReason =
  | 'path_escape' | 'symlink_escape' | 'file_missing' | 'file_too_large'
  | 'not_regular_file' | 'read_denied' | 'parent_missing'
  | 'target_is_directory' | 'write_denied';

class FsFailure extends Error {
  readonly failureReason: FsFailureReason;
  constructor(reason: FsFailureReason) {
    super(reason);
    this.name = 'FsFailure';
    this.failureReason = reason;
  }
}

function insideRoot(realRoot: string, candidate: string): boolean {
  const suffix = relative(realRoot, candidate);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

/** 写目标预检：父目录必须存在且在根内；叶子符号链接/目录/只读在写入前拒绝。 */
function resolveWriteTarget(realRoot: string, base: string, rel: string): string {
  const target = join(base, rel);
  if (!insideRoot(realRoot, target)) throw new FsFailure('path_escape');
  const parent = dirname(target);
  if (!existsSync(parent)) throw new FsFailure('parent_missing');
  if (!insideRoot(realRoot, realpathSync(parent))) throw new FsFailure('path_escape');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new FsFailure('symlink_escape');
    if (!insideRoot(realRoot, realpathSync(target))) throw new FsFailure('path_escape');
    if (stat.isDirectory()) throw new FsFailure('target_is_directory');
    // 按 mode 位预检写权限（不依赖 euid：root 运行同样确定性拒绝）。
    if ((stat.mode & 0o222) === 0) throw new FsFailure('write_denied');
  }
  return target;
}

/** 读目标预检：存在性、叶子符号链接、常规文件、realpath 归属与大小上限。 */
function resolveReadTarget(realRoot: string, base: string, rel: string): string {
  const target = join(base, rel);
  if (!insideRoot(realRoot, target)) throw new FsFailure('path_escape');
  if (!existsSync(target)) throw new FsFailure('file_missing');
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new FsFailure('symlink_escape');
  if (!insideRoot(realRoot, realpathSync(target))) throw new FsFailure('path_escape');
  if (!stat.isFile()) throw new FsFailure('not_regular_file');
  if ((stat.mode & 0o444) === 0) throw new FsFailure('read_denied');
  if (stat.size > FAKE_RUNTIME_READ_FILE_MAX_BYTES) throw new FsFailure('file_too_large');
  return target;
}

/* ------------------------------------------------------------------ *
 * F-004 批准命令定义校验（装配期 fail-fast；返回值与输入快照分离）
 * ------------------------------------------------------------------ */

interface ValidatedToolCommandDefinition {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Uint8Array | undefined;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

function validateToolCommandDefinition(
  name: string,
  value: unknown,
): ValidatedToolCommandDefinition {
  const bad = (detail: string): never => {
    throw new TypeError(`FakeRuntime.create: toolCommands.${name} ${detail}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('必须是对象');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['argv', 'environment', 'stdin', 'timeoutMs', 'maxInputBytes', 'maxOutputBytes'].includes(key)) {
      bad(`未知键 ${key}`);
    }
  }
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > TOOL_ARGV_MAX_ITEMS ||
      argv.some((item) => typeof item !== 'string' || item.includes('\0')) ||
      (argv[0] as string).length === 0) {
    bad('argv 必须是 1..256 个无 NUL 字符串且首元素非空');
  }
  const environment: Record<string, string> = {};
  if (raw.environment !== undefined) {
    if (raw.environment === null || typeof raw.environment !== 'object' || Array.isArray(raw.environment)) {
      bad('environment 必须是白名单键值对象');
    }
    const entries = Object.entries(raw.environment as Record<string, unknown>);
    if (entries.length > TOOL_ENV_MAX_ENTRIES) bad('environment 超出条目上限');
    for (const [key, envValue] of entries) {
      if (!ENV_KEY_PATTERN.test(key)) bad('environment 键非法');
      if (typeof envValue !== 'string' || envValue.includes('\0')) bad('environment 值非法');
      environment[key] = envValue as string;
    }
  }
  if (raw.stdin !== undefined && !(raw.stdin instanceof Uint8Array)) bad('stdin 必须是 Uint8Array');
  const timeoutMs = raw.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 ||
      (timeoutMs as number) > FAKE_RUNTIME_TOOL_TIMEOUT_MS_MAX) {
    bad('timeoutMs 必须是有限工具超时');
  }
  const maxInputBytes = raw.maxInputBytes ?? FAKE_RUNTIME_TOOL_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || (maxInputBytes as number) < 1 ||
      (maxInputBytes as number) > FAKE_RUNTIME_TOOL_MAX_INPUT_BYTES) {
    bad('maxInputBytes 超出有界输入上限');
  }
  const maxOutputBytes = raw.maxOutputBytes ?? FAKE_RUNTIME_TOOL_DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || (maxOutputBytes as number) < 1 ||
      (maxOutputBytes as number) > FAKE_RUNTIME_TOOL_MAX_OUTPUT_BYTES_CAP) {
    bad('maxOutputBytes 超出有界输出上限');
  }
  return Object.freeze({
    argv: Object.freeze([...(argv as string[])]),
    environment: Object.freeze(environment),
    stdin: raw.stdin === undefined ? undefined : new Uint8Array(raw.stdin as Uint8Array),
    timeoutMs: timeoutMs as number,
    maxInputBytes: maxInputBytes as number,
    maxOutputBytes: maxOutputBytes as number,
  });
}

/* ------------------------------------------------------------------ *
 * 运行循环
 * ------------------------------------------------------------------ */

class FailRun extends Error {
  readonly failReason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'FailRun';
    this.failReason = reason;
  }
}

/** 通道关闭（取消）中断信号。 */
class ChannelClosed extends Error {
  constructor() {
    super('channel_closed');
    this.name = 'ChannelClosed';
  }
}

function mapInputReadError(error: unknown): string {
  if (isExecutionInputBindingError(error)) {
    if (error.reason === 'input_missing' || error.reason === 'input_not_ready') return 'input_missing';
    if (error.reason === 'unbound_input_read') return 'unbound_input_read';
  }
  return 'input_read_failed';
}

/**
 * 装配确定性 FakeRuntime：返回可直接交给 createStaticRuntimeRegistry 的
 * { descriptor, adapter }。import 本模块无副作用；构造只做脚本终验与
 * 工作区根 realpath 固定，不创建任何目录或文件。
 */
export function createFakeRuntime(options: FakeRuntimeOptions): FakeRuntimeAssembly {
  const script: FakeRuntimeScriptV1 = validateFakeRuntimeScript(options.script);
  const assemblyContext: ValidationContext = { operation: `${OPERATION}.create` };
  if (!Array.isArray(options.providers) || options.providers.length === 0) {
    throw new TypeError('FakeRuntime.create: providers 必须是非空能力描述数组');
  }
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const bufferMaxEvents = options.buffer?.maxEvents ?? DEFAULT_BUFFER_MAX_EVENTS;
  const bufferMaxBytes = options.buffer?.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES;
  if (!Number.isSafeInteger(bufferMaxEvents) || bufferMaxEvents < 1 ||
      bufferMaxEvents > FAKE_RUNTIME_BUFFER_MAX_EVENTS_CAP ||
      !Number.isSafeInteger(bufferMaxBytes) || bufferMaxBytes < 1 ||
      bufferMaxBytes > FAKE_RUNTIME_BUFFER_MAX_BYTES_CAP) {
    throw new TypeError('FakeRuntime.create: buffer 上限必须是收窄硬上限内的正整数');
  }
  const canonicalRoots = new Map<string, string>();
  for (const [rootId, rootPath] of Object.entries(options.workspaceRoots ?? {})) {
    requireSafeRecordKey(rootId, assemblyContext, `workspaceRoots.${rootId}`);
    if (typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
      throw new TypeError('FakeRuntime.create: workspaceRoots 必须是 rootId → 绝对路径');
    }
    const real = realpathSync(rootPath);
    if (!lstatSync(real).isDirectory()) {
      throw new TypeError('FakeRuntime.create: workspaceRoots 必须指向已存在目录');
    }
    canonicalRoots.set(rootId, real);
  }

  /* F-004：批准命令定义装配期终验与快照；脚本含 tool_command 时必须装配
   * CommandProcess 端口与 Core 身份提交回调（缺任何一项即装配错误）。 */
  const toolCommandDefinitions = new Map<string, ValidatedToolCommandDefinition>();
  for (const [name, definition] of Object.entries(options.toolCommands ?? {})) {
    requireSafeRecordKey(name, assemblyContext, `toolCommands.${name}`);
    toolCommandDefinitions.set(name, validateToolCommandDefinition(name, definition));
  }
  const referencedToolCommands = new Set(
    script.steps.filter((step) => step.op === 'tool_command').map((step) => step.name),
  );
  if (referencedToolCommands.size > 0) {
    const port = options.commandProcess;
    if (port === null || typeof port !== 'object' || typeof port.start !== 'function') {
      throw new TypeError('FakeRuntime.create: 脚本含 tool_command 时必须注入 CommandProcess 端口');
    }
    if (typeof options.commitCommandIdentity !== 'function') {
      throw new TypeError('FakeRuntime.create: 脚本含 tool_command 时必须注入 Core 身份提交回调');
    }
    for (const name of referencedToolCommands) {
      if (!toolCommandDefinitions.has(name)) {
        throw new TypeError(`FakeRuntime.create: tool_command 引用未批准命令定义 ${name}`);
      }
    }
  }
  const commandProcess = options.commandProcess;
  const commitCommandIdentity = options.commitCommandIdentity;

  /* F-005：命名门闩装配核验（脚本引用必须全部装配；门闩形态 fail-fast）。 */
  const gateMap = new Map<string, FakeRuntimeGate>();
  for (const [name, gate] of Object.entries(options.gates ?? {})) {
    requireSafeRecordKey(name, assemblyContext, `gates.${name}`);
    if (gate === null || typeof gate !== 'object' ||
        typeof (gate as FakeRuntimeGate).wait !== 'function') {
      throw new TypeError(`FakeRuntime.create: gates.${name} 必须提供 wait()`);
    }
    gateMap.set(name, gate);
  }
  for (const ref of collectFakeRuntimeGateRefs(script)) {
    if (!gateMap.has(ref)) {
      throw new TypeError(`FakeRuntime.create: 脚本引用未装配门闩 ${ref}`);
    }
  }
  /* F-005：启动抛错注入校验（受控 kind + 原因 token；快照冻结）。 */
  let startFailure: FakeRuntimeStartFailure | undefined;
  if (options.startFailure !== undefined) {
    const raw = options.startFailure;
    if (raw === null || typeof raw !== 'object' ||
        !(RUNTIME_ERROR_KINDS as readonly string[]).includes(raw.kind as string) ||
        typeof raw.reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.reason)) {
      throw new TypeError('FakeRuntime.create: startFailure 必须是受控 kind 与原因 token');
    }
    startFailure = Object.freeze({ kind: raw.kind, reason: raw.reason });
  }
  const lifecycle = script.lifecycle;

  const descriptor: RuntimeAdapterDescriptor = {
    schemaVersion: 1,
    runtimeId: FAKE_RUNTIME_ID,
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterVersion: options.adapterVersion ?? '1.0',
    providers: options.providers.map((provider) => ({ ...provider })),
    permissionGrants: [],
    isolationModes: [TRUSTED_PROJECT_ISOLATION],
  };

  const adapter: RuntimeAdapter = {
    async start(request: RuntimeExecutionRequest): Promise<RuntimeHandle> {
      /* F-005：启动抛错注入（在创建任何运行现场之前拒绝）。 */
      if (startFailure !== undefined) {
        throw new RuntimeError(startFailure.kind, startFailure.reason);
      }
      const realRoot = canonicalRoots.get(request.cwd.root);
      if (realRoot === undefined) {
        throw new RuntimeError('configuration', 'cwd_root_unknown', { field: 'request.cwd.root' });
      }
      const base = request.cwd.relativePath === '.'
        ? realRoot
        : join(realRoot, ...request.cwd.relativePath.split('/'));
      if (!insideRoot(realRoot, base)) {
        throw new RuntimeError('configuration', 'cwd_root_unknown', { field: 'request.cwd.relativePath' });
      }

      /* 每次 start 的独立运行现场：通道/op log/输出计数/取消信号互不共享。 */
      const channel = createBoundedChannel(bufferMaxEvents, bufferMaxBytes);
      const opLog: FakeRuntimeOpRecord[] = [];
      const correlation = fakeRuntimeCorrelationToken(request);
      const maxOutputBytes = request.limits.maxOutputBytes;
      let outputBytes = 0;
      let sequence = 0;
      let observedUsage: RuntimeExecutionResult['usage'] = null;
      let messageSeq = 0;
      let toolSeq = 0;
      let cancelled = false;
      /* F-004 受控工具进程登记：活动句柄用于取消传播；停止核验用于最终证据。 */
      const activeTools = new Set<CommandProcessHandle>();
      const toolStops: Array<{ toolCallId: string; stop: Promise<CommandProcessStop> }> = [];
      let uncleanToolLaunch = 0;
      const startAbort = new AbortController();

      /* F-005：取消通知（门闩等待的有界中断）与故障/生命周期配置快照。 */
      let cancelNotify!: () => void;
      const cancelNotified = new Promise<void>((resolve) => { cancelNotify = resolve; });
      const dropSet = new Set(lifecycle?.events?.drop ?? []);
      const duplicateSet = new Set(lifecycle?.events?.duplicate ?? []);
      const reorderAt = lifecycle?.events?.reorderAt;
      const eventsEndGate = lifecycle?.events?.endGate;
      const resultGate = lifecycle?.result?.gate;
      const terminalOverride = lifecycle?.result?.terminalOverride;
      const acceptOnlyCancel = lifecycle?.cancel?.acceptOnly === true;
      const stoppedGate = lifecycle?.stopped?.gate;
      const stoppedUnconfirmedFault = lifecycle?.stopped?.unconfirmed === true;
      let acceptOnlyConsumed = false;
      let heldEvent: { event: WireRuntimeEvent; bytes: number } | null = null;

      /** 门闩等待：真实取消有界中断（ChannelClosed）；acceptOnly 首次取消不中断。 */
      const raceGate = async (name: string): Promise<void> => {
        const gate = gateMap.get(name) as FakeRuntimeGate;
        await Promise.race([gate.wait(), cancelNotified]);
        if (cancelled) throw new ChannelClosed();
      };

      let settleResult!: (result: RuntimeExecutionResult) => void;
      const result = new Promise<RuntimeExecutionResult>((resolve) => { settleResult = resolve; });
      let resultSettled = false;
      const settleOnce = (value: RuntimeExecutionResult): void => {
        if (resultSettled) return;
        resultSettled = true;
        settleResult(value);
      };
      let settleStopped!: (evidence: RuntimeStopEvidence) => void;
      const stopped = new Promise<RuntimeStopEvidence>((resolve) => { settleStopped = resolve; });
      let stoppedSettled = false;
      const settleStoppedOnce = (evidence: RuntimeStopEvidence): void => {
        if (stoppedSettled) return;
        stoppedSettled = true;
        settleStopped(evidence);
      };

      const isoNow = (): string => new Date(nowUtcMs()).toISOString();

      const pushEvent = async (event: WireRuntimeEvent, bytes: number): Promise<void> => {
        if (outputBytes + bytes > maxOutputBytes) throw new FailRun('output_limit_exceeded');
        if (!(await channel.push(event, bytes))) throw new ChannelClosed();
        outputBytes += bytes;
      };

      /** 有暂存事件时先投当前事件再投暂存（reorderAt 相邻乱序）。 */
      const deliverOrdered = async (event: WireRuntimeEvent, bytes: number): Promise<void> => {
        if (heldEvent === null) {
          await pushEvent(event, bytes);
          return;
        }
        const held = heldEvent;
        heldEvent = null;
        await pushEvent(event, bytes);
        await pushEvent(held.event, held.bytes);
      };

      /** 冲刷暂存事件（drop 命中时保持既有顺序；通闩关闭前收尾）。 */
      const flushHeld = async (): Promise<void> => {
        if (heldEvent === null) return;
        const held = heldEvent;
        heldEvent = null;
        await pushEvent(held.event, held.bytes);
      };

      const emit = async (payload: RuntimeEventPayload): Promise<void> => {
        const nextSequence = sequence + 1;
        const { kind, ...wirePayload } = payload;
        const event: WireRuntimeEvent = {
          schemaVersion: 1,
          eventId: `evt.${correlation}.${nextSequence}`,
          kind,
          sequence: nextSequence,
          occurredAtUtc: isoNow(),
          payload: payload.kind === 'usage' ? { ...payload.usage } : wirePayload,
        };
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        const faulted = heldEvent !== null || dropSet.has(nextSequence) ||
          duplicateSet.has(nextSequence) || reorderAt === nextSequence;
        if (!faulted) {
          /* 无故障路径与 F-003 逐语句一致（相同微任务跳数）：push 成功后推进序列。 */
          if (outputBytes + bytes > maxOutputBytes) throw new FailRun('output_limit_exceeded');
          if (!(await channel.push(event, bytes))) throw new ChannelClosed();
          outputBytes += bytes;
          sequence = nextSequence;
          return;
        }
        /* F-005 故障路径：序列在生成时推进（丢失计入水位缺口）。 */
        sequence = nextSequence;
        if (dropSet.has(nextSequence)) {
          await flushHeld();
          return;
        }
        if (reorderAt === nextSequence) {
          heldEvent = { event, bytes };
          return;
        }
        await deliverOrdered(event, bytes);
        if (duplicateSet.has(nextSequence)) await pushEvent(event, bytes);
      };

      const record = (
        op: string, target: string, outcome: 'ok' | 'failed',
        extra: {
          reason?: string | null; bytes?: number | null; digest?: string | null;
          toolCallId?: string; exitCode?: number | null; signal?: string | null;
          lastActivityAtUtc?: string | null; droppedOutputBytes?: number; stopConfirmed?: boolean;
        } = {},
      ): void => {
        opLog.push({
          index: opLog.length + 1, op, target, outcome,
          reason: extra.reason ?? null, bytes: extra.bytes ?? null, digest: extra.digest ?? null,
          ...(extra.toolCallId === undefined ? {} : { toolCallId: extra.toolCallId }),
          ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
          ...(extra.signal === undefined ? {} : { signal: extra.signal }),
          ...(extra.lastActivityAtUtc === undefined ? {} : { lastActivityAtUtc: extra.lastActivityAtUtc }),
          ...(extra.droppedOutputBytes === undefined ? {} : { droppedOutputBytes: extra.droppedOutputBytes }),
          ...(extra.stopConfirmed === undefined ? {} : { stopConfirmed: extra.stopConfirmed }),
        });
      };

      const resolveReader = (): BoundExecutionInputReader | undefined => {
        if (options.reader === undefined) return undefined;
        if (typeof options.reader === 'function') return options.reader(request);
        return options.reader;
      };

      const executeStep = async (step: FakeRuntimeScriptStep): Promise<void> => {
        switch (step.op) {
          case 'read_input': {
            const reader = resolveReader();
            if (reader === undefined) {
              record('read_input', step.purpose, 'failed', { reason: 'input_reader_missing' });
              throw new FailRun('input_reader_missing');
            }
            try {
              const body = await reader.read(step.purpose);
              record('read_input', step.purpose, 'ok', { bytes: body.sizeBytes, digest: body.contentHash });
            } catch (error) {
              const reason = mapInputReadError(error);
              record('read_input', step.purpose, 'failed', { reason });
              throw new FailRun(reason);
            }
            return;
          }
          case 'read_file': {
            try {
              const target = resolveReadTarget(realRoot, base, step.path);
              const content = readFileSync(target);
              record('read_file', step.path, 'ok', {
                bytes: content.byteLength, digest: createHash('sha256').update(content).digest('hex'),
              });
            } catch (error) {
              const reason = error instanceof FsFailure ? error.failureReason : 'read_denied';
              record('read_file', step.path, 'failed', { reason });
              throw new FailRun(reason);
            }
            return;
          }
          case 'write_file': {
            const bytes = Buffer.byteLength(step.content, 'utf8');
            try {
              if (outputBytes + bytes > maxOutputBytes) throw new FailRun('output_limit_exceeded');
              const target = resolveWriteTarget(realRoot, base, step.path);
              writeFileSync(target, step.content, 'utf8');
              outputBytes += bytes;
              record('write_file', step.path, 'ok', {
                bytes, digest: createHash('sha256').update(step.content, 'utf8').digest('hex'),
              });
            } catch (error) {
              if (error instanceof FailRun) {
                record('write_file', step.path, 'failed', { reason: error.failReason });
                throw error;
              }
              const reason = error instanceof FsFailure ? error.failureReason : 'write_denied';
              record('write_file', step.path, 'failed', { reason });
              throw new FailRun(reason);
            }
            return;
          }
          case 'message':
            messageSeq += 1;
            await emit({
              kind: 'message',
              messageId: `msg.${correlation}.${messageSeq}`,
              role: step.role,
              preview: step.text,
            });
            record('message', step.role, 'ok');
            return;
          case 'tool': {
            toolSeq += 1;
            const toolCallId = `tool.${correlation}.${toolSeq}`;
            await emit({ kind: 'tool_started', toolCallId, toolName: step.name });
            await emit({ kind: 'tool_finished', toolCallId, exitCode: step.exitCode, signal: null });
            record('tool', step.name, 'ok');
            return;
          }
          case 'tool_command': {
            /* F-004：只以名称引用装配批准定义；argv/环境/超时快照自装配侧。 */
            toolSeq += 1;
            const toolCallId = `tool.${correlation}.${toolSeq}`;
            const definition = toolCommandDefinitions.get(step.name) as ValidatedToolCommandDefinition;
            const port = commandProcess as CommandProcessPort;
            const commit = commitCommandIdentity as FakeRuntimeCommitCommandIdentity;
            let tool: CommandProcessHandle;
            try {
              /* launchId/PID/PGID/OS 启动身份经 Core 回调提交到当前 Attempt/占用
               * 后才由既有 CommandProcess 握手放行；提交失败命令不执行。 */
              tool = await port.start({
                argv: definition.argv,
                cwd: base,
                environment: definition.environment,
                stdin: definition.stdin,
                timeoutMs: definition.timeoutMs,
                maxInputBytes: definition.maxInputBytes,
                maxOutputBytes: definition.maxOutputBytes,
              }, (identity) => commit(identity, {
                toolCallId,
                invocationId: request.invocationId,
                attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : undefined,
              }), startAbort.signal);
            } catch (error) {
              const reason = !(error instanceof CommandProcessError)
                ? 'tool_launch_failed'
                : error.reason === 'confirmation_failed'
                  ? 'tool_identity_commit_failed'
                  : error.reason === 'stop_unconfirmed'
                    ? 'tool_stop_unconfirmed'
                    : 'tool_launch_failed';
              if (reason === 'tool_stop_unconfirmed') uncleanToolLaunch += 1;
              record('tool_command', step.name, 'failed', { reason, toolCallId });
              if (cancelled) throw new ChannelClosed();
              throw new FailRun(reason);
            }
            activeTools.add(tool);
            if (cancelled) void tool.cancel().catch(() => undefined);
            toolStops.push({ toolCallId, stop: tool.stopped });
            /* 防止未聚合路径（如停止核验故障注入跳过聚合）产生未处理拒绝。 */
            void tool.stopped.then(() => undefined, () => undefined);
            try {
              await emit({ kind: 'tool_started', toolCallId, toolName: step.name });
              /* 输出与结果并行有界消费：滚动摘要 + 最后活动，不累积全文。 */
              const digest = createHash('sha256');
              let lastActivity: string | null = null;
              const consume = (async () => {
                for await (const chunk of tool.output) {
                  digest.update(chunk.bytes);
                  lastActivity = isoNow();
                }
              })();
              const commandResult = await tool.result;
              await consume;
              const stop = await tool.stopped;
              const ok = commandResult.reason === null && commandResult.exitCode === 0;
              record('tool_command', step.name, ok ? 'ok' : 'failed', {
                reason: commandResult.reason,
                bytes: commandResult.outputBytes,
                digest: commandResult.outputBytes > 0 ? digest.digest('hex') : null,
                toolCallId,
                exitCode: commandResult.exitCode,
                signal: commandResult.signal,
                lastActivityAtUtc: lastActivity,
                droppedOutputBytes: commandResult.droppedOutputBytes,
                stopConfirmed: stop.confirmed,
              });
              await emit({
                kind: 'tool_finished', toolCallId,
                exitCode: commandResult.exitCode, signal: commandResult.signal,
                reason: commandResult.reason, outputBytes: commandResult.outputBytes,
                lastActivityAtUtc: lastActivity,
              });
              // A timed out tool must not admit the next script side effect. Core still
              // observes the independent stopped promise before any resource release.
              if (commandResult.reason === 'timed_out') throw new FailRun('tool_timeout');
            } finally {
              activeTools.delete(tool);
            }
            return;
          }
          case 'usage': {
            const delta = { basis: 'synthetic' as const, inputTokens: step.inputTokens,
              outputTokens: step.outputTokens, costUsdMicros: step.costUsdMicros };
            const sumKnown = (left: number | null, right: number | null): number | null =>
              left === null || right === null || !Number.isSafeInteger(left + right) ? null : left + right;
            observedUsage = observedUsage === null ? delta : { basis: 'synthetic',
              inputTokens: sumKnown(observedUsage.inputTokens, delta.inputTokens),
              outputTokens: sumKnown(observedUsage.outputTokens, delta.outputTokens),
              costUsdMicros: sumKnown(observedUsage.costUsdMicros, delta.costUsdMicros) };
            await emit({ kind: 'usage', usage: delta });
            record('usage', 'usage', 'ok');
            return;
          }
          case 'fail':
            record('fail', step.reason, 'failed', { reason: step.reason });
            throw new FailRun(step.reason);
          case 'await_gate':
            /* F-005：挂起在装配注入门闩；取消有界中断等待（acceptOnly 除外）。 */
            try {
              await raceGate(step.name);
            } catch (error) {
              record('await_gate', step.name, 'failed', { reason: 'cancelled' });
              throw error;
            }
            record('await_gate', step.name, 'ok');
            return;
          case 'raise':
            /* F-005：意外异常注入（非 FailRun → 运行循环折算 internal_error）。 */
            record('raise', step.reason, 'failed', { reason: step.reason });
            throw new Error(`fake_runtime_raise:${step.reason}`);
        }
      };

      const cancelledResult = (): RuntimeExecutionResult => ({
        schemaVersion: 1, terminal: 'cancelled', reason: null, exitCode: null, signal: null,
        durationMs: null, usage: observedUsage, lastEventSequence: sequence,
      });
      const failedResult = (reason: string): RuntimeExecutionResult => ({
        schemaVersion: 1, terminal: reason === 'tool_timeout' ? 'timed_out' : 'failed', reason, exitCode: null, signal: null,
        durationMs: null, usage: observedUsage, lastEventSequence: sequence,
      });
      const scriptResult = (): RuntimeExecutionResult => ({
        schemaVersion: 1,
        /* F-005：terminalOverride 产出词汇外终态（仅正常完成路径；会话层
         * 校验为 protocol unknown_terminal，不折算 failed）。 */
        terminal: (terminalOverride ?? script.result.terminal) as RuntimeTerminalState,
        reason: script.result.reason,
        exitCode: script.result.exitCode,
        signal: script.result.signal,
        durationMs: script.result.durationMs,
        usage: script.result.usage === null ? null : { basis: 'synthetic', ...script.result.usage },
        lastEventSequence: sequence,
      });

      const run = (async (): Promise<void> => {
        /* F-005：result.gate 延迟结果结算（事件先结束）；取消竞态由
         * settleOnce 一次结算规则兜底。 */
        let deferred: (() => RuntimeExecutionResult) | null = null;
        try {
          /* 请求携带非 new 恢复选择时如实声明：确定性全新执行，不冒充
           * SDK 检查点/对话续接验收（core-design/14 恢复边界）。 */
          if (request.recovery.mode !== 'new') {
            await emit({
              kind: 'diagnostic',
              code: 'fake_fresh_execution',
              message: 'recovery requested; deterministic fresh run, no native checkpoint or conversation state resumed',
            });
          }
          for (const step of script.steps) {
            if (cancelled) break;
            await executeStep(step);
          }
          if (resultGate === undefined) {
            settleOnce(cancelled ? cancelledResult() : scriptResult());
          } else {
            deferred = () => (cancelled ? cancelledResult() : scriptResult());
          }
        } catch (error) {
          if (error instanceof ChannelClosed) {
            settleOnce(cancelledResult());
          } else {
            const reason = error instanceof FailRun ? error.failReason : 'internal_error';
            /* 失败诊断尽力入队（满/关闭即丢弃，绝不因诊断阻塞结算）。 */
            const diagnostic: WireRuntimeEvent = {
              schemaVersion: 1,
              eventId: `evt.${correlation}.${sequence + 1}`,
              kind: 'diagnostic',
              sequence: sequence + 1,
              occurredAtUtc: isoNow(),
              payload: { code: 'fake.op_failed', message: reason.slice(0, 200) },
            };
            const diagnosticBytes = Buffer.byteLength(JSON.stringify(diagnostic), 'utf8');
            if (channel.tryPush(diagnostic, diagnosticBytes)) sequence += 1;
            settleOnce(failedResult(reason));
          }
        } finally {
          /* F-005：事件结束门闩——结果可先于事件结束结算（结果先到）；取消
           * 竞态下关闭优先（有界结束等待与事件通道）。 */
          if (eventsEndGate !== undefined) await raceGate(eventsEndGate).catch(() => undefined);
          await flushHeld().catch(() => undefined);
          channel.close();
          /* F-005：结果门闩——事件通道已关闭而结果可继续挂起（事件先结束）。 */
          if (deferred !== null) {
            await raceGate(resultGate as string).catch(() => undefined);
            settleOnce(deferred());
          }
          /* F-005：停止证据门闩——释放后才聚合真实受控组核验结果（不以预设
           * 布尔冒充真实进程已退出）。 */
          if (stoppedGate !== undefined) await raceGate(stoppedGate).catch(() => undefined);
          if (stoppedUnconfirmedFault) {
            /* 监督边界故障注入：如实报告未知，不冒充已停止。 */
            settleStoppedOnce({
              schemaVersion: 1,
              confirmed: false,
              checkedAtUtc: isoNow(),
              detail: 'stop_verification_fault',
            });
          } else {
            /* F-004：Runtime stopped 只有在脚本步骤结束且所有登记受控工具进程组
             * 核验停止后才 confirmed；父退子活、身份核验失败与进程监督丢失
             * （含启动失败且清理未核验的 launch）均报告 confirmed=false。 */
            const outcomes = await Promise.all(toolStops.map(async (entry) => ({
              toolCallId: entry.toolCallId,
              confirmed: await entry.stop.then((stop) => stop.confirmed, () => false),
            })));
            const unconfirmed = outcomes.filter((outcome) => !outcome.confirmed)
              .map((outcome) => outcome.toolCallId);
            for (let index = 0; index < uncleanToolLaunch; index += 1) {
              unconfirmed.push('launch_unverified');
            }
            const confirmedStop = unconfirmed.length === 0;
            settleStoppedOnce({
              schemaVersion: 1,
              confirmed: confirmedStop,
              checkedAtUtc: isoNow(),
              detail: confirmedStop ? null : `unconfirmed_tool_stop:${unconfirmed.join(',')}`.slice(0, 200),
            });
          }
        }
      })();
      void run;

      const handle: FakeRuntimeHandle = {
        events: channel.iterable(),
        result,
        stopped,
        cancel: async () => {
          /* F-005 acceptOnly：首次取消只返回接受回执，不中断运行、不自动
           * 确认停止；再次取消走真实取消语义（幂等）。 */
          if (acceptOnlyCancel && !acceptOnlyConsumed) {
            acceptOnlyConsumed = true;
            return { accepted: true, reason: null };
          }
          if (!cancelled) {
            cancelled = true;
            cancelNotify();
            startAbort.abort();
            /* 取消向活动受控工具传播：走既有身份匹配升级终止路径。 */
            for (const active of [...activeTools]) {
              void active.cancel().catch(() => undefined);
            }
            channel.close();
            settleOnce(cancelledResult());
          }
          return { accepted: true, reason: null };
        },
        inspection: {
          opLog: () => [...opLog],
          highWater: () => channel.highWater(),
        },
      };
      return handle;
    },
  };

  return { descriptor, adapter };
}
