import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExecutionService, type ExecutionServiceDeps } from '../../../packages/core/src/application/execution-service.ts';
import { createRuntimeExecutionService } from '../../../packages/core/src/application/runtime-execution.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createFakeRuntime, createFakeRuntimeGate, fakeRuntimeCorrelationToken, type FakeRuntimeOptions } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createStaticRuntimeRegistry } from '../../../packages/core/src/ports/runtime-registry.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openBindingFixture, BINDING_NOW, FAKE_STRATEGY, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';

function assemble(fixture: BindingFixture, options: Partial<FakeRuntimeOptions> = {}, overrides: Partial<ExecutionServiceDeps> = {}) {
  const outsideTransaction = () => expect(fixture.session.database.inTransaction).toBe(false);
  const fake = createFakeRuntime({
    script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'runtime-proof.txt', content: 'started' }] },
    workspaceRoots: { 'workspace-root': fixture.box.root },
    providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
    adapterVersion: 'fake-1.0.0', nowUtcMs: () => BINDING_NOW,
    ...options,
  });
  const configuration = createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
  ]);
  const adapterStart = vi.fn(async (request: Parameters<typeof fake.adapter.start>[0]) => {
    outsideTransaction();
    expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toMatchObject({ runtime_starts: 1 });
    expect(fixture.query('SELECT status FROM sessions WHERE kind = ?', 'work')).toMatchObject({ status: 'reserved' });
    return fake.adapter.start(request);
  });
  const runtime = createRuntimeExecutionService({ configuration,
    registry: createStaticRuntimeRegistry([{ descriptor: fake.descriptor, adapter: { start: adapterStart } }], configuration) });
  const sessions = createSqliteWorkSessionStore(fixture.session, { nowUtcMs: () => BINDING_NOW });
  const deps: ExecutionServiceDeps = {
    atomic: createSqliteAtomicCommandStore(fixture.session, { nowUtcMs: () => BINDING_NOW }),
    resources: fixture.createResources(), sessions,
    dag: createSqliteTaskDagStore(fixture.session), attempts: createSqliteAttemptAccess(fixture.session),
    recorder: createWorkEvidenceRecorder({ publisher: fixture.publisher, verifier: fixture.verifier, sessions, limits: DEFAULT_RECORDER_LIMITS }),
    inputBinding: { async bind(input) { outsideTransaction(); return fixture.bindingService.bind(input); } },
    runtime: { prepare(input) { outsideTransaction(); return runtime.prepare(input); }, start: runtime.start },
    eventIdentityPrefix: request => `evt.${fakeRuntimeCorrelationToken(request)}.`,
    nowUtcMs: () => BINDING_NOW,
    ...overrides,
  };
  return { service: createExecutionService(deps), deps, adapterStart, sessions };
}

const proof = (fixture: BindingFixture) => join(fixture.box.repoDirA, 'runtime-proof.txt');
const starts = (fixture: BindingFixture, n: number) => expect(fixture.query('SELECT runtime_starts FROM execution_batches')).toMatchObject({ runtime_starts: n });
const held = (fixture: BindingFixture) => expect(fixture.query('SELECT count(*) AS n FROM workspace_leases WHERE state = ?', 'held')).toEqual({ n: 3 });

async function finish(result: Awaited<ReturnType<ReturnType<typeof createExecutionService>['start']>>) {
  const [execution, stopped, recording] = await Promise.all([result.context.result, result.context.stopped, result.context.recording]);
  expect(execution).toMatchObject({ status: 'fulfilled', value: { terminal: 'completed' } });
  expect(stopped).toMatchObject({ status: 'fulfilled', value: { confirmed: true } });
  expect(recording).toMatchObject({ status: 'fulfilled', value: { status: 'complete' } });
  return recording;
}

describe('P03-6 F-008 ExecutionService', () => {
  it('commits Session and budget before external I/O, records evidence and retains the Attempt context', async () => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const { service, adapterStart, deps } = assemble(fixture);
      const input = fixture.bindingInput(claimed);
      const result = await service.start(input);
      await finish(result);
      expect(result.session).toMatchObject({ status: 'started', adapterVersion: 'fake-1.0.0', attemptId: claimed.receipt.attempt.id });
      expect(service.get(fixture.projectId, claimed.receipt.attempt.id)).toBe(result.context);
      expect(readFileSync(proof(fixture), 'utf8')).toBe('started');
      held(fixture);
      const defaults = deps.atomic.getGlobalSettingsOrNull()!;
      deps.atomic.transact('test.change-defaults', tx => tx.updateGlobalSettings({
        expectedRevision: defaults.revision, payload: { schemaVersion: 2 },
      }));
      expect(result.context.request.strategy).toEqual(FAKE_STRATEGY);
      await expect(service.start({ ...input, sessionId: 'session-replay' })).rejects.toThrow();
      expect(adapterStart).toHaveBeenCalledTimes(1);
      starts(fixture, 1);
      expect(service.forget(fixture.projectId, claimed.receipt.attempt.id)).toBe(true);
      held(fixture);
    } finally { fixture.close(); }
  });

  it('two independent service callers race the same committed Attempt: one start and one debit', async () => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const a = assemble(fixture);
      const b = assemble(fixture);
      const outcomes = await Promise.allSettled([
        a.service.start(fixture.bindingInput(claimed)),
        b.service.start(fixture.bindingInput(claimed, { sessionId: 'session-competing' })),
      ]);
      expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      for (const outcome of outcomes) if (outcome.status === 'fulfilled') await finish(outcome.value);
      expect(a.adapterStart.mock.calls.length + b.adapterStart.mock.calls.length).toBe(1);
      starts(fixture, 1);
      held(fixture);
    } finally { fixture.close(); }
  });

  it('retains one debit, structured failure and workspace when Runtime.start throws', async () => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const { service, sessions } = assemble(fixture, { startFailure: { kind: 'process', reason: 'injected_start_failure' } });
      await expect(service.start(fixture.bindingInput(claimed))).rejects.toMatchObject({ kind: 'process', reason: 'injected_start_failure' });
      starts(fixture, 1);
      held(fixture);
      expect(existsSync(proof(fixture))).toBe(false);
      expect(sessions.getWorkSession(fixture.projectId, 'session-t-1-1')).toMatchObject({ status: 'ended', recordingGaps: ['runtime_start_failed:process'] });
      await expect(service.start(fixture.bindingInput(claimed, { sessionId: 'session-new' }))).rejects.toThrow();
      starts(fixture, 1);
    } finally { fixture.close(); }
  });

  it.each(['workspace', 'missing-input', 'stale-claim', 'cross-project', 'capability'])('preparation rejection (%s) has no Runtime debit or file effects', async reason => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const assembly = assemble(fixture);
      const input = fixture.bindingInput(claimed);
      if (reason === 'workspace') input.workspace = { forged: true };
      if (reason === 'stale-claim') input.claim = { ...claimed.receipt, attempt: { ...claimed.receipt.attempt, owner: 'stale-owner' } };
      if (reason === 'cross-project') input.claim = { ...claimed.receipt, attempt: { ...claimed.receipt.attempt, projectId: 'other-project' } };
      if (reason === 'missing-input') {
        const ref = claimed.inputSnapshot.group.prompt;
        fixture.session.database.prepare("UPDATE artifacts SET status = 'failed' WHERE id = ?").run(ref.artifactId);
      }
      if (reason === 'capability') {
        assembly.deps.runtime.prepare = () => { throw new Error('capability_unavailable'); };
      }
      await expect(assembly.service.start(input)).rejects.toThrow();
      expect(assembly.adapterStart).not.toHaveBeenCalled();
      starts(fixture, 0);
      expect(existsSync(proof(fixture))).toBe(false);
      expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
    } finally { fixture.close(); }
  });

  it.each(['paused', 'cancelling', 'cancelled', 'batch-paused', 'manual-block', 'approval', 'deadline', 'run-time', 'runtime-budget', 'expired-lease', 'permissions'])('rechecks %s after asynchronous input binding, before the launch commit', async reason => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const assembly = assemble(fixture);
      const db = fixture.session.database;
      let now = BINDING_NOW;
      const service = createExecutionService({ ...assembly.deps, nowUtcMs: () => now,
        permissions: () => ({ grants: reason === 'permissions' ? ['changed-grant'] : [] }),
        inputBinding: { async bind(input) {
          const bound = await fixture.bindingService.bind(input);
          if (['paused', 'cancelling', 'cancelled'].includes(reason)) db.prepare('UPDATE runs SET status = ?').run(reason);
          if (reason === 'batch-paused') db.prepare("UPDATE execution_batches SET status = 'paused'").run();
          if (reason === 'manual-block') db.prepare('UPDATE tasks SET manual_block = 1').run();
          if (reason === 'approval') db.prepare("UPDATE features SET plan_status = 'draft'").run();
          if (reason === 'deadline' || reason === 'run-time') {
            now += 3_600_000;
            fixture.session.transactWrite('test.renew', () => assembly.deps.resources.renewInTransaction({
              projectId: fixture.projectId, attemptId: claimed.receipt.attempt.id, owner: 'owner-1', hostInstanceId: 'host-1',
              executionVersion: claimed.receipt.attempt.executionVersion,
            }, now + 600_000));
            if (reason === 'run-time') db.prepare('UPDATE runs SET started_at = ?').run(BINDING_NOW);
          }
          if (reason === 'expired-lease') now += 600_000;
          if (reason === 'runtime-budget') db.prepare('UPDATE execution_batches SET runtime_starts = 4').run();
          return bound;
        } },
      });
      const reasons: Record<string, string> = { paused: 'run_control_blocked', cancelling: 'run_control_blocked',
        cancelled: 'run_not_active', 'batch-paused': 'batch_control_blocked', 'manual-block': 'waiting_approval',
        approval: 'waiting_approval', deadline: 'deadline_exhausted', 'run-time': 'run_time_exhausted',
        'expired-lease': 'stale_execution_identity', permissions: 'permissions_changed', 'runtime-budget': 'budget_exhausted' };
      await expect(service.start(fixture.bindingInput(claimed))).rejects.toMatchObject({ details: { reason: reasons[reason] } });
      expect(assembly.adapterStart).not.toHaveBeenCalled();
      starts(fixture, reason === 'runtime-budget' ? 4 : 0);
      expect(existsSync(proof(fixture))).toBe(false);
      expect(fixture.query("SELECT count(*) AS n FROM sessions WHERE kind = 'work'")).toEqual({ n: 0 });
    } finally { fixture.close(); }
  });

  it.each(['slot-quarantined', 'slot-released', 'claim-quarantined', 'claim-generation'])('[case:dispatch-after-binding-%s] rechecks durable dispatch after asynchronous binding before any Runtime start', async reason => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const assembly = assemble(fixture);
      const db = fixture.session.database;
      const service = createExecutionService({ ...assembly.deps, inputBinding: { async bind(input) {
        const bound = await fixture.bindingService.bind(input);
        expect(db.inTransaction).toBe(false);
        if (reason === 'slot-quarantined') db.prepare("UPDATE execution_slot_claims SET state = 'quarantined', reason = 'uncertain'").run();
        if (reason === 'slot-released' || reason === 'claim-generation') db.prepare("UPDATE execution_slot_claims SET state = 'released', released_at = ?").run(BINDING_NOW);
        if (reason === 'claim-quarantined') db.prepare("UPDATE run_dispatch_claims SET state = 'quarantined', reason = 'uncertain', settled_at = ?").run(BINDING_NOW);
        if (reason === 'claim-generation') {
          db.prepare("UPDATE run_dispatch_claims SET state = 'released', settled_at = ?").run(BINDING_NOW);
          db.prepare(`INSERT INTO run_dispatch_claims (id, created_at, project_id, updated_at, feature_id, run_id,
            claim_version, origin, resumed_from_claim_id, resumed_from_claim_version, owner_id, host_instance_id,
            acquired_at, lease_until, state) SELECT 'new-generation', created_at, project_id, updated_at,
            feature_id, run_id, 2, 'resume', id, 1, owner_id, host_instance_id, acquired_at, lease_until, 'held'
            FROM run_dispatch_claims WHERE id = ?`).run(claimed.receipt.dispatch!.claimId);
        }
        return bound;
      } } });
      await expect(service.start(fixture.bindingInput(claimed))).rejects.toThrow();
      expect(assembly.adapterStart).not.toHaveBeenCalled();
      starts(fixture, 0);
      expect(fixture.query('SELECT count(*) AS n FROM runtime_start_reservations')).toEqual({ n: 0 });
      expect(fixture.query('SELECT count(*) AS n FROM task_claim_receipts')).toEqual({ n: 1 });
      expect(fixture.query('SELECT count(*) AS n FROM attempts')).toEqual({ n: 1 });
      expect(fixture.query("SELECT count(*) AS n FROM sessions WHERE kind = 'work'")).toEqual({ n: 0 });
      expect(existsSync(proof(fixture))).toBe(false);
    } finally { fixture.close(); }
  });

  it.each(['begin-launch', 'session-insert', 'commit'])('%s failure rolls back without Runtime file or process effects', async failure => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const db = fixture.session.database;
      const assembly = assemble(fixture);
      if (failure === 'begin-launch') db.exec("CREATE TEMP TRIGGER fail_launch BEFORE UPDATE ON attempts WHEN NEW.invocation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected_launch_failure'); END");
      if (failure === 'session-insert') db.exec("CREATE TEMP TRIGGER fail_session BEFORE INSERT ON sessions WHEN NEW.kind = 'work' BEGIN SELECT RAISE(ABORT, 'injected_session_failure'); END");
      // A deferred FK fails at COMMIT, after both reservation and Session inserts.
      db.exec('CREATE TABLE commit_probe (id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED)');
      const service = createExecutionService({ ...assembly.deps, atomic: { ...assembly.deps.atomic, transact(operation, work) {
        return assembly.deps.atomic.transact(operation, transaction => {
          const result = work(transaction);
          if (failure === 'commit' && operation === 'execution.reserve-runtime-start') db.prepare('INSERT INTO commit_probe VALUES (?)').run('missing-project');
          return result;
        });
      } } });
      await expect(service.start(fixture.bindingInput(claimed))).rejects.toThrow();
      expect(assembly.adapterStart).not.toHaveBeenCalled();
      starts(fixture, 0);
      expect(fixture.query('SELECT count(*) AS n FROM runtime_start_reservations')).toEqual({ n: 0 });
      expect(fixture.query("SELECT count(*) AS n FROM sessions WHERE kind = 'work'")).toEqual({ n: 0 });
      expect(existsSync(proof(fixture))).toBe(false);
    } finally { fixture.close(); }
  });

  it('retains a live handle and observes stop even when the started Session write fails', async () => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const { service, adapterStart } = assemble(fixture);
      fixture.session.database.exec("CREATE TEMP TRIGGER fail_started BEFORE UPDATE ON sessions WHEN NEW.status = 'started' BEGIN SELECT RAISE(ABORT, 'injected_started_failure'); END");
      await expect(service.start(fixture.bindingInput(claimed))).rejects.toThrow();
      expect(adapterStart).toHaveBeenCalledTimes(1);
      const context = service.get(fixture.projectId, claimed.receipt.attempt.id);
      expect(context).toBeDefined();
      expect(await context!.recording).toMatchObject({ status: 'rejected' });
      expect(await context!.stopped).toMatchObject({ status: 'fulfilled', value: { confirmed: true } });
      await context!.result;
      starts(fixture, 1);
      held(fixture);
    } finally { fixture.close(); }
  });

  it('does not forget an unconfirmed stopped observation or release its occupancy', async () => {
    const fixture = await openBindingFixture();
    try {
      const claimed = fixture.claimTask('t-1');
      const { service } = assemble(fixture, { script: { schemaVersion: 1, steps: [], lifecycle: { stopped: { unconfirmed: true } } } });
      const result = await service.start(fixture.bindingInput(claimed));
      await Promise.all([result.context.result, result.context.recording]);
      expect(await result.context.stopped).toMatchObject({ status: 'fulfilled', value: { confirmed: false } });
      expect(service.forget(fixture.projectId, claimed.receipt.attempt.id)).toBe(false);
      held(fixture);
    } finally { fixture.close(); }
  });

  it.each(['long-stream', 'result-first', 'events-first'])('observes %s concurrently and holds resources until independent stop confirmation', async order => {
    const fixture = await openBindingFixture();
    const eventsGate = createFakeRuntimeGate();
    const resultGate = createFakeRuntimeGate();
    const stopGate = createFakeRuntimeGate();
    try {
      const claimed = fixture.claimTask('t-1');
      const steps = Array.from({ length: order === 'long-stream' ? 200 : 3 }, (_, i) => ({ op: 'message', role: 'assistant', text: `message-${i}` }));
      const { service } = assemble(fixture, {
        script: { schemaVersion: 1, steps, lifecycle: {
          ...(order === 'result-first' ? { events: { endGate: 'events' } } : {}),
          ...(order === 'events-first' ? { result: { gate: 'result' } } : {}),
          stopped: { gate: 'stop' },
        } }, gates: { events: eventsGate, result: resultGate, stop: stopGate },
        buffer: { maxEvents: 2, maxBytes: 4096 },
      });
      const result = await service.start(fixture.bindingInput(claimed));
      if (order === 'result-first') {
        await result.context.result;
        expect(result.runtime.query()).toMatchObject({ resultSettled: true, eventsEnded: false, stopConfirmed: null });
        eventsGate.release();
      }
      if (order === 'events-first') {
        await vi.waitFor(() => expect(result.runtime.query().eventsEnded).toBe(true));
        expect(result.runtime.query().resultSettled).toBe(false);
        resultGate.release();
      }
      const recording = await result.context.recording;
      expect(recording).toMatchObject({ status: 'fulfilled', value: { status: 'complete', stats: { eventsPersisted: steps.length } } });
      expect(result.runtime.query().stopConfirmed).toBe(null);
      held(fixture);
      expect(service.forget(fixture.projectId, claimed.receipt.attempt.id)).toBe(false);
      stopGate.release();
      await finish(result);
      held(fixture);
    } finally {
      eventsGate.release(); resultGate.release(); stopGate.release();
      fixture.close();
    }
  });
});
