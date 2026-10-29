/** Read-only evidence for trusted projects. No SQLite, mutation, retry, or cleanup authority.
 * The caller commits each supervised identity before release via the existing process port.
 * Two bounded observations detect ordinary concurrent changes; they are not an OS sandbox.
 */
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CommandProcessError } from '../../ports/command-process.js';
import type { CommandProcessPort, ConfirmCommandProcessIdentity } from '../../ports/command-process.js';
import { observeRepoIdentityEvidence } from './repository-inspector.js';
import { deriveRepoIdentity } from '../../ports/repository-inspector.js';
import { validateWorkspaceBaseline, type WorkspaceBaseline } from '../../ports/workspace.js';
import { WorkspaceInspectionError, type WorkspaceContentEntry, type WorkspaceInspectionReason,
  type WorkspaceInspector } from '../../ports/workspace-inspector.js';
import { createCommandProcessAdapter } from '../process/command-process.js';

export interface WorkspaceInspectorOptions {
  readonly authorizedRoots: readonly string[];
  readonly processes?: CommandProcessPort;
  readonly confirmProcessIdentity: ConfirmCommandProcessIdentity;
  readonly limits?: Partial<WorkspaceInspectionLimits>;
}
export interface WorkspaceInspectionLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxOutputBytes: number;
  readonly gitTimeoutMs: number;
  readonly totalTimeoutMs: number;
}
const DEFAULTS: WorkspaceInspectionLimits = { maxFiles: 20_000, maxBytes: 256 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024, gitTimeoutMs: 10_000, totalTimeoutMs: 120_000 };
const MAX_GIT_CALLS = 22;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', PAGER: 'cat' });
const GIT_PREFIX = ['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${devNull}`,
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never'];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(reason: WorkspaceInspectionReason): never { throw new WorkspaceInspectionError(reason); }
const oid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
function text(bytes: Buffer): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) fail('invalid_git_output');
  return value;
}
function nulRecords(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) fail('invalid_git_output');
  return text(bytes.subarray(0, -1)).split('\0');
}
function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split('/').some(p => !p || p === '.' || p === '..')
    || path === '.git' || path.startsWith('.git/')) fail('invalid_git_output');
  return path;
}
function fingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function mapError(error: unknown): never {
  if (error instanceof WorkspaceInspectionError) throw error;
  if (error instanceof CommandProcessError) {
    if (error.reason === 'stop_unconfirmed') fail('stop_unconfirmed');
    if (error.reason === 'start_aborted') fail('scan_timeout');
    fail('git_failed');
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') fail('not_found');
  if (code === 'EACCES' || code === 'EPERM') fail('permission_denied');
  if (code === 'ELOOP') fail('symlink_rejected');
  fail('io');
}
function existingCanonical(path: string): string {
  const canonical = realpathSync(path);
  if (canonical !== resolve(path) || lstatSync(path).isSymbolicLink()) fail('symlink_rejected');
  if (!lstatSync(canonical).isDirectory()) fail('registration_damaged');
  return canonical;
}
function configure(options: WorkspaceInspectorOptions): WorkspaceInspectionLimits {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(k => !['authorizedRoots', 'processes', 'confirmProcessIdentity', 'limits'].includes(k))
    || !Array.isArray(options.authorizedRoots) || !options.authorizedRoots.length
    || typeof options.confirmProcessIdentity !== 'function'
    || (options.processes !== undefined && typeof options.processes?.start !== 'function')) fail('invalid_input');
  const raw = options.limits ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(k => !(k in DEFAULTS))) fail('invalid_input');
  const limits = { ...DEFAULTS, ...raw };
  for (const key of Object.keys(DEFAULTS) as (keyof WorkspaceInspectionLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULTS[key]) fail('invalid_input');
  }
  return limits;
}
interface GitSnapshot {
  readonly headCommit: string;
  readonly branch: string;
  readonly registration: { path: string; headCommit: string; branch: string };
  readonly refs: string;
  readonly status: string;
  readonly tracked: ReadonlyMap<string, { indexObject: string | null; indexMode: string | null }>;
  readonly untracked: ReadonlySet<string>;
  readonly ignored: ReadonlySet<string>;
  readonly identity: string;
}

export function createWorkspaceInspector(options: WorkspaceInspectorOptions): WorkspaceInspector {
  const limits = configure(options);
  const roots = options.authorizedRoots.map(root => {
    if (typeof root !== 'string' || root.length > 4096 || !isAbsolute(root) || root === sep || root.includes('\0')
      || root.split(sep).includes('..')) fail('invalid_input');
    const canonical = realpathSync(root);
    if (!lstatSync(canonical).isDirectory()) fail('invalid_input');
    return canonical;
  });
  const processes = options.processes ?? createCommandProcessAdapter();
  const confirm = options.confirmProcessIdentity;
  return { async inspect(input) {
    let baseline: WorkspaceBaseline;
    try { baseline = validateWorkspaceBaseline(input); } catch { return fail('invalid_input'); }
    if (baseline.branch === 'HEAD') fail('invalid_input');
    if (!roots.some(root => inside(root, baseline.canonicalPath))) fail('outside_authorized_root');
    /* P07-1 / F-002 恢复入口实体身份核验：现代（P06）身份以 Git common dir
     * 的文件系统对象标识（dev/ino）核对真实实体；旧路径派生身份保持已支持
     * 兼容（锁与绑定去重仍接受两种身份），但路径摘要匹配不能证明仓库实体
     * 未被替换（同路径重新 clone/重建的 dev/ino 已变）——旧绑定缺少实体证据
     * 时保持隔离并报告兼容限制，不以路径摘要回退证明安全；显式迁移沿用 P06
     * 授权入口，不在此自动重写历史 binding 或 operation 身份。 */
    const identityEvidence = observeRepoIdentityEvidence(baseline.gitCommonDir);
    if (identityEvidence.kind !== 'entity' || identityEvidence.repoIdentity !== baseline.repoIdentity) {
      if (baseline.repoIdentity === deriveRepoIdentity(baseline.gitCommonDir)) {
        fail('repository_identity_unverifiable');
      }
      fail('repository_mismatch');
    }
    const startedAt = new Date().toISOString();
    const deadline = performance.now() + limits.totalTimeoutMs;
    let gitCalls = 0, outputBytes = 0;
    const budget = () => { if (performance.now() >= deadline) fail('scan_timeout'); };
    try {
      existingCanonical(baseline.canonicalPath);
      existingCanonical(baseline.gitCommonDir);
      async function run(args: readonly string[], detachedAllowed = false): Promise<Buffer> {
        budget();
        if (++gitCalls > MAX_GIT_CALLS) fail('git_failed');
        // Recheck before each spawn; root/metadata aliases cannot authorize a changed cwd.
        existingCanonical(baseline.canonicalPath);
        const handle = await processes.start({ argv: [...GIT_PREFIX, ...args], cwd: baseline.canonicalPath,
          environment: ENVIRONMENT, timeoutMs: Math.max(1, Math.min(limits.gitTimeoutMs, Math.ceil(deadline - performance.now()))),
          maxInputBytes: 65_536, maxOutputBytes: limits.maxOutputBytes }, confirm,
          AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))));
        const chunks: Buffer[] = [];
        let overflow = false;
        try {
          for await (const event of handle.output) {
            outputBytes += event.bytes.length;
            if (outputBytes > limits.maxOutputBytes) {
              overflow = true; await handle.cancel();
            } else if (event.stream === 'stdout') chunks.push(Buffer.from(event.bytes));
          }
        } catch {
          await handle.cancel();
          if (!(await handle.stopped).confirmed) fail('stop_unconfirmed');
          fail('git_failed');
        }
        const result = await handle.result;
        if (!result.stop.confirmed || !(await handle.stopped).confirmed) fail('stop_unconfirmed');
        if (overflow || result.reason === 'output_overflow' || result.droppedOutputBytes !== 0) fail('output_limit');
        if (result.reason === 'timed_out') fail('git_timeout');
        if (result.reason === 'permission_denied') fail('permission_denied');
        if (detachedAllowed && result.exitCode === 1 && result.reason === null) fail('detached_head');
        if (result.reason !== null || result.exitCode !== 0 || result.signal !== null) {
          throw new WorkspaceInspectionError(args[0] === 'cat-file' ? 'commit_missing' : 'git_failed', result.exitCode, result.signal);
        }
        budget();
        return Buffer.concat(chunks);
      }
      async function marker(path: string): Promise<string> {
        budget();
        const fd = await open(path, READ_FLAGS);
        try {
          const stat = await fd.stat({ bigint: true });
          if (!stat.isFile()) fail('registration_damaged');
          if (stat.size > 16_384n) fail('registration_damaged');
          const bytes = Buffer.alloc(Number(stat.size) + 1);
          let size = 0;
          while (size < bytes.length) {
            const { bytesRead } = await fd.read(bytes, size, bytes.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (BigInt(size) !== stat.size || fingerprint(await fd.stat({ bigint: true })) !== fingerprint(stat)) fail('content_changed');
          const value = text(bytes.subarray(0, size));
          return value.endsWith('\n') ? value.slice(0, -1) : value;
        } finally { await fd.close(); }
      }
      async function verifyMarkers(): Promise<string> {
        const dotGit = join(baseline.canonicalPath, '.git');
        let dotStat;
        try { dotStat = await lstat(dotGit); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('registration_damaged'); throw error; }
        if (dotStat.isSymbolicLink()) fail('symlink_rejected');
        if (dotStat.isDirectory()) {
          if (existingCanonical(dotGit) !== baseline.gitCommonDir) fail('repository_mismatch');
          return baseline.gitCommonDir;
        }
        if (!dotStat.isFile()) fail('registration_damaged');
        const pointer = await marker(dotGit);
        if (!pointer.startsWith('gitdir: ') || !pointer.slice(8)) fail('registration_damaged');
        const gitDir = resolve(baseline.canonicalPath, pointer.slice(8));
        if (!inside(join(baseline.gitCommonDir, 'worktrees'), gitDir)) fail('repository_mismatch');
        try {
          existingCanonical(gitDir);
          if (resolve(gitDir, await marker(join(gitDir, 'commondir'))) !== baseline.gitCommonDir
            || resolve(gitDir, await marker(join(gitDir, 'gitdir'))) !== dotGit) fail('registration_damaged');
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) fail('registration_damaged');
          throw error;
        }
        return gitDir;
      }
      async function gitSnapshot(): Promise<GitSnapshot> {
        const registeredGitDir = await verifyMarkers();
        const meta = text(await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'])).split('\n');
        if (meta.length !== 4 || meta[3] !== '') fail('invalid_git_output');
        if (existingCanonical(meta[0]) !== baseline.canonicalPath || existingCanonical(meta[1]) !== baseline.gitCommonDir) fail('repository_mismatch');
        const gitDir = existingCanonical(meta[2]);
        if (gitDir !== registeredGitDir) fail('registration_damaged');
        if (text(await run(['cat-file', '-t', baseline.baseCommit])) !== 'commit\n') fail('commit_missing');
        const headCommit = text(await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
        if (!oid(headCommit)) fail('invalid_git_output');
        const branch = text(await run(['symbolic-ref', '--quiet', 'HEAD'], true)).trim();
        if (branch !== `refs/heads/${baseline.branch}`) fail('branch_mismatch');
        const records = nulRecords(await run(['worktree', 'list', '--porcelain', '-z']));
        const registrations: Record<string, string>[] = [];
        let row: Record<string, string> = {};
        for (const record of records) {
          if (record === '') { if (Object.keys(row).length) registrations.push(row); row = {}; continue; }
          const split = record.indexOf(' ');
          const key = split < 0 ? record : record.slice(0, split);
          if (key in row) fail('registration_damaged');
          row[key] = split < 0 ? '' : record.slice(split + 1);
        }
        if (Object.keys(row).length) fail('invalid_git_output');
        const matches = registrations.filter(r => r.worktree === baseline.canonicalPath);
        if (matches.length !== 1 || matches[0].HEAD !== headCommit || matches[0].branch !== branch
          || 'prunable' in matches[0] || 'bare' in matches[0] || 'detached' in matches[0]) fail('registration_damaged');
        const refs = text(await run(['show-ref', '--head']));
        const tracked = new Map<string, { indexObject: string | null; indexMode: string | null }>();
        for (const record of nulRecords(await run(['ls-files', '--stage', '-z']))) {
          const match = record.match(/^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
          if (!match || !oid(match[2])) fail('invalid_git_output');
          if (match[1] !== '100644' && match[1] !== '100755') fail('special_file');
          if (match[3] !== '0') fail('registration_damaged');
          const path = safeRelative(match[4]);
          if (tracked.has(path)) fail('invalid_git_output');
          tracked.set(path, { indexObject: match[2], indexMode: match[1] });
        }
        // HEAD-only paths retain staged deletion evidence, with no fabricated index object.
        for (const record of nulRecords(await run(['ls-tree', '-r', '-z', 'HEAD']))) {
          const match = record.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/);
          if (!match || !oid(match[3])) fail('invalid_git_output');
          if (match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) fail('special_file');
          const path = safeRelative(match[4]);
          if (!tracked.has(path)) tracked.set(path, { indexObject: null, indexMode: null });
        }
        const untracked = new Set(nulRecords(await run(['ls-files', '--others', '--exclude-standard', '-z'])).map(safeRelative));
        const ignored = new Set(nulRecords(await run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).map(safeRelative));
        for (const [path, entry] of tracked) {
          if (entry.indexObject !== null) { untracked.delete(path); ignored.delete(path); }
        }
        // Reject gitlinks before status could recurse into a nested repository.
        const status = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).toString('base64');
        const registration = { path: baseline.canonicalPath, headCommit, branch };
        const identity = JSON.stringify({ meta, registrations, refs, status, tracked: [...tracked], untracked: [...untracked], ignored: [...ignored] });
        return { headCommit, branch, registration, refs, status, tracked, untracked, ignored, identity };
      }
      async function scan(snapshot: GitSnapshot) {
        let count = 0, bytes = 0;
        const entries = new Map<string, WorkspaceContentEntry>();
        const directories: string[] = [];
        const stamps = new Map<string, string>();
        async function walk(directory: string, prefix: string, depth: number): Promise<void> {
          budget();
          if (depth > 64) fail('file_limit');
          const before = await lstat(directory, { bigint: true });
          if (before.isSymbolicLink()) fail('symlink_rejected');
          if (!before.isDirectory() || await realpath(directory) !== directory) fail('content_changed');
          stamps.set(prefix, fingerprint(before));
          const dir = await opendir(directory);
          try {
            for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
              budget();
              if (prefix === '' && entry.name === '.git') continue;
              if (++count > limits.maxFiles) fail('file_limit');
              const path = safeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
              const absolute = join(directory, entry.name);
              const before = await lstat(absolute, { bigint: true });
              if (before.isSymbolicLink()) fail('symlink_rejected');
              if (before.isDirectory()) { directories.push(path); await walk(absolute, path, depth + 1); continue; }
              if (!before.isFile()) fail('special_file');
              const index = snapshot.tracked.get(path);
              const protection = snapshot.untracked.has(path) || snapshot.ignored.has(path) ? 'preserve' : 'tracked';
              if (!index && !snapshot.untracked.has(path) && !snapshot.ignored.has(path)) fail('content_changed');
              if (before.size > BigInt(limits.maxBytes - bytes)) fail('byte_limit');
              const fd = await open(absolute, READ_FLAGS);
              const hash = createHash('sha256');
              let size = 0;
              try {
                if (fingerprint(await fd.stat({ bigint: true })) !== fingerprint(before)) fail('content_changed');
                const buffer = Buffer.alloc(65_536);
                for (;;) {
                  budget();
                  const { bytesRead } = await fd.read(buffer, 0, buffer.length, size);
                  if (!bytesRead) break;
                  size += bytesRead; bytes += bytesRead;
                  if (bytes > limits.maxBytes) fail('byte_limit');
                  hash.update(buffer.subarray(0, bytesRead));
                }
                if (BigInt(size) !== before.size || fingerprint(await fd.stat({ bigint: true })) !== fingerprint(before)
                  || fingerprint(await lstat(absolute, { bigint: true })) !== fingerprint(before)) fail('content_changed');
              } finally { await fd.close(); }
              stamps.set(path, fingerprint(before));
              entries.set(path, { path, state: 'present', sizeBytes: size, digest: hash.digest('hex'),
                mode: Number(before.mode & 0o777n), indexObject: index?.indexObject ?? null, indexMode: index?.indexMode ?? null, protection });
            }
          } finally { await dir.close(); }
          if (fingerprint(await lstat(directory, { bigint: true })) !== fingerprint(before)) fail('content_changed');
        }
        await walk(baseline.canonicalPath, '', 0);
        for (const path of snapshot.tracked.keys()) {
          if (!entries.has(path)) {
            // Only an absent tracked path is a deletion. A symlink ancestor is never followed.
            let absent = false;
            let current = baseline.canonicalPath;
            for (const part of path.split('/')) {
              current = join(current, part);
              try { if ((await lstat(current)).isSymbolicLink()) fail('symlink_rejected'); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { absent = true; break; } throw error; }
            }
            if (!absent) fail('content_changed');
            const index = snapshot.tracked.get(path)!;
            entries.set(path, { path, state: 'deleted', sizeBytes: null, digest: null, mode: null,
              indexObject: index.indexObject, indexMode: index.indexMode, protection: 'tracked' });
          }
        }
        for (const path of [...snapshot.untracked, ...snapshot.ignored]) if (!entries.has(path)) fail('content_changed');
        const ordered = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const contents = { tracked: ordered.filter(e => snapshot.tracked.has(e.path)).map(e =>
          snapshot.tracked.get(e.path)!.indexObject === null
            ? { ...e, state: 'deleted' as const, sizeBytes: null, digest: null, mode: null, protection: 'tracked' as const }
            : e),
          untracked: ordered.filter(e => snapshot.untracked.has(e.path)), ignored: ordered.filter(e => snapshot.ignored.has(e.path)),
          directories: directories.sort() };
        return { contents, count, bytes, identity: JSON.stringify([contents, [...stamps].sort()]) };
      }
      const firstGit = await gitSnapshot();
      if (firstGit.tracked.size + firstGit.untracked.size + firstGit.ignored.size > limits.maxFiles) fail('file_limit');
      const first = await scan(firstGit);
      const secondGit = await gitSnapshot();
      if (secondGit.identity !== firstGit.identity) fail('content_changed');
      const second = await scan(secondGit);
      if (second.identity !== first.identity) fail('content_changed');
      budget();
      existingCanonical(baseline.canonicalPath);
      existingCanonical(baseline.gitCommonDir);
      await verifyMarkers();
      const codeDigest = sha(JSON.stringify([first.contents.tracked, first.contents.untracked, firstGit.status]));
      const ignoredDigest = sha(JSON.stringify(first.contents.ignored));
      const repository = { ...baseline, headCommit: firstGit.headCommit };
      const facts = { schemaVersion: 1 as const, complete: true as const, repository, registration: firstGit.registration,
        statusPorcelainBase64: firstGit.status, refsDigest: sha(firstGit.refs), codeDigest, ignoredDigest, contents: first.contents,
        ignoredProtection: first.contents.ignored.length ? 'preserve' as const : 'none_present' as const,
        directoryProtection: first.contents.directories.length ? 'preserve' as const : 'none_present' as const,
        observedFileCount: first.count, observedBytes: first.bytes, boundary: 'trusted_project_not_os_sandbox' as const };
      return { ...facts, evidenceId: `sha256:${sha(JSON.stringify(facts))}`, startedAt,
        endedAt: new Date().toISOString(), gitCalls };
    } catch (error) { return mapError(error); }
  } };
}
