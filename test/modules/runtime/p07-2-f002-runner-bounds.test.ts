import { afterEach, expect, it, vi } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessPort, CommandProcessResult } from '../../../packages/core/src/ports/command-process.ts';
import type { RuntimeEvent, RuntimeExecutionRequest, RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createPiRunnerAdapter } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import {
  PI_RUNNER_BUFFER_BYTES,
  PI_RUNNER_BUFFER_EVENTS,
  PI_RUNNER_MAX_MESSAGE_BYTES,
  PiRunnerDecoder,
  PiRunnerEventChannel,
  encodePiRunnerMessage,
  piRunnerMessage,
} from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

function request(): RuntimeExecutionRequest {
  const ref = (purpose: string) => ({
    projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'artifact' as const },
  });
  return {
    schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1',
    executionVersion: 1, owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    invocationId: 'invocation-1', strategy: { runtime: 'pi', provider: 'provider', model: 'model' },
    prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: ['fs.read'], isolation: 'trusted_project' },
    limits: { timeoutMs: 2_000, maxEvents: 1_000, maxOutputBytes: 200_000 }, recovery: { mode: 'new' },
  };
}

const stop = { schemaVersion: 1 as const, confirmed: true, checkedAtUtc: '2026-10-29T00:00:00.000Z', detail: null };
function event(sequence: number): RuntimeEvent {
  return { schemaVersion: 1, eventId: `event-${sequence}`, kind: 'diagnostic', sequence,
    occurredAtUtc: '2026-10-29T00:00:00.000Z', payload: { kind: 'diagnostic', code: 'queued', message: `event-${sequence}` } };
}
function result(lastEventSequence: number): RuntimeExecutionResult {
  return { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
    durationMs: 1, usage: null, lastEventSequence };
}
function output(messages: readonly unknown[]): Uint8Array {
  return Buffer.from(messages.map(message => `${JSON.stringify(message)}\n`).join(''));
}
function processFixture(chunks: readonly Uint8Array[]) {
  const cancel = vi.fn(async () => ({ accepted: true }));
  const processHandle: CommandProcessHandle = {
    identity: { launchId: 'launch-1', pid: 123, processGroupId: 123, startTime: 'os-start' },
    output: { async *[Symbol.asyncIterator]() { for (const bytes of chunks) yield { stream: 'stdout' as const, bytes }; } },
    result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: true },
    } satisfies CommandProcessResult),
    stopped: Promise.resolve({ confirmed: true }), cancel,
    query: () => { throw new Error('not used'); },
  };
  const start = vi.fn<CommandProcessPort['start']>().mockResolvedValue(processHandle);
  const adapter = createPiRunnerAdapter({ process: { start }, argv: ['runner'], cwd: '/trusted', environment: {},
    confirm: async identity => ({ launchId: identity.launchId }) });
  return { adapter, cancel };
}

it('[case:f002-channel-rejects-oversize-direct-event] applies the byte bound before waking a waiting recorder', async () => {
  let abandoned = 0;
  const channel = new PiRunnerEventChannel(() => { abandoned += 1; });
  const iterator = channel[Symbol.asyncIterator]();
  const waiting = iterator.next();
  const large = { ...event(1), payload: { kind: 'diagnostic' as const, code: 'large', message: 'x'.repeat(PI_RUNNER_BUFFER_BYTES) } };
  expect(channel.push(large)).toBe(false);
  expect(channel.snapshot()).toEqual({ events: 0, bytes: 0 });
  channel.close();
  await expect(waiting).resolves.toMatchObject({ done: true });
  expect(abandoned).toBe(0);
});

it('[case:f002-overflow-drains-control-and-preserves-prefix] keeps the accepted queue prefix while decoding one cancel receipt', async () => {
  const req = request();
  const messages = [
    ...Array.from({ length: PI_RUNNER_BUFFER_EVENTS + 1 }, (_, index) =>
      piRunnerMessage(req, index + 1, { kind: 'event', body: event(index + 1) })),
    piRunnerMessage(req, PI_RUNNER_BUFFER_EVENTS + 2, { kind: 'cancel_receipt', body: { accepted: true, reason: null } }),
    piRunnerMessage(req, PI_RUNNER_BUFFER_EVENTS + 3, { kind: 'result', body: result(PI_RUNNER_BUFFER_EVENTS + 1) }),
    piRunnerMessage(req, PI_RUNNER_BUFFER_EVENTS + 4, { kind: 'stopped', body: stop }),
  ];
  const fixture = processFixture([output(messages)]);
  const handle = await fixture.adapter.start(req);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', reason: 'runner_buffer_overflow', lastEventSequence: PI_RUNNER_BUFFER_EVENTS });
  const accepted: RuntimeEvent[] = [];
  for await (const item of handle.events) accepted.push(item as RuntimeEvent);
  expect(accepted.map(item => item.sequence)).toEqual(Array.from({ length: PI_RUNNER_BUFFER_EVENTS }, (_, index) => index + 1));
  expect(handle.inspect()).toMatchObject({ bufferedEvents: 0, cancelReceipt: { accepted: true }, lastEventSequence: PI_RUNNER_BUFFER_EVENTS });
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
});

it('[case:f002-protocol-frame-bounds] rejects an oversized encoded message and a newline-free frame before JSON admission', () => {
  const req = request();
  const oversized = { ...event(1), payload: { kind: 'diagnostic' as const, code: 'large', message: 'x'.repeat(PI_RUNNER_MAX_MESSAGE_BYTES) } };
  expect(() => encodePiRunnerMessage(piRunnerMessage(req, 1, { kind: 'event', body: oversized })))
    .toThrowError(expect.objectContaining({ reason: 'runner_message_overflow' }));
  const decoder = new PiRunnerDecoder();
  expect(() => Array.from(decoder.push(new Uint8Array(PI_RUNNER_MAX_MESSAGE_BYTES)))).toThrowError(
    expect.objectContaining({ reason: 'runner_message_overflow' }),
  );
});

it('[case:f002-runner-write-timeout] bounds a blocked protocol sink and issues one cancellation', async () => {
  const cancel = vi.fn(async () => ({ accepted: true, reason: null }));
  const runner = createPiWorkRunner({
    adapter: { start: async () => ({ events: { async *[Symbol.asyncIterator]() { yield event(1); } },
      result: Promise.resolve(result(1)), stopped: Promise.resolve(stop), cancel }) },
    write: async () => new Promise<void>(() => {}),
  });
  await expect(runner.start(request())).rejects.toMatchObject({ reason: 'runner_write_timeout' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('[case:f002-cumulative-runner-output-bound] rejects cumulative protocol output before publishing an over-limit frame', async () => {
  const cancel = vi.fn(async () => ({ accepted: true, reason: null }));
  const writes: Uint8Array[] = [];
  const runner = createPiWorkRunner({
    adapter: { start: async () => ({ events: { async *[Symbol.asyncIterator]() { yield event(1); } },
      result: Promise.resolve(result(1)), stopped: Promise.resolve(stop), cancel }) },
    write: async bytes => { writes.push(bytes); },
  });
  await expect(runner.start({ ...request(), limits: { ...request().limits, maxOutputBytes: 1 } }))
    .rejects.toMatchObject({ reason: 'runner_output_overflow' });
  expect(writes).toHaveLength(0);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('[case:f002-sdk-channel-bound] bounds SDK events before Runner/Recorder consumption and preserves the accepted watermark', async () => {
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    subscribe(callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
    async prompt() {
      for (let index = 1; index <= PI_RUNNER_BUFFER_EVENTS + 1; index += 1) {
        listener?.({ type: 'message_end', message: { id: `sdk-${index}`, role: 'assistant', content: [{ text: `event-${index}` }] } });
      }
    },
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const adapter = createPiRuntimeAdapter({
    providers: [{ providerId: 'provider', models: ['model'] }],
    permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
    sessionFactory: async () => session,
    assembly: { agentDir: '/managed', resolveWorkingDirectory: () => '/trusted',
      credentialRef: { kind: 'trusted-resolution', id: 'credential-1' }, inputReader: { read: async () => 'controlled' },
      resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']> },
  }).adapter;
  const handle = await adapter.start(request());
  await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', reason: 'event_queue_backpressure', lastEventSequence: PI_RUNNER_BUFFER_EVENTS });
  const accepted: RuntimeEvent[] = [];
  for await (const item of handle.events) accepted.push(item as RuntimeEvent);
  expect(accepted).toHaveLength(PI_RUNNER_BUFFER_EVENTS);
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(session.dispose).toHaveBeenCalledTimes(1);
});

it('[case:f002-supervised-output-drains-with-fixed-buffer] bounds a real child pipe while the consumer is paused', async () => {
  const box = createTempSandbox('shiploop-f002-');
  resources.push(() => box.cleanup());
  const handle = await createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 500 }).start({
    argv: [process.execPath, '-e', "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"],
    cwd: box.path, environment: {}, timeoutMs: 250, maxInputBytes: 65_536, maxOutputBytes: 200_000,
  }, async identity => ({ launchId: identity.launchId }));
  const result = await handle.result;
  expect(handle.query().bufferedOutputBytes).toBeLessThanOrEqual(65_536);
  expect(result.droppedOutputBytes).toBeGreaterThan(0);
  expect(result.reason).toBe('timed_out');
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: true });
});
