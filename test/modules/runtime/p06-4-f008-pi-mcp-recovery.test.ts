import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ExecutionInputRef, RuntimeExecutionRequest, RuntimeRecoveryReference } from '../../../packages/core/src/index.ts';
import { createPiRuntimeAdapter, createPiSdkSessionFactory, PI_RUNTIME_RECOVERY_CAPABILITIES, PI_SDK_VERSION,
  PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION, type PiRecoveryWriterLease } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { validatePiNativeArchive } from '../../../packages/host/src/runtime/pi-native-session.ts';
import type { McpResourceResolutionInput } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it.each([
  ['unknown-system-state', { privileged: true }],
  ['invalid-sections', { sections: { prompt: { execute: 'untrusted' } } }],
  ['executable-declaration', { toolsAdded: [{ name: 'old_tool', description: 'history', parameters: {}, execute: 'untrusted' }] }],
  ['invalid-schema', { toolsAdded: [{ name: 'old_tool', description: 'history', parameters: null }] }],
] as const)('[case:recovery-system-reject-%s] refuses unverified system state instead of treating it as executable authority', (_name, patch) => {
  const archive = Buffer.from([
    { type: 'session', id: 'old-native', version: 3, cwd: '/tmp', timestamp: '2026-10-28T00:00:00Z' },
    { type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-10-28T00:00:00Z',
      message: { role: 'system', content: '', timestamp: 1, ...patch } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  expect(() => validatePiNativeArchive({ archive, reference: { providerSessionId: 'old-native', sourceDigest: hash(archive) },
    assertCurrent: async () => {} })).toThrow();
});

it('[case:sdk-attempt-recovery] real SDK forks history but re-resolves MCP authorization, clients and call identities for each Attempt', async () => {
  const first = await mcpWorkFixture(), second = await mcpWorkFixture(), third = await mcpWorkFixture({ selected: false });
  const fixtures = [first, second, third];
  let previous: { request: RuntimeExecutionRequest; session: AgentSession; archive: Buffer } | undefined;
  const nativeIds: string[] = [];
  try {
    for (const [ordinal, f] of fixtures.entries()) {
      const index = ordinal + 1;
      const request: RuntimeExecutionRequest = { ...f.request, sessionId: `session-${index}`, invocationId: `invocation-${index}`,
        identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: `attempt-${index}` },
        workAccess: { ...f.snapshot, invocationId: `invocation-${index}`, attemptId: `attempt-${index}` } };
      let source: RuntimeRecoveryReference | undefined;
      let lease: PiRecoveryWriterLease | undefined;
      if (previous) {
        const old = previous;
        const stop = Buffer.from(JSON.stringify({ confirmed: true, nativeWriterDisposed: true,
          mcpProcesses: fixtures[ordinal - 1]!.registry.list(fixtures[ordinal - 1]!.registrations[0]!) }));
        const artifact = (id: string, bytes: Buffer, mediaType: string): ExecutionInputRef => ({ projectId: request.projectId,
          artifactId: id, kind: 'execution-input', purpose: 'recovery', version: 1, contentHash: hash(bytes), sizeBytes: bytes.length,
          locator: `sessions/${id}`, mediaType, origin: { kind: 'artifact' } });
        const archive = artifact('native-archive', old.archive, 'application/x-ndjson');
        const stopRef = artifact('stop-proof', stop, 'application/json');
        source = { schemaVersion: 1, purpose: 'work', kind: 'conversation', sourceProjectId: request.projectId,
          sourceSessionId: old.request.sessionId, sourceTaskId: 'task-1', sourceAttemptId: `attempt-${index - 1}`,
          runtime: 'pi', provider: request.strategy.provider, model: request.strategy.model, providerSessionId: old.session.sessionId,
          nativeArchiveRef: archive.artifactId, sourceDigest: archive.contentHash,
          nativeFormat: PI_NATIVE_SESSION_FORMAT, nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION };
        lease = { source: { reference: source, archive, sdkVersion: PI_SDK_VERSION, previousWriter: { status: 'confirmed', stopEvidence: stopRef } },
          sourceReadOnly: true, authority: { projectId: request.projectId, featureId: request.featureId, taskId: 'task-1', taskStatus: 'unfinished',
            previousAttemptId: `attempt-${index - 1}`, previousSessionId: old.request.sessionId },
          writer: { purpose: 'work', attemptId: `attempt-${index}`, invocationId: request.invocationId,
            sessionId: request.sessionId, executionVersion: request.executionVersion, owner: request.owner, exclusive: true },
          assertCurrent: async () => {}, release: async () => {},
          readVerifiedArtifact: async ref => ref.artifactId === archive.artifactId ? old.archive : stop };
      }
      let resolved = 0, turn = 0, currentTool: string | undefined, session: AgentSession | undefined;
      let factoryFailure: unknown;
      const assembly = { ...f.assembly, mcp: { ...f.assembly.mcp!, resolver: { resolve: (input: McpResourceResolutionInput) => {
        resolved++; return f.assembly.mcp!.resolver.resolve(input);
      } } }, recoverySourceManager: lease ? { acquire: async () => lease! } : undefined };
      await f.runtime.setRuntimeApiKey('anthropic', 'offline-synthetic-key');
      f.runtime.streamSimple = model => {
        const call = ++turn === 1 && currentTool !== undefined;
        const message: AssistantMessage = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
          content: call ? [{ type: 'toolCall', id: 'same-call-id', name: currentTool!, arguments: {} }] : [{ type: 'text', text: 'done' }],
          stopReason: call ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      };
      const factory = createPiSdkSessionFactory(assembly);
      const registration = createPiRuntimeAdapter({ assembly, providers: [{ providerId: 'anthropic', models: ['claude-sonnet-4-5'] }],
        permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
        recoveryCapabilities: { ...PI_RUNTIME_RECOVERY_CAPABILITIES, capabilities: { ...PI_RUNTIME_RECOVERY_CAPABILITIES.capabilities,
          conversationResume: { status: 'verified', evidenceRef: 'offline-sdk-fixture', limits: ['test only'] },
          nativeFork: { status: 'verified', evidenceRef: 'offline-sdk-fixture', limits: ['test only'] } } },
        sessionFactory: async options => {
          try {
            currentTool = options.customTools?.[0]?.name;
            session = await factory(options) as AgentSession;
            expect(session.getActiveToolNames()).toEqual(currentTool ? [currentTool] : []);
            if (previous) expect(session.messages.some(message => message.role === 'toolResult')).toBe(true);
            return session;
          } catch (error) { factoryFailure = error; throw error; }
        } });
      const handle = await registration.adapter.start({ ...request, recovery: source ? { mode: 'required', kind: 'conversation', source } : { mode: 'new' } })
        .catch(error => { throw factoryFailure ?? error; });
      expect(await handle.result).toMatchObject({ terminal: 'completed' });
      nativeIds.push(session!.sessionId);
      if (ordinal < 2) {
        expect(resolved).toBe(1);
        expect(JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8')).count).toBe(1);
        expect(f.registrations).toHaveLength(1);
        expect(f.registry.list(f.registrations[0]!)).toEqual([]);
        const events: unknown[] = [];
        for await (const event of handle.events) events.push(event);
        expect(JSON.stringify(events)).toContain('same-call-id');
      } else {
        expect(resolved).toBe(0);
        expect(f.registrations).toEqual([]);
        expect(existsSync(join(f.box.path, 'call.entered'))).toBe(false);
      }
      previous = { request, session: session!, archive: readFileSync(session!.sessionFile!) };
    }
    expect(new Set(nativeIds).size).toBe(3);
    expect(first.registrations[0]!.processIdentity.launchId).not.toBe(second.registrations[0]!.processIdentity.launchId);
  } finally { for (const f of fixtures.reverse()) await f.cleanup(); }
}, 25_000);
