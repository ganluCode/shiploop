import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as sdk from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createMcpToolCatalog } from '../../../packages/host/src/runtime/mcp-tool-catalog.ts';
import { createMcpRuntimeAudit } from '../../../packages/host/src/runtime/mcp-runtime-audit.ts';
import type { McpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

it.each(['result', 'exception'] as const)('[case:native-secret-%s] real pinned SDK persists sanitized MCP tool declarations and results without a model request', async mode => {
  const box = createTempSandbox('shiploop-mcp-native-audit-');
  let session: sdk.AgentSession | undefined;
  const secret = 'synthetic-private-mcp-native-credential';
  try {
    const mapping = { resourceId: 'server-1', sourceRef: 'source-1', originalName: 'echo', piName: 'mcp_echo' };
    const server = { resourceId: 'server-1', sourceRef: 'source-1', sourceRevision: 'r1', version: null, contentDigest: null,
      environmentRefs: ['env-ref'], credentialRef: 'credential-ref', executable: '/usr/bin/true', argv: [], cwd: box.path,
      environment: { MCP_KEY: secret }, allowedTools: ['echo'], approvalDigest: 'approval', tools: [mapping] };
    const plan: McpStartupPlan = { schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', attemptId: 'attempt-1',
      invocationId: 'invocation-1', executionVersion: 1, resourceSnapshotDigest: 'snapshot', digest: 'plan', servers: [server], tools: [mapping], gaps: [] };
    const events: unknown[] = [];
    const audit = createMcpRuntimeAudit({ plan, publish: payload => { events.push(payload); }, requestStop: () => {} });
    const catalog = await createMcpToolCatalog({ plan, audit, endpoints: [{ server,
      discover: async () => [{ name: 'echo', description: `Untrusted description ${secret}`, inputSchema: { type: 'object', properties: {} } }],
      call: async () => {
        if (mode === 'exception') throw new Error(`third-party diagnostic ${secret}`);
        return { content: [{ type: 'text', text: secret }], structuredContent: { credential: secret } };
      } }] });
    const runtime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    await runtime.setRuntimeApiKey('anthropic', 'offline-synthetic-key');
    const model = runtime.getModel('anthropic', 'claude-sonnet-4-5')!;
    let requests = 0;
    runtime.streamSimple = actual => {
      const first = ++requests === 1;
      const message: AssistantMessage = { role: 'assistant', provider: actual.provider, model: actual.id, api: actual.api,
        content: first ? [{ type: 'toolCall', id: 'native-mcp-call', name: 'mcp_echo', arguments: {} }] : [{ type: 'text', text: 'done' }],
        stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(); });
      return stream;
    };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: box.path, agentDir: box.path, settingsManager,
      noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'offline MCP audit' });
    await resourceLoader.reload();
    const nativeDirectory = join(box.path, 'native');
    mkdirSync(nativeDirectory);
    const created = await sdk.createAgentSession({ cwd: box.path, agentDir: box.path, model, modelRuntime: runtime,
      resourceLoader, settingsManager, thinkingLevel: 'off', sessionManager: sdk.SessionManager.create(box.path, nativeDirectory),
      tools: ['mcp_echo'], customTools: catalog.tools as unknown as NonNullable<sdk.CreateAgentSessionOptions['customTools']> });
    session = created.session;
    await session.prompt('Call the approved local tool once.');
    await session.waitForIdle();
    expect(requests).toBe(2);
    const native = readFileSync(session.sessionFile!, 'utf8');
    expect(native).not.toContain(secret);
    expect(native).toContain('mcp_echo');
    const entries = native.trim().split('\n').map(line => JSON.parse(line) as { message?: { role: string; isError?: boolean } });
    const results = entries.filter(entry => entry.message?.role === 'toolResult');
    expect(results).toHaveLength(1);
    expect(results[0]!.message!.isError).toBe(mode === 'exception');
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(secret);
  } finally { session?.dispose(); box.cleanup(); }
}, 20_000);
