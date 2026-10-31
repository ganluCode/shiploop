import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { GitCommitProcessError, gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';

type Fixture = Awaited<ReturnType<typeof gitCommitFixture>>;
const request = (f: Fixture) => ({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId });
const claimed = (f: Fixture) => existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'));

async function pendingOperation(f: Fixture) {
  const verified = await f.inspector.inspect(f.baseline);
  git(['add', '--', ...f.authorization.allowedPaths], f.root);
  const operation = f.store.registerGitOperation({
    ...f.authorization.intent,
    candidateTree: git(['write-tree'], f.root).trim(),
  }).operation;
  return { verified, operation };
}

function externalCommit(f: Fixture, message: string) {
  git(['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com',
    'commit', '--allow-empty', '--cleanup=verbatim', '-m', message], f.root);
}

describe('P07-5 F-004 Git commit recovery boundary', () => {
  it('[case:p07-f004-recover-lost-receipt] reopens a real operation after commit durability and settles it once without another commit', async () => {
    const f = await gitCommitFixture();
    const verified = await f.inspector.inspect(f.baseline);
    const before = f.box.snapshot();
    f.afterCommit(() => {
      throw new GitCommitProcessError('stop_unconfirmed', false);
    });

    await expect(f.execute()).rejects.toMatchObject({ reason: 'stop_unconfirmed' });
    const operationId = f.authorization.intent.operationId;
    const durableHead = git(['rev-parse', 'HEAD'], f.root).trim();
    const durableTree = git(['rev-parse', 'HEAD^{tree}'], f.root).trim();
    expect(durableHead).not.toBe(f.baseline.baseCommit);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(f.store.getGitOperation(f.box.projectId, operationId).status).toBe('pending');
    expect(claimed(f)).toBe(true);

    /* Reopen the SQLite session as the replacement Host would; the original
     * process has already stopped and the retained claim is still exact-owner. */
    f.box.reopen();
    const operations = createSqliteGitOperationStore(f.box.session);
    const recovered = await createGitCommitReconciliationService({ ...f.deps, operations,
      readVerificationInspection: () => verified }).reconcile(request(f));

    expect(recovered).toMatchObject({ outcome: 'matched', operation: {
      status: 'succeeded', actualCommit: durableHead, actualTree: durableTree,
      intent: { operationId },
    } });
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(durableHead);
    expect(git(['rev-parse', 'HEAD^{tree}'], f.root).trim()).toBe(durableTree);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(claimed(f)).toBe(false);
    expect(f.occupancy.leases).toHaveLength(3);
    expect(f.box.snapshot()).not.toEqual(before);

    const snapshot = f.box.snapshot();
    expect(await createGitCommitReconciliationService({ ...f.deps, operations,
      readVerificationInspection: () => verified }).reconcile(request(f))).toEqual(recovered);
    expect(f.box.snapshot()).toEqual(snapshot);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  }, 30_000);

  it('[case:p07-f004-preserve-conflicting-facts] quarantines a post-commit source drift and keeps tracked and untracked work intact', async () => {
    const f = await gitCommitFixture();
    const { verified } = await pendingOperation(f);
    externalCommit(f, gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId));
    const keep = join(f.root, 'uncommitted.keep');
    writeFileSync(join(f.root, 'source.ts'), 'external post-commit source\n');
    writeFileSync(keep, 'retain this failed-scene file\n');

    const result = await createGitCommitReconciliationService({ ...f.deps,
      readVerificationInspection: () => verified }).reconcile(request(f));

    expect(result).toMatchObject({ outcome: 'failed', operation: {
      status: 'failed', reasonCode: 'source_changed', deliveryStatus: 'failed',
    } });
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toBe('external post-commit source\n');
    expect(readFileSync(keep, 'utf8')).toBe('retain this failed-scene file\n');
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(git(['status', '--porcelain'], f.root)).toContain(' M source.ts');
    expect(git(['status', '--porcelain'], f.root)).toContain('?? uncommitted.keep');
  }, 30_000);

  it('[case:p07-f004-missing-evidence] keeps an unexplainable commit pending with its claim for manual handling', async () => {
    const f = await gitCommitFixture();
    await pendingOperation(f);
    externalCommit(f, gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId));

    const result = await createGitCommitReconciliationService({ ...f.deps,
      readVerificationInspection: () => null }).reconcile(request(f));

    expect(result).toMatchObject({ outcome: 'unknown', operation: {
      status: 'unknown', actualCommit: null, actualTree: null,
      reasonCode: 'verification_evidence_missing', deliveryStatus: 'pending',
    } });
    expect(claimed(f)).toBe(true);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  }, 30_000);
});
