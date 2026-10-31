import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { processRows } from '../../helpers/process-matrix.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { openDrillFixture, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';

const fixtures: DrillFixture[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toMatchObject({ status: 'passed' });
});
const q = (f: DrillFixture, sql: string, ...args: unknown[]) => f.q(sql, ...args) as Record<string, any>;
const budget = (f: DrillFixture) => q(f, 'SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');
const latest = (f: DrillFixture) => q(f, 'SELECT * FROM attempts ORDER BY created_at DESC, number DESC LIMIT 1');
async function connect(f: DrillFixture) {
  const client = await connectToHost({ canonicalRoot: f.dataRoot,
    timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
  clients.push(client);
  return client;
}
async function capture(f: DrillFixture, scenario: string, phase: 'before' | 'after', runId: string) {
  const evidence = await f.collectDrillEvidence(scenario, phase, { runId });
  // Optional export retains actual facts after temporary resources have been removed.
  if (process.env.SHIPLOOP_P07_EVIDENCE_DIR) {
    mkdirSync(process.env.SHIPLOOP_P07_EVIDENCE_DIR, { recursive: true });
    const probe = openSqliteStorageSession({ path: f.dbPath });
    let rows: Record<string, unknown>;
    try {
      rows = Object.fromEntries(['attempts', 'tasks', 'runs', 'managed_workspaces', 'workspace_leases',
        'repository_bindings', 'execution_batches', 'run_dispatch_claims', 'execution_slot_claims', 'verification_processes']
        .map(table => [table, probe.database.prepare(`SELECT * FROM ${table}`).all()]));
    } finally { probe.close(); }
    const observed = (await processRows()).filter(row => evidence.processes.some(p => p.pid === row.pid));
    const serialized = JSON.stringify({ ...evidence, rows, observed }, null, 2).replaceAll(f.root, '<fixture>');
    expect(serialized).not.toContain(f.sensitiveSentinelValue);
    expect(serialized).not.toContain(f.bearerSentinelValue);
    writeFileSync(join(process.env.SHIPLOOP_P07_EVIDENCE_DIR,
      `${scenario}-${runId}-${evidence.identity.attempt}.json`), serialized);
  }
  return evidence;
}

function fenceLateResults(f: DrillFixture, old: Record<string, any>) {
  const session = openSqliteStorageSession({ path: f.dbPath });
  try {
    const lifecycle = createSqliteAttemptLifecycleStore(session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.root] }), nowUtcMs: Date.now,
    });
    const identity = { projectId: old.project_id, runId: old.run_id, taskId: old.task_id,
      attemptId: old.id, owner: old.owner_id, hostInstanceId: old.host_instance_id, executionVersion: old.execution_version };
    const before = q(f, 'SELECT status, execution_version, revision FROM tasks WHERE id = ?', old.task_id);
    for (const fields of [{}, { owner: 'stale-owner' }, { hostInstanceId: 'stale-host' },
      { executionVersion: old.execution_version + 10 }]) {
      expect(lifecycle.apply({ ...identity, ...fields, notificationId: `late-${randomUUID()}`,
        kind: 'runtime_completed', exitCode: 0, evidenceRef: old.input_ref }))
        .toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
    }
    expect(q(f, 'SELECT status, execution_version, revision FROM tasks WHERE id = ?', old.task_id)).toEqual(before);
  } finally { session.close(); }
}

async function cli(f: DrillFixture, args: string[]) {
  let output = '';
  const result = await runAppCli({ args: [...args, '--data-root', f.dataRoot, '--json'], env: {},
    io: { stdout: value => { output += value; }, stderr: () => {} } });
  return { exitCode: result.exitCode, envelope: JSON.parse(output) };
}

describe.skipIf(process.platform !== 'darwin')('P07-5 F-003 verifier crash and explicit recovery', () => {
  it('[case:p07-stage-resume-prefix-budget] preserves passed prefix and dirty code, admits one overlapping resume, and keeps dependencies locked after failed revalidation', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f003-', taskCount: 3 });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    const [passedId, currentId, blockedId] = f.projectA.taskIds;
    expect(blockedId).toBeDefined();
    const first = await f.spawnDrillHost({ label: 'f003-finalized', progressWrites: true,
      barriers: { commitEntry: true, taskId: currentId } });
    const boundary = await f.awaitBarrier(first, 'entered_commit', 120_000);
    expect(boundary.taskId).toBe(currentId);
    await waitFor(() => q(f, `SELECT coverage, finalized FROM recording_manifests
      WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ? ORDER BY number DESC LIMIT 1)
      ORDER BY version DESC LIMIT 1`, currentId)?.finalized === 1,
    'Recorder publishes the final manifest before the safe recovery boundary', 20_000);
    const old = latest(f);
    const workspace = q(f, 'SELECT * FROM managed_workspaces WHERE feature_id = ?', f.projectA.featureId);
    expect(q(f, 'SELECT status FROM tasks WHERE id = ?', passedId)).toEqual({ status: 'passed' });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 0 });
    expect(git(['status', '--porcelain'], workspace.canonical_path)).toContain(' M progress.txt');
    expect(git(['status', '--porcelain'], workspace.canonical_path)).toContain('?? pending-2.txt');
    const tracked = readFileSync(join(workspace.canonical_path, 'progress.txt'), 'utf8');
    const untracked = readFileSync(join(workspace.canonical_path, 'pending-2.txt'), 'utf8');
    const before = budget(f);
    await capture(f, 'f003-prefix-resume', 'before', runId);
    expect(first.kill('SIGKILL')).toBe(true);
    expect((await first.exited).signal).toBe('SIGKILL');

    const restart = await f.spawnDrillHost({ label: 'f003-restart', verifierTestCount: 0,
      barriers: { verificationEntry: true, taskId: currentId } });
    expect(q(f, 'SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(q(f, 'SELECT status FROM runs WHERE id = ?', runId)).toEqual({ status: 'paused' });
    const diagnosis = await createArtifactFileStore({ dataRoot: f.dataRoot }).openFinalRead({
      projectId: f.projectA.projectId,
      artifactId: q(f, 'SELECT diagnostic_ref FROM attempts WHERE id = ?', old.id).diagnostic_ref,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of diagnosis.stream) chunks.push(Buffer.from(chunk));
    const recordingFiles = q(f, `SELECT json_group_array(json_object('id', id, 'kind', kind, 'locator', storage_locator)) AS files
      FROM artifacts WHERE storage_locator LIKE ?`, `sessions/${old.session_id}/%`);
    expect(q(f, 'SELECT status FROM managed_workspaces WHERE id = ?', workspace.id),
      Buffer.concat(chunks).toString('utf8') + JSON.stringify(recordingFiles))
      .toEqual({ status: 'retained' });
    expect(budget(f)).toEqual(before);
    expect(f.runtimeStarts()).toHaveLength(2);
    await capture(f, 'f003-prefix-resume', 'after', runId);
    const client = await connect(f);
    const request = { projectId: f.projectA.projectId, runId,
      expectedRevision: q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const racers = [0, 1].map(async () => { await gate; return client.resumeExecution(request); });
    release();
    const results = await Promise.allSettled(racers);
    const completed = results.flatMap(r => r.status === 'fulfilled' && r.value.status === 'completed' ? [r.value] : []);
    expect(completed).toHaveLength(1);
    const winner = completed[0]!;
    expect(await client.resumeExecution(request, { commandId: winner.commandId, issuedAt: winner.issuedAt }))
      .toMatchObject({ replayed: true, status: 'completed' });
    await expect(client.resumeExecution({ ...request, expectedRevision: request.expectedRevision + 10 },
      { commandId: winner.commandId, issuedAt: winner.issuedAt })).rejects.toMatchObject({ code: 'conflict' });
    await f.awaitBarrier(restart, 'entered_verification', 120_000);
    expect(latest(f)).toMatchObject({ task_id: currentId, number: old.number + 1 });
    fenceLateResults(f, old);
    expect(readFileSync(join(workspace.canonical_path, 'progress.txt'), 'utf8')).toBe(tracked);
    expect(readFileSync(join(workspace.canonical_path, 'pending-2.txt'), 'utf8')).toBe(untracked);
    expect(q(f, 'SELECT id FROM managed_workspaces WHERE feature_id = ?', f.projectA.featureId)).toEqual({ id: workspace.id });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', passedId)).toEqual({ n: 1 });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 0 });
    f.releaseBarrier(restart, 'entered_verification');
    expect(await restart.waitMessage('verifier_result', 30_000)).toMatchObject({ status: 'inconclusive' });
    expect(q(f, 'SELECT status FROM tasks WHERE id = ?', currentId).status).not.toBe('passed');
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 0 });
    expect(q(f, 'SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(budget(f)).toEqual({ ...before, attempts_created: before.attempts_created + 1, runtime_starts: before.runtime_starts + 1 });
    expect(f.runtimeStarts()).toHaveLength(3);
    await capture(f, 'f003-prefix-resume', 'after', runId);
  }, 240_000);

  it('[case:p07-stage-verifier-wait-quarantine] kills the Host while a real Verifier waits, preserves the incomplete batch and refuses CLI resume', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f003-wait-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    const first = await f.spawnDrillHost({ label: 'f003-wait', verifierHold: true,
      barriers: { verificationEntry: true } });
    await f.awaitBarrier(first, 'entered_verification');
    const old = latest(f);
    expect(q(f, 'SELECT status FROM verification_batches WHERE attempt_id = ?', old.id)).toEqual({ status: 'running' });
    expect(q(f, 'SELECT COUNT(*) AS n FROM verification_processes')).toEqual({ n: 1 });
    const before = budget(f);
    await capture(f, 'f003-wait', 'before', runId);
    expect(first.kill('SIGKILL')).toBe(true);
    expect((await first.exited).signal).toBe('SIGKILL');
    await capture(f, 'f003-wait-killed', 'after', runId);
    await f.spawnDrillHost({ label: 'f003-wait-restart' });
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    expect(recovery.startup.workspace).toMatchObject({ status: 'quarantined' });
    expect(recovery.startup.nextSteps.find(s => s.action === 'execution.resume')?.executable).toBe(false);
    const refused = await cli(f, ['execution', 'resume', '--project', f.projectA.projectId, '--run', runId,
      '--revision', String(q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision)]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject({ ok: false });
    fenceLateResults(f, old);
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId)).toEqual({ n: 0 });
    expect(q(f, 'SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(budget(f)).toEqual(before);
    expect(f.runtimeStarts()).toHaveLength(1);
    await capture(f, 'f003-wait', 'after', runId);
  }, 150_000);

  it('[case:p07-stage-unrelated-writer] refuses a persisted PID with a mismatched start identity while the real unrelated process continues writing', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f003-identity-' });
    fixtures.push(f);
    const ready = join(f.markerDir, 'unrelated.pid');
    const heartbeat = join(f.markerDir, 'unrelated-heartbeat');
    const writer = f.spawnCommand('unrelated-writer', [process.execPath, '-e',
      `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => fs.appendFileSync(process.argv[2], 'tick\\n'), 20);`, ready, heartbeat]);
    await waitFor(() => existsSync(ready) && existsSync(heartbeat), 'unrelated writer ready');
    const { runId } = await f.startRun('a');
    const first = await f.spawnDrillHost({ label: 'f003-identity', verifierHold: true,
      verifierIdentityOverride: { pid: writer.pid, processGroupId: writer.pid, startTime: 'unrelated-process-start' },
      barriers: { verificationEntry: true } });
    await f.awaitBarrier(first, 'entered_verification');
    const old = latest(f);
    const before = budget(f);
    await capture(f, 'f003-identity', 'before', runId);
    expect(first.kill('SIGKILL')).toBe(true);
    await first.exited;
    await f.spawnDrillHost({ label: 'f003-identity-restart' });
    const size = statSync(heartbeat).size;
    await waitFor(() => statSync(heartbeat).size > size, 'writer still active after recovery observation');
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    expect(recovery.startup.observations[0]).toMatchObject({ stopConfirmed: false });
    expect(recovery.startup.workspace).toMatchObject({ status: 'quarantined' });
    await expect(client.resumeExecution({ projectId: f.projectA.projectId, runId,
      expectedRevision: q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision }))
      .rejects.toMatchObject({ code: 'resource_busy' });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(f.runtimeStarts()).toHaveLength(1);
    fenceLateResults(f, old);
    expect(budget(f)).toEqual(before);
    await capture(f, 'f003-identity', 'after', runId);
  }, 150_000);

  it.each(['branch', 'binding'] as const)('[case:p07-stage-workspace-drift-%s] refuses changed workspace or repository binding identity without resetting files or granting another writer', async drift => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f003-drift-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    const first = await f.spawnDrillHost({ label: 'f003-drift', barriers: { commitEntry: true } });
    await f.awaitBarrier(first, 'entered_commit');
    const workspace = f.workspaceRow('a')!;
    const before = budget(f);
    await capture(f, 'f003-drift', 'before', runId);
    expect(first.kill('SIGKILL')).toBe(true);
    await first.exited;
    if (drift === 'branch') {
      git(['symbolic-ref', 'HEAD', 'refs/heads/external-writer'], workspace.canonical_path);
      // Give the external branch a real HEAD; preserve every working tree byte.
      git(['update-ref', 'refs/heads/external-writer', workspace.base_commit], workspace.canonical_path);
    } else {
      // Same path and bytes, different real common-directory entity. PID/path
      // equality cannot authorize adoption of a replaced repository binding.
      const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace.canonical_path).trim();
      cpSync(common, `${common}.replacement`, { recursive: true });
      renameSync(common, `${common}.original`);
      renameSync(`${common}.replacement`, common);
    }
    await f.spawnDrillHost({ label: 'f003-drift-restart' });
    const client = await connect(f);
    expect((await client.getRunRecovery(f.projectA.projectId, runId)).startup.workspace)
      .toMatchObject({ status: 'quarantined' });
    await expect(client.resumeExecution({ projectId: f.projectA.projectId, runId,
      expectedRevision: q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision }))
      .rejects.toMatchObject({ code: 'resource_busy' });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
    expect(readFileSync(join(workspace.canonical_path, f.runtimeTarget.path), 'utf8')).toBe(f.runtimeTarget.content);
    expect(git(['symbolic-ref', '--short', 'HEAD'], workspace.canonical_path).trim())
      .toBe(drift === 'branch' ? 'external-writer' : workspace.branch);
    expect(budget(f)).toEqual(before);
    await capture(f, `f003-drift-${drift}`, 'after', runId);
  }, 150_000);

  it('[case:p07-stage-cancel-completion-race] cancellation at the finalized verifier barrier fences completion and never unlocks the dependent Task', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f003-cancel-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    const child = await f.spawnDrillHost({ label: 'f003-cancel', barriers: { commitEntry: true } });
    await f.awaitBarrier(child, 'entered_commit');
    const before = budget(f);
    const old = latest(f);
    const client = await connect(f);
    await capture(f, 'f003-cancel', 'before', runId);
    const cancelling = client.cancelExecution({ projectId: f.projectA.projectId, runId,
      expectedRevision: q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision });
    await waitFor(() => ['cancelling', 'cancelled'].includes(q(f, 'SELECT status FROM runs WHERE id = ?', runId).status),
      'cancellation committed while completion is held');
    f.releaseBarrier(child, 'entered_commit');
    await cancelling;
    await child.waitMessage(['verifier_error', 'verifier_completion'], 30_000);
    expect(q(f, 'SELECT status FROM tasks WHERE id = ?', old.task_id).status).not.toBe('passed');
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId)).toEqual({ n: 0 });
    expect(q(f, 'SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(budget(f)).toEqual(before);
    expect(f.runtimeStarts()).toHaveLength(1);
    await capture(f, 'f003-cancel', 'after', runId);
  }, 150_000);
});
