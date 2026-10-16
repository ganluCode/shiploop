import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_RECORDER_LIMITS } from './helpers/p03-6/evidence-fixture.ts';
import { join } from 'node:path';
import { RuntimeError, type RuntimeExecutionRequest } from '../packages/core/src/ports/runtime-execution.ts';
import type { ExecutionServiceDeps } from '../packages/core/src/application/execution-service.ts';
import { createRuntimeSettlementService } from '../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder, WorkEvidenceRecordingError } from '../packages/core/src/application/work-evidence-recorder.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createFakeRuntimeGate } from '../packages/core/src/adapters/fake-runtime.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { fixture } from './helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from './helpers/p03-6/input-binding-fixture.ts';
import { git } from './helpers/git-repo.ts';

const script = (steps: unknown[], lifecycle?: unknown) => ({ schemaVersion: 1, steps, ...(lifecycle ? { lifecycle } : {}) });
const fastStop = (_f: unknown, deps: ExecutionServiceDeps) => Object.assign(deps.supervision!, { stopWaitMs: 40, drainWaitMs: 80 });
async function settlementEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const row = f.query('SELECT result_ref FROM sessions') as { result_ref: string };
  return f.readArtifact(row.result_ref);
}

describe('F-010 uncertainty, persistence and shutdown', () => {
  it('acceptance alone persists interrupted/quarantined; late stop never releases or reruns retention', async () => {
    const f = await fixture({ script: script([{ op: 'await_gate', name: 'hang' }], { cancel: { acceptOnly: true } }) }, {}, fastStop);
    try {
      const { context } = await f.start();
      expect(await f.service.cancel(f.identity)).toMatchObject({ stopConfirmed: false, persisted: true, retained: false });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.resources.read(f.identity).leases.map(l => l.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
      expect(f.retain).not.toHaveBeenCalled();
      expect((await settlementEvidence(f)).control).toEqual({ reason: 'user_cancelled', cancel: 'accepted' });
      expect(f.service.forget(f.projectId, f.identity.attemptId)).toBe(false);
      expect(await f.service.close()).toEqual({ closed: false, pendingAttemptIds: [f.identity.attemptId] });
      expect(f.session.isOpen()).toBe(true);
      await expect(f.start()).rejects.toMatchObject({ reason: 'execution_service_closing' });
      await f.rawHandles[0]!.cancel();
      await context.stopped;
      expect(f.resources.read(f.identity).leases).toHaveLength(3);
      expect(f.retain).not.toHaveBeenCalled();
      const reopened = openSqliteStorageSession({ path: f.session.database.name });
      try {
        expect(reopened.database.prepare('SELECT status FROM attempts').get()).toEqual({ status: 'interrupted' });
        expect(reopened.database.prepare("SELECT count(*) AS n FROM workspace_leases WHERE state = 'quarantined'").get()).toEqual({ n: 3 });
      } finally { reopened.close(); }
    } finally { await f.dispose(); }
  });

  it.each(['unconfirmed', 'rejected', 'never'] as const)('completed result/events with %s stopped cannot release or restart', async fault => {
    const f = await fixture({ script: script([]) }, {}, (f, deps) => {
      fastStop(f, deps);
      const runtime = deps.runtime;
      Object.assign(deps, { runtime: { ...runtime, start: async (request: RuntimeExecutionRequest) => {
        const h = await runtime.start(request);
        return { ...h, stopped: fault === 'never' ? new Promise(() => {}) : fault === 'rejected'
          ? Promise.reject(new Error('probe_failed')) : Promise.resolve({ schemaVersion: 1, confirmed: false,
            checkedAtUtc: new Date(BINDING_NOW).toISOString(), detail: 'unknown' }) };
      } } });
    });
    try {
      const { context } = await f.start();
      expect(await context.completion).toMatchObject({ stopConfirmed: false, persisted: true, retained: false });
      expect(f.query('SELECT status, exit_code, duration_ms FROM attempts')).toEqual({ status: 'interrupted', exit_code: 0, duration_ms: null });
      expect(f.resources.read(f.identity).leases).toHaveLength(3);
      await expect(f.start()).rejects.toThrow();
      expect(f.query('SELECT count(*) AS n FROM sessions')).toEqual({ n: 1 });
      expect((await f.service.close()).closed).toBe(false);
    } finally { await f.dispose(); }
  });

  it.each(['rejected', 'throws', 'never'] as const)('cancel %s without independent stop remains isolated', async fault => {
    const f = await fixture({}, {}, (f, deps) => {
      fastStop(f, deps);
      const runtime = deps.runtime;
      Object.assign(deps, { runtime: { ...runtime, start: async (request: RuntimeExecutionRequest) => {
        const h = await runtime.start(request);
        return { ...h, cancel: async () => {
          if (fault === 'throws') throw new Error('cancel_failed');
          if (fault === 'never') return new Promise(() => {});
          return { accepted: false, reason: 'denied' };
        } };
      } } });
    });
    try {
      await f.start();
      expect(await f.service.cancel(f.identity)).toMatchObject({ persisted: true, stopConfirmed: false, retained: false });
      expect((await settlementEvidence(f)).control.cancel).toBe(fault === 'throws' ? 'failed' : fault === 'never' ? 'unobserved' : 'rejected');
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.resources.read(f.identity).leases.every(l => l.state === 'quarantined')).toBe(true);
    } finally { await f.dispose(); }
  });

  it('required recorder failure records audit error and preserves tracked/untracked bytes and branches', async () => {
    const f = await fixture({}, {}, (_f, deps) => {
      Object.assign(deps, { recorder: { record: async () => {
        throw new WorkEvidenceRecordingError('event_publish_failed', 'disk_failed', { watermark: null,
          gaps: ['event_publish_failed'], safeStopRequired: true });
      } } });
    });
    try {
      const tracked = join(f.workspace.canonicalPath, 'README.md'), untracked = join(f.workspace.canonicalPath, 'keep.bin');
      writeFileSync(tracked, 'partial progress'); writeFileSync(untracked, Buffer.from([0, 255, 3]));
      const refs = git(['show-ref'], f.workspace.canonicalPath);
      const { context } = await f.start();
      expect(await context.completion).toMatchObject({ persisted: true, stopConfirmed: true, retained: true });
      expect((await settlementEvidence(f)).execution.failure).toEqual({ kind: 'protocol', reason: 'recording_failed' });
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(readFileSync(tracked, 'utf8')).toBe('partial progress');
      expect(readFileSync(untracked)).toEqual(Buffer.from([0, 255, 3]));
      expect(git(['show-ref'], f.workspace.canonicalPath)).toBe(refs);
      expect(f.resources.read(f.identity).leases).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('publication failure keeps leases and prevents safe close or forgetting context', async () => {
    const f = await fixture({ script: script([]) }, {}, (_f, deps) => {
      const publisher = { publishArtifact: async () => { throw new Error('ENOSPC'); } };
      Object.assign(deps, { settlement: createRuntimeSettlementService({ publisher, attempts: deps.attempts,
        dag: deps.dag, lifecycle: createSqliteAttemptLifecycleStore(_f.session, { workspaceAuthority: _f.authority, nowUtcMs: () => BINDING_NOW }) }) });
    });
    try {
      const { context } = await f.start();
      expect(await context.completion).toMatchObject({ persisted: false, retained: false });
      expect(f.resources.read(f.identity).leases.every(l => l.state === 'quarantined')).toBe(true);
      expect(f.retain).not.toHaveBeenCalled();
      expect(f.service.forget(f.projectId, f.identity.attemptId)).toBe(false);
      expect((await f.service.close()).closed).toBe(false);
    } finally { await f.dispose(); }
  });

  it('verified non-started binding failure persists evidence before retention and release', async () => {
    const f = await fixture({}, {}, (_f, deps) => Object.assign(deps, { inputBinding: { bind: async () => {
      throw new RuntimeError('protocol', 'input_rejected');
    } } }));
    try {
      await expect(f.start()).rejects.toMatchObject({ reason: 'input_rejected' });
      expect(f.rawHandles).toHaveLength(0);
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'failed' });
      expect(f.resources.read(f.identity).leases).toEqual([]);
      expect(f.retain).toHaveBeenCalledOnce();
      expect(f.workspaces.readWorkspace(f.projectId, f.featureId)?.status).toBe('retained');
      expect((await f.service.close()).closed).toBe(true);
    } finally { await f.dispose(); }
  });

  it('adapter start throwing is uncertain rather than proof of no launch', async () => {
    const f = await fixture({ startFailure: { kind: 'process', reason: 'adapter_start_failed' } });
    try {
      await expect(f.start()).rejects.toMatchObject({ reason: 'adapter_start_failed' });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.resources.read(f.identity).leases.every(l => l.state === 'quarantined')).toBe(true);
      expect((await f.service.close()).closed).toBe(false);
    } finally { await f.dispose(); }
  });

  it('completed/cancel race finalizes once and leaves Task waiting for verification', async () => {
    const gate = createFakeRuntimeGate();
    const f = await fixture({ script: script([{ op: 'await_gate', name: 'finish' }]), gates: { finish: gate } });
    try {
      const { context } = await f.start(); gate.release(); await context.completion;
      const before = f.query('SELECT count(*) AS n FROM attempt_notifications');
      await f.service.cancel(f.identity);
      expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual(before);
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'verifying' });
      expect(f.query('SELECT status FROM tasks')).toEqual({ status: 'running' });
      expect(f.resources.read(f.identity).leases).toHaveLength(3);
    } finally { await f.dispose(); }
  });

  it('actual required chunk publication failure stops subsequent script effects', async () => {
    const f = await fixture({ script: script([{ op: 'message', role: 'assistant', text: 'progress' },
      { op: 'await_gate', name: 'hang' }, { op: 'write_file', path: 'forbidden', content: 'bad' }]) }, {}, (f, deps) => {
      Object.assign(deps, { recorder: createWorkEvidenceRecorder({ sessions: deps.sessions, verifier: f.verifier,
        limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 1 },
        publisher: { publishArtifact: async () => { throw new Error('ENOSPC'); } } }) });
    });
    try {
      const { context } = await f.start();
      expect(await context.completion).toMatchObject({ persisted: true, stopConfirmed: true, retained: true });
      const evidence = await settlementEvidence(f);
      expect(evidence.control.reason).toBe('recording_failed');
      expect(evidence.recording.gaps.length).toBeGreaterThan(0);
      expect(existsSync(join(f.workspace.canonicalPath, 'forbidden'))).toBe(false);
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(f.resources.read(f.identity).leases).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('close bounds an unresolved start and cancels a handle arriving after shutdown began', async () => {
    const gate = createFakeRuntimeGate();
    let entered = false;
    const f = await fixture({}, {}, (_f, deps) => {
      Object.assign(deps.supervision!, { closeWaitMs: 40 });
      const runtime = deps.runtime;
      Object.assign(deps, { runtime: { ...runtime, start: async (request: RuntimeExecutionRequest) => {
        entered = true; await gate.wait(); return runtime.start(request);
      } } });
    });
    const started = f.start();
    try {
      const deadline = Date.now() + 2_000;
      while (!entered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(entered).toBe(true);
      const before = Date.now();
      expect(await f.service.close()).toEqual({ closed: false, pendingAttemptIds: [f.identity.attemptId] });
      expect(Date.now() - before).toBeLessThan(1_000);
      gate.release();
      const { context } = await started;
      expect(await context.completion).toMatchObject({ stopConfirmed: true, persisted: true, retained: true });
      expect((await settlementEvidence(f)).control.reason).toBe('service_close');
      expect((await f.service.close()).closed).toBe(true);
    } finally { gate.release(); await started.catch(() => undefined); await f.dispose(); }
  });

  it('late stop authorization cannot release a newly claimed Task occupancy', async () => {
    const f = await fixture({}, {}, undefined, 't-2');
    try {
      await f.start();
      const previous = f.resources.read(f.identity);
      await f.service.cancel(f.identity);
      // Fixture simulates a separately authorized run continuation; F-010 adds no resume API.
      f.session.database.prepare("UPDATE runs SET status = 'running', reason = NULL").run();
      const next = f.claimTask('t-1');
      const nextIdentity = { ...f.identity, attemptId: next.receipt.attempt.id };
      const current = f.resources.read(nextIdentity);
      expect(current.leases).toHaveLength(3);
      const lateToken = await f.service.stopVerifier.verify(previous);
      expect(lateToken).not.toBeNull();
      expect(() => f.session.transactWrite('test.late-release', () =>
        f.resources.releaseStoppedInTransaction(f.identity, lateToken))).toThrow();
      expect(() => f.session.transactWrite('test.forged-release', () =>
        f.resources.releaseStoppedInTransaction(nextIdentity, { confirmed: true }))).toThrow();
      expect(f.resources.read(nextIdentity)).toEqual(current);
    } finally { await f.dispose(); }
  });

  it('close cancels active execution and denies new admission without closing SQLite', async () => {
    const f = await fixture();
    try {
      await f.start();
      expect(await f.service.close()).toEqual({ closed: true, pendingAttemptIds: [] });
      expect((await settlementEvidence(f)).control.reason).toBe('service_close');
      expect(f.session.isOpen()).toBe(true);
      await expect(f.start()).rejects.toMatchObject({ reason: 'execution_service_closing' });
    } finally { await f.dispose(); }
  });
});
