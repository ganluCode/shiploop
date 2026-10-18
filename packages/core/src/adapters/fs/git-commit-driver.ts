import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { performance } from 'node:perf_hooks';
import { CommandProcessError } from '../../ports/command-process.js';
import type { CommandProcessPort, ConfirmCommandProcessIdentity } from '../../ports/command-process.js';
import { GitCommitProcessError } from '../../ports/controlled-git-commit.js';
import type { GitCommitDriver, GitCommitFacts } from '../../ports/controlled-git-commit.js';
import { createCommandProcessAdapter } from '../process/command-process.js';

const ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat', PAGER: 'cat' });
// Do NOT override core.hooksPath: real configured hooks are part of the trusted-project boundary.
const PREFIX = ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
  '-c', 'commit.gpgsign=false'];
const oid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
function invalid(): never { throw new GitCommitProcessError('invalid_git_output', true); }
function decode(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes)) invalid();
  return value;
}
export function createGitCommitDriver(options: {
  readonly processes?: CommandProcessPort;
  readonly confirmProcessIdentity: ConfirmCommandProcessIdentity;
}): GitCommitDriver {
  const processes = options.processes ?? createCommandProcessAdapter();
  return { open(baseline, admit) {
    const deadline = performance.now() + 120_000;
    let calls = 0, outputBytes = 0;
    async function run(args: readonly string[], stdin?: Uint8Array, identity?: { name: string; email: string }, allowFailure = false) {
      admit();
      if (++calls > 1100 || performance.now() >= deadline) throw new GitCommitProcessError('git_budget_exhausted', true);
      if (realpathSync(baseline.canonicalPath) !== baseline.canonicalPath
        || realpathSync(baseline.gitCommonDir) !== baseline.gitCommonDir) throw new GitCommitProcessError('path_changed', true);
      const started = performance.now();
      let handle;
      try {
        handle = await processes.start({ argv: [...PREFIX, ...args], cwd: baseline.canonicalPath,
          environment: { ...ENV, ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
            GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}) },
          stdin, timeoutMs: Math.max(1, Math.min(30_000, Math.ceil(deadline - performance.now()))),
          maxInputBytes: 65_536, maxOutputBytes: 1024 * 1024 }, async identity => {
          const receipt = await options.confirmProcessIdentity(identity);
          // Confirmation can yield; recheck authority before the supervised process is released.
          admit();
          return receipt;
        });
      } catch (error) {
        if (error instanceof CommandProcessError) throw new GitCommitProcessError(error.reason, error.reason !== 'stop_unconfirmed');
        throw error;
      }
      const chunks: Buffer[] = [];
      try {
        for await (const event of handle.output) {
          outputBytes += event.bytes.length;
          if (outputBytes > 4 * 1024 * 1024) await handle.cancel();
          else if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes));
        }
      } catch {
        await handle.cancel();
        throw new GitCommitProcessError('git_output_failed', (await handle.stopped).confirmed);
      }
      const result = await handle.result;
      if (!result.stop.confirmed || !(await handle.stopped).confirmed) throw new GitCommitProcessError('stop_unconfirmed', false, result.exitCode);
      const reason = result.reason ?? (result.signal !== null ? 'git_signal' : null);
      if (outputBytes > 4 * 1024 * 1024 || result.droppedOutputBytes) throw new GitCommitProcessError('output_limit', true, result.exitCode);
      if (!allowFailure && (reason !== null || result.exitCode !== 0)) throw new GitCommitProcessError(reason ?? 'git_failed', true, result.exitCode);
      return { output: Buffer.concat(chunks), exitCode: result.exitCode,
        durationMs: Math.ceil(performance.now() - started), reason };
    }
    async function output(args: readonly string[]): Promise<string> { return decode((await run(args)).output); }
    async function tree() {
      const value = (await output(['write-tree'])).trim();
      if (!oid(value)) invalid();
      return value;
    }
    return {
      tree,
      async stagedPaths() {
        const value = await output(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', 'HEAD', '--']);
        if (!value) return [];
        if (!value.endsWith('\0')) invalid();
        return value.slice(0, -1).split('\0');
      },
      async unstagedPaths() {
        const tracked = await output(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', '--']);
        const untracked = await output(['ls-files', '--others', '--exclude-standard', '-z']);
        if ((tracked && !tracked.endsWith('\0')) || (untracked && !untracked.endsWith('\0'))) invalid();
        return [...(tracked ? tracked.slice(0, -1).split('\0') : []), ...(untracked ? untracked.slice(0, -1).split('\0') : [])];
      },
      async stage(paths) {
        // Existing process protocol caps argv at 256 entries; retain one claim across batches.
        for (let offset = 0; offset < paths.length; offset += 128) {
          await run(['add', '-A', '--', ...paths.slice(offset, offset + 128)]);
        }
      },
      async verifyIndex(entries) {
        const records = await output(['ls-files', '--stage', '-z']);
        if (records && !records.endsWith('\0')) invalid();
        const index = new Map<string, { mode: string; object: string }>();
        for (const record of records ? records.slice(0, -1).split('\0') : []) {
          const match = record.match(/^(\d{6}) ([0-9a-f]+) 0\t([\s\S]+)$/);
          if (!match || !oid(match[2]) || index.has(match[3])) invalid();
          index.set(match[3], { mode: match[1], object: match[2] });
        }
        for (const entry of entries) {
          const staged = index.get(entry.path);
          if (entry.state === 'deleted') {
            if (staged) throw new GitCommitProcessError('index_source_mismatch', true);
          } else {
            if (!staged || staged.mode !== (entry.mode !== null && (entry.mode & 0o111) ? '100755' : '100644')) {
              throw new GitCommitProcessError('index_source_mismatch', true);
            }
            const blob = (await run(['cat-file', 'blob', staged.object])).output;
            if (createHash('sha256').update(blob).digest('hex') !== entry.digest) {
              throw new GitCommitProcessError('index_source_mismatch', true);
            }
          }
        }
      },
      async facts(): Promise<GitCommitFacts> {
        const head = (await output(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        if (!oid(head)) invalid();
        const raw = await output(['cat-file', 'commit', head]);
        const split = raw.indexOf('\n\n');
        if (split < 0) invalid();
        const headers = raw.slice(0, split).split('\n');
        const tree = headers.find(line => line.startsWith('tree '))?.slice(5) ?? '';
        const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
        if (!oid(tree) || parents.some(parent => !oid(parent))) invalid();
        function person(key: string) {
          const match = headers.find(line => line.startsWith(`${key} `))?.match(/^[a-z]+ (.+) <([^>]*)> \d+ [+-]\d{4}$/);
          if (!match) return invalid();
          return { name: match[1], email: match[2] };
        }
        return { head, tree, parents, message: raw.slice(split + 2), author: person('author'), committer: person('committer') };
      },
      async isAncestor(ancestor, descendant) {
        if (!oid(ancestor) || !oid(descendant)) invalid();
        const result = await run(['merge-base', '--is-ancestor', ancestor, descendant], undefined, undefined, true);
        if (result.reason !== null || (result.exitCode !== 0 && result.exitCode !== 1)) invalid();
        return result.exitCode === 0;
      },
      async commit(message, identity) {
        const result = await run(['commit', '--no-gpg-sign', '--cleanup=verbatim', '--file=-'], Buffer.from(message), identity, true);
        return { exitCode: result.exitCode, durationMs: result.durationMs, reason: result.reason };
      },
    };
  } };
}
