import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';

describe('P07 F-007 uncertain commit facts', () => {
  it('[case:tree-mismatch] retains an unknown same-owner commit whose tree differs from the durable candidate', async () => {
    const f = await gitCommitFixture();
    const verified = await f.inspector.inspect(f.baseline);
    git(['add', '--', 'source.ts'], f.root);
    f.store.registerGitOperation({ ...f.authorization.intent, candidateTree: git(['write-tree'], f.root).trim() });
    writeFileSync(join(f.root, 'source.ts'), 'external change\n');
    git(['add', '--', 'source.ts'], f.root);
    git(['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com', 'commit', '--cleanup=verbatim', '-m',
      gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId)], f.root);
    const result = await createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified })
      .reconcile({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId });
    expect(result).toMatchObject({ outcome: 'unknown', operation: { status: 'unknown', actualCommit: null,
      reasonCode: 'candidate_tree_mismatch' } });
    expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(true);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('[case:no-observed-commit] keeps a pending no-change candidate at expected HEAD unexecuted', async () => {
    const f = await gitCommitFixture();
    // The candidate was the original HEAD tree; an intent alone proves no execution.
    const verified = await f.inspector.inspect(f.baseline);
    f.store.registerGitOperation({ ...f.authorization.intent, candidateTree: git(['rev-parse', 'HEAD^{tree}'], f.root).trim() });
    const result = await createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified })
      .reconcile({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId });
    expect(result).toMatchObject({ outcome: 'not_executed', operation: { status: 'pending' } });
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('1');
  });
});
