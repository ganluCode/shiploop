import { expect, it, describe } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPathService } from '../../../packages/core/src/adapters/fs/path-service.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createFeatureWorktreePreparer } from '../../../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createFeatureWorktreeDiscarder } from '../../../packages/core/src/adapters/fs/feature-worktree-discarder.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteWorkspacePreparationStore } from '../../../packages/core/src/adapters/sqlite/workspace-preparation.ts';
import { createSqliteWorkspaceAccess } from '../../../packages/core/src/adapters/sqlite/workspace.ts';
import { createSqliteWorkspaceDiscardStore, createSqliteWorkspaceDiscardPreviewStore } from '../../../packages/core/src/adapters/sqlite/workspace-discard.ts';
import { createWorkspacePreparationService } from '../../../packages/core/src/application/workspace-preparation.ts';
import { createWorkspaceDiscardService } from '../../../packages/core/src/application/workspace-discard.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { WorkspaceDiscardPreview } from '../../../packages/core/src/ports/workspace-discard.ts';
import type { WorkResourceStopVerifier } from '../../../packages/core/src/ports/work-resources.ts';
import type { CommandProcessPort, CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import { createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { APP_CAPABILITIES } from '../../../packages/core/src/ports/commands.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { git } from '../../helpers/git-repo.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

async function withTempSandboxAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f010-');
  try { await fn(sandbox.path); } finally { sandbox.cleanup(); }
}

function resultReason(done: { receipt: { status: string; result?: unknown } }): unknown {
  return done.receipt.status === 'completed' ? (done.receipt.result as Record<string, unknown>).reason : undefined;
}

async function fixture(edges: string[][] = [[]]) {
  const f = await openClaimFixture(edges);
  let clock = NOW;
  const confirmProcess = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });
  function assemble(stopVerifier?: WorkResourceStopVerifier, maxPreviewEntries?: number) {
    const session = f.box.session;
    const paths = createPathService({ dataRoot: f.box.box.root, projectLookup: createSqliteStateStore(session), featureLookup: createSqliteQueryStore(session) });
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
    const resources = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, stopVerifier, nowUtcMs: () => clock });
    const workspaces = createSqliteWorkspaceAccess(session, { resources, nowUtcMs: () => clock });
    const inspector = createWorkspaceInspector({ authorizedRoots: [f.box.box.root], confirmProcessIdentity: confirmProcess });
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
      gitLock: createGitPublicMetadataLock(), preparer: createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: confirmProcess }), publishEvidence });
    const discardStore = createSqliteWorkspaceDiscardStore(session, { resources, nowUtcMs: () => clock });
    const discardService = createWorkspaceDiscardService({
      previewStore: createSqliteWorkspaceDiscardPreviewStore(session, { resources }),
      store: discardStore, inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector, confirmProcessIdentity: confirmProcess }),
      publishEvidence, nowUtcMs: () => clock, previewTtlMs: 60_000,
      ...(maxPreviewEntries === undefined ? {} : { maxPreviewEntries }) });
    return { authority, resources, workspaces, inspector, preparation, discardStore, discardService, publishEvidence };
  }
  const a = assemble();
  const token = await a.authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(f.box.session, { workspaceAuthority: a.authority, nowUtcMs: () => clock }).claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner, hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
  const preparationInput = { identity, taskId: f.ids.taskId, runId: f.ids.runId, claimKey: claim.claimKey, operationId: randomUUID(), workspaceId: randomUUID() };
  const prepared = await a.preparation.prepare(preparationInput);
  const owner = createLocalOwnerPrincipal();
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
  function preview(service = a.discardService, over: Record<string, unknown> = {}) {
    return service.preview({ principal: owner, projectId: f.ids.projectId, featureId: f.box.featureId, ...over });
  }
  function confirmInput(previewed: WorkspaceDiscardPreview, over: Record<string, unknown> = {}) {
    return { principal: owner, commandId: randomUUID(), projectId: f.ids.projectId, featureId: f.box.featureId,
      workspaceId: prepared.workspace.id, operationId: randomUUID(), expectedWorkspaceRevision: previewed.workspaceRevision,
      preview: { previewDigest: previewed.previewDigest, headCommit: previewed.headCommit, codeDigest: previewed.codeDigest,
        ignoredDigest: previewed.ignoredDigest, workspaceRevision: previewed.workspaceRevision, expiresAtUtcMs: previewed.expiresAtUtcMs },
      evidenceRefs: [previewed.evidenceRef], ...over };
  }
  return { ...f, ...a, assemble, token, identity, prepared, preparationInput, owner, succeed, preview, confirmInput,
    tick: (ms: number) => { clock += ms; } };
}

function dirtyWorktree(worktree: string) {
  writeFileSync(join(worktree, 'README.md'), 'modified but uncommitted');
  writeFileSync(join(worktree, 'new-file.bin'), Buffer.from([0, 255, 7]));
  writeFileSync(join(worktree, '.gitignore'), 'local.ignored\n');
  git(['add', '.gitignore'], worktree);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore rules'], worktree);
  writeFileSync(join(worktree, 'local.ignored'), Buffer.from([9, 9, 9]));
}

it('previews the exact discard scope and discards only the previewed managed worktree after authorized confirmation', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const worktree = f.token.canonicalPath;
    const source = f.box.box.repoDirA;
    dirtyWorktree(worktree);
    writeFileSync(join(source, 'source-local.txt'), 'keep me');
    const sourceHead = git(['rev-parse', 'HEAD'], source).trim();
    const sourceRefs = git(['show-ref'], source);
    const sourceIndex = readFileSync(join(source, '.git', 'index'));

    const previewed = await f.preview();
    expect(previewed.workspaceId).toBe(f.prepared.workspace.id);
    expect(previewed.branch).toBe(f.prepared.workspace.branch);
    expect(previewed.headCommit).toBe(git(['rev-parse', 'HEAD'], worktree).trim());
    expect(previewed.status).toBe('ready');
    expect(previewed.scope).toBe('worktree_only');
    expect(previewed.blockers).toEqual([]);
    expect(previewed.contents.counts.tracked).toBeGreaterThanOrEqual(1);
    expect(previewed.contents.counts.untracked).toBe(1);
    expect(previewed.contents.counts.ignored).toBe(1);
    expect(previewed.contents.truncated).toBe(false);
    expect(previewed.impact.irreversible).toBe(true);
    expect(previewed.impact.discardsUncommittedTrackedChanges).toBeGreaterThanOrEqual(1);
    expect(previewed.impact.preserves).toEqual(['source_repository', 'feature_branch', 'committed_work', 'audit_records']);
    expect(previewed.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    // The preview never leaks absolute managed/source paths; entries are relative.
    expect(JSON.stringify(previewed)).not.toContain(worktree);
    expect(JSON.stringify(previewed)).not.toContain(source);
    expect(previewed.contents.untracked.map(e => e.path)).toEqual(['new-file.bin']);

    const business = f.snapshot();
    const events: string[] = [];
    const realLock = createGitPublicMetadataLock();
    const spyLock = { acquire: async (lockInput: Parameters<ReturnType<typeof createGitPublicMetadataLock>['acquire']>[0]) => {
      const lease = await realLock.acquire(lockInput);
      events.push('acquire');
      return { release: async () => { events.push('release'); await lease.release(); } };
    }, releaseRecovered: (lockInput: Parameters<typeof realLock.releaseRecovered>[0]) => realLock.releaseRecovered(lockInput) };
    const store = { ...a.discardStore, finish: (...args: Parameters<typeof a.discardStore.finish>) => {
      events.push('finish');
      return a.discardStore.finish(...args);
    } };
    const service = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(f.box.session, { resources: a.resources }),
      store, inspector: a.inspector, gitLock: spyLock,
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: a.publishEvidence, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    const input = f.confirmInput(previewed);
    const done = await service.confirm(input);
    expect(done.operation.status).toBe('succeeded');
    expect(done.operation.kind).toBe('discard');
    expect(done.operation.principalId).toBe('local-owner');
    expect(done.operation.commandId).toBe(input.commandId);
    expect(done.workspace.status).toBe('cleaned');
    expect(done.workspace.headCommit).toBe(previewed.headCommit);
    expect(done.receipt.status === 'completed' && done.receipt.result).toMatchObject({ removed: true, recovered: false, reason: null });
    expect(events).toEqual(['acquire', 'finish', 'release']);
    // Directory and registration are gone; the Feature branch and committed work stay readable.
    expect(existsSync(worktree)).toBe(false);
    expect(git(['worktree', 'list', '--porcelain'], source)).not.toContain(worktree);
    expect(git(['rev-parse', `refs/heads/${f.prepared.workspace.branch}`], source).trim()).toBe(previewed.headCommit);
    expect(git(['cat-file', '-t', previewed.headCommit], source).trim()).toBe('commit');
    // Source repository HEAD, refs, index and dirty bytes are untouched.
    expect(git(['rev-parse', 'HEAD'], source).trim()).toBe(sourceHead);
    expect(git(['show-ref'], source)).toBe(sourceRefs);
    expect(readFileSync(join(source, '.git', 'index'))).toEqual(sourceIndex);
    expect(readFileSync(join(source, 'source-local.txt'))).toEqual(Buffer.from('keep me'));
    // Business facts are not rewritten by a manual discard.
    expect(f.snapshot().tasks).toEqual(business.tasks);
    expect(f.snapshot().attempts).toEqual(business.attempts);
    expect(f.snapshot().runs).toEqual(business.runs);
    expect(f.snapshot().execution_batches).toEqual(business.execution_batches);
    // Operation audit and evidence artifacts remain readable.
    const operations = a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items;
    expect(operations.map(o => o.kind).sort()).toEqual(['discard', 'prepare']);
    for (const ref of done.operation.result!.evidenceRefs) {
      expect(f.box.session.database.prepare("SELECT id FROM artifacts WHERE id = ? AND status = 'ready'").get(ref)).toBeTruthy();
    }
  } finally { f.box.close(); }
}, 60_000);

it('preview is read-only, deterministic within its validity window and bounded with a truncation marker', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    const worktree = f.token.canonicalPath;
    writeFileSync(join(worktree, 'a.txt'), 'a');
    writeFileSync(join(worktree, 'b.txt'), 'b');
    writeFileSync(join(worktree, 'c.txt'), 'c');
    const before = f.snapshot();
    const operationsBefore = a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items;
    const first = await f.preview();
    const second = await f.preview();
    expect(second.previewDigest).toBe(first.previewDigest);
    expect(second.expiresAtUtcMs).toBe(first.observedAtUtcMs + 60_000);
    // Held occupancy is surfaced as a blocker, never hidden; an unstarted attempt
    // with fully stopped preparation processes already carries stop evidence.
    expect(first.blockers).toEqual(['occupancy_active']);
    // No workspace/business mutation, no operation rows, workspace bytes unchanged.
    expect(f.snapshot()).toEqual(before);
    expect(a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items)
      .toEqual(operationsBefore);
    expect(readFileSync(join(worktree, 'a.txt'))).toEqual(Buffer.from('a'));
    // Bounded listing: the marker is explicit and totals stay truthful.
    const bounded = await f.preview(f.assemble(undefined, 1).discardService);
    expect(bounded.contents.untracked).toHaveLength(1);
    expect(bounded.contents.truncated).toBe(true);
    expect(bounded.contents.counts.untracked).toBe(3);
  } finally { f.box.close(); }
}, 60_000);

it('refuses preview and confirm for principals without the discard capability or project visibility', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const before = f.snapshot();
    const withoutCapability = createRestrictedPrincipal({
      capabilities: APP_CAPABILITIES.filter(c => c !== 'workspace.discard'),
      projectScope: { kind: 'all' },
    });
    await expect(a.discardService.preview({ principal: withoutCapability, projectId: f.ids.projectId, featureId: f.box.featureId }))
      .rejects.toMatchObject({ code: 'forbidden' });
    const previewed = await f.preview();
    await expect(a.discardService.confirm(f.confirmInput(previewed, { principal: withoutCapability })))
      .rejects.toMatchObject({ code: 'forbidden' });
    const invisible = createRestrictedPrincipal({
      capabilities: [...APP_CAPABILITIES],
      projectScope: { kind: 'allowlist', projectIds: [randomUUID()] },
    });
    await expect(a.discardService.preview({ principal: invisible, projectId: f.ids.projectId, featureId: f.box.featureId }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(a.discardService.confirm(f.confirmInput(previewed, { principal: invisible })))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(f.snapshot()).toEqual(before);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items.map(o => o.kind))
      .toEqual(['prepare']);
  } finally { f.box.close(); }
}, 60_000);

it('refuses confirmation without a matching preview and refuses a different subject replaying the operation identity', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    const before = f.snapshot();
    // No real preview: a forged digest never matches the recomputed binding.
    await expect(a.discardService.confirm(f.confirmInput(previewed, { preview: { ...f.confirmInput(previewed).preview, previewDigest: '0'.repeat(64) } })))
      .rejects.toThrow(/preview_digest_mismatch/);
    // A binding computed for a different workspace revision is stale.
    await expect(a.discardService.confirm(f.confirmInput(previewed, { expectedWorkspaceRevision: previewed.workspaceRevision + 1 })))
      .rejects.toThrow(/stale_workspace_revision/);
    expect(f.snapshot()).toEqual(before);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    const input = f.confirmInput(previewed);
    const done = await a.discardService.confirm(input);
    expect(done.operation.status).toBe('succeeded');
    // A different subject cannot claim or replay the same operation identity.
    const other = Object.freeze({ ...f.owner, principalId: 'other-operator-1' });
    await expect(a.discardService.confirm({ ...input, principal: other }))
      .rejects.toThrow(/identity_conflict|already used/);
    expect(existsSync(f.token.canonicalPath)).toBe(false);
  } finally { f.box.close(); }
}, 60_000);

it('rejects an expired preview at registration and again right before deletion, with zero deletion', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    f.tick(61_000);
    await expect(a.discardService.confirm(f.confirmInput(previewed))).rejects.toThrow(/preview_expired/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items.map(o => o.kind))
      .toEqual(['prepare']);
  } finally { f.box.close(); }
  // Expiry is re-checked after content verification inside the Git lock.
  const g = await fixture();
  try {
    const a = g.assemble();
    await g.succeed();
    const previewed = await g.preview();
    const store = { ...a.discardStore, recheckAuthorization: (input: Parameters<typeof a.discardStore.recheckAuthorization>[0], intent: Parameters<typeof a.discardStore.recheckAuthorization>[1]) => {
      g.tick(61_000);
      return a.discardStore.recheckAuthorization(input, intent);
    } };
    const service = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(g.box.session, { resources: a.resources }),
      store, inspector: a.inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: a.publishEvidence, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    const done = await service.confirm(g.confirmInput(previewed));
    expect(done.operation.status).toBe('failed');
    expect(String(resultReason(done))).toBe('preview_expired');
    expect(done.workspace.status).toBe('ready');
    expect(existsSync(g.token.canonicalPath)).toBe(true);
  } finally { g.box.close(); }
}, 60_000);

it.each(['tracked', 'untracked', 'ignored', 'head'] as const)('refuses when %s changes between preview and confirm, deleting nothing', async kind => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const worktree = f.token.canonicalPath;
    const previewed = await f.preview();
    if (kind === 'tracked') {
      writeFileSync(join(worktree, 'README.md'), 'modified after preview');
    } else if (kind === 'untracked') {
      writeFileSync(join(worktree, 'after-preview.bin'), Buffer.from([1]));
    } else if (kind === 'ignored') {
      writeFileSync(join(worktree, '.gitignore'), 'late.ignored\n');
      git(['add', '.gitignore'], worktree);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore rules'], worktree);
      writeFileSync(join(worktree, 'late.ignored'), Buffer.from([2]));
    } else {
      writeFileSync(join(worktree, 'external.txt'), 'external commit');
      git(['add', 'external.txt'], worktree);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'external'], worktree);
    }
    const done = await a.discardService.confirm(f.confirmInput(previewed));
    expect(done.operation.status).toBe('failed');
    expect(done.workspace.status).toBe('ready');
    expect(String(resultReason(done))).toMatch(/changed/);
    expect(existsSync(worktree)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], f.box.box.repoDirA)).toContain(worktree);
    // A failed discard is terminal audit; replay cannot rewrite it.
    const replay = await a.discardService.confirm(f.confirmInput(previewed, { commandId: (done.operation as { commandId: string }).commandId, operationId: done.operation.id }));
    expect(replay.operation).toEqual(done.operation);
  } finally { f.box.close(); }
}, 60_000);

it('refuses while write occupancy is held and while stop evidence is missing, even with confirmation', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    // Never started: leases held → occupancy refuses before any deletion.
    const previewed = await f.preview();
    expect(previewed.blockers).toContain('occupancy_active');
    await expect(a.discardService.confirm(f.confirmInput(previewed))).rejects.toThrow(/occupancy_active/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    // A launched attempt whose leases vanish without durable stop proof: the stop gate refuses.
    f.box.session.transactWrite('test.launch', () => {
      a.resources.beginLaunchInTransaction(f.identity);
      a.resources.confirmLaunchInTransaction(f.identity, { launchId: randomUUID(), pid: 123, processGroupId: 123, startTime: 'test-supervised-process' });
    });
    f.box.session.database.prepare('DELETE FROM workspace_leases').run();
    const previewed2 = await f.preview();
    expect(previewed2.blockers).toEqual(['stop_evidence_missing']);
    await expect(a.discardService.confirm(f.confirmInput(previewed2))).rejects.toThrow(/stop_evidence_missing/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(a.workspaces.listOperations({ projectId: f.ids.projectId, featureId: f.box.featureId, cursor: null, limit: 100 }).items.map(o => o.kind))
      .toEqual(['prepare']);
  } finally { f.box.close(); }
}, 60_000);

it('discards a never-started workspace once unstarted occupancy is released and preparation stop is proven', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    f.box.session.transactWrite('test.release-unstarted', () => a.resources.releaseUnstartedInTransaction(f.identity));
    const previewed = await f.preview();
    expect(previewed.blockers).toEqual([]);
    const done = await a.discardService.confirm(f.confirmInput(previewed));
    expect(done.operation.status).toBe('succeeded');
    expect(done.workspace.status).toBe('cleaned');
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    expect(git(['rev-parse', `refs/heads/${f.prepared.workspace.branch}`], f.box.box.repoDirA).trim()).toBe(previewed.headCommit);
  } finally { f.box.close(); }
}, 60_000);

it.each(['quarantined', 'preparing', 'cleanup_pending'] as const)('refuses to confirm a workspace in %s status', async status => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    f.box.session.database.prepare('UPDATE managed_workspaces SET status = ? WHERE id = ?').run(status, f.prepared.workspace.id);
    await expect(a.discardService.confirm(f.confirmInput(previewed))).rejects.toThrow(/workspace_status_not_discardable/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

it('replays the identical confirmation without new events or repeated Git effects', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    const input = f.confirmInput(previewed);
    const done = await a.discardService.confirm(input);
    const after = f.snapshot();
    const replay = await a.discardService.confirm(input);
    expect(replay.replay).toBe(true);
    expect(replay.operation).toEqual(done.operation);
    expect(replay.receipt).toEqual(done.receipt);
    expect(f.snapshot()).toEqual(after);
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    // Same commandId with a different payload is an idempotency conflict, not a new deletion.
    await expect(a.discardService.confirm({ ...input, evidenceRefs: [previewed.evidenceRef, previewed.evidenceRef] })).rejects.toThrow();
    expect(f.snapshot()).toEqual(after);
  } finally { f.box.close(); }
}, 60_000);

it('reconciles a discard whose receipt was never committed, without re-deleting or fabricating success', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    const input = f.confirmInput(previewed);
    let failPublish = true;
    const faulty = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(f.box.session, { resources: a.resources }),
      store: a.discardStore, inspector: a.inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: async (...args: Parameters<typeof a.publishEvidence>) => {
        if (failPublish) throw new Error('publication_failed');
        return a.publishEvidence(...args);
      }, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    await expect(faulty.confirm(input)).rejects.toThrow('publication_failed');
    // The deletion really happened but no receipt was committed: the operation stays pending.
    expect(existsSync(f.token.canonicalPath)).toBe(false);
    expect(a.workspaces.readOperation(f.ids.projectId, input.operationId)!.status).toBe('pending');
    expect(a.workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.status).toBe('ready');
    f.box.reopen();
    const recovered = await f.assemble().discardService.confirm(input);
    expect(recovered.operation.status).toBe('succeeded');
    expect(recovered.workspace.status).toBe('cleaned');
    expect(recovered.receipt.status === 'completed' && recovered.receipt.result).toMatchObject({ removed: true, recovered: true, reason: null });
    const again = await f.assemble().discardService.confirm(input);
    expect(again.replay).toBe(true);
    expect(again.operation).toEqual(recovered.operation);
  } finally { f.box.close(); }
}, 60_000);

it('diagnoses directory/registration inconsistency instead of guessing during recovery', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    const input = f.confirmInput(previewed);
    let failPublish = true;
    const faulty = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(f.box.session, { resources: a.resources }),
      store: a.discardStore, inspector: a.inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: async (...args: Parameters<typeof a.publishEvidence>) => {
        if (failPublish) throw new Error('publication_failed');
        return a.publishEvidence(...args);
      }, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    await expect(faulty.confirm(input)).rejects.toThrow('publication_failed');
    failPublish = false;
    // During the outage someone recreated a directory at the managed path: not our verified bytes.
    mkdirSync(f.token.canonicalPath);
    const recovered = await f.assemble().discardService.confirm(input);
    expect(recovered.operation.status).toBe('failed');
    expect(String(resultReason(recovered))).toBe('inconsistent_removal_state');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(f.assemble().workspaces.readWorkspace(f.ids.projectId, f.box.featureId)!.status).toBe('ready');
  } finally { f.box.close(); }
}, 60_000);

it('records a failed operation when Git refuses the scoped removal; the workspace bytes stay intact', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    dirtyWorktree(f.token.canonicalPath);
    const previewed = await f.preview();
    const { createCommandProcessAdapter } = await import("../../../packages/core/src/adapters/process/command-process.ts");
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
    const service = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(f.box.session, { resources: a.resources }),
      store: a.discardStore, inspector: a.inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, commandProcess: processes, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: a.publishEvidence, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    const done = await service.confirm(f.confirmInput(previewed));
    expect(done.operation.status).toBe('failed');
    expect(String(resultReason(done))).toBe('git_removal_refused');
    const removal = argvLog.find(argv => argv.includes('worktree') && argv.includes('remove'));
    expect(removal).toBeTruthy();
    // Scoped force on the verified registered path only; never unbounded force or recursive delete.
    expect(removal!.filter(a2 => a2 === '--force' || a2 === '-f')).toEqual(['--force']);
    expect(removal).toContain(f.token.canonicalPath);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    expect(readFileSync(join(f.token.canonicalPath, 'new-file.bin'))).toEqual(Buffer.from([0, 255, 7]));
  } finally { f.box.close(); }
}, 60_000);

it('blocks and quarantines when the removal process stop is unconfirmed, without deleting bytes', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    const previewed = await f.preview();
    const { createCommandProcessAdapter } = await import("../../../packages/core/src/adapters/process/command-process.ts");
    const delegate = createCommandProcessAdapter();
    const selective: CommandProcessPort = { async start(request, acknowledge, signal) {
      if (request.argv.includes('worktree') && request.argv.includes('remove')) {
        const identity: CommandProcessIdentity = { launchId: randomUUID(), pid: 322, processGroupId: 322, startTime: 'fake-remove' };
        return { identity, query: () => ({ identity, state: 'uncertain' as const, bufferedOutputBytes: 0 }),
          output: { async *[Symbol.asyncIterator]() { /* empty */ } },
          result: Promise.resolve({ exitCode: 0, signal: null, reason: null, outputBytes: 0, droppedOutputBytes: 0, stop: { confirmed: false } }),
          stopped: Promise.resolve({ confirmed: false }), cancel: async () => ({ accepted: true }) };
      }
      return delegate.start(request, acknowledge, signal);
    } };
    const service = createWorkspaceDiscardService({ previewStore: createSqliteWorkspaceDiscardPreviewStore(f.box.session, { resources: a.resources }),
      store: a.discardStore, inspector: a.inspector, gitLock: createGitPublicMetadataLock(),
      discarder: createFeatureWorktreeDiscarder({ inspector: a.inspector, commandProcess: selective, confirmProcessIdentity: async id => ({ launchId: id.launchId }) }),
      publishEvidence: a.publishEvidence, nowUtcMs: () => NOW, previewTtlMs: 60_000 });
    const input = f.confirmInput(previewed);
    const done = await service.confirm(input);
    expect(done.operation.status).toBe('blocked');
    expect(done.workspace.status).toBe('quarantined');
    expect(String(resultReason(done))).toBe('stop_unconfirmed');
    expect(existsSync(f.token.canonicalPath)).toBe(true);
    // A blocked operation stays terminal; the quarantined workspace refuses further discard.
    const replay = await f.assemble().discardService.confirm(input);
    expect(replay.operation.status).toBe('blocked');
  } finally { f.box.close(); }
}, 60_000);

it('rejects previews for missing workspaces and confirms for the wrong workspace identity', async () => {
  const f = await fixture();
  try {
    const a = f.assemble();
    await f.succeed();
    await expect(a.discardService.preview({ principal: f.owner, projectId: f.ids.projectId, featureId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });
    const previewed = await f.preview();
    await expect(a.discardService.confirm(f.confirmInput(previewed, { workspaceId: randomUUID() })))
      .rejects.toThrow(/preview_digest_mismatch|workspace_scope_mismatch/);
    expect(existsSync(f.token.canonicalPath)).toBe(true);
  } finally { f.box.close(); }
}, 60_000);

describe('F-010 migration v19 workspace_operations kind rebuild', () => {
  it('preserves prior operation rows, accepts discard and keeps historical checksums immutable', async () => {
    const { openSqliteStorageSession } = await import("../../../packages/core/src/adapters/sqlite/session.ts");
    const { migrateSqliteStorage } = await import("../../../packages/core/src/adapters/sqlite/migrator.ts");
    const { SQLITE_MIGRATIONS } = await import("../../../packages/core/src/adapters/sqlite/migrations.ts");
    await withTempSandboxAsync(async root => {
      const session = openSqliteStorageSession({ path: join(root, 'db.sqlite') });
      try {
        expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(30);
        await migrateSqliteStorage(session, { migrations: SQLITE_MIGRATIONS.slice(0, 18) });
        const db = session.database;
        const digest = 'a'.repeat(64);
        const digestB = 'b'.repeat(64);
        const commit = 'c'.repeat(40);
        const project = randomUUID(), phase = randomUUID(), feature = randomUUID(), task = randomUUID();
        const batch = randomUUID(), run = randomUUID(), attempt = randomUUID(), artifact = randomUUID();
        const binding = randomUUID(), workspace = randomUUID(), operation = randomUUID(), receipt = randomUUID();
        db.prepare("INSERT INTO projects (id, created_at, updated_at, display_name) VALUES (?, 1, 1, 'p')").run(project);
        db.prepare("INSERT INTO repository_bindings (id, created_at, project_id, updated_at, canonical_path, repo_identity) VALUES (?, 1, ?, 1, '/repo', 'repo-1')").run(binding, project);
        db.prepare("INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, 1, ?, 1, 'ph')").run(phase, project);
        db.prepare("INSERT INTO features (id, created_at, project_id, updated_at, phase_id, title) VALUES (?, 1, ?, 1, ?, 'f')").run(feature, project, phase);
        db.prepare(`INSERT INTO tasks (id, created_at, project_id, updated_at, feature_id, title, acceptance, execution_config, config_source, execution_version)
          VALUES (?, 1, ?, 1, ?, 't', '{"criteria":["c"]}', '{}', 'project_default', 1)`).run(task, project, feature);
        db.prepare(`INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, budget_snapshot, deadline_at)
          VALUES (?, 1, ?, 1, ?, ?, '{"featureIds":["f-1"]}', '{}', '{}', 10)`).run(batch, project, phase, feature);
        db.prepare(`INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, scope_digest, work_key, max_attempts_per_run, run_time_limit_ms)
          VALUES (?, 1, ?, 1, ?, ?, 'execute', '{}', '{}', ?, 'wk', 1, 1000)`).run(run, project, batch, feature, digest);
        db.prepare(`INSERT INTO artifacts (id, created_at, project_id, updated_at, kind, media_type, expected_hash, storage_locator, status, version, content_hash, size_bytes)
          VALUES (?, 1, ?, 1, 'execution_input', 'application/json', ?, 'inputs/x.json', 'ready', 1, ?, 0)`).run(artifact, project, digest, digest);
        const inputSnapshot = JSON.stringify({ schemaVersion: 1, projectId: project, featureId: feature, taskId: task,
          digests: { snapshotDigest: digest }, group: { snapshot: { artifactId: artifact, version: 1, contentHash: digest, sizeBytes: 0, locator: 'inputs/x.json', mediaType: 'application/json' } } });
        db.prepare(`INSERT INTO attempts (id, created_at, project_id, updated_at, feature_id, run_id, task_id, number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref)
          VALUES (?, 1, ?, 1, ?, ?, ?, 1, 'owner-1', 'host-1', 1, 100, ?, ?, ?)`).run(attempt, project, feature, run, task, inputSnapshot, digest, artifact);
        db.prepare(`INSERT INTO command_receipts (id, created_at, updated_at, principal_id, command_id, scope_kind, project_id, operation, request_digest, status, result_json, result_ref, issued_at, completed_at)
          VALUES (?, 1, 1, 'local-owner', ?, 'project', ?, 'execution.start', ?, 'completed', '{}', 'v1.${'A'.repeat(43)}', 1, 1)`).run(receipt, operation, project, digestB);
        db.prepare(`INSERT INTO managed_workspaces (id, created_at, project_id, updated_at, feature_id, repository_binding_id, repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit, status, preparation_operation_id, owner_id, host_instance_id, execution_version, run_id, attempt_id)
          VALUES (?, 1, ?, 1, ?, ?, 1, 'repo-1', '/repo/ws', '/repo/.git', 'feature/x', ?, 'ready', ?, 'owner-1', 'host-1', 1, ?, ?)`)
          .run(workspace, project, feature, binding, commit, operation, run, attempt);
        db.prepare(`INSERT INTO workspace_operations (id, created_at, project_id, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, receipt_id)
          VALUES (?, 1, ?, 1, ?, ?, ?, ?, 'owner-1', 'host-1', 1, 'prepare', 'preflight', 'local-owner', ?, ?, '{}', 'succeeded', ?)`)
          .run(operation, project, feature, workspace, run, attempt, operation, digestB, receipt);
        const beforeRows = db.prepare('SELECT * FROM workspace_operations').all();
        const beforeMigrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
        // The legacy kind check is still enforced at v18.
        expect(() => db.prepare(`INSERT INTO workspace_operations (id, created_at, project_id, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, receipt_id)
          VALUES (?, 1, ?, 1, ?, ?, ?, ?, 'owner-1', 'host-1', 1, 'discard', 'cleanup', 'local-owner', ?, ?, '{}', 'pending', ?)`)
          .run(randomUUID(), project, feature, workspace, run, attempt, randomUUID(), digestB, receipt)).toThrow();
        await migrateSqliteStorage(session);
        // Rows, identity and historical migration checksums survive the rebuild.
        expect(db.prepare('SELECT * FROM workspace_operations').all()).toEqual(beforeRows);
        expect(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all().slice(0, 18)).toEqual(beforeMigrations);
        expect(db.prepare('SELECT * FROM managed_workspaces').all()).toHaveLength(1);
        // The rebuilt table accepts discard and still rejects unknown kinds.
        db.prepare(`INSERT INTO workspace_operations (id, created_at, project_id, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, receipt_id)
          VALUES (?, 1, ?, 1, ?, ?, ?, ?, 'owner-1', 'host-1', 1, 'discard', 'cleanup', 'local-owner', ?, ?, '{}', 'pending', ?)`)
          .run(randomUUID(), project, feature, workspace, run, attempt, randomUUID(), digestB, receipt);
        expect(() => db.prepare(`INSERT INTO workspace_operations (id, created_at, project_id, updated_at, feature_id, workspace_id, run_id, attempt_id, owner_id, host_instance_id, execution_version, kind, execution_stage, principal_id, command_id, request_digest, input_snapshot, status, receipt_id)
          VALUES (?, 1, ?, 1, ?, ?, ?, ?, 'owner-1', 'host-1', 1, 'destroy', 'cleanup', 'local-owner', ?, ?, '{}', 'pending', ?)`)
          .run(randomUUID(), project, feature, workspace, run, attempt, randomUUID(), digestB, receipt)).toThrow();
        // Immutability triggers survive the rebuild.
        expect(() => db.prepare("UPDATE workspace_operations SET kind = 'cleanup' WHERE id = ?").run(operation)).toThrow();
        expect((await migrateSqliteStorage(session)).appliedVersions).toEqual([]);
      } finally { session.close(); }
    });
  }, 60_000);
});
