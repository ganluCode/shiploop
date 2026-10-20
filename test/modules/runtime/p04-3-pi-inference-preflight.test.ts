import { expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { createPiInferencePreflightAdapter } from '../../../packages/host/src/runtime/pi-inference-preflight.ts';
import { createRuntimeInferencePreflight } from '../../../packages/core/src/application/runtime-inference-preflight.ts';
import { createPiWorkRuntimeFactory } from '../../../packages/host/src/runtime/pi-work-runtime.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import type { RuntimeInferenceProbeRequest } from '../../../packages/core/src/ports/runtime-inference-preflight.ts';

// Any attempt to load an agent/resource loader in a transport probe fails this test.
vi.mock('@earendil-works/pi-coding-agent', () => { throw new Error('Agent SDK forbidden in probe'); });
const strategy = { runtime: 'pi', provider: 'provider', model: 'model' };
const selection = { strategy, authenticationRef: 'auth:selected', environmentDigest: 'a'.repeat(64), resourceDigest: 'b'.repeat(64) };
const model = { id: 'model', provider: 'provider', api: 'openai-responses' } as Model<Api>;
const message = (stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text: 'OK' }], provider: 'provider', model: 'model', api: 'openai-responses',
  stopReason, timestamp: Date.now(), usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
});
const request = (): RuntimeInferenceProbeRequest => ({ ...selection, prompt: 'Reply with OK.', maxOutputTokens: 32, maxRetries: 0,
  observeUsage: vi.fn(), signal: new AbortController().signal });

it('[case:pi-minimal-transport] passes only the selected model and fixed prompt with zero tools/retries', async () => {
  const stream = vi.fn(() => {
    const events = createAssistantMessageEventStream(), m = message();
    events.push({ type: 'start', partial: m });
    events.push({ type: 'done', reason: 'stop', message: m });
    return events;
  });
  const resolve = vi.fn(async () => ({ model, stream }));
  const adapter = createPiInferencePreflightAdapter([{ selection, isolation: 'inference_only', resolve }]);
  const result = await adapter.probe(request());
  expect(result).toMatchObject({ terminal: 'completed', response: 'OK', usage: { inputTokens: 3, outputTokens: 1, costUsdMicros: 3000 } });
  const [selected, context, options] = stream.mock.calls[0] as unknown as [unknown, { messages: unknown[] }, unknown];
  expect(selected).toBe(model);
  expect(JSON.stringify(context)).toContain('Reply with OK.');
  expect(JSON.stringify(context)).not.toMatch(/cwd|Skill|memory|MCP|project|read_file|bash/);
  expect(context.messages).toHaveLength(1);
  expect(options).toMatchObject({ maxRetries: 0, maxTokens: 32 });
  expect(resolve).toHaveBeenCalledTimes(1);
});

it.each(['blank', 'length', 'toolUse', 'error', 'delta-only', 'no-start', 'model-drift'] as const)(
  '[case:pi-terminal-%s] refuses incomplete, invalid or empty responses', async mode => {
    const stream = () => {
      const events = createAssistantMessageEventStream(), m = message();
      if (mode !== 'no-start') events.push({ type: 'start', partial: m });
      if (mode === 'delta-only') {
        events.push({ type: 'text_delta', contentIndex: 0, delta: 'OK', partial: m }); events.end();
      } else if (mode === 'error') {
        m.stopReason = 'error'; m.errorMessage = 'HTTP 200 sk-DO-NOT-PERSIST';
        events.push({ type: 'error', reason: 'error', error: m });
      } else {
        if (mode === 'blank') m.content = [{ type: 'text', text: '  ' }];
        if (mode === 'model-drift') m.model = 'other-model';
        if (mode === 'length' || mode === 'toolUse') m.stopReason = mode;
        if (mode === 'toolUse') m.content = [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }];
        events.push({ type: 'done', reason: mode === 'length' || mode === 'toolUse' ? mode : 'stop', message: m });
      }
      return events;
    };
    const adapter = createPiInferencePreflightAdapter([{ selection, isolation: 'inference_only', resolve: async () => ({ model, stream }) }]);
    const records: unknown[] = [];
    const service = createRuntimeInferencePreflight({ policy: { enabled: true }, adapter,
      authorize: async () => true, audit: async record => { records.push(record); } });
    expect((await service.check(selection)).dispatchAllowed).toBe(false);
    expect(JSON.stringify(records)).not.toContain('sk-DO-NOT-PERSIST');
  },
);

it('[case:pi-exact-auth-binding] cannot use another auth source, endpoint or model behind a selected key', async () => {
  const resolve = vi.fn(async () => ({ model, stream: vi.fn() }));
  const adapter = createPiInferencePreflightAdapter([{ selection, isolation: 'inference_only', resolve }]);
  expect(await adapter.probe({ ...request(), authenticationRef: 'auth:other' })).toMatchObject({ terminal: 'failed', category: 'configuration' });
  expect(await adapter.probe({ ...request(), strategy: { ...strategy, endpointRef: 'endpoint:other' } })).toMatchObject({ terminal: 'failed' });
  expect(resolve).not.toHaveBeenCalled();
  const wrong = createPiInferencePreflightAdapter([{ selection, isolation: 'inference_only',
    resolve: async () => ({ model: { ...model, id: 'other' }, stream: vi.fn() }) }]);
  expect(await wrong.probe(request())).toMatchObject({ terminal: 'failed', category: 'configuration' });
});

it.each(['disabled', 'failed', 'passed'] as const)(
  '[case:core-before-claim-%s] audits admission before Task claim, work preparation or budget use', async mode => {
    const binding = await openBindingFixture({ strategy });
    const start = vi.fn(async () => { throw new Error('Test Runner intentionally unavailable'); });
    const seen = vi.fn(async () => true);
    const probe = vi.fn(async () => {
      // Admission is earlier than claim and all business input/worktree operations.
      expect(binding.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
      expect(binding.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
      return { terminal: mode === 'passed' ? 'completed' as const : 'failed' as const,
        response: 'OK', usage: { inputTokens: 3, outputTokens: 1, costUsdMicros: 3000 } };
    });
    const catalog = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'provider', models: ['model'] }],
      contractVersion: 1, permissionGrants: [], isolationModes: ['trusted_project'] }]);
    const factory = createPiWorkRuntimeFactory({ providers: [{ providerId: 'provider', models: ['model'] }],
      permissionGrants: [], isolationModes: ['trusted_project'], process: { start }, argv: ['trusted-runner'], cwd: '/trusted', environment: {},
      inferencePreflight: { policy: mode === 'disabled' ? undefined : { enabled: true },
        adapter: { isolation: 'inference_only', probe }, authorize: seen, select: ({ strategy }) => ({ ...selection, strategy }) } });
    let core: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
    const defaults = binding.query('SELECT execution_config FROM tasks WHERE id = ?', 't-1');
    try {
      core = await openCoreApplication({ dataRoot: binding.box.dataRoot, capabilityCatalog: catalog, workRuntimeFactory: factory });
      const prepare = vi.spyOn(core.workspacePreparation, 'prepare');
      const inputs = vi.spyOn(core.executionInputPrepare, 'prepareExecutionInput').mockImplementation(async () => {
        expect(binding.query("SELECT count(*) AS n FROM artifacts WHERE kind = 'inference_preflight' AND status = 'ready'"))
          .toEqual({ n: mode === 'disabled' ? 0 : 2 });
        throw new StorageError('conflict', 'test.beforeClaim', 'Stop at workspace admission boundary', {
          details: { reason: 'test_stop_before_claim' },
        });
      });
      await core.workExecution.scan();
      if (mode === 'failed') {
        expect(binding.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
        expect(binding.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
        expect(prepare).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
        expect(binding.query('SELECT reason FROM runs')).toEqual({ reason: 'inference_preflight_invalid_terminal' });
      } else {
        expect(inputs).toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
        expect(binding.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
        expect(binding.query('SELECT reason FROM runs')).toEqual({ reason: 'test_stop_before_claim' });
      }
      expect(probe).toHaveBeenCalledTimes(mode === 'disabled' ? 0 : 1);
      expect(seen).toHaveBeenCalledTimes(mode === 'disabled' ? 0 : mode === 'passed' ? 2 : 1);
      expect(binding.query("SELECT count(*) AS n FROM artifacts WHERE kind = 'inference_preflight' AND status = 'ready'"))
        .toEqual({ n: mode === 'disabled' ? 0 : 2 });
      expect(binding.query('SELECT execution_config FROM tasks WHERE id = ?', 't-1')).toEqual(defaults);
      if (mode === 'failed') {
        const rows = binding.session.database.prepare("SELECT id FROM artifacts WHERE kind = 'inference_preflight' AND status = 'ready'").all() as { id: string }[];
        const audits = await Promise.all(rows.map(async row => {
          const artifact = await core!.artifactStore.getArtifact(binding.projectId, row.id);
          const content = await core!.artifactFileStore.openFinalRead({ projectId: binding.projectId, artifactId: artifact.id });
          const chunks: Buffer[] = [];
          for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
          return JSON.parse(Buffer.concat(chunks).toString());
        }));
        expect(audits).toContainEqual(expect.objectContaining({ outcome: 'failed', accounting: 'inference_preflight',
          selection: expect.objectContaining({ strategy }), usage: { inputTokens: 3, outputTokens: 1, costUsdMicros: 3000 } }));
        expect(JSON.stringify(audits)).not.toMatch(/attemptId|worktreeId/);
      }
    } finally {
      if (core) { await core.workExecution.close(); core.close(); }
      binding.close();
    }
  }, 25_000,
);
