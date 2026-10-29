import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
      const targetSession = driver.open(baseline(plan.target.canonicalPath, plan.target.gitCommonDir, plan.target.baseCommit), () => undefined);
      const targetFacts = await targetSession.facts();
      const targetDirty = (await targetSession.stagedPaths()).length > 0 || (await targetSession.unstagedPaths()).length > 0;
      const workspacePath = operation.intent.worktreePath;
      let workspaceSession;
      try {
        workspaceSession = driver.open(baseline(workspacePath, plan.target.gitCommonDir, plan.target.baseCommit), () => undefined);
        const facts = await workspaceSession.facts();
        const dirty = (await workspaceSession.stagedPaths()).length > 0 || (await workspaceSession.unstagedPaths()).length > 0;
        const prior = observation?.steps ?? [];
        let steps = [...prior];
        const expectedParent = prior.at(-1)?.commitSha ?? plan.target.baseCommit;
        const nextFeatureId = plan.mergeOrder[prior.length];
        const predecessor = nextFeatureId === undefined ? undefined : plan.predecessors.find(item => item.featureId === nextFeatureId);
        const inputSha = predecessor?.delivery?.commitSha;
        const expectedMessage = inputSha === undefined ? null : `Merge ${inputSha} into ShipLoop integration ${plan.integrationId}\\n`;
        const identity = { name: operation.intent.gitIdentity.name, email: operation.intent.gitIdentity.email };
        if (facts.head !== expectedParent && nextFeatureId !== undefined && inputSha !== undefined
          && facts.parents.length === 2 && facts.parents[0] === expectedParent && facts.parents[1] === inputSha
          && facts.message === expectedMessage && facts.author.name === identity.name && facts.author.email === identity.email
          && facts.committer.name === identity.name && facts.committer.email === identity.email) {
          steps = [...prior, { ordinal: prior.length + 1, featureId: nextFeatureId, inputSha,
            parentBefore: expectedParent, parents: facts.parents, commitSha: facts.head, treeSha: facts.tree, status: 'succeeded' as const }];
        }
        const existing = observation?.workspace;
        const workspace = {
          workspaceId: existing?.workspaceId ?? `recovered:${operation.intent.operationId}`,
          ownerId: operation.intent.ownerId, ownerVersion: operation.intent.budgetSnapshot?.ownerVersion as number,
          path: workspacePath, gitCommonDir: plan.target.gitCommonDir, repoIdentity: operation.intent.repoIdentity,
          targetBase: plan.target.baseCommit, plan, gitIdentity: operation.intent.gitIdentity,
          status: steps.length === plan.mergeOrder.length ? 'succeeded' as const : dirty ? 'blocked' as const : 'ready' as const,
          currentHead: facts.head, steps,
          facts: { head: facts.head, tree: facts.tree, parents: facts.parents, statusPorcelain: dirty ? 'dirty' : '', unresolvedPaths: [] },
        };
        return { target: { head: targetFacts.head, repoIdentity: operation.intent.repoIdentity,
          gitCommonDir: plan.target.gitCommonDir, statusPorcelain: targetDirty ? 'dirty' : '' }, workspace, steps };
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { target: { head: targetFacts.head, repoIdentity: operation.intent.repoIdentity,
            gitCommonDir: plan.target.gitCommonDir, statusPorcelain: targetDirty ? 'dirty' : '' }, workspace: null, steps: [] };
        }
        throw error;
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
