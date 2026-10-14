import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandProcessIdentity, CommandProcessPort } from '../../ports/command-process.js';
import { CommandProcessError } from '../../ports/command-process.js';
import { devNull } from 'node:os';
import { createCommandProcessAdapter } from '../process/command-process.js';
import type { FeatureWorktreePreparer, WorkspacePreparationOutcome } from '../../ports/workspace-preparation.js';
import type { WorkspaceInspector } from '../../ports/workspace-inspector.js';
import { WorkspaceInspectionError } from '../../ports/workspace-inspector.js';
import { validateWorkspaceBaseline } from '../../ports/workspace.js';

export function createFeatureWorktreePreparer(options: {
  readonly inspector: WorkspaceInspector;
  readonly commandProcess?: CommandProcessPort;
  readonly confirmProcessIdentity: (identity: CommandProcessIdentity) => Promise<{ readonly launchId: string }>;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}): FeatureWorktreePreparer {
  const processes = options.commandProcess ?? createCommandProcessAdapter();
  return {
    async prepare(binding, rawBaseline, _operationId, admit) {
      const baseline = validateWorkspaceBaseline(rawBaseline);
      const startedAtUtcMs = Date.now();
      let isolated = false, exitCode: number | null = null, signal: string | null = null;
      function result() {
        const endedAtUtcMs = Date.now();
        return { startedAtUtcMs, endedAtUtcMs, durationMs: endedAtUtcMs - startedAtUtcMs, exitCode, signal };
      }
      async function git(args: string[], allowed = [0]) {
        admit();
        if (await realpath(binding.canonicalPath) !== binding.canonicalPath) throw new Error('source_path_changed');
        const previouslyIsolated = isolated;
        // A startup/result exception cannot prove that the supervised group stopped.
        isolated = true;
        const handle = await processes.start({ cwd: binding.canonicalPath,
          argv: ['/usr/bin/git', '--no-pager', '--no-optional-locks', '-c', `core.hooksPath=${devNull}`,
            '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
            '-c', 'protocol.allow=never', ...args],
          environment: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
            GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
          maxInputBytes: 65_536, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
          timeoutMs: options.timeoutMs ?? 30_000 }, options.confirmProcessIdentity);
        const chunks: Buffer[] = [];
        let outputFailed = false;
        try { for await (const event of handle.output) if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes)); }
        catch { outputFailed = true; await handle.cancel(); }
        const completed = await handle.result;
        exitCode = completed.exitCode; signal = completed.signal;
        if (!completed.stop.confirmed || !(await handle.stopped).confirmed) throw new Error('stop_unconfirmed');
        isolated = previouslyIsolated || outputFailed;
        if (outputFailed || completed.reason !== null || completed.droppedOutputBytes !== 0 || signal !== null
          || !allowed.includes(exitCode ?? -1)) throw new Error('git_command_failed');
        return { output: Buffer.concat(chunks).toString('utf8'), exitCode };
      }
      try {
        if ((await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).output.trim() !== baseline.gitCommonDir) throw new Error('source_common_dir_changed');
        await git(['cat-file', '-e', baseline.baseCommit + '^{commit}']);
        if ((await git(['rev-parse', '--verify', baseline.baseCommit + '^{commit}'])).output.trim() !== baseline.baseCommit) throw new Error('base_commit_mismatch');
        const occupied = await git(['show-ref', '--verify', '--quiet', 'refs/heads/' + baseline.branch], [0, 1]);
        if (occupied.exitCode === 0) throw new Error('branch_conflict');
        const listing = (await git(['worktree', 'list', '--porcelain', '-z'])).output;
        if (listing.split('\0').includes('worktree ' + baseline.canonicalPath)) throw new Error('registered_path_conflict');
        try { await lstat(baseline.canonicalPath); throw new Error('directory_conflict'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        // A PathService token authorizes the location; recheck aliases immediately before mkdir/Git.
        let ancestor = dirname(baseline.canonicalPath);
        for (;;) {
          try { if (await realpath(ancestor) !== ancestor) throw new Error('preparation_parent_changed'); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
        }
        const sourceHead = (await git(['rev-parse', '--verify', 'HEAD'])).output.trim();
        const sourceBranch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).output.trim();
        const sourceBaseline = { ...baseline, canonicalPath: binding.canonicalPath, branch: sourceBranch, baseCommit: sourceHead };
        const sourceBefore = await options.inspector.inspect(sourceBaseline);
        const refs = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).output;
        const indexPath = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).output.trim();
        const index = await readFile(indexPath);
        await mkdir(dirname(baseline.canonicalPath), { recursive: true });
        if (await realpath(dirname(baseline.canonicalPath)) !== dirname(baseline.canonicalPath)) throw new Error('preparation_parent_changed');
        admit();
        isolated = true;
        await git(['worktree', 'add', '-b', baseline.branch, baseline.canonicalPath, baseline.baseCommit]);
        const inspection = await options.inspector.inspect(baseline);
        if (inspection.repository.headCommit !== baseline.baseCommit || inspection.statusPorcelainBase64 !== ''
          || inspection.contents.untracked.length > 0 || inspection.contents.ignored.length > 0) throw new Error('created_worktree_not_at_baseline');
        const expectedRefs = (refs + `refs/heads/${baseline.branch} ${baseline.baseCommit}\n`).trim().split('\n').sort();
        const actualRefs = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).output.trim().split('\n').sort();
        const sourceAfter = await options.inspector.inspect(sourceBaseline);
        if (JSON.stringify(expectedRefs) !== JSON.stringify(actualRefs) || sourceAfter.repository.headCommit !== sourceHead
          || sourceAfter.codeDigest !== sourceBefore.codeDigest || sourceAfter.ignoredDigest !== sourceBefore.ignoredDigest
          || JSON.stringify(sourceAfter.contents) !== JSON.stringify(sourceBefore.contents)
          || !(await readFile(indexPath)).equals(index)) throw new Error('source_protection_changed');
        return { inspection, isolated: false, reason: null, result: result() };
      } catch (error) {
        if ((error instanceof WorkspaceInspectionError || error instanceof CommandProcessError)
          && error.reason === 'stop_unconfirmed') isolated = true;
        return { inspection: null, isolated, reason: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'workspace_preparation_failed', result: result() };
      }
    },
  };
}
