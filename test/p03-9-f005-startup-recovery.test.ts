import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startHost } from '../packages/host/src/index.ts';
import { validateStateEventWire } from '../packages/host/src/client/app-wire.ts';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteWorkStartupRecoveryStore } from '../packages/core/src/adapters/sqlite/work-startup-recovery.ts';
import { createWorkStartupRecovery } from '../packages/core/src/application/work-startup-recovery.ts';
import { createFakeWorkRuntimeFactory } from '../packages/core/src/adapters/testing.ts';
import { createLocalOwnerPrincipal } from './helpers/p02-2/index.ts';
import { BINDING_NOW, openBindingFixture, type BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';
import type { CommandProcessHandle } from '../packages/core/src/ports/command-process.ts';
import type { TaskClaimReceipt } from '../packages/core/src/ports/task-claim.ts';
import type { WorkStartupRecoveryEvidence } from '../packages/core/src/ports/work-startup-recovery.ts';

const owner = createLocalOwnerPrincipal();
const processPort = () => createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 1_000 });
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function publish(f: BindingFixture, evidence: WorkStartupRecoveryEvidence) {
  const body = Buffer.from(JSON.stringify(evidence));
  return (await f.publisher.publishArtifact({ projectId: f.projectId, kind: 'workspace_evidence', mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${randomUUID()}.json`, content: [body] })).artifact.id;
}
function recorded(f: BindingFixture, phase = 'observed'): Record<string, any> {
  const row = f.query("SELECT payload FROM state_events WHERE json_extract(payload, '$.phase') = ? ORDER BY sequence DESC LIMIT 1", phase) as { payload: string };
  return JSON.parse(row.payload);
}
function registerWorkspace(f: BindingFixture, claim: TaskClaimReceipt) {
  const a = claim.attempt, b = f.workspace.binding;
  f.session.database.prepare(`INSERT INTO managed_workspaces (id, created_at, updated_at, project_id, feature_id,
    repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir,
    branch, base_commit, status, preparation_operation_id, owner_id, host_instance_id, execution_version, run_id, attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), BINDING_NOW, BINDING_NOW, f.projectId, f.featureId, b.id, b.revision, b.repoIdentity,
      f.workspace.canonicalPath, b.gitCommonDir, 'fixture-branch', 'a'.repeat(40), randomUUID(),
      a.owner, a.hostInstanceId, a.executionVersion, a.runId, a.id);
}
async function launch(f: BindingFixture) {
  const claim = f.claimAndLaunch('t-1');
  registerWorkspace(f, claim.receipt);
  const a = claim.receipt.attempt;
  const identity = { projectId: a.projectId, attemptId: a.id, owner: a.owner,
    hostInstanceId: a.hostInstanceId, executionVersion: a.executionVersion };
  const port = processPort();
  const writer = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync('heartbeat','x');setInterval(()=>fs.appendFileSync('heartbeat','x'),15)";
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['--no-warnings','-e',${JSON.stringify(writer)}],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));c.unref()`;
  const handle = await port.start({ argv: [process.execPath, '--no-warnings', '-e', script], cwd: f.workspace.canonicalPath,
    environment: {}, timeoutMs: 30_000, maxInputBytes: 16_384, maxOutputBytes: 16_384 }, async processIdentity => {
    f.session.transactWrite('test.persist-identity', () => f.createResources().confirmLaunchInTransaction(identity, processIdentity));
    return { launchId: processIdentity.launchId };
  });
  await expect.poll(() => existsSync(join(f.workspace.canonicalPath, 'heartbeat')), { timeout: 5_000 }).toBe(true);
  const pids = JSON.parse(readFileSync(join(f.workspace.canonicalPath, 'pids.json'), 'utf8')) as number[];
  return { claim, identity, port, handle, pids };
}
async function cleanupProcess(handle: CommandProcessHandle) {
  await handle.cancel();
  expect(await processPort().recoverStop!(handle.identity)).toEqual({ confirmed: true });
}

// Real Host lock + SQLite + CommandProcess. No model credentials or network provider.
describe.skipIf(process.platform !== 'darwin')('P03-9 / F-005 startup recovery', () => {
  it('opens the gate after a clean census while preserving queued authorization and budgets', async () => {
    const f = await openBindingFixture();
    const before = f.query('SELECT COUNT(*) AS n FROM state_events');
    const budgets = f.query('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(host.core.workExecution.recoveryState()).toEqual({ status: 'complete', reason: null });
      expect(f.query('SELECT status FROM runs')).toEqual({ status: 'queued' });
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 0 });
      expect(f.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(before);
      expect(f.query('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches')).toEqual(budgets);
      await host.core.workExecution.recover();
      expect(f.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(before);
    } finally { await host?.close(); f.close(); }
  });

  it.each(['preparing', 'executing', 'verifying'])('fences a leftover %s Attempt and rejects old writes without settling success', async status => {
    const f = await openBindingFixture();
    const claim = f.claimTask('t-1');
    f.session.database.prepare('UPDATE attempts SET status = ?, code_ref = ?, exit_code = 0 WHERE id = ?')
      .run(status, f.requirementArtifactId, claim.receipt.attempt.id);
    const budgets = f.query('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(host.lifecycleState).toBe('ready');
      expect(host.core.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'workspace_reconciliation_required' });
      expect(f.query('SELECT status, code_ref, exit_code FROM attempts WHERE id = ?', claim.receipt.attempt.id))
        .toEqual({ status: 'interrupted', code_ref: f.requirementArtifactId, exit_code: 0 });
      expect(f.query('SELECT status, reason FROM runs WHERE id = ?', f.runId))
        .toEqual({ status: 'interrupted', reason: 'restart_recovery' });
      expect(f.query('SELECT status, execution_version FROM tasks WHERE id = ?', 't-1'))
        .toEqual({ status: 'running', execution_version: 2 });
      expect(f.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual([
        { state: 'quarantined' }, { state: 'quarantined' }, { state: 'quarantined' },
      ]);
      expect(recorded(f)).toMatchObject({ stopConfirmed: false, workspaceReconciled: false,
        gaps: expect.arrayContaining(['process_identity_missing', 'workspace_not_reconciled']) });
      const before = f.query('SELECT COUNT(*) AS n FROM state_events');
      await host.core.workExecution.recover();
      await host.core.workExecution.scan();
      expect(f.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(before);
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
      expect(f.query('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches')).toEqual(budgets);
      const a = claim.receipt.attempt;
      const late = createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }).apply({
        projectId: f.projectId, runId: f.runId, taskId: 't-1', attemptId: a.id, owner: a.owner,
        hostInstanceId: a.hostInstanceId, executionVersion: a.executionVersion, notificationId: randomUUID(),
        kind: 'runtime_completed', exitCode: 0, evidenceRef: f.requirementArtifactId,
      });
      expect(late).toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
      // F-006 may supersede attempt.diagnostic_ref with a newer reconciliation diagnosis;
      // the immutable F-005 startup Artifact remains referenced by its recorded event.
      const startupRef = recorded(f, 'recorded').evidenceRef as string;
      const artifact = await f.verifier.readVerifiedContent(f.projectId, startupRef);
      expect(JSON.parse(Buffer.from(artifact.content).toString())).toMatchObject({ kind: 'work-startup-recovery', attemptId: a.id });
      expect((f.query('SELECT diagnostic_ref FROM attempts') as { diagnostic_ref: string }).diagnostic_ref).toEqual(expect.any(String));
      const events = await host.core.queryService.readEventBatch(owner, { scope: { kind: 'project', projectId: f.projectId }, afterSequence: 0, limit: 500 });
      const recoveryEvents = events.events.filter(event => event.type === 'work.recovery.updated');
      expect(recoveryEvents).toHaveLength(4);
      expect(recoveryEvents.at(-1)!.aggregate.revision).toBe((f.query('SELECT revision FROM runs WHERE id = ?', f.runId) as { revision: number }).revision);
      for (const event of recoveryEvents) {
        expect(event.payload).toEqual({ recoveryUpdated: true });
        expect(validateStateEventWire(event).payload).toEqual({ recoveryUpdated: true });
      }
    } finally {
      // Explicit fixture disposal only; product recovery must keep these leases.
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close();
      f.close();
    }
  });

  it('stops the durable old group before ready, including a live child after its parent exits; never starts Runtime', async () => {
    const f = await openBindingFixture();
    const running = await launch(f);
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    let starts = 0;
    const fake = createFakeWorkRuntimeFactory({ providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      script: { schemaVersion: 1, steps: [] } });
    try {
      writeFileSync(join(f.workspace.canonicalPath, 'keep.txt'), 'keep');
      // Simulate a crash after fencing commits, before any stop I/O or Artifact publish.
      createSqliteWorkStartupRecoveryStore(f.session).fence();
      host = await startHost({ dataRoot: f.box.dataRoot,
        capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]), env: {},
        workRuntimeFactory(context) {
          const assembly = fake(context);
          return { ...assembly, entries: assembly.entries.map(entry => ({ ...entry,
            adapter: { ...entry.adapter, async start(input) { starts++; return entry.adapter.start(input); } } })) };
        } });
      expect(running.pids.every(pid => !alive(pid))).toBe(true);
      const size = statSync(join(f.workspace.canonicalPath, 'heartbeat')).size;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(statSync(join(f.workspace.canonicalPath, 'heartbeat')).size).toBe(size);
      expect(readFileSync(join(f.workspace.canonicalPath, 'keep.txt'), 'utf8')).toBe('keep');
      expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
      expect(f.query('SELECT execution_version FROM tasks')).toEqual({ execution_version: 2 });
      expect(recorded(f)).toMatchObject({ stopConfirmed: true, processIdentity: running.handle.identity,
        workspaceReconciled: false, gaps: ['workspace_not_reconciled'] });
      const eventsBefore = f.query('SELECT COUNT(*) AS n FROM state_events');
      await host.core.workExecution.recover();
      host.core.workExecution.signalRunDispatched({ projectId: f.projectId, runId: f.runId });
      await host.core.workExecution.scan();
      expect(starts).toBe(0);
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 3 });
      expect(f.query('SELECT COUNT(*) AS n FROM state_events')).toEqual(eventsBefore);
    } finally {
      await cleanupProcess(running.handle);
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close(); f.close();
    }
  }, 20_000);

  it('does not mistake expired leases or mismatched persistent PID start identity for stopped execution', async () => {
    const f = await openBindingFixture();
    const running = await launch(f);
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const wrong = { ...running.handle.identity, startTime: 'unrelated-process-start' };
      f.session.database.prepare('UPDATE workspace_leases SET lease_until = 0, process_identity = ?')
        .run(JSON.stringify({ schemaVersion: 2, ...wrong }));
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(alive(running.pids[1]!)).toBe(true);
      expect(recorded(f)).toMatchObject({ stopConfirmed: false, gaps: expect.arrayContaining(['stop_unconfirmed']) });
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases WHERE state = ?', 'quarantined')).toEqual({ n: 3 });
      expect(host.core.workExecution.recoveryState().status).toBe('blocked');
      await expect(host.close()).rejects.toMatchObject({ code: 'resource_busy' });
      await expect(startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {}, lockTimeoutMs: 0 })).rejects.toBeDefined();
    } finally {
      await cleanupProcess(running.handle);
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close(); f.close();
    }
  }, 20_000);

  it.each(['owner_id', 'execution_version', 'attempt_id'])('quarantines mismatched workspace %s without signalling its process', async field => {
    const f = await openBindingFixture();
    const running = await launch(f);
    const stop = vi.fn(running.port.recoverStop!);
    try {
      // Seed a valid older workspace registration bound to another historical Attempt.
      // Immutable identity triggers prevent fabricating an owner/version inconsistent with that Attempt.
      f.session.database.prepare('DELETE FROM managed_workspaces').run();
      const first = f.query('SELECT * FROM attempts') as Record<string, any>;
      const a = running.claim.receipt.attempt;
      const second = { ...first, id: randomUUID(), number: 2, status: 'failed', invocation_id: null,
        owner_id: field === 'owner_id' ? 'another-owner' : a.owner,
        execution_version: field === 'execution_version' ? 42 : a.executionVersion };
      const keys = Object.keys(second);
      f.session.database.prepare(`INSERT INTO attempts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map(key => (second as Record<string, any>)[key]));
      if (field === 'execution_version') f.session.database.prepare('UPDATE tasks SET execution_version = ?').run(second.execution_version);
      registerWorkspace(f, { ...running.claim.receipt, attempt: { ...a, id: second.id,
        owner: second.owner_id, executionVersion: second.execution_version } });
      const recovery = createWorkStartupRecovery({ store: createSqliteWorkStartupRecoveryStore(f.session),
        process: { recoverStop: stop }, publishEvidence: (_project, evidence) => publish(f, evidence) });
      await recovery.recover();
      expect(stop).not.toHaveBeenCalled();
      expect(alive(running.pids[1]!)).toBe(true);
      expect(recorded(f)).toMatchObject({ stopConfirmed: false, gaps: expect.arrayContaining(['workspace_identity_mismatch']) });
      expect(f.query('SELECT status FROM managed_workspaces')).toEqual({ status: 'quarantined' });
      expect(recovery.blocked()).toBe(true);
    } finally { await cleanupProcess(running.handle); f.close(); }
  }, 15_000);

  it('rejects malformed or unknown persisted recovery events through the Host read path', async () => {
    const f = await openBindingFixture();
    f.claimTask('t-1');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      const event = f.query("SELECT id, payload FROM state_events WHERE json_extract(payload, '$.phase') = 'observed'") as { id: string; payload: string };
      for (const patch of [{ injected: true }, { projectId: randomUUID() }, { runId: randomUUID() }, { stopConfirmed: true }]) {
        f.session.database.prepare('UPDATE state_events SET payload = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(event.payload), ...patch }), event.id);
        await expect(host.core.queryService.readEventBatch(owner, { scope: { kind: 'project', projectId: f.projectId }, afterSequence: 0, limit: 500 }))
          .rejects.toMatchObject({ code: 'corrupt_state' });
      }
      f.session.database.prepare('UPDATE state_events SET payload = ?, event_type = ? WHERE id = ?')
        .run(event.payload, 'work.recovery.unrecognized', event.id);
      await expect(host.core.queryService.readEventBatch(owner, { scope: { kind: 'project', projectId: f.projectId }, afterSequence: 0, limit: 500 }))
        .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'unknown_event_type' } });
    } finally {
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close(); f.close();
    }
  });

  it('holds the claim and scan gate from Core assembly until recovery completes', async () => {
    const f = await openBindingFixture();
    const claim = f.claimTask('t-1');
    const core = await openCoreApplication({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog,
      workStartupRecoveryRequired: true, nowUtcMs: () => BINDING_NOW });
    try {
      expect(core.workExecution.recoveryState().status).toBe('recovering');
      const runsBefore = f.query('SELECT COUNT(*) AS n FROM runs');
      await expect(core.commandService.submit(owner, { ...f.startEnvelope, commandId: randomUUID() } as never))
        .rejects.toMatchObject({ code: 'resource_busy', details: { reason: 'startup_recovery' } });
      expect(f.query('SELECT COUNT(*) AS n FROM runs')).toEqual(runsBefore);
      expect(await core.workExecution.scan()).toMatchObject({ pages: 0, bounded: true, runs: [] });
      const workspace = await core.workWorkspaceAuthority.verify(f.workspace.binding, f.workspace.canonicalPath);
      expect(() => core.taskClaims.claimTask({ claimKey: randomUUID(), projectId: f.projectId,
        runId: f.runId, taskId: 't-1', expectedRevision: 2, executionVersion: 1,
        owner: 'new-owner', hostInstanceId: 'new-host', leaseUntilUtcMs: BINDING_NOW + 60_000,
        workspace, inputSnapshot: claim.inputSnapshot })).toThrow(expect.objectContaining({ details: { reason: 'startup_recovery' } }));
      await core.workExecution.recover();
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    } finally { await core.workExecution.close(); core.close(); f.close(); }
  });

  it('retains the startup gate and an authoritative diagnostic when scanning rolls back', async () => {
    const f = await openBindingFixture();
    f.claimTask('t-1');
    f.session.database.exec("CREATE TRIGGER fail_recovery_scan BEFORE UPDATE OF status ON attempts WHEN NEW.status = 'interrupted' BEGIN SELECT RAISE(ABORT, 'controlled_scan_failure'); END");
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(host.core.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'recovery_failed' });
      expect(recorded(f, 'failed')).toMatchObject({ reason: 'recovery_failed' });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'preparing' });
      expect(f.query('SELECT execution_version FROM tasks')).toEqual({ execution_version: 1 });
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 3 });
      expect(await host.core.workExecution.scan()).toMatchObject({ runs: [], pages: 0 });
      const events = await host.core.queryService.readEventBatch(owner, { scope: { kind: 'global' }, afterSequence: 0, limit: 500 });
      expect(events.events.filter(event => event.type === 'work.recovery.blocked')).toHaveLength(1);
    } finally {
      f.session.database.exec('DROP TRIGGER fail_recovery_scan');
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close(); f.close();
    }
  });

  it('records an uncertain stop when recoverStop throws, retaining identity and quarantined occupancy', async () => {
    const f = await openBindingFixture();
    const running = await launch(f);
    const stop = vi.fn(async () => { throw new Error('controlled_probe_failure'); });
    try {
      const recovery = createWorkStartupRecovery({ store: createSqliteWorkStartupRecoveryStore(f.session),
        process: { recoverStop: stop }, publishEvidence: (_project, evidence) => publish(f, evidence) });
      recovery.enter();
      await recovery.recover();
      await recovery.recover();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(alive(running.pids[1]!)).toBe(true);
      expect(recorded(f)).toMatchObject({ stopConfirmed: false, processIdentity: running.handle.identity, gaps: expect.arrayContaining(['stop_failed']) });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases WHERE state = ?', 'quarantined')).toEqual({ n: 3 });
    } finally { await cleanupProcess(running.handle); f.close(); }
  }, 15_000);

  it('keeps durable stop observations even if publishing the diagnostic Artifact fails', async () => {
    const f = await openBindingFixture();
    const running = await launch(f);
    f.session.database.exec("CREATE TRIGGER fail_recovery_artifact BEFORE INSERT ON artifacts WHEN NEW.kind = 'workspace_evidence' BEGIN SELECT RAISE(ABORT, 'controlled_artifact_failure'); END");
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(host.core.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'recovery_failed' });
      expect(recorded(f)).toMatchObject({ stopConfirmed: true, evidenceRef: null });
      expect(running.pids.every(pid => !alive(pid))).toBe(true);
      expect(recorded(f, 'failed')).toMatchObject({ reason: 'recovery_failed' });
      expect(f.query('SELECT status FROM attempts')).toEqual({ status: 'interrupted' });
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases WHERE state = ?', 'quarantined')).toEqual({ n: 3 });
      // A new coordinator must publish the durable observation without stopping twice.
      f.session.database.exec('DROP TRIGGER fail_recovery_artifact');
      const stopAgain = vi.fn(running.port.recoverStop!);
      const restarted = createWorkStartupRecovery({ store: createSqliteWorkStartupRecoveryStore(f.session),
        process: { recoverStop: stopAgain }, publishEvidence: (_project, evidence) => publish(f, evidence) });
      await restarted.recover();
      expect(stopAgain).not.toHaveBeenCalled();
      expect(recorded(f, 'recorded')).toMatchObject({ stopConfirmed: true, evidenceRef: expect.any(String) });
      expect(f.query("SELECT COUNT(*) AS n FROM state_events WHERE json_extract(payload, '$.phase') = 'observed'")).toEqual({ n: 1 });
      expect(f.query('SELECT execution_version FROM tasks')).toEqual({ execution_version: 2 });
    } finally {
      f.session.database.exec('DROP TRIGGER IF EXISTS fail_recovery_artifact');
      await cleanupProcess(running.handle);
      f.session.database.prepare('DELETE FROM workspace_leases').run();
      await host?.close(); f.close();
    }
  });

  it('fails closed with a persisted diagnostic when the bounded Run census overflows', async () => {
    const f = await openBindingFixture();
    // Distinct real Features satisfy the one-active-Run-per-Feature invariant.
    const phase = f.query('SELECT * FROM phases') as Record<string, any>;
    const feature = f.query('SELECT * FROM features') as Record<string, any>;
    const batch = f.query('SELECT * FROM execution_batches') as Record<string, any>;
    const run = f.query('SELECT * FROM runs') as Record<string, any>;
    f.session.transactWrite('test.seed-bound', () => {
      for (let i = 0; i < 129; i++) {
        const phaseId = randomUUID(), featureId = randomUUID(), batchId = randomUUID();
        const rows: [string, Record<string, any>][] = [
          ['phases', { ...phase, id: phaseId }],
          ['features', { ...feature, id: featureId, phase_id: phaseId }],
          ['execution_batches', { ...batch, id: batchId, phase_id: phaseId, feature_id: featureId }],
          ['runs', { ...run, id: randomUUID(), batch_id: batchId, feature_id: featureId }],
        ];
        for (const [table, row] of rows) {
          const keys = Object.keys(row);
          f.session.database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
        }
      }
    });
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      host = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
      expect(host.core.workExecution.recoveryState()).toEqual({ status: 'blocked', reason: 'scan_limit' });
      expect(recorded(f, 'scan_limited')).toMatchObject({ limit: 128 });
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 0 });
      expect(await host.core.workExecution.scan()).toMatchObject({ pages: 0, runs: [] });
    } finally { await host?.close(); f.close(); }
  });
});
