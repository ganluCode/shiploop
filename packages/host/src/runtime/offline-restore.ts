import { realpathSync } from 'node:fs';
import { createDataRestoreService } from 'shiploop-core/assembly';
import type { DataRestoreService, RestoreBoundary } from 'shiploop-core/assembly';
import { acquireWriterLock } from '../locking/writer-lock.js';

/** Offline owner assembly only. No HTTP/Work tool channel can replace an open database. */
export function createOfflineRestoreService(options: {
  readonly dataRoot: string;
  readonly boundary?: (point: RestoreBoundary) => Promise<void>;
}): DataRestoreService {
  const canonicalRoot = realpathSync(options.dataRoot);
  return createDataRestoreService({
    dataRoot: options.dataRoot,
    boundary: options.boundary,
    async withWriterLock(action) {
      const lock = await acquireWriterLock({ canonicalRoot, timeoutMs: 0 });
      try { return await action(); } finally { lock.releaseAfterWritesClosed(); }
    },
  });
}
