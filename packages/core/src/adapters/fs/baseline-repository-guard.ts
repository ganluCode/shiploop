/**
 * Persistent cooperative claim in the real Git common directory, not a PID/TTL lock.
 * O_EXCL serializes roots/worktrees; uncertain/crashed owners are NEVER auto-reclaimed.
 * Recovery requires explicit stopped-owner verification (F-013). Advisory trusted-user
 * boundary only: external tools and malicious same-user processes can bypass it.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicError, isUuidV4 } from '../../ports/commands.js';
import type { BaselineRepositoryGuard } from '../../ports/baseline-execution.js';

export function createBaselineRepositoryGuard(): BaselineRepositoryGuard {
  return {
    async releaseRecovered(input) {
      if (!isUuidV4(input.operationId)) return false;
      const path = join(realpathSync(input.gitCommonDir), 'shiploop-baseline.claim');
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      try {
        const inode = fstatSync(fd);
        if (!inode.isFile() || inode.nlink !== 1 || inode.size > 1024) return false;
        const owner = JSON.parse(readFileSync(fd, 'utf8')) as { operationId?: unknown };
        if (owner.operationId !== input.operationId) return false;
        const current = lstatSync(path);
        if (current.dev !== inode.dev || current.ino !== inode.ino || !current.isFile() || current.nlink !== 1) return false;
        unlinkSync(path);
        return true;
      } catch { return false; }
      finally { closeSync(fd); }
    },
    async acquire(input) {
      if (!isUuidV4(input.operationId)) throw new TypeError('Invalid repository claim owner');
      const path = join(realpathSync(input.gitCommonDir), 'shiploop-baseline.claim');
      let fd: number;
      try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PublicError('resource_busy', 'baseline.run', undefined, { details: { reason: 'baseline_in_progress' } });
        throw new PublicError('internal', 'baseline.run');
      }
      let inode;
      try {
        inode = fstatSync(fd);
        writeFileSync(fd, JSON.stringify({ operationId: input.operationId }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // A partial write also leaves the claim in place: never hide an unknown owner.
      let released = false;
      return { async release() {
        if (released) return;
        const current = lstatSync(path);
        if (current.dev !== inode.dev || current.ino !== inode.ino || !current.isFile() || current.nlink !== 1) {
          throw new PublicError('conflict', 'baseline.run');
        }
        unlinkSync(path);
        released = true;
      } };
    },
  };
}
