import { realpathSync } from 'node:fs';
import { createGitPublicMetadataLock } from './git-public-metadata-lock.js';
import { PublicError, isUuidV4 } from '../../ports/commands.js';
import { deriveObservedRepoIdentity } from './repository-inspector.js';
import type { GitPublicMetadataLock } from '../../ports/git-public-metadata-lock.js';
import type { BaselineRepositoryGuard } from '../../ports/baseline-execution.js';

export function createBaselineRepositoryGuard(options: { lock?: GitPublicMetadataLock } = {}): BaselineRepositoryGuard {
  const lock = options.lock ?? createGitPublicMetadataLock();
  const mapError = (error: unknown): PublicError => error instanceof PublicError
    ? new PublicError(error.code, 'baseline.run', undefined, {
      ...(error.code === 'resource_busy' ? { details: { reason: 'baseline_in_progress' } } : {}), cause: error,
    })
    : new PublicError('internal', 'baseline.run', undefined, { cause: error });
  return {
    async releaseRecovered(input) {
      if (!isUuidV4(input.operationId)) return false;
      try {
        return await lock.releaseRecovered({
          operationId: input.operationId,
          repoIdentity: deriveObservedRepoIdentity(realpathSync(input.gitCommonDir)),
          workspacePath: realpathSync(input.canonicalPath),
          gitCommonDir: realpathSync(input.gitCommonDir),
        });
      } catch { return false; }
    },
    async acquire(input) {
      if (!isUuidV4(input.operationId)) throw new TypeError('Invalid repository claim owner');
      try {
        const lease = await lock.acquire({
          operationId: input.operationId,
          repoIdentity: deriveObservedRepoIdentity(realpathSync(input.gitCommonDir)),
          workspacePath: realpathSync(input.canonicalPath),
          gitCommonDir: realpathSync(input.gitCommonDir),
        });
        return { async release() {
          try { await lease.release(); } catch (error) { throw mapError(error); }
        } };
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}
