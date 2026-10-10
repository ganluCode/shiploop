/**
 * F-013 HostClient 应用能力（P02-2 契约 §11.2）：命令提交（冻结信封、超时
 * 先查回执、有限重发、outcome_unknown）、回执/结果读取、授权查询与快照、
 * SSE 订阅（跨分块解析、有界去重、snapshot_required 恢复分支、自动重连）。
 *
 * 规则落实：
 * - 只访问 §3.2 正式路由；不打开 SQLite、不直读业务文件；凭据只经
 *   Authorization 头发送，绝不跟随重定向（http-json 层已冻结 3xx 拒绝）；
 * - 一次逻辑命令一个冻结信封：commandId/issuedAt/expiresAt/payload 在首次
 *   发送前冻结，重发逐字节相同（同一对象序列化）；超时/响应丢失先等待一个
 *   有界提交窗口（SUBMIT_RECEIPT_GRACE_MS）再查该 principal 名下回执，
 *   回执未知才在有限预算（submitBudgetMs / SUBMIT_MAX_ATTEMPTS）内重发；
 *   连接失败不折算为业务拒绝或完成；预算耗尽 → outcome_unknown（保留
 *   commandId 供事后查回执）；AbortSignal 立即以 unreachable(aborted) 中止，
 *   不产生新请求；
 * - 响应运行时校验复用 app-wire 纯校验器（畸形/未知版本 → 协议错误，
 *   不重试）；非 200 且体为合法回执（§5.7 rejected 唯一映射）按回执返回；
 * - SSE：建连等待响应头（非 200 按错误体映射，建连前 409 snapshot_required
 *   是明确恢复分支）；帧解析处理跨分块 UTF-8（TextDecoder stream）与心跳
 *   注释；eventId 去重缓存有界（512，FIFO 逐出，不阻塞新事件）；断线在
 *   有限预算内以 Last-Event-ID 自动重连；建连后 snapshot_required /
 *   stream_overflow 以对应 EventStreamEnd 结束；close()/AbortSignal 只释放
 *   本地观察资源（销毁本连接），绝不触发 stop/cancel；
 * - 事件帧 262 144 B、接收缓冲 1 048 576 B 上限（超限 protocol_error，
 *   不无限缓冲）；重连最多 5 次、间隔 200 ms（§15.6 登记实施值）。
 *
 * import 本模块无副作用：不发起网络、不读文件系统/argv/env。
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import {
  computeCommandRequestDigest,
  isUuidV4,
  isValidResultRef,
  validateCommandEnvelope,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from 'shiploop-core/protocol';
import type {
  AppOperation,
  BaselineDetailResult,
  BaselineListResult,
  CommandReceipt,
  CommandScope,
  EffectiveSettings,
  ExportedSettings,
  GlobalSnapshotResult,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectInspectionResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  ProjectOverviewResult,
  ProjectSnapshotResult,
  PublicSettingsState,
  PublicStateEvent,
  SettingsScope,
  SnapshotResult,
} from 'shiploop-core/protocol';
import {
  APP_REQUEST_TIMEOUT_MS,
  ARTIFACT_CONTENT_ROUTE_SUFFIX,
  ARTIFACTS_ROUTE_PREFIX,
  BASELINES_ROUTE_PREFIX,
  COMMANDS_ROUTE,
  EVENTS_ROUTE,
  HostProtocolError,
  MAX_APP_BODY_BYTES,
  MAX_ARTIFACT_CONTENT_BYTES,
  PROJECTS_INSPECT_ROUTE,
  PROJECTS_ROUTE,
  PROJECT_LABEL_COUNTS_ROUTE,
  RECEIPTS_ROUTE_PREFIX,
  RESULTS_ROUTE_PREFIX,
  SETTINGS_GLOBAL_EXPORT_ROUTE,
  SETTINGS_GLOBAL_ROUTE,
  SNAPSHOT_ROUTE,
  SUBMIT_COMMAND_BUDGET_MS,
  isHostProtocolError,
  isPlainObject,
} from '../contract/index.js';
import type { HostOperation } from '../contract/index.js';
import { mapErrorResponse, requestLoopbackJson, requestLoopbackText } from './http-json.js';
import {
  validateAppQueryResponse,
  validateBaselineCommandResultWire,
  validateBaselinePreviewResultWire,
  validateCommandReceiptWire,
  validateStateEventWire,
} from './app-wire.js';

/* ------------------------------------------------------------------ *
 * 预算与重试策略（有限默认值，§15.6 登记）
 * ------------------------------------------------------------------ */

/** 响应丢失后、首次查回执前的提交窗口（ms）：给 Host 完成在途提交的有限余量。 */
export const SUBMIT_RECEIPT_GRACE_MS = 1_000;
/** 重发冻结信封前的有限间隔（ms）。 */
export const SUBMIT_RETRY_DELAY_MS = 100;
/** 一个逻辑命令的最大提交尝试次数（首发 + 有限重发）。 */
export const SUBMIT_MAX_ATTEMPTS = 3;

/** §13：eventId 去重缓存上限（每连接，FIFO 逐出）。 */
export const EVENT_ID_CACHE_LIMIT = 512;
/** 单个 SSE 帧字节上限（与服务端单批序列化上限一致）。 */
export const MAX_SSE_FRAME_BYTES = 262_144;
/** SSE 接收缓冲上限（不无限缓冲未终结帧）。 */
export const MAX_SSE_BUFFER_BYTES = 1_048_576;
/** 断线自动重连上限与间隔（有限预算；耗尽以 protocol_error 结束观察）。 */
export const EVENT_RECONNECT_MAX_ATTEMPTS = 5;
export const EVENT_RECONNECT_DELAY_MS = 200;

/* ------------------------------------------------------------------ *
 * 公共类型
 * ------------------------------------------------------------------ */

/** 一次逻辑命令的输入；commandId/issuedAt/expiresAt 缺省在首次发送前生成一次并冻结。 */
export interface SubmitCommandInput {
  readonly commandId?: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly expectedRevision?: number;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly payload: unknown;
}

export interface SubmitCommandOptions {
  /** 中止信号：立即以 unreachable(aborted) 拒绝，不折算 outcome_unknown。 */
  readonly signal?: AbortSignal;
}

/** 项目列表分页/筛选输入（§7.1；取值规则由 Core 复核，客户端做形态把关）。 */
export interface ListProjectsInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly labels?: readonly string[];
  readonly match?: 'any' | 'all';
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 基线面输入/输出类型（§6/§7.4-§7.6）
 * ------------------------------------------------------------------ */

/** baseline.preview 输入（plan 形状由 Core 深校验，客户端只做结构把关）。 */
export interface PreviewBaselineInput {
  readonly projectId: string;
  readonly plan: unknown;
  readonly commandId?: string;
}

/** baseline.run 输入：decision/plan/previewDigest 绑定用户确认的完整输入摘要。 */
export interface RunBaselineInput {
  readonly projectId: string;
  readonly decision: 'authorize' | 'decline';
  readonly plan: unknown;
  readonly previewDigest: string;
  readonly commandId?: string;
}

/** baselines.list 分页输入（§7.4：limit 1..100；cursor 为上一页最后 operationId）。 */
export interface ListBaselinesInput {
  readonly limit?: number;
  readonly cursor?: string;
}

/** artifacts.get 的授权证据正文（§7.6：text/plain 有界内容，已脱敏）。 */
export interface BaselineArtifactContentResult {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly content: string;
}

/** SSE 订阅输入：恢复位置 cursor/lastEventId 至少其一（缺省零网络拒绝）。 */
export interface SubscribeEventsInput {
  readonly scope: SettingsScope;
  readonly cursor?: string;
  readonly lastEventId?: string;
  readonly onEvent: (event: PublicStateEvent) => void;
  readonly signal?: AbortSignal;
}

/** 观察流结束原因（全部明确分类；不折算成功/业务完成）。 */
export type EventStreamEnd =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'protocol_error'; readonly reason: string }
  | { readonly kind: 'snapshot_required'; readonly snapshotRoute: string }
  | { readonly kind: 'stream_overflow'; readonly snapshotRoute: string };

/** 活跃 SSE 订阅句柄；close 幂等，只释放本地观察资源。 */
export interface HostEventSubscription {
  /** 流结束即 resolve（绝不 reject）。 */
  readonly ended: Promise<EventStreamEnd>;
  /** 最后一个成功投递事件的 eventId（自动重连的 Last-Event-ID）。 */
  lastEventId(): string | undefined;
  /** 建连使用的恢复游标（订阅期间不变）。 */
  resumeCursor(): string | undefined;
  /** 幂等；只释放本地观察资源，绝不触发 stop/cancel。 */
  close(): void;
}

/** HostClient 应用面方法集（connectToHost 返回对象的一部分）。 */
export interface HostClientApplication {
  submitCommand(input: SubmitCommandInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  getReceipt(commandId: string): Promise<CommandReceipt>;
  resolveResult(resultRef: string): Promise<CommandReceipt>;
  listProjects(options?: ListProjectsInput): Promise<ProjectListResult>;
  getProject(projectId: string): Promise<ProjectDetailResult>;
  /** P02-3 / F-006（§7.2）：注册前只读仓库检查（path 为仓库根绝对路径）。 */
  inspectRepository(path: string): Promise<ProjectInspectionResult>;
  /** P02-3 / F-006（§7.3）：注册状态与健康状态分开的项目概览。 */
  getProjectOverview(projectId: string): Promise<ProjectOverviewResult>;
  getRepositoryBinding(projectId: string): Promise<ProjectBindingResult>;
  countProjectLabels(): Promise<ProjectLabelCountsResult>;
  getGlobalSettings(): Promise<PublicSettingsState>;
  exportGlobalSettings(): Promise<ExportedSettings>;
  getProjectSettings(projectId: string): Promise<PublicSettingsState>;
  getEffectiveSettings(projectId: string): Promise<EffectiveSettings>;
  exportProjectSettings(projectId: string): Promise<ExportedSettings>;
  getSnapshot(scope: { readonly kind: 'project'; readonly projectId: string }): Promise<ProjectSnapshotResult>;
  getSnapshot(scope: { readonly kind: 'global' }): Promise<GlobalSnapshotResult>;
  getSnapshot(scope: SettingsScope): Promise<SnapshotResult>;
  subscribeEvents(input: SubscribeEventsInput): Promise<HostEventSubscription>;
  /**
   * P02-3 / F-014（§6/§7.6）：baseline.preview 命令（只读预览）。completed
   * 回执的 result 经预览形状校验；rejected/业务拒绝按回执原样返回。
   */
  previewBaseline(input: PreviewBaselineInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /**
   * P02-3 / F-014（§5.3/§6）：baseline.run 命令。authorize → 202 accepted
   * 回执（携带 operationId，检查随后台异步执行；本方法不等待执行完成）；
   * decline → completed 回执（result 经形状校验）。
   */
  runBaseline(input: RunBaselineInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /**
   * P02-3 / F-014（§6）：baseline.cancel 显式取消命令（唯一取消途径；
   * 客户端断开/close/Abort 绝不自动取消后台检查）。completed 回执的
   * result 经形状校验。
   */
  cancelBaseline(
    projectId: string,
    operationId: string,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** P02-3 / F-014（§7.4）：项目基线操作键集分页查询。 */
  listBaselines(projectId: string, input?: ListBaselinesInput): Promise<BaselineListResult>;
  /** P02-3 / F-014（§7.5）：单次基线操作详情（授权摘要 + 逐项检查）。 */
  getBaseline(operationId: string): Promise<BaselineDetailResult>;
  /** P02-3 / F-014（§7.6）：正式基线证据制品正文（有界、已授权、已脱敏）。 */
  readArtifactContent(artifactId: string): Promise<BaselineArtifactContentResult>;
}

/** 由 connectToHost 注入的会话上下文（身份/预算/生命周期钩子）。 */
export interface AppClientContext {
  readonly port: number;
  readonly token: string;
  readonly connectMs: number;
  readonly appRequestMs: number;
  readonly submitBudgetMs: number;
  /** 客户端关闭即拒绝新操作（client_closed）。 */
  assertOpen(operation: HostOperation): void;
  /** 登记/注销活跃订阅：client.close() 级联释放本地观察资源。 */
  registerSubscription(subscription: HostEventSubscription): void;
  unregisterSubscription(subscription: HostEventSubscription): void;
}

function invalidInput(operation: HostOperation, reason: string, field?: string): HostProtocolError {
  return new HostProtocolError('invalid_input', operation, 'HostClient 输入未通过校验', {
    details: field === undefined ? { reason } : { reason, field },
  });
}

function abortedError(operation: HostOperation): HostProtocolError {
  return new HostProtocolError('unreachable', operation, '操作已被 AbortSignal 中止', {
    details: { reason: 'aborted' },
  });
}

/**
 * 提取可选 AbortSignal（参数以 unknown 视角校验，避免类型守卫收窄干扰调用方类型）。
 */
function extractAbortSignal(
  options: { readonly signal?: unknown } | undefined,
  operation: HostOperation,
): AbortSignal | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (!isPlainObject(options)) {
    throw invalidInput(operation, 'invalid_options');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'signal') {
      throw invalidInput(operation, 'unknown_option_key', key);
    }
  }
  const signal: unknown = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidInput(operation, 'invalid_signal', 'signal');
  }
  return signal;
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return (
    isHostProtocolError(error, 'unreachable') &&
    (error.details as Record<string, unknown> | undefined)?.reason === 'aborted'
  );
}

/** 有界等待；中止立即抛 unreachable(aborted)，等待不超过 deadline。 */
function boundedDelay(
  ms: number,
  signal: AbortSignal | undefined,
  deadlineMs: number,
  operation: HostOperation,
): Promise<void> {
  const remaining = deadlineMs - Date.now();
  const waitMs = Math.max(0, Math.min(ms, remaining));
  return new Promise<void>((resolveWait, rejectWait) => {
    if (signal?.aborted === true) {
      rejectWait(abortedError(operation));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, waitMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectWait(abortedError(operation));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ *
 * 信封冻结与本地校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const SUBMIT_INPUT_KEYS = [
  'commandId',
  'operation',
  'scope',
  'expectedRevision',
  'issuedAt',
  'expiresAt',
  'payload',
] as const;

interface FrozenEnvelope {
  readonly commandId: string;
  readonly operation: AppOperation;
  readonly wire: Record<string, unknown>;
  readonly requestDigest: string;
}

/**
 * 构造并冻结信封：commandId/issuedAt 缺省生成一次；经 Core
 * validateCommandEnvelope 完整校验（同一权威，不另立第二份），任何
 * PublicError 都折算为客户端 invalid_input（本地输入错误，零网络）。
 */
function freezeCommandEnvelope(input: SubmitCommandInput): FrozenEnvelope {
  if (!isPlainObject(input)) {
    throw invalidInput('commands.submit', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(SUBMIT_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('commands.submit', 'unknown_option_key', key);
    }
  }
  const commandId = input.commandId ?? randomUUID();
  const wire: Record<string, unknown> = {
    // 线消息版本随 shiploop-core 协议常量（P02-3 / F-006 起 v3），不另立字面量。
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId,
    operation: input.operation,
    scope: input.scope,
  };
  if (input.expectedRevision !== undefined) {
    wire.expectedRevision = input.expectedRevision;
  }
  wire.issuedAt = input.issuedAt ?? new Date().toISOString();
  if (input.expiresAt !== undefined) {
    wire.expiresAt = input.expiresAt;
  }
  wire.payload = input.payload;
  try {
    const validated = validateCommandEnvelope(wire);
    return {
      commandId,
      operation: validated.operation,
      wire,
      requestDigest: computeCommandRequestDigest(validated),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'PublicError') {
      const details = (error as { details?: Record<string, unknown> }).details;
      const field = typeof details?.field === 'string' ? details.field : undefined;
      throw invalidInput('commands.submit', 'invalid_command_envelope', field);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 查询输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const LIST_INPUT_KEYS = ['limit', 'cursor', 'labels', 'match'] as const;

/** §7.1/§13：分页 1..200、标签 ≤50 个、match any/all；查询串键序冻结。 */
function buildProjectListQuery(input: ListProjectsInput | undefined): string {
  if (input === undefined) {
    return '';
  }
  if (!isPlainObject(input)) {
    throw invalidInput('projects.list', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(LIST_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('projects.list', 'unknown_option_key', key);
    }
  }
  const params = new URLSearchParams();
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw invalidInput('projects.list', 'invalid_limit', 'limit');
    }
    params.append('limit', String(input.limit));
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length === 0) {
      throw invalidInput('projects.list', 'invalid_cursor', 'cursor');
    }
    params.append('cursor', input.cursor);
  }
  if (input.labels !== undefined) {
    if (
      !Array.isArray(input.labels) ||
      input.labels.length > 50 ||
      !input.labels.every(
        (label) => typeof label === 'string' && label.length > 0 && label.length <= 64,
      )
    ) {
      throw invalidInput('projects.list', 'invalid_labels', 'labels');
    }
    for (const label of input.labels) {
      params.append('label', label);
    }
  }
  if (input.match !== undefined) {
    if (input.match !== 'any' && input.match !== 'all') {
      throw invalidInput('projects.list', 'invalid_match', 'match');
    }
    params.append('match', input.match);
  }
  return params.toString();
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * §7.2 inspect 输入零网络把关：path 必须是非空绝对路径字符串（无 NUL）。
 * 完整校验（存在/目录/Git 仓库根/规范路径）由服务端 RepositoryInspector
 * 单一权威完成；客户端只拒绝明显非法输入，不复制服务端规则。
 */
function requireRepositoryPathInput(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\u0000') ||
    !path.startsWith('/')
  ) {
    throw invalidInput('projects.inspect', 'invalid_repository_path', 'path');
  }
  return path;
}

function requireProjectId(operation: HostOperation, projectId: string): string {
  if (typeof projectId !== 'string' || !STABLE_ID_PATTERN.test(projectId)) {
    throw invalidInput(operation, 'invalid_project_id', 'projectId');
  }
  return projectId;
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 基线输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const PREVIEW_INPUT_KEYS = ['projectId', 'plan', 'commandId'] as const;
const RUN_INPUT_KEYS = ['projectId', 'decision', 'plan', 'previewDigest', 'commandId'] as const;
const BASELINE_LIST_INPUT_KEYS = ['limit', 'cursor'] as const;

function rejectUnknownInputKeys(
  operation: HostOperation,
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw invalidInput(operation, 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw invalidInput(operation, 'unknown_option_key', key);
    }
  }
  return input;
}

function requireOperationIdInput(operation: HostOperation, operationId: string): string {
  if (!isUuidV4(operationId)) {
    throw invalidInput(operation, 'invalid_operation_id', 'operationId');
  }
  return operationId;
}

function requireArtifactIdInput(operation: HostOperation, artifactId: string): string {
  if (typeof artifactId !== 'string' || !STABLE_ID_PATTERN.test(artifactId)) {
    throw invalidInput(operation, 'invalid_artifact_id', 'artifactId');
  }
  return artifactId;
}

/** §7.4：limit 1..100；cursor 是上一页最后 operationId（UUID v4）。键序冻结。 */
function buildBaselineListQuery(input: ListBaselinesInput | undefined): string {
  if (input === undefined) {
    return '';
  }
  const object = rejectUnknownInputKeys('baselines.list', input, BASELINE_LIST_INPUT_KEYS);
  const params = new URLSearchParams();
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > 100
    ) {
      throw invalidInput('baselines.list', 'invalid_limit', 'limit');
    }
    params.append('limit', String(object.limit));
  }
  if (object.cursor !== undefined) {
    if (typeof object.cursor !== 'string' || !isUuidV4(object.cursor)) {
      throw invalidInput('baselines.list', 'invalid_cursor', 'cursor');
    }
    params.append('cursor', object.cursor);
  }
  return params.toString();
}

/** §8 scope：global 无 projectId；project 必须携带稳定 ID。 */
function validateSnapshotScope(operation: HostOperation, scope: SettingsScope): SettingsScope {
  if (!isPlainObject(scope)) {
    throw invalidInput(operation, 'invalid_scope', 'scope');
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'kind' && key !== 'projectId') {
      throw invalidInput(operation, 'unknown_option_key', `scope.${key}`);
    }
  }
  if (scope.kind === 'global') {
    if (Object.prototype.hasOwnProperty.call(scope, 'projectId')) {
      throw invalidInput(operation, 'scope_conflict', 'scope.projectId');
    }
    return { kind: 'global' };
  }
  if (scope.kind === 'project') {
    const projectId = (scope as { projectId?: unknown }).projectId;
    if (typeof projectId !== 'string' || !STABLE_ID_PATTERN.test(projectId)) {
      throw invalidInput(operation, 'invalid_project_id', 'scope.projectId');
    }
    return { kind: 'project', projectId };
  }
  throw invalidInput(operation, 'invalid_scope_kind', 'scope.kind');
}

/* ------------------------------------------------------------------ *
 * SSE 订阅
 * ------------------------------------------------------------------ */

interface ParsedSubscribeInput {
  readonly scope: SettingsScope;
  readonly cursor: string | undefined;
  readonly lastEventId: string | undefined;
  readonly onEvent: (event: PublicStateEvent) => void;
  readonly signal: AbortSignal | undefined;
}

const SUBSCRIBE_INPUT_KEYS = ['scope', 'cursor', 'lastEventId', 'onEvent', 'signal'] as const;
const EVENT_CURSOR_PREFIX = 'evcur_v1_';

function parseSubscribeInput(input: SubscribeEventsInput): ParsedSubscribeInput {
  if (!isPlainObject(input)) {
    throw invalidInput('events.subscribe', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(SUBSCRIBE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('events.subscribe', 'unknown_option_key', key);
    }
  }
  const scope = validateSnapshotScope('events.subscribe', input.scope);
  if (typeof input.onEvent !== 'function') {
    throw invalidInput('events.subscribe', 'invalid_on_event', 'onEvent');
  }
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      !input.cursor.startsWith(EVENT_CURSOR_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(input.cursor.slice(EVENT_CURSOR_PREFIX.length))
    ) {
      throw invalidInput('events.subscribe', 'invalid_cursor', 'cursor');
    }
    cursor = input.cursor;
  }
  let lastEventId: string | undefined;
  if (input.lastEventId !== undefined) {
    if (!isUuidV4(input.lastEventId)) {
      throw invalidInput('events.subscribe', 'invalid_event_id', 'lastEventId');
    }
    lastEventId = input.lastEventId;
  }
  // 缺省恢复位置无法续读（服务端会 400 cursor_required）：本地零网络拒绝。
  if (cursor === undefined && lastEventId === undefined) {
    throw invalidInput('events.subscribe', 'cursor_required', 'cursor');
  }
  const signal = input.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidInput('events.subscribe', 'invalid_signal', 'signal');
  }
  return { scope, cursor, lastEventId, onEvent: input.onEvent, signal };
}

interface OpenedStream {
  readonly request: ClientRequest;
  readonly response: IncomingMessage;
}

/** 读取有界错误响应体并解析 JSON（建连前非 200 分支）。 */
function readErrorBody(response: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolveRead) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (value: unknown): void => {
      if (!done) {
        done = true;
        resolveRead(value);
      }
    };
    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_APP_BODY_BYTES) {
        response.destroy();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        finish(undefined);
      }
    });
    response.on('error', () => finish(undefined));
    response.on('close', () => finish(undefined));
  });
}

export function createHostClientApplication(context: AppClientContext): HostClientApplication {
  const { port, token } = context;

  /** 单请求预算：appRequestMs 与剩余总预算取小（有界）。 */
  function requestBudget(deadlineMs?: number): number {
    const base = context.appRequestMs;
    if (deadlineMs === undefined) {
      return base;
    }
    return Math.max(1, Math.min(base, deadlineMs - Date.now()));
  }

  async function getJson(operation: HostOperation, path: string): Promise<unknown> {
    context.assertOpen(operation);
    const response = await requestLoopbackJson({
      port,
      method: 'GET',
      path,
      operation,
      token,
      connectTimeoutMs: context.connectMs,
      overallTimeoutMs: requestBudget(),
      maxResponseBytes: MAX_APP_BODY_BYTES,
    });
    if (response.statusCode !== 200) {
      throw mapErrorResponse(response.statusCode, response.json, operation);
    }
    return response.json;
  }

  /** 提交响应 → 回执：200/202 必须是合法回执（§5.3：accepted → 202，P02-3 /
   *  F-008 起为 baseline.run authorize 的合法线上状态）；非 200/202 体为合法
   *  回执按 §5.7 返回，否则错误映射。 */
  function receiptFromSubmitResponse(
    response: { statusCode: number; json: unknown },
    frozen: FrozenEnvelope,
  ): CommandReceipt {
    const expectation = {
      expectedCommandId: frozen.commandId,
      expectedRequestDigest: frozen.requestDigest,
      expectedOperation: frozen.operation,
    };
    if (response.statusCode === 200 || response.statusCode === 202) {
      return validateCommandReceiptWire(response.json, expectation, 'commands.submit');
    }
    if (
      isPlainObject(response.json) &&
      typeof response.json.commandId === 'string' &&
      (response.json.status === 'completed' ||
        response.json.status === 'rejected' ||
        response.json.status === 'accepted')
    ) {
      return validateCommandReceiptWire(response.json, expectation, 'commands.submit');
    }
    throw mapErrorResponse(response.statusCode, response.json, 'commands.submit');
  }

  /** 回执查询：命中返回已核验回执；明确 not_found / 传输失败返回 undefined（继续有限重发）。 */
  async function lookupReceipt(
    frozen: FrozenEnvelope,
    signal: AbortSignal | undefined,
    deadlineMs: number,
  ): Promise<CommandReceipt | undefined> {
    try {
      const response = await requestLoopbackJson({
        port,
        method: 'GET',
        path: `${RECEIPTS_ROUTE_PREFIX}${frozen.commandId}`,
        operation: 'receipts.get',
        token,
        connectTimeoutMs: context.connectMs,
        overallTimeoutMs: requestBudget(deadlineMs),
        maxResponseBytes: MAX_APP_BODY_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (response.statusCode !== 200) {
        throw mapErrorResponse(response.statusCode, response.json, 'receipts.get');
      }
      return validateCommandReceiptWire(
        response.json,
        {
          expectedCommandId: frozen.commandId,
          expectedRequestDigest: frozen.requestDigest,
          expectedOperation: frozen.operation,
        },
        'receipts.get',
      );
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      if (isHostProtocolError(error, 'not_found') || isHostProtocolError(error, 'unreachable')) {
        return undefined;
      }
      throw error;
    }
  }

  async function submitCommand(
    input: SubmitCommandInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt> {
    context.assertOpen('commands.submit');
    const signal = extractAbortSignal(options, 'commands.submit');
    const frozen = freezeCommandEnvelope(input);
    const deadlineMs = Date.now() + context.submitBudgetMs;

    let attempt = 0;
    for (;;) {
      if (signal?.aborted === true) {
        throw abortedError('commands.submit');
      }
      if (attempt >= SUBMIT_MAX_ATTEMPTS || Date.now() >= deadlineMs) {
        // 预算耗尽仍未知：明确结果不确定，保留 commandId 供事后查回执。
        throw new HostProtocolError(
          'outcome_unknown',
          'commands.submit',
          undefined,
          { details: { reason: 'submit_budget_exhausted', commandId: frozen.commandId } },
        );
      }
      attempt += 1;
      try {
        const response = await requestLoopbackJson({
          port,
          method: 'POST',
          path: COMMANDS_ROUTE,
          operation: 'commands.submit',
          token,
          body: frozen.wire,
          connectTimeoutMs: context.connectMs,
          overallTimeoutMs: requestBudget(deadlineMs),
          maxResponseBytes: MAX_APP_BODY_BYTES,
          ...(signal !== undefined ? { signal } : {}),
        });
        return receiptFromSubmitResponse(response, frozen);
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw abortedError('commands.submit');
        }
        // 仅传输失败（连接丢失/超时）进入查回执路径；业务拒绝/协议错误/重定向
        // 都是明确结果，不重试、不查回执。
        if (!isHostProtocolError(error, 'unreachable')) {
          throw error;
        }
      }
      // 传输失败：先等待有界提交窗口，再查本 principal 名下回执。
      await boundedDelay(SUBMIT_RECEIPT_GRACE_MS, signal, deadlineMs, 'commands.submit');
      const receipt = await lookupReceipt(frozen, signal, deadlineMs);
      if (receipt !== undefined) {
        return receipt;
      }
      // 回执未知：有限间隔后以完全相同的冻结信封重发。
      await boundedDelay(SUBMIT_RETRY_DELAY_MS, signal, deadlineMs, 'commands.submit');
    }
  }

  /* ---------------------------------------------------------------- *
   * SSE
   * ---------------------------------------------------------------- */

  function buildEventsQuery(scope: SettingsScope, cursor: string | undefined): string {
    const params = new URLSearchParams();
    if (scope.kind === 'project') {
      params.append('scope', 'project');
      params.append('projectId', scope.projectId);
    } else {
      params.append('scope', 'global');
    }
    if (cursor !== undefined) {
      params.append('cursor', cursor);
    }
    return params.toString();
  }

  /** 建立 SSE 连接并等待响应头；非 200 按错误体映射拒绝（含建连前 snapshot_required）。 */
  function openStream(
    parsed: ParsedSubscribeInput,
    resume: { readonly cursor: string | undefined; readonly lastEventId: string | undefined },
  ): Promise<OpenedStream> {
    return new Promise<OpenedStream>((resolveOpen, rejectOpen) => {
      let settled = false;
      const fail = (error: HostProtocolError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        parsed.signal?.removeEventListener('abort', onAbort);
        req.destroy();
        rejectOpen(error);
      };
      const timer = setTimeout(() => {
        fail(
          new HostProtocolError('unreachable', 'events.subscribe', '等待事件流响应头超时', {
            details: { reason: 'request_timeout' },
          }),
        );
      }, requestBudget());
      const onAbort = (): void => {
        fail(abortedError('events.subscribe'));
      };
      parsed.signal?.addEventListener('abort', onAbort, { once: true });

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        host: `127.0.0.1:${port}`,
        accept: 'text/event-stream',
      };
      if (resume.lastEventId !== undefined) {
        headers['last-event-id'] = resume.lastEventId;
      }
      const req = httpRequest(
        {
          host: '127.0.0.1',
          family: 4,
          port,
          method: 'GET',
          path: `${EVENTS_ROUTE}?${buildEventsQuery(parsed.scope, resume.cursor)}`,
          agent: false,
          headers,
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            response.resume();
            fail(
              new HostProtocolError(
                'redirect_rejected',
                'events.subscribe',
                '拒绝重定向（不会向新地址发送凭据）',
                { details: { reason: 'redirect_rejected', statusCode } },
              ),
            );
            return;
          }
          if (statusCode !== 200) {
            void readErrorBody(response).then((json) => {
              fail(mapErrorResponse(statusCode, json, 'events.subscribe'));
            });
            return;
          }
          const contentType = response.headers['content-type'];
          if (
            typeof contentType !== 'string' ||
            !contentType.toLowerCase().startsWith('text/event-stream')
          ) {
            fail(
              new HostProtocolError('response_malformed', 'events.subscribe', '事件流内容类型不符', {
                details: { reason: 'content_type_not_event_stream' },
              }),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          parsed.signal?.removeEventListener('abort', onAbort);
          resolveOpen({ request: req, response });
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        fail(
          new HostProtocolError('unreachable', 'events.subscribe', '无法建立事件流连接', {
            details: { reason: 'connection_lost', ...(error.code ? { causeCode: error.code } : {}) },
          }),
        );
      });
      req.end();
    });
  }

  async function subscribeEvents(input: SubscribeEventsInput): Promise<HostEventSubscription> {
    context.assertOpen('events.subscribe');
    const parsed = parseSubscribeInput(input);
    if (parsed.signal?.aborted === true) {
      throw abortedError('events.subscribe');
    }

    // 订阅状态（跨自动重连共享：去重缓存与最后事件身份）。
    const seenEventIds = new Map<string, true>();
    let lastEventId: string | undefined = parsed.lastEventId;
    let closed = false;
    let current: OpenedStream | undefined;
    let reconnectAttempts = 0;
    let resolveEnded!: (end: EventStreamEnd) => void;
    const ended = new Promise<EventStreamEnd>((resolveEnd) => {
      resolveEnded = resolveEnd;
    });

    const subscription: HostEventSubscription = {
      ended,
      lastEventId: () => lastEventId,
      resumeCursor: () => parsed.cursor,
      close: () => {
        finish({ kind: 'aborted' });
      },
    };

    // AbortSignal 在整个订阅生命周期生效（不只建连阶段）：只释放本地观察资源。
    const onUserAbort = (): void => {
      finish({ kind: 'aborted' });
    };
    parsed.signal?.addEventListener('abort', onUserAbort, { once: true });

    function finish(end: EventStreamEnd): void {
      if (closed) {
        return;
      }
      closed = true;
      parsed.signal?.removeEventListener('abort', onUserAbort);
      context.unregisterSubscription(subscription);
      const stream = current;
      current = undefined;
      if (stream === undefined) {
        resolveEnded(end);
        return;
      }
      // 结算前确认本地连接已收尾：等 response close（本端析构完成）加一段
      // 有界回环交付余量，让对端 close 落账后再 resolve ended；1 000 ms 兜底。
      let resolved = false;
      const resolveOnce = (): void => {
        if (!resolved) {
          resolved = true;
          resolveEnded(end);
        }
      };
      stream.response.once('close', () => {
        setTimeout(resolveOnce, 25);
      });
      try {
        stream.request.destroy();
        stream.response.destroy();
      } catch {
        // 尽力收尾。
      }
      setTimeout(resolveOnce, 1_000);
    }

    function noteEvent(event: PublicStateEvent): boolean {
      if (seenEventIds.has(event.eventId)) {
        return false;
      }
      if (seenEventIds.size >= EVENT_ID_CACHE_LIMIT) {
        const oldest = seenEventIds.keys().next();
        if (!oldest.done) {
          seenEventIds.delete(oldest.value);
        }
      }
      seenEventIds.set(event.eventId, true);
      lastEventId = event.eventId;
      return true;
    }

    function handleErrorFrame(data: string): boolean {
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        finish({ kind: 'protocol_error', reason: 'error_frame_invalid_json' });
        return true;
      }
      const code = isPlainObject(payload) ? payload.code : undefined;
      const snapshotRoute =
        isPlainObject(payload) && typeof payload.snapshotRoute === 'string'
          ? payload.snapshotRoute
          : SNAPSHOT_ROUTE;
      if (code === 'snapshot_required') {
        finish({ kind: 'snapshot_required', snapshotRoute });
        return true;
      }
      if (code === 'stream_overflow') {
        finish({ kind: 'stream_overflow', snapshotRoute });
        return true;
      }
      finish({
        kind: 'protocol_error',
        reason: typeof code === 'string' ? 'error_frame' : 'error_frame_malformed',
      });
      return true;
    }

    function handleStateEventFrame(data: string): void {
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(data) as unknown;
      } catch {
        finish({ kind: 'protocol_error', reason: 'event_data_invalid_json' });
        return;
      }
      let event: PublicStateEvent;
      try {
        event = validateStateEventWire(parsedData, 'events.subscribe');
      } catch {
        finish({ kind: 'protocol_error', reason: 'event_wire_invalid' });
        return;
      }
      if (event.scope.kind !== parsed.scope.kind || (
        event.scope.kind === 'project' && parsed.scope.kind === 'project' &&
        event.scope.projectId !== parsed.scope.projectId
      )) {
        finish({ kind: 'protocol_error', reason: 'event_scope_mismatch' });
        return;
      }
      if (!noteEvent(event)) {
        return;
      }
      try {
        parsed.onEvent(event);
      } catch {
        finish({ kind: 'protocol_error', reason: 'observer_callback_error' });
      }
    }

    function dispatchFrame(rawFrame: string): void {
      if (closed) {
        return;
      }
      if (Buffer.byteLength(rawFrame, 'utf8') > MAX_SSE_FRAME_BYTES) {
        finish({ kind: 'protocol_error', reason: 'frame_too_large' });
        return;
      }
      let eventField: string | undefined;
      const dataLines: string[] = [];
      for (const rawLine of rawFrame.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0 || line.startsWith(':')) {
          continue; // 空行与注释（心跳）忽略。
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        if (field === 'event') {
          eventField = value;
        } else if (field === 'data') {
          dataLines.push(value);
        }
        // id 字段与事件 eventId 同源（服务端一致写入）；去重以事件封套为准。
      }
      if (eventField === undefined && dataLines.length === 0) {
        return; // 纯注释/心跳帧。
      }
      const data = dataLines.join('\n');
      if (eventField === 'error') {
        handleErrorFrame(data);
        return;
      }
      if (eventField === 'state-event') {
        handleStateEventFrame(data);
        return;
      }
      finish({ kind: 'protocol_error', reason: 'unknown_frame_event' });
    }

    function attach(stream: OpenedStream): void {
      current = stream;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      stream.response.on('data', (chunk: Buffer) => {
        if (closed) {
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator !== null) {
          const rawFrame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          dispatchFrame(rawFrame);
          if (closed) {
            return;
          }
          separator = /\r?\n\r?\n/.exec(buffer);
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          finish({ kind: 'protocol_error', reason: 'buffer_overflow' });
        }
      });
      // 连接结束/错误：用户关闭已结算；否则进入有限自动重连。
      const onLost = (): void => {
        if (closed || current !== stream) {
          return;
        }
        current = undefined;
        stream.request.destroy();
        stream.response.destroy();
        void reconnect();
      };
      stream.response.on('end', onLost);
      stream.response.on('error', onLost);
      stream.response.on('close', onLost);
    }

    async function reconnect(): Promise<void> {
      if (closed) {
        return;
      }
      if (reconnectAttempts >= EVENT_RECONNECT_MAX_ATTEMPTS) {
        finish({ kind: 'protocol_error', reason: 'reconnect_budget_exhausted' });
        return;
      }
      try {
        await boundedDelay(
          EVENT_RECONNECT_DELAY_MS,
          parsed.signal,
          Number.POSITIVE_INFINITY,
          'events.subscribe',
        );
      } catch {
        finish({ kind: 'aborted' });
        return;
      }
      if (closed) {
        return;
      }
      reconnectAttempts += 1;
      try {
        // 断线续读：Last-Event-ID 优先（服务端解析持久 sequence），无则原游标。
        const stream = await openStream(parsed, {
          cursor: lastEventId === undefined ? parsed.cursor : undefined,
          lastEventId,
        });
        if (closed) {
          stream.request.destroy();
          stream.response.destroy();
          return;
        }
        attach(stream);
      } catch (error) {
        if (closed) {
          return;
        }
        if (isAbortError(error, parsed.signal)) {
          finish({ kind: 'aborted' });
          return;
        }
        if (isHostProtocolError(error, 'snapshot_required')) {
          // 建连时低于可续读下界：明确恢复分支（重取快照），不偷偷从零重读。
          const details = error.details as Record<string, unknown> | undefined;
          finish({
            kind: 'snapshot_required',
            snapshotRoute:
              typeof details?.snapshotRoute === 'string' ? details.snapshotRoute : SNAPSHOT_ROUTE,
          });
          return;
        }
        if (!isHostProtocolError(error, 'unreachable')) {
          finish({ kind: 'protocol_error', reason: 'reconnect_rejected' });
          return;
        }
        await reconnect();
      }
    }

    // 建连（非 200 拒绝直接向上抛出，不产生订阅句柄）。
    try {
      const stream = await openStream(parsed, {
        cursor: parsed.cursor,
        lastEventId: parsed.lastEventId,
      });
      current = stream;
      context.assertOpen('events.subscribe');
      if (closed) throw abortedError('events.subscribe');
      context.registerSubscription(subscription);
      attach(stream);
      return subscription;
    } catch (error) {
      finish({ kind: 'aborted' });
      throw error;
    }
  }

  /* ---------------------------------------------------------------- *
   * 查询与回执/结果读取
   * ---------------------------------------------------------------- */

  async function getSnapshot(scope: { readonly kind: 'project'; readonly projectId: string }): Promise<ProjectSnapshotResult>;
  async function getSnapshot(scope: { readonly kind: 'global' }): Promise<GlobalSnapshotResult>;
  async function getSnapshot(scope: SettingsScope): Promise<SnapshotResult> {
    context.assertOpen('snapshot.get');
    const validScope = validateSnapshotScope('snapshot.get', scope);
    const json = await getJson('snapshot.get', `${SNAPSHOT_ROUTE}?${buildEventsQuery(validScope, undefined)}`);
    return validateAppQueryResponse('snapshot.get', json, { scope: validScope });
  }

  return {
    submitCommand,

    async getReceipt(commandId: string): Promise<CommandReceipt> {
      context.assertOpen('receipts.get');
      if (!isUuidV4(commandId)) {
        throw invalidInput('receipts.get', 'invalid_uuid_v4', 'commandId');
      }
      const json = await getJson('receipts.get', `${RECEIPTS_ROUTE_PREFIX}${commandId}`);
      return validateCommandReceiptWire(json, { expectedCommandId: commandId }, 'receipts.get');
    },

    async resolveResult(resultRef: string): Promise<CommandReceipt> {
      context.assertOpen('results.resolve');
      if (!isValidResultRef(resultRef)) {
        throw invalidInput('results.resolve', 'invalid_result_ref', 'resultRef');
      }
      const json = await getJson('results.resolve', `${RESULTS_ROUTE_PREFIX}${resultRef}`);
      return validateCommandReceiptWire(json, {}, 'results.resolve');
    },

    async listProjects(options?: ListProjectsInput): Promise<ProjectListResult> {
      context.assertOpen('projects.list');
      const query = buildProjectListQuery(options);
      const json = await getJson(
        'projects.list',
        query.length === 0 ? PROJECTS_ROUTE : `${PROJECTS_ROUTE}?${query}`,
      );
      return validateAppQueryResponse('projects.list', json);
    },

    async getProject(projectId: string): Promise<ProjectDetailResult> {
      const id = requireProjectId('projects.get', projectId);
      const json = await getJson('projects.get', `${PROJECTS_ROUTE}/${id}`);
      return validateAppQueryResponse('projects.get', json);
    },

    async inspectRepository(path: string): Promise<ProjectInspectionResult> {
      context.assertOpen('projects.inspect');
      const repositoryPath = requireRepositoryPathInput(path);
      const params = new URLSearchParams();
      params.append('path', repositoryPath);
      const json = await getJson(
        'projects.inspect',
        `${PROJECTS_INSPECT_ROUTE}?${params.toString()}`,
      );
      return validateAppQueryResponse('projects.inspect', json);
    },

    async getProjectOverview(projectId: string): Promise<ProjectOverviewResult> {
      context.assertOpen('projects.overview');
      const id = requireProjectId('projects.overview', projectId);
      const json = await getJson('projects.overview', `${PROJECTS_ROUTE}/${id}/overview`);
      return validateAppQueryResponse('projects.overview', json);
    },

    async getRepositoryBinding(projectId: string): Promise<ProjectBindingResult> {
      const id = requireProjectId('projects.binding.get', projectId);
      const json = await getJson('projects.binding.get', `${PROJECTS_ROUTE}/${id}/repository-binding`);
      return validateAppQueryResponse('projects.binding.get', json);
    },

    async countProjectLabels(): Promise<ProjectLabelCountsResult> {
      const json = await getJson('projects.labelCounts', PROJECT_LABEL_COUNTS_ROUTE);
      return validateAppQueryResponse('projects.labelCounts', json);
    },

    async getGlobalSettings(): Promise<PublicSettingsState> {
      const json = await getJson('settings.global.get', SETTINGS_GLOBAL_ROUTE);
      return validateAppQueryResponse('settings.global.get', json);
    },

    async exportGlobalSettings(): Promise<ExportedSettings> {
      const json = await getJson('settings.global.export', SETTINGS_GLOBAL_EXPORT_ROUTE);
      return validateAppQueryResponse('settings.global.export', json);
    },

    async getProjectSettings(projectId: string): Promise<PublicSettingsState> {
      const id = requireProjectId('settings.project.get', projectId);
      const json = await getJson('settings.project.get', `${PROJECTS_ROUTE}/${id}/settings`);
      return validateAppQueryResponse('settings.project.get', json);
    },

    async getEffectiveSettings(projectId: string): Promise<EffectiveSettings> {
      const id = requireProjectId('settings.project.effective', projectId);
      const json = await getJson('settings.project.effective', `${PROJECTS_ROUTE}/${id}/settings/effective`);
      return validateAppQueryResponse('settings.project.effective', json);
    },

    async exportProjectSettings(projectId: string): Promise<ExportedSettings> {
      const id = requireProjectId('settings.project.export', projectId);
      const json = await getJson('settings.project.export', `${PROJECTS_ROUTE}/${id}/settings/export`);
      return validateAppQueryResponse('settings.project.export', json);
    },

    getSnapshot,

    subscribeEvents,

    /* ------------------------------------------------------------ *
     * P02-3 / F-014 基线命令与查询（§6/§7.4-§7.6）
     * ------------------------------------------------------------ */

    async previewBaseline(
      input: PreviewBaselineInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, PREVIEW_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'baseline.preview',
          scope: { kind: 'project', projectId },
          payload: { plan: object.plan },
        },
        options,
      );
      // completed 回执的 result 必须是预览摘要形状（§6 冻结）。
      if (receipt.status === 'completed') {
        validateBaselinePreviewResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async runBaseline(
      input: RunBaselineInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, RUN_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      if (object.decision !== 'authorize' && object.decision !== 'decline') {
        throw invalidInput('commands.submit', 'invalid_decision', 'decision');
      }
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'baseline.run',
          scope: { kind: 'project', projectId },
          payload: {
            decision: object.decision,
            plan: object.plan,
            previewDigest: object.previewDigest,
          },
        },
        options,
      );
      // decline → completed 回执 result 形状校验；accepted 只携带 operationId
      //（线校验已保证），本方法不等待后台检查完成。
      if (receipt.status === 'completed') {
        validateBaselineCommandResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async cancelBaseline(
      projectId: string,
      operationId: string,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      // 取消是唯一停止途径且必须显式：本方法只发送 baseline.cancel 命令；
      // 客户端断开/close/Abort 不触发本方法（见 subscribeEvents/close 纪律）。
      const id = requireProjectId('commands.submit', projectId);
      const target = requireOperationIdInput('commands.submit', operationId);
      const receipt = await submitCommand(
        {
          operation: 'baseline.cancel',
          scope: { kind: 'project', projectId: id },
          payload: { operationId: target },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateBaselineCommandResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async listBaselines(
      projectId: string,
      input?: ListBaselinesInput,
    ): Promise<BaselineListResult> {
      context.assertOpen('baselines.list');
      const id = requireProjectId('baselines.list', projectId);
      const query = buildBaselineListQuery(input);
      const base = `${PROJECTS_ROUTE}/${id}/baselines`;
      const json = await getJson(
        'baselines.list',
        query.length === 0 ? base : `${base}?${query}`,
      );
      return validateAppQueryResponse('baselines.list', json);
    },

    async getBaseline(operationId: string): Promise<BaselineDetailResult> {
      context.assertOpen('baselines.get');
      const id = requireOperationIdInput('baselines.get', operationId);
      const json = await getJson('baselines.get', `${BASELINES_ROUTE_PREFIX}${id}`);
      return validateAppQueryResponse('baselines.get', json);
    },

    async readArtifactContent(artifactId: string): Promise<BaselineArtifactContentResult> {
      context.assertOpen('artifacts.get');
      const id = requireArtifactIdInput('artifacts.get', artifactId);
      const response = await requestLoopbackText({
        port,
        method: 'GET',
        path: `${ARTIFACTS_ROUTE_PREFIX}${id}${ARTIFACT_CONTENT_ROUTE_SUFFIX}`,
        operation: 'artifacts.get',
        token,
        connectTimeoutMs: context.connectMs,
        overallTimeoutMs: requestBudget(),
        // §7.6/§13：证据正文上限 8 MiB（超限即 response_malformed，不截断冒充）。
        maxResponseBytes: MAX_ARTIFACT_CONTENT_BYTES,
      });
      if (!response.ok) {
        throw mapErrorResponse(response.statusCode, response.json, 'artifacts.get');
      }
      return { artifactId: id, byteSize: response.byteSize, content: response.text };
    },
  };
}
