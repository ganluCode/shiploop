import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExecutionService } from '../../../packages/core/src/application/execution-service.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createFakeRuntime, createFakeRuntimeGate, fakeRuntimeCorrelationToken, type FakeRuntimeOptions } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { RuntimeError, type RuntimeAdapter } from '../../../packages/core/src/ports/runtime-execution.ts';
import { openEvidenceFixture, DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';

async function fixture(options: Partial<FakeRuntimeOptions> = {}, fault?: 'events-reject' | 'result-reject' | 'both-reject') {
  const f = await openBindingFixture({ secondTask: true });
  const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
  const lifecycle = createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW });
  const settlement = createRuntimeSettlementService({ lifecycle, publisher: f.publisher, attempts: createSqliteAttemptAccess(f.session),
    dag: createSqliteTaskDagStore(f.session), secrets: ['sensitive-test-value'] });
  const fake = createFakeRuntime({ script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'retained.txt', content: 'progress' }] },
    workspaceRoots: { 'workspace-root': f.box.root }, providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    adapterVersion: 'fake-1.0.0', nowUtcMs: () => BINDING_NOW, ...options });
  const adapter: RuntimeAdapter = { async start(request) {
    const handle = await fake.adapter.start(request);
    const result = fault === 'result-reject' || fault === 'both-reject'
      ? handle.result.then(() => { throw new RuntimeError('provider', 'stream_terminated'); }) : handle.result;
    if (fault === 'events-reject' || fault === 'both-reject') return { ...handle, result, events: { async *[Symbol.asyncIterator]() {
      for await (const event of handle.events) yield event;
      throw new RuntimeError('protocol', 'events_transport_failed');
    } } };
    return { ...handle, result };
  } };
  const configuration = createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]);
  const runtime = createRuntimeExecutionService({ configuration, registry: createStaticRuntimeRegistry([{ descriptor: fake.descriptor, adapter }], configuration) });
  const service = createExecutionService({ atomic: createSqliteAtomicCommandStore(f.session, { nowUtcMs: () => BINDING_NOW }),
    resources: f.createResources(), sessions, inputBinding: f.bindingService, runtime,
    dag: createSqliteTaskDagStore(f.session), attempts: createSqliteAttemptAccess(f.session),
    recorder: createWorkEvidenceRecorder({ publisher: f.publisher, verifier: f.verifier, sessions, limits: DEFAULT_RECORDER_LIMITS }),
    eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`, nowUtcMs: () => BINDING_NOW, settlement });
  const claim = f.claimTask('t-1');
  const start = () => service.start(f.bindingInput(claim));
  const input = async () => {
    const started = await start();
    const [result, recording, stopped] = await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
    return { request: started.context.request, result, recording, stopped };
  };
  return { ...f, sessions, lifecycle, settlement, service, claim, start, input };
}

function businessSnapshot(f: Pick<Awaited<ReturnType<typeof fixture>>, 'session'>) {
  return ['attempts', 'tasks', 'sessions', 'workspace_leases', 'execution_batches', 'runs', 'state_events', 'attempt_notifications']
    .map(table => f.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

const assertOccupied = (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(f.session.database.prepare('SELECT state FROM workspace_leases').all()).toHaveLength(3);
  expect(f.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 1, attempts_created: 1 });
};

describe('P03-6 F-009 Runtime fenced settlement', () => {
  it('[case:recovery-terminal-gaps] retains recovery source, watermark and gaps when stop is unobserved', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      const source = { schemaVersion: 1 as const, purpose: 'work' as const, kind: 'conversation' as const,
        sourceProjectId: f.projectId, sourceTaskId: input.request.identity.purpose === 'work' ? input.request.identity.taskId : '',
        sourceAttemptId: 'attempt-old', sourceSessionId: 'session-old', runtime: 'fake', provider: 'test-provider', model: 'fake-model',
        providerSessionId: 'native-sensitive-test-value', nativeArchiveRef: 'archive-old', sourceDigest: 'a'.repeat(64), nativeFormat: 'jsonl', nativeFormatVersion: '3' };
      const request = { ...input.request, recovery: { mode: 'required' as const, kind: 'conversation' as const, source } };
      const current = f.sessions.getWorkSession(f.projectId, request.sessionId);
      f.sessions.applyWorkSessionProgress({ projectId: f.projectId, sessionId: current.id, attemptId: f.claim.receipt.attempt.id,
        owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion,
        expectedRevision: current.revision, kind: 'activity', recordingGaps: ['recovery:source_watermark_unknown'] });
      const receipt = await f.settlement.settle({ ...input, request, stopped: null,
        result: input.result.status === 'fulfilled' ? { status: 'fulfilled', value: { ...input.result.value, providerSessionId: 'native-current' } } : input.result,
        recording: input.recording.status === 'fulfilled' ? { status: 'fulfilled', value: { ...input.recording.value, status: 'partial' } } : input.recording });
      expect(receipt).toMatchObject({ waitingFor: 'execution_uncertain', stopConfirmed: false });
      const session = f.sessions.getWorkSession(f.projectId, current.id);
      expect(session).toMatchObject({ status: 'ended', recordingWatermark: current.recordingWatermark, providerSessionId: 'native-current' });
      expect(session.recordingGaps).toEqual(expect.arrayContaining(['recovery:source_watermark_unknown', 'recording_required', 'stop_unconfirmed']));
      const bytes = await f.verifier.readVerifiedContent(f.projectId, session.resultRef!);
      expect(JSON.parse(Buffer.from(bytes.content).toString('utf8'))).toMatchObject({ recovery: {
        source: { ...source, providerSessionId: 'native-[REDACTED]' }, sourceWatermark: null, decision: null, coverage: 'unknown', historicalUsage: 'excluded_unknown_scope' } });
      expect(Buffer.from(bytes.content).toString('utf8')).not.toContain('sensitive-test-value');
    } finally { f.close(); }
  });

  it('[case:recovery-start-rejected] records known source and model rejection without treating old success as a new result', async () => {
    const f = await fixture();
    try {
      const started = await f.start();
      await Promise.all([started.context.result, started.context.recording, started.context.stopped]);
      const source = { schemaVersion: 1 as const, purpose: 'work' as const, kind: 'conversation' as const,
        sourceProjectId: f.projectId, sourceTaskId: 't-1', sourceAttemptId: 'attempt-old', sourceSessionId: 'session-old',
        runtime: 'fake', provider: 'test-provider', model: 'fake-model', providerSessionId: 'native-old', nativeArchiveRef: 'archive-old',
        sourceDigest: 'a'.repeat(64), nativeFormat: 'jsonl', nativeFormatVersion: '3' };
      const request = { ...started.context.request, recovery: { mode: 'required' as const, kind: 'conversation' as const, source } };
      await f.settlement.settle({ request, result: { status: 'rejected', reason: new RuntimeError('configuration', 'actual_model_configuration_mismatch') },
        recording: null, stopped: null });
      const session = f.sessions.getWorkSession(f.projectId, request.sessionId);
      expect(session.status).toBe('ended');
      const bytes = await f.verifier.readVerifiedContent(f.projectId, session.resultRef!);
      expect(JSON.parse(Buffer.from(bytes.content).toString('utf8'))).toMatchObject({
        execution: { result: null, failure: { kind: 'configuration', reason: 'actual_model_configuration_mismatch' } },
        recovery: { source, actualModel: null, sourceWatermark: null, coverage: 'unknown' },
        recording: { complete: false }, stop: { evidence: null } });
      expect(f.query('SELECT status FROM attempts WHERE id = ?', f.claim.receipt.attempt.id)).not.toEqual({ status: 'completed' });
    } finally { f.close(); }
  });

  it('persists separate execution/recording/stop facts, pauses for verification, and replays after SQLite reopen', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      const receipt = await f.settlement.settle(input);
      expect(receipt).toMatchObject({ disposition: 'applied', status: 'verifying', waitingFor: 'verification_not_assembled', stopConfirmed: true });
      const session = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!;
      expect(session).toMatchObject({ status: 'stopped', executionStage: 'verification' });
      expect(session.resultRef).toBeTruthy();
      expect(f.query('SELECT status, reason FROM runs')).toEqual({ status: 'paused', reason: 'verification_not_assembled' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
      expect(f.query('SELECT status FROM features')).not.toEqual({ status: 'completed' });
      assertOccupied(f);
      expect(readFileSync(join(f.box.repoDirA, 'retained.txt'), 'utf8')).toBe('progress');
      const before = businessSnapshot(f);
      f.session.close();
      const reopened = openSqliteStorageSession({ path: f.session.path });
      try {
        const store = createSqliteWorkSessionStore(reopened);
        expect(store.getWorkSession(f.projectId, session.id)).toEqual(session);
        const verifier = createArtifactVerifier({ artifacts: createSqliteArtifactStore(reopened),
          files: createArtifactFileStore({ dataRoot: f.box.dataRoot }), limits: { maxReadBytes: 4_000_000 } });
        const evidence = await verifier.readVerifiedContent(f.projectId, session.resultRef!);
        expect(JSON.parse(Buffer.from(evidence.content).toString('utf8'))).toMatchObject({
          execution: { result: { terminal: 'completed' }, failure: null },
          recording: { complete: true, manifestRef: expect.any(String) }, stop: { evidence: { confirmed: true }, failure: null },
        });
        const service = createRuntimeSettlementService({ publisher: f.publisher,
          lifecycle: createSqliteAttemptLifecycleStore(reopened, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }),
          attempts: createSqliteAttemptAccess(reopened), dag: createSqliteTaskDagStore(reopened) });
        expect(await service.settle(input)).toEqual({ ...receipt, disposition: 'replayed' });
        expect(businessSnapshot({ session: reopened })).toEqual(before);
      } finally { reopened.close(); }
    } finally { f.close(); }
  });

  it('settles completed execution while stopped remains genuinely pending', async () => {
    const gate = createFakeRuntimeGate();
    const f = await fixture({ script: { schemaVersion: 1, steps: [], lifecycle: { stopped: { gate: 'stop' } } }, gates: { stop: gate } });
    try {
      const { context } = await f.start();
      let stopObserved = false;
      const observed = context.stopped.then(() => { stopObserved = true; });
      const [result, recording] = await Promise.all([context.result, context.recording]);
      expect(stopObserved).toBe(false);
      expect(await f.settlement.settle({ request: context.request, result, recording, stopped: null }))
        .toMatchObject({ status: 'verifying', waitingFor: 'execution_uncertain', resultSaved: true, stopConfirmed: false });
      expect(stopObserved).toBe(false);
      expect(f.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
      gate.release();
      await observed;
      assertOccupied(f);
    } finally { gate.release(); f.close(); }
  });

  it.each([false, null])('saves completed result when stopped is %s and keeps occupancy quarantined', async stopped => {
    const f = await fixture({ script: { schemaVersion: 1, steps: [], lifecycle: { stopped: { unconfirmed: true } } } });
    try {
      const input = await f.input();
      const receipt = await f.settlement.settle({ ...input, stopped: stopped === null ? null : input.stopped });
      expect(receipt).toMatchObject({ waitingFor: 'execution_uncertain', stopConfirmed: false, resultSaved: true });
      expect(f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)).toMatchObject({ status: 'ended', resultRef: expect.any(String) });
      expect(f.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
      assertOccupied(f);
    } finally { f.close(); }
  });

  it.each(['owner', 'host', 'version', 'terminal'])('isolates late %s notifications before publishing or changing business facts', async stale => {
    const f = await fixture();
    try {
      const input = await f.input();
      if (stale === 'terminal') f.session.database.prepare("UPDATE attempts SET status = 'interrupted'").run();
      if (stale === 'version') f.session.database.prepare('UPDATE tasks SET execution_version = execution_version + 1').run();
      if (stale === 'owner' || stale === 'host') input.request = { ...input.request, owner: { ...input.request.owner,
        ...(stale === 'owner' ? { principalId: 'stale-owner' } : { hostInstanceId: 'stale-host' }) } };
      const before = businessSnapshot(f);
      const artifacts = f.query('SELECT count(*) AS n FROM artifacts');
      for (let i = 0; i < 40; i++) expect(await f.settlement.settle(input)).toMatchObject({ disposition: 'ignored' });
      expect(businessSnapshot(f)).toEqual(before);
      expect(f.query('SELECT count(*) AS n FROM artifacts')).toEqual(artifacts);
      expect(JSON.stringify(f.session.database.prepare('SELECT * FROM attempt_notification_diagnostics').all())).not.toContain('stale-owner');
    } finally { f.close(); }
  });

  it.each(['block-first', 'result-first'])('does not override manual approval or allow a successor (%s)', async order => {
    const f = await fixture();
    try {
      const input = await f.input();
      const block = () => f.session.database.prepare('UPDATE tasks SET manual_block = 1 WHERE id = ?').run('t-1');
      if (order === 'block-first') block();
      expect(await f.settlement.settle(input)).toMatchObject({ waitingFor: order === 'block-first' ? 'approval' : 'verification_not_assembled' });
      if (order === 'result-first') block();
      expect(f.query('SELECT manual_block, status FROM tasks WHERE id = ?', 't-1')).toEqual({ manual_block: 1, status: 'running' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
      assertOccupied(f);
    } finally { f.close(); }
  });

  it('rolls back Session, Attempt, pause, resource and event changes on COMMIT failure, then retries without starting Runtime', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      const before = businessSnapshot(f);
      f.session.database.exec(`CREATE TABLE settlement_commit_probe (id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TEMP TRIGGER fail_settlement AFTER INSERT ON attempt_notifications BEGIN INSERT INTO settlement_commit_probe VALUES ('missing-project'); END;`);
      await expect(f.settlement.settle(input)).rejects.toThrow();
      expect(businessSnapshot(f)).toEqual(before);
      f.session.database.exec('DROP TRIGGER fail_settlement');
      expect(await f.settlement.settle(input)).toMatchObject({ disposition: 'applied' });
      assertOccupied(f);
    } finally { f.close(); }
  });

  it('keeps completed execution separate from missing required recording', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      input.recording = { status: 'rejected', reason: new Error('sensitive-test-value') };
      expect(await f.settlement.settle(input)).toMatchObject({ status: 'verifying', waitingFor: 'recording_required', runtimeCompleted: true });
      assertOccupied(f);
    } finally { f.close(); }
  });

  it('persists startup failure without losing the original Runtime error or Runtime-start debit', async () => {
    const f = await fixture({ startFailure: { kind: 'authentication', reason: 'credentials_unavailable' } });
    try {
      writeFileSync(join(f.box.repoDirA, 'untracked-progress.txt'), 'keep me');
      await expect(f.start()).rejects.toMatchObject({ kind: 'authentication', reason: 'credentials_unavailable' });
      expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'failed', error_kind: 'authentication' });
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'paused' });
      expect(readFileSync(join(f.box.repoDirA, 'untracked-progress.txt'), 'utf8')).toBe('keep me');
      assertOccupied(f);
    } finally { f.close(); }
  });

  it.each(['owner', 'host', 'version', 'terminal', 'midstream-version'])('fences %s event recording before publishing or advancing Session watermarks', async stale => {
    const f = await openEvidenceFixture({ script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'sensitive-test-value' }] } });
    try {
      const db = f.budget.session.database;
      let request = f.request;
      let handle = f.handle;
      const bump = () => db.prepare('UPDATE tasks SET execution_version = execution_version + 1').run();
      if (stale === 'version') bump();
      if (stale === 'terminal') db.prepare("UPDATE attempts SET status = 'interrupted'").run();
      if (stale === 'owner' || stale === 'host') request = { ...request, owner: { ...request.owner,
        ...(stale === 'owner' ? { principalId: 'stale-owner' } : { hostInstanceId: 'stale-host' }) } };
      if (stale === 'midstream-version') handle = { ...f.handle, events: { async *[Symbol.asyncIterator]() {
        for await (const event of f.handle.events) { yield event; bump(); }
      } } };
      const before = f.sessions.getWorkSession(f.projectId, f.sessionId);
      const artifacts = f.query('SELECT count(*) AS n FROM artifacts');
      await expect(f.recorder.record({ request, handle, eventIdentityPrefix: f.eventIdentityPrefix }))
        .rejects.toMatchObject({ reason: 'stale_execution_identity' });
      expect(f.sessions.getWorkSession(f.projectId, f.sessionId)).toEqual(before);
      expect(f.query('SELECT count(*) AS n FROM artifacts')).toEqual(artifacts);
      expect(f.query('SELECT count(*) AS n FROM attempt_notification_diagnostics')).toEqual({ n: 1 });
      expect(JSON.stringify(db.prepare('SELECT * FROM attempt_notification_diagnostics').all())).not.toContain('sensitive-test-value');
    } finally { f.close(); }
  });

  it('rechecks manual approval inside the final transaction after evidence publication', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      const service = createRuntimeSettlementService({ ...f, attempts: createSqliteAttemptAccess(f.session), dag: createSqliteTaskDagStore(f.session),
        publisher: { async publishArtifact(body) {
          const result = await f.publisher.publishArtifact(body);
          f.session.database.prepare('UPDATE tasks SET manual_block = 1 WHERE id = ?').run('t-1');
          return result;
        } } });
      expect(await service.settle(input)).toMatchObject({ waitingFor: 'approval' });
      expect(f.query('SELECT reason FROM runs')).toEqual({ reason: 'approval' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
    } finally { f.close(); }
  });

  it('preserves the original Runtime failure when event recording also fails', async () => {
    const f = await fixture({}, 'both-reject');
    try {
      const input = await f.input();
      expect(input.result.status).toBe('rejected');
      expect(input.recording.status).toBe('rejected');
      expect(await f.settlement.settle(input)).toMatchObject({ status: 'failed' });
      expect(f.query('SELECT error_kind FROM attempts')).toEqual({ error_kind: 'provider' });
      const ref = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!.resultRef!;
      const evidence = await f.verifier.readVerifiedContent(f.projectId, ref);
      expect(JSON.parse(Buffer.from(evidence.content).toString('utf8'))).toMatchObject({
        execution: { result: null, failure: { kind: 'provider', reason: 'stream_terminated' } },
        recording: { failure: 'event_stream_failed' },
      });
    } finally { f.close(); }
  });

  it('persists reported usage without replacing unknown metrics with zero', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      if (input.result.status !== 'fulfilled') throw new Error('missing result');
      input.result = { status: 'fulfilled', value: { ...input.result.value,
        usage: { basis: 'reported', inputTokens: 7, outputTokens: null, costUsdMicros: 125 } } };
      expect(await f.settlement.settle(input)).toMatchObject({ status: 'verifying' });
      expect(createSqliteAttemptAccess(f.session).getAttempt(f.projectId, f.claim.receipt.attempt.id).usageSummary)
        .toEqual({ schemaVersion: 1, inputTokens: 7, outputTokens: null, costMicros: 125, currency: 'USD' });
    } finally { f.close(); }
  });

  it.each(['result-reject', 'unknown-terminal', 'events-reject', 'process-exit'])('records %s as failure, retaining known metrics without synthetic success', async fault => {
    const f = await fixture(fault === 'unknown-terminal' ? { script: { schemaVersion: 1, steps: [], lifecycle: { result: { terminalOverride: 'unrecognized' } } } }
      : fault === 'process-exit' ? { script: { schemaVersion: 1, steps: [], result: {
        terminal: 'failed', reason: 'process_exit', exitCode: 23, signal: null, durationMs: 19,
        usage: { inputTokens: 7, outputTokens: null, costUsdMicros: null } } } } : {},
      fault === 'events-reject' || fault === 'result-reject' ? fault : undefined);
    try {
      const input = await f.input();
      const receipt = await f.settlement.settle(input);
      expect(receipt).toMatchObject({ status: 'failed', resultSaved: true });
      if (fault === 'process-exit') {
        expect(f.query('SELECT exit_code, duration_ms FROM attempts')).toEqual({ exit_code: 23, duration_ms: 19 });
        expect(createSqliteAttemptAccess(f.session).getAttempt(f.projectId, f.claim.receipt.attempt.id).usageSummary).toBeNull();
        const ref = f.sessions.getAttemptWorkSession(f.projectId, f.claim.receipt.attempt.id)!.resultRef!;
        const evidence = await f.verifier.readVerifiedContent(f.projectId, ref);
        expect(JSON.parse(Buffer.from(evidence.content).toString('utf8')).execution.result.usage)
          .toEqual({ basis: 'synthetic', inputTokens: 7, outputTokens: null, costUsdMicros: null });
      }
      if (fault === 'unknown-terminal') expect(f.query('SELECT error_kind FROM attempts')).toEqual({ error_kind: 'protocol' });
      if (fault === 'result-reject') expect(f.query('SELECT error_kind FROM attempts')).toEqual({ error_kind: 'provider' });
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'paused' });
      assertOccupied(f);
    } finally { f.close(); }
  });
});
