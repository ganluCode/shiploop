/**
 * F-009 非强制 Feature worktree 清理器（fs/Git 适配器）。
 *
 * 不变量：
 * - 只使用非强制 `git worktree remove`；永不传 --force、永不递归删除目录、
 *   永不触碰源仓库内容或分支；
 * - 删除前复核：规范路径与目录身份、Git 登记、HEAD/代码摘要/ignored 摘要与
 *   授权时快照一致；源仓库 HEAD/refs/index/脏内容在删除前后逐项不变；
 * - 变更性 Git 命令的进程身份先落库（checkpoint.recordProcess），确认整组停止
 *   后才允许记录停止（recordStop）；停止不确定 → isolated，由上层隔离；
 * - 恢复：已有 verified 检查点且目录与登记均已消失 → 核对分支与源仓库后补写
 *   事实；目录与登记状态不一致 → 明确诊断（inconsistent_removal_state），不猜测；
 * - 授权门槛（gates.authorize）在删除前最后重核；fencing（gates.fence）贯穿全程。
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { devNull } from 'node:os';
import type { CommandProcessIdentity, CommandProcessPort } from '../../ports/command-process.js';
import { CommandProcessError } from '../../ports/command-process.js';
import { createCommandProcessAdapter } from '../process/command-process.js';
import type {
  FeatureWorktreeCleaner, WorkspaceCleanerCheckpoint, WorkspaceCleanerExpected,
  WorkspaceCleanerOutcome, WorkspaceCleanerSourceState, WorkspaceCleanerVerified,
} from '../../ports/workspace-cleaner.js';
import type { RepositoryBindingRecord } from '../../ports/state-store.js';
import { StorageError } from '../../ports/errors.js';
import type { WorkspaceBaseline } from '../../ports/workspace.js';
import { validateWorkspaceBaseline } from '../../ports/workspace.js';
import { WorkspaceInspectionError } from '../../ports/workspace-inspector.js';
import type { WorkspaceInspector } from '../../ports/workspace-inspector.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type GitRun = (args: string[], allowed?: number[]) => Promise<{ output: string; exitCode: number }>;

export function createFeatureWorktreeCleaner(options: {
  readonly inspector: WorkspaceInspector;
  readonly commandProcess?: CommandProcessPort;
  readonly confirmProcessIdentity: (identity: CommandProcessIdentity) => Promise<{ readonly launchId: string }>;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}): FeatureWorktreeCleaner {
  const processes = options.commandProcess ?? createCommandProcessAdapter();

  /** Read-only supervised Git against the source checkout; throws on any anomaly. */
  function readonlyGit(binding: RepositoryBindingRecord, fence: () => void,
    onStopUnconfirmed: () => void): GitRun {
    return async (args, allowed = [0]) => {
      fence();
      if (await realpath(binding.canonicalPath) !== binding.canonicalPath) throw new Error('source_path_changed');
      const handle = await processes.start({ cwd: binding.canonicalPath,
        argv: ['/usr/bin/git', '--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`,
          '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
          '-c', 'protocol.allow=never', ...args],
        environment: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
          GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
        maxInputBytes: 65_536, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
        timeoutMs: options.timeoutMs ?? 30_000 }, identity => options.confirmProcessIdentity(identity));
      const chunks: Buffer[] = [];
      let outputFailed = false;
      try { for await (const event of handle.output) if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes)); }
      catch { outputFailed = true; await handle.cancel(); }
      const completed = await handle.result;
      if (!completed.stop.confirmed || !(await handle.stopped).confirmed) {
        onStopUnconfirmed();
        throw new Error('stop_unconfirmed');
      }
      if (outputFailed || completed.reason !== null || completed.droppedOutputBytes !== 0 || completed.signal !== null
        || !allowed.includes(completed.exitCode ?? -1)) throw new Error('git_command_failed');
      return { output: Buffer.concat(chunks).toString('utf8'), exitCode: completed.exitCode ?? -1 };
    };
  }

  async function sourceState(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline, git: GitRun): Promise<WorkspaceCleanerSourceState> {
    const headCommit = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).output.trim();
    const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).output.trim();
    const refs = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).output;
    const indexPath = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).output.trim();
    const indexDigest = sha(await readFile(indexPath));
    const sourceBaseline = { ...baseline, canonicalPath: binding.canonicalPath, branch, baseCommit: headCommit };
    const inspection = await options.inspector.inspect(sourceBaseline);
    return { headCommit, branch, refsDigest: sha(refs), codeDigest: inspection.codeDigest,
      ignoredDigest: inspection.ignoredDigest, indexDigest };
  }

  /** 'removed' = directory and registration both gone; 'present' = both exist. */
  async function removalState(baseline: WorkspaceBaseline, git: GitRun): Promise<'removed' | 'present' | 'inconsistent'> {
    let directory = true;
    try { await lstat(baseline.canonicalPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      directory = false;
    }
    const listing = (await git(['worktree', 'list', '--porcelain', '-z'])).output;
    const registered = listing.split('\0').includes('worktree ' + baseline.canonicalPath);
    return directory && registered ? 'present' : !directory && !registered ? 'removed' : 'inconsistent';
  }

  async function verifyBranchAndSource(binding: RepositoryBindingRecord, baseline: WorkspaceBaseline,
    git: GitRun, verified: WorkspaceCleanerVerified): Promise<void> {
    const branchHead = (await git(['rev-parse', '--verify', `refs/heads/${baseline.branch}^{commit}`])).output.trim();
    if (branchHead !== verified.headCommit) throw new Error('branch_changed');
    const source = await sourceState(binding, baseline, git);
    if (!isDeepStrictEqual(source, verified.source)) throw new Error('source_repository_changed');
  }

  async function clean(binding: RepositoryBindingRecord, rawBaseline: unknown, expected: WorkspaceCleanerExpected,
    gates: { fence(): void; authorize(): string | null }, checkpoint: WorkspaceCleanerCheckpoint): Promise<WorkspaceCleanerOutcome> {
    const baseline = validateWorkspaceBaseline(rawBaseline);
    const startedAtUtcMs = Date.now();
    let isolated = false, exitCode: number | null = null, signal: string | null = null;
    let persistenceFailed = false;
    const git = readonlyGit(binding, () => gates.fence(), () => { isolated = true; });
    function persist(action: () => void) {
      try { action(); } catch (error) { persistenceFailed = true; throw error; }
    }
    function result() {
      const endedAtUtcMs = Date.now();
      return { startedAtUtcMs, endedAtUtcMs, durationMs: endedAtUtcMs - startedAtUtcMs, exitCode, signal };
    }
    function refusal(reason: string): WorkspaceCleanerOutcome {
      return { removed: false, recovered: false, removedHeadCommit: null, removedCodeDigest: null,
        reason, isolated: false, result: result() };
    }
    async function directoryIdentity() {
      if (await realpath(baseline.canonicalPath) !== baseline.canonicalPath) throw new Error('directory_identity_changed');
      const stat = await lstat(baseline.canonicalPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory_identity_changed');
      return { device: String(stat.dev), inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
    }
    async function verifyContentsMatch() {
      const inspection = await options.inspector.inspect(baseline);
      if (inspection.repository.headCommit !== expected.headCommit) throw new Error('head_or_digest_changed');
      if (inspection.codeDigest !== expected.codeDigest || inspection.ignoredDigest !== expected.ignoredDigest) {
        throw new Error('workspace_contents_changed');
      }
    }
    async function remove(verified: WorkspaceCleanerVerified): Promise<WorkspaceCleanerOutcome> {
      // A startup/result exception cannot prove that the supervised group stopped.
      isolated = true;
      const handle = await processes.start({ cwd: binding.canonicalPath,
        argv: ['/usr/bin/git', '--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`,
          '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
          '-c', 'protocol.allow=never', 'worktree', 'remove', baseline.canonicalPath],
        environment: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
          GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
        maxInputBytes: 65_536, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
        timeoutMs: options.timeoutMs ?? 30_000 }, async identity => {
          persist(() => checkpoint.recordProcess(identity));
          return options.confirmProcessIdentity(identity);
        });
      const chunks: Buffer[] = [];
      let outputFailed = false;
      try { for await (const event of handle.output) if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes)); }
      catch { outputFailed = true; await handle.cancel(); }
      const completed = await handle.result;
      exitCode = completed.exitCode; signal = completed.signal;
      if (!completed.stop.confirmed || !(await handle.stopped).confirmed) throw new Error('stop_unconfirmed');
      persist(() => checkpoint.recordStop(handle.identity));
      // The supervised group is confirmed stopped; a refusal here is never process uncertainty.
      isolated = false;
      if (outputFailed || completed.reason !== null || completed.droppedOutputBytes !== 0 || signal !== null
        || completed.exitCode !== 0) throw new Error('git_removal_refused');
      if (await removalState(baseline, git) !== 'removed') throw new Error('inconsistent_removal_state');
      await verifyBranchAndSource(binding, baseline, git, verified);
      gates.fence();
      return { removed: true, recovered: false, removedHeadCommit: verified.headCommit,
        removedCodeDigest: verified.codeDigest, reason: null, isolated: false, result: result() };
    }
    try {
      gates.fence();
      if (await realpath(binding.canonicalPath) !== binding.canonicalPath) throw new Error('source_path_changed');
      if ((await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).output.trim() !== baseline.gitCommonDir) {
        throw new Error('source_common_dir_changed');
      }
      const state = await removalState(baseline, git);
      const verified = checkpoint.verified;
      if (verified !== null) {
        if (verified.headCommit !== expected.headCommit || verified.codeDigest !== expected.codeDigest
          || verified.ignoredDigest !== expected.ignoredDigest) throw new Error('head_or_digest_changed');
        if (state === 'removed') {
          // The receipt was never committed: reconcile actual Git/file state, never re-delete.
          await verifyBranchAndSource(binding, baseline, git, verified);
          gates.fence();
          return { removed: true, recovered: true, removedHeadCommit: verified.headCommit,
            removedCodeDigest: verified.codeDigest, reason: null, isolated: false, result: result() };
        }
        if (state !== 'present') return refusal('inconsistent_removal_state');
        if (!isDeepStrictEqual(await directoryIdentity(), verified.directoryIdentity)) throw new Error('directory_identity_changed');
        await verifyContentsMatch();
        gates.fence();
        const refused = gates.authorize();
        if (refused !== null) return refusal(refused);
        return await remove(verified);
      }
      if (state !== 'present') return refusal('inconsistent_removal_state');
      const directory = await directoryIdentity();
      await verifyContentsMatch();
      const source = await sourceState(binding, baseline, git);
      const recorded: WorkspaceCleanerVerified = { headCommit: expected.headCommit, codeDigest: expected.codeDigest,
        ignoredDigest: expected.ignoredDigest, directoryIdentity: directory, source };
      persist(() => checkpoint.recordVerified(recorded));
      gates.fence();
      const refused = gates.authorize();
      if (refused !== null) return refusal(refused);
      return await remove(recorded);
    } catch (error) {
      if (persistenceFailed) throw error;
      if (error instanceof StorageError) throw error;
      if ((error instanceof WorkspaceInspectionError || error instanceof CommandProcessError)
        && error.reason === 'stop_unconfirmed') isolated = true;
      return { removed: false, recovered: false, removedHeadCommit: null, removedCodeDigest: null,
        reason: error instanceof WorkspaceInspectionError ? error.reason
          : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'workspace_cleanup_failed',
        isolated, result: result() };
    }
  }

  async function confirmRemoval(binding: RepositoryBindingRecord, rawBaseline: unknown, verified: WorkspaceCleanerVerified): Promise<void> {
    const baseline = validateWorkspaceBaseline(rawBaseline);
    const git = readonlyGit(binding, () => { /* receipt window: fencing runs in the store layer */ }, () => { /* read-only */ });
    if (await removalState(baseline, git) !== 'removed') throw new Error('cleanup_removal_unconfirmed');
    await verifyBranchAndSource(binding, baseline, git, verified);
  }

  return { clean, confirmRemoval };
}
