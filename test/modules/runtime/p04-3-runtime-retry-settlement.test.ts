import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createPiRuntimeAdapter, createPiSdkSessionFactory, piRuntimeEventPrefix, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { piRunnerMessage } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import type { RuntimeEvent, RuntimeExecutionRequest } from '../../../packages/core/src/index.ts';
import { createExecutionService, createRuntimeExecutionService, createRuntimeSettlementService, createWorkEvidenceRecorder,
  createStaticRuntimeCapabilityCatalog, createStaticRuntimeRegistry } from '../../../packages/core/src/index.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openBindingFixture, BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';

const strategy = { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' };
const policy = { maxRetries: 2, maxTotalRetries: 2, baseBackoffMs: 0, maxBackoffMs: 0 };
const message = (error?: string): AssistantMessage => ({ role: 'assistant', api: 'anthropic-messages',
  provider: strategy.provider, model: strategy.model, content: error ? [] : [{ type: 'text', text: 'complete response' }],
  stopReason: error ? 'error' : 'stop', errorMessage: error, timestamp: Date.now(),
  usage: { input: 3, output: error ? 0 : 2, cacheRead: 0, cacheWrite: 0, totalTokens: error ? 3 : 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

type Script = (round: number) => AssistantMessageEvent[];
async function fixture(script: Script, fault?: 'recording' | 'events') {
  const f = await openBindingFixture({ strategy });
  try {
    const agentDir = join(f.box.root, 'pi-agent');
    const loader = new DefaultResourceLoader({ cwd: f.box.repoDirA, agentDir, settingsManager: SettingsManager.inMemory(),
      noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: '', appendSystemPrompt: [] });
    await loader.reload();
    const assembly: PiTrustedAssembly = { agentDir, resourceLoader: loader,
      resolveWorkingDirectory: () => f.box.repoDirA,
      resolveModel: () => getModel('anthropic', 'claude-sonnet-4-5'),
      inputReader: { async read(ref) { return Buffer.from((await f.verifier.readVerifiedContent(ref.projectId, ref.artifactId)).content).toString('utf8'); } },
      credentialRef: { kind: 'trusted-resolution', id: 'controlled-test-reference' } };
    let calls = 0, factories = 0;
    let sdk: AgentSession | undefined;
    const createSession = createPiSdkSessionFactory(assembly);
    const pi = createPiRuntimeAdapter({ providers: [{ providerId: strategy.provider, models: [strategy.model] }],
      permissionGrants: [], isolationModes: ['trusted_project'], assembly,
      requestRetryPolicy: policy,
      sessionFactory: async options => {
        factories++;
        sdk = await createSession(options) as AgentSession;
        await sdk.modelRuntime.setRuntimeApiKey(strategy.provider, 'controlled-test-key');
        sdk.agent.streamFunction = (_model, _context, streamOptions) => {
          expect(streamOptions?.maxRetries).toBe(0);
          const out = createAssistantMessageEventStream();
          for (const event of script(++calls)) out.push(event);
          return out;
        };
        return sdk;
      } });
    const configuration = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: pi.descriptor.providers }]);
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
    const attempts = createSqliteAttemptAccess(f.session), dag = createSqliteTaskDagStore(f.session);
    const settlement = createRuntimeSettlementService({ publisher: f.publisher, attempts, dag,
      lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }) });
    const service = createExecutionService({ atomic: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => BINDING_NOW }),
      resources: f.createResources(), sessions, inputBinding: f.bindingService, attempts, dag, settlement,
      runtime: createRuntimeExecutionService({ configuration, registry: createStaticRuntimeRegistry([{ descriptor: pi.descriptor,
        adapter: { async start(request: RuntimeExecutionRequest) {
          const handle = await pi.adapter.start(request);
          // Use the production Runner wire conversion before Core's raw-event validator.
          return { ...handle, events: { async *[Symbol.asyncIterator]() {
            for await (const raw of handle.events) {
              const event = raw as RuntimeEvent;
              const wire = piRunnerMessage(request, event.sequence, { kind: 'event', body: event });
              if (wire.kind === 'event') yield wire.body;
              if (fault === 'events' && event.kind === 'usage') throw new Error('controlled_events_failure');
            }
          } } };
        } } }], configuration) }),
      recorder: createWorkEvidenceRecorder({ publisher: fault === 'recording' ? { async publishArtifact() { throw new Error('controlled_recording_failure'); } } : f.publisher,
        verifier: f.verifier, sessions, limits: { ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 50 } }),
      eventIdentityPrefix: piRuntimeEventPrefix, nowUtcMs: () => BINDING_NOW });
    const claim = f.claimTask('t-1');
    return { ...f, sessions, service, settlement, claim, sdk: () => sdk, calls: () => calls, factories: () => factories,
      start: () => service.start(f.bindingInput(claim)),
      async content(id: string) { return Buffer.from((await f.verifier.readVerifiedContent(f.projectId, id)).content).toString('utf8'); },
      async json(id: string) { return JSON.parse(Buffer.from((await f.verifier.readVerifiedContent(f.projectId, id)).content).toString('utf8')); } };
  } catch (error) { f.close(); throw error; }
}

describe('F-003 real Pi Session, recording and fenced settlement', () => {
  it('[case:F003-RECORDED-RETRY] retains request rounds/usage/watermark in one Attempt and settles exactly once', async () => {
    const f = await fixture(round => {
      const failed = message('503 service_unavailable');
      if (round < 3) return [{ type: 'start', partial: failed }, { type: 'error', reason: 'error', error: failed }];
      const success = message();
      return [{ type: 'start', partial: success }, { type: 'done', reason: 'stop', message: success }];
    });
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(result, JSON.stringify({ result, recording, calls: f.calls() })).toMatchObject({ status: 'fulfilled', value: { terminal: 'completed' } });
      expect(recording.status).toBe('fulfilled');
      expect(f.calls()).toBe(3);
      expect(f.factories()).toBe(1);
      expect(f.sdk()?.autoRetryEnabled).toBe(false);
      expect(f.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 1, attempts_created: 1 });
      expect(f.query('SELECT COUNT(*) AS count FROM attempts')).toEqual({ count: 1 });
      expect(f.query('SELECT COUNT(*) AS count FROM sessions')).toEqual({ count: 1 });
      if (recording.status !== 'fulfilled') throw recording.reason;
      const manifest = await f.json(recording.value.manifestArtifactId);
      // Pi exposes per-message usage without a trusted incremental/cumulative scope.
      // Preserve all observations, but keep totals unknown instead of inventing a retry delta.
      expect(manifest.usage.observations).toMatchObject({ counted: 3, totals: { inputTokens: null, outputTokens: null, costUsdMicros: null, complete: false } });
      const chunks = await Promise.all(manifest.chunks.map(async (chunk: { artifactId: string }) =>
        (await f.content(chunk.artifactId)).trim().split('\n').map(line => JSON.parse(line))));
      const events = chunks.flat();
      expect(events.filter(event => event.payload?.code === 'pi.retry.failure')).toHaveLength(2);
      expect(events.filter(event => event.payload?.code === 'pi.retry.request')).toHaveLength(3);
      expect(events.filter(event => event.payload?.code === 'pi.retry.success')).toHaveLength(1);
      const input = { request: started.context.request, result, recording, stopped };
      const first = await f.settlement.settle(input);
      expect(first).toMatchObject({ disposition: 'applied', stopConfirmed: false });
      const before = f.query('SELECT COUNT(*) AS count FROM state_events');
      expect(await f.settlement.settle(input)).toMatchObject({ disposition: 'replayed' });
      expect(f.query('SELECT COUNT(*) AS count FROM state_events')).toEqual(before);
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
      expect(f.query('SELECT COUNT(*) AS count FROM workspace_leases')).toEqual({ count: 3 });
      expect(manifest.result.lastEventSequence).toBeGreaterThan(0);
    } finally { await f.service.close(); f.close(); }
  });

  it('[case:F003-PARTIAL-SETTLEMENT] preserves HTTP success followed by a broken response as failure with partial usage', async () => {
    const f = await fixture(() => {
      const partial = { ...message('ECONNRESET'), content: [{ type: 'text' as const, text: 'partial response' }] };
      return [{ type: 'start', partial }, { type: 'text_delta', contentIndex: 0, delta: 'partial response', partial },
        { type: 'error', reason: 'error', error: partial }];
    });
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(f.calls(), JSON.stringify({ result, recording })).toBe(1);
      expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: 'failed', reason: 'connection_interrupted' } });
      if (recording.status !== 'fulfilled') throw recording.reason;
      const manifest = await f.json(recording.value.manifestArtifactId);
      expect(manifest.usage.observations.counted).toBe(1);
      const receipt = await f.settlement.settle({ request: started.context.request, result, recording, stopped });
      expect(receipt.stopConfirmed).toBe(false);
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!;
      expect(await f.json(session.resultRef!)).toMatchObject({ execution: {
        failure: { kind: 'provider' }, classification: { category: 'transient_connection' } },
        recording: { watermark: manifest.watermark }, stop: { evidence: { confirmed: false } } });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'failed' });
      expect(f.session.database.prepare('SELECT state FROM workspace_leases').all())
        .toEqual(Array(3).fill({ state: 'quarantined' }));
    } finally { await f.service.close(); f.close(); }
  });

  it.each([
    { id: 'F003-AUTH-SETTLEMENT', category: 'authentication', error: '401 unauthorized', kind: 'authentication', calls: 1 },
    { id: 'F003-QUOTA-SETTLEMENT', category: 'quota_blocked', error: '429 insufficient_quota', kind: 'rate_limited', calls: 1 },
    { id: 'F003-EXHAUSTED-SETTLEMENT', category: 'transient_server', error: '503 service_unavailable', kind: 'provider', calls: 3 },
    { id: 'F003-TIMEOUT-SETTLEMENT', category: 'timeout', error: 'deadline_exceeded', kind: 'timeout', calls: 1 },
    { id: 'F003-CANCEL-SETTLEMENT', category: 'cancelled', error: 'runtime_cancelled', kind: 'process', calls: 1 },
    { id: 'F003-UNKNOWN-SETTLEMENT', category: 'unknown', error: 'unrecognized SDK terminal error', kind: 'process', calls: 1 },
  ])('[case:$id] preserves $category after bounded request execution', async ({ category, error, kind, calls }) => {
    const f = await fixture(() => [{ type: 'error', reason: category === 'cancelled' ? 'aborted' : 'error',
      error: { ...message(error), ...(category === 'cancelled' ? { stopReason: 'aborted' as const } : {}) } }]);
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(f.calls()).toBe(calls);
      expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: category === 'timeout' ? 'timed_out' : category === 'cancelled' ? 'cancelled' : 'failed' } });
      const input = { request: started.context.request, result, recording, stopped };
      const receipt = await f.settlement.settle(input);
      expect(receipt).toMatchObject({ disposition: 'applied', stopConfirmed: false, runtimeCompleted: false });
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!;
      expect(await f.json(session.resultRef!)).toMatchObject({ execution: { failure: { kind }, classification: { category } } });
      expect(await f.settlement.settle(input)).toMatchObject({ disposition: 'replayed' });
      expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
      expect(f.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
    } finally { await f.service.close(); f.close(); }
  });

  it.each([
    { id: 'F003-PUBLISH-FAILURE', fault: 'recording' as const },
    { id: 'F003-EVENT-FAILURE', fault: 'events' as const },
  ])('[case:$id] keeps $fault failure independent from the successful model result', async ({ fault }) => {
    const f = await fixture(round => round === 1
      ? [{ type: 'error', reason: 'error', error: message('503 service_unavailable') }]
      : [{ type: 'done', reason: 'stop', message: message() }], fault);
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(recording.status).toBe('rejected');
      const receipt = await f.settlement.settle({ request: started.context.request, result, recording, stopped });
      expect(receipt).toMatchObject({ disposition: 'applied', stopConfirmed: false, resultSaved: true });
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!;
      const evidence = await f.json(session.resultRef!);
      expect(evidence.recording).toMatchObject({ complete: false, failure: fault === 'events' ? 'event_stream_failed' : 'event_publish_failed' });
      if (fault === 'events') {
        expect(evidence.execution).toMatchObject({ failure: { kind: 'protocol', reason: 'runtime_events_failed' }, classification: { category: 'protocol' } });
        const manifest = await f.json(evidence.recording.manifestRef);
        expect(manifest.coverage).toBe('failed');
        expect(manifest.watermark).toBeGreaterThan(0);
        expect(manifest.chunks.length).toBeGreaterThan(0);
        expect(manifest.usage.observations.counted).toBeGreaterThan(0);
      }
      expect(f.query('SELECT COUNT(*) AS count FROM workspace_leases')).toEqual({ count: 3 });
    } finally { await f.service.close(); f.close(); }
  });

  it.each([
    { id: 'F003-SDK-UNKNOWN-ERROR', kind: 'error' },
    { id: 'F003-SDK-UNKNOWN-DONE', kind: 'done' },
  ])('[case:$id] rejects an unrecognized SDK $kind terminal instead of completing the Attempt', async ({ kind }) => {
    const f = await fixture(() => {
      const unknown = { ...message('unrecognized SDK terminal'), stopReason: 'future_sdk_terminal' } as unknown as AssistantMessage;
      return [kind === 'error' ? { type: 'error', reason: 'error', error: unknown }
        : { type: 'done', reason: 'future_sdk_terminal', message: unknown } as unknown as AssistantMessageEvent];
    });
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(f.calls()).toBe(1);
      expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: 'failed' } });
      const receipt = await f.settlement.settle({ request: started.context.request, result, recording, stopped });
      expect(receipt.runtimeCompleted).toBe(false);
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!;
      expect(await f.json(session.resultRef!)).toMatchObject({ execution: { classification: { category: 'unknown' } } });
    } finally { await f.service.close(); f.close(); }
  });

  it('[case:F003-MISSING-USAGE] retains unknown usage when transport setup fails before any SDK response', async () => {
    const f = await fixture(() => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); });
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      expect(f.calls()).toBe(3);
      expect(result).toMatchObject({ status: 'fulfilled', value: { terminal: 'failed', usage: null } });
      if (recording.status !== 'fulfilled') throw recording.reason;
      const manifest = await f.json(recording.value.manifestArtifactId);
      expect(manifest.usage.observations.counted).toBe(0);
      await f.settlement.settle({ request: started.context.request, result, recording, stopped });
      expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    } finally { await f.service.close(); f.close(); }
  });

  it('[case:F003-LATE-RESULT] fences a late completed result after request retries without advancing the Session or releasing occupancy', async () => {
    const f = await fixture(round => round === 1
      ? [{ type: 'error', reason: 'error', error: message('503 service_unavailable') }]
      : [{ type: 'done', reason: 'stop', message: message() }]);
    try {
      const started = await f.start();
      const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      const before = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id);
      f.session.database.prepare('UPDATE tasks SET execution_version = execution_version + 1').run();
      const receipt = await f.settlement.settle({ request: started.context.request, result, recording, stopped });
      expect(receipt).toMatchObject({ disposition: 'ignored', resultSaved: false });
      expect(f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)).toEqual(before);
      expect(f.query('SELECT COUNT(*) AS count FROM attempt_notification_diagnostics')).toEqual({ count: 1 });
      expect(f.query('SELECT COUNT(*) AS count FROM workspace_leases')).toEqual({ count: 3 });
    } finally { await f.service.close(); f.close(); }
  });
});
