import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createPiSdkSessionFactory, type PiSession, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';

it.each(['normal', 'is_error', 'invalid_arguments'] as const)('[case:sdk-approved-tools-%s] real SDK Work session calls selected MCP, submission and built-in tools without model/network calls', async mode => {
  const server = { callMode: mode === 'is_error' ? 'is_error' as const : 'normal' as const, discoveryFile: '' };
  const f = await mcpWorkFixture({ server });
  server.discoveryFile = 'tools.json';
  writeFileSync(join(f.box.path, server.discoveryFile), JSON.stringify([
    { name: 'echo', inputSchema: mode === 'invalid_arguments'
      ? { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } : { type: 'object', properties: {} } },
    { name: 'forbidden', inputSchema: { type: 'object', properties: {} } },
  ]));
  let session: PiSession | undefined;
  try {
    // A configured global/project MCP must stay inert without loading the built-in MCP extension.
    mkdirSync(join(f.box.path, '.pi'));
    const poisoned = JSON.stringify({ mcpServers: { forbidden: { command: '/bin/sh', args: ['-c', `touch '${join(f.box.path, 'unselected-started')}'`] } } });
    writeFileSync(join(f.box.path, 'mcp.json'), poisoned);
    writeFileSync(join(f.box.path, '.pi/mcp.json'), poisoned);
    let submitted = 0, turns = 0, mcpName = '';
    const assembly: PiTrustedAssembly = { ...f.assembly, resolveBuiltInTools: () => ['read'],
      resolveSubmissionTools: () => [{ name: 'submit_candidate', label: 'Submit', description: 'Restricted submission', parameters: { type: 'object' },
        execute: async () => { submitted++; return { content: [{ type: 'text', text: 'submitted' }] }; } }] };
    await f.runtime.setRuntimeApiKey('anthropic', 'offline-synthetic-key');
    f.runtime.streamSimple = model => {
      const first = ++turns === 1;
      const message: AssistantMessage = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
        content: first ? [{ type: 'toolCall', id: 'sdk-call', name: mcpName, arguments: {} },
          { type: 'toolCall', id: 'submit-call', name: 'submit_candidate', arguments: {} },
          { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: join(f.box.path, 'mcp.json') } }]
          : [{ type: 'text', text: 'done' }],
        stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }); stream.end(); });
      return stream;
    };
    const factory = createPiSdkSessionFactory(assembly);
    const handle = await f.adapter(async options => {
      session = await factory(options);
      const real = session as AgentSession;
      const names = real.getActiveToolNames();
      mcpName = names.find(name => name.startsWith('mcp_'))!;
      expect(names.sort()).toEqual(['read', 'submit_candidate', mcpName].sort());
      expect(real.resourceLoader.getExtensions().extensions).toEqual([]);
      return session;
    }, assembly).start(f.request);
    expect(await handle.result).toMatchObject({ terminal: 'completed' });
    expect(turns).toBe(2);
    const native = readFileSync(session!.sessionFile!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(native.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === 'sdk-call')?.message.isError)
      .toBe(mode !== 'normal');
    expect(submitted).toBe(1);
    expect(f.actualManifests).toHaveLength(1);
    expect(f.actualManifests[0]).toMatchObject({ state: 'loaded', resources: [{ id: f.resourceId, status: 'available', loadedCapabilities: ['mcp_stdio'] }] });
    if (mode === 'invalid_arguments') expect(existsSync(join(f.box.path, 'call.entered'))).toBe(false);
    else expect(JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')).count).toBe(1);
    expect(f.registry.list(f.registrations[0]!)).toEqual([]);
    expect(existsSync(join(f.box.path, 'exit.json'))).toBe(true);
    expect(existsSync(join(f.box.path, 'unselected-started'))).toBe(false);
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect(events.filter(event => (event as { kind: string }).kind === 'tool_started'
      && JSON.stringify(event).includes('sdk-call'))).toHaveLength(1);
    expect(events.filter(event => (event as { kind: string }).kind === 'tool_finished'
      && JSON.stringify(event).includes('sdk-call'))).toHaveLength(1);
    // SDK idle and MCP group stop do not certify the Runner/other tools have stopped.
    expect(await handle.stopped).toMatchObject({ confirmed: false });
  } finally { session?.dispose(); await f.cleanup(); }
}, 20_000);
