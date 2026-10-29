/** Cooperative trusted-user boundary: external Git and same-user attackers can bypass it.
 * Claims are never reclaimed by PID/TTL. Git I/O must stay outside SQLite transactions.
 */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync,
  readSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PublicError, isUuidV4 } from '../../ports/commands.js';
import {
  GIT_PUBLIC_METADATA_CLAIM_FILE,
  type GitPublicMetadataLease,
  type GitPublicMetadataLock,
  type GitPublicMetadataLockInput,
} from '../../ports/git-public-metadata-lock.js';
import { deriveObservedRepoIdentity } from './repository-inspector.js';
import { deriveRepoIdentity } from '../../ports/repository-inspector.js';

const CLAIM_MAX_BYTES = 4096;
const SCAN_MAX_ENTRIES = 10000;
const SCAN_MAX_DEPTH = 64;
const OPERATION = 'git.publicMetadata';
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Claim = GitPublicMetadataLockInput & { readonly schemaVersion: 1 };

function busy(reason: string): PublicError {
  return new PublicError('resource_busy', OPERATION, undefined, { details: { reason } });
}
function conflict(): PublicError {
  return new PublicError('conflict', OPERATION);
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
function boundedRead(fd: number): string | undefined {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > CLAIM_MAX_BYTES) return undefined;
  const buffer = Buffer.alloc(CLAIM_MAX_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = readSync(fd, buffer, size, buffer.length - size, size);
    if (count === 0) break;
    size += count;
  }
  return size > CLAIM_MAX_BYTES ? undefined : buffer.toString('utf8', 0, size);
}
function marker(path: string): string {
  const fd = openSync(path, READ_FLAGS);
  try {
    const content = boundedRead(fd);
    if (content === undefined) throw conflict();
    return content.trim();
  } finally { closeSync(fd); }
}
function canonicalize(input: GitPublicMetadataLockInput): Claim {
  if (!isUuidV4(input.operationId)) throw new TypeError('Invalid Git metadata lock owner');
  try {
    const workspacePath = realpathSync(input.workspacePath);
    const gitCommonDir = realpathSync(input.gitCommonDir);
    const observedIdentity = deriveObservedRepoIdentity(gitCommonDir);
    // Existing pre-P06 bindings retain their path-derived identity; new bindings use inode identity.
    if ((input.repoIdentity !== observedIdentity && input.repoIdentity !== deriveRepoIdentity(gitCommonDir))
      || !lstatSync(workspacePath).isDirectory() || !lstatSync(gitCommonDir).isDirectory()) throw conflict();
    const repoIdentity = input.repoIdentity;
    const claim: Claim = { schemaVersion: 1, operationId: input.operationId, repoIdentity, workspacePath, gitCommonDir };
    if (Buffer.byteLength(JSON.stringify(claim)) > CLAIM_MAX_BYTES) throw conflict();
    return claim;
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw busy('git_metadata_unavailable');
  }
}
function claimPath(claim: Claim): string {
  return join(claim.gitCommonDir, GIT_PUBLIC_METADATA_CLAIM_FILE);
}
function nativeLockRoots(claim: Claim): string[] {
  const dotGit = join(claim.workspacePath, '.git');
  const stat = lstatSync(dotGit);
  let gitDir: string;
  if (stat.isDirectory()) gitDir = realpathSync(dotGit);
  else if (stat.isFile()) {
    const content = marker(dotGit);
    if (!content.startsWith('gitdir: ')) throw conflict();
    gitDir = realpathSync(resolve(dirname(dotGit), content.slice('gitdir: '.length)));
  } else throw conflict();
  let commonDir = gitDir;
  try { commonDir = realpathSync(resolve(gitDir, marker(join(gitDir, 'commondir')))); }
  catch (error) { if (!missing(error)) throw error; }
  if (commonDir !== claim.gitCommonDir) throw conflict();
  return [...new Set([commonDir, gitDir])];
}
function hasNativeLock(claim: Claim): boolean {
  let remaining = SCAN_MAX_ENTRIES;
  function scan(root: string, recursive: boolean, depth = 0): boolean {
    let directory;
    try { directory = opendirSync(root); }
    catch (error) { if (missing(error)) return false; throw error; }
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (--remaining < 0) throw busy('git_lock_scan_incomplete');
        if (entry.name.endsWith('.lock')) return true;
        if (!recursive) continue;
        if (entry.isSymbolicLink()) throw busy('git_lock_scan_incomplete');
        if (entry.isDirectory()) {
          if (depth >= SCAN_MAX_DEPTH) throw busy('git_lock_scan_incomplete');
          if (scan(join(root, entry.name), true, depth + 1)) return true;
        }
      }
      return false;
    } finally { directory.closeSync(); }
  }
  try {
    for (const root of nativeLockRoots(claim)) {
      if (scan(root, false)) return true;
      for (const tree of ['refs', 'logs', 'worktrees']) {
        if (scan(join(root, tree), true)) return true;
      }
      if (scan(join(root, 'objects', 'pack'), false)) return true;
    }
    return false;
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw busy('git_metadata_unavailable');
  }
}
function readClaim(fd: number): Record<string, unknown> | undefined {
  const content = boundedRead(fd);
  if (content === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
function owns(owner: Record<string, unknown> | undefined, expected: Claim, legacy = false): boolean {
  if (owner?.operationId !== expected.operationId) return false;
  if (legacy && Object.keys(owner).length === 1) return true;
  return Object.keys(owner).length === 5 && owner.schemaVersion === 1
    && owner.repoIdentity === expected.repoIdentity && owner.workspacePath === expected.workspacePath
    && owner.gitCommonDir === expected.gitCommonDir;
}
function removeOwned(path: string, expected: Claim, inode: { dev: number; ino: number } | undefined, legacy: boolean): void {
  const fd = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(fd);
    if ((inode && (opened.dev !== inode.dev || opened.ino !== inode.ino)) || !owns(readClaim(fd), expected, legacy)) throw conflict();
    const current = lstatSync(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino || !current.isFile() || current.nlink !== 1) throw conflict();
    unlinkSync(path);
  } finally { closeSync(fd); }
}
export function createGitPublicMetadataLock(): GitPublicMetadataLock {
  return {
    async acquire(input): Promise<GitPublicMetadataLease> {
      const claim = canonicalize(input);
      if (hasNativeLock(claim)) throw busy('git_native_lock');
      const path = claimPath(claim);
      let fd: number;
      try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy('git_operation_in_progress');
        throw busy('git_metadata_unavailable');
      }
      let inode;
      try {
        inode = fstatSync(fd);
        writeFileSync(fd, JSON.stringify(claim));
        fsyncSync(fd);
      } catch { throw busy('git_metadata_unavailable'); }
      finally { closeSync(fd); }
      // Partial writes deliberately retain a claim; only the exact owner may release it.
      let released = false;
      return { async release() {
        if (released) return;
        try { removeOwned(path, claim, inode, false); }
        catch (error) {
          if (error instanceof PublicError) throw error;
          throw conflict();
        }
        released = true;
      } };
    },
    async inspectRecovered(input): Promise<boolean> {
      try {
        const expected = canonicalize(input);
        if (hasNativeLock(expected)) return false;
        const path = claimPath(expected), fd = openSync(path, READ_FLAGS);
        try {
          const opened = fstatSync(fd), current = lstatSync(path);
          return opened.dev === current.dev && opened.ino === current.ino
            && current.isFile() && current.nlink === 1 && owns(readClaim(fd), expected);
        } finally { closeSync(fd); }
      } catch { return false; }
    },
    async releaseRecovered(input): Promise<boolean> {
      try {
        const expected = canonicalize(input);
        if (hasNativeLock(expected)) return false;
        try { removeOwned(claimPath(expected), expected, undefined, true); }
        catch (error) { return missing(error); }
        return true;
      } catch { return false; }
    },
  };
}
