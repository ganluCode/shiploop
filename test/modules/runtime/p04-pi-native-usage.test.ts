import { expect, it } from 'vitest';
import * as sdk from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { RuntimeExecutionRequest, RuntimeEvent, RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';

it('pinned native SDK assistant messages have per-request usage, not unknown session totals', async () => {
  const runtime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey('anthropic', 'synthetic-key');
  const model = runtime.getModel('anthropic', 'claude-sonnet-4-5')!;
  let calls = 0;
  runtime.streamSimple = actual => {
    const ordinal = ++calls;
    const message: AssistantMessage = { role: 'assistant', provider: actual.provider, model: actual.id, api: actual.api,
      content: ordinal === 1 ? [{ type: 'toolCall', id: 'call-1', name: 'noop', arguments: {} }] : [{ type: 'text', text: 'done' }],
      stopReason: ordinal === 1 ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: ordinal === 1 ? 100 : 80, output: ordinal === 1 ? 10 : 20, cacheRead: ordinal === 1 ? 50 : 30,
        cacheWrite: 0, totalTokens: ordinal === 1 ? 160 : 130,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(); });
    return stream;
  };
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager,
    noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'offline test' });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd: process.cwd(), model, modelRuntime: runtime, resourceLoader,
    settingsManager, thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(), tools: ['noop'],
    customTools: [{ name: 'noop', label: 'noop', description: 'No side effects', parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; } }] });
  const ref = (purpose: string) => ({ projectId: 'project', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: `input/${purpose}`, mediaType: 'text/plain', origin: { kind: 'artifact' as const } });
  const request: RuntimeExecutionRequest = { schemaVersion: 1, projectId: 'project', featureId: 'feature', sessionId: 'session', invocationId: 'invocation',
    executionVersion: 1, owner: { principalId: 'owner', hostInstanceId: 'host' }, identity: { purpose: 'work', runId: 'run', taskId: 'task', attemptId: 'attempt' },
    strategy: { runtime: 'pi', provider: model.provider, model: model.id }, prompt: ref('prompt'), inputManifest: ref('manifest'),
    cwd: { root: 'workspace', relativePath: '.' }, permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 10000, maxEvents: 100, maxOutputBytes: 100000 }, recovery: { mode: 'new' } };
  const registration = createPiRuntimeAdapter({ providers: [{ providerId: model.provider, models: [model.id] }],
    permissionGrants: [], isolationModes: ['trusted_project'],
    assembly: { agentDir: '/unused-memory-only', resolveWorkingDirectory: () => process.cwd(), resourceLoader,
      inputReader: { read: async () => 'Do the offline noop once.' }, credentialRef: { kind: 'trusted-resolution', id: 'offline-key' } },
    sessionFactory: async () => session });
  const handle = await registration.adapter.start(request);
  const events: RuntimeEvent[] = [];
  for await (const event of handle.events) events.push(event as RuntimeEvent);
  expect((await handle.result as RuntimeExecutionResult).terminal).toBe('completed');
  expect(calls).toBe(2);
  const usage = events.filter(event => event.kind === 'usage').map(event => event.payload as { usage: unknown });
  expect(usage).toHaveLength(2);
  expect(usage.map(row => row.usage)).toMatchObject([
    { accounting: 'incremental', completeness: 'partial', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, providerTotalTokens: 160 },
    { accounting: 'incremental', completeness: 'partial', inputTokens: 80, outputTokens: 20, cacheReadTokens: 30, providerTotalTokens: 130 },
  ]);
}, 20000);
