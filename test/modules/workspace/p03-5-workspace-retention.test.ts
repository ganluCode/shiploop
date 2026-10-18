import { expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFeatureWorktreePreparer } from '../../../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../../../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createSqliteWorkspaceAccess } from '../../../packages/core/src/adapters/sqlite/workspace.ts';
import { createWorkspacePreparationService } from '../../../packages/core/src/application/workspace-preparation.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createWorkspaceRetentionService } from '../../../packages/core/src/application/workspace-retention.ts';
import { createSqliteWorkspaceRetentionStore } from '../../../packages/core/src/adapters/sqlite/workspace-retention.ts';
import type { WorkspaceRetentionReason } from '../../../packages/core/src/ports/workspace-retention.ts';
import type { WorkResourceStopVerifier } from '../../../packages/core/src/ports/work-resources.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteCommandReceiptAccess } from '../../../packages/core/src/adapters/sqlite/command-receipts.ts';
import { createCompletedReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createResultRef } from '../../../packages/core/src/ports/command-receipts.ts';
import type { CommandProcessHandle } from '../../../packages/core/src/ports/command-process.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { git } from '../../helpers/git-repo.ts';

async function fixture(edges: string[][] = [[]]) {
  const f = await openClaimFixture(edges);
  let clock = NOW;
  function assemble(stopVerifier?: WorkResourceStopVerifier) {
    const session = f.box.session;
    const paths = createPathService({ dataRoot: f.box.box.root, projectLookup: createSqliteStateStore(session), featureLookup: createSqliteQueryStore(session) });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
    const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, stopVerifier, nowUtcMs: () => clock });
    const workspaces = createSqliteWorkspaceAccess(session, { resources, nowUtcMs: () => clock });
    const publisher = createArtifactPublisher({ artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => clock }),
      files: createArtifactFileStore({ dataRoot: f.box.box.root }), limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } });
    const publishEvidence = async (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => {
      expect(session.database.inTransaction).toBe(false);
      const body = Buffer.from(JSON.stringify(evidence));
      return (await publisher.publishArtifact({ projectId, kind: 'workspace_evidence', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body] })).artifact.id;
    };
    const confirm = async (identity: import("../../../packages/core/src/ports/command-process.ts").CommandProcessIdentity) => ({ launchId: identity.launchId });
    const preparation = createWorkspacePreparationService({
      store: createSqliteWorkspacePreparationStore(session, { resources, workspaceAuthority: authority, nowUtcMs: () => clock }), authority, resources,
      gitLock: createGitPublicMetadataLock(), preparer: createFeatureWorktreePreparer({ inspector: createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: confirm }), confirmProcessIdentity: confirm }), publishEvidence });
    const store = createSqliteWorkspaceRetentionStore(session, { resources, workspaceAuthority: authority, nowUtcMs: () => clock });
    const service = createWorkspaceRetentionService({ store, stopVerifier, publishEvidence });
    return { authority, resources, workspaces, preparation, store, service, publishEvidence };
  }
  const a = assemble();
  const token = await a.authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: a.authority, nowUtcMs: () => clock }).claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
  const preparationInput = { identity, taskId: f.ids.taskId, runId: f.ids.runId, claimKey: claim.claimKey, operationId: randomUUID(), workspaceId: randomUUID() };
  const prepared = await a.preparation.prepare(preparationInput);
  const input = (reason: WorkspaceRetentionReason = 'interrupted') => ({ identity, runId: f.ids.runId, taskId: f.ids.taskId, workspaceId: prepared.workspace.id,
    operationId: randomUUID(), expectedWorkspaceRevision: assemble().workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.revision,
    reason, evidenceRefs: prepared.operation.result!.evidenceRefs });
  return { ...f, ...a, inputTaskForPeer: () => f.input(1), token, identity, input, assemble, preparationInput, tick: () => { clock = NOW + 2000; } };
}

it.each(['authentication_failed', 'rate_limited', 'protocol_error', 'execution_error', 'verification_failed', 'timed_out', 'cancelled', 'partial', 'approval_waiting', 'interrupted'] as const)
('retains %s bytes, refs and queryable reason; distinct unstarted proof never grants Task acceptance', async reason => {
  const f = await fixture();
  try {
    const path = f.token.canonicalPath;
    const files = ['README.md', 'untracked.bin', '.gitignore', 'ignored.local'];
    files.forEach((name, i) => writeFileSync(join(path, name), name === '.gitignore' ? 'ignored.local\n' : Buffer.from([0, 255, i, 10])));
    const bytes = files.map(name => readFileSync(join(path, name))), refs = git(['show-ref'], f.box.box.repoDirA);
    const before = f.snapshot();
    const input = f.input(reason);
    const done = await f.service.retain(input);
    expect(done.workspace.status).toBe('retained');
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ reason, stop: 'not_started', reusable: false });
    expect(done.operation.result!.evidenceRefs).toHaveLength(2);
    expect(f.workspaces.readOperation(f.ids.projectId, input.operationId)).toEqual(done.operation);
    expect(f.resources.read(f.identity).leases).toEqual([]);
    expect(files.map(name => readFileSync(join(path, name)))).toEqual(bytes);
    expect(git(['show-ref'], f.box.box.repoDirA)).toBe(refs);
    expect(f.snapshot().tasks).toEqual(before.tasks);
    expect(f.snapshot().execution_batches).toEqual(before.execution_batches);
    expect(f.snapshot().runs).toEqual(before.runs);
    const events = f.snapshot().state_events;
    const replay = await f.service.retain(input);
    expect(replay.replay).toBe(true);
    expect(replay.receipt).toEqual(done.receipt);
    expect(replay.operation).toEqual(done.operation);
    expect(f.snapshot().state_events).toEqual(events);
    expect(existsSync(path)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it('persists isolation through database reopen when a launch may have started; expiry or cancellation is not proof', async () => {
  const f = await fixture();
  try {
    f.box.session.transactWrite('test.launch', () => f.resources.beginLaunchInTransaction(f.identity));
    f.tick();
    const input = f.input('cancelled');
    const done = await f.service.retain(input);
    expect(done.workspace.status).toBe('quarantined');
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ reason: 'cancelled', stop: 'unknown', reusable: false });
    f.box.reopen();
    const a = f.assemble();
    expect(a.resources.read(f.identity).leases.map(l => l.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    expect((await a.service.retain(input)).replay).toBe(true);
    await expect(a.preparation.prepare(f.preparationInput)).rejects.toThrow();
    expect(() => f.box.session.transactWrite('test.delete', () => a.workspaces.beginInTransaction({
      operationId: randomUUID(), workspaceId: done.workspace.id, featureId: f.box.featureId, kind: 'cleanup', identity: f.identity,
      executionStage: 'commit', expectedWorkspaceRevision: done.workspace.revision, baseline: done.operation.inputSnapshot.baseline, receipt: done.receipt,
    }))).toThrow();
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

function launch(f: Awaited<ReturnType<typeof fixture>>, a = f) {
  f.box.session.transactWrite('test.launch', () => {
    a.resources.beginLaunchInTransaction(f.identity);
    a.resources.confirmLaunchInTransaction(f.identity, { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'test-supervised-process' });
  });
}

it('releases a quarantined completed Attempt only after trusted stop and persistence, without reopening its outcome', async () => {
  const f = await fixture();
  let finalize = false;
  let canStop = false;
  const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: canStop }) },
    finalize: async () => { finalize = true; return true; } });
  try {
    const a = f.assemble(verifier);
    launch(f, { ...f, ...a });
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: a.authority, nowUtcMs: () => NOW });
    const common = { ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId };
    expect(lifecycle.apply({ ...common, notificationId: 'executing', kind: 'executing' }).disposition).toBe('applied');
    expect(lifecycle.apply({ ...common, notificationId: 'completed', kind: 'runtime_completed', exitCode: 1, evidenceRef: f.input().evidenceRefs[0] })).toMatchObject({ stopConfirmed: false, status: 'failed' });
    const business = f.snapshot();
    const unknown = await a.service.retain(f.input('execution_error'));
    expect(unknown.workspace.status).toBe('quarantined');
    expect(finalize).toBe(false);
    canStop = true;
    const done = await a.service.retain(f.input('execution_error'));
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ stop: 'confirmed', reusable: true });
    expect(finalize).toBe(true);
    expect(a.resources.read(f.identity).leases).toEqual([]);
    expect(f.snapshot().tasks).toEqual(business.tasks);
    expect(f.snapshot().runs).toEqual(business.runs);
    expect(f.snapshot().execution_batches).toEqual(business.execution_batches);
    expect(f.snapshot().attempts[0]).toMatchObject({ status: 'failed', ended_at: NOW, exit_code: 1 });
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it('keeps durable lifecycle release evidence distinct from missing occupancy and retains terminal preflight failures', async () => {
  const f = await fixture();
  try {
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
    expect(lifecycle.apply({ ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId, kind: 'preparation_failed', errorKind: 'configuration',
      notificationId: 'failed', evidenceRef: f.input().evidenceRefs[0] }).stopConfirmed).toBe(true);
    const done = await f.service.retain(f.input('authentication_failed'));
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ stop: 'confirmed', reusable: true });
    expect(f.snapshot().attempts[0]).toMatchObject({ status: 'failed', ended_at: NOW });
    expect(f.resources.read(f.identity).leases).toEqual([]);
  } finally { f.box.close(); }
}, 60_000);

it('does not infer never-started from Runtime fields when a preparation process lacks a stopped checkpoint', async () => {
  const f = await fixture();
  try {
    const value = { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'unknown-git-process' };
    const timestamp = new Date(NOW).toISOString();
    f.box.session.transactWrite('test.lost-stop', () => createSqliteCommandReceiptAccess(f.box.session).saveReceiptInTransaction(createCompletedReceipt({
      principalId: 'core-workspace-process', commandId: value.launchId, operation: 'execution.start', scope: { kind: 'project', projectId: f.ids.projectId },
      requestDigest: createHash('sha256').update('git-process').digest('hex'), issuedAt: timestamp, completedAt: timestamp,
      result: { workspaceId: f.input().workspaceId, value }, resultRef: createResultRef(randomBytes(32)),
    })));
    const done = await f.service.retain(f.input());
    expect(done.workspace.status).toBe('quarantined');
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ stop: 'unknown' });
    expect(f.resources.read(f.identity).leases).toHaveLength(3);
  } finally { f.box.close(); }
}, 60_000);

it.each(['publication', 'result_transaction', 'supervisor'] as const)('preserves bytes and occupancy on %s failure, then reconciles the pending intent', async fault => {
  const f = await fixture();
  let failStop = fault === 'supervisor';
  const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => { if (failStop) throw new Error('probe_failed'); return { confirmed: true }; } }, finalize: async () => true });
  try {
    const a = f.assemble(verifier);
    if (fault === 'supervisor') launch(f, { ...f, ...a });
    const sentinel = join(f.token.canonicalPath, 'protected.bin');
    writeFileSync(sentinel, Buffer.from([0, 255, 1]));
    const input = f.input();
    const faulty = createWorkspaceRetentionService({ store: a.store, stopVerifier: verifier,
      publishEvidence: fault === 'publication' ? async () => { throw new Error('publication_failed'); } : a.publishEvidence });
    if (fault === 'result_transaction') f.box.session.database.exec("CREATE TRIGGER retention_fault BEFORE UPDATE ON workspace_operations WHEN NEW.kind = 'retain' AND NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'retention_fault'); END");
    await expect(faulty.retain(input)).rejects.toThrow();
    expect(a.resources.read(f.identity).leases.map(l => l.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)!.status).toBe('pending');
    expect(readFileSync(sentinel)).toEqual(Buffer.from([0, 255, 1]));
    if (fault === 'result_transaction') f.box.session.database.exec('DROP TRIGGER retention_fault');
    failStop = false;
    f.box.reopen();
    const recovered = await f.assemble(verifier).service.retain(input);
    expect(recovered.workspace.status).toBe('retained');
    expect(f.assemble(verifier).resources.read(f.identity).leases).toEqual([]);
  } finally { f.box.close(); }
}, 60_000);

it.each(['owner', 'hostInstanceId', 'executionVersion'] as const)('fences stale %s without writing events or releasing occupancy', async field => {
  const f = await fixture();
  try {
    const input = f.input();
    const before = f.snapshot();
    await expect(f.service.retain({ ...input, identity: { ...f.identity, [field]: field === 'executionVersion' ? 2 : 'old' } })).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
  } finally { f.box.close(); }
}, 60_000);

it('rejects conflicting duplicate input and late retention after a new Attempt prepares the same workspace', async () => {
  const f = await fixture([[], []]);
  try {
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
    lifecycle.apply({ ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId, kind: 'preparation_failed', errorKind: 'configuration', notificationId: 'end', evidenceRef: f.input().evidenceRefs[0] });
    const input = f.input();
    const done = await f.service.retain(input);
    const before = f.snapshot();
    await expect(f.service.retain({ ...input, reason: 'partial' })).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW })
      .claimTask({ ...f.inputTaskForPeer(), workspace: f.token }).receipt;
    const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
    await f.preparation.prepare({ ...f.preparationInput, identity, taskId: claim.attempt.taskId, claimKey: claim.claimKey, operationId: randomUUID() });
    const current = f.snapshot();
    const workspace = f.workspaces.readWorkspace(f.ids.projectId, f.box.featureId);
    await expect(f.service.retain(input)).rejects.toThrow();
    await expect(f.service.retain({ ...input, operationId: randomUUID(), expectedWorkspaceRevision: workspace!.revision })).rejects.toThrow();
    expect(f.snapshot()).toEqual(current);
    expect(f.workspaces.readWorkspace(f.ids.projectId, f.box.featureId)).toEqual(workspace);
    expect(done.workspace.status).toBe('retained');
  } finally { f.box.close(); }
}, 60_000);

it('fences an Attempt revision changed while retention evidence is published', async () => {
  const f = await fixture();
  try {
    launch(f);
    const input = f.input();
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
    let checkpoint: ReturnType<typeof f.snapshot> | undefined;
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const a = f.assemble(verifier);
    const service = createWorkspaceRetentionService({ store: a.store, stopVerifier: verifier, publishEvidence: async (...args) => {
      const ref = await a.publishEvidence(...args);
      lifecycle.apply({ ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId, notificationId: 'race', kind: 'executing' });
      checkpoint = f.snapshot();
      return ref;
    } });
    await expect(service.retain(input)).rejects.toThrow('stale_retention_revision');
    expect(f.snapshot()).toEqual(checkpoint);
    expect(a.resources.read(f.identity).leases).toHaveLength(3);
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)!.status).toBe('pending');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it.skipIf(process.platform !== 'darwin')('keeps a real orphan child writing after parent exit isolated despite completed/cancel/failed-probe facts, and releases only after group stop', async () => {
  const f = await fixture();
  const processPort = createCommandProcessAdapter({ stopGraceMs: 100, stopConfirmMs: 2000 });
  let allowStop = false;
  const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async identity => {
    expect(f.box.session.database.inTransaction).toBe(false);
    if (!allowStop) return { confirmed: false };
    return processPort.recoverStop!(identity);
  } }, finalize: async () => true });
  const a = f.assemble(verifier);
  let handle: CommandProcessHandle | undefined;
  const sentinel = join(f.token.canonicalPath, 'child-writes');
  try {
    f.box.session.transactWrite('test.admit-process', () => a.resources.beginLaunchInTransaction(f.identity));
    const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(sentinel)},'x'),20);`;
    const parentCode = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(sentinel + '.parent')},String(process.pid));`;
    handle = await processPort.start({ argv: [process.execPath, '-e', parentCode], cwd: f.token.canonicalPath,
      environment: {}, timeoutMs: 15000, maxInputBytes: 4096, maxOutputBytes: 1024 }, async identity => {
      expect(f.box.session.transactWrite('test.confirm-process', () => a.resources.confirmLaunchInTransaction(f.identity, identity)).authorized).toBe(true);
      return { launchId: identity.launchId };
    });
    await expect.poll(() => { try { return readFileSync(sentinel).length; } catch { return 0; } }, { timeout: 3000 }).toBeGreaterThan(0);
    const parentPid = Number(readFileSync(sentinel + '.parent', 'utf8'));
    await expect.poll(() => { try { process.kill(parentPid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } }, { timeout: 3000 }).toBe(true);
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: a.authority, nowUtcMs: () => NOW });
    const common = { ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId };
    lifecycle.apply({ ...common, notificationId: 'running', kind: 'executing' });
    expect(lifecycle.apply({ ...common, notificationId: 'completed', kind: 'runtime_completed', exitCode: 0, evidenceRef: f.input().evidenceRefs[0] }).stopConfirmed).toBe(false);
    f.tick();
    const done = await a.service.retain(f.input('cancelled'));
    expect(done.workspace.status).toBe('quarantined');
    const length = readFileSync(sentinel).length;
    await expect.poll(() => readFileSync(sentinel).length, { timeout: 3000 }).toBeGreaterThan(length);
    await expect(a.preparation.prepare(f.preparationInput)).rejects.toThrow();
    expect(() => f.box.session.transactWrite('test.unsafe-release', () => a.resources.releaseUnstartedInTransaction(f.identity))).toThrow();
    expect(() => f.box.session.transactWrite('test.unsafe-stop', () => a.resources.releaseStoppedInTransaction(f.identity, { confirmed: true }))).toThrow();
    expect(() => f.box.session.transactWrite('test.delete-live-child', () => a.workspaces.beginInTransaction({
      operationId: randomUUID(), workspaceId: done.workspace.id, featureId: f.box.featureId, kind: 'cleanup', identity: f.identity,
      executionStage: 'commit', expectedWorkspaceRevision: done.workspace.revision, baseline: done.operation.inputSnapshot.baseline, receipt: done.receipt,
    }))).toThrow();
    const retry = f.input('interrupted');
    f.box.reopen();
    expect(f.assemble(verifier).resources.read(f.identity).leases.map(l => l.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
    allowStop = true;
    const stopped = await f.assemble(verifier).service.retain(retry);
    expect(stopped.workspace.status).toBe('retained');
    expect(stopped.receipt.status === 'completed' && stopped.receipt.result).toMatchObject({ stop: 'confirmed', reusable: false });
    expect(f.assemble(verifier).resources.read(f.identity).leases).toEqual([]);
    expect(existsSync(sentinel)).toBe(true);
  } finally {
    if (handle) {
      expect(await processPort.recoverStop!(handle.identity)).toEqual({ confirmed: true });
      await handle.cancel();
      await handle.result;
    }
    f.box.close();
  }
}, 60_000);
