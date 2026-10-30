import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGitPublicMetadataLock } from '../../../packages/core/src/adapters/fs/git-public-metadata-lock.ts';
import { deriveObservedRepoIdentity } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { deriveRepoIdentity } from '../../../packages/core/src/ports/repository-inspector.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { initGitRepo } from '../../helpers/git-repo.ts';

it('[case:common-directory-replacement] 持锁期间 Git common dir 同路径实体替换后，新旧身份都不能把旧 lease 当有效', async () => {
  const box = createTempSandbox('shiploop-common-identity-');
  try {
    const source = join(realpathSync(box.path), 'source');
    initGitRepo(source);
    const common = join(source, '.git');
    const lock = createGitPublicMetadataLock();
    const input = { operationId: randomUUID(), workspacePath: source, gitCommonDir: common, repoIdentity: deriveRepoIdentity(common) };
    const lease = await lock.acquire(input);
    lease.assertCurrent!();
    renameSync(common, common + '.original');
    mkdirSync(common);
    try { expect(() => lease.assertCurrent!()).toThrow(); }
    finally { rmSync(common, { recursive: true }); renameSync(common + '.original', common); await lease.release(); }
  } finally { box.cleanup(); }
});

it('[case:overlap-barrier] 持有现代身份 lease 的屏障期间，旧身份请求确定争用同一 claim', async () => {
  const box = createTempSandbox('shiploop-common-overlap-');
  try {
    const source = join(realpathSync(box.path), 'source'); initGitRepo(source);
    const common = join(source, '.git'), lock = createGitPublicMetadataLock();
    let enter!: () => void, leave!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const leaving = new Promise<void>(resolve => { leave = resolve; });
    const holding = (async () => {
      const lease = await lock.acquire({ operationId: randomUUID(), workspacePath: source, gitCommonDir: common, repoIdentity: deriveObservedRepoIdentity(common) });
      enter();
      try { await leaving; lease.assertCurrent!(); } finally { await lease.release(); }
    })();
    try {
      await Promise.race([entered, holding]);
      await expect(lock.acquire({ operationId: randomUUID(), workspacePath: source, gitCommonDir: common, repoIdentity: deriveRepoIdentity(common) }))
        .rejects.toMatchObject({ code: 'resource_busy' });
    } finally { leave(); await holding; }
    const lease = await lock.acquire({ operationId: randomUUID(), workspacePath: source, gitCommonDir: common, repoIdentity: deriveRepoIdentity(common) });
    await lease.release();
  } finally { box.cleanup(); }
});

it('[case:source-link-native-lock] 公开锁拒绝源目录链接，持锁后出现原生锁时重新核验失败', async () => {
  const box = createTempSandbox('shiploop-common-link-');
  try {
    const source = join(realpathSync(box.path), 'source'); initGitRepo(source);
    const common = join(source, '.git'), lock = createGitPublicMetadataLock();
    const alias = join(box.path, 'source-alias'); symlinkSync(source, alias);
    const input = { operationId: randomUUID(), workspacePath: source, gitCommonDir: common, repoIdentity: deriveObservedRepoIdentity(common) };
    await expect(lock.acquire({ ...input, workspacePath: alias })).rejects.toMatchObject({ code: 'conflict' });
    const lease = await lock.acquire(input);
    try {
      writeFileSync(join(common, 'index.lock'), 'external');
      expect(() => lease.assertCurrent!()).toThrow();
    } finally { await lease.release(); }
  } finally { box.cleanup(); }
});
