/**
 * P03-6 / F-001 异步 Runtime 执行契约（ports 契约层：类型、常量、纯校验函数与
 * 适配器端口形态，无任何 I/O）。
 *
 * 设计依据：core-design/14-runtime-recovery-and-durable.md §1/§3/§6（Core 拥有
 * 授权、预算、验收与停止核验；RuntimeAdapter 是可替换端口；结果/事件/停止确认
 * 是不同事实）、core-design/05-runtime-and-session-recording.md（统一可见事件、
 * 稳定事件身份、用量 null 语义）与 input/p03-fake-runtime.md FR-1（事件
 * AsyncIterable、唯一 result、cancel 回执与独立 stopped Promise；未知终态明确
 * 失败；超时保留已知指标，不统一归零）。
 *
 * 契约要点：
 * - 恢复选择沿用 P03-3A `runtime-recovery.ts`：请求中的身份/executionVersion/
 *   invocationId/strategy/recovery 部分直接委托既有校验器，不重建第二套恢复
 *   Schema；本阶段执行请求只接受 Work 判别身份（Chat 服务留待后续阶段）；
 * - RuntimeRequest 固定 Project/Feature/Run/Task/Attempt/Session、owner 与
 *   hostInstanceId、executionVersion（fencing 代次）、完整实际策略、prompt 与
 *   inputManifest 不可变引用（ExecutionInputRef）、受控 cwd（获准根 ID + POSIX
 *   相对位置，绝不接受绝对路径）、权限（grants + isolation）与有限超时/事件/
 *   输出政策；
 * - RuntimeHandle 分别提供 events AsyncIterable、唯一 result Promise、cancel
 *   回执与独立 stopped Promise；不要求适配器返回 PID——进程身份属于
 *   CommandProcess 端口，不属于 Runtime 句柄；
 * - 事件/结果/停止证据/取消回执是适配器侧产出，畸形一律 RuntimeError('protocol')
 *   （未知终态 unknown_terminal 不映射成 failed）；schemaVersion 白名单严格匹配；
 *   缺少退出码/信号/用量/耗时必须为显式 null（键缺席即非法，绝不填 0）；
 *   F-004 起 tool_finished 可附加可选的 reason/outputBytes/lastActivityAtUtc
 *   （真实工具命令的实际原因、已知保留输出字节与最后活动时间；出现即受控校验）；
 * - 未知公开事件不中断流：classifyRuntimeEvent 判为 unknown，由会话层保留受限
 *   诊断（有界条目、有界长度），不透传未知 payload；
 * - 错误分类 RUNTIME_ERROR_KINDS 固定九类：configuration/missing_runtime/
 *   permission/protocol/process/timeout/authentication/provider/rate_limited；
 *   rate_limited 仅指真实硬限流；信息型限流告警是 warning 事件
 *   （code=rate_limit_notice），绝不作为 RuntimeError；
 * - 请求校验失败抛 StorageError(kind='validation')（调用方/配置侧错误）；
 *   适配器产出校验失败抛 RuntimeError(kind='protocol')（适配器违约）。两类
 *   错误来源不同，不混用。
 *
 * 实现者：application/runtime-execution.ts（可信注册消费 + 会话包装）。本层不
 * 实现任何适配器、不导入 Pi SDK/HTTP/ORM。
 */
import { isIsoUtcDateTime } from './commands.js';
import type { ExecutionInputRef } from './execution-input.js';
import { validateExecutionInputRef } from './execution-input.js';
import type {
  ExecutionIdentity,
  RuntimeRecoverySelection,
} from './runtime-recovery.js';
import { validateRuntimeRecoveryRequest } from './runtime-recovery.js';
import type { RuntimeStrategyV1 } from './settings-schema.js';
import { TOOL_TIMEOUT_MS_MAX, TOOL_TIMEOUT_MS_MIN, WORK_TIMEOUT_MS_MAX, WORK_TIMEOUT_MS_MIN } from './settings-schema.js';
import {
  rejectUnknownKeys, requireNonEmptyString, requirePlainObject,
  validateArtifactLocator, validatePositiveInteger, validateSha256Digest,
  validateStableId, validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 版本与边界常量
 * ------------------------------------------------------------------ */

export const RUNTIME_EXECUTION_SCHEMA_VERSION = 1;
export const RUNTIME_EVENT_SCHEMA_VERSION = 1;
export const RUNTIME_RESULT_SCHEMA_VERSION = 1;
export const RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION = 1;

/** 单次执行允许的事件数量上限（请求政策可收窄，不可放宽）。 */
export const RUNTIME_EXECUTION_MAX_EVENTS_LIMIT = 100_000;
/** 单次执行保留输出字节上限（与受控命令输出上限对齐）。 */
export const RUNTIME_EXECUTION_MAX_OUTPUT_BYTES_LIMIT = 8_388_608;
/** 权限授予条目数上限。 */
export const RUNTIME_EXECUTION_MAX_GRANTS = 64;
/** 事件预览/诊断消息的最大长度（受限诊断不放大未知内容）。 */
export const RUNTIME_EVENT_TEXT_MAX_LENGTH = 200;
/** 会话层保留的未知事件诊断条目上限（超出以 diagnostics_overflow 收尾）。 */
export const RUNTIME_SESSION_DIAGNOSTICS_MAX_COUNT = 32;

/* ------------------------------------------------------------------ *
 * 错误分类（协议/进程/限流等真实类别；信息型限流告警不在此列）
 * ------------------------------------------------------------------ */

export const RUNTIME_ERROR_KINDS = [
  'configuration', 'missing_runtime', 'permission', 'protocol', 'process',
  'timeout', 'authentication', 'provider', 'rate_limited',
] as const;
export type RuntimeErrorKind = (typeof RUNTIME_ERROR_KINDS)[number];

export interface RuntimeErrorOptions {
  readonly field?: string;
  readonly cause?: unknown;
}

/** Runtime 执行结构化错误；kind 区分失败来源，reason 是受限机器可读原因。 */
export class RuntimeError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly reason: string;
  constructor(kind: RuntimeErrorKind, reason: string, options: RuntimeErrorOptions = {}) {
    super(
      `RuntimeError(${kind}): ${reason}${options.field === undefined ? '' : ` at ${options.field}`}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'RuntimeError';
    this.kind = kind;
    this.reason = reason;
  }
}

export function isRuntimeError(value: unknown, kind?: RuntimeErrorKind): value is RuntimeError {
  return value instanceof RuntimeError && (kind === undefined || value.kind === kind);
}

function protocolError(reason: string, field?: string): RuntimeError {
  return new RuntimeError('protocol', reason, field === undefined ? {} : { field });
}

/** 适配器侧对象形态检查：违约一律 protocol（不使用 StorageError validation）。 */
function adapterObject(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError('not_an_object', field);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw protocolError('unknown_key', `${field}.${key}`);
  }
  return raw;
}

function adapterNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw protocolError('invalid_count', field);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * RuntimeRequest（Core → 适配器；校验失败为 StorageError validation）
 * ------------------------------------------------------------------ */

const requestContext: ValidationContext = { operation: 'RuntimeExecutionRequest.validate' };

/** 执行归属：可信装配注入的委托人 + Host 实例身份（不从请求数据取身份）。 */
export interface RuntimeExecutionOwner {
  readonly principalId: string;
  readonly hostInstanceId: string;
}

/** 受控 cwd：获准根 ID + POSIX 相对位置（'.' 表示根本身）；绝不接受绝对路径。 */
export interface RuntimeWorkingDirectory {
  readonly root: string;
  readonly relativePath: string;
}

/** 权限与隔离请求：适配器必须能逐项落实，无法落实即 permission 拒绝。 */
export interface RuntimeExecutionPermissions {
  readonly grants: readonly string[];
  readonly isolation: string;
}

/**
 * 脱敏 Work 访问快照：只携带同一 Attempt 的授权身份、策略摘要、认证状态
 * 和资源摘要。认证正文、owner token、Core 连接与环境值永远不进入请求。
 */
export interface RuntimeWorkAccessSnapshot {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly owner: RuntimeExecutionOwner;
  readonly strategy: { readonly runtime: 'pi'; readonly provider: string; readonly model: string };
  readonly permissions: RuntimeExecutionPermissions;
  readonly grantId: string;
  readonly policyDigest: string;
  readonly authentication: {
    readonly status: 'ready' | 'missing' | 'expired' | 'revoked' | 'invalid' | 'unknown';
    readonly digest: string;
    readonly sourceRef: string;
    readonly kind: 'environment' | 'local_login' | 'plugin';
  };
  readonly resources: {
    readonly digest: string;
    readonly entries: readonly {
      readonly id: string;
      readonly kind: 'auth_plugin' | 'skill' | 'mcp' | 'extension' | 'tool';
      readonly sourceRef: string;
      readonly version: string | null;
      readonly contentDigest: string | null;
      readonly status: 'available' | 'omitted';
      readonly capabilities: readonly string[];
      readonly transport: 'stdio' | 'streamable_http' | null;
    }[];
  };
}

/** 有限超时/输出政策：全部有上下界，不设无限值。 */
export interface RuntimeExecutionLimits {
  /** Session/单次 Work 总时长上限（旧字段语义保持不变）。 */
  readonly timeoutMs: number;
  /**
   * P03-9 / F-004：单工具调用上限（可选兼容扩展）。缺省时适配器仍以自身
   * 有限工具上限执行，但 Work 装配会显式提供；提供时不得超过 timeoutMs。
   */
  readonly toolTimeoutMs?: number;
  readonly maxEvents: number;
  readonly maxOutputBytes: number;
}

/** 异步执行请求：身份、策略、不可变输入引用、受控 cwd、权限与有限政策的固定组合。 */
export interface RuntimeExecutionRequest {
  readonly schemaVersion: typeof RUNTIME_EXECUTION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly featureId: string;
  readonly sessionId: string;
  readonly executionVersion: number;
  readonly owner: RuntimeExecutionOwner;
  readonly identity: ExecutionIdentity;
  readonly invocationId: string;
  readonly strategy: RuntimeStrategyV1;
  readonly prompt: ExecutionInputRef;
  readonly inputManifest: ExecutionInputRef;
  readonly cwd: RuntimeWorkingDirectory;
  readonly permissions: RuntimeExecutionPermissions;
  readonly limits: RuntimeExecutionLimits;
  readonly recovery: RuntimeRecoverySelection;
  readonly workAccess?: RuntimeWorkAccessSnapshot;
}

export function validateRuntimeWorkAccessSnapshot(value: unknown, expected: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly executionVersion: number;
  readonly identity: ExecutionIdentity;
  readonly invocationId: string;
  readonly strategy: RuntimeStrategyV1;
  readonly owner: RuntimeExecutionOwner;
  readonly permissions: RuntimeExecutionPermissions;
}): RuntimeWorkAccessSnapshot {
  const field = 'request.workAccess';
  const raw = requirePlainObject(value, requestContext, field);
  rejectUnknownKeys(raw, ['schemaVersion', 'projectId', 'runId', 'taskId', 'attemptId', 'invocationId', 'executionVersion',
    'owner', 'strategy', 'permissions', 'grantId', 'policyDigest', 'authentication', 'resources'], requestContext, field);
  if (raw.schemaVersion !== 1) throw validationError(requestContext, `${field}.schemaVersion`, '版本不受支持');
  const identity = expected.identity;
  if (identity.purpose !== 'work') throw validationError(requestContext, `${field}.identity`, 'work_identity_required');
  const projectId = validateStableId(raw.projectId, requestContext, `${field}.projectId`);
  const runId = validateStableId(raw.runId, requestContext, `${field}.runId`);
  const taskId = validateStableId(raw.taskId, requestContext, `${field}.taskId`);
  const attemptId = validateStableId(raw.attemptId, requestContext, `${field}.attemptId`);
  const invocationId = validateStableId(raw.invocationId, requestContext, `${field}.invocationId`);
  const executionVersion = validatePositiveInteger(raw.executionVersion, requestContext, `${field}.executionVersion`);
  const snapshotOwner = owner(raw.owner);
  const snapshotPermissions = permissions(raw.permissions);
  const strategyRaw = requirePlainObject(raw.strategy, requestContext, `${field}.strategy`);
  rejectUnknownKeys(strategyRaw, ['runtime', 'provider', 'model'], requestContext, `${field}.strategy`);
  if (strategyRaw.runtime !== 'pi') throw validationError(requestContext, `${field}.strategy.runtime`, 'pi_runtime_required');
  const strategy: RuntimeWorkAccessSnapshot['strategy'] = {
    runtime: 'pi',
    provider: requireNonEmptyString(strategyRaw.provider, requestContext, `${field}.strategy.provider`),
    model: requireNonEmptyString(strategyRaw.model, requestContext, `${field}.strategy.model`),
  };

  const digest = (entry: unknown, name: string) => validateSha256Digest(entry, requestContext, `${field}.${name}`);
  const grantId = validateStableId(raw.grantId, requestContext, `${field}.grantId`);
  const policyDigest = digest(raw.policyDigest, 'policyDigest');
  const authRaw = requirePlainObject(raw.authentication, requestContext, `${field}.authentication`);
  rejectUnknownKeys(authRaw, ['status', 'digest', 'sourceRef', 'kind'], requestContext, `${field}.authentication`);
  const authStatus = authRaw.status;
  if (!['ready', 'missing', 'expired', 'revoked', 'invalid', 'unknown'].includes(authStatus as string)) {
    throw validationError(requestContext, `${field}.authentication.status`, 'invalid_authentication_status');
  }
  const authentication = {
    status: authStatus as RuntimeWorkAccessSnapshot['authentication']['status'],
    digest: digest(authRaw.digest, 'authentication.digest'),
    sourceRef: validateStableId(authRaw.sourceRef, requestContext, `${field}.authentication.sourceRef`),
    kind: authRaw.kind,
  } as RuntimeWorkAccessSnapshot['authentication'];
  if (!['environment', 'local_login', 'plugin'].includes(authentication.kind)) {
    throw validationError(requestContext, `${field}.authentication.kind`, 'invalid_authentication_kind');
  }
  const resourcesRaw = requirePlainObject(raw.resources, requestContext, `${field}.resources`);
  rejectUnknownKeys(resourcesRaw, ['digest', 'entries'], requestContext, `${field}.resources`);
  if (!Array.isArray(resourcesRaw.entries) || resourcesRaw.entries.length > 64) {
    throw validationError(requestContext, `${field}.resources.entries`, 'invalid_resource_entries');
  }
  const entries = resourcesRaw.entries.map((entry, index) => {
    const item = requirePlainObject(entry, requestContext, `${field}.resources.entries[${index}]`);
    rejectUnknownKeys(item, ['id', 'kind', 'sourceRef', 'version', 'contentDigest', 'status', 'capabilities', 'transport'], requestContext, `${field}.resources.entries[${index}]`);
    const kind = item.kind;
    if (!['auth_plugin', 'skill', 'mcp', 'extension', 'tool'].includes(kind as string)) throw validationError(requestContext, `${field}.resources.entries[${index}].kind`, 'invalid_resource_kind');
    const transport = item.transport;
    if (transport !== null && transport !== 'stdio' && transport !== 'streamable_http') throw validationError(requestContext, `${field}.resources.entries[${index}].transport`, 'invalid_resource_transport');
    if ((kind === 'mcp') !== (transport !== null)) throw validationError(requestContext, `${field}.resources.entries[${index}].transport`, 'resource_transport_mismatch');
    if (typeof item.version !== 'string' && item.version !== null) throw validationError(requestContext, `${field}.resources.entries[${index}].version`, 'invalid_resource_version');
    if (item.contentDigest !== null) digest(item.contentDigest, `resources.entries[${index}].contentDigest`);
    if (item.version === null && item.contentDigest === null) throw validationError(requestContext, `${field}.resources.entries[${index}]`, 'resource_identity_missing');
    if (item.status !== 'available' && item.status !== 'omitted') throw validationError(requestContext, `${field}.resources.entries[${index}].status`, 'invalid_resource_status');
    if (!Array.isArray(item.capabilities) || item.capabilities.some(capability => typeof capability !== 'string')) throw validationError(requestContext, `${field}.resources.entries[${index}].capabilities`, 'invalid_resource_capabilities');
    return {
      id: validateStableId(item.id, requestContext, `${field}.resources.entries[${index}].id`),
      kind: kind as RuntimeWorkAccessSnapshot['resources']['entries'][number]['kind'],
      sourceRef: validateStableId(item.sourceRef, requestContext, `${field}.resources.entries[${index}].sourceRef`),
      version: item.version as string | null, contentDigest: item.contentDigest as string | null,
      status: item.status as 'available' | 'omitted', capabilities: [...item.capabilities] as string[],
      transport: transport as 'stdio' | 'streamable_http' | null,
    };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw validationError(requestContext, `${field}.resources.entries`, 'duplicate_resource');
  const resources = { digest: digest(resourcesRaw.digest, 'resources.digest'), entries };
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (projectId !== expected.projectId || runId !== identity.runId || taskId !== identity.taskId || attemptId !== identity.attemptId
    || invocationId !== expected.invocationId || executionVersion !== expected.executionVersion || !same(snapshotOwner, expected.owner)
    || !same(strategy, { runtime: expected.strategy.runtime, provider: expected.strategy.provider, model: expected.strategy.model })
    || !same(snapshotPermissions, expected.permissions)) {
    throw validationError(requestContext, field, 'attempt_access_identity_mismatch');
  }
  return { schemaVersion: 1, projectId, runId, taskId, attemptId, invocationId, executionVersion,
    owner: snapshotOwner, strategy, permissions: snapshotPermissions, grantId, policyDigest, authentication, resources };
}

function owner(value: unknown): RuntimeExecutionOwner {
  const field = 'request.owner';
  const raw = requirePlainObject(value, requestContext, field);
  rejectUnknownKeys(raw, ['principalId', 'hostInstanceId'], requestContext, field);
  return {
    principalId: validateStableId(raw.principalId, requestContext, `${field}.principalId`),
    hostInstanceId: validateStableId(raw.hostInstanceId, requestContext, `${field}.hostInstanceId`),
  };
}

function cwd(value: unknown): RuntimeWorkingDirectory {
  const field = 'request.cwd';
  const raw = requirePlainObject(value, requestContext, field);
  rejectUnknownKeys(raw, ['root', 'relativePath'], requestContext, field);
  const relativePath = requireNonEmptyString(raw.relativePath, requestContext, `${field}.relativePath`);
  return {
    root: validateStableId(raw.root, requestContext, `${field}.root`),
    relativePath: relativePath === '.'
      ? relativePath
      : validateArtifactLocator(relativePath, requestContext, `${field}.relativePath`),
  };
}

function permissions(value: unknown): RuntimeExecutionPermissions {
  const field = 'request.permissions';
  const raw = requirePlainObject(value, requestContext, field);
  rejectUnknownKeys(raw, ['grants', 'isolation'], requestContext, field);
  if (!Array.isArray(raw.grants) || raw.grants.length > RUNTIME_EXECUTION_MAX_GRANTS) {
    throw validationError(requestContext, `${field}.grants`, '必须是有界数组（权限授予条目）');
  }
  const grants = raw.grants.map((grant, index) =>
    validateStableId(grant, requestContext, `${field}.grants[${index}]`));
  if (new Set(grants).size !== grants.length) {
    throw validationError(requestContext, `${field}.grants`, '不允许重复授予');
  }
  return {
    grants,
    isolation: validateStableId(raw.isolation, requestContext, `${field}.isolation`),
  };
}

function limits(value: unknown): RuntimeExecutionLimits {
  const field = 'request.limits';
  const raw = requirePlainObject(value, requestContext, field);
  rejectUnknownKeys(raw, ['timeoutMs', 'toolTimeoutMs', 'maxEvents', 'maxOutputBytes'], requestContext, field);
  const timeoutMs = validatePositiveInteger(raw.timeoutMs, requestContext, `${field}.timeoutMs`);
  if (timeoutMs < WORK_TIMEOUT_MS_MIN || timeoutMs > WORK_TIMEOUT_MS_MAX) {
    throw validationError(requestContext, `${field}.timeoutMs`, '超出允许范围（有限超时政策）');
  }
  let toolTimeoutMs: number | undefined;
  if (raw.toolTimeoutMs !== undefined) {
    const toolLimit = validatePositiveInteger(raw.toolTimeoutMs, requestContext, `${field}.toolTimeoutMs`);
    if (toolLimit < TOOL_TIMEOUT_MS_MIN || toolLimit > TOOL_TIMEOUT_MS_MAX) {
      throw validationError(requestContext, `${field}.toolTimeoutMs`, '超出允许范围（有限工具超时政策）');
    }
    if (toolLimit > timeoutMs) {
      throw validationError(requestContext, `${field}.toolTimeoutMs`, '不得大于 Session 总时长上限');
    }
    toolTimeoutMs = toolLimit;
  }
  const maxEvents = validatePositiveInteger(raw.maxEvents, requestContext, `${field}.maxEvents`);
  if (maxEvents > RUNTIME_EXECUTION_MAX_EVENTS_LIMIT) {
    throw validationError(requestContext, `${field}.maxEvents`, '超出事件数量上限');
  }
  const maxOutputBytes = validatePositiveInteger(raw.maxOutputBytes, requestContext, `${field}.maxOutputBytes`);
  if (maxOutputBytes > RUNTIME_EXECUTION_MAX_OUTPUT_BYTES_LIMIT) {
    throw validationError(requestContext, `${field}.maxOutputBytes`, '超出输出字节上限');
  }
  return {
    timeoutMs,
    ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    maxEvents,
    maxOutputBytes,
  };
}

/**
 * 执行请求校验：身份/executionVersion/invocationId/strategy/recovery 部分直接
 * 委托 P03-3A `validateRuntimeRecoveryRequest`（沿用而非重建恢复协议），返回
 * 值与调用方对象完全分离；本阶段只接受 Work 判别身份。
 */
export function validateRuntimeExecutionRequest(value: unknown): RuntimeExecutionRequest {
  const raw = requirePlainObject(value, requestContext, 'request');
  rejectUnknownKeys(raw, [
    'schemaVersion', 'projectId', 'featureId', 'sessionId', 'executionVersion', 'owner',
    'identity', 'invocationId', 'strategy', 'prompt', 'inputManifest', 'cwd',
    'permissions', 'limits', 'recovery', 'workAccess',
  ], requestContext, 'request');
  const recoveryPortion = validateRuntimeRecoveryRequest({
    schemaVersion: raw.schemaVersion, projectId: raw.projectId, sessionId: raw.sessionId,
    executionVersion: raw.executionVersion, identity: raw.identity,
    invocationId: raw.invocationId, strategy: raw.strategy, recovery: raw.recovery,
  });
  if (recoveryPortion.identity.purpose !== 'work') {
    throw validationError(requestContext, 'request.identity.purpose', 'work_identity_required');
  }
  return {
    schemaVersion: RUNTIME_EXECUTION_SCHEMA_VERSION,
    projectId: recoveryPortion.projectId,
    featureId: validateStableId(raw.featureId, requestContext, 'request.featureId'),
    sessionId: recoveryPortion.sessionId,
    executionVersion: recoveryPortion.executionVersion,
    owner: owner(raw.owner),
    identity: recoveryPortion.identity,
    invocationId: recoveryPortion.invocationId,
    strategy: recoveryPortion.strategy,
    prompt: validateExecutionInputRef(raw.prompt, requestContext.operation),
    inputManifest: validateExecutionInputRef(raw.inputManifest, requestContext.operation),
    cwd: cwd(raw.cwd),
    permissions: permissions(raw.permissions),
    limits: limits(raw.limits),
    recovery: recoveryPortion.recovery,
    ...(raw.workAccess === undefined ? {} : {
      workAccess: validateRuntimeWorkAccessSnapshot(raw.workAccess, {
        projectId: recoveryPortion.projectId, sessionId: recoveryPortion.sessionId,
        executionVersion: recoveryPortion.executionVersion, identity: recoveryPortion.identity,
        invocationId: recoveryPortion.invocationId, strategy: recoveryPortion.strategy,
        owner: owner(raw.owner), permissions: permissions(raw.permissions),
      }),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 事件（适配器 → Core；违约为 RuntimeError protocol）
 * ------------------------------------------------------------------ */

export const RUNTIME_EVENT_KINDS = [
  'message', 'tool_started', 'tool_finished', 'usage', 'warning', 'diagnostic',
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

/** 告警代码：rate_limit_notice 是信息型限流告警，不是硬限流错误。 */
export const RUNTIME_WARNING_CODES = ['rate_limit_notice', 'generic'] as const;
export type RuntimeWarningCode = (typeof RUNTIME_WARNING_CODES)[number];

export const RUNTIME_EVENT_ROLES = ['assistant', 'user', 'system', 'tool'] as const;
export type RuntimeEventRole = (typeof RUNTIME_EVENT_ROLES)[number];

/** 用量声明：basis 区分 synthetic（Fake/测试）与 reported（供应商报告）；未知为 null。 */
export interface RuntimeUsageReport {
  readonly basis: 'synthetic' | 'reported';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
  /** SDK 统计范围不确定或只覆盖部分观察事实时显式保留缺口。 */
  readonly completeness?: 'complete' | 'partial' | 'unknown';
  readonly accounting?: 'incremental' | 'cumulative' | 'unknown';
}

export type RuntimeEventPayload =
  | { readonly kind: 'message'; readonly messageId: string; readonly role: RuntimeEventRole; readonly preview: string }
  | { readonly kind: 'tool_started'; readonly toolCallId: string; readonly toolName: string }
  /**
   * tool_finished：F-001 三键（toolCallId/exitCode/signal）必填；F-004 起可
   * 选附加 reason（实际原因 token，正常退出为 null）、outputBytes（已知保留
   * 输出字节）与 lastActivityAtUtc（最后活动时间，无活动为 null）。可选键
   * 出现时必须为显式值或 null，不填 0/不伪造。
   */
  | { readonly kind: 'tool_finished'; readonly toolCallId: string; readonly exitCode: number | null; readonly signal: string | null;
      readonly reason?: string | null; readonly outputBytes?: number | null; readonly lastActivityAtUtc?: string | null }
  | { readonly kind: 'usage'; readonly usage: RuntimeUsageReport }
  | { readonly kind: 'warning'; readonly code: RuntimeWarningCode; readonly message: string }
  | { readonly kind: 'diagnostic'; readonly code: string; readonly message: string };

/** 公开事件：稳定 eventId（去重身份）、严格递增 sequence、UTC 时间与按 kind 限定的 payload。 */
export interface RuntimeEvent {
  readonly schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly kind: RuntimeEventKind;
  readonly sequence: number;
  readonly occurredAtUtc: string;
  readonly payload: RuntimeEventPayload;
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > RUNTIME_EVENT_TEXT_MAX_LENGTH) {
    throw protocolError('invalid_text', field);
  }
  return value;
}

function eventToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw protocolError('invalid_token', field);
  }
  return value;
}

function nullableExitCode(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw protocolError('invalid_exit_code', field);
  }
  return value;
}

function nullableToken(value: unknown, field: string): string | null {
  if (value === null) return null;
  return eventToken(value, field);
}

function nullableCount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw protocolError('invalid_count', field);
  }
  return value;
}

export function validateRuntimeUsageReport(value: unknown, field = 'usage'): RuntimeUsageReport {
  const raw = adapterObject(value, ['basis', 'inputTokens', 'outputTokens', 'costUsdMicros', 'completeness', 'accounting'], field);
  if (raw.basis !== 'synthetic' && raw.basis !== 'reported') {
    throw protocolError('invalid_usage_basis', `${field}.basis`);
  }
  if (raw.completeness !== undefined && raw.completeness !== 'complete' && raw.completeness !== 'partial' && raw.completeness !== 'unknown') {
    throw protocolError('invalid_usage_completeness', `${field}.completeness`);
  }
  if (raw.accounting !== undefined && raw.accounting !== 'incremental' && raw.accounting !== 'cumulative' && raw.accounting !== 'unknown') {
    throw protocolError('invalid_usage_accounting', `${field}.accounting`);
  }
  return {
    basis: raw.basis,
    inputTokens: nullableCount(raw.inputTokens, `${field}.inputTokens`),
    outputTokens: nullableCount(raw.outputTokens, `${field}.outputTokens`),
    costUsdMicros: nullableCount(raw.costUsdMicros, `${field}.costUsdMicros`),
    ...(raw.completeness === undefined ? {} : { completeness: raw.completeness as RuntimeUsageReport['completeness'] }),
    ...(raw.accounting === undefined ? {} : { accounting: raw.accounting as RuntimeUsageReport['accounting'] }),
  };
}

function eventPayload(kind: RuntimeEventKind, value: unknown): RuntimeEventPayload {
  const field = 'event.payload';
  const raw = adapterObject(value, payloadKeys(kind), field);
  switch (kind) {
    case 'message': {
      const role = raw.role;
      if (typeof role !== 'string' || !(RUNTIME_EVENT_ROLES as readonly string[]).includes(role)) {
        throw protocolError('invalid_role', `${field}.role`);
      }
      return { kind, messageId: eventToken(raw.messageId, `${field}.messageId`),
        role: role as RuntimeEventRole, preview: boundedText(raw.preview, `${field}.preview`) };
    }
    case 'tool_started':
      return { kind, toolCallId: eventToken(raw.toolCallId, `${field}.toolCallId`),
        toolName: eventToken(raw.toolName, `${field}.toolName`) };
    case 'tool_finished': {
      const finished: {
        kind: RuntimeEventKind; toolCallId: string; exitCode: number | null; signal: string | null;
        reason?: string | null; outputBytes?: number | null; lastActivityAtUtc?: string | null;
      } = { kind, toolCallId: eventToken(raw.toolCallId, `${field}.toolCallId`),
        exitCode: nullableExitCode(raw.exitCode, `${field}.exitCode`),
        signal: nullableToken(raw.signal, `${field}.signal`) };
      if (raw.reason !== undefined) {
        finished.reason = nullableToken(raw.reason, `${field}.reason`);
      }
      if (raw.outputBytes !== undefined) {
        finished.outputBytes = nullableCount(raw.outputBytes, `${field}.outputBytes`);
      }
      if (raw.lastActivityAtUtc !== undefined) {
        if (raw.lastActivityAtUtc === null) finished.lastActivityAtUtc = null;
        else if (isIsoUtcDateTime(raw.lastActivityAtUtc)) finished.lastActivityAtUtc = raw.lastActivityAtUtc;
        else throw protocolError('invalid_timestamp', `${field}.lastActivityAtUtc`);
      }
      return finished as RuntimeEventPayload;
    }
    case 'usage':
      return { kind, usage: validateRuntimeUsageReport(raw, field) };
    case 'warning': {
      if (typeof raw.code !== 'string' || !(RUNTIME_WARNING_CODES as readonly string[]).includes(raw.code)) {
        throw protocolError('invalid_warning_code', `${field}.code`);
      }
      return { kind, code: raw.code as RuntimeWarningCode, message: boundedText(raw.message, `${field}.message`) };
    }
    case 'diagnostic':
      return { kind, code: eventToken(raw.code, `${field}.code`), message: boundedText(raw.message, `${field}.message`) };
  }
}

function payloadKeys(kind: RuntimeEventKind): readonly string[] {
  switch (kind) {
    case 'message': return ['messageId', 'role', 'preview'];
    case 'tool_started': return ['toolCallId', 'toolName'];
    case 'tool_finished': return ['toolCallId', 'exitCode', 'signal', 'reason', 'outputBytes', 'lastActivityAtUtc'];
    case 'usage': return ['basis', 'inputTokens', 'outputTokens', 'costUsdMicros', 'completeness', 'accounting'];
    case 'warning': return ['code', 'message'];
    case 'diagnostic': return ['code', 'message'];
  }
}

/** 已知 kind 事件的完整校验；未知 kind 抛 protocol('unknown_event_kind')。 */
export function validateRuntimeEvent(value: unknown): RuntimeEvent {
  const field = 'event';
  const raw = adapterObject(value, ['schemaVersion', 'eventId', 'kind', 'sequence', 'occurredAtUtc', 'payload'], field);
  if (raw.schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw protocolError('unsupported_schema_version', `${field}.schemaVersion`);
  }
  if (typeof raw.kind !== 'string' || !(RUNTIME_EVENT_KINDS as readonly string[]).includes(raw.kind)) {
    throw protocolError('unknown_event_kind', `${field}.kind`);
  }
  if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) {
    throw protocolError('invalid_sequence', `${field}.sequence`);
  }
  if (!isIsoUtcDateTime(raw.occurredAtUtc)) {
    throw protocolError('invalid_timestamp', `${field}.occurredAtUtc`);
  }
  const kind = raw.kind as RuntimeEventKind;
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: eventToken(raw.eventId, `${field}.eventId`),
    kind, sequence: raw.sequence, occurredAtUtc: raw.occurredAtUtc,
    payload: eventPayload(kind, raw.payload),
  };
}

/** 事件分类：valid（完整合法）/ unknown（未知 kind，保留受限诊断）/ invalid（畸形，protocol 错误）。 */
export type RuntimeEventClassification =
  | { readonly outcome: 'valid'; readonly event: RuntimeEvent }
  | { readonly outcome: 'unknown'; readonly observedKind: string }
  | { readonly outcome: 'invalid'; readonly reason: string };

export function classifyRuntimeEvent(value: unknown): RuntimeEventClassification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { outcome: 'invalid', reason: 'not_an_object' };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) {
    return { outcome: 'invalid', reason: 'unsupported_schema_version' };
  }
  if (typeof raw.kind === 'string' && !(RUNTIME_EVENT_KINDS as readonly string[]).includes(raw.kind)) {
    return { outcome: 'unknown', observedKind: raw.kind.slice(0, RUNTIME_EVENT_TEXT_MAX_LENGTH) };
  }
  try {
    return { outcome: 'valid', event: validateRuntimeEvent(value) };
  } catch (error) {
    return { outcome: 'invalid', reason: isRuntimeError(error) ? error.reason : 'invalid_event' };
  }
}

/* ------------------------------------------------------------------ *
 * 结果 / 停止证据 / 取消回执（适配器 → Core；违约为 RuntimeError protocol）
 * ------------------------------------------------------------------ */

export const RUNTIME_TERMINAL_STATES = ['completed', 'failed', 'cancelled', 'timed_out'] as const;
export type RuntimeTerminalState = (typeof RUNTIME_TERMINAL_STATES)[number];

/**
 * 一次结算的最终结果：退出码/信号/用量/耗时未知时必须为显式 null（键缺席即
 * protocol 违约，绝不填 0）；未知终态拒绝为 protocol('unknown_terminal')，
 * 不映射成 failed。结果不携带 Task passed——验收是 Core 职责。
 */
export interface RuntimeExecutionResult {
  readonly schemaVersion: typeof RUNTIME_RESULT_SCHEMA_VERSION;
  readonly terminal: RuntimeTerminalState;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly usage: RuntimeUsageReport | null;
  readonly lastEventSequence: number | null;
  /** Provider-native identity is evidence, never the Core Attempt identity. */
  readonly providerSessionId?: string | null;
  /** Event IDs for bounded diagnostics emitted during this invocation. */
  readonly diagnosticRefs?: readonly string[];
}

export function validateRuntimeExecutionResult(value: unknown): RuntimeExecutionResult {
  const field = 'result';
  const raw = adapterObject(value, [
    'schemaVersion', 'terminal', 'reason', 'exitCode', 'signal', 'durationMs', 'usage', 'lastEventSequence',
    'providerSessionId', 'diagnosticRefs',
  ], field);
  if (raw.schemaVersion !== RUNTIME_RESULT_SCHEMA_VERSION) {
    throw protocolError('unsupported_schema_version', `${field}.schemaVersion`);
  }
  if (typeof raw.terminal !== 'string' || !(RUNTIME_TERMINAL_STATES as readonly string[]).includes(raw.terminal)) {
    throw protocolError('unknown_terminal', `${field}.terminal`);
  }
  const usage = raw.usage === null ? null : validateRuntimeUsageReport(raw.usage, `${field}.usage`);
  const providerSessionId = raw.providerSessionId === undefined || raw.providerSessionId === null
    ? raw.providerSessionId
    : eventToken(raw.providerSessionId, `${field}.providerSessionId`);
  let diagnosticRefs: string[] | undefined;
  if (raw.diagnosticRefs !== undefined) {
    if (!Array.isArray(raw.diagnosticRefs) || raw.diagnosticRefs.length > RUNTIME_SESSION_DIAGNOSTICS_MAX_COUNT) {
      throw protocolError('invalid_diagnostic_refs', `${field}.diagnosticRefs`);
    }
    diagnosticRefs = raw.diagnosticRefs.map((ref, index) => eventToken(ref, `${field}.diagnosticRefs[${index}]`));
  }
  return {
    schemaVersion: RUNTIME_RESULT_SCHEMA_VERSION,
    terminal: raw.terminal as RuntimeTerminalState,
    reason: raw.reason === null ? null : eventToken(raw.reason, `${field}.reason`),
    exitCode: nullableExitCode(raw.exitCode, `${field}.exitCode`),
    signal: nullableToken(raw.signal, `${field}.signal`),
    durationMs: nullableCount(raw.durationMs, `${field}.durationMs`),
    usage,
    lastEventSequence: raw.lastEventSequence === null
      ? null
      : adapterNonNegativeInteger(raw.lastEventSequence, `${field}.lastEventSequence`),
    ...(raw.providerSessionId === undefined ? {} : { providerSessionId }),
    ...(diagnosticRefs === undefined ? {} : { diagnosticRefs }),
  };
}

/**
 * 停止证据：独立于结果。confirmed=false 表示停止未被核验（调用方必须保留
 * 占用/隔离现场），绝不因 result 完成或 cancel 接受而冒充 confirmed。
 */
export interface RuntimeStopEvidence {
  readonly schemaVersion: typeof RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION;
  readonly confirmed: boolean;
  readonly checkedAtUtc: string;
  readonly detail: string | null;
}

export function validateRuntimeStopEvidence(value: unknown): RuntimeStopEvidence {
  const field = 'stopEvidence';
  const raw = adapterObject(value, ['schemaVersion', 'confirmed', 'checkedAtUtc', 'detail'], field);
  if (raw.schemaVersion !== RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION) {
    throw protocolError('unsupported_schema_version', `${field}.schemaVersion`);
  }
  if (typeof raw.confirmed !== 'boolean') throw protocolError('invalid_confirmed', `${field}.confirmed`);
  if (!isIsoUtcDateTime(raw.checkedAtUtc)) throw protocolError('invalid_timestamp', `${field}.checkedAtUtc`);
  return {
    schemaVersion: RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
    confirmed: raw.confirmed, checkedAtUtc: raw.checkedAtUtc,
    detail: raw.detail === null ? null : boundedText(raw.detail, `${field}.detail`),
  };
}

/** 取消回执：accepted 是「接受取消请求」，不是停止确认；重复取消幂等。 */
export interface RuntimeCancelReceipt {
  readonly accepted: boolean;
  readonly reason: string | null;
}

export function validateRuntimeCancelReceipt(value: unknown): RuntimeCancelReceipt {
  const field = 'cancelReceipt';
  const raw = adapterObject(value, ['accepted', 'reason'], field);
  if (typeof raw.accepted !== 'boolean') throw protocolError('invalid_accepted', `${field}.accepted`);
  return {
    accepted: raw.accepted,
    reason: raw.reason === null ? null : eventToken(raw.reason, `${field}.reason`),
  };
}

/* ------------------------------------------------------------------ *
 * 适配器端口（可信装配注入；不强制返回 PID，不热加载模块）
 * ------------------------------------------------------------------ */

/**
 * 适配器返回的执行句柄：events/result/stopped 产出可以是未校验原始值，由
 * 会话层逐项运行时校验。不要求也不解释 PID——受控进程身份属于
 * CommandProcess 端口的 launch/identity 通道。
 */
export interface RuntimeNativeSessionReference {
  readonly runtimeId: string;
  readonly providerSessionId: string | null;
  readonly sessionFile: string | null;
}

export interface RuntimeHandle {
  readonly events: AsyncIterable<unknown>;
  readonly result: Promise<unknown>;
  readonly stopped: Promise<unknown>;
  readonly nativeSession?: RuntimeNativeSessionReference;
  cancel(): Promise<unknown>;
}

/**
 * 可替换 Runtime 适配器窄端口：start 接收已通过
 * `validateRuntimeExecutionRequest` 的请求并异步返回句柄。实现不得据此更新
 * Core 业务表、不得自行决定恢复来源、不得把结果冒充 Task 验收。
 */
export interface RuntimeAdapter {
  start(request: RuntimeExecutionRequest): Promise<RuntimeHandle>;
}
