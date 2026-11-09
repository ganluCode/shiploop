import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deriveRepoIdentity } from '../../ports/repository-inspector.js';
import { deriveObservedRepoIdentity } from './repository-inspector.js';
import { GIT_PUBLIC_METADATA_CLAIM_FILE } from '../../ports/git-public-metadata-lock.js';
import type { GitCommitDriver } from '../../ports/controlled-git-commit.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import type { RecoveryGitReader } from '../../ports/work-recovery-reconciliation.js';
import type { GitIntegrationRecoveryReader } from '../../ports/git-integration-reconciliation.js';

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function lockExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}
function worktreeGitDirectory(baseline: WorkspaceBaseline): string {
  const dotGit = join(baseline.canonicalPath, '.git');
  const stat = lstatSync(dotGit);
  if (stat.isDirectory()) return realpathSync(dotGit);
  if (!stat.isFile()) throw new TypeError('invalid_worktree_git_marker');
  const marker = readFileSync(dotGit, 'utf8');
  if (!marker.startsWith('gitdir: ') || marker.slice(8).trim() === '') throw new TypeError('invalid_worktree_git_marker');
  const gitDir = realpathSync(resolve(baseline.canonicalPath, marker.slice(8).trim()));
  if (gitDir !== baseline.gitCommonDir && !inside(join(baseline.gitCommonDir, 'worktrees'), gitDir)) {
    throw new TypeError('worktree_git_directory_outside_repository');
  }
  return gitDir;
}

export function createIntegrationGitRecoveryReader(options: {
  readonly driverFor: (projectId: string) => GitCommitDriver;
}): GitIntegrationRecoveryReader {
  function fail(reason: string): never { throw Object.assign(new Error(reason), { reason }); }
  function verifiedDirectory(baseline: WorkspaceBaseline): string {
    try {
      if (realpathSync(baseline.canonicalPath) !== baseline.canonicalPath
        || realpathSync(baseline.gitCommonDir) !== baseline.gitCommonDir) fail('repo_identity_changed');
      const gitDir = worktreeGitDirectory(baseline);
      const common = gitDir === baseline.gitCommonDir ? gitDir
        : realpathSync(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()));
      if (common !== baseline.gitCommonDir || (deriveRepoIdentity(common) !== baseline.repoIdentity
        && deriveObservedRepoIdentity(common) !== baseline.repoIdentity)) fail('repo_identity_changed');
      return gitDir;
    } catch { return fail('repo_identity_changed'); }
  }
  return {
    async inspect({ projectId, operation, observation }) {
      const plan = operation.intent.integrationPlan;
      if (plan == null) throw new TypeError('integration_plan_missing');
      const baseline = (canonicalPath: string, gitCommonDir: string, baseCommit: string) => ({
        repositoryBindingId: operation.intent.repositoryBindingId,
        repositoryBindingRevision: 1,
        repoIdentity: operation.intent.repoIdentity,
        canonicalPath,
        gitCommonDir,
        branch: '',
        baseCommit,
      });
      const driver = options.driverFor(projectId);
      const targetBaseline = baseline(plan.target.canonicalPath, plan.target.gitCommonDir, plan.target.baseCommit);
      verifiedDirectory(targetBaseline);
      if (lockExists(join(plan.target.gitCommonDir, GIT_PUBLIC_METADATA_CLAIM_FILE))
        || (await createRecoveryGitReader(options).locks(targetBaseline)).length > 0) fail('git_lock_present');
      const targetSession = driver.open(targetBaseline, () => undefined);
      const targetFacts = await targetSession.facts();
      const targetDirty = (await targetSession.stagedPaths()).length > 0 || (await targetSession.unstagedPaths()).length > 0;
      const workspacePath = operation.intent.worktreePath;
      // Absence before worktree creation is distinct from a partial/foreign worktree.
      try { lstatSync(join(workspacePath, '.git')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { target: { head: targetFacts.head, repoIdentity: plan.target.repoIdentity,
          gitCommonDir: plan.target.gitCommonDir, statusPorcelain: targetDirty ? 'dirty' : '' }, workspace: null, steps: [] };
      }
      const workspaceBaseline = baseline(workspacePath, plan.target.gitCommonDir, plan.target.baseCommit);
      const gitDir = verifiedDirectory(workspaceBaseline);
      if (readFileSync(join(gitDir, 'HEAD'), 'utf8').trim().startsWith('ref:')) fail('workspace_branch_changed');
      if ((await createRecoveryGitReader(options).locks(workspaceBaseline)).length > 0) fail('git_lock_present');
      let owner;
      try {
        const path = join(gitDir, 'shiploop-integration-owner.json');
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 65_536 || stat.nlink !== 1) fail('workspace_not_owned');
        owner = JSON.parse(readFileSync(path, 'utf8'));
        if (owner.workspaceId !== plan.integrationId || owner.planId !== plan.integrationId
          || owner.targetBase !== plan.target.baseCommit || owner.ownerId !== operation.intent.ownerId
          || owner.ownerVersion !== operation.intent.budgetSnapshot?.ownerVersion) fail('workspace_not_owned');
      } catch { fail('workspace_not_owned'); }
      const workspaceSession = driver.open(workspaceBaseline, () => undefined);
      {
        const facts = await workspaceSession.facts();
        const dirty = (await workspaceSession.stagedPaths()).length > 0 || (await workspaceSession.unstagedPaths()).length > 0;
        const prior = observation?.steps ?? [];
        let steps = [...prior];
        const expectedParent = prior.at(-1)?.commitSha ?? plan.target.baseCommit;
        const nextFeatureId = plan.mergeOrder[prior.length];
        const predecessor = nextFeatureId === undefined ? undefined : plan.predecessors.find(item => item.featureId === nextFeatureId);
        const inputSha = predecessor?.delivery?.commitSha;
        const expectedMessage = inputSha === undefined ? null : `Merge ${inputSha} into ShipLoop integration ${plan.integrationId}\n`;
        const identity = { name: operation.intent.gitIdentity.name, email: operation.intent.gitIdentity.email };
        if (facts.head !== expectedParent && nextFeatureId !== undefined && inputSha !== undefined
          && facts.parents.length === 2 && facts.parents[0] === expectedParent && facts.parents[1] === inputSha
          && facts.message === expectedMessage && facts.author.name === identity.name && facts.author.email === identity.email
          && facts.committer.name === identity.name && facts.committer.email === identity.email) {
          steps = [...prior, { ordinal: prior.length + 1, featureId: nextFeatureId, inputSha,
            parentBefore: expectedParent, parents: facts.parents, commitSha: facts.head, treeSha: facts.tree, status: 'succeeded' as const }];
        }
        // Inputs already reachable from this exact HEAD do not create commits. Only
        // the next frozen inputs may be reconstructed, in order, using Git ancestry.
        while (facts.head === (steps.at(-1)?.commitSha ?? plan.target.baseCommit)) {
          const featureId = plan.mergeOrder[steps.length];
          const input = plan.predecessors.find(item => item.featureId === featureId)?.delivery?.commitSha;
          if (!featureId || !input || !await workspaceSession.isAncestor(input, facts.head)) break;
          steps.push({ ordinal: steps.length + 1, featureId, inputSha: input, parentBefore: facts.head,
            parents: facts.parents, commitSha: facts.head, treeSha: facts.tree, status: 'already_included' });
        }
        const existing = observation?.workspace;
        const workspace = {
          workspaceId: existing?.workspaceId ?? owner.workspaceId,
          ownerId: operation.intent.ownerId, ownerVersion: operation.intent.budgetSnapshot?.ownerVersion as number,
          path: workspacePath, gitCommonDir: plan.target.gitCommonDir, repoIdentity: operation.intent.repoIdentity,
          targetBase: plan.target.baseCommit, plan, gitIdentity: operation.intent.gitIdentity,
          status: steps.length === plan.mergeOrder.length ? 'succeeded' as const : dirty ? 'blocked' as const : 'ready' as const,
          currentHead: facts.head, steps,
          facts: { head: facts.head, tree: facts.tree, parents: facts.parents, statusPorcelain: dirty ? 'dirty' : '', unresolvedPaths: [] },
        };
        return { target: { head: targetFacts.head, repoIdentity: operation.intent.repoIdentity,
          gitCommonDir: plan.target.gitCommonDir, statusPorcelain: targetDirty ? 'dirty' : '' }, workspace, steps };
      }
    },
  };
}

/** Detects locks only; it never deletes them or attempts to take over a writer. */
export function createRecoveryGitReader(options: {
  /** Trusted factory so each supervised Git process confirms its project-specific identity. */
  readonly driverFor: (projectId: string) => GitCommitDriver;
}): RecoveryGitReader {
  return {
    async locks(baseline) {
      const gitDir = worktreeGitDirectory(baseline);
      const candidates = [
        ['worktree:index.lock', join(gitDir, 'index.lock')],
        ['worktree:HEAD.lock', join(gitDir, 'HEAD.lock')],
        ['common:index.lock', join(baseline.gitCommonDir, 'index.lock')],
        ['common:HEAD.lock', join(baseline.gitCommonDir, 'HEAD.lock')],
        ['common:packed-refs.lock', join(baseline.gitCommonDir, 'packed-refs.lock')],
        ['common:config.lock', join(baseline.gitCommonDir, 'config.lock')],
      ] as const;
      return candidates.filter(([, path]) => lockExists(path)).map(([name]) => name);
    },
    async facts(projectId, baseline) {
      return options.driverFor(projectId).open(baseline, () => undefined).facts();
    },
    async isAncestor(projectId, baseline, ancestor, descendant) {
      return options.driverFor(projectId).open(baseline, () => undefined).isAncestor(ancestor, descendant);
    },
  };
}
