import { createGitPublicMetadataLock } from '../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import type { GitPublicMetadataLockInput } from '../../packages/core/src/ports/git-public-metadata-lock.ts';
import { runBarrierChild } from './host/child-runtime.ts';

void runBarrierChild({ scenario: { name: 'git-public-lock-race', async onGo(context) {
  const lock = createGitPublicMetadataLock();
  let lease;
  try {
    lease = await lock.acquire(context.config.input as unknown as GitPublicMetadataLockInput);
    process.send?.({ kind: 'race-result', ok: true });
  } catch (error) {
    process.send?.({ kind: 'race-result', ok: false, code: (error as { code?: string }).code });
  }
  await context.closeRequested;
  await lease?.release();
} }, goTimeoutMs: 15000, watchdogMs: 45000 });
