import { expect, it, vi } from 'vitest';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import { createPiRunnerAdapter } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import { createPiWorkRunner, runPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import { piRunnerMessage, encodePiRunnerMessage, PI_RUNNER_MAX_MESSAGE_BYTES } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import type { RuntimeAdapter, RuntimeEvent, RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { CommandProcessHandle, CommandProcessResult } from '../../../packages/core/src/ports/command-process.ts';

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
    limits: { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 100_000 }, recovery: { mode: 'new' },
  };
}

it('[case:runner-validates-before-launch] rejects malformed requests without releasing a process', async () => {
  const start = vi.fn();
  const adapter = createPiRunnerAdapter({ process: { start }, argv: ['runner'], cwd: '/trusted', environment: {},
    confirm: async identity => ({ launchId: identity.launchId }) });
  const original = request();
  for (const invalid of [
    { ...original, identity: undefined }, { ...original, executionVersion: 0 },
    { ...original, cwd: { root: 'workspace', relativePath: '/etc' } },
    { ...original, limits: { ...original.limits, maxEvents: 100_001 } },
    { ...original, limits: { ...original.limits, maxOutputBytes: 8_388_609 } },
    { ...original, secret: 'never log this' },
  ]) await expect(adapter.start(invalid as RuntimeExecutionRequest)).rejects.toMatchObject({ kind: 'validation' });
  expect(start).not.toHaveBeenCalled();
});

it('[case:runner-launch-idempotency] concurrent starts and retries after spawn failure never launch twice', async () => {
  const start = vi.fn<CommandProcessPort['start']>().mockRejectedValue(new Error('private prompt and credential'));
  const adapter = createPiRunnerAdapter({ process: { start }, argv: ['runner'], cwd: '/trusted', environment: {},
    confirm: async identity => ({ launchId: identity.launchId }) });
  const outcomes = await Promise.allSettled([adapter.start(request()), adapter.start(request()), adapter.start(request())]);
  expect(start).toHaveBeenCalledTimes(1);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toMatchObject({ kind: 'process', reason: 'runner_start_failed' });
      expect(String(outcome.reason)).not.toContain('private');
    }
  }
  await expect(adapter.start(request())).rejects.toMatchObject({ reason: 'runner_start_failed' });
  expect(start).toHaveBeenCalledTimes(1);
});

const time = '2026-10-20T00:00:00.000Z';
const stop = { schemaVersion: 1 as const, confirmed: true, checkedAtUtc: time, detail: null };
function event(sequence = 1): RuntimeEvent {
  return { schemaVersion: 1, eventId: `event-${sequence}`, kind: 'usage', sequence, occurredAtUtc: time,
    payload: { kind: 'usage', usage: { basis: 'reported', inputTokens: 7, outputTokens: null, costUsdMicros: null } } };
}
function result(lastEventSequence: number | null = 1): RuntimeExecutionResult {
  return { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: null, signal: null,
    durationMs: 12, usage: null, lastEventSequence };
}
function bytes(...messages: unknown[]): Uint8Array {
  return Buffer.from(messages.map(message => JSON.stringify(message) + '\n').join(''));
}
function wire(req = request()) {
  return [piRunnerMessage(req, 1, { kind: 'event', body: event() }),
    piRunnerMessage(req, 2, { kind: 'result', body: result() }),
    piRunnerMessage(req, 3, { kind: 'stopped', body: stop })];
}
function processFixture(chunks: Array<{ stream: 'stdout' | 'stderr'; bytes: Uint8Array }>,
  overrides: Partial<CommandProcessResult> = {}) {
  const cancel = vi.fn(async () => ({ accepted: true }));
  const handle: CommandProcessHandle = {
    identity: { launchId: 'launch-1', pid: 123, processGroupId: 123, startTime: 'os-start' },
    output: { async *[Symbol.asyncIterator]() { yield* chunks; } },
    result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0,
      droppedOutputBytes: 0, stop: { confirmed: true }, ...overrides }),
    stopped: Promise.resolve({ confirmed: true }), cancel,
    query: () => { throw new Error('not used'); },
  };
  const start = vi.fn<CommandProcessPort['start']>().mockResolvedValue(handle);
  const adapter = createPiRunnerAdapter({ process: { start }, argv: ['runner'], cwd: '/trusted', environment: {},
    confirm: async identity => ({ launchId: identity.launchId }) });
  return { adapter, start, cancel };
}

it('[case:runner-sequenced-success] handles fragmented UTF-8 frames, usage and independent stop evidence', async () => {
  const output = bytes(...wire());
  const fixture = processFixture([...output].map(byte => ({ stream: 'stdout', bytes: Uint8Array.of(byte) })));
  const handle = await fixture.adapter.start(request());
  const events: unknown[] = [];
  for await (const item of handle.events) events.push(item);
  const expectedEvent = event();
  const expectedUsage = expectedEvent.payload.kind === 'usage' ? expectedEvent.payload.usage : null;
  expect(events).toEqual([{ ...expectedEvent, payload: expectedUsage }]);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'completed', usage: expectedUsage,
    lastEventSequence: 1, exitCode: 0, signal: null });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'runner_resources_stop_unknown' });
  expect(handle.inspect()).toMatchObject({ failure: null, lastMessageSequence: 3, bufferedBytes: 0 });
  expect(fixture.cancel).not.toHaveBeenCalled();
});

it('[case:runner-single-sdk-admission] Runner admits one SDK request and rejects changed or second invocation', async () => {
  const start = vi.fn<RuntimeAdapter['start']>().mockResolvedValue({
    events: { async *[Symbol.asyncIterator]() { yield event(); } },
    result: Promise.resolve(result()), stopped: Promise.resolve(stop), cancel: async () => ({ accepted: true, reason: null }),
  });
  const output: Uint8Array[] = [];
  const runner = createPiWorkRunner({ adapter: { start }, write: async value => { output.push(value); } });
  await Promise.all([runner.start(request()), runner.start(request())]);
  await runner.start(request());
  expect(start).toHaveBeenCalledTimes(1);
  await expect(runner.start({ ...request(), executionVersion: 2 })).rejects.toMatchObject({ reason: 'runner_request_conflict' });
  await expect(runner.start({ ...request(), invocationId: 'another' })).rejects.toMatchObject({ reason: 'runner_request_conflict' });
  const messages = Buffer.concat(output).toString().trim().split('\n').map(line => JSON.parse(line));
  expect(messages.map(message => [message.kind, message.sequence])).toEqual([['event', 1], ['result', 2], ['stopped', 3]]);
  expect(messages[0]).toMatchObject({ invocationId: 'invocation-1', attemptId: 'attempt-1', executionVersion: 1 });
});

it('[case:runner-entry-rejects-input] stdin entry refuses duplicate JSON requests and oversized input before SDK start', async () => {
  const start = vi.fn();
  for (const value of [JSON.stringify(request()) + '\n' + JSON.stringify(request()), 'x'.repeat(50_000)]) {
    await expect(runPiWorkRunner({ adapter: { start }, input: { async *[Symbol.asyncIterator]() { yield Buffer.from(value); } },
      write: async () => {} })).rejects.toMatchObject({ kind: 'protocol' });
  }
  expect(start).not.toHaveBeenCalled();
});
