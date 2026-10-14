import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { createWorkspacePreparationService } from '../packages/core/src/application/workspace-preparation.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { deriveManagedFeatureBranch } from '../packages/core/src/ports/workspace-preparation.ts';
import { NOW } from './helpers/p03-3/budget-fixture.ts';
import { commitAll } from './helpers/git-repo.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { git } from './helpers/git-repo.ts';

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

async function fixture() {
  const f = await openClaimFixture();
  const { session } = f.box;
  const paths = createPathService({ dataRoot: f.box.box.root,
    projectLookup: createSqliteStateStore(session), featureLookup: createSqliteQueryStore(session) });
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [f.box.box.root], preparationPaths: paths });
  const token = await authority.verifyPreparation(f.workspace.binding, f.box.featureId);
  const claim = createSqliteTaskClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => NOW })
    .claimTask({ ...f.input(), workspace: token }).receipt;
  const identity = { projectId: f.ids.projectId, attemptId: claim.attempt.id, owner: claim.attempt.owner,
    hostInstanceId: claim.attempt.hostInstanceId, executionVersion: claim.attempt.executionVersion };
  const input = { identity, taskId: f.ids.taskId, runId: f.ids.runId, claimKey: claim.claimKey,
    operationId: randomUUID(), workspaceId: randomUUID() };
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
  const options = { store, authority, resources, gitLock, preparer, publishEvidence };
  return { ...f, input, store, token, options, branch: deriveManagedFeatureBranch(f.ids.projectId, f.box.featureId),
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

