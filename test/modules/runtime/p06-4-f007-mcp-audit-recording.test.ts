import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';
import type { RuntimeEvent, RuntimeEventPayload, RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createMcpRuntimeAudit } from '../../../packages/host/src/runtime/mcp-runtime-audit.ts';
import { createMcpStdioConnection, type McpStdioConnection, type McpStdioConnectionOptions } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import type { McpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { PiRunnerEventChannel, piRunnerMessage, encodePiRunnerMessage, validatePiRunnerMessage } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import { openBindingFixture, BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { createFakeMcpServerCommand, waitForFakeMcpFile, type FakeMcpServerOptions } from '../../helpers/mcp-stdio-fake-server.ts';

const SECRET = 'synthetic-mcp-private-value-7cf0';
async function fixture(options: FakeMcpServerOptions = {}, connectionOptions: Partial<McpStdioConnectionOptions> = {}) {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  const source = createTempSandbox('shiploop-mcp-audit-source-');
  let c: McpStdioConnection | undefined;
  try {
    const launch = f.claimAndLaunch('t-1');
    const { request } = await f.bindingService.bind(f.bindingInput(launch));
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: launch.receipt.attempt.id,
      owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
    const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'test-v1' });
    sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    const publisher = createWorkRecordingPublisher({ artifacts: f.publisher, redactionValues: [SECRET], limits: {
      maxBodyBytes: 65_536, maxAttachmentBytes: 65_536, maxTotalBytes: 131_072, maxChunkBytes: 8192, maxQueueBytes: 8192 } });
    const recorder = createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, secrets: [SECRET],
      limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 2, tailWaitMs: 500 },
      recording: { publisher, store, nowUtcMs: () => NOW } });
    const command = createFakeMcpServerCommand(source.path, { echoEnvironmentKey: 'MCP_CREDENTIAL', ...options });
    const mapping = { resourceId: 'server-1', sourceRef: 'source-1', originalName: 'echo', piName: 'mcp_echo' };
    const server = { resourceId: 'server-1', sourceRef: 'source-1', sourceRevision: 'r1', version: null, contentDigest: null,
      environmentRefs: ['ref-1'], credentialRef: 'credential-ref', ...command, cwd: source.path, environment: { MCP_CREDENTIAL: SECRET },
      allowedTools: ['echo'], approvalDigest: 'approval', tools: [mapping] };
    const plan: McpStartupPlan = { schemaVersion: 1, projectId: request.projectId, sessionId: request.sessionId,
      attemptId: request.identity.purpose === 'work' ? request.identity.attemptId : '', invocationId: request.invocationId,
      executionVersion: request.executionVersion, resourceSnapshotDigest: 'snapshot', digest: 'plan-digest',
      servers: [server], tools: [mapping], gaps: [] };
    const events: RuntimeEvent[] = [];
    let stopRequests = 0, cancels = 0;
    const publish = (payload: RuntimeEventPayload) => {
      const sequence = events.length + 1;
      const event: RuntimeEvent = { schemaVersion: 1, eventId: `evt.mcp.${sequence}`, kind: payload.kind, sequence,
        occurredAtUtc: new Date(NOW).toISOString(), payload };
      const wire = encodePiRunnerMessage(piRunnerMessage(request, sequence, { kind: 'event', body: event }));
      const decoded = validatePiRunnerMessage(JSON.parse(Buffer.from(wire).toString()), request, sequence - 1);
      if (decoded.kind !== 'event') throw new Error('unexpected wire message');
      events.push(decoded.body);
      return true;
    };
    const audit = createMcpRuntimeAudit({ plan, publish, requestStop: () => { stopRequests++; } });
    c = createMcpStdioConnection({ plan, audit, registerProcess: async r => ({ launchId: r.processIdentity.launchId }),
      closeTimeoutMs: 75, ...connectionOptions });
    const connection = c;
    const handle = (): RuntimeHandle => ({ events: { async *[Symbol.asyncIterator]() { yield* events; } },
      result: Promise.resolve({ schemaVersion: 1, terminal: 'completed', reason: null, exitCode: null, signal: null,
        durationMs: null, usage: null, lastEventSequence: events.length }),
      stopped: Promise.resolve({ schemaVersion: 1, confirmed: false, checkedAtUtc: new Date(NOW).toISOString(), detail: 'test_no_runtime_stop_proof' }),
      cancel: async () => { cancels++; return { accepted: true, reason: null }; } });
    return { ...f, source, request, plan, connection, audit, events, publisher, recorder, store, handle,
      stopRequests: () => stopRequests, cancels: () => cancels,
      record: () => recorder.record({ request, handle: handle(), eventIdentityPrefix: 'evt.mcp.' }),
      async dispose() { await connection.close(); source.cleanup(); f.close(); } };
  } catch (error) { await c?.close(); source.cleanup(); f.close(); throw error; }
}

function bodies(events: RuntimeEvent[]): Record<string, unknown>[] {
  return events.flatMap(event => {
    const p = event.payload;
    const text = p.kind === 'message' ? p.text : p.kind === 'tool_started' ? p.input : p.kind === 'tool_finished' ? p.output : null;
    return text ? [JSON.parse(text) as Record<string, unknown>] : [];
  });
}

it('[case:durable-cleanup-source-deleted] persists correlated results and stop evidence through wire/SQLite/Artifacts after source removal', async () => {
  const f = await fixture();
  try {
    const ready = await f.connection.start();
    expect(JSON.stringify(ready)).not.toContain(SECRET);
    expect(JSON.stringify(f.plan.servers[0]!.argv)).not.toContain(SECRET);
    for (const ref of [f.request.prompt, f.request.inputManifest]) {
      const input = await f.verifier.readVerifiedContent(f.projectId, ref.artifactId);
      expect(Buffer.from(input.content).toString()).not.toContain(SECRET);
    }
    expect(JSON.stringify(f.query('SELECT input_snapshot FROM attempts WHERE id = ?',
      f.request.identity.purpose === 'work' ? f.request.identity.attemptId : ''))).not.toContain(SECRET);
    const catalog = await f.connection.createToolCatalog();
    const result = await catalog.tools[0]!.execute('call-1', {});
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const stop = await f.connection.close();
    await f.connection.close();
    expect(stop.confirmed).toBe(true);
    const cleanup = bodies(f.events).filter(event => event.phase === 'cleanup');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ projectId: f.request.projectId, invocationId: f.request.invocationId,
      executionVersion: f.request.executionVersion, toolCallId: null,
      content: { evidence: { confirmed: true }, stderr: { redacted: true, truncated: false, text: '[REDACTED]\n' } } });
    const content = cleanup[0]!.content as { evidence: unknown; evidenceDigest: string };
    expect(content.evidenceDigest).toBe(createHash('sha256').update(stableStringify(content.evidence)).digest('hex'));
    const originalEnd = f.events.find(event => event.kind === 'tool_finished')!;
    f.events.push(originalEnd); // Stable duplicate delivery cannot create a second settled result.
    f.source.cleanup();
    expect(existsSync(f.source.path)).toBe(false);
    const outcome = await f.recorder.record({ request: f.request, handle: { ...f.handle(),
      result: Promise.resolve({ schemaVersion: 1, terminal: 'completed', reason: null, exitCode: null, signal: null,
        durationMs: null, usage: null, lastEventSequence: f.events.length - 1 }) }, eventIdentityPrefix: 'evt.mcp.' });
    expect(outcome.status).toBe('complete');
    const manifest = f.store.getLatestManifest(f.projectId, f.request.sessionId)!;
    expect(manifest).toMatchObject({ coverage: 'complete', watermark: f.events.length - 1, finalized: true, redaction: { applied: true } });
    const rows = f.session.database.prepare('SELECT kind, content_ref FROM session_messages ORDER BY sequence').all() as { kind: string; content_ref: string }[];
    expect(rows.filter(row => row.kind === 'tool_finished')).toHaveLength(1);
    const saved: unknown[] = [];
    for (const row of rows) {
      const body = await f.verifier.readVerifiedContent(f.projectId, row.content_ref);
      expect(body.contentHash).toBe(createHash('sha256').update(body.content).digest('hex'));
      saved.push(JSON.parse(Buffer.from(body.content).toString()));
    }
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).not.toContain(f.source.path);
    const evidenceManifest = await f.verifier.readVerifiedContent(f.projectId, manifest.manifestRef!.artifactId);
    expect(JSON.parse(Buffer.from(evidenceManifest.content).toString())).toMatchObject({ stop: { evidence: { confirmed: false } } });
    expect(Buffer.from(evidenceManifest.content).toString()).not.toContain(SECRET);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
  } finally { await f.dispose(); }
}, 20_000);

it('[case:cleanup-unconfirmed-is-not-stop-proof] records uncertain cleanup independently of the Runtime terminal', async () => {
  const f = await fixture({}, { processInspector: {
    identify: async (pid, launchId) => ({ pid, processGroupId: pid, launchId, startTime: 'synthetic-test-start' }),
    matches: async () => false, groupAbsent: async () => false } });
  try {
    await f.connection.start();
    const stop = await f.connection.close();
    expect(stop.confirmed).toBe(false);
    expect(bodies(f.events).find(event => event.phase === 'cleanup')).toMatchObject({ reason: 'cleanup_unconfirmed',
      content: { evidence: { confirmed: false, status: 'unconfirmed' } } });
    expect((await f.record()).status).toBe('complete'); // Complete observation, not a confirmed stop or accepted Task.
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
  } finally { await f.dispose(); }
}, 20_000);

it('[case:required-recorder-write-failure] retains the durable prefix and requests cancellation without advancing to a successor', async () => {
  const f = await fixture();
  try {
    await f.connection.start();
    const catalog = await f.connection.createToolCatalog();
    await catalog.tools[0]!.execute('call-1', {});
    await f.connection.close();
    let writes = 0;
    const publish = f.publisher.publishBody.bind(f.publisher);
    f.publisher.publishBody = async input => ++writes > 2 ? { status: 'unavailable', ref: null, observedBytes: 0,
      retainedBytes: 0, truncated: false, redacted: false, gapReasons: ['publication_file_error'] } : publish(input);
    await expect(f.record()).rejects.toMatchObject({ name: 'WorkEvidenceRecordingError', safeStopRequired: true });
    expect(f.cancels()).toBe(1);
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ watermark: 2, coverage: 'failed' });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
  } finally { await f.dispose(); }
}, 20_000);

it('[case:bounded-channel-backpressure] stops audited MCP dispatch when the existing Runner channel is full', async () => {
  let stops = 0;
  const f = await fixture();
  try {
    const channel = new PiRunnerEventChannel(() => { stops++; });
    for (let i = 1; i <= 64; i++) expect(channel.push({ schemaVersion: 1, eventId: `fill-${i}`, sequence: i,
      occurredAtUtc: new Date(NOW).toISOString(), kind: 'diagnostic', payload: { kind: 'diagnostic', code: 'fill', message: 'bounded' } })).toBe(true);
    const audit = createMcpRuntimeAudit({ plan: f.plan, publish: payload => channel.push({ schemaVersion: 1, eventId: 'overflow',
      sequence: 65, occurredAtUtc: new Date(NOW).toISOString(), kind: payload.kind, payload }), requestStop: () => { stops++; } });
    let calls = 0;
    await expect(audit.observeCall('server-1', 'mcp_echo', 'backpressure', {}, async () => { calls++; return {}; }, () => 'failed'))
      .rejects.toMatchObject({ reason: 'audit_unavailable' });
    expect(channel.snapshot().events).toBe(64); expect(stops).toBe(1); expect(calls).toBe(0);
    channel.close();
  } finally { await f.dispose(); }
}, 20_000);

it('[case:truncation-is-durable-gap] a truncated stderr tail remains partial in the Recorder and retains stop evidence', async () => {
  const f = await fixture({ stderrBytes: 10000 }, { maxStderrBytes: 128 });
  try {
    await f.connection.start();
    await f.connection.close();
    expect(f.stopRequests()).toBe(1);
    expect(bodies(f.events).find(event => event.phase === 'cleanup')).toMatchObject({ coverage: 'partial',
      gap: 'mcp_stderr_truncated', content: { evidence: { confirmed: true }, stderr: { truncated: true } } });
    await expect(f.record()).rejects.toMatchObject({ name: 'WorkEvidenceRecordingError', safeStopRequired: true });
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)!.missingReasons).toContain('mcp_audit_gap');
    expect(f.cancels()).toBe(1);
  } finally { await f.dispose(); }
}, 20_000);

it('[case:argv-secret-rejected-before-spawn] refuses a resolved environment credential in process arguments', async () => {
  const f = await fixture();
  try {
    const plan = structuredClone(f.plan);
    (plan.servers[0]!.argv as string[]).push(`--credential=${SECRET}`);
    expect(() => createMcpStdioConnection({ plan, registerProcess: async () => { throw new Error('must not spawn'); } }))
      .toThrow('invalid_startup_plan');
    expect(existsSync(join(f.source.path, 'server.pid'))).toBe(false);
  } finally { await f.dispose(); }
});

it.each(['invalid_protocol', 'stdout_noise', 'exit_initialize'] as const)(
  '[case:startup-fault-%s] retains lifecycle failure and cleanup without inventing a tool call', async mode => {
    const f = await fixture({ mode });
    try {
      await expect(f.connection.start()).rejects.toThrow('MCP stdio');
      expect((await f.connection.close()).confirmed).toBe(true);
      const recorded = bodies(f.events);
      expect(recorded.find(event => event.phase === 'failed')).toMatchObject({ serverId: 'server-1', toolCallId: null });
      expect(recorded.find(event => event.phase === 'cleanup')).toMatchObject({ content: { evidence: { confirmed: true } } });
      expect(f.events.some(event => event.kind === 'tool_started' || event.kind === 'tool_finished')).toBe(false);
      expect((await f.record()).status).toBe('complete');
    } finally { await f.dispose(); }
  }, 20_000,
);

it.each([
  ['timeout', { callMode: 'hang' }, { callTimeoutMs: 150 }, 'call_timeout'],
  ['exit', { callMode: 'exit' }, {}, 'connection_closed'],
] as const)('[case:real-process-%s] persists one terminal call and correlated cleanup after a process fault', async (_name, options, extra, reason) => {
  const f = await fixture(options, extra);
  try {
    await f.connection.start();
    const catalog = await f.connection.createToolCatalog();
    await expect(catalog.tools[0]!.execute('fault-call', {})).rejects.toMatchObject({ reason });
    await f.connection.close();
    expect(f.events.filter(event => event.kind === 'tool_finished')).toHaveLength(1);
    expect(bodies(f.events).find(event => event.phase === 'cleanup')).toMatchObject({ toolCallId: null,
      content: { evidence: { confirmed: true } } });
    expect((await f.record()).status).toBe('complete');
  } finally { await f.dispose(); }
}, 20_000);

it('[case:real-process-cancel] correlates cancellation and does not accept a late server result twice', async () => {
  const f = await fixture({ callMode: 'hang' });
  try {
    await f.connection.start();
    const catalog = await f.connection.createToolCatalog();
    const abort = new AbortController();
    const pending = catalog.tools[0]!.execute('cancelled-call', {}, abort.signal);
    await waitForFakeMcpFile(join(f.source.path, 'call.entered'));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'call_cancelled' });
    await expect(catalog.tools[0]!.execute('cancelled-call', {})).rejects.toMatchObject({ reason: 'call_cancelled' });
    await f.connection.close();
    expect(f.events.filter(event => event.kind === 'tool_finished')).toHaveLength(1);
    expect((await f.record()).status).toBe('complete');
  } finally { await f.dispose(); }
}, 20_000);
