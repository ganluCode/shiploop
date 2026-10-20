import { afterEach, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkResourceSnapshot } from '../../../packages/core/src/ports/work-resources.ts';
import { startHost, connectToHost, createPiWorkRuntimeFactory, type RunningHost, type HostClient } from '../../../packages/host/src/index.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openFakeCoreApplication } from '../../../packages/core/src/adapters/testing.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { fixture as stoppingFixture } from '../../helpers/p03-6/stopping-fixture.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';

// Any accidental eager SDK import makes this module fail to load.
vi.mock('@earendil-works/pi-coding-agent', () => { throw new Error('SDK deliberately unavailable'); });
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';

import { PiRunnerDecoder } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';

import type { WorkRuntimeContext } from '../../../packages/core/src/adapters/composition.ts';

const providers = [{ providerId: 'provider', models: ['model'] }];
const capability = { runtimeId: 'pi', providers, contractVersion: 1, permissionGrants: ['fs.read'], isolationModes: ['trusted_project'] };
const context = (capabilityCatalog = createStaticRuntimeCapabilityCatalog([capability])): WorkRuntimeContext => ({
  capabilityCatalog, workspaceRoots: {}, reader: () => undefined,
  commitCommandIdentity: async identity => ({ launchId: identity.launchId }),
});

it('[case:factory-static-entry] assembles a versioned Pi entry without starting its trusted process', () => {
  const start = vi.fn();
  const factory = createPiWorkRuntimeFactory({ providers, permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
    process: { start }, argv: ['trusted-runner'], cwd: '/trusted', environment: {} });
  const assembly = factory(context());
  expect(assembly.entries[0]?.descriptor).toMatchObject({ ...capability, sdkVersion: '1.0.4', adapterVersion: '0.1.0' });
  expect(start).not.toHaveBeenCalled();
  expect(() => factory(context(createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers }]))))
    .toThrowError(expect.objectContaining({ reason: 'pi_capability_declarations_required' }));
});

it('[case:catalog-permission-drift] rejects permission drift before invoking an adapter', () => {
  const descriptor = { schemaVersion: 1 as const, runtimeId: 'pi', contractVersion: 1 as const,
    adapterVersion: '0.1.0', providers: [{ providerId: 'provider', models: ['model'] }],
    permissionGrants: ['fs.read'], isolationModes: ['trusted_project'] };
  const start = vi.fn();
  const catalog = createStaticRuntimeCapabilityCatalog([{ ...descriptor, permissionGrants: ['fs.write'] }]);
  expect(() => createStaticRuntimeRegistry([{ descriptor, adapter: { start } }], catalog))
    .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'permission_grants_mismatch' }) }));
});

it.each([
  ['provider', { providers: [{ providerId: 'other', models: ['model'] }] }, 'provider_mismatch'],
  ['model', { providers: [{ providerId: 'provider', models: ['other'] }] }, 'provider_mismatch'],
  ['permissions', { permissionGrants: ['fs.write'] }, 'permission_grants_mismatch'],
  ['isolation', { isolationModes: ['strong_sandbox'] }, 'isolation_modes_mismatch'],
  ['contract', { contractVersion: 2 }, 'contract_version_mismatch'],
] as const)('[case:catalog-drift-%s] rejects catalog drift without process side effects', (_field, changes, reason) => {
  const start = vi.fn();
  const factory = createPiWorkRuntimeFactory({ providers, permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
    process: { start }, argv: ['trusted-runner'], cwd: '/trusted', environment: {} });
  expect(() => factory(context(createStaticRuntimeCapabilityCatalog([{ ...capability, ...changes }]))))
    .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason }) }));
  expect(start).not.toHaveBeenCalled();
});

it('[case:registry-invalid-entries] refuses unknown, duplicate, incompatible and module-path entries before startup', () => {
  const factory = createPiWorkRuntimeFactory({ providers, permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
    process: { start: vi.fn() }, argv: ['trusted-runner'], cwd: '/trusted', environment: {} });
  const entry = factory(context()).entries[0]!;
  for (const [entries, catalog, reason] of [
    [[entry], createStaticRuntimeCapabilityCatalog([]), 'unknown_runtime'],
    [[entry, entry], context().capabilityCatalog, 'duplicate_runtime_id'],
    [[{ ...entry, descriptor: { ...entry.descriptor, contractVersion: 2 } }], context().capabilityCatalog, 'contract_version_incompatible'],
    [[{ ...entry, adapter: '/untrusted/module.js' }], context().capabilityCatalog, 'adapter_must_be_injected'],
  ] as const) expect(() => createStaticRuntimeRegistry(entries, catalog))
    .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason }) }));
});

function request(): RuntimeExecutionRequest {
  const ref = (purpose: string) => ({ projectId: 'project-1', artifactId: `artifact-${purpose}`, kind: 'execution-input',
    purpose, version: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'artifact' as const } });
  return { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1', invocationId: 'invocation-1',
    executionVersion: 1, identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
    owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
    strategy: { runtime: 'pi', provider: 'provider', model: 'model' }, prompt: ref('prompt'), inputManifest: ref('manifest'),
    cwd: { root: 'managed-work', relativePath: '.' }, permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 15_000, maxEvents: 100, maxOutputBytes: 100_000 }, recovery: { mode: 'new' } };
}
const workCapability = { ...capability, permissionGrants: [] };
const workCatalog = () => createStaticRuntimeCapabilityCatalog([workCapability]);
function realAssembly(mode: 'complete' | 'cancel' | 'crash' | 'start-failed' = 'complete') {
  const port = createCommandProcessAdapter({ stopGraceMs: 3_000, stopConfirmMs: 2_000 });
  const handles = new Map<string, CommandProcessHandle>();
  const tokens = new WeakMap<object, WorkResourceSnapshot>();
  let starts = 0, events = 0;
  const processPort: CommandProcessPort = { start: async (input, confirm) => {
    starts++;
    if (mode === 'start-failed') throw new Error('Controlled launch failure');
    const req = JSON.parse(Buffer.from(input.stdin!).toString()) as RuntimeExecutionRequest;
    const handle = await port.start(input, confirm);
    handles.set(req.invocationId, handle);
    const decoder = new PiRunnerDecoder();
    return { ...handle, output: (async function* () {
      for await (const chunk of handle.output) {
        if (chunk.stream === 'stdout') for (const frame of decoder.push(chunk.bytes)) {
          if ((frame as { kind: string }).kind === 'event') events++;
        }
        yield chunk;
      }
    })() };
  } };
  const factory = createPiWorkRuntimeFactory({ providers, permissionGrants: [], isolationModes: ['trusted_project'],
    process: processPort, argv: [process.execPath, '--experimental-transform-types', '--import',
      fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url)),
      fileURLToPath(new URL('../../helpers/pi-composition-runner-child.ts', import.meta.url))], cwd: process.cwd(),
    environment: { SHIPLOOP_TEST_PI_MODE: mode },
    // This test Runner has no external tools. A real tool-capable assembly needs its own authority.
    resourceStop: { snapshot(req) {
      if (req.identity.purpose !== 'work') throw new Error('Work required');
      return { identity: { projectId: req.projectId, attemptId: req.identity.attemptId, owner: req.owner.principalId,
        hostInstanceId: req.owner.hostInstanceId, executionVersion: req.executionVersion }, invocationId: req.invocationId,
        processIdentity: handles.get(req.invocationId)!.identity, leases: [] };
    }, verifier: { async verify(snapshot) {
      if (!(await port.recoverStop!(snapshot.processIdentity!)).confirmed) return null;
      const token = Object.freeze({}); tokens.set(token, snapshot); return token;
    }, inspect(token) {
      const snapshot = typeof token === 'object' && token !== null ? tokens.get(token) : undefined;
      if (!snapshot) throw new Error('Unknown test proof');
      return snapshot;
    } } } });
  return { factory, handles, starts: () => starts, events: () => events, async dispose() {
    for (const handle of handles.values()) {
      await handle.cancel();
      expect((await port.recoverStop!(handle.identity)).confirmed).toBe(true);
    }
  } };
}

it('[case:factory-admission] duplicate and stale identities cannot start another Runner', async () => {
  const f = realAssembly();
  const assembly = f.factory(context(workCatalog())), adapter = assembly.entries[0]!.adapter, req = request();
  try {
    const [first, repeat] = await Promise.all([adapter.start(req), adapter.start(req)]);
    expect(first).toBe(repeat);
    await expect(adapter.start({ ...req, invocationId: 'stale-invocation' }))
      .rejects.toMatchObject({ reason: 'runner_stale_execution' });
    await expect(adapter.start({ ...req, strategy: { ...req.strategy, model: 'other' } }))
      .rejects.toMatchObject({ reason: 'unsupported_model' });
    const events: any[] = [];
    for await (const event of first.events) events.push(event);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.eventId.startsWith(assembly.eventIdentityPrefix(req)))).toBe(true);
    await expect(first.result).resolves.toMatchObject({ terminal: 'completed' });
    await expect(first.stopped).resolves.toMatchObject({ confirmed: true });
    expect(f.starts()).toBe(1);
  } finally { await f.dispose(); }
}, 20_000);

it('[case:factory-start-failure] repeated failed admission keeps the same failure and one launch', async () => {
  const start = vi.fn(async () => { throw new Error('private process failure'); });
  const assembly = createPiWorkRuntimeFactory({ providers, permissionGrants: [], isolationModes: ['trusted_project'],
    process: { start }, argv: ['trusted-runner'], cwd: '/trusted', environment: {} })(context(workCatalog()));
  const adapter = assembly.entries[0]!.adapter;
  await expect(adapter.start(request())).rejects.toMatchObject({ kind: 'process', reason: 'runner_start_failed' });
  await expect(adapter.start(request())).rejects.toMatchObject({ reason: 'runner_start_failed' });
  expect(start).toHaveBeenCalledTimes(1);
});

it('[case:factory-runner-crash] real Runner crash retains partial public events and cannot prove stop of resources', async () => {
  const f = realAssembly('crash');
  try {
    const handle = await f.factory(context(workCatalog())).entries[0]!.adapter.start(request());
    const events: unknown[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events).toHaveLength(2);
    await expect(handle.result).resolves.toMatchObject({ terminal: 'failed', exitCode: 7 });
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false, detail: 'runner_stop_evidence_missing' });
  } finally { await f.dispose(); }
}, 20_000);

let fixture: BindingFixture | undefined, host: RunningHost | undefined, client: HostClient | undefined;
afterEach(async () => {
  client?.close(); client = undefined;
  if (host) { await host.close(); host = undefined; }
  fixture?.close(); fixture = undefined;
});

// Full Host composition includes real workspace preparation and supervised Git commands.
// Use the repository's integration-test budget; Runner and settlement waits stay independently bounded.
it.each(['complete', 'cancel'] as const)('[case:host-pi-%s] Host exposes Attempt, Session, events and fenced Core settlement', async mode => {
  fixture = await openBindingFixture({ strategy: { runtime: 'pi', provider: 'provider', model: 'model' } });
  const f = realAssembly(mode);
  try {
    host = await startHost({ dataRoot: fixture.box.dataRoot, capabilityCatalog: workCatalog(), env: {}, workRuntimeFactory: f.factory });
    client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
    await host.core.workExecution.scan();
    await expect.poll(async () => (await client!.listExecutionAttempts(fixture!.projectId, 't-1')).records.length).toBe(1);
    const attemptId = (await client.listExecutionAttempts(fixture.projectId, 't-1')).records[0]!.id;
    if (mode === 'cancel') {
      await expect.poll(f.events, { timeout: 10_000 }).toBe(2);
      const response = await client.submitCommand({ operation: 'execution.attempt.cancel',
        scope: { kind: 'project', projectId: fixture.projectId }, payload: { attemptId } });
      expect(response.status).toBe('completed');
    }
    await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);
    const detail = await client.getWorkSession(fixture.projectId, attemptId);
    expect(detail.attempt.status).toBe(mode === 'complete' ? 'verifying' : 'cancelled');
    expect(detail.session?.status).toBe('stopped');
    expect(detail.resultEvidence?.result?.terminal).toBe(mode === 'complete' ? 'completed' : 'cancelled');
    expect(detail.resultEvidence?.stop.evidence?.confirmed).toBe(true);
    if (mode === 'complete') {
      expect(detail.session?.recordingGaps).toEqual([]);
      const eventsRef = detail.evidence.find(ref => ref.kind === 'work-evidence-events')!;
      const events = await client.readWorkSessionEvidence(fixture.projectId, attemptId, eventsRef.artifactId);
      const lines = Buffer.from(events.content).toString().trim().split('\n').map(line => JSON.parse(line));
      expect(lines).toMatchObject([{ kind: 'message', payload: { preview: 'Pi Work evidence' } }, { kind: 'usage' }]);
      expect(detail.resultEvidence?.result?.usage).toMatchObject({ basis: 'reported', inputTokens: 5, outputTokens: 2 });
    } else {
      // Core intentionally aborts collection when cancellation is requested.
      expect(detail.session?.recordingGaps).toEqual(['recording_required']);
      expect(detail.resultEvidence?.recording.complete).toBe(false);
    }
    const session = (await client.listWorkSessions(fixture.projectId, { runId: fixture.runId })).records;
    expect(session).toHaveLength(1);
    const evidence = await client.readWorkSessionEvidence(fixture.projectId, attemptId, detail.session!.resultRef!);
    expect(JSON.parse(Buffer.from(evidence.content).toString()).kind).toBe('runtime-settlement');
    expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    expect(fixture.query('SELECT status FROM tasks WHERE id = ?', 't-1')).not.toEqual({ status: 'passed' });
    await host.core.workExecution.scan();
    expect(f.starts()).toBe(1);
  } finally { await f.dispose(); }
});

it.each(['stale', 'crash', 'start-failed'] as const)('[case:core-pi-%s] Core fences late Pi facts and retains unknown-stop occupancy', async mode => {
  const runner = realAssembly(mode === 'stale' ? 'cancel' : mode);
  const f = await stoppingFixture({}, {}, (binding, deps) => {
    const assembly = runner.factory({ ...context(workCatalog()), commitCommandIdentity: async (identity, runtime) => {
      const work = runtime.identity;
      if (work.purpose !== 'work') throw new Error('Work required');
      binding.session.transactWrite('test.pi-confirm', () => binding.createResources().confirmLaunchInTransaction({
        projectId: binding.projectId, attemptId: work.attemptId, owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 1,
      }, identity));
      return { launchId: identity.launchId };
    } });
    Object.assign(deps, { eventIdentityPrefix: assembly.eventIdentityPrefix,
      runtime: createRuntimeExecutionService({ configuration: workCatalog(),
        registry: createStaticRuntimeRegistry(assembly.entries, workCatalog()) }) });
  }, 't-1', { strategy: { runtime: 'pi', provider: 'provider', model: 'model' } });
  try {
    if (mode === 'start-failed') {
      await expect(f.start()).rejects.toMatchObject({ kind: 'process', reason: 'runner_start_failed' });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
      expect((f.query("SELECT count(*) AS n FROM workspace_leases WHERE state IN ('held', 'quarantined')") as { n: number }).n).toBeGreaterThan(0);
      expect(f.retain).not.toHaveBeenCalled();
      return;
    }
    const started = await f.start();
    const before = f.query('SELECT status, execution_version FROM attempts');
    if (mode === 'stale') {
      await expect.poll(runner.events, { timeout: 10_000 }).toBe(2);
      f.session.database.prepare('UPDATE tasks SET execution_version = execution_version + 1 WHERE id = ?').run('t-1');
      await started.context.runtime.cancel();
    }
    const completion = await started.context.completion;
    expect(completion).toMatchObject(mode === 'stale'
      ? { stopConfirmed: true, persisted: false, error: 'stale_execution_identity' }
      : { stopConfirmed: false, persisted: true });
    expect(f.query('SELECT status FROM attempts')).toEqual(mode === 'stale'
      ? { status: (before as { status: string }).status } : { status: 'interrupted' });
    if (mode === 'stale') expect(f.query('SELECT status, execution_version FROM attempts')).toEqual(before);
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).not.toEqual({ status: 'passed' });
    expect((f.query("SELECT count(*) AS n FROM workspace_leases WHERE state IN ('held', 'quarantined')") as { n: number }).n).toBeGreaterThan(0);
    expect(f.retain).not.toHaveBeenCalled();
    if (mode === 'stale') expect((f.query('SELECT count(*) AS n FROM attempt_notification_diagnostics') as { n: number }).n).toBeGreaterThan(0);
    expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
  } finally { await runner.dispose(); await f.dispose(); }
}, 25_000);

it('[case:core-catalog-before-claim] catalog drift aborts Core assembly before claims or runtime debits', async () => {
  fixture = await openBindingFixture({ strategy: { runtime: 'pi', provider: 'provider', model: 'model' } });
  const start = vi.fn();
  const factory = createPiWorkRuntimeFactory({ providers, permissionGrants: [], isolationModes: ['trusted_project'],
    process: { start }, argv: ['trusted-runner'], cwd: '/trusted', environment: {} });
  await expect(openCoreApplication({ dataRoot: fixture.box.dataRoot,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ ...workCapability, permissionGrants: ['fs.write'] }]),
    workRuntimeFactory: factory })).rejects.toThrowError(expect.objectContaining({
      details: expect.objectContaining({ reason: 'permission_grants_mismatch' }),
    }));
  expect(start).not.toHaveBeenCalled();
  expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
  expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
});

it('[case:sdk-absent-core-fake] SDK absence leaves Core, Host, CLI and Fake assembly usable', async () => {
  expect(typeof (await import('../../../packages/cli/src/index.ts')).parseHostCliArgs).toBe('function');
  fixture = await openBindingFixture();
  const core = await openCoreApplication({ dataRoot: fixture.box.dataRoot, capabilityCatalog: fixture.box.capabilityCatalog });
  try {
    await core.workExecution.scan();
    expect(fixture.query('SELECT reason FROM runs')).toEqual({ reason: 'runtime_not_found' });
    expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
  } finally { await core.workExecution.close(); core.close(); }
  const fake = await openFakeCoreApplication({ dataRoot: fixture.box.dataRoot,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]),
    fake: { providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'no Pi SDK' }] } } });
  try {
    await fake.workExecution.scan();
    await expect.poll(() => fake.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    expect(fixture.query('SELECT status FROM attempts')).toEqual({ status: 'verifying' });
  } finally { await fake.workExecution.close(); fake.close(); }
});
