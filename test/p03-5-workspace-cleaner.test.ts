import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFeatureWorktreePreparer } from '../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createFeatureWorktreeCleaner } from '../packages/core/src/adapters/fs/feature-worktree-cleaner.ts';
import { createGitPublicMetadataLock } from '../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteTaskClaimStore } from '../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createSqliteWorkspaceAccess } from '../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteWorkspaceCleanerStore } from '../packages/core/src/adapters/sqlite/workspace-cleaner.ts';
import { createWorkspacePreparationService } from '../packages/core/src/application/workspace-preparation.ts';
import { createWorkspaceCleanerService } from '../packages/core/src/application/workspace-cleaner.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { decideWorkspaceCleanup } from '../packages/core/src/application/workspace-cleanup-policy.ts';
import type { WorkspaceCleanupDecision } from '../packages/core/src/ports/workspace-cleanup.ts';
import type { WorkspaceCleanerInput } from '../packages/core/src/ports/workspace-cleaner.ts';
import type { WorkResourceStopVerifier } from '../packages/core/src/ports/work-resources.ts';
import type { CommandProcessPort, CommandProcessIdentity } from '../packages/core/src/ports/command-process.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createWorkResourceStopVerifier } from '../packages/core/src/application/work-resource-stop.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { git } from './helpers/git-repo.ts';


function resultReason(done: { receipt: { status: string; result?: unknown } }): unknown {
  return done.receipt.status === 'completed' ? (done.receipt.result as Record<string, unknown>).reason : undefined;
}


async function fixture(edges: string[][] = [[]]) {
  const f = await openClaimFixture(edges);
  let clock = NOW;
  const confirm = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });
  function assemble(stopVerifier?: WorkResourceStopVerifier) {
    const session = f.box.session;
    const paths = createPathService({ dataRoot: f.box.box.root, projectLookup: createSqliteStateStore(session), featureLookup: createSqliteQueryStore(session) });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
    const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, stopVerifier, nowUtcMs: () => clock });
    const workspaces = createSqliteWorkspaceAccess(session, { resources, nowUtcMs: () => clock });
    const inspector = createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: confirm });
    const publisher = createArtifactPublisher({ artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => clock }),
      files: createArtifactFileStore({ dataRoot: f.box.box.root }), limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } });
    const publishEvidence = async (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => {
      expect(session.database.inTransaction).toBe(false);
      const body = Buffer.from(JSON.stringify(evidence));
      return (await publisher.publishArtifact({ projectId, kind: 'workspace_evidence', mediaType: 'application/json',
        expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body] })).artifact.id;
    };
    const preparation = createWorkspacePreparationService({
      store: createSqliteWorkspacePreparationStore(session, { resources, workspaceAuthority: authority, nowUtcMs: () => clock }), authority, resources,
      gitLock: createGitPublicMetadataLock(), preparer: createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: confirm }), publishEvidence });
    const cleanerStore = createSqliteWorkspaceCleanerStore(session, { resources, nowUtcMs: () => clock, maxDecisionAgeMs: 60_000 });
    const cleanerService = createWorkspaceCleanerService({ store: cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector, confirmProcessIdentity: confirm }), publishEvidence });
    return { authority, resources, workspaces, inspector, preparation, cleanerStore, cleanerService, publishEvidence };
  }
  const a = assemble();
  const token = await a.authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: a.authority, nowUtcMs: () => clock }).claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
  const preparationInput = { identity, taskId: f.ids.taskId, runId: f.ids.runId, claimKey: claim.claimKey, operationId: randomUUID(), workspaceId: randomUUID() };
  const prepared = await a.preparation.prepare(preparationInput);
  const baseline = {
    repositoryBindingId: prepared.workspace.repositoryBindingId, repositoryBindingRevision: prepared.workspace.repositoryBindingRevision,
    repoIdentity: prepared.workspace.repoIdentity, canonicalPath: prepared.workspace.canonicalPath,
    gitCommonDir: prepared.workspace.gitCommonDir, branch: prepared.workspace.branch, baseCommit: prepared.workspace.baseCommit,
  };
  async function succeed() {
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const v = assemble(verifier);
    f.box.session.transactWrite('test.launch', () => {
      v.resources.beginLaunchInTransaction(identity);
      v.resources.confirmLaunchInTransaction(identity, { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'test-supervised-process' });
    });
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: v.authority, stopVerifier: verifier, nowUtcMs: () => clock });
    const common = { ...identity, taskId: f.ids.taskId, runId: f.ids.runId };
    expect(lifecycle.apply({ ...common, notificationId: 'executing', kind: 'executing' }).disposition).toBe('applied');
    const stopToken = await verifier.verify(v.resources.read(identity));
    const done = lifecycle.apply({ ...common, notificationId: 'completed', kind: 'runtime_completed', exitCode: 0,
      evidenceRef: prepared.operation.result!.evidenceRefs[0]! }, stopToken ?? undefined);
    expect(done).toMatchObject({ disposition: 'applied', stopConfirmed: true, resultSaved: true });
    expect(v.resources.read(identity).leases).toEqual([]);
  }
  function decision(at = NOW): WorkspaceCleanupDecision {
    const evidence = [{ ref: prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: at - 10, expiresAtUtcMs: at + 100_000 }];
    return decideWorkspaceCleanup({ nowUtcMs: at,
      inspection: { verified: true, scanComplete: true, evidence },
      execution: { runtimeOutcome: 'completed', acceptance: 'passed', manualReview: 'none', evidence },
      stop: { state: 'confirmed', evidence },
      occupancy: { activeLeases: 0, processActive: false, quarantined: false, evidence },
      delivery: { artifactsPolicy: 'not_required', artifactsSaved: true, commitCapability: 'assembled', commitStatus: 'not_required', requiredDeliveriesComplete: true, evidence },
      contents: { trackedChanges: 0, untrackedChanges: 0, ignored: [], evidence },
      authorization: { autoCleanup: true, grantedBy: 'owner-1', evidence } });
  }
  async function expected(a2: ReturnType<typeof assemble>) {
    const inspection = await a2.inspector.inspect(baseline);
    return { headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest, ignoredDigest: inspection.ignoredDigest };
  }
  function cleanInput(exp: { headCommit: string; codeDigest: string; ignoredDigest: string }, dec = decision(), operationId: string = randomUUID()): WorkspaceCleanerInput {
    const revision = assemble().workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.revision;
    return { identity, runId: f.ids.runId, taskId: f.ids.taskId, workspaceId: prepared.workspace.id, operationId,
      expectedWorkspaceRevision: revision, decision: dec, expected: exp, evidenceRefs: prepared.operation.result!.evidenceRefs };
  }
  return { ...f, ...a, assemble, token, identity, preparationInput, prepared, baseline, succeed, decision, expected, cleanInput,
    tick: () => { clock = NOW + 2000; } };
}

it('cleans a safe successful worktree non-forcibly inside the Git lock, preserving branch, source, attempts and audit', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const worktree = f.token.canonicalPath;
    const source = f.box.box.repoDirA;
    // Work committed on the managed branch advances HEAD beyond the preparation base commit.
    writeFileSync(join(worktree, 'feature.txt'), 'delivered work');
    git(['add', 'feature.txt'], worktree);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'feature work'], worktree);
    writeFileSync(join(source, 'source-local.txt'), 'keep me');
    const sourceHead = git(['rev-parse', 'HEAD'], source).trim();
    const sourceRefs = git(['show-ref'], source);
    const sourceIndex = readFileSync(join(source, '.git', 'index'));
    const exp = await f.expected(a);
    expect(exp.headCommit).not.toBe(f.baseline.baseCommit);
    const business = f.snapshot();
    const events: string[] = [];
    const realLock = createGitPublicMetadataLock();
    const spyLock = { acquire: async (lockInput: Parameters<ReturnType<typeof createGitPublicMetadataLock>['acquire']>[0]) => {
      const lease = await realLock.acquire(lockInput);
      events.push('acquire');
      return { release: async () => { events.push('release'); await lease.release(); } };
    }, releaseRecovered: (lockInput: Parameters<typeof realLock.releaseRecovered>[0]) => realLock.releaseRecovered(lockInput) };
    const store = { ...a.cleanerStore, finish: (...args: Parameters<typeof a.cleanerStore.finish>) => {
      events.push('finish');
      return a.cleanerStore.finish(...args);
    } };
    const service = createWorkspaceCleanerService({ store, gitLock: spyLock, cleaner: createFeatureWorktreeCleaner({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }), publishEvidence: a.publishEvidence });
    const input = f.cleanInput(exp);
    const done = await service.clean(input);
    expect(done.operation.status).toBe('succeeded');
    expect(done.workspace.status).toBe('cleaned');
    expect(done.workspace.headCommit).toBe(exp.headCommit);
    expect(done.workspace.codeDigest).toBe(exp.codeDigest);
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ removed: true, recovered: false, reason: null });
    expect(events).toEqual(['acquire', 'finish', 'release']);
    // Directory and registration are gone; the Feature branch and commits stay readable.
    expect(existsSync(worktree)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], source)).not.toContain(worktree);
    expect(git(['rev-parse', `refs/heads/${f.baseline.branch}`], source).trim()).toBe(exp.headCommit);
    expect(git(['cat-file', '-t', exp.headCommit], source).trim()).toBe('commit');
    // Source repository HEAD, refs, index and dirty bytes are untouched.
    expect(git(['rev-parse', 'HEAD'], source).trim()).toBe(sourceHead);
    expect(git(['show-ref'], source)).toBe(sourceRefs);
    expect(readFileSync(join(source, '.git', 'index'))).toEqual(sourceIndex);
    expect(readFileSync(join(source, 'source-local.txt'))).toEqual(Buffer.from('keep me'));
    // Business success is not rewritten; Attempt/Task/Run facts are unchanged.
    expect(f.snapshot().tasks).toEqual(business.tasks);
    expect(f.snapshot().attempts).toEqual(business.attempts);
    expect(f.snapshot().runs).toEqual(business.runs);
    expect(f.snapshot().execution_batches).toEqual(business.execution_batches);
    // Workspace history, operation audit and evidence artifacts remain readable.
    const workspace = a.workspaces.readWorkspace(f.ids.projectId, f.box.featureId);
    expect(workspace).toMatchObject({ id: f.prepared.workspace.id, status: 'cleaned', headCommit: exp.headCommit });
    const operations = a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items;
    expect(operations.map(o => o.kind).sort()).toEqual(['cleanup', 'prepare']);
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)).toEqual(done.operation);
    for (const ref of done.operation.result!.evidenceRefs) {
      expect(f.box.session.database.prepare("SELECT id FROM artifacts WHERE id = ? AND status = 'ready'").get(ref)).toBeTruthy();
    }
  } finally { f.box.close(); }
}, 60_000);

it('replays the identical command as the original operation without new events or repeated Git effects', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const input = f.cleanInput(exp);
    const done = await a.cleanerService.clean(input);
    const after = f.snapshot();
    const replay = await a.cleanerService.clean(input);
    expect(replay.replay).toBe(true);
    expect(replay.operation).toEqual(done.operation);
    expect(replay.receipt).toEqual(done.receipt);
    expect(f.snapshot()).toEqual(after);
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    await expect(a.cleanerService.clean({ ...input, evidenceRefs: [] })).rejects.toThrow();
    await expect(a.cleanerService.clean({ ...input, expected: { ...exp, headCommit: '0'.repeat(40) } })).rejects.toThrow();
    expect(f.snapshot()).toEqual(after);
  } finally { f.box.close(); }
}, 60_000);

it.each(['tracked', 'untracked', 'ignored'] as const)('refuses and preserves %s content introduced after the authorized summary', async kind => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const worktree = f.token.canonicalPath;
    const exp = await f.expected(a);
    if (kind === 'tracked') {
      writeFileSync(join(worktree, 'README.md'), 'modified');
      git(['add', 'README.md'], worktree);
    } else if (kind === 'untracked') {
      writeFileSync(join(worktree, 'new-file.bin'), Buffer.from([0, 255, 7]));
    } else {
      writeFileSync(join(worktree, '.gitignore'), 'local.ignored\n');
      git(['add', '.gitignore'], worktree);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore rules'], worktree);
      const committed = await f.expected(a);
      exp.headCommit = committed.headCommit; exp.codeDigest = committed.codeDigest;
      writeFileSync(join(worktree, 'local.ignored'), Buffer.from([9, 9, 9]));
    }
    const bytes = kind === 'tracked' ? readFileSync(join(worktree, 'README.md'))
      : readFileSync(join(worktree, kind === 'untracked' ? 'new-file.bin' : 'local.ignored'));
    const input = f.cleanInput(exp);
    const done = await a.cleanerService.clean(input);
    expect(done.operation.status).toBe('failed');
    expect(done.workspace.status).toBe('ready');
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ removed: false, recovered: false });
    expect(String(resultReason(done))).toMatch(/changed/);
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(worktree, kind === 'tracked' ? 'README.md' : kind === 'untracked' ? 'new-file.bin' : 'local.ignored'))).toEqual(bytes);
    expect(git(['rev-parse', `refs/heads/${f.baseline.branch}`], f.box.box.repoDirA).trim()).toBe(exp.headCommit);
    // The failed operation is terminal audit; a stale replay cannot overwrite a later operation.
    const replay = await a.cleanerService.clean(input);
    expect(replay.operation).toEqual(done.operation);
  } finally { f.box.close(); }
}, 60_000);

it('refuses an external HEAD move before deletion and keeps the directory', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const worktree = f.token.canonicalPath;
    const exp = await f.expected(a);
    writeFileSync(join(worktree, 'external.txt'), 'external commit');
    git(['add', 'external.txt'], worktree);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'external'], worktree);
    const done = await a.cleanerService.clean(f.cleanInput(exp));
    expect(done.operation.status).toBe('failed');
    expect(String(resultReason(done))).toBe('head_or_digest_changed');
    expect(existsSync(worktree)).toBe(true);
    expect(git(['rev-parse', 'HEAD'], worktree).trim()).not.toBe(exp.headCommit);
  } finally { f.box.close(); }
}, 60_000);

it('records a failed operation when approval changes after intent registration and never deletes', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const store = { ...a.cleanerStore, recheckAuthorization: (input: Parameters<typeof a.cleanerStore.recheckAuthorization>[0], intent: Parameters<typeof a.cleanerStore.recheckAuthorization>[1]) => {
      f.box.session.database.prepare('UPDATE tasks SET manual_block = 1 WHERE id = ?').run(f.ids.taskId);
      return a.cleanerStore.recheckAuthorization(input, intent);
    } };
    const service = createWorkspaceCleanerService({ store, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }), publishEvidence: a.publishEvidence });
    const input = f.cleanInput(exp);
    const done = await service.clean(input);
    expect(done.operation.status).toBe('failed');
    expect(done.workspace.status).toBe('ready');
    expect(String(resultReason(done))).toBe('approval_changed');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA)).toContain(f.token.canonicalPath);
  } finally { f.box.close(); }
}, 60_000);

it('rejects stale, future or non-cleanable decisions at registration without side effects', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const before = f.snapshot();
    const retain = decideWorkspaceCleanup({ nowUtcMs: NOW,
      inspection: { verified: true, scanComplete: true, evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      execution: { runtimeOutcome: 'failed', acceptance: 'failed', manualReview: 'none', evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      stop: { state: 'confirmed', evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      occupancy: { activeLeases: 0, processActive: false, quarantined: false, evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      delivery: { artifactsPolicy: 'not_required', artifactsSaved: true, commitCapability: 'assembled', commitStatus: 'not_required', requiredDeliveriesComplete: true, evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      contents: { trackedChanges: 0, untrackedChanges: 0, ignored: [], evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] },
      authorization: { autoCleanup: true, grantedBy: 'owner-1', evidence: [{ ref: f.prepared.operation.result!.evidenceRefs[0]!, observedAtUtcMs: NOW - 10, expiresAtUtcMs: NOW + 100_000 }] } });
    expect(retain.outcome).toBe('retain');
    await expect(a.cleanerService.clean(f.cleanInput(exp, retain))).rejects.toThrow(/decision_not_cleanable/);
    await expect(a.cleanerService.clean(f.cleanInput(exp, f.decision(NOW - 120_000)))).rejects.toThrow(/decision_expired/);
    await expect(a.cleanerService.clean(f.cleanInput(exp, f.decision(NOW + 120_000)))).rejects.toThrow(/decision_expired/);
    expect(f.snapshot()).toEqual(before);
    expect(a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items.map(o => o.kind)).toEqual(['prepare']);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it('requires durable success, trusted stop and release evidence before registering a cleanup intent', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    const exp = await f.expected(a);
    await expect(a.cleanerService.clean(f.cleanInput(exp))).rejects.toThrow(/execution_not_succeeded/);
    const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async () => ({ confirmed: true }) }, finalize: async () => true });
    const v = f.assemble(verifier);
    f.box.session.transactWrite('test.launch', () => {
      v.resources.beginLaunchInTransaction(f.identity);
      v.resources.confirmLaunchInTransaction(f.identity, { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'test-supervised-process' });
    });
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: v.authority, stopVerifier: verifier, nowUtcMs: () => NOW });
    const common = { ...f.identity, taskId: f.ids.taskId, runId: f.ids.runId };
    lifecycle.apply({ ...common, notificationId: 'executing', kind: 'executing' });
    const failed = lifecycle.apply({ ...common, notificationId: 'completed', kind: 'runtime_completed', exitCode: 1, evidenceRef: f.prepared.operation.result!.evidenceRefs[0]! });
    expect(failed).toMatchObject({ disposition: 'applied', stopConfirmed: false });
    await expect(v.cleanerService.clean(f.cleanInput(exp))).rejects.toThrow(/execution_not_succeeded|release_evidence_missing|occupancy_active/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it('keeps the workspace and records the reason when non-force Git removal refuses; never downgrades to force', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const { createCommandProcessAdapter } = await import('../packages/core/src/adapters/process/command-process.ts');
    const delegate = createCommandProcessAdapter();
    const argvLog: string[][] = [];
    const processes: CommandProcessPort = { async start(request, acknowledge, signal) {
      argvLog.push([...request.argv]);
      if (request.argv.includes('worktree') && request.argv.includes('remove')) {
        const identity: CommandProcessIdentity = { launchId: randomUUID(), pid: 321, processGroupId: 321, startTime: 'fake-remove' };
        await acknowledge(identity);
        return { identity, query: () => ({ identity, state: 'stopped' as const, bufferedOutputBytes: 0 }),
          output: { async *[Symbol.asyncIterator]() { /* empty */ } },
          result: Promise.resolve({ exitCode: 128, signal: null, reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: true } }),
          stopped: Promise.resolve({ confirmed: true }), cancel: async () => ({ accepted: true }) };
      }
      return delegate.start(request, acknowledge, signal);
    } };
    const service = createWorkspaceCleanerService({ store: a.cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector: createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
        commandProcess: processes, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }), publishEvidence: a.publishEvidence });
    const done = await service.clean(f.cleanInput(exp));
    expect(done.operation.status).toBe('failed');
    expect(String(resultReason(done))).toBe('git_removal_refused');
    const removal = argvLog.find(argv => argv.includes('worktree') && argv.includes('remove'));
    expect(removal).toBeTruthy();
    expect(removal).not.toContain('--force');
    expect(removal).not.toContain('-f');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA)).toContain(f.token.canonicalPath);
  } finally { f.box.close(); }
}, 60_000);

it('blocks and quarantines when the removal process stop is unconfirmed, without deleting bytes', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const processes: CommandProcessPort = { async start(request) {
      const identity: CommandProcessIdentity = { launchId: randomUUID(), pid: 322, processGroupId: 322, startTime: 'fake-remove' };
      return { identity, query: () => ({ identity, state: 'uncertain' as const, bufferedOutputBytes: 0 }),
        output: { async *[Symbol.asyncIterator]() { /* empty */ } },
        result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: false } }),
        stopped: Promise.resolve({ confirmed: false }), cancel: async () => ({ accepted: true }) };
    } };
    // The fake only intercepts the mutating removal; read-only Git runs on the real adapter through the inspector.
    const { createCommandProcessAdapter } = await import('../packages/core/src/adapters/process/command-process.ts');
    const delegate = createCommandProcessAdapter();
    const selective: CommandProcessPort = { async start(request, acknowledge, signal) {
      if (request.argv.includes('worktree') && request.argv.includes('remove')) return processes.start(request, acknowledge, signal);
      return delegate.start(request, acknowledge, signal);
    } };
    const service = createWorkspaceCleanerService({ store: a.cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector: createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
        commandProcess: selective, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }), publishEvidence: a.publishEvidence });
    const input = f.cleanInput(exp);
    const done = await service.clean(input);
    expect(done.operation.status).toBe('blocked');
    expect(done.workspace.status).toBe('quarantined');
    expect(String(resultReason(done))).toBe('stop_unconfirmed');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    const replay = await f.assemble().cleanerService.clean(input);
    expect(replay.operation.status).toBe('blocked');
  } finally { f.box.close(); }
}, 60_000);

it('reconciles a removal whose receipt was never committed, without re-deleting or fabricating success', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const input = f.cleanInput(exp);
    let failPublish = true;
    const faulty = createWorkspaceCleanerService({ store: a.cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: async (...args: Parameters<typeof a.publishEvidence>) => {
        if (failPublish) throw new Error('publication_failed');
        return a.publishEvidence(...args);
      } });
    await expect(faulty.clean(input)).rejects.toThrow('publication_failed');
    // The deletion really happened but no receipt was committed: the operation stays pending.
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA)).not.toContain(f.token.canonicalPath);
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)!.status).toBe('pending');
    expect(a.workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.status).toBe('ready');
    f.box.reopen();
    const recovered = await f.assemble().cleanerService.clean(input);
    expect(recovered.operation.status).toBe('succeeded');
    expect(recovered.workspace.status).toBe('cleaned');
    expect(recovered.receipt.status === 'completed' && recovered.receipt.result).toMatchObject({ removed: true, recovered: true, reason: null });
    expect(git(['rev-parse', `refs/heads/${f.baseline.branch}`], f.box.box.repoDirA).trim()).toBe(exp.headCommit);
    const again = await f.assemble().cleanerService.clean(input);
    expect(again.replay).toBe(true);
    expect(again.operation).toEqual(recovered.operation);
  } finally { f.box.close(); }
}, 60_000);

it('diagnoses directory/registration inconsistency instead of guessing, during recovery and fresh runs', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    // Fresh run with the directory removed externally but registration left behind.
    rmSync(f.token.canonicalPath, { recursive: true });
    const done = await a.cleanerService.clean(f.cleanInput(exp));
    expect(done.operation.status).toBe('failed');
    expect(String(resultReason(done))).toBe('inconsistent_removal_state');
    expect(git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA)).toContain('prunable');
    expect(a.workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.status).toBe('ready');
    expect(git(['rev-parse', `refs/heads/${f.baseline.branch}`], f.box.box.repoDirA).trim()).toBe(exp.headCommit);
  } finally { f.box.close(); }
  const g = await fixture();
  try {
    const a = g.assemble();
    await g.succeed();
    const exp = await g.expected(a);
    const input = g.cleanInput(exp);
    let failPublish = true;
    const faulty = createWorkspaceCleanerService({ store: a.cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: createFeatureWorktreeCleaner({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: async (...args: Parameters<typeof a.publishEvidence>) => {
        if (failPublish) throw new Error('publication_failed');
        return a.publishEvidence(...args);
      } });
    await expect(faulty.clean(input)).rejects.toThrow('publication_failed');
    failPublish = false;
    // During the outage someone recreated a directory at the managed path: not our verified bytes.
    mkdirSync(g.token.canonicalPath);
    const recovered = await g.assemble().cleanerService.clean(input);
    expect(recovered.operation.status).toBe('failed');
    expect(String(resultReason(recovered))).toBe('inconsistent_removal_state');
    expect(existsSync(g.token.canonicalPath)).toBe(true);
    expect(g.assemble().workspaces.readWorkspace(g.ids.projectId, g.box.featureId)!.status).toBe('ready');
  } finally { g.box.close(); }
}, 60_000);

it('blocks a new claim while a cleanup intent is pending and fences a cleanup whose workspace gained a new writer', async () => {
  const f = await fixture([[], []]);
  try {
    const a = f.assemble();
    await f.succeed();
    // Make the successful Attempt/Task terminal so a peer writer could otherwise prepare.
    f.box.session.database.prepare("UPDATE attempts SET status = 'succeeded' WHERE id = ?").run(f.identity.attemptId);
    f.box.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = ?").run(f.ids.taskId);
    const exp = await f.expected(a);
    const input = f.cleanInput(exp);
    const crashing = createWorkspaceCleanerService({ store: a.cleanerStore, gitLock: createGitPublicMetadataLock(),
      cleaner: { clean: async () => { throw new Error('injected_crash'); },
        confirmRemoval: async () => { throw new Error('unreachable'); } },
      publishEvidence: a.publishEvidence });
    await expect(crashing.clean(input)).rejects.toThrow('injected_crash');
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)!.status).toBe('pending');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    // A new claim cannot obtain preparation rights while the managed cleanup intent is pending.
    const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW })
      .claimTask({ ...f.input(1), workspace: f.token }).receipt;
    const peerIdentity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
    await expect(a.preparation.prepare({ ...f.preparationInput, identity: peerIdentity, taskId: claim.attempt.taskId,
      claimKey: claim.claimKey, operationId: randomUUID() })).rejects.toThrow(/unfinished/);
    // The peer never started; its unstarted occupancy is safely released before the cleanup retry.
    f.box.session.transactWrite('test.release-peer', () => a.resources.releaseUnstartedInTransaction(peerIdentity));
    // The managed intent completes instead; the deletion right stayed with the original operation.
    const done = await a.cleanerService.clean(input);
    expect(done.operation.status).toBe('succeeded');
    expect(existsSync(f.token.canonicalPath)).toBe(false);
  } finally { f.box.close(); }
  const g = await fixture([[], []]);
  try {
    const a = g.assemble();
    await g.succeed();
    g.box.session.database.prepare("UPDATE attempts SET status = 'succeeded' WHERE id = ?").run(g.identity.attemptId);
    g.box.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = ?").run(g.ids.taskId);
    const exp = await g.expected(a);
    const input = g.cleanInput(exp);
    // A peer writer prepares the workspace first; the stale cleanup can never delete its work.
    const claim = createSqliteTaskClaimStore(g.box.session, { workspaceAuthority: g.authority, nowUtcMs: () => NOW })
      .claimTask({ ...g.input(1), workspace: g.token }).receipt;
    const peerIdentity = { projectId: g.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
    await a.preparation.prepare({ ...g.preparationInput, identity: peerIdentity, taskId: claim.attempt.taskId,
      claimKey: claim.claimKey, operationId: randomUUID() });
    await expect(a.cleanerService.clean(input)).rejects.toThrow(/another_execution_occupies_resources|workspace_has_newer_writer/);
    expect(existsSync(g.token.canonicalPath)).toBe(true);
    expect(a.workspaces.listOperations({ projectId: g.ids.projectId, featureId: g.box.featureId, cursor: null, limit: 100 }).items.map(o => o.kind)).toEqual(['prepare', 'prepare']);
  } finally { g.box.close(); }
}, 60_000);

it('fences stale identities without events or deletion, and ignores an unrecovered stop without a verifier', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const exp = await f.expected(a);
    const before = f.snapshot();
    for (const field of ['owner', 'hostInstanceId', 'executionVersion'] as const) {
      const input = f.cleanInput(exp);
      await expect(a.cleanerService.clean({ ...input, identity: { ...f.identity, [field]: field === 'executionVersion' ? 2 : 'old' } })).rejects.toThrow();
    }
    expect(f.snapshot()).toEqual(before);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);
