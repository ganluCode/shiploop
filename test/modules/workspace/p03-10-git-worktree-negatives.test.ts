import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createFeatureWorktreePreparer } from '../../../packages/core/src/adapters/fs/feature-worktree-preparer.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { deriveObservedRepoIdentity } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import type { WorkspacePreparationCheckpoint } from '../../../packages/core/src/ports/workspace-preparation.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { commitAll, git, initGitRepo } from '../../helpers/git-repo.ts';
import { gitScene, withGitFaultEvidence } from '../../helpers/p03-10/git-fault-evidence.ts';

async function workspaceCase(name: string, body: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await withGitFaultEvidence(name, () => ({ source: gitScene(f.source), baseline: f.baseline,
      checkpoint: f.checkpoint, sourceBytes: f.sourceBytes(), outcome: f.outcome,
      workspaceExists: existsSync(f.workspace), movedExists: existsSync(f.workspace + '-retained'),
      retained: [f.workspace, f.workspace + '-retained'].filter(p => existsSync(join(p, 'untracked.txt')))
        .map(p => ({ path: p, tracked: readFileSync(join(p, 'source.ts'), 'utf8'),
          untracked: readFileSync(join(p, 'untracked.txt'), 'utf8') })) }), () => body(f));
  } finally { f.box.cleanup(); }
  expect(existsSync(f.box.path)).toBe(false);
}

function fixture() {
  const box = createTempSandbox('shiploop-f012-worktree-');
  const root = realpathSync(box.path);
  const source = join(root, 'source');
  initGitRepo(source);
  writeFileSync(join(source, 'source.ts'), 'baseline source\n');
  const baseCommit = commitAll(source, 'confirmed baseline');
  const gitCommonDir = realpathSync(join(source, '.git'));
  const repoIdentity = deriveObservedRepoIdentity(gitCommonDir);
  const workspace = join(root, 'managed');
  const baseline = { repositoryBindingId: 'binding', repositoryBindingRevision: 1, repoIdentity,
    canonicalPath: workspace, gitCommonDir, branch: 'shiploop/f012', baseCommit };
  const binding = { id: 'binding', projectId: 'project', canonicalPath: source, gitCommonDir,
    repoIdentity, revision: 1, bindingRevision: 1, createdAtUtcMs: 1, updatedAtUtcMs: 1 };
  const checkpoint: WorkspacePreparationCheckpoint = {
    directoryIdentity: null, expectedHead: baseCommit, unfinishedProcesses: [],
    recordDirectory(value) { Object.assign(checkpoint, { directoryIdentity: value }); },
    recordProcess(value) { Object.assign(checkpoint, { unfinishedProcesses: [...checkpoint.unfinishedProcesses, value] }); },
    recordStop(value) { Object.assign(checkpoint, { unfinishedProcesses: checkpoint.unfinishedProcesses.filter(p => p.launchId !== value.launchId) }); },
  };
  const inspector = createWorkspaceInspector({ authorizedRoots: [root], confirmProcessIdentity: async i => i });
  const preparer = createFeatureWorktreePreparer({ inspector, confirmProcessIdentity: async i => i });
  let outcome: Awaited<ReturnType<typeof preparer.prepare>> | null = null;
  const operationId = randomUUID();
  return { box, source, workspace, baseline, checkpoint, inspector,
    get outcome() { return outcome; },
    sourceBytes: () => ({ tracked: readFileSync(join(source, 'source.ts'), 'utf8'),
      local: existsSync(join(source, 'local.txt')) ? readFileSync(join(source, 'local.txt'), 'utf8') : null,
      index: readFileSync(join(gitCommonDir, 'index')).toString('base64') }),
    async prepare() { return outcome = await preparer.prepare(binding, baseline, operationId, () => {}, checkpoint); },
    keepProgress() {
      writeFileSync(join(workspace, 'source.ts'), 'tracked progress must survive\n');
      writeFileSync(join(workspace, 'untracked.txt'), 'untracked progress must survive\n');
    },
  };
}

test('[case:worktree-baseline-reuse] confirmed baseline and same directory reuse preserve tracked/untracked source and progress', async () => {
  await workspaceCase('baseline-reuse', async f => {
    writeFileSync(join(f.source, 'source.ts'), 'dirty source, not a baseline\n');
    writeFileSync(join(f.source, 'local.txt'), 'source local bytes\n');
    const before = f.sourceBytes();
    const first = await f.prepare();
    expect(first).toMatchObject({ reason: null, isolated: false, inspection: { repository: {
      headCommit: f.baseline.baseCommit, branch: f.baseline.branch, canonicalPath: f.workspace } } });
    expect(readFileSync(join(f.workspace, 'source.ts'), 'utf8')).toBe('baseline source\n');
    expect(existsSync(join(f.workspace, 'local.txt'))).toBe(false);
    f.keepProgress();
    const scene = gitScene(f.workspace), identity = f.checkpoint.directoryIdentity;
    for (let n = 0; n < 2; n++) {
      expect(await f.prepare()).toMatchObject({ reason: null, isolated: false });
      expect(gitScene(f.workspace)).toEqual(scene);
      expect(f.checkpoint.directoryIdentity).toEqual(identity);
    }
    expect(f.sourceBytes()).toEqual(before);
    expect((git(['worktree', 'list', '--porcelain'], f.source).match(/^worktree /gm) ?? [])).toHaveLength(2);
    expect(f.checkpoint.unfinishedProcesses).toEqual([]);
  });
}, 120_000);

for (const kind of ['branch', 'directory', 'head', 'occupied'] as const) {
  test(`[case:worktree-reject-${kind}] reject unexpected ${kind} and keep every user byte`, async () => {
    await workspaceCase(`reject-${kind}`, async f => {
      if (kind === 'occupied') {
        mkdirSync(f.workspace);
        f.keepProgress();
      } else {
        expect((await f.prepare()).reason).toBeNull();
        f.keepProgress();
      }
      let retained = f.workspace;
      if (kind === 'directory') {
        retained = f.workspace + '-retained';
        renameSync(f.workspace, retained);
        mkdirSync(f.workspace);
        writeFileSync(join(f.workspace, 'sentinel.txt'), 'replacement user directory\n');
      }
      if (kind === 'branch') {
        // Change only the temporary Git symbolic ref; no checkout/reset of files.
        git(['update-ref', 'refs/heads/foreign', f.baseline.baseCommit], f.workspace);
        git(['symbolic-ref', 'HEAD', 'refs/heads/foreign'], f.workspace);
      }
      if (kind === 'head') git(['-c', 'user.name=External', '-c', 'user.email=external@example.invalid',
        'commit', '--allow-empty', '-m', 'unexpected external progress'], f.workspace);
      const source = f.sourceBytes();
      const head = kind === 'head' ? git(['rev-parse', 'HEAD'], f.workspace) : null;
      const result = await f.prepare();
      expect(result.inspection).toBeNull();
      expect(result.reason).toBe({ branch: 'branch_mismatch', directory: 'directory_identity_changed',
        head: 'unexpected_head', occupied: 'directory_conflict' }[kind]);
      expect(readFileSync(join(retained, 'source.ts'), 'utf8')).toBe('tracked progress must survive\n');
      expect(readFileSync(join(retained, 'untracked.txt'), 'utf8')).toBe('untracked progress must survive\n');
      expect(f.sourceBytes()).toEqual(source);
      if (head) expect(git(['rev-parse', 'HEAD'], f.workspace)).toBe(head);
      if (kind === 'directory') expect(readFileSync(join(f.workspace, 'sentinel.txt'), 'utf8')).toBe('replacement user directory\n');
      expect(git(['stash', 'list'], f.source)).toBe('');
    });
  }, 120_000);
}
