import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createPiRunnerAdapter } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import { piRunnerMessage } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import type { CommandProcessHandle, CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import type { RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { piAssembly, piRequest, ScriptedPiSession } from '../../helpers/p04-1/pi-adapter-fixture.ts';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('[case:f007-adapter-isolated-scope] converts controlled SDK facts and isolates native session directories per attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-p04-1-f007-'));
  roots.push(root);
  const sessions: Array<{ sessionDir: string; credentialRef: unknown }> = [];
  const registration = createPiRuntimeAdapter({
    providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: ['fs.read'],
    isolationModes: ['trusted_project'], assembly: piAssembly(root),
    sessionFactory: async options => {
      sessions.push({ sessionDir: options.sessionDir, credentialRef: options.credentialRef });
      return new ScriptedPiSession({
        sessionId: `native-${sessions.length}`,
        sessionFile: join(options.sessionDir, 'session.jsonl'),
        events: [
          { type: 'message_end', message: { id: 'm-1', role: 'assistant', content: [{ text: 'offline result' }], usage: { input: 4, output: 2 }, stopReason: 'stop' } },
          { type: 'future_sdk_event', secret: 'must become bounded diagnostic' },
        ],
      });
    },
  });
  const first = await registration.adapter.start(piRequest());
  const second = await registration.adapter.start(piRequest({
    invocationId: 'invocation-2', sessionId: 'session-2', executionVersion: 2,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-2' },
  }));
  const firstEvents: unknown[] = [];
  for await (const event of first.events) firstEvents.push(event);
  await second.result;
  const result = await first.result as RuntimeExecutionResult;

  expect(sessions).toHaveLength(2);
  expect(sessions[0]!.sessionDir).toContain(join(root, 'sessions'));
  expect(sessions[0]!.sessionDir).not.toBe(sessions[1]!.sessionDir);
  expect(sessions[0]!.credentialRef).toEqual({ kind: 'trusted-resolution', id: 'f007-offline-credential' });
  expect(result).toMatchObject({ terminal: 'completed', providerSessionId: 'native-1',
    usage: { inputTokens: 4, outputTokens: 2, completeness: 'unknown', accounting: 'unknown' },
    lastEventSequence: firstEvents.length, exitCode: null, signal: null,
  });
  expect(firstEvents.map(event => (event as { kind: string }).kind)).toEqual(['message', 'usage', 'diagnostic']);
  expect(firstEvents.every(event => typeof (event as { eventId: unknown }).eventId === 'string')).toBe(true);
});

it('[case:f007-adapter-missing-terminal] fails a prompt that ends without SDK settlement and retains diagnostic evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-p04-1-f007-'));
  roots.push(root);
  const session = new ScriptedPiSession({
    settle: false,
    events: [{ type: 'message_update', message: { id: 'partial', role: 'assistant', content: [{ text: 'partial' }], usage: { input: 9 } } }],
  });
  const registration = createPiRuntimeAdapter({
    providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: ['fs.read'],
    isolationModes: ['trusted_project'], assembly: piAssembly(root), sessionFactory: async () => session,
  });
  const handle = await registration.adapter.start(piRequest());
  const result = await handle.result;
  const events: unknown[] = [];
  for await (const event of handle.events) events.push(event);

  expect(result).toMatchObject({ terminal: 'failed', reason: 'missing_terminal',
    usage: { inputTokens: 9, outputTokens: null, costUsdMicros: null }, lastEventSequence: events.length,
  });
  expect(result).toHaveProperty('diagnosticRefs.length', 1);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'message', payload: expect.objectContaining({ preview: 'partial' }) }),
    expect.objectContaining({ kind: 'diagnostic', payload: expect.objectContaining({ code: 'pi.missing_terminal' }) }),
  ]));
  expect(session.wasDisposed()).toBe(true);
});

it.each([
  ['authentication', 'invalid API key', 'authentication_error'],
  ['configuration', 'invalid SDK configuration', 'sdk_initialization_failed'],
  ['provider', 'provider unavailable', 'provider_error'],
] as const)('[case:f007-adapter-start-error-%s] classifies controlled SDK startup errors before execution', async (_kind, message, reason) => {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-p04-1-f007-'));
  roots.push(root);
  const registration = createPiRuntimeAdapter({
    providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: ['fs.read'],
    isolationModes: ['trusted_project'], assembly: piAssembly(root),
    sessionFactory: async () => { throw new Error(message); },
  });
  await expect(registration.adapter.start(piRequest())).rejects.toMatchObject({ kind: _kind, reason });
});

function processFixture(messages: readonly unknown[]): { adapter: ReturnType<typeof createPiRunnerAdapter>; start: ReturnType<typeof vi.fn> } {
  const processHandle: CommandProcessHandle = {
    identity: { launchId: '11111111-1111-4111-8111-111111111111', pid: 7, processGroupId: 7, startTime: 'f007' },
    output: { async *[Symbol.asyncIterator]() {
      yield { stream: 'stdout' as const, bytes: Buffer.from(messages.map(message => `${JSON.stringify(message)}\n`).join('')) };
    } },
    result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: true } }),
    stopped: Promise.resolve({ confirmed: true }),
    cancel: async () => ({ accepted: true }),
    query: () => { throw new Error('not used'); },
  };
  const start = vi.fn<CommandProcessPort['start']>().mockResolvedValue(processHandle);
  return {
    adapter: createPiRunnerAdapter({ process: { start }, argv: ['controlled-runner'], cwd: '/controlled', environment: {},
      confirm: async identity => ({ launchId: identity.launchId }) }), start,
  };
}

it('[case:f007-runner-protocol-evidence] turns a malformed event watermark into bounded protocol evidence', async () => {
  const req = piRequest();
  const f = processFixture([piRunnerMessage(req, 1, {
    kind: 'event',
    body: { schemaVersion: 1, eventId: 'event-2', kind: 'usage', sequence: 2, occurredAtUtc: '2026-10-20T00:00:00.000Z',
      payload: { kind: 'usage', usage: { basis: 'reported', inputTokens: 3, outputTokens: null, costUsdMicros: null } } },
  })]);
  const handle = await f.adapter.start(req);
  await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', reason: 'runner_event_sequence',
    exitCode: 0, signal: null, lastEventSequence: null });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(handle.inspect()).toMatchObject({ failure: { kind: 'protocol', reason: 'runner_event_sequence' }, lastMessageSequence: 1 });
  await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
});
