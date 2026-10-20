import { afterEach, expect, it, vi } from 'vitest';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { fixture as coreFixture } from '../../helpers/p03-6/stopping-fixture.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createPiRunnerAdapter } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import { createPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import { piRunnerMessage } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import type { CommandProcessHandle, CommandProcessResult } from '../../../packages/core/src/ports/command-process.ts';
import type { PiRunnerAdapterOptions } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import type { WorkResourceSnapshot } from '../../../packages/core/src/ports/work-resources.ts';
import type { RuntimeExecutionResult, RuntimeStopEvidence } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { PiSession } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';

function request(): RuntimeExecutionRequest {
  const ref = (purpose: string) => ({ projectId: 'project-1', artifactId: `artifact-${purpose}`,
    kind: 'execution-input', purpose, version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10,
    locator: `execution-inputs/${purpose}`, mediaType: 'text/plain', origin: { kind: 'artifact' as const } });
  return { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 1, owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
    prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.read'], isolation: 'trusted_project' },
    limits: { timeoutMs: 1_000, maxEvents: 100, maxOutputBytes: 100_000 }, recovery: { mode: 'new' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function sdkFixture() {
  const prompt = deferred<void>(), ready = deferred<void>();
  let listener: ((event: unknown) => void) | undefined;
  const abort = vi.fn(async () => {}), dispose = vi.fn(), unsubscribe = vi.fn(() => { listener = undefined; });
  const session: PiSession = { subscribe: callback => { listener = callback; ready.resolve(); return unsubscribe; },
    prompt: () => prompt.promise, abort, dispose,
    waitForIdle: async () => { listener?.({ type: 'agent_settled' }); } };
  const adapter = createPiRuntimeAdapter({ providers: [{ providerId: 'provider', models: ['model'] }],
    permissionGrants: ['fs.read'], isolationModes: ['trusted_project'], sessionFactory: async () => session,
    assembly: { agentDir: '/managed', resolveWorkingDirectory: () => '/trusted',
      credentialRef: { kind: 'trusted-resolution', id: 'credential-1' },
      inputReader: { read: async () => 'controlled' }, resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']> } }).adapter;
  return { adapter, abort, dispose, unsubscribe, prompt, ready, session, emit: (event: unknown) => listener?.(event) };
}
afterEach(() => { vi.useRealTimers(); });

it('[case:sdk-abort-is-not-stop] SDK accepting abort cannot prove a hung execution or tool has stopped', async () => {
  vi.useFakeTimers();
  const f = sdkFixture(), handle = await f.adapter.start(request());
  const receipts = await Promise.all([handle.cancel(), handle.cancel()]);
  expect(receipts).toEqual([{ accepted: true, reason: null }, { accepted: true, reason: null }]);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'cancelled' });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(f.dispose).toHaveBeenCalledTimes(1);
});

const stopped: RuntimeStopEvidence = { schemaVersion: 1, confirmed: false, checkedAtUtc: '2026-10-20T00:00:00.000Z', detail: 'pi_sdk_idle' };
const terminal: RuntimeExecutionResult = { schemaVersion: 1, terminal: 'completed', reason: null,
  exitCode: null, signal: null, durationMs: 12, usage: null, lastEventSequence: null };
function runnerFixture(messages: unknown[], outcome: Partial<CommandProcessResult> = {}, resourceStop?: PiRunnerAdapterOptions['resourceStop'],
  overrides: Partial<CommandProcessHandle> = {}) {
  const cancel = vi.fn(async () => ({ accepted: true }));
  const processHandle: CommandProcessHandle = {
    identity: { launchId: '11111111-1111-4111-8111-111111111111', pid: 123, processGroupId: 123, startTime: 'os-start' },
    output: { async *[Symbol.asyncIterator]() { yield { stream: 'stdout' as const, bytes: Buffer.from(messages.map(value => JSON.stringify(value) + '\n').join('')) }; } },
    result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0,
      droppedOutputBytes: 0, stop: { confirmed: true }, ...outcome }),
    stopped: Promise.resolve({ confirmed: true }), cancel,
    query: () => { throw new Error('unused'); }, ...overrides,
  };
  const adapter = createPiRunnerAdapter({ process: { start: async () => processHandle }, argv: ['runner'],
    cwd: '/trusted', environment: {}, resourceStop, confirm: async identity => ({ launchId: identity.launchId }) });
  return { adapter, cancel, processHandle };
}

it('[case:runner-exit-is-not-resource-stop] Runner exit and SDK idle still require separate resource evidence', async () => {
  const req = request();
  const f = runnerFixture([piRunnerMessage(req, 1, { kind: 'result', body: terminal }),
    piRunnerMessage(req, 2, { kind: 'stopped', body: { ...stopped, confirmed: true } })]);
  const handle = await f.adapter.start(req);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'completed' });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'runner_resources_stop_unknown' });
});

it.each(['reject', 'hang'] as const)('[case:sdk-abort-fault-%s] abort remains finite and cannot turn a repeat into acceptance', async fault => {
  vi.useFakeTimers();
  const f = sdkFixture();
  f.abort.mockImplementation(() => fault === 'hang' ? new Promise(() => {}) : Promise.reject(new Error('private secret')));
  const handle = await f.adapter.start(request());
  const first = handle.cancel(), repeat = handle.cancel();
  await vi.advanceTimersByTimeAsync(2_000);
  const receipt = await first;
  expect(receipt).toEqual({ accepted: false, reason: fault === 'hang' ? 'sdk_abort_timeout' : 'sdk_abort_failed' });
  expect(await repeat).toEqual(receipt);
  expect(await handle.cancel()).toEqual(receipt);
  expect(f.abort).toHaveBeenCalledTimes(1);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'cancelled' });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'pi_sdk_stop_unknown' });
});

it('[case:sdk-timeout-partial] execution timeout retains partial text, reported usage and the final watermark', async () => {
  vi.useFakeTimers();
  const f = sdkFixture(), handle = await f.adapter.start(request());
  f.emit({ type: 'message_update', message: { id: 'partial-1', role: 'assistant', content: [{ text: 'partial response' }],
    usage: { input: 17, output: 3 } } });
  await vi.advanceTimersByTimeAsync(3_000);
  const result = await handle.result as RuntimeExecutionResult;
  expect(result).toMatchObject({ terminal: 'timed_out', reason: 'timed_out', usage: { inputTokens: 17, outputTokens: 3 } });
  const events: unknown[] = [];
  for await (const event of handle.events) events.push(event);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message', payload: expect.objectContaining({ preview: 'partial response' }) })]));
  expect(result.lastEventSequence).toBe(events.length);
  expect(f.abort).toHaveBeenCalledTimes(1);
  const saved = structuredClone(result);
  f.prompt.resolve();
  await Promise.resolve();
  expect(await handle.result).toEqual(saved);
  expect(f.dispose).toHaveBeenCalledTimes(1);
});

it('[case:sdk-complete-cancel-race] normal completion and late cancel dispose once and do not change the result', async () => {
  const f = sdkFixture(), handle = await f.adapter.start(request());
  f.prompt.resolve();
  await expect(handle.result).resolves.toMatchObject({ terminal: 'completed' });
  await expect(handle.cancel()).resolves.toEqual({ accepted: false, reason: 'already_settled' });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'pi_sdk_idle' });
  expect(f.abort).not.toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

it('[case:sdk-dispose-failure] cleanup failure cannot erase the result or claim idle stop evidence', async () => {
  const f = sdkFixture(), handle = await f.adapter.start(request());
  f.dispose.mockImplementation(() => { throw new Error('private cleanup error'); });
  f.prompt.resolve();
  await expect(handle.result).resolves.toMatchObject({ terminal: 'completed' });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'pi_sdk_stop_unknown' });
});

function resourceProof() {
  const req = request();
  if (req.identity.purpose !== 'work') throw new Error('work fixture expected');
  const snapshot: WorkResourceSnapshot = { identity: { projectId: req.projectId, attemptId: req.identity.attemptId,
    owner: req.owner.principalId, hostInstanceId: req.owner.hostInstanceId, executionVersion: req.executionVersion },
    invocationId: req.invocationId, processIdentity: { launchId: '11111111-1111-4111-8111-111111111111', pid: 123,
      processGroupId: 123, startTime: 'os-start' }, leases: [] };
  const token = Object.freeze({});
  const verify = vi.fn(async (_snapshot: WorkResourceSnapshot): Promise<object | null> => token);
  const inspect = vi.fn(() => structuredClone(snapshot));
  return { snapshot, verify, inspect, options: { snapshot: () => snapshot, verifier: { verify, inspect } } };
}

it('[case:runner-independent-stop-proof] confirms stop only with SDK idle, process exit and a bound resource token', async () => {
  const proof = resourceProof(), req = request();
  const f = runnerFixture([piRunnerMessage(req, 1, { kind: 'result', body: terminal }),
    piRunnerMessage(req, 2, { kind: 'stopped', body: stopped })], {}, proof.options);
  const handle = await f.adapter.start(req);
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: true, detail: null });
  expect(proof.verify).toHaveBeenCalledExactlyOnceWith(proof.snapshot);
  expect(handle.inspect()).toMatchObject({ resourceStop: 'confirmed', eventsEnded: true, processExited: true,
    terminalResult: terminal, cancelReceipt: null });
});

it.each(['attempt', 'invocation', 'version', 'owner', 'host', 'project', 'process'] as const)(
  '[case:runner-fenced-proof-%s] rejects mismatched resource evidence before verification', async field => {
    const proof = resourceProof();
    if (field === 'invocation') Object.assign(proof.snapshot, { invocationId: 'other' });
    else if (field === 'process') Object.assign(proof.snapshot.processIdentity!, { startTime: 'reused-pid' });
    else Object.assign(proof.snapshot.identity, { [{ attempt: 'attemptId', version: 'executionVersion', owner: 'owner',
      host: 'hostInstanceId', project: 'projectId' }[field]]: field === 'version' ? 2 : 'other' });
    const req = request(), f = runnerFixture([piRunnerMessage(req, 1, { kind: 'result', body: terminal }),
      piRunnerMessage(req, 2, { kind: 'stopped', body: stopped })], {}, proof.options);
    const handle = await f.adapter.start(req);
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
    expect(proof.verify).not.toHaveBeenCalled();
  });

it.each(['reject', 'hang', 'wrong-token'] as const)('[case:runner-resource-probe-fault-%s] resource proof stays unconfirmed', async fault => {
  vi.useFakeTimers();
  const proof = resourceProof();
  if (fault === 'reject') proof.verify.mockRejectedValue(new Error('probe failed'));
  if (fault === 'hang') proof.verify.mockImplementation(() => new Promise(() => {}));
  if (fault === 'wrong-token') proof.inspect.mockReturnValue({ ...proof.snapshot, invocationId: 'other' });
  const req = request(), f = runnerFixture([piRunnerMessage(req, 1, { kind: 'result', body: terminal }),
    piRunnerMessage(req, 2, { kind: 'stopped', body: stopped })], {}, proof.options);
  const handle = await f.adapter.start(req);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
  expect(handle.inspect().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
    code: fault === 'hang' ? 'runner_resources_stop_timeout' : 'runner_resources_stop_unconfirmed',
    kind: fault === 'hang' ? 'timeout' : 'unknown' })]));
});

it.each([
  { name: 'crash', outcome: { exitCode: 3 }, reason: 'runner_crashed', kind: 'process', status: 'failed' },
  { name: 'signal', outcome: { exitCode: null, signal: 'SIGKILL' }, reason: 'runner_crashed', kind: 'process', status: 'failed' },
  { name: 'disconnect', outcome: { exitCode: null, reason: 'supervisor_lost' as const }, reason: 'runner_disconnected', kind: 'process', status: 'failed' },
  { name: 'timeout', outcome: { exitCode: null, reason: 'timed_out' as const }, reason: 'runner_timed_out', kind: 'timeout', status: 'timed_out' },
  { name: 'cancel', outcome: { exitCode: null, reason: 'cancelled' as const }, reason: 'runner_cancelled', kind: 'process', status: 'cancelled' },
])('[case:runner-exit-diagnostics-$name] keeps partial result, usage, watermark and exit facts', async ({ outcome, reason, kind, status }) => {
  vi.useFakeTimers();
  const req = request(), usage = { basis: 'reported' as const, inputTokens: 17, outputTokens: null, costUsdMicros: null };
  const partial = { ...terminal, usage, providerSessionId: 'native-1', diagnosticRefs: ['diagnostic-1'] };
  const f = runnerFixture([piRunnerMessage(req, 1, { kind: 'result', body: partial })], outcome);
  const handle = await f.adapter.start(req);
  await expect(handle.result).resolves.toMatchObject({ terminal: status, reason, usage, providerSessionId: 'native-1',
    diagnosticRefs: ['diagnostic-1'], exitCode: outcome.exitCode, signal: 'signal' in outcome ? outcome.signal : null });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
  expect(handle.inspect().terminalResult).toEqual(partial);
  expect(handle.inspect().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: reason, kind })]));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.cancel).toHaveBeenCalledTimes(1);
});

it('[case:runner-control-abort-receipt] control cancellation forwards one SDK abort and publishes a distinct receipt before result', async () => {
  const f = sdkFixture(), controller = new AbortController(), output: Uint8Array[] = [];
  f.abort.mockImplementation(async () => { f.prompt.resolve(); });
  const runner = createPiWorkRunner({ adapter: f.adapter, signal: controller.signal, write: async bytes => { output.push(bytes); } });
  const completion = runner.start(request());
  await f.ready.promise;
  controller.abort();
  await completion;
  const messages = Buffer.concat(output).toString().trim().split('\n').map(line => JSON.parse(line));
  expect(messages.map(message => message.kind)).toEqual(['cancel_receipt', 'result', 'stopped']);
  expect(messages[0].body).toEqual({ accepted: true, reason: null });
  expect(messages[1].body.terminal).toBe('cancelled');
  expect(messages[2].body.confirmed).toBe(false);
  expect(messages.map(message => message.sequence)).toEqual([1, 2, 3]);
  expect(f.abort).toHaveBeenCalledTimes(1);
});

it('[case:runner-cancel-idempotent] distinguishes process acceptance from SDK rejection and caches the receipt', async () => {
  const req = request(), release = deferred<void>();
  const f = runnerFixture([], {}, undefined, { output: (async function* () {
    await release.promise;
    const messages = [piRunnerMessage(req, 1, { kind: 'cancel_receipt', body: { accepted: false, reason: 'sdk_abort_failed' } }),
      piRunnerMessage(req, 2, { kind: 'result', body: terminal }), piRunnerMessage(req, 3, { kind: 'stopped', body: stopped })];
    yield { stream: 'stdout' as const, bytes: Buffer.from(messages.map(message => JSON.stringify(message) + '\n').join('')) };
  })() });
  const handle = await f.adapter.start(req);
  const first = handle.cancel(), second = handle.cancel();
  release.resolve();
  await expect(first).resolves.toEqual({ accepted: false, reason: 'sdk_abort_failed' });
  expect(await second).toEqual(await first);
  await handle.result;
  expect(await handle.cancel()).toEqual(await first);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(handle.inspect()).toMatchObject({ processCancelAccepted: true, cancelReceipt: { accepted: false, reason: 'sdk_abort_failed' } });
});

it('[case:runner-cancel-receipt-timeout] missing SDK receipt stays unknown despite accepted process stop', async () => {
  vi.useFakeTimers();
  const release = deferred<void>(), req = request();
  const f = runnerFixture([], {}, undefined, { output: (async function* () { await release.promise; })() });
  const handle = await f.adapter.start(req);
  const first = handle.cancel(), second = handle.cancel();
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(first).resolves.toEqual({ accepted: false, reason: 'runner_cancel_receipt_unknown' });
  expect(await second).toEqual(await first);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(handle.inspect()).toMatchObject({ processCancelAccepted: true, cancelReceipt: null });
  release.resolve();
  await handle.result;
  await handle.stopped;
});

it.each(['channel', 'process-stop', 'sdk-stop'] as const)(
  '[case:runner-stop-timeout-%s] observation is bounded and cannot substitute for resource proof', async fault => {
    vi.useFakeTimers();
    const req = request(), proof = resourceProof(), release = deferred<void>();
    const messages = [piRunnerMessage(req, 1, { kind: 'result', body: terminal }),
      piRunnerMessage(req, 2, { kind: 'stopped', body: fault === 'sdk-stop' ? { ...stopped, detail: 'pi_sdk_stop_unknown' } : stopped })];
    const f = runnerFixture(messages, {}, proof.options, fault === 'process-stop' ? { stopped: new Promise(() => {}) }
      : fault === 'channel' ? { output: (async function* () { await release.promise; })() } : {});
    const handle = await f.adapter.start(req);
    await vi.advanceTimersByTimeAsync(17_000);
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
    expect(proof.verify).not.toHaveBeenCalled();
    if (fault === 'channel') await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', reason: 'runner_channel_timeout' });
    release.resolve();
    await handle.result;
  });

it('[case:runner-real-signal] real supervised Runner receives SIGTERM, aborts SDK and verifies its group', async () => {
  const port = createCommandProcessAdapter({ stopGraceMs: 3_000, stopConfirmMs: 2_000 });
  let processHandle: CommandProcessHandle | undefined, childError = '';
  const tokens = new WeakMap<object, WorkResourceSnapshot>();
  const req = { ...request(), limits: { ...request().limits, timeoutMs: 15_000 } };
  const adapter = createPiRunnerAdapter({ process: { start: async (input, confirm) => {
    processHandle = await port.start(input, confirm);
    const raw = processHandle;
    return { ...raw, output: (async function* () {
      for await (const chunk of raw.output) {
        if (chunk.stream === 'stderr') childError += Buffer.from(chunk.bytes).toString();
        yield chunk;
      }
    })() };
  } }, argv: [process.execPath, '--experimental-transform-types', '--import', fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url)),
    fileURLToPath(new URL('../../helpers/pi-stopping-runner-child.ts', import.meta.url))], cwd: process.cwd(),
    environment: {}, confirm: async identity => ({ launchId: identity.launchId }),
    resourceStop: { snapshot: request => {
      if (request.identity.purpose !== 'work' || !processHandle) throw new Error('work process expected');
      return { identity: { projectId: request.projectId, attemptId: request.identity.attemptId, owner: request.owner.principalId,
        hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion }, invocationId: request.invocationId,
        processIdentity: processHandle.identity, leases: [] };
    }, verifier: { async verify(snapshot) {
      const stop = await port.recoverStop!(snapshot.processIdentity!);
      if (!stop.confirmed) return null;
      const token = Object.freeze({}); tokens.set(token, snapshot); return token;
    }, inspect: token => {
      const snapshot = token !== null && typeof token === 'object' ? tokens.get(token) : undefined;
      if (!snapshot) throw new Error('unissued stop token');
      return snapshot;
    } } },
  });
  const handle = await adapter.start(req), ready = deferred<void>();
  const drain = (async () => { try {
    for await (const event of handle.events) if ((event as { kind: string }).kind === 'usage') ready.resolve();
  } finally { ready.resolve(); } })();
  const readyTimer = setTimeout(() => ready.resolve(), 8_000);
  try {
    await ready.promise;
    expect(handle.inspect().lastEventSequence, JSON.stringify({ snapshot: handle.inspect(), childError })).toBe(2);
    const first = handle.cancel(), repeat = handle.cancel();
    await expect(first).resolves.toEqual({ accepted: true, reason: null });
    expect(await repeat).toEqual(await first);
    await expect(handle.result).resolves.toMatchObject({ terminal: 'cancelled', usage: { inputTokens: 5, outputTokens: 2 }, lastEventSequence: 2 });
    await drain;
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
    expect(handle.inspect()).toMatchObject({ processCancelAccepted: true, cancelReceipt: { accepted: true, reason: null },
      processExited: true, eventsEnded: true, resourceStop: 'confirmed', terminalResult: { terminal: 'cancelled' } });
  } finally {
    clearTimeout(readyTimer);
    if (processHandle) { await processHandle.cancel(); expect((await port.recoverStop!(processHandle.identity)).confirmed).toBe(true); }
    await drain;
  }
}, 15_000);

it('[case:core-retains-unknown-pi-stop] Core quarantines Pi idle, persists once and refuses automatic rerun', async () => {
  const sdk = sdkFixture();
  sdk.abort.mockImplementation(async () => { sdk.prompt.resolve(); });
  const f = await coreFixture({}, {}, (_f, deps) => {
    const configuration = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]);
    const pi = createPiRuntimeAdapter({ providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      permissionGrants: [], isolationModes: ['trusted_project'], assembly: {
        agentDir: _f.workspace.canonicalPath, resolveWorkingDirectory: () => _f.workspace.canonicalPath,
        credentialRef: { kind: 'trusted-resolution', id: 'test-only' }, inputReader: { read: async () => 'bound' },
        resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
      }, sessionFactory: async () => sdk.session });
    Object.assign(deps, { runtime: createRuntimeExecutionService({ configuration, registry: createStaticRuntimeRegistry([
      { descriptor: { ...pi.descriptor, runtimeId: 'fake' }, adapter: pi.adapter },
    ], configuration) }) });
    Object.assign(deps.supervision!, { stopWaitMs: 100, drainWaitMs: 100 });
  });
  try {
    const { context } = await f.start();
    const first = f.service.cancel(f.identity), second = f.service.cancel(f.identity);
    expect(await first).toMatchObject({ persisted: true, stopConfirmed: false, retained: false });
    expect(await second).toEqual(await first);
    await context.completion;
    expect(sdk.abort).toHaveBeenCalledTimes(1);
    expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
    expect(f.resources.read(f.identity).leases.map(lease => lease.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    expect(f.retain).not.toHaveBeenCalled();
    await expect(f.start()).rejects.toThrow();
    expect(f.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: 1 });
  } finally { await f.dispose(); }
});



