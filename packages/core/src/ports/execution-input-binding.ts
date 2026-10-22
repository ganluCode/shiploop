/**
 * P03-6 / F-002 不可变执行输入绑定契约（ports 契约层：类型、常量、纯校验
 * 函数与受限读取能力端口形态，无任何 I/O）。
 *
 * 设计依据：core-design/14-runtime-recovery-and-durable.md §3（RuntimeRequest
 * 携带稳定 invocationId 与已授权恢复引用；同项目/用途/版本/摘要核验）、
 * §5（Core 拥有占用与停止核验；原生档案与业务库分离）、core-design/06
 * （Attempt 固定输入引用和摘要；缺失必需输入明确失败）与
 * input/p03-fake-runtime.md FR-2（校验必需输入及权限；不打开业务库、不自行
 * 设 passed；不同 Task 独立上下文）。
 *
 * 契约要点：
 * - 绑定输入消费 P03-4 已提交的 TaskClaimReceipt（含 AttemptRecord 与租约
 *   组）与 P03-5 WorkWorkspaceAuthority 颁发的已核验工作区令牌；令牌只做
 *   authority.inspect 准入，不做 JSON 形态信任；
 * - 绑定产出三件套：可交给 RuntimeExecutionService.start 的
 *   RuntimeExecutionRequest（经既有 validateRuntimeExecutionRequest 终验）、
 *   只允许读取本次绑定制品集合的受限读取能力（BoundExecutionInputReader，
 *   绝不暴露业务数据库句柄）、按 Attempt 关联的读取证据
 *   （ExecutionInputReadEvidence；发布为同项目不可变 Artifact）；
 * - 读取证据逐项记录用途、制品身份、摘要、字节数与读取结果；引用存在但未
 *   实际读取不得记为已满足（证据只来自真实读取循环）；
 * - 有界性：单项字节、总字节、引用数量、读取调用次数与读取耗时全部显式
 *   有限；超限即 limit_exceeded 失败，绝不截断必需内容换取成功；
 * - 恢复：auto/new/required 决定沿用 P03-3A decideRuntimeRecovery 与可信
 *   能力目录；Fake 等不支持原生续接的 runtime 下 auto 显式降级 new 并记录
 *   原因，required 明确拒绝；恢复来源引用在进入适配器前必须解析为同项目
 *   ready Artifact 且 sourceDigest 与正文摘要一致；
 * - 失败纪律：输入/工作区/恢复任一拒绝都以 ExecutionInputBindingError 抛出
 *   （kind 区分 input/workspace/recovery，reason 为受控词汇），并尽力保留
 *   按 Attempt 关联的拒绝证据制品（evidenceRef）；不修改旧快照、不改预算、
 *   零代码/工具副作用；
 * - 秘密纪律：证据与错误 details 只含身份键、摘要、字节数、计数与脱敏原因，
 *   不含绝对路径、制品正文或凭据。
 *
 * 实现者：application/execution-input-binding.ts（绑定编排与受限读取能力）；
 * 本层不实现任何存储、文件系统或恢复来源行为。
 */
import { validateAttemptRecord, validateWorkspaceLeaseRecord } from './attempt-store.js';
import { validateTaskClaimLaunch, validateTaskClaimDispatch, type TaskClaimReceipt } from './task-claim.js';
import { validateExecutionInputPurpose } from './execution-input.js';
import {
  RUNTIME_RECOVERY_SCHEMA_VERSION,
  validateRuntimeRecoveryRequest,
} from './runtime-recovery.js';
import type {
  RuntimeRecoveryKind,
  RuntimeRecoverySelection,
} from './runtime-recovery.js';
import type {
  RuntimeExecutionLimits,
  RuntimeExecutionRequest,
  RuntimeWorkAccessSnapshot,
} from './runtime-execution.js';
import {
  RUNTIME_EXECUTION_MAX_EVENTS_LIMIT,
  RUNTIME_EXECUTION_MAX_OUTPUT_BYTES_LIMIT,
} from './runtime-execution.js';
import {
  TOOL_TIMEOUT_MS_MAX,
  TOOL_TIMEOUT_MS_MIN,
  WORK_TIMEOUT_MS_MAX,
  WORK_TIMEOUT_MS_MIN,
  validateRuntimeStrategy,
} from './settings-schema.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import {
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validateArtifactLocator,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本、证据制品词汇与有界常量
 * ------------------------------------------------------------------ */

export const EXECUTION_INPUT_BINDING_SCHEMA_VERSION = 1;

/** 读取证据制品的固定 kind（按 Attempt 关联的不可变证据）。 */
export const EXECUTION_INPUT_READ_EVIDENCE_ARTIFACT_KIND = 'execution-input-read-evidence';

/** 证据制品受控 locator 前缀（实际 locator = <前缀>/<attemptId>/binding）。 */
export const EXECUTION_INPUT_READ_EVIDENCE_LOCATOR_PREFIX = 'execution-input-reads';

/** 证据制品媒体类型（受控 JSON）。 */
export const EXECUTION_INPUT_READ_EVIDENCE_MEDIA_TYPE = 'application/json';

/** 绑定请求的权限授予条目上限（与 F-001 请求契约对齐）。 */
export const EXECUTION_INPUT_BINDING_MAX_GRANTS = 64;

/** 绑定输入的租约条目上限（global/project/workspace 之外不发明新租约）。 */
export const EXECUTION_INPUT_BINDING_MAX_LEASES = 16;

/**
 * 读取有界限制：单项字节、总字节、引用数量、读取调用次数与读取耗时全部
 * 显式有限。缺省值覆盖 schema 允许的最大输入规模（256 条必需输入 + 三正文）。
 */
export interface ExecutionInputBindingLimits {
  readonly maxItemBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRefCount: number;
  readonly maxReads: number;
  readonly maxReadDurationMs: number;
}

export const DEFAULT_EXECUTION_INPUT_BINDING_LIMITS: Readonly<ExecutionInputBindingLimits> =
  Object.freeze({
    maxItemBytes: 1_048_576,
    maxTotalBytes: 8_388_608,
    maxRefCount: 260,
    maxReads: 512,
    maxReadDurationMs: 60_000,
  });

/* ------------------------------------------------------------------ *
 * 结构化失败（受控原因词汇；details 只含脱敏身份/摘要/计数）
 * ------------------------------------------------------------------ */

/** 失败大类：input（必需输入/正文/预算）、workspace（占用/realpath/cwd）、recovery（恢复来源/决定）。 */
export type ExecutionInputBindingFailureKind = 'input' | 'workspace' | 'recovery';

export const EXECUTION_INPUT_BINDING_REASONS = [
  /** 回执与权威 Attempt 记录身份不一致（过期/伪造回执）。 */
  'claim_identity_mismatch',
  /** Attempt 不在已授权启动状态（未 beginLaunch、invocationId 不符或已推进）。 */
  'attempt_not_current',
  /** 同 Task 另有未停止（活动状态）Attempt，一律拒绝重叠。 */
  'overlap_active_attempt',
  /** 同 Task 旧 Attempt 仍持有/隔离工作区占用；new 不得绕过。 */
  'source_occupancy_unresolved',
  /** 输入快照记录的续接决策与当前请求/能力不一致（禁止静默沿用旧模型或旧决定）。 */
  'recovery_decision_changed',
  /** Attempt 已绑定的 Session 与请求 sessionId 冲突。 */
  'session_conflict',
  /** 工作区令牌/占用归属/realpath 复核失败（含目录替换与符号链接越界）。 */
  'workspace_untrusted',
  /** cwd 根 ID 不在可信装配的获准根白名单内。 */
  'cwd_root_unknown',
  /** 请求权限与准备时权限面不一致（拒绝扩大或缩减权限身份）。 */
  'permission_expansion',
  /** 请求策略与快照中的实际策略副本逐项不一致。 */
  'strategy_mismatch',
  /** 必需制品缺失。 */
  'input_missing',
  /** 必需制品 pending/failed（非 ready 不可用）。 */
  'input_not_ready',
  /** 引用与权威索引身份漂移（hash/size/locator/kind/mediaType）。 */
  'input_identity_mismatch',
  /** 引用版本与权威索引不一致（错误版本）。 */
  'input_version_mismatch',
  /** 正文损坏（实测摘要/字节与索引不符、非法 JSON/UTF-8）。 */
  'input_corrupt',
  /** 跨项目引用或制品归属不符。 */
  'input_cross_project',
  /** 读取端口失败（权限/IO 等不可读条件）。 */
  'input_unreadable',
  /** 适配器读取未绑定用途（受限读取能力之外的引用）。 */
  'unbound_input_read',
  /** snapshot/manifest/prompt 正文与冻结摘要重算不一致。 */
  'snapshot_digest_mismatch',
  'manifest_digest_mismatch',
  'prompt_digest_mismatch',
  /** 完整 acceptance 不可读（快照缺条目或 prompt 未完整携带）。 */
  'acceptance_incomplete',
  /** manifest 必需标记与实际读取/引用集不一致。 */
  'manifest_required_mismatch',
  /** 单项/总字节/引用数量/读取次数/读取耗时超限。 */
  'limit_exceeded',
  /** 恢复来源内容解析失败（同项目/ready/摘要/归档引用不符）。 */
  'recovery_source_invalid',
  /** required 恢复决定被能力/证据拒绝（绝不降级）。 */
  'recovery_rejected',
  /** 读取证据制品发布失败（证据是必须产物，发布失败即绑定失败）。 */
  'evidence_publish_failed',
] as const;
export type ExecutionInputBindingReason = (typeof EXECUTION_INPUT_BINDING_REASONS)[number];

export interface ExecutionInputBindingErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly evidenceRef?: string | null;
  readonly cause?: unknown;
}

/** 绑定失败：kind 大类 + 受控 reason；evidenceRef 指向已保存的拒绝证据（未保存为 null）。 */
export class ExecutionInputBindingError extends Error {
  readonly kind: ExecutionInputBindingFailureKind;
  readonly reason: ExecutionInputBindingReason;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly evidenceRef: string | null;

  constructor(
    kind: ExecutionInputBindingFailureKind,
    reason: ExecutionInputBindingReason,
    message: string,
    options: ExecutionInputBindingErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExecutionInputBindingError';
    this.kind = kind;
    this.reason = reason;
    this.details = options.details;
    this.evidenceRef = options.evidenceRef ?? null;
  }
}

export function isExecutionInputBindingError(
  value: unknown,
  reason?: ExecutionInputBindingReason,
): value is ExecutionInputBindingError {
  return (
    value instanceof ExecutionInputBindingError &&
    (reason === undefined || value.reason === reason)
  );
}

/* ------------------------------------------------------------------ *
 * 绑定输入（unknown → 已校验形态；校验失败抛 StorageError validation）
 * ------------------------------------------------------------------ */

const BINDING_OPERATION = 'ExecutionInputBinding.bind';
const bindingContext: ValidationContext = { operation: BINDING_OPERATION };

/** 绑定输入：已提交认领回执 + 已核验工作区令牌 + 启动身份/策略/权限/限制/恢复选择。 */
export interface ExecutionInputBindingInput {
  readonly schemaVersion: typeof EXECUTION_INPUT_BINDING_SCHEMA_VERSION;
  /** P03-4 已提交的认领回执（身份与权威 Attempt 逐项重核，不单独信任）。 */
  readonly claim: TaskClaimReceipt;
  /**
   * P03-5 WorkWorkspaceAuthority 颁发的已核验工作区令牌（不透明对象；
   * 只经 authority.inspect 准入，绝不做 JSON 形态信任）。
   */
  readonly workspace: unknown;
  /** 可信装配的 Work Session 身份（持久关联属后续 Session 任务）。 */
  readonly sessionId: string;
  /** beginLaunch 授权的稳定调用身份（与权威 Attempt 记录的 invocationId 逐项核对）。 */
  readonly invocationId: string;
  /** 请求执行策略（必须与快照中的实际策略副本逐项一致）。 */
  readonly strategy: RuntimeStrategyV1;
  /** 请求权限（内容摘要必须与准备时权限面一致，拒绝扩大）。 */
  readonly permissions: { readonly grants: readonly string[]; readonly isolation: string };
  /** 有限超时/事件/输出政策（与 RuntimeExecutionRequest.limits 同形同界）。 */
  readonly limits: RuntimeExecutionLimits;
  /** 恢复选择（沿用 P03-3A 契约；来源引用须解析为同项目 ready Artifact）。 */
  readonly recovery: RuntimeRecoverySelection;
  /** 已完成认证预检和显式资源选集的脱敏 Attempt 访问快照。 */
  readonly workAccess?: RuntimeWorkAccessSnapshot;
  /** 可信装配的获准 cwd 根 ID（rootId → 规范授权根由装配侧解析核对）。 */
  readonly cwdRoot: string;
}

function claimReceipt(value: unknown): TaskClaimReceipt {
  const field = 'input.claim';
  const raw = requirePlainObject(value, bindingContext, field);
  rejectUnknownKeys(
    raw,
    ['schemaVersion', 'claimKey', 'batchId', 'attempt', 'taskRevision', 'reservationId', 'leases', 'counts', 'eventId', 'launch', 'dispatch'],
    bindingContext,
    field,
  );
  if (raw.schemaVersion !== 1) {
    throw validationError(bindingContext, `${field}.schemaVersion`, 'unsupported_schema_version');
  }
  const attempt = validateAttemptRecord(raw.attempt);
  if (!Array.isArray(raw.leases) || raw.leases.length > EXECUTION_INPUT_BINDING_MAX_LEASES) {
    throw validationError(bindingContext, `${field}.leases`, '必须是有界租约数组');
  }
  const leases = raw.leases.map((lease, index) =>
    validateWorkspaceLeaseRecord(lease));
  const counts = requirePlainObject(raw.counts, bindingContext, `${field}.counts`);
  rejectUnknownKeys(
    counts,
    ['batchAttempts', 'runAttempts', 'taskAttempts', 'codeAttempts'],
    bindingContext,
    `${field}.counts`,
  );
  return {
    schemaVersion: 1,
    claimKey: validateStableId(raw.claimKey, bindingContext, `${field}.claimKey`),
    batchId: validateStableId(raw.batchId, bindingContext, `${field}.batchId`),
    attempt,
    taskRevision: validatePositiveInteger(raw.taskRevision, bindingContext, `${field}.taskRevision`),
    reservationId: validateStableId(raw.reservationId, bindingContext, `${field}.reservationId`),
    leases,
    counts: {
      batchAttempts: validateNonNegativeInteger(counts.batchAttempts, bindingContext, `${field}.counts.batchAttempts`),
      runAttempts: validateNonNegativeInteger(counts.runAttempts, bindingContext, `${field}.counts.runAttempts`),
      taskAttempts: validateNonNegativeInteger(counts.taskAttempts, bindingContext, `${field}.counts.taskAttempts`),
      codeAttempts: validateNonNegativeInteger(counts.codeAttempts, bindingContext, `${field}.counts.codeAttempts`),
    },
    eventId: validateStableId(raw.eventId, bindingContext, `${field}.eventId`),
    ...(raw.dispatch === undefined ? {} : { dispatch: validateTaskClaimDispatch(raw.dispatch) }),
    ...(raw.launch === undefined ? {} : { launch: validateTaskClaimLaunch(raw.launch, bindingContext, `${field}.launch`) }),
  };
}

function bindingPermissions(
  value: unknown,
): { readonly grants: readonly string[]; readonly isolation: string } {
  const field = 'input.permissions';
  const raw = requirePlainObject(value, bindingContext, field);
  rejectUnknownKeys(raw, ['grants', 'isolation'], bindingContext, field);
  if (!Array.isArray(raw.grants) || raw.grants.length > EXECUTION_INPUT_BINDING_MAX_GRANTS) {
    throw validationError(bindingContext, `${field}.grants`, '必须是有界数组（权限授予条目）');
  }
  const grants = raw.grants.map((grant, index) =>
    validateStableId(grant, bindingContext, `${field}.grants[${index}]`));
  if (new Set(grants).size !== grants.length) {
    throw validationError(bindingContext, `${field}.grants`, '不允许重复授予');
  }
  return {
    grants,
    isolation: validateStableId(raw.isolation, bindingContext, `${field}.isolation`),
  };
}

function bindingLimits(value: unknown): RuntimeExecutionLimits {
  const field = 'input.limits';
  const raw = requirePlainObject(value, bindingContext, field);
  rejectUnknownKeys(raw, ['timeoutMs', 'toolTimeoutMs', 'maxEvents', 'maxOutputBytes'], bindingContext, field);
  const timeoutMs = validatePositiveInteger(raw.timeoutMs, bindingContext, `${field}.timeoutMs`);
  if (timeoutMs < WORK_TIMEOUT_MS_MIN || timeoutMs > WORK_TIMEOUT_MS_MAX) {
    throw validationError(bindingContext, `${field}.timeoutMs`, '超出允许范围（有限超时政策）');
  }
  let toolTimeoutMs: number | undefined;
  if (raw.toolTimeoutMs !== undefined) {
    const toolLimit = validatePositiveInteger(raw.toolTimeoutMs, bindingContext, `${field}.toolTimeoutMs`);
    if (toolLimit < TOOL_TIMEOUT_MS_MIN || toolLimit > TOOL_TIMEOUT_MS_MAX || toolLimit > timeoutMs) {
      throw validationError(bindingContext, `${field}.toolTimeoutMs`, '必须是有限单工具上限且不大于 Session 上限');
    }
    toolTimeoutMs = toolLimit;
  }
  const maxEvents = validatePositiveInteger(raw.maxEvents, bindingContext, `${field}.maxEvents`);
  if (maxEvents > RUNTIME_EXECUTION_MAX_EVENTS_LIMIT) {
    throw validationError(bindingContext, `${field}.maxEvents`, '超出事件数量上限');
  }
  const maxOutputBytes = validatePositiveInteger(raw.maxOutputBytes, bindingContext, `${field}.maxOutputBytes`);
  if (maxOutputBytes > RUNTIME_EXECUTION_MAX_OUTPUT_BYTES_LIMIT) {
    throw validationError(bindingContext, `${field}.maxOutputBytes`, '超出输出字节上限');
  }
  return {
    timeoutMs,
    ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    maxEvents,
    maxOutputBytes,
  };
}

/**
 * 绑定输入校验：认领回执/策略/权限/限制逐项校验；恢复选择连同 Work 身份、
 * sessionId 与 invocationId 委托 P03-3A `validateRuntimeRecoveryRequest`
 * （同项目/用途/来源身份不符在输入边界即拒绝）。workspace 令牌保持不透明，
 * 由 authority.inspect 在应用层准入。
 */
export function validateExecutionInputBindingInput(value: unknown): ExecutionInputBindingInput {
  const raw = requirePlainObject(value, bindingContext, 'input');
  rejectUnknownKeys(
    raw,
    [
      'schemaVersion', 'claim', 'workspace', 'sessionId', 'invocationId', 'strategy',
      'permissions', 'limits', 'recovery', 'workAccess', 'cwdRoot',
    ],
    bindingContext,
    'input',
  );
  if (raw.schemaVersion !== EXECUTION_INPUT_BINDING_SCHEMA_VERSION) {
    throw validationError(bindingContext, 'input.schemaVersion', 'unsupported_schema_version');
  }
  const claim = claimReceipt(raw.claim);
  const sessionId = validateStableId(raw.sessionId, bindingContext, 'input.sessionId');
  const invocationId = validateStableId(raw.invocationId, bindingContext, 'input.invocationId');
  if (claim.launch !== undefined && (claim.launch.sessionId !== sessionId || claim.launch.invocationId !== invocationId)) {
    throw validationError(bindingContext, 'input.claim.launch', 'frozen_launch_identity_mismatch');
  }
  const strategy = validateRuntimeStrategy(raw.strategy, bindingContext, 'input.strategy');
  const permissions = bindingPermissions(raw.permissions);
  const limits = bindingLimits(raw.limits);
  const cwdRoot = validateStableId(raw.cwdRoot, bindingContext, 'input.cwdRoot');
  if (raw.workspace === undefined || raw.workspace === null || typeof raw.workspace !== 'object') {
    throw validationError(bindingContext, 'input.workspace', '必须是已核验工作区令牌（不透明对象）');
  }
  const attempt = claim.attempt;
  const recoveryPortion = validateRuntimeRecoveryRequest({
    schemaVersion: RUNTIME_RECOVERY_SCHEMA_VERSION,
    projectId: attempt.projectId,
    sessionId,
    executionVersion: attempt.executionVersion,
    identity: { purpose: 'work', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.id },
    invocationId,
    strategy,
    recovery: raw.recovery,
  });
  return {
    schemaVersion: EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
    claim,
    workspace: raw.workspace,
    sessionId,
    invocationId,
    strategy,
    permissions,
    limits,
    recovery: recoveryPortion.recovery,
    ...(raw.workAccess === undefined ? {} : { workAccess: raw.workAccess as RuntimeWorkAccessSnapshot }),
    cwdRoot,
  };
}

/** 读取限制校验（显式有限；未知键拒绝）。 */
export function validateExecutionInputBindingLimits(value: unknown): ExecutionInputBindingLimits {
  const context: ValidationContext = { operation: 'ExecutionInputBinding.limits' };
  const raw = requirePlainObject(value, context, 'limits');
  rejectUnknownKeys(
    raw,
    ['maxItemBytes', 'maxTotalBytes', 'maxRefCount', 'maxReads', 'maxReadDurationMs'],
    context,
    'limits',
  );
  return {
    maxItemBytes: validatePositiveInteger(raw.maxItemBytes, context, 'limits.maxItemBytes'),
    maxTotalBytes: validatePositiveInteger(raw.maxTotalBytes, context, 'limits.maxTotalBytes'),
    maxRefCount: validatePositiveInteger(raw.maxRefCount, context, 'limits.maxRefCount'),
    maxReads: validatePositiveInteger(raw.maxReads, context, 'limits.maxReads'),
    maxReadDurationMs: validatePositiveInteger(raw.maxReadDurationMs, context, 'limits.maxReadDurationMs'),
  };
}

/* ------------------------------------------------------------------ *
 * 受限读取能力与按 Attempt 关联的读取证据
 * ------------------------------------------------------------------ */

/** 已绑定输入引用（三正文与必需输入统一形态；正文永不内联）。 */
export interface BoundExecutionInputRef {
  readonly purpose: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
}

/** 单次读取证据：用途、制品身份、摘要、字节数、耗时与结果。 */
export interface ExecutionInputReadEntry {
  readonly purpose: string;
  readonly artifactId: string;
  readonly contentHash: string | null;
  readonly sizeBytes: number | null;
  readonly durationMs: number;
  readonly outcome: 'read' | 'failed';
  /** 失败时的脱敏原因（受控词汇；成功为 null）。 */
  readonly detail: string | null;
}

/** 恢复决定记录（来源记录：请求选择 + 能力决定 + 原因）。 */
export interface ExecutionInputRecoveryRecord {
  readonly selectionMode: 'new' | 'auto' | 'required';
  readonly selectionKind: RuntimeRecoveryKind | null;
  /** 恢复来源的原生归档制品 ID（无来源为 null；绝不携带原生路径）。 */
  readonly sourceArchiveArtifactId: string | null;
  readonly decision: 'new' | 'resume' | 'rejected';
  readonly reasons: readonly string[];
}

/** 按 Attempt 关联的读取证据（发布为同项目不可变 Artifact 的正文形态）。 */
export interface ExecutionInputReadEvidence {
  readonly schemaVersion: typeof EXECUTION_INPUT_BINDING_SCHEMA_VERSION;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly outcome: 'bound' | 'rejected';
  /** 拒绝原因（受控词汇；绑定成功为 null）。 */
  readonly reason: ExecutionInputBindingReason | null;
  readonly boundInputs: readonly BoundExecutionInputRef[];
  readonly reads: readonly ExecutionInputReadEntry[];
  readonly recovery: ExecutionInputRecoveryRecord;
  readonly totals: {
    readonly refCount: number;
    readonly totalBytes: number;
    readonly readDurationMs: number;
  };
  readonly createdAtUtcMs: number;
}

/** 受限读取能力返回的正文（已按绑定引用复核 hash/size）。 */
export interface BoundExecutionInputBody {
  readonly purpose: string;
  readonly artifactId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly content: Uint8Array;
}

/**
 * 受限读取能力：只允许读取本次绑定的制品集合（按用途），逐项复核身份与
 * 摘要并受显式字节/次数/耗时上限约束。可交给适配器使用；不是业务数据库
 * 句柄，不提供列举项目制品、写索引或读取未绑定引用的任何入口。
 */
export interface BoundExecutionInputReader {
  /** 已绑定引用清单（身份级；读取用途白名单）。 */
  list(): readonly BoundExecutionInputRef[];
  /** 按用途读取已绑定正文；未绑定用途/身份漂移/超限一律 ExecutionInputBindingError。 */
  read(purpose: unknown): Promise<BoundExecutionInputBody>;
}

/** 绑定结果：执行请求 + 受限读取能力 + 证据与已发布证据制品引用。 */
export interface ExecutionInputBindingResult {
  readonly request: RuntimeExecutionRequest;
  readonly reader: BoundExecutionInputReader;
  readonly evidence: ExecutionInputReadEvidence;
  readonly evidenceRef: BoundExecutionInputRef;
}

/* ------------------------------------------------------------------ *
 * 证据形态校验（读取已发布证据正文时的边界校验）
 * ------------------------------------------------------------------ */

const EVIDENCE_OPERATION = 'ExecutionInputReadEvidence.validate';
const evidenceContext: ValidationContext = { operation: EVIDENCE_OPERATION };

function boundRef(value: unknown, field: string): BoundExecutionInputRef {
  const raw = requirePlainObject(value, evidenceContext, field);
  rejectUnknownKeys(
    raw,
    ['purpose', 'artifactId', 'version', 'contentHash', 'sizeBytes', 'locator', 'mediaType'],
    evidenceContext,
    field,
  );
  return {
    purpose: validateExecutionInputPurpose(raw.purpose, evidenceContext, `${field}.purpose`),
    artifactId: validateStableId(raw.artifactId, evidenceContext, `${field}.artifactId`),
    version: validatePositiveInteger(raw.version, evidenceContext, `${field}.version`),
    contentHash: validateSha256Digest(raw.contentHash, evidenceContext, `${field}.contentHash`),
    sizeBytes: validateNonNegativeInteger(raw.sizeBytes, evidenceContext, `${field}.sizeBytes`),
    locator: validateArtifactLocator(raw.locator, evidenceContext, `${field}.locator`),
    mediaType: requireNonEmptyString(raw.mediaType, evidenceContext, `${field}.mediaType`),
  };
}

/** 证据正文校验（读回已发布证据时使用；非法形态抛 StorageError validation）。 */
export function validateExecutionInputReadEvidence(value: unknown): ExecutionInputReadEvidence {
  const raw = requirePlainObject(value, evidenceContext, 'evidence');
  rejectUnknownKeys(
    raw,
    [
      'schemaVersion', 'projectId', 'featureId', 'runId', 'taskId', 'attemptId', 'sessionId',
      'invocationId', 'outcome', 'reason', 'boundInputs', 'reads', 'recovery', 'totals',
      'createdAtUtcMs',
    ],
    evidenceContext,
    'evidence',
  );
  if (raw.schemaVersion !== EXECUTION_INPUT_BINDING_SCHEMA_VERSION) {
    throw validationError(evidenceContext, 'evidence.schemaVersion', 'unsupported_schema_version');
  }
  if (raw.outcome !== 'bound' && raw.outcome !== 'rejected') {
    throw validationError(evidenceContext, 'evidence.outcome', 'invalid_outcome');
  }
  if (raw.reason !== null && !(EXECUTION_INPUT_BINDING_REASONS as readonly string[]).includes(raw.reason as string)) {
    throw validationError(evidenceContext, 'evidence.reason', 'invalid_reason');
  }
  if (raw.outcome === 'bound' && raw.reason !== null) {
    throw validationError(evidenceContext, 'evidence.reason', 'bound_must_not_carry_reason');
  }
  if (!Array.isArray(raw.boundInputs) || !Array.isArray(raw.reads)) {
    throw validationError(evidenceContext, 'evidence.reads', '必须是数组');
  }
  const recovery = requirePlainObject(raw.recovery, evidenceContext, 'evidence.recovery');
  rejectUnknownKeys(
    recovery,
    ['selectionMode', 'selectionKind', 'sourceArchiveArtifactId', 'decision', 'reasons'],
    evidenceContext,
    'evidence.recovery',
  );
  if (!['new', 'auto', 'required'].includes(recovery.selectionMode as string)) {
    throw validationError(evidenceContext, 'evidence.recovery.selectionMode', 'invalid_recovery_mode');
  }
  if (recovery.selectionKind !== null && recovery.selectionKind !== 'conversation' && recovery.selectionKind !== 'checkpoint') {
    throw validationError(evidenceContext, 'evidence.recovery.selectionKind', 'invalid_recovery_kind');
  }
  if (!['new', 'resume', 'rejected'].includes(recovery.decision as string)) {
    throw validationError(evidenceContext, 'evidence.recovery.decision', 'invalid_decision');
  }
  if (!Array.isArray(recovery.reasons) || recovery.reasons.some((reason) => typeof reason !== 'string')) {
    throw validationError(evidenceContext, 'evidence.recovery.reasons', '必须是字符串数组');
  }
  const totals = requirePlainObject(raw.totals, evidenceContext, 'evidence.totals');
  rejectUnknownKeys(totals, ['refCount', 'totalBytes', 'readDurationMs'], evidenceContext, 'evidence.totals');
  return {
    schemaVersion: EXECUTION_INPUT_BINDING_SCHEMA_VERSION,
    projectId: validateStableId(raw.projectId, evidenceContext, 'evidence.projectId'),
    featureId: validateStableId(raw.featureId, evidenceContext, 'evidence.featureId'),
    runId: validateStableId(raw.runId, evidenceContext, 'evidence.runId'),
    taskId: validateStableId(raw.taskId, evidenceContext, 'evidence.taskId'),
    attemptId: validateStableId(raw.attemptId, evidenceContext, 'evidence.attemptId'),
    sessionId: validateStableId(raw.sessionId, evidenceContext, 'evidence.sessionId'),
    invocationId: validateStableId(raw.invocationId, evidenceContext, 'evidence.invocationId'),
    outcome: raw.outcome,
    reason: raw.reason as ExecutionInputBindingReason | null,
    boundInputs: raw.boundInputs.map((ref, index) => boundRef(ref, `evidence.boundInputs[${index}]`)),
    reads: raw.reads.map((entry, index) => {
      const field = `evidence.reads[${index}]`;
      const read = requirePlainObject(entry, evidenceContext, field);
      rejectUnknownKeys(
        read,
        ['purpose', 'artifactId', 'contentHash', 'sizeBytes', 'durationMs', 'outcome', 'detail'],
        evidenceContext,
        field,
      );
      if (read.outcome !== 'read' && read.outcome !== 'failed') {
        throw validationError(evidenceContext, `${field}.outcome`, 'invalid_outcome');
      }
      return {
        purpose: validateExecutionInputPurpose(read.purpose, evidenceContext, `${field}.purpose`),
        artifactId: validateStableId(read.artifactId, evidenceContext, `${field}.artifactId`),
        contentHash: read.contentHash === null
          ? null
          : validateSha256Digest(read.contentHash, evidenceContext, `${field}.contentHash`),
        sizeBytes: read.sizeBytes === null
          ? null
          : validateNonNegativeInteger(read.sizeBytes, evidenceContext, `${field}.sizeBytes`),
        durationMs: validateNonNegativeInteger(read.durationMs, evidenceContext, `${field}.durationMs`),
        outcome: read.outcome,
        detail: read.detail === null
          ? null
          : requireNonEmptyString(read.detail, evidenceContext, `${field}.detail`),
      };
    }),
    recovery: {
      selectionMode: recovery.selectionMode as 'new' | 'auto' | 'required',
      selectionKind: recovery.selectionKind as RuntimeRecoveryKind | null,
      sourceArchiveArtifactId: recovery.sourceArchiveArtifactId === null
        ? null
        : validateStableId(recovery.sourceArchiveArtifactId, evidenceContext, 'evidence.recovery.sourceArchiveArtifactId'),
      decision: recovery.decision as 'new' | 'resume' | 'rejected',
      reasons: [...(recovery.reasons as readonly string[])],
    },
    totals: {
      refCount: validateNonNegativeInteger(totals.refCount, evidenceContext, 'evidence.totals.refCount'),
      totalBytes: validateNonNegativeInteger(totals.totalBytes, evidenceContext, 'evidence.totals.totalBytes'),
      readDurationMs: validateNonNegativeInteger(totals.readDurationMs, evidenceContext, 'evidence.totals.readDurationMs'),
    },
    createdAtUtcMs: validateNonNegativeInteger(raw.createdAtUtcMs, evidenceContext, 'evidence.createdAtUtcMs'),
  };
}
