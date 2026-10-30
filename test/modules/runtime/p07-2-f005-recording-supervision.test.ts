import { describe, expect, it } from 'vitest';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createWorkRecordingPublisher } from '../../../packages/core/src/application/work-recording-publish.ts';
import { createSqliteWorkRecordingStore } from '../../../packages/core/src/adapters/sqlite/work-recording-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { ArtifactPublishError } from '../../../packages/core/src/application/artifact-publish.ts';
import type { RuntimeSettlementInput } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { observeWithin, superviseExecution } from '../../../packages/core/src/application/execution-supervision.ts';
import { openBindingFixture, BINDING_NOW as NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { validateRuntimeExecutionResult, validateRuntimeStopEvidence, RuntimeError } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { RuntimeSession } from '../../../packages/core/src/application/runtime-execution.ts';
import type { RecordingMode, WorkEvidenceRecorderDeps, WorkEvidenceRecordingOutcome } from '../../../packages/core/src/application/work-evidence-recorder.ts';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const completed = validateRuntimeExecutionResult({ schemaVersion: 1, terminal: 'completed', reason: null,
  exitCode: 0, signal: null, durationMs: 10, usage: null, lastEventSequence: 0 });
const stopped = validateRuntimeStopEvidence({ schemaVersion: 1, confirmed: true,
  checkedAtUtc: new Date(NOW).toISOString(), detail: null });
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ status: 'fulfilled' as const, value }),
  reason => ({ status: 'rejected' as const, reason }));

async function fixture(mode: RecordingMode = 'required') {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  const launch = f.claimAndLaunch('t-1');
  const bound = await f.bindingService.bind(f.bindingInput(launch));
  const request = { ...bound.request, limits: { ...bound.request.limits, timeoutMs: 1000 } };
  const sessions = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => NOW });
  const identity = { projectId: f.projectId, sessionId: request.sessionId, attemptId: launch.receipt.attempt.id,
    owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion };
  const created = sessions.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'f005' });
  sessions.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });
  const store = createSqliteWorkRecordingStore(f.session, { nowUtcMs: () => NOW });
  const bodyPublisher = createWorkRecordingPublisher({ artifacts: f.publisher, limits: {
    maxBodyBytes: 65_536, maxAttachmentBytes: 65_536, maxTotalBytes: 131_072, maxChunkBytes: 8192, maxQueueBytes: 8192,
  } });
  const recorder = (overrides: Partial<WorkEvidenceRecorderDeps> = {}) => createWorkEvidenceRecorder({
    publisher: f.publisher, verifier: f.verifier, sessions, recordingMode: mode,
    limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 1, tailWaitMs: 20 },
    recording: { publisher: bodyPublisher, store, nowUtcMs: () => NOW }, ...overrides });
  let cancels = 0;
  const handle = (events: RuntimeHandle['events'], result = Promise.resolve(completed)): RuntimeHandle => ({
    events, result, stopped: Promise.resolve(stopped), async cancel() { cancels++; return { accepted: true, reason: null }; },
  });
  const event = (sequence: number) => ({ schemaVersion: 1, eventId: `evt.f005.${sequence}`, sequence,
    kind: 'message', occurredAtUtc: new Date(NOW).toISOString(), payload: { messageId: `m-${sequence}`, role: 'assistant', preview: 'kept' } });
  const settlement = createRuntimeSettlementService({ publisher: f.publisher, sessions,
    lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW }),
    attempts: createSqliteAttemptAccess(f.session), dag: createSqliteTaskDagStore(f.session) });
  return { ...f, request, identity, sessions, store, bodyPublisher, recorder, handle, event, settlement, cancels: () => cancels };
}

describe('P07-2 F-005 整体期限与监督结算', () => {
  for (const scenario of ['both-hang', 'small-events', 'body-hang', 'manifest-hang'] as const) {
    it(`[case:deadline-${scenario}] 采集与发布共用整体期限，失败收尾有界且迟到发布不推进水位`, async () => {
      const f = await fixture();
      const blocked = gate<never>();
      const release = gate<void>();
      const controller = new AbortController();
      let pulls = 0;
      let publicationSignal: AbortSignal | undefined;
      let recording: Promise<PromiseSettledResult<WorkEvidenceRecordingOutcome>> | undefined;
      try {
        const publisher = { async publishArtifact(input: unknown) {
          const value = input as { kind: string; signal?: AbortSignal };
          if (scenario === 'manifest-hang' && value.kind === 'work-evidence-manifest') {
            publicationSignal = value.signal;
            await release.promise;
          }
          return f.publisher.publishArtifact(input);
        } };
        if (scenario === 'body-hang') {
          const original = f.bodyPublisher.publishBody.bind(f.bodyPublisher);
          f.bodyPublisher.publishBody = async input => { publicationSignal = input.signal; await release.promise; return original(input); };
        }
        const events = { async *[Symbol.asyncIterator]() {
          if (scenario === 'both-hang') { await blocked.promise; return; }
          if (scenario === 'manifest-hang') return;
          do { pulls++; yield f.event(pulls); } while (scenario === 'small-events');
        } };
        const runtime = f.handle(events, scenario === 'manifest-hang' ? Promise.resolve(completed) : blocked.promise);
        const start = performance.now();
        recording = settle(f.recorder({ publisher }).record({ request: f.request, handle: runtime,
          eventIdentityPrefix: 'evt.f005.', signal: controller.signal }));
        const outcome = await observeWithin(recording, 1600);
        expect(outcome, '整体期限必须独立于 result 与 events 的结束').toMatchObject({ status: 'rejected',
          reason: { reason: 'recording_deadline_exceeded', safeStopRequired: true } });
        expect(performance.now() - start).toBeLessThan(1600);
        expect(f.cancels()).toBe(1);
        const manifest = f.store.getLatestManifest(f.projectId, f.request.sessionId)!;
        expect(manifest).toMatchObject({ finalized: true, coverage: 'failed' });
        expect(manifest.missingReasons).toContain('recording_failed:recording_deadline_exceeded');
        if (scenario === 'body-hang' || scenario === 'manifest-hang') expect(publicationSignal?.aborted).toBe(true);
        const snapshot = JSON.stringify(manifest);
        release.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(JSON.stringify(f.store.getLatestManifest(f.projectId, f.request.sessionId))).toBe(snapshot);
        expect(f.query("SELECT count(*) AS n FROM tasks WHERE status = 'passed'")).toEqual({ n: 0 });
      } finally {
        controller.abort(); release.resolve();
        if (recording) await observeWithin(recording, 200);
        f.close();
      }
    });
  }

  for (const mode of ['required', 'best_effort'] as const) {
    it(`[case:${mode}-hard-limit] 队列硬限制在 completed 交错后仍停止，禁止 fallback 和重复结算`, async () => {
      const f = await fixture(mode);
      try {
        const events = { async *[Symbol.asyncIterator]() { yield f.event(1); throw new RuntimeError('protocol', 'runner_buffer_overflow'); } };
        const runtime = f.handle(events, Promise.resolve({ ...completed, lastEventSequence: 1 }));
        const recording = settle(f.recorder().record({ request: f.request, handle: runtime, eventIdentityPrefix: 'evt.f005.' }));
        let routed = 0, retained = 0, quarantined = 0;
        let applied!: RuntimeSettlementInput;
        const supervision = superviseExecution({ request: f.request, runtime: runtime as RuntimeSession,
          controller: new AbortController(), result: settle(Promise.resolve({ ...completed, lastEventSequence: 1 })),
          stopped: settle(Promise.resolve(stopped)), recording, settlement: { async settle(input) {
            applied = input; return f.settlement.settle(input);
          } },
          options: { stopWaitMs: 20, drainWaitMs: 100, closeWaitMs: 100,
            retain: async () => { retained++; }, routeFailure: async () => { routed++; return true; } },
          quarantine: () => { quarantined++; }, evidenceRef: () => f.sessions.getWorkSession(f.projectId, f.request.sessionId).resultRef,
          timeoutMs: 1000, timeoutReason: 'runtime_timeout', timeoutLayer: 'session', timeoutLimitMs: 1000 });
        const outcome = await supervision.completion;
        expect(outcome).toMatchObject({ stopConfirmed: true, persisted: true, retained: true });
        expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'failed' });
        expect(f.query("SELECT count(*) AS n FROM tasks WHERE status = 'passed'")).toEqual({ n: 0 });
        expect(f.query('SELECT status FROM tasks WHERE id = ?', 't-2')).toEqual({ status: 'pending' });
        expect(routed).toBe(0); expect(retained).toBe(1); expect(quarantined).toBe(0);
        expect(await f.settlement.settle(applied)).toMatchObject({ disposition: 'replayed' });
        expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual({ n: 1 });
        expect(f.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
      } finally { f.close(); }
    });
  }
  for (const gap of ['queue_limit', 'cleanup_unconfirmed']) {
    it(`[case:best-effort-body-${gap}] 公开正文的硬限制和清理故障不能降为普通缺口`, async () => {
      const f = await fixture('best_effort');
      try {
        f.bodyPublisher.publishBody = async () => ({ status: 'unavailable', ref: null, observedBytes: 0,
          retainedBytes: 0, truncated: false, redacted: false, gapReasons: [gap] });
        const outcome = await settle(f.recorder().record({ request: f.request,
          handle: f.handle({ async *[Symbol.asyncIterator]() { yield f.event(1); } }, Promise.resolve({ ...completed, lastEventSequence: 1 })),
          eventIdentityPrefix: 'evt.f005.' }));
        expect(outcome).toMatchObject({ status: 'rejected', reason: { safeStopRequired: true,
          cleanupStatus: gap === 'cleanup_unconfirmed' ? gap : 'confirmed' } });
        expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toMatchObject({ coverage: 'failed',
          missingReasons: expect.arrayContaining([gap]) });
      } finally { f.close(); }
    });
  }

  for (const fault of ['metadata', 'cleanup'] as const) {
    it(`[case:failure-${fault}] 持久化故障和文件清理未确认独立阻塞并保留占用`, async () => {
      const f = await fixture('best_effort');
      try {
        const sessions = fault === 'metadata' ? { ...f.sessions, applyWorkSessionProgress() { throw new Error('database readonly'); } } : f.sessions;
        const recording = settle(f.recorder({ sessions, recording: fault === 'metadata' ? undefined : {
          publisher: f.bodyPublisher, store: f.store,
        }, publisher: { async publishArtifact() {
          throw new ArtifactPublishError('staging', 'file', 'injected', { projectId: f.projectId, artifactId: null,
            cleanupStatus: fault === 'cleanup' ? 'cleanup_unconfirmed' : 'confirmed' });
        } } }).record({ request: f.request,
          handle: f.handle({ async *[Symbol.asyncIterator]() { yield f.event(1); } }), eventIdentityPrefix: 'evt.f005.' }));
        const observation = await recording;
        expect(observation).toMatchObject({ status: 'rejected', reason: { safeStopRequired: true,
          gaps: expect.arrayContaining([fault === 'metadata' ? 'evidence_metadata_unpersisted' : 'cleanup_unconfirmed']) } });
        let retained = 0, quarantine = 0;
        const supervision = superviseExecution({ request: f.request, runtime: f.handle({ async *[Symbol.asyncIterator]() {} }) as RuntimeSession,
          controller: new AbortController(), result: settle(Promise.resolve(completed)), stopped: settle(Promise.resolve(stopped)), recording,
          settlement: fault === 'metadata' ? { async settle() { throw new Error('cannot persist settlement'); } } : f.settlement,
          options: { stopWaitMs: 20, drainWaitMs: 100, closeWaitMs: 100, retain: async () => { retained++; } },
          quarantine: () => { quarantine++; }, evidenceRef: () => null,
          timeoutMs: 1000, timeoutReason: 'runtime_timeout', timeoutLayer: 'session', timeoutLimitMs: 1000 });
        expect(await supervision.completion).toMatchObject({ retained: false,
          error: fault === 'metadata' ? 'execution_finalization_failed' : 'cleanup_unconfirmed' });
        expect(retained).toBe(0); expect(quarantine).toBeGreaterThan(0);
        expect(f.query("SELECT count(*) AS n FROM tasks WHERE status = 'passed'")).toEqual({ n: 0 });
      } finally { f.close(); }
    });
  }

  it('[case:old-owner-failure-receipt] 旧 owner 故障回执在屏障后拒绝，保留当前记录与预算', async () => {
    const f = await fixture();
    const barrier = gate<void>();
    try {
      const recording = await settle(f.recorder().record({ request: f.request,
        handle: f.handle({ async *[Symbol.asyncIterator]() { throw new RuntimeError('protocol', 'runner_buffer_overflow'); } }),
        eventIdentityPrefix: 'evt.f005.' }));
      const snapshot = () => JSON.stringify(['attempts', 'tasks', 'sessions', 'recording_manifests', 'execution_batches', 'workspace_leases', 'artifacts']
        .map(table => f.session.database.prepare(`SELECT * FROM ${table}`).all()));
      const before = snapshot();
      const late = (async () => {
        await barrier.promise;
        return f.settlement.settle({ request: { ...f.request, owner: { ...f.request.owner, principalId: 'old-owner' } },
          recording, result: { status: 'fulfilled', value: completed }, stopped: { status: 'fulfilled', value: stopped } });
      })();
      barrier.resolve();
      expect(await late).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
      expect(snapshot()).toBe(before);
    } finally { barrier.resolve(); f.close(); }
  });

  it('[case:runtime-cannot-switch-mode] Runtime 输入不能覆盖可信 required 策略', async () => {
    const f = await fixture();
    try {
      await expect(f.recorder().record({ request: f.request, handle: f.handle({ async *[Symbol.asyncIterator]() {} }),
        eventIdentityPrefix: 'evt.f005.', recordingMode: 'best_effort' })).rejects.toMatchObject({ kind: 'validation' });
      expect(f.store.getLatestManifest(f.projectId, f.request.sessionId)).toBeNull();
    } finally { f.close(); }
  });

  for (const fence of ['executionVersion'] as const) {
    it(`[case:failure-stale-${fence}] 故障屏障后旧回执不改写新持有者、预算或 Manifest`, async () => {
      const f = await fixture();
      const entered = gate<void>(), release = gate<void>();
      try {
        const recording = settle(f.recorder({ publisher: { async publishArtifact(input) {
          entered.resolve(); await release.promise; return f.publisher.publishArtifact(input);
        } } }).record({ request: f.request,
          handle: f.handle({ async *[Symbol.asyncIterator]() { yield f.event(1); throw new Error('broken stream'); } }),
          eventIdentityPrefix: 'evt.f005.' }));
        await entered.promise;
        // Controlled storage-fault fixture: simulate fencing revocation while an
        // old write is in flight. Public closed-loop creation is tested separately.
        f.session.database.prepare('UPDATE tasks SET execution_version = ?').run(2);
        const snapshot = () => JSON.stringify(['attempts', 'tasks', 'sessions', 'recording_manifests', 'execution_batches', 'workspace_leases']
          .map(table => f.session.database.prepare(`SELECT * FROM ${table}`).all()));
        const before = snapshot(); release.resolve();
        const observed = await recording;
        expect(observed).toMatchObject({ status: 'rejected', reason: { reason: 'stale_execution_identity' } });
        for (let i = 0; i < 3; i++) expect(await f.settlement.settle({ request: f.request,
          recording: observed, result: { status: 'fulfilled', value: completed }, stopped: { status: 'fulfilled', value: stopped } }))
          .toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
        expect(snapshot()).toBe(before);
        expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual({ n: 0 });
      } finally { release.resolve(); f.close(); }
    });
  }
});
