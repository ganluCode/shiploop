/**
 * P04-1 标准 Pi Coding Agent 适配器。
 *
 * 该模块是唯一加载 Pi SDK 的生产边界。SDK 会话工厂、受控工作目录和输入
 * 读取器都由可信 Host/Runner 装配注入；本模块不访问 Core 存储、不解析模块
 * 路径、不发现全局插件，也不把凭据传入 prompt、argv 或事件正文。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { observePiWithin, PI_ABORT_WAIT_MS, PI_STOP_WAIT_MS } from './pi-lifecycle.js';
import type {
  CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type {
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
} from 'shiploop-core';
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RuntimeError,
} from 'shiploop-core';

export const PI_RUNTIME_ID = 'pi';
export const PI_ADAPTER_VERSION = '0.1.0';
export const PI_SDK_LICENSE = 'MIT';
/** Locked SDK version; loading the SDK is reserved for an authorized Runner start. */
export const PI_SDK_VERSION = '1.0.4';

export type PiCapabilityStatus = 'supported' | 'unsupported' | 'unknown' | 'not_ready';

export interface PiRuntimeCapabilities {
  readonly events: PiCapabilityStatus;
  readonly usage: PiCapabilityStatus;
  readonly cancel: PiCapabilityStatus;
  readonly stopped: PiCapabilityStatus;
  readonly conversationResume: PiCapabilityStatus;
  readonly executionRecovery: PiCapabilityStatus;
}

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
}

export interface PiTrustedWorkAccess {
  readonly snapshot: RuntimeWorkAccessSnapshot;
  readonly credentialRef: { readonly kind: 'trusted-resolution'; readonly id: string };
  readonly resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
}

export interface PiSession {
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
}

export type PiSessionFactory = (options: PiSessionFactoryOptions) => Promise<PiSession>;

/** 标准 SDK 的实际初始化入口：受管 SessionManager + 受控 resourceLoader。 */
export function createPiSdkSessionFactory(assembly: PiTrustedAssembly): PiSessionFactory {
  return async ({ cwd, agentDir, sessionDir, provider, model, resourceLoader }) => {
    const resolvedModel = assembly.resolveModel?.(provider, model);
    if (resolvedModel === undefined) {
      throw new RuntimeError('configuration', 'model_resolution_unavailable', { field: 'strategy.model' });
    }
    const { createAgentSession, SessionManager, VERSION } = await import('@earendil-works/pi-coding-agent');
    if (VERSION !== PI_SDK_VERSION) throw new RuntimeError('configuration', 'sdk_version_incompatible');
    const result = await createAgentSession({
      cwd,
      agentDir,
      model: resolvedModel,
      resourceLoader,
      sessionManager: SessionManager.create(cwd, sessionDir),
      noTools: 'all',
    });
    return result.session;
  };
}

export interface PiRuntimeAdapterOptions {
  readonly providers: readonly ProviderCapabilityDescriptor[];
  readonly permissionGrants: readonly string[];
  readonly isolationModes: readonly string[];
  readonly assembly: PiTrustedAssembly;
  readonly sessionFactory?: PiSessionFactory;
}

export interface PiRuntimeRegistration {
  readonly descriptor: PiRuntimeDescriptor;
  readonly capabilities: PiRuntimeCapabilities;
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
    if (actual.snapshot.resources.entries.some(entry => entry.status !== 'available')) {
      throw new RuntimeError('permission', 'resource_not_authorized');
    }
    if (!isDeepStrictEqual(actual.snapshot, request.workAccess)) {
      throw new RuntimeError('authentication', 'work_access_snapshot_mismatch');
    }
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

/** 启动 SDK 前复核 provider/model、权限、隔离和恢复边界。 */
export function assertPiStartupCompatible(
  request: RuntimeExecutionRequest,
  descriptor: PiRuntimeDescriptor,
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
  if (request.recovery.mode !== 'new') {
    throw startupError('execution_recovery_unsupported', 'recovery.mode');
  }
}

function token(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : `pi-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
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

function usageOf(message: unknown): RuntimeUsageReport | null {
  if (message === null || typeof message !== 'object') return null;
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
  const adapter: RuntimeAdapter = {
    async start(request): Promise<RuntimeHandle> {
      assertPiStartupCompatible(request, descriptor);
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
      let session: PiSession;
      try {
        session = await sessionFactory({
          cwd,
          agentDir: options.assembly.agentDir,
          sessionDir,
          provider: request.strategy.provider,
          model: request.strategy.model,
          credentialRef,
          resourceLoader,
        });
      } catch (error) {
        throw classifyPiFailure(error, 'sdk_initialization_failed', 'configuration');
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
      const cancel = (reason: 'cancelled' | 'timed_out' = 'cancelled'): Promise<RuntimeCancelReceipt> => {
        if (cancelPromise) return cancelPromise;
        if (finalized) return Promise.resolve({ accepted: false, reason: 'already_settled' });
        cancelRequested = true;
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
        if (type === 'message_start' || activeMessageKey === undefined) {
          messageOrdinal += 1;
          activeMessageKey = identityToken(undefined, `${request.invocationId}-message-${messageOrdinal}`);
        }
        return activeMessageKey;
      };
      const rememberMessage = (type: string, message: unknown): string => {
        const key = messageKeyFor(type, message);
        const previous = pendingMessages.get(key);
        pendingMessages.set(key, { message, usage: usageOf(message) ?? previous?.usage ?? null });
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
      try {
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
              terminal = 'failed';
              terminalReason = classifyPiFailure(
                event.message !== null && typeof event.message === 'object' ? (event.message as { errorMessage?: unknown }).errorMessage : undefined,
                'model_error',
              ).reason;
            }
          } else if (type === 'agent_end' && Array.isArray(event.messages)) {
            for (const message of event.messages) {
              if (messageRole(message) === 'assistant') flushMessage(rememberMessage(type, message));
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
          session.dispose();
        } catch {
          // 保持初始化失败诊断，不让清理异常覆盖它。
        }
        throw classifyPiFailure(error, 'sdk_initialization_failed', 'configuration');
      }

      const executionTimer = setTimeout(() => { void cancel('timed_out'); }, request.limits.timeoutMs);
      const work = (async () => {
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
          try { unsubscribe(); } catch { cleanupSucceeded = false; }
          events.close();
          try { session.dispose(); } catch { cleanupSucceeded = false; }
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
      return {
        events,
        result,
        stopped,
        nativeSession: {
          runtimeId: PI_RUNTIME_ID,
          providerSessionId: session.sessionId === undefined ? null : identityToken(session.sessionId, `${request.invocationId}-provider-session`),
          sessionFile: session.sessionFile ?? null,
        },
        cancel: () => cancel(),
      };
    },
  };
  return { descriptor, capabilities: PI_RUNTIME_CAPABILITIES, adapter };
}
