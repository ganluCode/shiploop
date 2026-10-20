/**
 * P04-1 标准 Pi Coding Agent 适配器。
 *
 * 该模块是唯一加载 Pi SDK 的生产边界。SDK 会话工厂、受控工作目录和输入
 * 读取器都由可信 Host/Runner 装配注入；本模块不访问 Core 存储、不解析模块
 * 路径、不发现全局插件，也不把凭据传入 prompt、argv 或事件正文。
 */
import { createHash } from 'node:crypto';
import {
  createAgentSession,
  VERSION as PI_SDK_VERSION,
} from '@earendil-works/pi-coding-agent';
import type {
  CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type {
  ProviderCapabilityDescriptor,
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeEvent,
  RuntimeExecutionRequest,
  RuntimeHandle,
  RuntimeUsageReport,
} from 'shiploop-core';
import {
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RuntimeError,
} from 'shiploop-core';

export const PI_RUNTIME_ID = 'pi';
export const PI_ADAPTER_VERSION = '0.1.0';
export const PI_SDK_LICENSE = 'MIT';
export { PI_SDK_VERSION };

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
}

export interface PiSession {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type PiSessionFactory = (options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
}) => Promise<PiSession>;

/** 标准 SDK 的实际初始化入口：createAgentSession(cwd, agentDir, resourceLoader)。 */
export function createPiSdkSessionFactory(assembly: PiTrustedAssembly): PiSessionFactory {
  return async ({ cwd, agentDir, resourceLoader }) => {
    const result = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
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
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : 'pi-event';
}

function eventId(request: RuntimeExecutionRequest, sequence: number): string {
  return createHash('sha256')
    .update(`${request.sessionId}\0${request.invocationId}\0${request.executionVersion}\0${sequence}`)
    .digest('hex')
    .slice(0, 24);
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
  const inputTokens = typeof raw.input === 'number' && Number.isSafeInteger(raw.input) ? raw.input : null;
  const outputTokens = typeof raw.output === 'number' && Number.isSafeInteger(raw.output) ? raw.output : null;
  const total = raw.cost !== null && typeof raw.cost === 'object'
    ? (raw.cost as { total?: unknown }).total
    : undefined;
  const costUsdMicros = typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.round(total * 1_000_000)
    : null;
  if (inputTokens === null && outputTokens === null && costUsdMicros === null) return null;
  return { basis: 'reported', inputTokens, outputTokens, costUsdMicros };
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
      const prompt = await options.assembly.inputReader.read(request.prompt);
      const cwd = options.assembly.resolveWorkingDirectory(request.cwd);
      const session = await sessionFactory({
        cwd,
        agentDir: options.assembly.agentDir,
        resourceLoader: options.assembly.resourceLoader,
      });
      const events = new EventChannel();
      let sequence = 0;
      let lastUsage: RuntimeUsageReport | null = null;
      let terminal: 'completed' | 'failed' | 'cancelled' = 'completed';
      let cancelRequested = false;
      const startedAt = Date.now();
      const publish = (kind: RuntimeEvent['kind'], payload: RuntimeEvent['payload']): void => {
        sequence += 1;
        if (kind === 'usage') {
          lastUsage = (payload as Extract<RuntimeEvent['payload'], { readonly kind: 'usage' }>).usage;
        }
        events.push(runtimeEvent(request, sequence, kind, payload));
      };
      const unsubscribe = session.subscribe((raw) => {
        if (raw === null || typeof raw !== 'object') {
          publish('diagnostic', { kind: 'diagnostic', code: 'pi_unknown_event', message: 'unknown event' });
          return;
        }
        const event = raw as Record<string, unknown>;
        const type = typeof event.type === 'string' ? event.type : 'unknown';
        if (type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
          publish('tool_started', { kind: 'tool_started', toolCallId: token(event.toolCallId), toolName: token(event.toolName) });
        } else if (type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
          const isError = event.isError === true;
          publish('tool_finished', {
            kind: 'tool_finished', toolCallId: token(event.toolCallId), exitCode: null, signal: null,
            reason: isError ? 'tool_error' : null,
          });
        } else if (type === 'message_end') {
          const message = event.message;
          const usage = usageOf(message);
          if (usage !== null) publish('usage', { kind: 'usage', usage });
          if (messageRole(message) === 'assistant') {
            const preview = textOf(message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : undefined).slice(0, 200);
            if (preview.length > 0) {
              publish('message', { kind: 'message', messageId: token(eventId(request, sequence + 1)), role: 'assistant', preview });
            }
          }
          const stopReason = messageStopReason(message);
          if (stopReason === 'aborted') terminal = 'cancelled';
          else if (stopReason === 'error') terminal = 'failed';
        } else if (type !== 'agent_start' && type !== 'turn_start' && type !== 'turn_end' && type !== 'agent_end' && type !== 'message_start' && type !== 'message_update' && type !== 'tool_execution_update') {
          publish('diagnostic', { kind: 'diagnostic', code: 'pi_unknown_event', message: 'unknown event' });
        }
      });

      const result = (async () => {
        try {
          await session.prompt(prompt);
          if (cancelRequested) terminal = 'cancelled';
        } catch {
          terminal = cancelRequested ? 'cancelled' : 'failed';
        } finally {
          unsubscribe();
          events.close();
          session.dispose();
        }
        return {
          schemaVersion: 1,
          terminal,
          reason: terminal === 'completed' ? null : terminal === 'cancelled' ? 'cancelled' : 'sdk_prompt_failed',
          exitCode: null,
          signal: null,
          durationMs: Date.now() - startedAt,
          usage: lastUsage,
          lastEventSequence: sequence === 0 ? null : sequence,
        };
      })();
      const stopped = result.then(() => ({
        schemaVersion: 1,
        confirmed: true,
        checkedAtUtc: new Date().toISOString(),
        detail: null,
      }));
      return {
        events,
        result,
        stopped,
        async cancel() {
          if (cancelRequested) return { accepted: true, reason: 'already_requested' };
          cancelRequested = true;
          try {
            await session.abort();
            return { accepted: true, reason: null };
          } catch {
            return { accepted: false, reason: 'cancel_failed' };
          }
        },
      };
    },
  };
  return { descriptor, capabilities: PI_RUNTIME_CAPABILITIES, adapter };
}
