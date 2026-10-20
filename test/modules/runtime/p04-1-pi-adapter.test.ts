import { describe, expect, it, vi } from 'vitest';
import * as piSdk from '@earendil-works/pi-coding-agent';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import {
  isRuntimeError,
} from '../../../packages/core/src/ports/runtime-execution.ts';

import {
  PI_RUNTIME_CAPABILITIES,
  PI_RUNTIME_ID,
  PI_SDK_LICENSE,
  PI_SDK_VERSION,
  assertPiStartupCompatible,
  createPiRuntimeAdapter,
  createPiRuntimeDescriptor,
} from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { PiSession, PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { ExecutionInputRef } from '../../../packages/core/src/ports/execution-input.ts';
import {
  createStaticRuntimeCapabilityCatalog,
  createStaticRuntimeRegistry,
  RUNTIME_ADAPTER_CONTRACT_VERSION,
} from '../../../packages/core/src/index.ts';

const digest = 'a'.repeat(64);

function inputRef(purpose: string): ExecutionInputRef {
  return {
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'file', root: 'workspace', relativePath: `${purpose}.txt` },
  };
}

function request(overrides: Partial<RuntimeExecutionRequest> = {}): RuntimeExecutionRequest {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    featureId: 'feature-1',
    sessionId: 'session-1',
    executionVersion: 1,
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1',
    strategy: { runtime: PI_RUNTIME_ID, provider: 'anthropic', model: 'claude-sonnet' },
    prompt: inputRef('prompt'),
    inputManifest: inputRef('manifest'),
    cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.read'], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 100_000 },
    recovery: { mode: 'new' },
    ...overrides,
  };
}

function descriptor() {
  return createPiRuntimeDescriptor({
    providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
    permissionGrants: ['fs.read'],
    isolationModes: ['trusted_project'],
  });
}

function assembly(): PiTrustedAssembly {
  return {
    agentDir: 'trusted-agent-dir',
    resolveWorkingDirectory: () => '/trusted/workspace',
    inputReader: { read: async () => 'run this controlled prompt' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
    credentialRef: { kind: 'trusted-resolution', id: 'credential-ref-1' },
  };
}

class FakePiSession implements PiSession {
  readonly sessionId = `provider-session-${Math.random().toString(36).slice(2)}`;
  readonly sessionFile = `/managed/session/${this.sessionId}.jsonl`;
  private listener: ((event: unknown) => void) | undefined;
  private aborted = false;
  private readonly holdForCancel: boolean;
  private readonly promptFailure: Error | undefined;
  private releasePrompt: (() => void) | undefined;
  private disposed = false;
  constructor(holdForCancel = false, promptFailure?: Error) {
    this.holdForCancel = holdForCancel;
    this.promptFailure = promptFailure;
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  async prompt(): Promise<void> {
    if (this.promptFailure !== undefined) throw this.promptFailure;
    if (this.holdForCancel) {
      await new Promise<void>((resolve) => { this.releasePrompt = resolve; });
      return;
    }
    this.listener?.({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' });
    this.listener?.({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false });
    this.listener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from Pi' }],
        usage: { input: 10, output: 5, cost: { total: 0.00001 } },
        stopReason: 'stop',
      },
    });
  }
  async waitForIdle(): Promise<void> { this.listener?.({ type: 'agent_settled' }); }
  async abort(): Promise<void> {
    this.aborted = true;
    this.listener?.({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
    this.releasePrompt?.();
  }
  dispose(): void { this.disposed = true; }
  wasAborted(): boolean { return this.aborted; }
  wasDisposed(): boolean { return this.disposed; }
}

class ScriptedPiSession implements PiSession {
  readonly sessionId = 'provider-session-scripted';
  readonly sessionFile = '/managed/session/scripted.jsonl';
  private listener: ((event: unknown) => void) | undefined;
  constructor(private readonly script: readonly unknown[], private readonly settle = true) {}
  subscribe(listener: (event: unknown) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  async prompt(): Promise<void> { for (const event of this.script) this.listener?.(event); }
  async waitForIdle(): Promise<void> {
    if (this.settle) this.listener?.({ type: 'agent_settled' });
  }
  async abort(): Promise<void> { this.listener?.({ type: 'agent_settled' }); }
  dispose(): void {}
}

describe('P04-1 standard Pi SDK contract', () => {
  it('[case:pi-sdk-actual-contract] locks the installed SDK version, license, import and lifecycle API', () => {
    expect(PI_SDK_VERSION).toBe('1.0.4');
    expect(PI_SDK_LICENSE).toBe('MIT');
    expect(typeof piSdk.createAgentSession).toBe('function');
    expect(typeof piSdk.AgentSession.prototype.subscribe).toBe('function');
    expect(typeof piSdk.AgentSession.prototype.prompt).toBe('function');
    expect(typeof piSdk.AgentSession.prototype.abort).toBe('function');
  });

  it('[case:pi-descriptor-registry] reports the actual SDK version through the existing registry and catalog', () => {
    const piDescriptor = descriptor();
    const catalog = createStaticRuntimeCapabilityCatalog([
      { runtimeId: PI_RUNTIME_ID, providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
    ]);
    const adapter = { start: async () => { throw new Error('test adapter'); } };
    const registry = createStaticRuntimeRegistry(
      [{ descriptor: piDescriptor, adapter }],
      catalog,
    );
    expect(registry.resolve(PI_RUNTIME_ID)?.descriptor.sdkVersion).toBe('1.0.4');
    expect(registry.resolve(PI_RUNTIME_ID)?.descriptor.contractVersion).toBe(RUNTIME_ADAPTER_CONTRACT_VERSION);
  });

  it('[case:pi-capability-states] keeps event, usage, cancel/stopped and recovery capabilities independent', () => {
    expect(PI_RUNTIME_CAPABILITIES).toEqual({
      events: 'supported', usage: 'supported', cancel: 'supported', stopped: 'supported',
      conversationResume: 'unsupported', executionRecovery: 'unsupported',
    });
  });

  it('[case:pi-startup-preflight] refuses unknown provider/model, permission and recovery before SDK creation', () => {
    const piDescriptor = descriptor();
    expect(() => assertPiStartupCompatible(request({ strategy: { runtime: 'pi', provider: 'ghost', model: 'm' } }), piDescriptor))
      .toThrowError(expect.objectContaining({ kind: 'configuration', reason: 'unknown_provider' }));
    expect(() => assertPiStartupCompatible(request({ strategy: { runtime: 'pi', provider: 'anthropic', model: 'unknown' } }), piDescriptor))
      .toThrowError(expect.objectContaining({ kind: 'configuration', reason: 'unsupported_model' }));
    expect(() => assertPiStartupCompatible(request({ permissions: { grants: [], isolation: 'trusted_project' } }), piDescriptor))
      .toThrowError(expect.objectContaining({ kind: 'permission', reason: 'required_permission_not_granted' }));
    expect(() => assertPiStartupCompatible(request({ recovery: { mode: 'auto', kind: 'conversation' } as RuntimeExecutionRequest['recovery'] }), piDescriptor))
      .toThrowError(expect.objectContaining({ kind: 'configuration', reason: 'execution_recovery_unsupported' }));
  });

  it('[case:pi-runtime-event-usage] converts verified SDK events and reported usage to the Core handle', async () => {
    const session = new FakePiSession();
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => session,
    });
    const handle = await registration.adapter.start(request());
    const result = await handle.result;
    const events: unknown[] = [];
    for await (const event of handle.events) events.push(event);
    expect(result).toMatchObject({ terminal: 'completed', usage: { basis: 'reported', inputTokens: 10, outputTokens: 5 } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_started' }),
      expect.objectContaining({ kind: 'tool_finished' }),
      expect.objectContaining({ kind: 'usage' }),
      expect.objectContaining({ kind: 'message' }),
    ]));
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
  });

  it('[case:pi-event-normalization] coalesces message updates, deduplicates tool and usage facts, and retains unknown diagnostics', async () => {
    const message = (content: string, usage = true) => ({
      id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: content }],
      ...(usage ? { usage: { input: 11, output: 7, cost: { total: 0.00002 } } } : {}), stopReason: 'stop',
    });
    const session = new ScriptedPiSession([
      { type: 'message_start', message: message('hello') },
      { type: 'message_update', message: message('hel') },
      { type: 'message_update', message: message('hello') },
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' },
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read' },
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false },
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false },
      { type: 'message_end', message: message('hello') },
      { type: 'future_sdk_event', privatePayload: 'must not cross the boundary' },
    ]);
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => session,
    });
    const handle = await registration.adapter.start(request());
    const events: RuntimeEvent[] = [];
    for await (const event of handle.events) events.push(event as RuntimeEvent);
    const result = await handle.result as RuntimeExecutionResult;
    expect(events.filter(event => event.kind === 'message')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'usage')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'tool_started')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'tool_finished')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'diagnostic')).toHaveLength(1);
    expect(events.find(event => event.kind === 'message')?.payload).toMatchObject({ messageId: 'assistant-1', preview: 'hello' });
    expect(result).toMatchObject({
      terminal: 'completed', providerSessionId: 'provider-session-scripted', lastEventSequence: events.length,
      diagnosticRefs: [expect.any(String)], usage: { inputTokens: 11, outputTokens: 7, completeness: 'unknown', accounting: 'unknown' },
      exitCode: null, signal: null,
    });
    expect(new Set(events.map(event => event.eventId)).size).toBe(events.length);
  });

  it('[case:pi-terminal-and-null-semantics] waits for agent settled and keeps unavailable usage fields null', async () => {
    const session = new ScriptedPiSession([
      { type: 'message_end', message: { id: 'assistant-2', role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } },
    ]);
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => session,
    });
    const handle = await registration.adapter.start(request({ invocationId: 'invocation-2', executionVersion: 2 }));
    await expect(handle.result).resolves.toMatchObject({
      terminal: 'completed', usage: null, providerSessionId: 'provider-session-scripted',
      exitCode: null, signal: null,
    });
  });

  it('[case:pi-managed-session-scope] binds both immutable inputs, creates a distinct native scope per attempt, and returns native identity', async () => {
    const reads: string[] = [];
    const sessionOptions: Array<{ sessionDir: string; provider: string; model: string }> = [];
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
      assembly: {
        ...assembly(),
        inputReader: { read: async ref => { reads.push(ref.purpose); return `bound-${ref.purpose}`; } },
      },
      sessionFactory: async options => {
        sessionOptions.push(options);
        return new FakePiSession();
      },
    });

    const first = await registration.adapter.start(request());
    await first.result;
    const second = await registration.adapter.start(request({
      attemptId: 'attempt-2',
      invocationId: 'invocation-2',
      sessionId: 'session-2',
    }));
    await second.result;

    expect(reads).toEqual(['prompt', 'manifest', 'prompt', 'manifest']);
    expect(sessionOptions[0]?.sessionDir).toBeTruthy();
    expect(sessionOptions[0]?.sessionDir).not.toBe(sessionOptions[1]?.sessionDir);
    expect(sessionOptions.map(item => [item.provider, item.model])).toEqual([
      ['anthropic', 'claude-sonnet'], ['anthropic', 'claude-sonnet'],
    ]);
    expect(first.nativeSession).toMatchObject({
      providerSessionId: expect.stringMatching(/^provider-session-/),
      sessionFile: expect.stringContaining('/managed/session/'),
    });
    expect(first.nativeSession?.providerSessionId).not.toBe(request().identity.attemptId);
  });

  it('[case:pi-credential-preflight] rejects a missing trusted credential reference before SDK initialization', async () => {
    const sessionFactory = vi.fn(async () => new FakePiSession());
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
      assembly: { ...assembly(), credentialRef: undefined }, sessionFactory,
    });

    await expect(registration.adapter.start(request())).rejects.toMatchObject({
      kind: 'authentication', reason: 'credential_reference_missing',
    });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('[case:pi-failure-classification] preserves context/model diagnostics and disposes a failed SDK session', async () => {
    const session = new FakePiSession(false, new Error('context window exceeded'));
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => session,
    });

    const handle = await registration.adapter.start(request());
    await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', reason: 'context_error' });
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    expect(session.wasDisposed()).toBe(true);
  });

  it('[case:pi-sdk-init-failure] exposes SDK initialization failure as configuration', async () => {
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => { throw new Error('SDK bootstrap failed'); },
    });

    await expect(registration.adapter.start(request())).rejects.toMatchObject({
      kind: 'configuration', reason: 'sdk_initialization_failed',
    });
  });
  it('[case:pi-cancel-stopped] exposes cancel acceptance separately from confirmed stopped evidence', async () => {
    const session = new FakePiSession(true);
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
      permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], assembly: assembly(),
      sessionFactory: async () => session,
    });
    const handle = await registration.adapter.start(request());
    await expect(handle.cancel()).resolves.toEqual({ accepted: true, reason: null });
    await expect(handle.result).resolves.toMatchObject({ terminal: 'cancelled', reason: 'cancelled' });
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    expect(session.wasAborted()).toBe(true);
  });

  it('[case:pi-boundary] keeps the Core import independent from the Pi SDK and accepts only trusted assembly inputs', async () => {
    const core = await import('../../../packages/core/src/index.ts');
    expect(typeof core.createStaticRuntimeRegistry).toBe('function');
    expect(assembly().credentialRef).toEqual({ kind: 'trusted-resolution', id: 'credential-ref-1' });
    expect(isRuntimeError(new Error('ordinary error'))).toBe(false);
  });
});
