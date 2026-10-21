import { expect, it } from 'vitest';
import { createWorkEvidenceRecorder, WorkEvidenceRecordingError, type RecordingMode, type WorkEvidenceRecorderDeps } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { openBindingFixture, BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { superviseExecution } from '../../../packages/core/src/application/execution-supervision.ts';
import type { RuntimeSession } from '../../../packages/core/src/application/runtime-execution.ts';
import { validateRuntimeExecutionResult, validateRuntimeStopEvidence } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';

async function fixture(mode: RecordingMode = 'required') {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const launch = f.claimAndLaunch('t-1');
    const { request } = await f.bindingService.bind(f.bindingInput(launch));
    const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
    const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: launch.receipt.attempt.id,
      owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
    const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'test-v1' });
    sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
    const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
    const bodyPublisher = createWorkRecordingPublisher({ artifacts: f.publisher, limits: {
      maxBodyBytes: 65_536, maxAttachmentBytes: 65_536, maxTotalBytes: 131_072, maxChunkBytes: 8192, maxQueueBytes: 8192,
    } });
    const makeRecorder = (overrides: Partial<WorkEvidenceRecorderDeps> = {}) => createWorkEvidenceRecorder({
      publisher: f.publisher, verifier: f.verifier, sessions, recordingMode: mode,
      limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 2, tailWaitMs: 200 },
      recording: { publisher: bodyPublisher, store, nowUtcMs: () => NOW }, ...overrides });
    const recorder = makeRecorder();
    const event = (sequence: number, kind: string, payload: object) => ({ schemaVersion: 1, eventId: `evt.test.${sequence}`,
      sequence, kind, occurredAtUtc: new Date(NOW).toISOString(), payload });
    const result = (lastEventSequence: number) => ({ schemaVersion: 1, terminal: 'completed', reason: null,
      exitCode: null, signal: null, durationMs: null, usage: null, lastEventSequence });
    let cancels = 0;
    const handle = (events: unknown[], last = events.length): RuntimeHandle => ({
      events: { async *[Symbol.asyncIterator]() { yield* events; } }, result: Promise.resolve(result(last)),
      stopped: Promise.resolve({ schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(NOW).toISOString(), detail: null }),
      async cancel() { cancels++; return { accepted: true, reason: null }; },
    });
    return { ...f, request, sessions, store, bodyPublisher, recorder, makeRecorder, event, result, handle, cancels: () => cancels };
  } catch (error) { f.close(); throw error; }
}

it('[case:event-result-projection] persists public bodies, tool phases and terminal facts without passing the Task', async () => {
  const f = await fixture();
  try {
    const before = f.query('SELECT status FROM tasks WHERE id = ?', 't-1');
    const events = [f.event(1, 'message', { messageId: 'user-1', role: 'user', preview: '问题' }),
      f.event(2, 'tool_started', { toolCallId: 'call-1', toolName: 'read', parentToolCallId: 'parent-1', input: '公开输入' }),
      f.event(3, 'tool_finished', { toolCallId: 'call-1', exitCode: 0, signal: null, parentToolCallId: 'parent-1', output: '公开输出' }),
      f.event(4, 'message', { messageId: 'answer-1', role: 'assistant', preview: '最终输出', text: '完整公开正文' })];
    const outcome = await f.recorder.record({ request: f.request, handle: f.handle(events), eventIdentityPrefix: 'evt.test.' });
    expect(outcome).toMatchObject({ status: 'complete', watermark: 4 });
    const rows = f.session.database.prepare('SELECT sequence, kind, role, content_ref FROM session_messages ORDER BY sequence').all() as Record<string, unknown>[];
    expect(rows.map(row => [row.sequence, row.kind, row.role])).toEqual([
      [1, 'message', 'user'], [2, 'tool_started', 'tool'], [3, 'tool_finished', 'tool'], [4, 'message', 'assistant'],
    ]);
    for (const row of rows) expect((await f.verifier.verifyArtifact(f.projectId, row.content_ref as string)).kind).toBe('verified_ready');
    expect(f.query('SELECT parent_tool_call_id, tool_call_id FROM session_messages WHERE sequence = 2')).toEqual({ parent_tool_call_id: 'parent-1', tool_call_id: 'call-1' });
    const answer = await f.verifier.readVerifiedContent(f.projectId, rows[3].content_ref as string);
    expect(JSON.parse(Buffer.from(answer.content).toString())).toMatchObject({ text: '完整公开正文' });
    const manifest = f.store.getLatestManifest(f.projectId, f.request.sessionId);
    expect(manifest).toMatchObject({ coverage: 'complete', watermark: 4, finalSequence: 4, finalized: true });
    const body = await f.verifier.readVerifiedContent(f.projectId, manifest!.manifestRef!.artifactId);
    expect(JSON.parse(Buffer.from(body.content).toString())).toMatchObject({ result: { terminal: 'completed' }, stop: { evidence: { confirmed: true } } });
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual(before);
    expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
  } finally { f.close(); }
});

it('[case:bounded-backpressure] stops pulling at the bounded batch while publication waits, then flushes before watermark', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const publicationEntered = new Promise<void>(resolve => { entered = resolve; });
  try {
    const publish = f.bodyPublisher.publishBody.bind(f.bodyPublisher);
    f.bodyPublisher.publishBody = async input => { entered(); await gate; return publish(input); };
    let pulled = 0;
    const handle = f.handle([]);
    const recording = f.recorder.record({ request: f.request, eventIdentityPrefix: 'evt.test.', handle: {
      ...handle, result: Promise.resolve(f.result(20)), events: { async *[Symbol.asyncIterator]() {
        for (let i = 1; i <= 20; i++) { pulled++; yield f.event(i, 'message', { messageId: `m-${i}`, role: 'assistant', preview: 'output' }); }
      } },
    } });
    await publicationEntered;
    expect(pulled).toBe(2);
    expect(f.sessions.getWorkSession(f.projectId, f.request.sessionId).recordingWatermark).toBeNull();
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
    release();
    expect(await recording).toMatchObject({ status: 'complete', watermark: 20 });
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 20 });
  } finally { release(); f.close(); }
});

for (const mode of ['required', 'best_effort'] as const) {
  it(`[case:${mode}-publication-failure] retains durable evidence and settles recording policy independently of Runtime completion`, async () => {
    const f = await fixture(mode);
    try {
      let writes = 0;
      const publish = f.bodyPublisher.publishBody.bind(f.bodyPublisher);
      f.bodyPublisher.publishBody = async input => ++writes > 2 ? {
        status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0,
        truncated: false, redacted: false, gapReasons: ['publication_file_error'],
      } : publish(input);
      const events = Array.from({ length: 4 }, (_, i) => f.event(i + 1, 'message', { messageId: `m-${i}`, role: 'assistant', preview: 'durable' }));
      const handle = f.handle(events);
      const recording = await Promise.allSettled([f.recorder.record({ request: f.request, handle, eventIdentityPrefix: 'evt.test.' })]);
      if (mode === 'required') {
        expect(recording[0]).toMatchObject({ status: 'rejected', reason: { name: 'WorkEvidenceRecordingError', safeStopRequired: true } });
        expect(f.cancels()).toBe(1);
      } else {
        expect(recording[0]).toMatchObject({ status: 'fulfilled', value: { status: 'partial', recordingMode: 'best_effort', watermark: 2 } });
        expect(f.cancels()).toBe(0);
      }
      expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 2 });
      expect(f.sessions.getWorkSession(f.projectId, f.request.sessionId).recordingWatermark).toBe(2);
      const manifest = f.store.getLatestManifest(f.projectId, f.request.sessionId)!;
      expect(manifest).toMatchObject({ watermark: 2, coverage: mode === 'required' ? 'failed' : 'partial', finalized: true });
      expect(manifest.missingReasons).toContain('publication_file_error');
      const settlement = createRuntimeSettlementService({ publisher: f.publisher,
        lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }),
        attempts: createSqliteAttemptAccess(f.session), dag: createSqliteTaskDagStore(f.session) });
      const receipt = await settlement.settle({ request: f.request, result: { status: 'fulfilled', value: validateRuntimeExecutionResult(await handle.result) },
        stopped: { status: 'fulfilled', value: validateRuntimeStopEvidence(await handle.stopped) }, recording: recording[0] });
      expect(receipt).toMatchObject({ status: 'verifying', runtimeCompleted: true, stopConfirmed: true,
        waitingFor: mode === 'required' ? 'recording_required' : 'verification_not_assembled' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-1')).toEqual({ status: 'running' });
      expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
    } finally { f.close(); }
  });
}

it('[case:best-effort-drain] drains a bounded producer after body storage fails so result can settle', async () => {
  const f = await fixture('best_effort');
  try {
    f.bodyPublisher.publishBody = async () => ({ status: 'unavailable', ref: null, observedBytes: 0, retainedBytes: 0,
      truncated: false, redacted: false, gapReasons: ['publication_file_error'] });
    let finish!: (result: unknown) => void;
    const result = new Promise<unknown>(resolve => { finish = resolve; });
    let pulled = 0;
    const handle = { ...f.handle([]), result, events: { async *[Symbol.asyncIterator]() {
      for (let sequence = 1; sequence <= 8; sequence++) { pulled++; yield f.event(sequence, 'message', { messageId: `m-${sequence}`, role: 'user', preview: 'input' }); }
      finish(f.result(8));
    } } };
    const outcome = await f.recorder.record({ request: f.request, handle, eventIdentityPrefix: 'evt.test.' });
    expect(outcome).toMatchObject({ status: 'partial', result: { terminal: 'completed' } });
    expect(pulled).toBe(8);
    expect(f.cancels()).toBe(0);
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ coverage: 'partial', watermark: null, finalized: true });
  } finally { f.close(); }
});

it('[case:required-sequence-gap] stops on an unfilled sequence gap while preserving only the published indexes', async () => {
  const f = await fixture();
  try {
    const events = [f.event(1, 'message', { messageId: 'm-1', role: 'user', preview: 'input' }),
      f.event(3, 'message', { messageId: 'm-3', role: 'assistant', preview: 'output' })];
    await expect(f.recorder.record({ request: f.request, handle: f.handle(events, 3), eventIdentityPrefix: 'evt.test.' }))
      .rejects.toBeInstanceOf(WorkEvidenceRecordingError);
    expect(f.cancels()).toBe(1);
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ coverage: 'failed', watermark: 3,
      missingReasons: expect.arrayContaining(['sequence_gap', 'missing_sequences:2']) });
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 2 });
  } finally { f.close(); }
});

it('[case:stop-observation-independent] keeps a completed result separate from an unconfirmed stop', async () => {
  const f = await fixture();
  try {
    const handle = f.handle([f.event(1, 'diagnostic', { code: 'provider.failure', message: '公开错误' })]);
    const outcome = await f.recorder.record({ request: f.request, eventIdentityPrefix: 'evt.test.', handle: {
      ...handle, stopped: Promise.resolve({ schemaVersion: 1, confirmed: false, checkedAtUtc: new Date(NOW).toISOString(), detail: 'still_running' }),
    } });
    expect(outcome.status).toBe('complete');
    const body = await f.verifier.readVerifiedContent(f.projectId, outcome.manifestArtifactId);
    expect(JSON.parse(Buffer.from(body.content).toString())).toMatchObject({ result: { terminal: 'completed' }, stop: { evidence: { confirmed: false } } });
    expect(f.query('SELECT kind, role FROM session_messages')).toEqual({ kind: 'error', role: 'error' });
    expect(f.sessions.getWorkSession(f.projectId, f.request.sessionId).status).toBe('started');
  } finally { f.close(); }
});

it('[case:stop-tail-bound] closes a missing stopped fact within the finite tail budget and stops required execution', async () => {
  const f = await fixture();
  try {
    const recorder = f.makeRecorder({ limits: { ...DEFAULT_RECORDER_LIMITS, tailWaitMs: 10 } });
    const handle = { ...f.handle([]), stopped: new Promise<never>(() => undefined) };
    await expect(recorder.record({ request: f.request, handle, eventIdentityPrefix: 'evt.test.' })).rejects.toMatchObject({ safeStopRequired: true });
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ finalized: true, coverage: 'failed',
      missingReasons: expect.arrayContaining(['stop_evidence_unavailable']) });
  } finally { f.close(); }
});

it('[case:best-effort-supervision] does not cancel or quarantine solely for partial best_effort recording', async () => {
  const f = await fixture('best_effort');
  try {
    const handle = f.handle([f.event(1, 'unknown_public_kind', {})]);
    const [recording] = await Promise.allSettled([f.recorder.record({ request: f.request, handle, eventIdentityPrefix: 'evt.test.' })]);
    expect(recording).toMatchObject({ status: 'fulfilled', value: { status: 'partial' } });
    const settlement = createRuntimeSettlementService({ publisher: f.publisher,
      lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }),
      attempts: createSqliteAttemptAccess(f.session), dag: createSqliteTaskDagStore(f.session) });
    let cancelled = false;
    let quarantined = false;
    const controller = new AbortController();
    const runtime = { async cancel() { cancelled = true; return { schemaVersion: 1, accepted: true, reason: null }; } } as unknown as RuntimeSession;
    const supervision = superviseExecution({ request: f.request, runtime, controller,
      result: Promise.resolve({ status: 'fulfilled', value: validateRuntimeExecutionResult(await handle.result) }),
      stopped: Promise.resolve({ status: 'fulfilled', value: validateRuntimeStopEvidence(await handle.stopped) }),
      recording: Promise.resolve(recording), options: { stopWaitMs: 100, drainWaitMs: 100, closeWaitMs: 100, async retain() {} },
      settlement: { async settle(input) { expect(input.control).toBeUndefined(); return settlement.settle(input); } },
      quarantine() { quarantined = true; }, evidenceRef: () => null,
      timeoutMs: 1000, timeoutReason: 'runtime_timeout', timeoutLayer: 'session', timeoutLimitMs: 1000 });
    expect(await supervision.completion).toMatchObject({ stopConfirmed: true, persisted: true, retained: false, error: null });
    expect(cancelled).toBe(false);
    expect(quarantined).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  } finally { f.close(); }
});

it('[case:manifest-storage-unavailable] closes partial index metadata even when no manifest Artifact can be published', async () => {
  const f = await fixture('best_effort');
  try {
    const recorder = f.makeRecorder({ publisher: { async publishArtifact() { throw new Error('ENOSPC'); } } });
    const handle = f.handle([f.event(1, 'message', { messageId: 'm-1', role: 'assistant', preview: 'retained' })]);
    await expect(recorder.record({ request: f.request, handle, eventIdentityPrefix: 'evt.test.' })).rejects.toMatchObject({
      recordingMode: 'best_effort', safeStopRequired: false, manifestArtifactId: null,
    });
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ finalized: true, coverage: 'partial', manifestRef: null, watermark: null });
    expect(f.cancels()).toBe(0);
    expect(f.query("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'message' AND status = 'ready'" )).toEqual({ n: 1 });
  } finally { f.close(); }
});

it('[case:terminal-behind-durable] preserves producer terminal mismatch without regressing durable indexes', async () => {
  const f = await fixture();
  try {
    const events = [1, 2].map(sequence => f.event(sequence, 'message', { messageId: `m-${sequence}`, role: 'assistant', preview: 'retained' }));
    await expect(f.recorder.record({ request: f.request, handle: f.handle(events, 1), eventIdentityPrefix: 'evt.test.' })).rejects.toMatchObject({ safeStopRequired: true });
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ coverage: 'failed', watermark: 2, finalSequence: null, finalized: true });
    expect(f.sessions.getWorkSession(f.projectId, f.request.sessionId).recordingWatermark).toBe(2);
  } finally { f.close(); }
});

it('[case:empty-terminal] reconciles a known empty stream without inventing an event', async () => {
  const f = await fixture();
  try {
    expect(await f.recorder.record({ request: f.request, handle: f.handle([]), eventIdentityPrefix: 'evt.test.' })).toMatchObject({ status: 'complete', watermark: 0 });
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ coverage: 'complete', watermark: 0, finalSequence: 0, sequenceReconciliation: 'match', finalized: true });
    expect(f.query('SELECT COUNT(*) AS n FROM session_messages')).toEqual({ n: 0 });
  } finally { f.close(); }
});

it('[case:body-redaction] redacts full public text before body hashing and index admission', async () => {
  const f = await fixture();
  try {
    const recorder = f.makeRecorder({ secrets: ['private-value'] });
    const outcome = await recorder.record({ request: f.request, eventIdentityPrefix: 'evt.test.', handle: f.handle([
      f.event(1, 'message', { messageId: 'm-1', role: 'assistant', preview: 'private-value', text: '完整 private-value 正文' }),
    ]) });
    expect(outcome.status).toBe('complete');
    const row = f.query('SELECT content_ref FROM session_messages') as { content_ref: string };
    const bytes = await f.verifier.readVerifiedContent(f.projectId, row.content_ref);
    expect(Buffer.from(bytes.content).toString()).toContain('[REDACTED]');
    expect(Buffer.from(bytes.content).toString()).not.toContain('private-value');
    expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)?.redaction.applied).toBe(true);
    expect(f.query('SELECT redacted FROM session_messages')).toEqual({ redacted: 1 });
  } finally { f.close(); }
});
