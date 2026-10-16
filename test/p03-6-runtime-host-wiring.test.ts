import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, connectToHost, validateAppQueryResponse, type HostClient, type RunningHost } from '../packages/host/src/index.ts';
import { loopbackRequest } from './helpers/host/index.ts';
import { openCoreApplication, type CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { openFakeCoreApplication, createFakeRuntimeGate, createFakeWorkRuntimeFactory } from '../packages/core/src/adapters/testing.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from './helpers/p02-2/index.ts';
import { openBindingFixture, BINDING_NOW, type BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';

let fixture: BindingFixture | undefined;
let core: CoreApplication | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;
let releaseGates: (() => void)[] = [];
afterEach(async () => {
  releaseGates.forEach(release => release()); releaseGates = [];
  client?.close(); client = undefined;
  if (host) { await host.close(); host = undefined; }
  if (core) { await core.workExecution.close(); core.close(); core = undefined; }
  fixture?.close(); fixture = undefined;
});

describe('F-012 production composition', () => {
  it('keeps an accepted Run queryable with runtime_not_found and no claim or Runtime start', async () => {
    fixture = await openBindingFixture();
    core = await openCoreApplication({ dataRoot: fixture.box.dataRoot, capabilityCatalog: fixture.box.capabilityCatalog });
    await core.workExecution.scan();
    expect(fixture.query('SELECT reason FROM runs WHERE id = ?', fixture.runId)).toMatchObject({ reason: 'runtime_not_found' });
    expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 0 });
    expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
  });
  it('executes through explicit Fake composition and retains queryable Runtime evidence', async () => {
    fixture = await openBindingFixture();
    core = await openFakeCoreApplication({ dataRoot: fixture.box.dataRoot,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]),
      nowUtcMs: () => BINDING_NOW,
      fake: { providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'F-012' }] } } });
    const scan = await core.workExecution.scan();
    expect(scan.runs, JSON.stringify(fixture.query('SELECT reason FROM runs'))).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const attempt = fixture.query('SELECT id FROM attempts') as { id: string };
    const detail = await core.queryService.getWorkSession(createLocalOwnerPrincipal(), { projectId: fixture.projectId, attemptId: attempt.id });
    expect(detail.executionState).toBe('awaiting_verification');
    expect(detail.resultEvidence?.result?.terminal).toBe('completed');
    expect(detail.session?.status).toBe('stopped');
    expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    await core.workExecution.scan();
    expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
  });
});

const providers = [{ providerId: 'test-provider', models: ['fake-model'] }];
const catalog = () => createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]);

async function openHostCase(stopGate = false) {
  fixture = await openBindingFixture();
  const run = createFakeRuntimeGate(), stopped = createFakeRuntimeGate();
  releaseGates.push(run.release, stopped.release);
  const factory = createFakeWorkRuntimeFactory({ providers, gates: { run, stopped },
    script: { schemaVersion: 1, steps: [...Array.from({ length: 96 }, () => ({ op: 'message', role: 'assistant', text: 'x'.repeat(200) })),
      { op: 'await_gate', name: 'run' }], ...(stopGate ? { lifecycle: { cancel: { acceptOnly: true }, stopped: { gate: 'stopped' } } } : {}) } });
  let starts = 0, cancels = 0;
  host = await startHost({ dataRoot: fixture.box.dataRoot, capabilityCatalog: catalog(), env: {},
    ...(stopGate ? { quiesceBudgetMs: 50 } : {}), workRuntimeFactory: context => {
      const assembly = factory(context);
      return { ...assembly, entries: assembly.entries.map(entry => ({ ...entry, adapter: { async start(input) {
        starts++;
        const handle = await entry.adapter.start(input);
        return { ...handle, cancel() { cancels++; return handle.cancel(); } };
      } } })) };
    } });
  client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
  await host.core.workExecution.scan();
  await expect.poll(() => starts, { timeout: 20_000 }).toBe(1);
  const attempts = await client.listExecutionAttempts(fixture.projectId, 't-1');
  expect(attempts.records).toHaveLength(1);
  const attemptId = attempts.records[0]!.id;
  const token = readFileSync(join(fixture.box.dataRoot, 'host/auth.token'), 'utf8');
  const command = (envelope: unknown) => loopbackRequest({ port: host!.port, path: '/v1/commands', method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: envelope });
  return { run, stopped, attemptId, token, command, counts: () => ({ starts, cancels }) };
}
function cancelEnvelope(attemptId: string) {
  return { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(),
    operation: 'execution.attempt.cancel', scope: { kind: 'project', projectId: fixture!.projectId },
    payload: { attemptId } };
}

describe('F-012 isolated Host execution', () => {
  it('queries accepted execution, survives observer disconnect, and recovers/replays a lost cancellation response once', async () => {
    const f = await openHostCase();
    const accepted = await client!.getReceipt(fixture!.startEnvelope.commandId as string);
    expect(accepted).toMatchObject({ status: 'accepted', runId: fixture!.runId });
    expect((await f.command(fixture!.startEnvelope)).statusCode).toBe(202);
    const sessions = await client!.listWorkSessions(fixture!.projectId, { runId: fixture!.runId });
    expect(sessions.records).toHaveLength(1);
    const running = await client!.getWorkSession(fixture!.projectId, f.attemptId);
    expect(running.session?.status).toBe('started');
    client!.close();
    client = await connectToHost({ canonicalRoot: fixture!.box.dataRoot });
    expect(f.counts()).toEqual({ starts: 1, cancels: 0 });
    const snapshot = await client!.getSnapshot({ kind: 'project', projectId: fixture!.projectId });
    await new Promise<void>((resolve, reject) => {
      const slow = request({ host: '127.0.0.1', port: host!.port,
        path: `/v1/events?scope=project&projectId=${fixture!.projectId}&cursor=${encodeURIComponent(snapshot.watermark.cursor)}`,
        headers: { Authorization: `Bearer ${f.token}`, Accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { res.destroy(); slow.destroy(); reject(new Error(`SSE status ${res.statusCode}`)); return; }
        res.pause();
        releaseGates.push(() => { res.destroy(); slow.destroy(); }); resolve();
      });
      slow.on('error', reject); slow.end();
    });
    const envelope = cancelEnvelope(f.attemptId);
    // Discard the real HTTP response after the server has committed the command.
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: host!.port, method: 'POST', path: '/v1/commands',
        headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' } }, res => {
        res.destroy(); resolve();
      });
      req.on('error', reject); req.end(JSON.stringify(envelope));
    });
    const receipt = await client!.getReceipt(envelope.commandId);
    expect(receipt).toMatchObject({ status: 'completed', result: { attemptId: f.attemptId, cancellationRequested: true } });
    const replay = await f.command(envelope);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ commandId: envelope.commandId, replayed: true });
    expect((await f.command({ ...envelope, payload: { attemptId: 'different-attempt' } })).statusCode).toBe(409);
    await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const detail = await client!.getWorkSession(fixture!.projectId, f.attemptId);
    expect(detail.attempt.status).toBe('cancelled');
    expect(detail.session?.status).toBe('stopped');
    expect(detail.resultEvidence?.control?.reason).toBe('user_cancelled');
    expect(f.counts()).toEqual({ starts: 1, cancels: 1 });
    expect(fixture!.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    expect(fixture!.query('SELECT count(*) AS n FROM task_attempt_reservations')).toEqual({ n: 1 });
    const artifactId = detail.session!.resultRef!;
    const evidence = await client!.readWorkSessionEvidence(fixture!.projectId, f.attemptId, artifactId);
    expect(evidence.content.length).toBe(evidence.artifact.sizeBytes);
    expect(JSON.parse(Buffer.from(evidence.content).toString()).kind).toBe('runtime-settlement');
    const largeContent = Buffer.alloc(80_000, 'e');
    const published = await createArtifactPublisher({ artifacts: host!.core.artifactStore, files: host!.core.artifactFileStore,
      limits: { maxSizeBytes: 100_000, timeoutMs: 5_000 } }).publishArtifact({ projectId: fixture!.projectId,
      kind: 'work-event-log', mediaType: 'application/octet-stream',
      expectedHash: createHash('sha256').update(largeContent).digest('hex'),
      locator: `sessions/${detail.session!.id}/large-evidence.bin`, content: [largeContent] });
    const largeResponse = await client!.readWorkSessionEvidence(fixture!.projectId, f.attemptId, published.artifact.id);
    expect(Buffer.from(largeResponse.content).equals(largeContent)).toBe(true);
    const largeWire = { schemaVersion: 5, scope: 'work-session-evidence', artifact: { ...evidence.artifact,
      sizeBytes: largeContent.length, contentHash: createHash('sha256').update(largeContent).digest('hex') }, content: largeContent.toString('base64') };
    expect(validateAppQueryResponse('execution.session.evidence.get', largeWire).content.length).toBe(80_000);
    expect(() => validateAppQueryResponse('execution.session.evidence.get', { ...largeWire, content: Buffer.alloc(80_000).toString('base64') })).toThrow();
    expect(() => validateAppQueryResponse('execution.session.get', { ...detail, privateField: 'leak' })).toThrow();
    expect(() => validateAppQueryResponse('execution.sessions.list', { ...sessions, schemaVersion: 999 })).toThrow();
  });

  it('rejects unauthenticated, expired, cross-project and unsupported requests before cancelling', async () => {
    const f = await openHostCase();
    const envelope = cancelEnvelope(f.attemptId);
    expect((await loopbackRequest({ port: host!.port, path: '/v1/commands', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: envelope })).statusCode).toBe(401);
    expect((await f.command({ ...envelope, schemaVersion: 999 })).statusCode).toBe(400);
    const expired = await f.command({ ...envelope, commandId: randomUUID(), issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:01.000Z' });
    expect(expired.json()).toMatchObject({ error: { code: 'command_expired' } });
    const registered = await client!.submitCommand({ operation: 'project.register', scope: { kind: 'registration' },
      payload: { repositoryPath: fixture!.box.repoDirB, displayName: 'Project B', description: null, labels: [] } });
    expect(registered.status).toBe('completed');
    const projectIdB = (registered as { result: { project: { id: string } } }).result.project.id;
    const crossed = await f.command({ ...envelope, commandId: randomUUID(), scope: { kind: 'project', projectId: projectIdB } });
    expect(crossed.json()).toMatchObject({ error: { code: 'forbidden' } });
    await expect(client!.getWorkSession(projectIdB, f.attemptId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.command({ ...envelope, commandId: randomUUID(), operation: 'execution.result.submit' })).statusCode).toBe(501);
    expect(f.counts()).toEqual({ starts: 1, cancels: 0 });
    const authorized = fixture!.box.restrictedPrincipal({ capabilities: ['execution.start', 'receipts.read'],
      projectScope: fixture!.box.scopeAllowlist([fixture!.projectId]) });
    const cancellation = await host!.core.commandService.submit(authorized, envelope as never);
    expect(cancellation.status).toBe('completed');
    const revoked = fixture!.box.restrictedPrincipal({ principalId: authorized.principalId, capabilities: ['receipts.read'],
      projectScope: fixture!.box.scopeAllowlist([fixture!.projectId]) });
    await expect(host!.core.commandService.submit(revoked, envelope as never)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.counts()).toEqual({ starts: 1, cancels: 1 });
  });

  it('settles a cancellation/result race only once without another claim or debit', async () => {
    const f = await openHostCase();
    const envelope = cancelEnvelope(f.attemptId);
    f.run.release();
    expect([200, 409]).toContain((await f.command(envelope)).statusCode);
    await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const detail = await client!.getWorkSession(fixture!.projectId, f.attemptId);
    expect(['cancelled', 'verifying']).toContain(detail.attempt.status);
    expect(detail.session?.status).toBe('stopped');
    const before = fixture!.query('SELECT status, result_ref, revision FROM sessions');
    await f.command(envelope);
    await host!.core.workExecution.scan();
    expect(fixture!.query('SELECT status, result_ref, revision FROM sessions')).toEqual(before);
    expect(fixture!.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 1 });
    expect(fixture!.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.counts().starts).toBe(1);
    expect(f.counts().cancels).toBeLessThanOrEqual(1);
  });

  it('keeps the writer lock and refuses stopped while Runtime stop evidence is pending', async () => {
    const f = await openHostCase(true);
    await expect(host!.close()).rejects.toMatchObject({ code: 'resource_busy' });
    expect(host!.lifecycleState).toBe('quiescing');
    await expect(startHost({ dataRoot: fixture!.box.dataRoot, capabilityCatalog: catalog(), env: {}, lockTimeoutMs: 0 })).rejects.toBeDefined();
    expect(fixture!.query('SELECT count(*) AS n FROM workspace_leases')).toEqual({ n: 3 });
    f.run.release(); f.stopped.release();
    await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 5_000 }).toEqual([]);
    await host!.close(); host = undefined;
  });
});
