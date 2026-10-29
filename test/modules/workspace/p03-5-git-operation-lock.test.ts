import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createBaselineRepositoryGuard } from '../../../packages/core/src/adapters/fs/baseline-repository-guard.ts';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { deriveObservedRepoIdentity } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';
import { runBarrierChildren } from '../../helpers/p02-2/race-children.ts';
import { git } from '../../helpers/git-repo.ts';

const held: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of held.splice(0).reverse()) await dispose();
});
function fixture() {
  const box = createBaselineFixture();
  held.push(async () => box.dispose());
  return box;
}
function input(box: ReturnType<typeof createBaselineFixture>, operationId = randomUUID()) {
  const gitCommonDir = realpathSync(join(box.repos.withHead, '.git'));
  return { repoIdentity: deriveObservedRepoIdentity(gitCommonDir), workspacePath: box.repos.withHead, gitCommonDir, operationId };
}
function claimPath(lockInput: ReturnType<typeof input>) {
  return join(lockInput.gitCommonDir, 'shiploop-baseline.claim');
}

describe('F-003 Git public metadata lock', () => {
  it('serializes legacy path bindings with P06 inode bindings without weakening forged identity checks', async () => {
    const box = fixture(), modern = input(box), lock = createGitPublicMetadataLock();
    const legacy = { ...modern, operationId: randomUUID(), repoIdentity: deriveRepoIdentity(modern.gitCommonDir) };
    const lease = await lock.acquire(legacy);
    try { await expect(lock.acquire(modern)).rejects.toMatchObject({ code: 'resource_busy' }); }
    finally { await lease.release(); }
    const next = await lock.acquire(modern);
    try {
      await expect(lock.acquire(legacy)).rejects.toMatchObject({ code: 'resource_busy' });
      await expect(lock.acquire({ ...modern, repoIdentity: 'forged' })).rejects.toMatchObject({ code: 'conflict' });
    } finally { await next.release(); }
  });
  it('[case:baseline-work-lock] shares the common-dir claim between Work and baseline in both orders; release is idempotent', async () => {
    const box = fixture(), first = input(box), work = createGitPublicMetadataLock();
    const baseline = createBaselineRepositoryGuard();
    const lease = await work.acquire(first);
    expect(existsSync(claimPath(first))).toBe(true);
    await expect(baseline.acquire({ canonicalPath: first.workspacePath, gitCommonDir: first.gitCommonDir, operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'resource_busy', operation: 'baseline.run', details: { reason: 'baseline_in_progress' } });
    await lease.release();
    await lease.release();
    const baselineLease = await baseline.acquire({ canonicalPath: first.workspacePath, gitCommonDir: first.gitCommonDir, operationId: first.operationId });
    await expect(work.acquire(input(box))).rejects.toMatchObject({ code: 'resource_busy' });
    await baselineLease.release();
    await baselineLease.release();
    const next = await work.acquire(input(box));
    await next.release();
  });

  it('keeps unknown or damaged claims and native Git locks busy', async () => {
    const box = fixture(), lock = createGitPublicMetadataLock(), owner = input(box), claim = claimPath(owner);
    writeFileSync(claim, '{not-json');
    await expect(lock.acquire(input(box))).rejects.toMatchObject({ code: 'resource_busy' });
    await expect(lock.releaseRecovered(owner)).resolves.toBe(false);
    expect(readFileSync(claim, 'utf8')).toBe('{not-json');
    writeFileSync(claim, JSON.stringify({ operationId: owner.operationId }));
    await expect(lock.releaseRecovered(input(box))).resolves.toBe(false);
    await expect(lock.acquire(input(box))).rejects.toMatchObject({ code: 'resource_busy' });
    writeFileSync(join(owner.gitCommonDir, 'index.lock'), 'native');
    await expect(lock.releaseRecovered(owner)).resolves.toBe(false);
    expect(existsSync(claim)).toBe(true);
    await expect(lock.acquire(input(box))).rejects.toMatchObject({ code: 'resource_busy' });
    unlinkSync(join(owner.gitCommonDir, 'index.lock'));
    await expect(lock.releaseRecovered(owner)).resolves.toBe(true);
    await expect(lock.releaseRecovered(owner)).resolves.toBe(true);
  });

  it.each(['rewrite', 'replace'])('does not release another owner after claim %s', async mode => {
    const box = fixture(), lock = createGitPublicMetadataLock(), owner = input(box), path = claimPath(owner);
    const lease = await lock.acquire(owner);
    const replacement = JSON.stringify({ schemaVersion: 1, ...input(box) });
    if (mode === 'replace') renameSync(path, `${path}.old`);
    writeFileSync(path, replacement);
    await expect(lease.release()).rejects.toMatchObject({ code: 'conflict' });
    await expect(lease.release()).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(path, 'utf8')).toBe(replacement);
    await expect(lock.releaseRecovered(owner)).resolves.toBe(false);
  });

  it('requires exact schema and identity on explicit recovery, while accepting the historical claim', async () => {
    const box = fixture(), lock = createGitPublicMetadataLock(), owner = input(box), path = claimPath(owner);
    for (const change of [{ schemaVersion: 2 }, { schemaVersion: null }, { workspacePath: box.root },
      { repoIdentity: 'unknown' }, { gitCommonDir: box.root }]) {
      const content = JSON.stringify({ schemaVersion: 1, ...owner, ...change });
      writeFileSync(path, content);
      await expect(lock.releaseRecovered(owner)).resolves.toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
    writeFileSync(path, JSON.stringify({ operationId: owner.operationId, workspacePath: 'unknown' }));
    await expect(lock.releaseRecovered(owner)).resolves.toBe(false);
    writeFileSync(path, JSON.stringify({ operationId: owner.operationId }));
    await expect(lock.releaseRecovered(owner)).resolves.toBe(true);
    await lock.acquire(owner);
    await expect(lock.releaseRecovered(owner)).resolves.toBe(true);
  });

  it('canonicalizes aliases, rejects forged identity and keeps independent clones independent', async () => {
    const box = fixture(), lock = createGitPublicMetadataLock(), owner = input(box);
    await expect(lock.acquire({ ...owner, repoIdentity: 'forged' })).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(claimPath(owner))).toBe(false);
    const lease = await lock.acquire({ ...owner, workspacePath: box.repos.alias, gitCommonDir: join(box.repos.alias, '.git') });
    await expect(createGitPublicMetadataLock().acquire(input(box))).rejects.toMatchObject({ code: 'resource_busy' });
    const cloneCommon = realpathSync(join(box.repos.cloneA, '.git'));
    const clone = await lock.acquire({ ...owner, workspacePath: box.repos.cloneA, gitCommonDir: cloneCommon, repoIdentity: deriveObservedRepoIdentity(cloneCommon) });
    await clone.release();
    await lease.release();
  });

  it('[case:linked-worktree-lock] serializes linked worktrees and preserves native per-worktree, ref and symlink locks', async () => {
    const box = fixture(), lock = createGitPublicMetadataLock(), owner = input(box);
    const linked = join(box.root, 'linked');
    git(['worktree', 'add', '--detach', linked, 'HEAD'], box.repos.withHead, { home: box.homeDir });
    const linkedInput = { ...owner, workspacePath: linked, operationId: randomUUID() };
    const lease = await lock.acquire(owner);
    await expect(lock.acquire(linkedInput)).rejects.toMatchObject({ code: 'resource_busy' });
    await lease.release();
    const gitDir = realpathSync(resolve(linked, git(['rev-parse', '--git-dir'], linked).trim()));
    for (const path of [join(gitDir, 'index.lock'), join(owner.gitCommonDir, 'refs/heads/nested/branch.lock')]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'native');
      await expect(lock.acquire(linkedInput)).rejects.toMatchObject({ code: 'resource_busy' });
      expect(readFileSync(path, 'utf8')).toBe('native');
      unlinkSync(path);
    }
    symlinkSync(join(box.root, 'missing'), join(owner.gitCommonDir, 'config.lock'));
    try {
      await expect(lock.acquire(linkedInput)).rejects.toMatchObject({ code: 'resource_busy' });
      expect(existsSync(claimPath(owner))).toBe(false);
    } finally { unlinkSync(join(owner.gitCommonDir, 'config.lock')); }
  });

  it('[case:git-lock-race] allows at most one production-adapter holder in a real cross-process race', async () => {
    const box = fixture(), environment = createIsolatedHostEnvironment();
    held.push(() => environment.dispose());
    const results = await runBarrierChildren(environment, {
      scriptPath: fileURLToPath(new URL('../../helpers/git-public-lock-child.ts', import.meta.url)),
      configs: [{ input: input(box) }, { input: input(box) }],
    });
    expect(results.filter(result => result.result.ok === true)).toHaveLength(1);
    expect(results.filter(result => result.result.code === 'resource_busy')).toHaveLength(1);
    expect(existsSync(claimPath(input(box)))).toBe(false);
    const next = await createGitPublicMetadataLock().acquire(input(box));
    await next.release();
  });
});
