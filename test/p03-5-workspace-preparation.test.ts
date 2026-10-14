import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPathService } from '../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFeatureWorktreePreparer } from '../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createGitPublicMetadataLock } from '../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteTaskClaimStore } from '../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createSqliteWorkspaceAccess } from '../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createCompletedReceipt } from '../packages/core/src/ports/commands.ts';
import { createResultRef } from '../packages/core/src/ports/command-receipts.ts';
import { validateWorkspaceBaseline } from '../packages/core/src/ports/workspace.ts';
import type { WorkspacePreparationStore } from '../packages/core/src/ports/workspace-preparation.ts';
import { createWorkspacePreparationService } from '../packages/core/src/application/workspace-preparation.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { deriveManagedFeatureBranch } from '../packages/core/src/ports/workspace-preparation.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { commitAll } from './helpers/git-repo.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { git } from './helpers/git-repo.ts';

it('rechecks a completed preparation and rejects an unrecorded descendant HEAD without resetting files', async () => {
  const f = await fixture();
  try {
    await f.service.prepare(f.input);
    writeFileSync(join(f.token.canonicalPath, 'external.txt'), 'unexpected external commit');
    commitAll(f.token.canonicalPath, 'unrecorded external progress');
    const head = git(['rev-parse', 'HEAD'], f.token.canonicalPath);
    await expect(f.service.prepare(f.input)).rejects.toThrow();
    expect(git(['rev-parse', 'HEAD'], f.token.canonicalPath)).toBe(head);
    expect(readFileSync(join(f.token.canonicalPath, 'external.txt'), 'utf8')).toBe('unexpected external commit');
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
  } finally { f.box.close(); }
}, 60_000);

it('reconciles Git creation after a receipt transaction failure and database reopen without repeating Git add', async () => {
  const f = await fixture();
  try {
    f.box.session.database.exec("CREATE TRIGGER fault BEFORE UPDATE ON workspace_operations WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'receipt_fault'); END");
    await expect(f.service.prepare(f.input)).rejects.toThrow('receipt_fault');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    writeFileSync(join(f.token.canonicalPath, 'README.md'), 'preserved tracked progress');
    writeFileSync(join(f.token.canonicalPath, 'untracked.txt'), 'preserved untracked progress');
    writeFileSync(join(f.token.canonicalPath, '.gitignore'), 'ignored.local\n');
    writeFileSync(join(f.token.canonicalPath, 'ignored.local'), 'preserved ignored progress');
    const bytes = ['README.md', 'untracked.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(f.token.canonicalPath, name)));
    f.box.session.database.exec('DROP TRIGGER fault');
    f.box.reopen();
    const service = createWorkspacePreparationService(assemble(f));
    const recovered = await service.prepare(f.input);
    expect(recovered.operation.status).toBe('succeeded');
    expect(recovered.operation.id).toBe(f.input.operationId);
    expect(recovered.workspace.codeDigest).not.toBeNull();
    expect(['README.md', 'untracked.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(f.token.canonicalPath, name)))).toEqual(bytes);
    expect((git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA).match(/worktree /g) ?? []).length).toBe(2);
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({ n: 1 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()).toEqual({ n: 1 });
    expect((await service.prepare(f.input)).replay).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

async function recordProgress(f: Awaited<ReturnType<typeof fixture>>) {
  const access = createSqliteWorkspaceAccess(f.box.session, { resources: f.resources, nowUtcMs: () => NOW });
  const workspace = access.readWorkspace(f.ids.projectId, f.box.featureId)!;
  const baseline = validateWorkspaceBaseline(access.readOperation(f.ids.projectId, f.input.operationId)!.inputSnapshot.baseline);
  const inspection = await f.inspector.inspect(baseline);
  const evidenceRef = await f.options.publishEvidence(f.ids.projectId, randomUUID(), { inspection, expectedHead: inspection.repository.headCommit });
  const operationId = randomUUID();
  const receipt = (step: string) => createCompletedReceipt({ commandId: randomUUID(), principalId: 'trusted-progress-test',
    operation: 'execution.start', scope: { kind: 'project', projectId: f.ids.projectId }, requestDigest: createHash('sha256').update(step).digest('hex'),
    issuedAt: new Date(NOW).toISOString(), completedAt: new Date(NOW).toISOString(),
    result: { workspaceOperationId: operationId, workspaceId: workspace.id }, resultRef: createResultRef(randomBytes(32)) });
  const intent = f.box.session.transactWrite('test.progress.intent', () => access.beginInTransaction({
    operationId, workspaceId: workspace.id, featureId: f.box.featureId, kind: 'retain', identity: f.input.identity,
    executionStage: 'commit', expectedWorkspaceRevision: workspace.revision, baseline, receipt: receipt('intent') }));
  return f.box.session.transactWrite('test.progress.result', () => access.finishInTransaction({
    operationId, identity: f.input.identity, expectedRevision: intent.operation.revision, expectedWorkspaceRevision: intent.workspace.revision,
    status: 'succeeded', workspaceStatus: 'retained', headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
    result: { evidenceRefs: [evidenceRef], errorRef: null, startedAtUtcMs: NOW, endedAtUtcMs: NOW, durationMs: 0, exitCode: 0, signal: null },
    receipt: receipt('result') }));
}

it.each(['after_git', 'after_inspection', 'before_receipt'] as const)('recovers %s interruption into the same durable operation', async point => {
  const f = await fixture();
  try {
    const fault = createWorkspacePreparationService({ ...f.options,
      preparer: point === 'after_git' ? createFeatureWorktreePreparer({
        inspector: { async inspect(baseline) {
          if (validateWorkspaceBaseline(baseline).canonicalPath === f.token.canonicalPath) throw new Error('unexpected_inspection');
          return f.inspector.inspect(baseline);
        } }, confirmProcessIdentity: f.options.confirm }) : point === 'after_inspection' ? {
        async prepare(...args) { await f.options.preparer.prepare(...args); throw new Error('after_inspection_fault'); },
      } : f.options.preparer,
      store: point === 'after_git' ? { ...f.store,
        recordCheckpoint(...args) { f.store.recordCheckpoint(...args); if (args[2] === 'stop') throw new Error('after_git_fault'); },
      } : point === 'before_receipt' ? { ...f.store, finish() { throw new Error('before_receipt_fault'); } } : f.store,
    });
    await expect(fault.prepare(f.input)).rejects.toThrow(point + '_fault');
    expect(f.box.session.database.prepare('SELECT id, status FROM workspace_operations').get()).toEqual({ id: f.input.operationId, status: 'pending' });
    const refs = git(['show-ref'], f.box.box.repoDirA);
    f.box.reopen();
    const recovered = await createWorkspacePreparationService(assemble(f)).prepare(f.input);
    expect(recovered.operation.id).toBe(f.input.operationId);
    expect(recovered.operation.status).toBe('succeeded');
    expect(git(['show-ref'], f.box.box.repoDirA)).toBe(refs);
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()).toEqual({ n: 1 });
  } finally { f.box.close(); }
}, 60_000);

it.each(['wrong_branch', 'detached', 'replaced', 'foreign_repository', 'symlink'] as const)('refuses %s reuse and preserves bytes and isolation', async drift => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare(f.input);
    writeFileSync(join(f.token.canonicalPath, 'sentinel'), 'keep all progress');
    if (drift === 'wrong_branch') git(['checkout', '-b', 'external-branch'], f.token.canonicalPath);
    if (drift === 'detached') git(['checkout', '--detach'], f.token.canonicalPath);
    if (drift === 'replaced' || drift === 'symlink') {
      const moved = f.token.canonicalPath + '-original';
      renameSync(f.token.canonicalPath, moved);
      if (drift === 'replaced') cpSync(moved, f.token.canonicalPath, { recursive: true });
      else symlinkSync(moved, f.token.canonicalPath);
    }
    if (drift === 'foreign_repository') {
      renameSync(f.token.canonicalPath, f.token.canonicalPath + '-original');
      git(['worktree', 'add', '-b', f.branch, f.token.canonicalPath], f.box.box.repoDirB);
      writeFileSync(join(f.token.canonicalPath, 'sentinel'), 'keep all progress');
    }
    await expect(f.service.prepare(f.input)).rejects.toThrow();
    expect(readFileSync(join(f.token.canonicalPath, 'sentinel'), 'utf8')).toBe('keep all progress');
    const operation = f.box.session.database.prepare('SELECT result_json FROM workspace_operations WHERE id = ?').get(f.input.operationId) as { result_json: string };
    expect(JSON.parse(operation.result_json)).toEqual(prepared.operation.result);
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
  } finally { f.box.close(); }
}, 60_000);

it('keeps recorded committed progress and associates reuse with a newly claimed Attempt without changing old snapshots or budgets', async () => {
  const f = await fixture([[], [], []]);
  const archivePath = join(f.box.box.root, 'native-archive.sqlite');
  const archive = new DatabaseSync(archivePath);
  archive.exec("CREATE TABLE native_session (body TEXT); INSERT INTO native_session VALUES ('keep native session separate');");
  const nativeBytes = readFileSync(archivePath);
  try {
    f.box.session.transactWrite('test.previously-passed-task', () => {
      f.box.session.database.prepare("UPDATE tasks SET status = 'passed' WHERE id = 't-3'").run();
    });
    const passed = f.box.session.database.prepare("SELECT * FROM tasks WHERE id = 't-3'").get();
    const first = await f.service.prepare(f.input);
    writeFileSync(join(f.token.canonicalPath, 'progress.txt'), 'legitimate committed progress');
    commitAll(f.token.canonicalPath, 'authorized recorded progress');
    const progress = await recordProgress(f);
    writeFileSync(join(f.token.canonicalPath, 'dirty.txt'), 'additional untracked progress');
    const oldAttempt = f.box.session.database.prepare('SELECT input_snapshot FROM attempts WHERE id = ?').get(f.input.identity.attemptId);
    const lifecycle = createSqliteAttemptLifecycleStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW });
    const evidenceRef = first.operation.result!.evidenceRefs[0]!;
    expect(lifecycle.apply({ ...f.input.identity, runId: f.input.runId, taskId: f.input.taskId,
      notificationId: 'stop-preflight', kind: 'preparation_failed', errorKind: 'configuration', evidenceRef }).disposition).toBe('applied');
    const second = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW })
      .claimTask({ ...f.inputTask(1), workspace: f.token }).receipt;
    const input = { ...f.input, taskId: second.attempt.taskId, claimKey: second.claimKey, operationId: randomUUID(),
      identity: { projectId: f.ids.projectId, attemptId: second.attempt.id, owner: second.attempt.owner,
        hostInstanceId: second.attempt.hostInstanceId, executionVersion: second.attempt.executionVersion } };
    const reused = await f.service.prepare(input);
    expect(reused.workspace.id).toBe(first.workspace.id);
    expect(reused.workspace.baseCommit).toBe(first.workspace.baseCommit);
    expect(reused.workspace.headCommit).toBe(progress.workspace.headCommit);
    expect(reused.operation.identity.attemptId).toBe(second.attempt.id);
    expect(reused.workspace).toMatchObject({ attemptId: first.workspace.attemptId, ownerId: first.workspace.ownerId,
      hostInstanceId: first.workspace.hostInstanceId, executionVersion: first.workspace.executionVersion, runId: first.workspace.runId });
    expect(reused.operation).toMatchObject({ runId: second.attempt.runId,
      identity: { attemptId: second.attempt.id, owner: second.attempt.owner,
        hostInstanceId: second.attempt.hostInstanceId, executionVersion: second.attempt.executionVersion } });
    expect(reused.workspace.codeDigest).not.toBe(progress.workspace.codeDigest);
    expect(reused.operation.inputSnapshot.baseline).toEqual(first.operation.inputSnapshot.baseline);
    expect(f.box.session.database.prepare('SELECT input_snapshot FROM attempts WHERE id = ?').get(f.input.identity.attemptId)).toEqual(oldAttempt);
    expect(f.box.session.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches').get()).toEqual({ attempts_created: 2, runtime_starts: 0 });
    expect(f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get(f.input.taskId)).toEqual({ status: 'failed' });
    expect(readFileSync(join(f.token.canonicalPath, 'dirty.txt'), 'utf8')).toBe('additional untracked progress');
    expect((git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA).match(/worktree /g) ?? []).length).toBe(2);
    expect(f.box.session.database.prepare('SELECT * FROM runtime_start_reservations').all()).toEqual([]);
    expect(f.box.session.database.prepare("SELECT * FROM tasks WHERE id = 't-3'").get()).toEqual(passed);
    expect(readFileSync(archivePath)).toEqual(nativeBytes);
    expect(archive.prepare('SELECT body FROM native_session').get()).toEqual({ body: 'keep native session separate' });
    expect(existsSync(join(f.token.canonicalPath, 'native-archive.sqlite'))).toBe(false);
  } finally { archive.close(); f.box.close(); }
}, 60_000);

it.each(['head', 'bytes'] as const)('rejects %s changes during evidence publication before marking preparation ready', async changed => {
  const f = await fixture();
  try {
    const service = createWorkspacePreparationService({ ...f.options,
      async publishEvidence(projectId, operationId, evidence) {
        const reference = await f.options.publishEvidence(projectId, operationId, evidence);
        if (operationId === f.input.operationId) {
          writeFileSync(join(f.token.canonicalPath, 'late.txt'), 'late protected bytes');
          if (changed === 'head') commitAll(f.token.canonicalPath, 'unrecorded concurrent HEAD');
        }
        return reference;
      } });
    await expect(service.prepare(f.input)).rejects.toThrow('workspace_changed_before_receipt');
    expect(readFileSync(join(f.token.canonicalPath, 'late.txt'), 'utf8')).toBe('late protected bytes');
    expect(f.box.session.database.prepare('SELECT status FROM workspace_operations').get()).toEqual({ status: 'pending' });
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
    if (changed === 'head') await expect(f.service.prepare(f.input)).rejects.toThrow('unexpected_head');
    else expect((await f.service.prepare(f.input)).operation.status).toBe('succeeded');
  } finally { f.box.close(); }
}, 60_000);

it('requires independent stop confirmation when Git launch evidence has no durable stopped receipt', async () => {
  const f = await fixture();
  try {
    const faultStore: WorkspacePreparationStore = { ...f.store,
      recordCheckpoint(...args) {
        if (args[2] === 'stop') throw new Error('lost_stop_receipt');
        f.store.recordCheckpoint(...args);
      } };
    await expect(createWorkspacePreparationService({ ...f.options, store: faultStore }).prepare(f.input)).rejects.toThrow('lost_stop_receipt');
    const before = git(['show-ref'], f.box.box.repoDirA);
    await expect(f.service.prepare(f.input)).rejects.toThrow('previous_git_stop_unconfirmed');
    await expect(createWorkspacePreparationService({ ...f.options,
      verifyPreparationStop: async () => ({ confirmed: false }) }).prepare(f.input)).rejects.toThrow('previous_git_stop_unconfirmed');
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
    const restored = await createWorkspacePreparationService({ ...f.options,
      verifyPreparationStop: async process => {
        expect(process.launchId).toMatch(/^[0-9a-f-]{36}$/);
        return { confirmed: true };
      } }).prepare(f.input);
    expect(restored.operation.status).toBe('succeeded');
    expect(git(['show-ref'], f.box.box.repoDirA)).toBe(before);
  } finally { f.box.close(); }
}, 60_000);

it('refuses an already launched Runtime even when preparation has a successful receipt', async () => {
  const f = await fixture();
  try {
    await f.service.prepare(f.input);
    f.box.session.transactWrite('test.live-runtime', () => f.resources.beginLaunchInTransaction(f.input.identity));
    const before = f.snapshot();
    await expect(f.service.prepare(f.input)).rejects.toThrow('attempt_not_live_preflight');
    expect(f.snapshot()).toEqual(before);
  } finally { f.box.close(); }
}, 60_000);

it('serializes competing recovery and fences late results/quarantine without overwriting completed receipts', async () => {
  const f = await fixture();
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let inflight: ReturnType<typeof f.service.prepare> | undefined;
  try {
    const authorization = f.store.readAuthorization(f.input);
    const baseline = { repositoryBindingId: authorization.binding.id, repositoryBindingRevision: authorization.binding.bindingRevision,
      repoIdentity: authorization.binding.repoIdentity, gitCommonDir: authorization.binding.gitCommonDir!, canonicalPath: f.token.canonicalPath,
      branch: f.branch, baseCommit: authorization.baseCommit };
    const oldIntent = f.store.begin(f.input, baseline);
    let observation!: import('../packages/core/src/ports/workspace-preparation.ts').WorkspacePreparationOutcome;
    const service = createWorkspacePreparationService({ ...f.options,
      async publishEvidence(projectId, operationId, evidence) {
        if (operationId === f.input.operationId) {
          observation = evidence.outcome as typeof observation;
          entered(); await gate;
        }
        return f.options.publishEvidence(projectId, operationId, evidence);
      } });
    inflight = service.prepare(f.input);
    await ready;
    await expect(f.service.prepare(f.input)).rejects.toThrow();
    resume();
    const completed = await inflight;
    expect(completed.operation.status).toBe('succeeded');
    const before = f.snapshot();
    expect(() => f.store.finish(f.input, oldIntent, observation, completed.operation.result!.evidenceRefs[0]!)).toThrow('stale_preparation_revision');
    f.store.quarantine(f.input, oldIntent);
    expect(f.snapshot()).toEqual(before);
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({ n: 1 });
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()).toEqual({ n: 1 });
  } finally { resume(); if (inflight) await inflight.catch(() => undefined); f.box.close(); }
}, 60_000);

it('does not adopt a manually created worktree without a durable managed directory checkpoint', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.token.canonicalPath, '..'), { recursive: true });
    git(['worktree', 'add', '-b', f.branch, f.token.canonicalPath], f.box.box.repoDirA);
    writeFileSync(join(f.token.canonicalPath, 'unowned.txt'), 'unowned preserved bytes');
    const before = git(['show-ref'], f.box.box.repoDirA);
    const refused = await f.service.prepare(f.input);
    expect(refused.operation.status).toBe('failed');
    expect(git(['show-ref'], f.box.box.repoDirA)).toBe(before);
    expect(readFileSync(join(f.token.canonicalPath, 'unowned.txt'), 'utf8')).toBe('unowned preserved bytes');
    expect(f.box.session.database.prepare("SELECT id FROM command_receipts WHERE principal_id = 'core-workspace-directory'").get()).toBeUndefined();
  } finally { f.box.close(); }
}, 60_000);

it('freezes the explicitly confirmed commit and binding in the committed Run, not a later source HEAD', async () => {
  const f = await openClaimFixture();
  try {
    const run = f.box.session.database.prepare('SELECT input_snapshot FROM runs WHERE id = ?').get(f.ids.runId) as { input_snapshot: string };
    expect(JSON.parse(run.input_snapshot).workspaceBaseline).toEqual({
      repositoryBindingId: f.workspace.binding.id,
      repositoryBindingRevision: f.workspace.binding.bindingRevision,
      baseCommit: git(['rev-parse', 'HEAD'], f.box.box.repoDirA).trim(),
    });
  } finally { f.box.close(); }
});

function assemble(f: Pick<Awaited<ReturnType<typeof openClaimFixture>>, 'box' | 'ids'>) {
  const { session } = f.box;
  const paths = createPathService({ dataRoot: f.box.box.root,
    projectLookup: createSqliteStateStore(session), featureLookup: createSqliteQueryStore(session) });
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
  const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
  const store = createSqliteWorkspacePreparationStore(session, { resources, workspaceAuthority: authority, nowUtcMs: () => NOW });
  const publisher = createArtifactPublisher({ artifacts: createSqliteArtifactStore(session, { nowUtcMs: () => NOW }),
    files: createArtifactFileStore({ dataRoot: f.box.box.root }), limits: { maxSizeBytes: 4 * 1024 * 1024, timeoutMs: 10_000 } });
  const publishEvidence = async (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => {
    expect(session.database.inTransaction).toBe(false);
    const body = Buffer.from(JSON.stringify(evidence));
    const published = await publisher.publishArtifact({ projectId, kind: 'workspace_evidence', mediaType: 'application/json',
      expectedHash: createHash('sha256').update(body).digest('hex'), locator: `evidence/${operationId}.json`, content: [body] });
    return published.artifact.id;
  };
  const confirm = async (processIdentity: import('../packages/core/src/ports/command-process.ts').CommandProcessIdentity) => {
    await publishEvidence(f.ids.projectId, processIdentity.launchId, { processIdentity });
    return { launchId: processIdentity.launchId };
  };
  const inspector = createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: confirm });
  const preparer = createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: confirm });
  const gitLock = createGitPublicMetadataLock();
  return { store, authority, resources, gitLock, preparer, publishEvidence, inspector, confirm };
}

async function fixture(edges: string[][] = [[]]) {
  const f = await openClaimFixture(edges);
  const options = assemble(f);
  const token = await options.authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: options.authority, nowUtcMs: () => NOW })
    .claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner,
    hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
  const input = { identity, taskId: f.ids.taskId, runId: f.ids.runId, claimKey: claim.claimKey,
    operationId: randomUUID(), workspaceId: randomUUID() };
  return { ...f, ...options, inputTask: f.input, input, token, options, branch: deriveManagedFeatureBranch(f.ids.projectId, f.box.featureId),
    service: createWorkspacePreparationService(options) };
}

it('creates and verifies a first worktree at the confirmed commit, preserving dirty source bytes, HEAD, index and all existing refs', async () => {
  const f = await fixture();
  try {
    const source = f.box.box.repoDirA;
    const baseCommit = git(['rev-parse', 'HEAD'], source).trim();
    writeFileSync(join(source, 'later.txt'), 'source later commit\n');
    commitAll(source, 'advance after explicit confirmation');
    writeFileSync(join(source, 'README.md'), 'dirty tracked source bytes\n');
    writeFileSync(join(source, 'only-source.txt'), 'dirty untracked source bytes\n');
    writeFileSync(join(source, '.gitignore'), 'ignored.local\n');
    writeFileSync(join(source, 'ignored.local'), 'preserved ignored source\n');
    const head = git(['rev-parse', 'HEAD'], source), refs = git(['for-each-ref', '--format=%(refname) %(objectname)'], source);
    const indexPath = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], source).trim();
    const index = readFileSync(indexPath);
    const dirty = ['README.md', 'only-source.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(source, name)));
    const prepared = await f.service.prepare(f.input);
    expect(prepared.operation.status, JSON.stringify(prepared.receipt)).toBe('succeeded');
    expect(prepared.workspace).toMatchObject({ status: 'ready', baseCommit, headCommit: baseCommit, branch: f.branch,
      canonicalPath: f.token.canonicalPath, gitCommonDir: f.workspace.binding.gitCommonDir });
    expect(git(['rev-parse', 'HEAD'], f.token.canonicalPath).trim()).toBe(baseCommit);
    expect(git(['symbolic-ref', '--short', 'HEAD'], f.token.canonicalPath).trim()).toBe(f.branch);
    expect(existsSync(join(f.token.canonicalPath, 'only-source.txt'))).toBe(false);
    expect(existsSync(join(f.token.canonicalPath, 'later.txt'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], source)).toBe(head);
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'], source).trim().split('\n').sort())
      .toEqual((refs + `refs/heads/${f.branch} ${baseCommit}\n`).trim().split('\n').sort());
    expect(readFileSync(indexPath)).toEqual(index);
    expect(['README.md', 'only-source.txt', '.gitignore', 'ignored.local'].map(name => readFileSync(join(source, name)))).toEqual(dirty);
    expect(f.box.session.database.prepare('SELECT status, execution_stage, usage_summary FROM attempts').get())
      .toEqual({ status: 'preparing', execution_stage: 'preflight', usage_summary: null });
    expect(f.box.session.database.prepare('SELECT status FROM runs').get()).toEqual({ status: 'queued' });
    expect(f.box.session.database.prepare('SELECT runtime_starts FROM execution_batches').get()).toEqual({ runtime_starts: 0 });
    expect(f.box.session.database.prepare('SELECT * FROM runtime_start_reservations').all()).toEqual([]);
    expect(f.box.session.database.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'running' });
    expect(f.box.session.database.prepare("SELECT status FROM artifacts WHERE id = ?").get(prepared.operation.result!.evidenceRefs[0])).toEqual({ status: 'ready' });
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'held' }));
    const again = await f.service.prepare(f.input);
    expect(again.replay).toBe(true);
    expect(again.operation.status).toBe('succeeded');
  } finally { f.box.close(); }
}, 60_000);

it.each(['branch', 'directory', 'base_commit'] as const)('retains pre-creation %s failure, refunds only code classification and never alters the source', async conflict => {
  const f = await fixture();
  try {
    const source = f.box.box.repoDirA;
    if (conflict === 'branch') git(['branch', f.branch], source);
    if (conflict === 'directory') { mkdirSync(f.token.canonicalPath, { recursive: true }); writeFileSync(join(f.token.canonicalPath, 'sentinel'), 'keep'); }
    if (conflict === 'base_commit') {
      const confirmed = git(['rev-parse', 'HEAD'], source).trim();
      writeFileSync(join(source, 'later.txt'), 'advance'); commitAll(source, 'advance');
      rmSync(join(f.workspace.binding.gitCommonDir!, 'objects', confirmed.slice(0, 2), confirmed.slice(2)));
    }
    const refs = git(['show-ref'], source), head = git(['rev-parse', 'HEAD'], source);
    const failed = await f.service.prepare(f.input);
    expect(failed.operation.status).toBe('failed');
    expect(failed.workspace.status).toBe('retained');
    expect(failed.operation.result!.errorRef).not.toBeNull();
    expect(f.box.session.database.prepare('SELECT status, error_kind, execution_stage, usage_summary FROM attempts').get())
      .toEqual({ status: 'failed', error_kind: 'workspace', execution_stage: 'preflight', usage_summary: null });
    expect(f.box.session.database.prepare('SELECT attempt_counter, code_attempts_used, status FROM tasks').get())
      .toEqual({ attempt_counter: 1, code_attempts_used: 0, status: 'failed' });
    expect(f.box.session.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches').get())
      .toEqual({ attempts_created: 1, runtime_starts: 0 });
    expect(f.box.session.database.prepare('SELECT * FROM workspace_leases').all()).toEqual([]);
    expect(git(['show-ref'], source)).toBe(refs); expect(git(['rev-parse', 'HEAD'], source)).toBe(head);
    if (conflict === 'directory') expect(readFileSync(join(f.token.canonicalPath, 'sentinel'), 'utf8')).toBe('keep');
    else expect(existsSync(f.token.canonicalPath)).toBe(false);
  } finally { f.box.close(); }
}, 60_000);

it('quarantines partial creation/post-create verification failure without reset or removal', async () => {
  const f = await fixture();
  try {
    let inspections = 0;
    const preparer = createFeatureWorktreePreparer({ inspector: {
      async inspect(baseline) {
        if (++inspections > 1) throw new Error('verification_failed');
        return createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) }).inspect(baseline);
      },
    }, confirmProcessIdentity: async identity => ({ launchId: identity.launchId }) });
    const blocked = await createWorkspacePreparationService({ ...f.options, preparer }).prepare(f.input);
    expect(blocked.operation.status).toBe('blocked'); expect(blocked.workspace.status).toBe('quarantined');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(git(['rev-parse', f.branch], f.box.box.repoDirA).trim()).toBe(blocked.workspace.baseCommit);
    expect(f.box.session.database.prepare('SELECT state FROM workspace_leases').all()).toEqual(Array(3).fill({ state: 'quarantined' }));
    expect(f.box.session.database.prepare('SELECT status, error_kind FROM attempts').get()).toEqual({ status: 'failed', error_kind: 'workspace' });
  } finally { f.box.close(); }
}, 60_000);

it.each(['owner', 'hostInstanceId', 'executionVersion', 'runId', 'claimKey'] as const)('rejects uncommitted or crossed %s before any Git mutation', async field => {
  const f = await fixture();
  try {
    const input = field === 'runId' || field === 'claimKey' ? { ...f.input, [field]: 'wrong' }
      : { ...f.input, identity: { ...f.input.identity, [field]: field === 'executionVersion' ? 2 : 'wrong' } };
    const before = f.snapshot();
    await expect(f.service.prepare(input)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    expect(f.box.session.database.prepare('SELECT * FROM workspace_operations').all()).toEqual([]);
  } finally { f.box.close(); }
});

