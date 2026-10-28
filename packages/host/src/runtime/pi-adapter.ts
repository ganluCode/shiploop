/**
 * P04-1 标准 Pi Coding Agent 适配器。
 *
 * 该模块是唯一加载 Pi SDK 的生产边界。SDK 会话工厂、受控工作目录和输入
 * 读取器都由可信 Host/Runner 装配注入；本模块不访问 Core 存储、不解析模块
 * 路径、不发现全局插件，也不把凭据传入 prompt、argv 或事件正文。
 */
import type { RuntimeRecoveryRecording } from 'shiploop-core';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import type { Agent } from '@earendil-works/pi-agent-core';
import { createPiManagedSessionManager, preparePiRecovery } from './pi-native-session.js';
import { PI_SDK_VERSION, PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION } from './pi-sdk-contract.js';
export { PI_SDK_VERSION, PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION } from './pi-sdk-contract.js';
import type { PiPreparedRecovery } from './pi-native-session.js';
import { observePiWithin, PI_ABORT_WAIT_MS, PI_STOP_WAIT_MS } from './pi-lifecycle.js';
import { piEventToken as token } from './pi-event-identity.js';
import type {
  CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type {
  ExecutionInputRef,
  ProviderCapabilityDescriptor,
  RuntimeAdapter,
  RuntimeCancelReceipt,
  RuntimeAdapterDescriptor,
  RuntimeErrorKind,
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeHandle,
  RuntimeUsageReport,
  RuntimeWorkAccessSnapshot,
  RuntimeRetryPolicy,
  RuntimeFailureClassification,
  RuntimeRecoveryCapabilities,
  RuntimeRecoveryReference,
  RuntimeRecoveryDecision,
} from 'shiploop-core';
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RuntimeError,
  createRuntimeRequestRetryController,
  DEFAULT_RUNTIME_REQUEST_RETRY_POLICY,
  decideRuntimeRecovery,
  validateRuntimeRecoveryCapabilities,
  validateProjectResourceLoadManifest,
} from 'shiploop-core';

export const PI_RUNTIME_ID = 'pi';
export const PI_ADAPTER_VERSION = '0.1.0';
export const PI_SDK_LICENSE = 'MIT';
export const PI_RECOVERY_EVIDENCE_REF = 'p04-4-pi-recovery-boundary';

export type PiCapabilityStatus = 'supported' | 'unsupported' | 'unknown' | 'not_ready';

export interface PiRuntimeCapabilities {
  readonly events: PiCapabilityStatus;
  readonly usage: PiCapabilityStatus;
  readonly cancel: PiCapabilityStatus;
  readonly stopped: PiCapabilityStatus;
  readonly conversationResume: PiCapabilityStatus;
  readonly executionRecovery: PiCapabilityStatus;
}

/**
 * Default production evidence remains unsupported pending authorized live
 * validation. The managed factory can load verified Artifact bytes and fork
 * JSONL v3; a trusted composition must supply environment-specific evidence
 * before Core can authorize continuation. No checkpoint replay is provided.
 */
export const PI_RUNTIME_RECOVERY_CAPABILITIES: RuntimeRecoveryCapabilities = Object.freeze({
  schemaVersion: 1,
  runtimeId: PI_RUNTIME_ID,
  adapterVersion: PI_ADAPTER_VERSION,
  sdkVersion: PI_SDK_VERSION,
  nativeFormats: Object.freeze([Object.freeze({
    format: PI_NATIVE_SESSION_FORMAT,
    versions: Object.freeze([PI_NATIVE_SESSION_FORMAT_VERSION]),
  })]),
  limits: Object.freeze([
    'production continuation requires explicit environment-specific capability evidence',
    'only immutable Artifact JSONL v3 with verified stopped writer authority can be forked',
    'SDK persistence does not provide Core execution recovery or side effect idempotency',
  ]),
  capabilities: Object.freeze({
    nativeHistory: Object.freeze({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF,
      limits: Object.freeze(['no verified native history reader is exposed']) }),
    conversationResume: Object.freeze({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF,
      limits: Object.freeze(['no verified same Task conversation load and continue operation is exposed']) }),
    executionRecovery: Object.freeze({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF,
      limits: Object.freeze(['Pi session persistence is not a checkpoint or tool execution recovery contract']) }),
    modelSwitchOnResume: Object.freeze({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF,
      limits: Object.freeze(['no verified resume-time provider/model switch operation is exposed']) }),
    nativeFork: Object.freeze({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF,
      limits: Object.freeze(['no verified immutable source fork or single-writer handoff operation is exposed']) }),
  }),
});

/** Alias used by composition roots that call the catalog entry a descriptor. */
export const PI_RUNTIME_RECOVERY_DESCRIPTOR = PI_RUNTIME_RECOVERY_CAPABILITIES;

/** 只声明本适配器实际验证过的边界；SDK 的原生 session 文件不等于 Core 恢复。 */
export const PI_RUNTIME_CAPABILITIES: PiRuntimeCapabilities = Object.freeze({
  events: 'supported',
  usage: 'supported',
  cancel: 'supported',
  stopped: 'supported',
  conversationResume: 'unsupported',
  executionRecovery: 'unsupported',
});

export interface PiRuntimeDescriptor extends RuntimeAdapterDescriptor {
  readonly sdkVersion: string;
}

export interface PiTrustedInputReader {
  read(ref: RuntimeExecutionRequest['prompt']): Promise<string>;
}

export interface PiTrustedAssembly {
  /** 由可信 Runner 固定提供，不从 RuntimeExecutionRequest 的 cwd 字符串解析路径。 */
  resolveWorkingDirectory(cwd: RuntimeExecutionRequest['cwd']): string;
  /** 受控 SDK 配置目录引用；适配器不自行读取该目录。 */
  readonly agentDir: string;
  readonly inputReader: PiTrustedInputReader;
  /** 仅接受可信装配提供的凭据解析结果引用，不接受 secret 字符串。 */
  readonly credentialRef?: { readonly kind: 'trusted-resolution'; readonly id: string };
  readonly resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
  /** 将 provider/model 解析为 SDK 原生模型；未提供时自定义 sessionFactory 仍可自行验证。 */
  readonly resolveModel?: (provider: string, model: string) => NonNullable<CreateAgentSessionOptions['model']>;
  /** 由可信装配选择受管项目数据根下的 Attempt session 目录。 */
  readonly resolveSessionDirectory?: (request: RuntimeExecutionRequest, cwd: string) => string;
  /** F-004：按请求执行认证预检和显式资源装配；返回值只含受限快照和可信引用。 */
  readonly prepareAccess?: (request: RuntimeExecutionRequest) => Promise<PiTrustedWorkAccess>;

  /** Core-approved immutable Artifact access and exclusive writer authority. */
  readonly recoverySourceManager?: PiRecoverySourceManager;
  /** Current authorized reasoning configuration; omission resets inherited reasoning to off. */
  readonly resolveThinkingLevel?: (request: RuntimeExecutionRequest) => NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
  /**
   * P05-1 / F-006：按请求解析受限提交自定义工具（如规划候选提交桥）；仅可信
   * 装配提供，不从请求字段/模型输出/全局发现推导。返回空数组 = 本次无工具。
   */
  readonly resolveSubmissionTools?: (
    request: RuntimeExecutionRequest,
  ) => readonly PiSubmissionToolDefinition[] | Promise<readonly PiSubmissionToolDefinition[]>;
}

export interface PiResourceLoadPolicy {
  readonly selectedResourceIds: readonly string[];
  readonly allowGlobalScan: false;
  readonly allowProjectDirectoryScan: false;
  readonly allowSdkDefaultScan: false;
}

export interface PiTrustedWorkAccess {
  readonly snapshot: RuntimeWorkAccessSnapshot;
  readonly credentialRef: { readonly kind: 'trusted-resolution'; readonly id: string };
  readonly resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
  /** F-004: the actual, identity-checked project resource load manifest. */
  readonly resourceManifest?: import('shiploop-core').ProjectResourceLoadManifest;
  /** F-004: explicit loader policy; all implicit SDK scans must remain disabled. */
  readonly resourceLoadPolicy?: PiResourceLoadPolicy;
}


/**
 * A Core-approved immutable source. It deliberately contains Artifact
 * identities and recovery references only; native paths, SQLite handles and
 * credential contents cannot cross this boundary.
 */
export interface PiManagedRecoverySource {
  readonly reference: RuntimeRecoveryReference;
  readonly archive: ExecutionInputRef;
  readonly sdkVersion: string;
  readonly checkpoint?: ExecutionInputRef;
  readonly previousWriter: {
    readonly status: 'confirmed';
    readonly stopEvidence: ExecutionInputRef;
  };
}

/**
 * Exclusive ownership for the new managed writer. The source remains read
 * only, and the lease is the only adapter-level continuation authority.
 */
export interface PiRecoveryWriterLease {
  readonly source: PiManagedRecoverySource;
  readonly sourceReadOnly: true;
  readonly authority: {
    readonly projectId: string;
    readonly featureId: string;
    readonly taskId: string;
    readonly taskStatus: 'unfinished';
    readonly previousAttemptId: string;
    readonly previousSessionId: string;
  };
  readonly writer: {
    readonly purpose: 'work';
    readonly attemptId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly executionVersion: number;
    readonly owner: RuntimeExecutionRequest['owner'];
    readonly exclusive: true;
  };
  /** Must verify current Core ownership/continuation eligibility, without mutating business facts. */
  assertCurrent(): Promise<void>;
  /** Trusted Artifact verifier, never an arbitrary native path reader. */
  readVerifiedArtifact(ref: ExecutionInputRef): Promise<Uint8Array>;
  /** Releases adapter ownership only, never Core locks or budget. */
  release(): Promise<void>;
}

/** Trusted Host/Core seam; acquisition must atomically exclude another writer and bind current eligibility. */
export interface PiRecoverySourceManager {
  acquire(request: RuntimeExecutionRequest, source: RuntimeRecoveryReference): Promise<PiRecoveryWriterLease>;
}

export interface PiSession {
  /** Standard SDK request boundary; absent on older/custom sessions means no safe retry. */
  readonly agent?: Pick<Agent, 'streamFunction'>;
  setAutoRetryEnabled?(enabled: boolean): void;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  /** Standard AgentSession exposes this idle barrier; older test doubles may omit it. */
  waitForIdle?(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiSessionFactoryOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialRef: { readonly kind: 'trusted-resolution'; readonly id: string };
  readonly resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
  readonly thinkingLevel?: NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
  readonly recovery?: PiPreparedRecovery;
  /** P05-1 / F-006：本次执行的受限提交工具（可信装配注入；空缺省 = 无自定义工具）。 */
  readonly customTools?: readonly PiSubmissionToolDefinition[];
}

export type PiSessionFactory = (options: PiSessionFactoryOptions) => Promise<PiSession>;

/** 受限提交工具名词法（与 SDK 工具名同一保守形态；防注入/伪装）。 */
const PI_SUBMISSION_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * P05-1 / F-006：受限提交自定义工具的结构化定义（不加载 SDK 类型；仅由可信
 * Host/Runner 装配提供，适配器不发明工具、不从请求/模型输出推导）。结构上
 * 兼容 SDK customTools 的 ToolDefinition；在 SDK 边界处受控转换。
 */
export interface PiSubmissionToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** 参数 schema（JSON Schema/TypeBox 形态；由 SDK 在调用前验证）。 */
  readonly parameters: unknown;
  readonly outputSchema?: unknown;
  readonly promptSnippet?: string;
  readonly executionMode?: 'sequential' | 'parallel';
  /** 受限执行：参数与结果由工具实现受控映射；signal 传递取消。 */
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** 校验受限提交工具定义形态（名字词法/去重/描述有界；execute 必须存在）。 */
export function validatePiSubmissionTools(tools: readonly PiSubmissionToolDefinition[]): readonly PiSubmissionToolDefinition[] {
  const seen = new Set<string>();
  return tools.map(tool => {
    if (tool === null || typeof tool !== 'object') throw startupError('submission_tool_invalid', 'customTools');
    if (typeof tool.name !== 'string' || !PI_SUBMISSION_TOOL_NAME_PATTERN.test(tool.name)
      || typeof tool.label !== 'string' || tool.label.length === 0 || tool.label.length > 128
      || typeof tool.description !== 'string' || tool.description.length === 0 || tool.description.length > 4096
      || tool.parameters === null || typeof tool.parameters !== 'object'
      || typeof tool.execute !== 'function') throw startupError('submission_tool_invalid', `customTools:${tool.name}`);
    if (seen.has(tool.name)) throw startupError('submission_tool_duplicate', `customTools:${tool.name}`);
    seen.add(tool.name);
    return tool;
  });
}

/** Shared lazy SDK boundary for construction and native-session identity checks. */
async function loadPiSdk() {
  return await import('@earendil-works/pi-coding-agent');
}

/** 标准 SDK 的实际初始化入口：受管 SessionManager + 受控 resourceLoader。 */
export function createPiSdkSessionFactory(assembly: PiTrustedAssembly): PiSessionFactory {
  return async ({ cwd, agentDir, sessionDir, provider, model, resourceLoader, thinkingLevel, recovery, customTools }) => {
    const resolvedModel = assembly.resolveModel?.(provider, model);
    if (resolvedModel === undefined) {
      throw new RuntimeError('configuration', 'model_resolution_unavailable', { field: 'strategy.model' });
    }
    if (resolvedModel.provider !== provider || resolvedModel.id !== model) {
      throw new RuntimeError('configuration', 'resolved_model_mismatch');
    }
    const sdk = await loadPiSdk();
    const { createAgentSession, VERSION, CURRENT_SESSION_VERSION } = sdk;
    if (VERSION !== PI_SDK_VERSION || String(CURRENT_SESSION_VERSION) !== PI_NATIVE_SESSION_FORMAT_VERSION) {
      throw new RuntimeError('configuration', 'sdk_version_incompatible');
    }
    const sessionManager = await createPiManagedSessionManager(sdk, cwd, sessionDir, recovery);
    // P05-1 / F-006：受限提交工具只以显式白名单激活（内置工具保持全部禁用，
    // 与 noTools:'all' 同一排除面）；结构化定义在 SDK 边界受控转换。
    const submissionTools = customTools === undefined ? [] : validatePiSubmissionTools(customTools);
    const result = await createAgentSession({
      cwd,
      agentDir,
      model: resolvedModel,
      resourceLoader,
      sessionManager,
      thinkingLevel: thinkingLevel ?? 'off',
      ...(submissionTools.length > 0
        ? {
            customTools: submissionTools as unknown as NonNullable<CreateAgentSessionOptions['customTools']>,
            tools: submissionTools.map(tool => tool.name),
          }
        : { noTools: 'all' as const }),
    });
    try {
      if (result.session.model?.provider !== provider || result.session.model.id !== model ||
          result.session.thinkingLevel !== (thinkingLevel ?? 'off')) {
        throw new RuntimeError('configuration', 'actual_model_configuration_mismatch');
      }
      await recovery?.assertCurrent();
      return result.session;
    } catch (error) { result.session.dispose(); throw error; }
  };
}

export interface PiRuntimeAdapterOptions {
  readonly providers: readonly ProviderCapabilityDescriptor[];
  readonly permissionGrants: readonly string[];
  readonly isolationModes: readonly string[];
  readonly assembly: PiTrustedAssembly;
  readonly sessionFactory?: PiSessionFactory;
  /** Explicit environment-specific evidence. Defaults remain unsupported pending authorized live validation. */
  readonly recoveryCapabilities?: RuntimeRecoveryCapabilities;
  /** Trusted Host policy, bounded again by Core; never read from prompt or SDK output. */
  readonly requestRetryPolicy?: RuntimeRetryPolicy;
}

export interface PiRuntimeRegistration {
  readonly descriptor: PiRuntimeDescriptor;
  readonly capabilities: PiRuntimeCapabilities;
  readonly recoveryCapabilities: RuntimeRecoveryCapabilities;
  readonly adapter: RuntimeAdapter;
}

export function createPiRuntimeDescriptor(options: Pick<PiRuntimeAdapterOptions, 'providers' | 'permissionGrants' | 'isolationModes'>): PiRuntimeDescriptor {
  return Object.freeze({
    schemaVersion: 1,
    runtimeId: PI_RUNTIME_ID,
    contractVersion: RUNTIME_ADAPTER_CONTRACT_VERSION,
    adapterVersion: PI_ADAPTER_VERSION,
    sdkVersion: PI_SDK_VERSION,
    providers: options.providers.map((provider) => ({
      providerId: provider.providerId,
      ...(provider.models === undefined ? {} : { models: [...provider.models] }),
    })),
    permissionGrants: [...options.permissionGrants],
    isolationModes: [...options.isolationModes],
  });
}

function startupError(reason: string, field: string): RuntimeError {
  return new RuntimeError('configuration', reason, { field });
}

function managedSessionDirectory(assembly: PiTrustedAssembly, request: RuntimeExecutionRequest, cwd: string): string {
  if (assembly.resolveSessionDirectory !== undefined) return assembly.resolveSessionDirectory(request, cwd);
  const attemptId = request.identity.purpose === 'work' ? request.identity.attemptId : 'chat';
  const scope = createHash('sha256')
    .update(`${request.projectId}\0${request.featureId}\0${attemptId}\0${request.invocationId}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(assembly.agentDir, 'sessions', scope);
}

function preflightCredential(credential: { readonly kind: 'trusted-resolution'; readonly id: string } | undefined): { readonly kind: 'trusted-resolution'; readonly id: string } {
  if (credential === undefined) {
    throw new RuntimeError('authentication', 'credential_reference_missing', { field: 'assembly.credentialRef' });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(credential.id)) {
    throw new RuntimeError('authentication', 'credential_reference_invalid', { field: 'assembly.credentialRef.id' });
  }
  return credential;
}

/** P05-1 / F-006：受限提交工具解析（可信装配专属；形态校验在 SDK 边界重复执行）。 */
async function resolveSubmissionTools(
  assembly: PiTrustedAssembly,
  request: RuntimeExecutionRequest,
): Promise<readonly PiSubmissionToolDefinition[]> {
  if (assembly.resolveSubmissionTools === undefined) return [];
  const tools = await assembly.resolveSubmissionTools(request);
  return validatePiSubmissionTools(tools);
}

function verifyActualResourceManifest(
  snapshot: RuntimeWorkAccessSnapshot,
  actual: PiTrustedWorkAccess,
): void {
  const expectedDigest = snapshot.resources.loadManifestDigest;
  if (expectedDigest === undefined) return;
  if (actual.resourceManifest === undefined || actual.resourceManifest.digest !== expectedDigest) {
    throw new RuntimeError('permission', 'work_resource_manifest_mismatch');
  }
  const policy = actual.resourceLoadPolicy;
  const expectedIds = snapshot.resources.entries.map(entry => entry.id).sort();
  if (policy === undefined || policy.allowGlobalScan !== false || policy.allowProjectDirectoryScan !== false
    || policy.allowSdkDefaultScan !== false || JSON.stringify([...policy.selectedResourceIds].sort()) !== JSON.stringify(expectedIds)) {
    throw new RuntimeError('permission', 'work_resource_loader_policy_mismatch');
  }
  try {
    validateProjectResourceLoadManifest(actual.resourceManifest);
  } catch (error) {
    throw new RuntimeError('permission', 'work_resource_manifest_invalid', { cause: error });
  }
}
function resolveTrustedAccess(assembly: PiTrustedAssembly, request: RuntimeExecutionRequest): Promise<PiTrustedWorkAccess | undefined> {
  if (request.workAccess === undefined) {
    if (assembly.prepareAccess !== undefined) {
      return Promise.reject(new RuntimeError('authentication', 'work_access_snapshot_missing', { field: 'request.workAccess' }));
    }
    return Promise.resolve(undefined);
  }
  if (assembly.prepareAccess === undefined) {
    return Promise.reject(new RuntimeError('authentication', 'work_access_preflight_missing', { field: 'assembly.prepareAccess' }));
  }
  return assembly.prepareAccess(request).then((actual) => {
    if (actual.snapshot.authentication.status !== 'ready') {
      throw new RuntimeError('authentication', 'work_authentication_not_ready');
    }
    if (actual.snapshot.resources.entries.some(entry => entry.status !== 'available'
      && (entry.required !== false || entry.onUnavailable !== 'omit'))) {
      throw new RuntimeError('permission', 'resource_not_authorized');
    }
    if (!isDeepStrictEqual(actual.snapshot, request.workAccess)) {
      throw new RuntimeError('authentication', 'work_access_snapshot_mismatch');
    }
    verifyActualResourceManifest(request.workAccess!, actual);
    return actual;
  }).catch(error => {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('authentication', 'work_access_preflight_failed', { cause: error });
  });
}

function classifyPiFailure(value: unknown, fallback: string, fallbackKind: RuntimeErrorKind = 'provider'): RuntimeError {
  if (value instanceof RuntimeError) return value;
  const message = value instanceof Error ? value.message : '';
  const normalized = message.toLowerCase();
  if (/credential|api key|unauthoriz|forbidden|authentication|permission/.test(normalized)) {
    return new RuntimeError('authentication', 'authentication_error');
  }
  if (/context|token limit|too many tokens|maximum.*token|prompt.*long/.test(normalized)) {
    return new RuntimeError('configuration', 'context_error');
  }
  if (/model|provider|network|timeout|overloaded|unavailable/.test(normalized)) {
    return new RuntimeError('provider', 'provider_error');
  }
  return new RuntimeError(fallbackKind, fallback);
}

function failureReason(error: RuntimeError): string {
  return error.reason;
}

/** Reuse Core's capability decision with its narrow request shape. */
function piRecoveryDecision(request: RuntimeExecutionRequest, capabilities: RuntimeRecoveryCapabilities): RuntimeRecoveryDecision {
  return decideRuntimeRecovery({ schemaVersion: request.schemaVersion, projectId: request.projectId,
    sessionId: request.sessionId, executionVersion: request.executionVersion, identity: request.identity,
    invocationId: request.invocationId, strategy: request.strategy, recovery: request.recovery }, capabilities);
}

/** 启动 SDK 前复核 provider/model、权限、隔离和恢复边界。 */
export function assertPiStartupCompatible(
  request: RuntimeExecutionRequest,
  descriptor: PiRuntimeDescriptor,
  capabilities: RuntimeRecoveryCapabilities = PI_RUNTIME_RECOVERY_CAPABILITIES,
): void {
  const provider = descriptor.providers.find((candidate) => candidate.providerId === request.strategy.provider);
  if (provider === undefined) throw startupError('unknown_provider', 'strategy.provider');
  if (provider.models !== undefined && provider.models.length > 0 && !provider.models.includes(request.strategy.model)) {
    throw startupError('unsupported_model', 'strategy.model');
  }
  if (!descriptor.permissionGrants.every((grant) => request.permissions.grants.includes(grant))) {
    throw new RuntimeError('permission', 'required_permission_not_granted', { field: 'permissions.grants' });
  }
  if (!descriptor.isolationModes.includes(request.permissions.isolation)) {
    throw new RuntimeError('permission', 'unsupported_isolation', { field: 'permissions.isolation' });
  }
  if (piRecoveryDecision(request, capabilities).mode === 'rejected') {
    throw startupError('execution_recovery_unsupported', 'recovery.mode');
  }
}

function identityToken(value: unknown, fallback: string): string {
  return token(typeof value === 'string' && value.length > 0 ? value : fallback);
}

export function piRuntimeEventPrefix(request: RuntimeExecutionRequest): string {
  return `pi.${createHash('sha256')
    .update(`${request.sessionId}\0${request.invocationId}\0${request.executionVersion}`)
    .digest('hex').slice(0, 24)}.`;
}

function eventId(request: RuntimeExecutionRequest, sequence: number): string {
  return `${piRuntimeEventPrefix(request)}${sequence}`;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
    return '';
  }).join('');
}

function usageOf(message: unknown, nativeSdkMessageUsage = false): RuntimeUsageReport | null {
  if (message === null || typeof message !== 'object') return null;
  if ((message as Record<symbol, unknown>)[Symbol.for('shiploop.pi.usageUnavailable')] === true) return null;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return null;
  const raw = usage as Record<string, unknown>;
  const inputTokens = typeof raw.input === 'number' && Number.isSafeInteger(raw.input) && raw.input >= 0 ? raw.input : null;
  const outputTokens = typeof raw.output === 'number' && Number.isSafeInteger(raw.output) && raw.output >= 0 ? raw.output : null;
  const cost = raw.cost !== null && typeof raw.cost === 'object' ? raw.cost as Record<string, unknown> : undefined;
  const total = cost?.total;
  const costUsdMicros = typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.round(total * 1_000_000)
    : null;
  if (inputTokens === null && outputTokens === null && costUsdMicros === null) return null;
  // Pi 1.0.4 emits the finalized request's usage on each native assistant
  // message (pi-ai/api/openai-responses-shared finalizeResponse). Session
  // totals and arbitrary injected session events have no such scope proof.
  if (nativeSdkMessageUsage && messageRole(message) === 'assistant'
      && ['stop', 'toolUse', 'length'].includes(messageStopReason(message) ?? '')
      && inputTokens !== null && outputTokens !== null) {
    const count = (field: string) => typeof raw[field] === 'number' && Number.isSafeInteger(raw[field]) && raw[field] >= 0
      ? raw[field] as number : null;
    return { basis: 'reported', inputTokens, outputTokens, costUsdMicros,
      cacheReadTokens: count('cacheRead'), cacheWriteTokens: count('cacheWrite'), reasoningTokens: count('reasoning'),
      providerTotalTokens: count('totalTokens'), cacheReadIncludedInInput: false, cacheWriteIncludedInInput: false,
      coverage: 'partial', normalization: 'raw', completeness: 'partial', accounting: 'incremental',
      sourceRefs: ['pi-sdk-1.0.4-assistant-message'] };
  }
  // Pi exposes message usage but does not identify whether it is a delta or a
  // session cumulative total. Keep the fact usable while preserving that gap.
  return { basis: 'reported', inputTokens, outputTokens, costUsdMicros, completeness: 'unknown', accounting: 'unknown' };
}

function messageRole(message: unknown): string {
  return message !== null && typeof message === 'object' && typeof (message as { role?: unknown }).role === 'string'
    ? (message as { role: string }).role
    : 'assistant';
}

function messageStopReason(message: unknown): string | undefined {
  return message !== null && typeof message === 'object' && typeof (message as { stopReason?: unknown }).stopReason === 'string'
    ? (message as { stopReason: string }).stopReason
    : undefined;
}

class EventChannel implements AsyncIterable<unknown> {
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private done = false;

  push(value: unknown): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.pending.push(value);
  }

  close(): void {
    this.done = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const value = this.pending.shift();
        if (value !== undefined) return { done: false, value };
        if (this.done) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function runtimeEvent(request: RuntimeExecutionRequest, sequence: number, kind: RuntimeEvent['kind'], payload: RuntimeEvent['payload']): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: eventId(request, sequence),
    kind,
    sequence,
    occurredAtUtc: new Date().toISOString(),
    payload,
  };
}

export function createPiRuntimeAdapter(options: PiRuntimeAdapterOptions): PiRuntimeRegistration {
  const descriptor = createPiRuntimeDescriptor(options);
  const sessionFactory = options.sessionFactory ?? createPiSdkSessionFactory(options.assembly);
  const recoveryCapabilities = options.recoveryCapabilities === undefined ? PI_RUNTIME_RECOVERY_CAPABILITIES
    : validateRuntimeRecoveryCapabilities(options.recoveryCapabilities);
  if (recoveryCapabilities.runtimeId !== PI_RUNTIME_ID || recoveryCapabilities.sdkVersion !== PI_SDK_VERSION ||
      recoveryCapabilities.adapterVersion !== PI_ADAPTER_VERSION ||
      recoveryCapabilities.capabilities.executionRecovery.status === 'verified') {
    throw startupError('recovery_evidence_incompatible', 'recoveryCapabilities');
  }
  const adapter: RuntimeAdapter = {
    async start(request): Promise<RuntimeHandle> {
      assertPiStartupCompatible(request, descriptor, recoveryCapabilities);
      const access = await resolveTrustedAccess(options.assembly, request);
      const credentialRef = preflightCredential(access?.credentialRef ?? options.assembly.credentialRef);
      const resourceLoader = access?.resourceLoader ?? options.assembly.resourceLoader;
      if (request.workAccess !== undefined && request.workAccess.authentication.status !== 'ready') {
        throw new RuntimeError('authentication', 'work_authentication_not_ready');
      }
      let prompt: string;
      try {
        prompt = await options.assembly.inputReader.read(request.prompt);
        await options.assembly.inputReader.read(request.inputManifest);
      } catch (error) {
        throw classifyPiFailure(error, 'input_binding_failed', 'configuration');
      }
      const cwd = options.assembly.resolveWorkingDirectory(request.cwd);
      const sessionDir = managedSessionDirectory(options.assembly, request, cwd);
      const thinkingLevel = options.assembly.resolveThinkingLevel?.(request) ?? 'off';
      // P05-1 / F-006：受限提交工具由可信装配按请求解析（不可用时不注入工具）。
      const submissionTools = await resolveSubmissionTools(options.assembly, request);
      let lease: PiRecoveryWriterLease | undefined;
      let prepared: PiPreparedRecovery | undefined;
      let decision: RuntimeRecoveryDecision;
      let session: PiSession;
      try {
        if (request.recovery.mode !== 'new' && request.recovery.source !== undefined) {
          if (options.assembly.recoverySourceManager === undefined) throw startupError('recovery_source_manager_unavailable', 'recovery');
          lease = await options.assembly.recoverySourceManager.acquire(request, request.recovery.source);
          prepared = await preparePiRecovery(request, request.recovery.source, lease);
        }
        decision = piRecoveryDecision(request, recoveryCapabilities);
        if (decision.mode === 'rejected') throw startupError('execution_recovery_unsupported', 'recovery');
        session = await sessionFactory({
          cwd,
          agentDir: options.assembly.agentDir,
          sessionDir,
          provider: request.strategy.provider,
          model: request.strategy.model,
          credentialRef,
          resourceLoader,
          thinkingLevel,
          ...(decision.mode === 'resume' ? { recovery: prepared } : {}),
          ...(submissionTools.length > 0 ? { customTools: submissionTools } : {}),
        });
        if (decision.mode === 'resume') {
          try {
            if (session.model?.provider !== request.strategy.provider || session.model.id !== request.strategy.model ||
                session.thinkingLevel !== thinkingLevel ||
                session.sessionId === undefined || session.sessionId === prepared?.reference.providerSessionId) {
              throw startupError('actual_model_configuration_mismatch', 'strategy');
            }
            await lease!.assertCurrent();
          } catch (error) { session.dispose(); throw error; }
        }
      } catch (error) {
        await lease?.release();
        throw classifyPiFailure(error, 'sdk_initialization_failed', 'configuration');
      }
      let nativeSdkMessageUsage = false;
      if (session.agent !== undefined && session.model !== undefined) {
        try {
          const sdk = await loadPiSdk();
          nativeSdkMessageUsage = sdk.VERSION === PI_SDK_VERSION && sdk.VERSION === '1.0.4' && session instanceof sdk.AgentSession;
        } catch { /* Unknown/custom sessions retain unknown accounting. */ }
      }
      const events = new EventChannel();
      let sequence = 0;
      let lastUsage: RuntimeUsageReport | null = null;
      let terminal: 'completed' | 'failed' | 'cancelled' | 'timed_out' = 'completed';
      let terminalReason: string | null = null;
      let terminalObserved = false;
      let cancelRequested = false;
      let finalized = false, idleObserved = false, cleanupSucceeded = true;
      let stopReason: 'cancelled' | 'timed_out' | null = null;
      let cancelPromise: Promise<RuntimeCancelReceipt> | undefined;
      let resolveStop!: () => void;
      const stopBoundary = new Promise<void>(resolve => { resolveStop = resolve; });
      let stopTimer: NodeJS.Timeout | undefined;
      const retryAbort = new AbortController();
      let lastRequestFailure: RuntimeFailureClassification | null = null;
      const cancel = (reason: 'cancelled' | 'timed_out' = 'cancelled'): Promise<RuntimeCancelReceipt> => {
        if (cancelPromise) return cancelPromise;
        if (finalized) return Promise.resolve({ accepted: false, reason: 'already_settled' });
        cancelRequested = true;
        retryAbort.abort();
        stopReason = reason;
        stopTimer = setTimeout(resolveStop, PI_ABORT_WAIT_MS + PI_STOP_WAIT_MS);
        cancelPromise = observePiWithin(Promise.resolve().then(() => session.abort()), PI_ABORT_WAIT_MS).then(outcome => {
          if (outcome.status === 'fulfilled') return { accepted: true, reason: null };
          const code = outcome.status === 'timeout' ? 'sdk_abort_timeout' : 'sdk_abort_failed';
          if (!finalized) diagnostic(code, code);
          return { accepted: false, reason: code };
        });
        return cancelPromise;
      };
      let messageOrdinal = 0;
      let identityGapReported = false;
      let snapshotGapReported = false;
      let activeMessageKey: string | undefined;
      const pendingMessages = new Map<string, { message: unknown; usage: RuntimeUsageReport | null }>();
      const emittedMessages = new Set<string>();
      const emittedUsage = new Set<string>();
      const emittedToolStarts = new Set<string>();
      const emittedToolEnds = new Set<string>();
      const diagnosticRefs: string[] = [];
      const startedAt = Date.now();
      const publish = (kind: RuntimeEvent['kind'], payload: RuntimeEvent['payload']): RuntimeEvent => {
        sequence += 1;
        if (kind === 'usage') {
          lastUsage = (payload as Extract<RuntimeEvent['payload'], { readonly kind: 'usage' }>).usage;
        }
        const emitted = runtimeEvent(request, sequence, kind, payload);
        if (kind === 'diagnostic' && diagnosticRefs.length < 32) diagnosticRefs.push(emitted.eventId);
        events.push(emitted);
        return emitted;
      };
      const objectId = (value: unknown): string | undefined => {
        if (value === null || typeof value !== 'object') return undefined;
        const raw = value as Record<string, unknown>;
        for (const key of ['id', 'messageId', 'toolCallId']) {
          if (typeof raw[key] === 'string' && raw[key].length > 0) return raw[key];
        }
        return undefined;
      };
      const messageKeyFor = (type: string, message: unknown): string => {
        const id = objectId(message);
        if (id !== undefined) return identityToken(id, `${request.invocationId}-message`);
        if (request.recovery.mode !== 'new' && !identityGapReported) {
          identityGapReported = true;
          diagnostic('pi.recovery.event_identity_unknown', 'SDK message identity is local to this invocation');
        }
        if (type === 'message_start' || activeMessageKey === undefined) {
          messageOrdinal += 1;
          activeMessageKey = identityToken(undefined, `${request.invocationId}-message-${messageOrdinal}`);
        }
        return activeMessageKey;
      };
      const rememberMessage = (type: string, message: unknown): string => {
        const key = messageKeyFor(type, message);
        const previous = pendingMessages.get(key);
        pendingMessages.set(key, { message, usage: usageOf(message, nativeSdkMessageUsage) ?? previous?.usage ?? null });
        return key;
      };
      const flushMessage = (key: string): void => {
        const pending = pendingMessages.get(key);
        if (pending === undefined || emittedMessages.has(key)) return;
        emittedMessages.add(key);
        const message = pending.message;
        const role = messageRole(message);
        const content = message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : undefined;
        const preview = textOf(content).slice(0, 200);
        if (preview.length > 0 && (role === 'assistant' || role === 'user' || role === 'tool' || role === 'system')) {
          publish('message', { kind: 'message', messageId: key, role: role as 'assistant' | 'user' | 'tool' | 'system', preview });
        }
        if (pending.usage !== null && !emittedUsage.has(key)) {
          emittedUsage.add(key);
          publish('usage', { kind: 'usage', usage: pending.usage });
        }
      };
      const diagnostic = (code: string, message: string): void => {
        publish('diagnostic', { kind: 'diagnostic', code: token(code), message: message.slice(0, 200) || 'diagnostic' });
      };
      let unsubscribe: () => void = () => undefined;
      let restoreRequestStream = () => {};
      try {
        if (request.identity.purpose === 'work' && session.agent !== undefined && session.setAutoRetryEnabled !== undefined) {
          const { wrapPiRequestStream } = await import('./pi-request-retry.js');
          const agent = session.agent;
          const original = agent.streamFunction;
          session.setAutoRetryEnabled(false);
          const retry = createRuntimeRequestRetryController({
            policy: options.requestRetryPolicy ?? DEFAULT_RUNTIME_REQUEST_RETRY_POLICY,
            deadlineUtcMs: startedAt + request.limits.timeoutMs,
            nowUtcMs: Date.now, runnerAlive: () => !finalized && !cancelRequested,
            signal: retryAbort.signal,
            wait: (delayMs, signal) => waitForRetry(delayMs, undefined, { signal }),
            observe: ({ kind, counters, decision, stopReason }) => {
              if (finalized) return;
              // Small numeric facts and controlled enum values only. Each diagnostic
              // keeps the existing event identity/watermark and redaction boundary.
              diagnostic(`pi.retry.${kind}`, JSON.stringify({ n: counters.requestCount, r: counters.retryCount,
                f: counters.cumulativeFailures, peak: counters.peakConsecutiveFailures,
                fm: counters.failureElapsedMs, bm: counters.backoffElapsedMs,
                ...(decision ? { category: decision.triggerCategory, action: decision.action } : {}),
                ...(stopReason ? { stop: stopReason } : {}) }));
            },
          });
          agent.streamFunction = wrapPiRequestStream(original.bind(agent), retry, message => {
            if (finalized) return;
            const usage = usageOf(message, nativeSdkMessageUsage);
            if (usage !== null) publish('usage', { kind: 'usage', usage });
          }, failure => { if (!finalized) lastRequestFailure = failure; });
          restoreRequestStream = () => { agent.streamFunction = original; };
        }
        unsubscribe = session.subscribe((raw) => {
          if (finalized) return;
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            diagnostic('pi_unknown_event', 'unknown SDK event');
            return;
          }
          const event = raw as Record<string, unknown>;
          const type = typeof event.type === 'string' ? event.type : 'unknown';
          if (type === 'message_start' && event.message !== undefined) {
            rememberMessage(type, event.message);
          } else if (type === 'message_update' && event.message !== undefined) {
            // Updates are coalesced with message_end so a stream is counted once.
            rememberMessage(type, event.message);
          } else if (type === 'message_end' && event.message !== undefined) {
            const key = rememberMessage(type, event.message);
            flushMessage(key);
            const stopReason = messageStopReason(event.message);
            if (stopReason === 'aborted') {
              terminal = 'cancelled';
              terminalReason = 'cancelled';
            } else if (stopReason === 'error') {
              terminal = lastRequestFailure?.category === 'timeout' ? 'timed_out' : 'failed';
              terminalReason = lastRequestFailure?.reason ?? classifyPiFailure(
                event.message !== null && typeof event.message === 'object' ? (event.message as { errorMessage?: unknown }).errorMessage : undefined,
                'model_error',
              ).reason;
            }
          } else if (type === 'agent_end' && Array.isArray(event.messages)) {
            for (const message of event.messages) {
              if (messageRole(message) === 'assistant') {
                const id = objectId(message);
                const key = id === undefined ? undefined : identityToken(id, `${request.invocationId}-message`);
                if (request.recovery.mode === 'new' || (key !== undefined && pendingMessages.has(key))) {
                  flushMessage(rememberMessage(type, message));
                } else if (!snapshotGapReported) {
                  snapshotGapReported = true;
                  diagnostic('pi.recovery.snapshot_scope_unknown', 'Unmatched final messages excluded from current invocation');
                }
              }
            }
          } else if (type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
            const toolCallId = identityToken(event.toolCallId, `${request.invocationId}-tool`);
            if (!emittedToolStarts.has(toolCallId)) {
              emittedToolStarts.add(toolCallId);
              publish('tool_started', { kind: 'tool_started', toolCallId, toolName: identityToken(event.toolName, 'pi-tool') });
            }
          } else if (type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
            const toolCallId = identityToken(event.toolCallId, `${request.invocationId}-tool`);
            if (!emittedToolEnds.has(toolCallId)) {
              emittedToolEnds.add(toolCallId);
              const result = event.result !== null && typeof event.result === 'object' ? event.result as Record<string, unknown> : {};
              const details = result.details !== null && typeof result.details === 'object' ? result.details as Record<string, unknown> : result;
              const exitCode = typeof details.exitCode === 'number' && Number.isInteger(details.exitCode) && details.exitCode >= 0 && details.exitCode <= 255 ? details.exitCode : null;
              const signal = typeof details.signal === 'string' ? token(details.signal) : null;
              const outputBytes = typeof details.outputBytes === 'number' && Number.isSafeInteger(details.outputBytes) && details.outputBytes >= 0 ? details.outputBytes : null;
              publish('tool_finished', {
                kind: 'tool_finished', toolCallId, exitCode, signal,
                reason: event.isError === true ? 'tool_error' : null,
                outputBytes, lastActivityAtUtc: new Date().toISOString(),
              });
            }
          } else if (type === 'agent_settled') {
            terminalObserved = true;
            if (cancelRequested) terminal = 'cancelled';
          } else if (type === 'ui_prompt_start' || type === 'permission_request' || type === 'permission_requested') {
            diagnostic('pi.permission.requested', 'Pi requested permission or user approval');
          } else if (type === 'auto_retry_start' || type === 'auto_retry_end' || type === 'compaction_end') {
            diagnostic(`pi.${type}`, 'Pi emitted a lifecycle diagnostic');
          } else if (type !== 'agent_start' && type !== 'turn_start' && type !== 'turn_end' && type !== 'agent_before_settle'
            && type !== 'message_start' && type !== 'tool_execution_update' && type !== 'ui_prompt_end' && type !== 'queue_update') {
            diagnostic('pi_unknown_event', `SDK event type: ${type.slice(0, 120)}`);
          }
        });
      } catch (error) {
        try {
          restoreRequestStream();
          session.dispose();
          await lease?.release();
        } catch {
          // 保持初始化失败诊断，不让清理异常覆盖它。
        }
        throw classifyPiFailure(error, 'sdk_initialization_failed', 'configuration');
      }

      const executionTimer = setTimeout(() => { void cancel('timed_out'); }, request.limits.timeoutMs);
      const work = (async () => {
        await lease?.assertCurrent();
        await session.prompt(prompt);
        if (session.waitForIdle !== undefined) {
          await session.waitForIdle();
          idleObserved = true;
        }
      })();
      const result = (async () => {
        try {
          const observed = await Promise.race([
            work.then(() => 'finished' as const), stopBoundary.then(() => 'stop_timeout' as const),
          ]);
          if (observed === 'stop_timeout') diagnostic('sdk_stop_timeout', 'SDK idle was not confirmed before the stop deadline');
          if (cancelRequested) {
            await cancelPromise;
            terminal = stopReason === 'timed_out' ? 'timed_out' : 'cancelled';
            terminalReason = stopReason;
          } else if (!terminalObserved) {
            terminal = 'failed';
            terminalReason = 'missing_terminal';
            diagnostic('pi.missing_terminal', 'Pi prompt ended without agent_settled');
          }
        } catch (error) {
          if (cancelRequested) {
            await cancelPromise;
            terminal = stopReason === 'timed_out' ? 'timed_out' : 'cancelled';
            terminalReason = stopReason;
          } else {
            const failure = classifyPiFailure(error, 'model_error');
            terminal = 'failed';
            terminalReason = failureReason(failure);
            terminalObserved = true;
            diagnostic(`pi.${failure.reason}`, failure.reason);
          }
        } finally {
          clearTimeout(executionTimer);
          clearTimeout(stopTimer);
          // Preserve the last partial response and reported usage before closing the stream.
          for (const key of pendingMessages.keys()) flushMessage(key);
          finalized = true;
          retryAbort.abort();
          // An unconfirmed Runner must keep the aborted gate on any late SDK
          // request; restoring the raw transport would bypass its retry budget.
          if (idleObserved) restoreRequestStream();
          try { unsubscribe(); } catch { cleanupSucceeded = false; }
          events.close();
          try { session.dispose(); } catch { cleanupSucceeded = false; }
          // Unknown SDK stop retains adapter ownership; Core occupancy remains Core-owned.
          if (idleObserved && cleanupSucceeded) {
            try { await lease?.release(); } catch { cleanupSucceeded = false; }
          }
        }
        return {
          schemaVersion: 1,
          terminal,
          reason: terminal === 'completed' ? null : terminalReason ?? (terminal === 'cancelled' ? 'cancelled' : 'model_error'),
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          usage: lastUsage,
          lastEventSequence: sequence === 0 ? null : sequence,
          providerSessionId: session.sessionId === undefined ? null : identityToken(session.sessionId, `${request.invocationId}-provider-session`),
          diagnosticRefs,
        };
      })();
      const stopped = result.then(() => ({
        schemaVersion: 1,
        // SDK idle/dispose is one observation, never OS tool/resource stop proof.
        confirmed: false,
        checkedAtUtc: new Date().toISOString(),
        detail: idleObserved && cleanupSucceeded ? 'pi_sdk_idle' : 'pi_sdk_stop_unknown',
      }));
      const recoveryRecording: RuntimeRecoveryRecording | null = request.recovery.mode === 'new' ? null : {
        schemaVersion: 1, requestedMode: request.recovery.mode, source: request.recovery.source ?? null,
        decision, sourceWatermark: null, sourceGaps: [],
        nativeSourceWatermark: prepared?.nativeWatermark === undefined ? null : {
          entryCount: prepared.nativeWatermark.entryCount, lastEntryId: prepared.nativeWatermark.lastEntryId === null
            ? null : identityToken(prepared.nativeWatermark.lastEntryId, 'native-entry'),
        },
        sourceSdkVersion: lease?.source.sdkVersion ?? null,
        sdkVersion: PI_SDK_VERSION, nativeFormat: PI_NATIVE_SESSION_FORMAT,
        nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION,
        providerSessionId: session.sessionId === undefined ? null : identityToken(session.sessionId, `${request.invocationId}-provider-session`),
        actualProvider: session.model?.provider ?? null, actualModel: session.model?.id ?? null,
        historicalUsage: 'excluded_unknown_scope', newEvents: { firstSequence: 1, scope: 'current_invocation' },
        coverage: 'partial', gaps: ['native_cumulative_scope_unknown',
          ...(session.model === undefined ? ['actual_model_unknown'] : [])],
      };
      return {
        events,
        result,
        stopped,
        recoveryRecording: Promise.resolve(recoveryRecording),
        nativeSession: {
          runtimeId: PI_RUNTIME_ID,
          providerSessionId: session.sessionId === undefined ? null : identityToken(session.sessionId, `${request.invocationId}-provider-session`),
          sessionFile: session.sessionFile ?? null,
          nativeFormat: PI_NATIVE_SESSION_FORMAT,
          nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION,
          adapterVersion: PI_ADAPTER_VERSION,
          sdkVersion: PI_SDK_VERSION,
          recovery: {
            decision,
            ...(prepared === undefined || request.recovery.mode === 'new' ? {} : { source: request.recovery.source }),
            evidenceRef: (decision.mode === 'resume' ? recoveryCapabilities.capabilities.conversationResume.evidenceRef : undefined) ?? PI_RECOVERY_EVIDENCE_REF,
            nativeForkEvidenceRef: recoveryCapabilities.capabilities.nativeFork.evidenceRef,
            thinkingLevel: session.thinkingLevel ?? thinkingLevel,
            provider: request.strategy.provider,
            model: request.strategy.model,
          },
        },
        cancel: () => cancel(),
      };
    },
  };
  return { descriptor, capabilities: PI_RUNTIME_CAPABILITIES,
    recoveryCapabilities, adapter };
}
