import { expect, test } from 'vitest';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';

function inspection(mode: number, head = 'a'.repeat(40)) {
  // Pure identity projection: no database/Git state or success evidence is seeded.
  return { repository: { headCommit: head }, contents: {
    tracked: [{ path: 'script.sh', state: 'present', digest: 'b'.repeat(64), mode }],
    untracked: [], ignored: [],
  } } as unknown as WorkspaceInspection;
}

test('[case:verification-mode-bound] unchanged bytes with changed executable mode invalidate verification', () => {
  expect(verificationCodeIdentity(inspection(0o644)).codeDigest)
    .not.toBe(verificationCodeIdentity(inspection(0o755)).codeDigest);
});

test('[case:verification-head-bound] HEAD remains an independent required verification identity', () => {
  const before = verificationCodeIdentity(inspection(0o644));
  const after = verificationCodeIdentity(inspection(0o644, 'c'.repeat(40)));
  expect(after.codeDigest).toBe(before.codeDigest);
  expect(after.headCommit).not.toBe(before.headCommit);
});
