import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { GIT_OPERATION_SETTLED_EVENT_TYPE } from '../../../packages/core/src/ports/events.ts';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import type { WorkspaceInspection } from '../../../packages/core/src/ports/workspace-inspector.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';

type Fixture = Awaited<ReturnType<typeof gitCommitFixture>>;
const request = (f: Fixture) => ({ projectId: f.box.projectId, operationId: f.authorization.intent.operationId });
function reconciler(f: Fixture, verified: WorkspaceInspection | null) {
  return createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified });
}
async function pending(f: Fixture) {
  const verified = await f.inspector.inspect(f.baseline);
  git(['add', '--', ...f.authorization.allowedPaths], f.root);
  const operation = f.store.registerGitOperation({ ...f.authorization.intent, candidateTree: git(['write-tree'], f.root).trim() }).operation;
  return { verified, operation };
}
function commit(f: Fixture, message = gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId)) {
  git(['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com', 'commit', '--allow-empty', '--cleanup=verbatim', '-m', message], f.root);
}
const claimed = (f: Fixture) => existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'));

describe('F-004 Git commit reconciliation', () => {
  it('repairs a lost receipt after SQLite reopen without another commit or duplicate settlement', async () => {
    const f = await gitCommitFixture();
    const verified = await f.inspector.inspect(f.baseline);
    f.box.session.database.exec(`CREATE TRIGGER receipt_fault BEFORE UPDATE ON git_operations
      WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`);
    await expect(f.execute()).rejects.toThrow('injected receipt fault');
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    f.box.reopen();
    f.box.session.database.exec('DROP TRIGGER receipt_fault');
    const operations = createSqliteGitOperationStore(f.box.session);
    const service = createGitCommitReconciliationService({ ...f.deps, operations,
      readVerificationInspection: () => verified });
    const request = { projectId: f.box.projectId, operationId: f.authorization.intent.operationId };
    const result = await service.reconcile(request);
    expect(result.outcome).toBe('matched');
    expect(result.operation.status).toBe('succeeded');
    expect(result.operation.actualCommit).toBe(head);
    expect(result.operation.exitCode).toBeNull();
    expect(result.operation.durationMs).toBeNull();
    const snapshot = f.box.snapshot();
    for (let i = 0; i < 3; i++) expect(await service.reconcile(request)).toEqual(result);
    expect(f.box.snapshot()).toEqual(snapshot);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(false);
    expect(f.occupancy.leases).toHaveLength(3);
  });

  it('reports no observed result at expected HEAD, retains intent/claim and never calls commit', async () => {
    const f = await gitCommitFixture(), { verified } = await pending(f);
    const service = reconciler(f, verified);
    const before = f.box.snapshot();
    const result = await service.reconcile(request(f));
    expect(result).toMatchObject({ outcome: 'not_executed', reasonCode: 'commit_not_observed', operation: { status: 'pending' } });
    expect(await service.reconcile(request(f))).toEqual(result);
    expect(f.box.snapshot()).toEqual(before);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('1');
    expect(claimed(f)).toBe(true);
    await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
  });

  it.each(['external', 'message', 'identity', 'parent'] as const)('does not adopt a same-tree commit with mismatched %s', async kind => {
    const f = await gitCommitFixture(), { verified, operation } = await pending(f);
    if (kind === 'parent') git(['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com', 'commit', '--allow-empty', '-m', 'intervening user commit'], f.root);
    if (kind === 'identity') {
      git(['-c', 'user.name=External User', '-c', 'user.email=external@example.com', 'commit', '-m',
        gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId)], f.root);
    } else commit(f, kind === 'external' ? 'User commit with identical tree\n' : kind === 'message'
      ? gitOperationCommitMessage('Changed intent message', f.authorization.intent.operationId)
      : gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId));
    expect(git(['rev-parse', 'HEAD^{tree}'], f.root).trim()).toBe(operation.intent.candidateTree);
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    const result = await reconciler(f, verified).reconcile(request(f));
    expect(result).toMatchObject({ outcome: 'unknown', operation: { status: 'unknown', actualCommit: null,
      actualTree: null, deliveryStatus: 'pending', reasonCode: kind === 'parent' ? 'unexplained_head_drift' : 'commit_intent_mismatch' } });
    expect(f.store.getGitOperation(f.box.projectId, f.authorization.intent.operationId)).toEqual(result.operation);
    expect(claimed(f)).toBe(true);
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(head);
    const snapshot = f.box.snapshot();
    expect(await reconciler(f, verified).reconcile(request(f))).toEqual(result);
    expect(f.box.snapshot()).toEqual(snapshot);
  });

  it.each(['working', 'staged'] as const)('keeps a %s hook edit invalid after finding the associated commit', async kind => {
    const f = await gitCommitFixture(), { verified } = await pending(f);
    f.hook(`printf 'hook changed source\\n' > source.ts${kind === 'staged' ? '\ngit add -- source.ts' : ''}`);
    commit(f);
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    const result = await reconciler(f, verified).reconcile(request(f));
    expect(result).toMatchObject({ outcome: kind === 'staged' ? 'unknown' : 'failed',
      operation: { status: kind === 'staged' ? 'unknown' : 'failed', actualCommit: kind === 'staged' ? null : head,
        deliveryStatus: kind === 'staged' ? 'pending' : 'failed',
        reasonCode: kind === 'staged' ? 'candidate_tree_mismatch' : 'source_changed' } });
    if (kind === 'staged') expect(claimed(f)).toBe(true);
    expect(readFileSync(join(f.root, 'source.ts'), 'utf8')).toContain('hook changed source');
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it.each(['approvalCurrent', 'verificationPassed', 'commitAuthorized'] as const)('records Git facts but refuses delivery when %s is false', async key => {
    const f = await gitCommitFixture(), { verified } = await pending(f);
    commit(f);
    f.authorization = { ...f.authorization, [key]: false };
    const originalStatus = f.box.session.database.prepare('SELECT status FROM features WHERE id = ?').get(f.box.featureId);
    const result = await reconciler(f, verified).reconcile(request(f));
    expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'delivery_not_authorized',
      operation: { actualCommit: git(['rev-parse', 'HEAD'], f.root).trim(), deliveryStatus: 'failed' } });
    expect(f.box.session.database.prepare('SELECT status, delivery_status FROM features WHERE id = ?').get(f.box.featureId))
      .toMatchObject({ ...originalStatus as object, delivery_status: 'failed' });
  });

  it('cannot turn missing or wrong original verification evidence into delivery', async () => {
    const f = await gitCommitFixture(); await pending(f); commit(f);
    const result = await reconciler(f, null).reconcile(request(f));
    expect(result).toMatchObject({ outcome: 'unknown', reasonCode: 'verification_evidence_missing' });
    expect(claimed(f)).toBe(true);
  });

  it('keeps unknown processes and quarantined occupancy isolated without any scan or settlement', async () => {
    const f = await gitCommitFixture(), { verified } = await pending(f);
    const held = await f.deps.lock.acquire({ repoIdentity: f.baseline.repoIdentity, workspacePath: f.root,
      gitCommonDir: f.baseline.gitCommonDir, operationId: f.authorization.intent.operationId });
    f.setStopped(false);
    const before = f.box.snapshot();
    await expect(reconciler(f, verified).reconcile(request(f))).rejects.toMatchObject({ details: { reason: 'previous_writer_stop_unconfirmed' } });
    f.setStopped(true);
    f.occupancy = { ...f.occupancy, leases: f.occupancy.leases.map((l: { state: 'held' | 'quarantined' }) => ({ ...l, state: 'quarantined' as const })) };
    await expect(reconciler(f, verified).reconcile(request(f))).rejects.toMatchObject({ details: { reason: 'workspace_not_held' } });
    expect(f.box.snapshot()).toEqual(before); expect(claimed(f)).toBe(true);
    void held; // Ownership is intentionally retained for manual recovery.
  });

  it('concurrent readers settle the same retained operation once', async () => {
    const f = await gitCommitFixture(), { verified } = await pending(f); commit(f);
    await f.deps.lock.acquire({ repoIdentity: f.baseline.repoIdentity, workspacePath: f.root,
      gitCommonDir: f.baseline.gitCommonDir, operationId: f.authorization.intent.operationId });
    const result = await Promise.all([reconciler(f, verified).reconcile(request(f)), reconciler(f, verified).reconcile(request(f))]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0]?.outcome).toBe('matched');
    expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM state_events WHERE aggregate_id = ? AND event_type = ?')
      .get(f.authorization.intent.operationId, GIT_OPERATION_SETTLED_EVENT_TYPE)).toEqual({ count: 1 });
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('late authorization or writer changes cannot settle an old inspection', async () => {
    const f = await gitCommitFixture(), { verified } = await pending(f); commit(f);
    const before = f.box.snapshot();
    const service = createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified,
      inspector: { ...f.inspector, async inspect(baseline) {
        const result = await f.inspector.inspect(baseline);
        f.authorization = { ...f.authorization, approvalCurrent: false };
        return result;
      } } });
    await expect(service.reconcile(request(f))).rejects.toMatchObject({ details: { reason: 'authorization_changed' } });
    expect(f.box.snapshot()).toEqual(before); expect(claimed(f)).toBe(true);
  });

  it('an older receipt cannot overwrite a newer operation delivery projection', async () => {
    const f = await gitCommitFixture(), { verified } = await pending(f); commit(f);
    const newer = f.store.registerGitOperation({ ...f.authorization.intent, operationId: randomUUID(),
      candidateTree: git(['write-tree'], f.root).trim() }).operation;
    f.store.finalizeGitOperation({ operationId: newer.intent.operationId, projectId: f.box.projectId,
      expectedRevision: newer.revision, status: 'failed', actualCommit: null, actualTree: null,
      reasonCode: 'newer_failure', exitCode: null, durationMs: null, deliveryStatus: 'failed', settledAtUtcMs: 1_900_000_100_000 });
    const before = f.box.snapshot();
    await expect(reconciler(f, verified).reconcile(request(f))).rejects.toMatchObject({ details: { reason: 'superseded_operation' } });
    expect(f.box.snapshot()).toEqual(before);
    expect(f.box.session.database.prepare('SELECT delivery_status FROM features WHERE id = ?').get(f.box.featureId))
      .toEqual({ delivery_status: 'failed' });
  });
});
