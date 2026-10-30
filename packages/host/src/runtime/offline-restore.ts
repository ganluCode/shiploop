import { realpathSync } from 'node:fs';
import { createBackupPackageVerificationService } from 'shiploop-core/assembly';
import type { BackupPackageVerificationService } from 'shiploop-core';
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

/**
 * P07-3 / F-014：离线备份包只读核验（owner 维护入口；不连接 Host）。
 * dataRoot 仅用于受管 staging 布局；verify 只读，不发布、不修改目标。
 */
export function createOfflineBackupVerificationService(options: {
  readonly dataRoot: string;
}): BackupPackageVerificationService {
  return createBackupPackageVerificationService({ dataRoot: options.dataRoot });
}
