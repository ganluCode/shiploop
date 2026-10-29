import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { gitOperationCommitMessage } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';

async function executed() {
  const f = await gitCommitFixture();
  const verified = await f.inspector.inspect(f.baseline);
  git(['add', '--', 'source.ts'], f.root);
  f.store.registerGitOperation({ ...f.authorization.intent, candidateTree: git(['write-tree'], f.root).trim() });
  git(['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com', 'commit', '--cleanup=verbatim', '-m',
    gitOperationCommitMessage(f.authorization.intent.message, f.authorization.intent.operationId)], f.root);
  return { f, verified, request: { projectId: f.box.projectId, operationId: f.authorization.intent.operationId } };
}
const claimed = (f: any) => existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'));

describe('P07 F-007 receipt faults and overlapping recovery', () => {
  it('[case:unreadable-facts] persists unknown and retains the exact claim when Git facts cannot be read', async () => {
    const { f, verified, request } = await executed();
    const driver = { open: (baseline: typeof f.baseline, current: () => void) => ({ ...f.deps.driver.open(baseline, current),
      facts: async () => { throw new Error('unreadable Git object'); } }) };
    const result = await createGitCommitReconciliationService({ ...f.deps, driver, readVerificationInspection: () => verified }).reconcile(request);
    expect(result).toMatchObject({ outcome: 'unknown', reasonCode: 'git_facts_unavailable' });
    expect(claimed(f)).toBe(true);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('[case:fresh-reader-overlap] overlapping readers with no pre-existing claim settle and release once', async () => {
    const { f, verified, request } = await executed();
    let admitSecond!: () => void;
    const barrier = new Promise<void>(resolve => { admitSecond = resolve; });
    let firstReading!: () => void;
    const reading = new Promise<void>(resolve => { firstReading = resolve; });
    let inspections = 0;
    const inspector = { ...f.inspector, async inspect(baseline: typeof f.baseline) {
      const result = await f.inspector.inspect(baseline);
      if (++inspections === 1) { firstReading(); await barrier; }
      return result;
    } };
    const service = createGitCommitReconciliationService({ ...f.deps, inspector, readVerificationInspection: () => verified });
    const first = service.reconcile(request);
    await reading;
    const second = service.reconcile(request);
    const secondResult = await second;
    admitSecond();
    expect(await first).toEqual(secondResult);
    expect(secondResult).toMatchObject({ outcome: 'matched', operation: { status: 'succeeded' } });
    expect(f.box.session.database.prepare("SELECT COUNT(*) AS n FROM state_events WHERE aggregate_id = ? AND event_type = 'git.operation.settled'")
      .get(request.operationId)).toEqual({ n: 1 });
    expect(claimed(f)).toBe(false);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
  });

  it('[case:receipt-failure-restart] a second receipt failure rolls back facts/events and a later reopen settles once', async () => {
    const f = await gitCommitFixture();
    const verified = await f.inspector.inspect(f.baseline);
    f.box.session.database.exec(`CREATE TRIGGER receipt_failure BEFORE UPDATE ON git_operations
      WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'receipt_failure'); END`);
    await expect(f.execute()).rejects.toThrow('receipt_failure');
    const request = { projectId: f.box.projectId, operationId: f.authorization.intent.operationId };
    const pending = f.store.getGitOperation(request.projectId, request.operationId);
    await expect(createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified }).reconcile(request)).rejects.toThrow('receipt_failure');
    expect(f.store.getGitOperation(request.projectId, request.operationId)).toEqual(pending);
    f.box.reopen();
    f.box.session.database.exec('DROP TRIGGER receipt_failure');
    const operations = createSqliteGitOperationStore(f.box.session);
    const service = createGitCommitReconciliationService({ ...f.deps, operations, readVerificationInspection: () => verified });
    const recovered = await service.reconcile(request);
    expect(recovered.outcome).toBe('matched');
    expect(await service.reconcile(request)).toEqual(recovered);
    expect(git(['rev-list', '--count', 'HEAD'], f.root).trim()).toBe('2');
    expect(f.occupancy.leases).toHaveLength(3);
  });

  it.each(['head', 'index', 'authorization'] as const)('[case:async-drift-%s] fences drift during observation without settlement or resource release', async kind => {
    const { f, verified, request } = await executed();
    let changed = false;
    const inspector = { ...f.inspector, async inspect(baseline: typeof f.baseline) {
      const result = await f.inspector.inspect(baseline);
      if (!changed) {
        changed = true;
        if (kind === 'authorization') f.authorization = { ...f.authorization, approvalCurrent: false };
        else if (kind === 'head') git(['-c', 'user.name=External', '-c', 'user.email=external@example.test', 'commit', '--allow-empty', '-m', 'external'], f.root);
        else { writeFileSync(join(f.root, 'source.ts'), 'external staged change\n'); git(['add', 'source.ts'], f.root); }
      }
      return result;
    } };
    await expect(createGitCommitReconciliationService({ ...f.deps, inspector, readVerificationInspection: () => verified }).reconcile(request)).rejects.toThrow();
    expect(f.store.getGitOperation(request.projectId, request.operationId).status).toBe('pending');
    expect(claimed(f)).toBe(true);
    expect(f.occupancy.leases).toHaveLength(3);
  });

  it.each(['unknown-claim', 'native-lock'] as const)('[case:retain-%s] preserves foreign claims and native locks', async kind => {
    const { f, verified, request } = await executed();
    const path = join(f.baseline.gitCommonDir, kind === 'unknown-claim' ? 'shiploop-baseline.claim' : 'index.lock');
    writeFileSync(path, kind);
    await expect(createGitCommitReconciliationService({ ...f.deps, readVerificationInspection: () => verified }).reconcile(request)).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(f.store.getGitOperation(request.projectId, request.operationId).status).toBe('pending');
  });
});
