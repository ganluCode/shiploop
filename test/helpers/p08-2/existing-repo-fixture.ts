/**
 * P08-2 / F-008 存量仓库契约夹具（仅测试使用，不是产品实现）。
 *
 * 用真实临时 Git 仓库制造：已提交的旧代码与测试、一个明确失败、修改过的跟踪
 * 文件、暂存文件和未跟踪文件。增量提交只 `git add -- <approved paths>`，因此
 * 夹具能验证 init/增量过程没有顺手重置或提交用户原有工作区。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, git, initGitRepo } from '../git-repo.ts';
import type { ExistingRepoChange, ExistingRepoSnapshot, ExistingRepoTestResult } from '../../../scripts/acceptance/p08-existing-demo.ts';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function fileDigest(path: string): string {
  return sha256(readFileSync(path, 'utf8'));
}

function statusState(index: string, worktree: string): 'modified_unstaged' | 'modified_staged' | 'untracked' {
  if (index === '?' && worktree === '?') return 'untracked';
  if (index !== ' ' && index !== '?') return 'modified_staged';
  return 'modified_unstaged';
}

export interface ExistingRepoFixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly dirtyTrackedPath: string;
  readonly stagedPath: string;
  readonly untrackedPath: string;
  snapshot(): ExistingRepoSnapshot;
  runKnownFailure(): { readonly exitCode: number; readonly status: 'failed'; readonly evidence: string };
  applyApprovedIncrement(): void;
  incrementChanges(): readonly ExistingRepoChange[];
  commitApprovedIncrement(): { readonly commitSha: string; readonly treeSha: string; readonly committedPaths: readonly string[] };
  dispose(): void;
}

function runExistingTest(repositoryPath: string, id: string, command: readonly string[], knownFailure: boolean): ExistingRepoTestResult {
  try {
    execFileSync(command[0]!, command.slice(1), { cwd: repositoryPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
    return { id, command: [...command], exitCode: 0, status: 'passed', knownFailure, evidenceRef: `tests/${id}.json` };
  } catch (error) {
    const exitCode = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : null;
    return { id, command: [...command], exitCode, status: exitCode === null ? 'not_run' : 'failed', knownFailure, evidenceRef: `tests/${id}.json` };
  }
}

export function createExistingRepoFixture(options: { readonly prefix?: string } = {}): ExistingRepoFixture {
  const root = mkdtempSync(join(tmpdir(), options.prefix ?? 'shiploop-f008-existing-'));
  const repositoryPath = join(root, 'repository');
  mkdirSync(repositoryPath, { recursive: true });
  initGitRepo(repositoryPath);
  writeFileSync(join(repositoryPath, 'README.md'), '# Existing Todo repository\n');
  mkdirSync(join(repositoryPath, 'src'), { recursive: true });
  mkdirSync(join(repositoryPath, 'test'), { recursive: true });
  mkdirSync(join(repositoryPath, 'docs'), { recursive: true });
  writeFileSync(join(repositoryPath, 'src/legacy.mjs'), 'export function legacyTitle() { return "old"; }\n');
  writeFileSync(join(repositoryPath, 'test/known-regression.mjs'), 'console.error("known regression"); process.exit(1);\n');
  writeFileSync(join(repositoryPath, 'test/existing-smoke.mjs'), 'process.exit(0);\n');
  writeFileSync(join(repositoryPath, 'docs/notes.md'), 'committed notes\n');
  commitAll(repositoryPath, 'fixture: initial non-nezha repository');

  const dirtyTrackedPath = join(repositoryPath, 'src/legacy.mjs');
  const stagedPath = join(repositoryPath, 'docs/notes.md');
  const untrackedPath = join(repositoryPath, 'notes/work-in-progress.md');
  writeFileSync(dirtyTrackedPath, 'export function legacyTitle() { return "old"; }\n// local work in progress\n');
  writeFileSync(stagedPath, 'committed notes\nlocal staged note\n');
  mkdirSync(join(repositoryPath, 'notes'), { recursive: true });
  writeFileSync(untrackedPath, 'keep this user file\n');
  git(['add', '--', 'docs/notes.md'], repositoryPath);

  const snapshot = (): ExistingRepoSnapshot => {
    const porcelain = git(['status', '--porcelain', '--untracked-files=all'], repositoryPath);
    const dirtyFiles = porcelain.split('\n').filter(Boolean).map(line => {
      const index = line[0] ?? ' ';
      const worktree = line[1] ?? ' ';
      const path = line.slice(3);
      return { path, state: statusState(index, worktree), digest: fileDigest(join(repositoryPath, path)) };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const trackedPaths = ['README.md', 'src/legacy.mjs', 'test/known-regression.mjs', 'test/existing-smoke.mjs', 'docs/notes.md'];
    const fileSnapshots = trackedPaths.map(path => ({ path, digest: fileDigest(join(repositoryPath, path)) }));
    const existingTests = [
      runExistingTest(repositoryPath, 'known-regression', ['node', 'test/known-regression.mjs'], true),
      runExistingTest(repositoryPath, 'existing-smoke', ['node', 'test/existing-smoke.mjs'], false),
    ];
    return {
      repository: { kind: 'non-nezha', projectId: 'existing-project-001', pathDigest: sha256(repositoryPath) },
      headCommit: git(['rev-parse', 'HEAD'], repositoryPath).trim(),
      statusPorcelain: porcelain,
      dirtyFiles,
      fileSnapshots,
      existingTests,
      knownFailures: existingTests.filter(test => test.knownFailure && test.status === 'failed').map(test => test.id),
    };
  };

  const incrementPaths = ['src/increment.mjs', 'test/increment.test.mjs'] as const;
  return {
    root,
    repositoryPath,
    dirtyTrackedPath,
    stagedPath,
    untrackedPath,
    snapshot,
    runKnownFailure: () => {
      const result = runExistingTest(repositoryPath, 'known-regression', ['node', 'test/known-regression.mjs'], true);
      return { exitCode: result.exitCode ?? -1, status: 'failed' as const, evidence: result.evidenceRef ?? 'tests/known-regression.json' };
    },
    applyApprovedIncrement: () => {
      writeFileSync(join(repositoryPath, incrementPaths[0]), 'export const archived = true;\n');
      writeFileSync(join(repositoryPath, incrementPaths[1]), 'import { archived } from "../src/increment.mjs";\nif (!archived) process.exit(1);\n');
    },
    incrementChanges: () => incrementPaths.map(path => ({
      path,
      kind: path.startsWith('test/') ? 'test' as const : 'code' as const,
      digest: fileDigest(join(repositoryPath, path)),
    })),
    commitApprovedIncrement: () => {
      git(['add', '--', ...incrementPaths], repositoryPath);
      git(['-c', 'user.name=ShipLoop Test', '-c', 'user.email=shiploop-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'increment: add archive marker'], repositoryPath);
      return {
        commitSha: git(['rev-parse', 'HEAD'], repositoryPath).trim(),
        treeSha: git(['rev-parse', 'HEAD^{tree}'], repositoryPath).trim(),
        committedPaths: [...incrementPaths],
      };
    },
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
