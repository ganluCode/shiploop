import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitCommitDriver } from '../../ports/controlled-git-commit.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import type { RecoveryGitReader } from '../../ports/work-recovery-reconciliation.js';

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
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
      return candidates.filter(([, path]) => existsSync(path)).map(([name]) => name);
    },
    async facts(projectId, baseline) {
      return options.driverFor(projectId).open(baseline, () => undefined).facts();
    },
    async isAncestor(projectId, baseline, ancestor, descendant) {
      return options.driverFor(projectId).open(baseline, () => undefined).isAncestor(ancestor, descendant);
    },
  };
}
