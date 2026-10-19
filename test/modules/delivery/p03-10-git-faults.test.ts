import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createSqliteGitOperationStore } from '../../../packages/core/src/adapters/sqlite/git-operations.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { openDeliveryVertical, type DeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { git } from '../../helpers/git-repo.ts';
import { gitScene, withGitFaultEvidence } from '../../helpers/p03-10/git-fault-evidence.ts';

function finalScene(f: DeliveryVertical) {
  return { git: gitScene(f.root), checkedCodeDigest: f.codeDigest,
    checks: f.diagnostics(), feature: f.db.prepare('SELECT status, delivery_status FROM features').all(),
    operations: f.db.prepare('SELECT * FROM git_operations').all(),
    approvals: f.db.prepare('SELECT id, kind, status, code_digest, decision_code_digest FROM task_approval_items').all(),
    source: readFileSync(join(f.root, 'src/upstream.ts'), 'utf8'),
    finalSource: readFileSync(join(f.root, 'src/final.ts'), 'utf8') };
}

async function finalCase(name: string, body: (f: DeliveryVertical) => Promise<void>) {
  const f = await openDeliveryVertical({ taskCommits: true, finalChanges: true });
  try { await withGitFaultEvidence(name, () => finalScene(f), () => body(f)); }
  finally { await f.close(); }
  expect(existsSync(f.root)).toBe(false);
}

test('[case:source-after-check] approved source changed after real Feature checks cannot complete or commit', async () => {
  await finalCase('source-after-check', async f => {
    await f.approve();
    f.afterVerify(() => writeFileSync(join(f.root, 'src/upstream.ts'), 'changed after checks\n'));
    const receipt = await f.finalize();
    expect(receipt).toMatchObject({ status: 'completed', result: { outcome: 'partial', runtimeCalled: false } });
    expect(f.head()).toBe(f.initialHead);
    expect(f.db.prepare('SELECT id FROM git_operations WHERE id = ?').all(f.operationId)).toEqual([]);
    expect(f.db.prepare('SELECT status FROM features').get()).toEqual({ status: 'partial' });
    expect(f.diagnostics()).toEqual([expect.objectContaining({ batch_status: 'passed', status: 'passed' })]);
    expect(readFileSync(join(f.root, 'src/upstream.ts'), 'utf8')).toBe('changed after checks\n');
    expect(f.counts()).toEqual({ runtimeCalls: 2, verificationCalls: 1 });
  });
}, 180_000);

test('[case:unapproved-final-source] missing human approval retains uncommitted final source and real check evidence', async () => {
  await finalCase('unapproved-final-source', async f => {
    f.insertItem();
    const before = gitScene(f.root);
    const receipt = await f.finalize();
    expect(receipt).toMatchObject({ status: 'completed', result: { outcome: 'awaiting_approval' } });
    expect(gitScene(f.root)).toEqual(before);
    expect(f.db.prepare('SELECT id FROM git_operations WHERE id = ?').all(f.operationId)).toEqual([]);
    expect(f.db.prepare('SELECT status FROM features').get()).toEqual({ status: 'awaiting_approval' });
    expect(f.diagnostics()).toEqual([expect.objectContaining({ batch_status: 'passed' })]);
    expect(readFileSync(join(f.root, 'src/final.ts'), 'utf8')).toBe('export const final = true;\n');
  });
}, 180_000);

test('[case:block-after-real-commit] a new persisted human block wins over successful Git without erasing HEAD/tree', async () => {
  await finalCase('block-after-real-commit', async f => {
    await f.approve();
    let blockId = '';
    f.afterCommit(() => { blockId = f.insertItem('block').id; });
    const receipt = await f.finalize();
    expect(receipt).toMatchObject({ status: 'completed', result: { outcome: 'partial' } });
    const row = f.operations.getGitOperation(f.fixture.projectId, f.operationId)!;
    expect(row).toMatchObject({ status: 'failed', reasonCode: 'authorization_or_occupancy_changed',
      actualCommit: f.head(), actualTree: gitScene(f.root).tree, deliveryStatus: 'failed' });
    expect(row.actualTree).toBe(row.intent.candidateTree);
    expect(f.head()).not.toBe(f.initialHead);
    expect(git(['rev-list', '--count', `${f.initialHead}..HEAD`], f.root).trim()).toBe('1');
    expect(f.db.prepare('SELECT kind, status FROM task_approval_items WHERE id = ?').get(blockId))
      .toEqual({ kind: 'block', status: 'pending' });
    expect(f.db.prepare('SELECT status FROM features').get()).not.toEqual({ status: 'completed' });
    expect(readFileSync(join(f.root, 'src/final.ts'), 'utf8')).toBe('export const final = true;\n');
  });
}, 180_000);

for (const point of ['before-commit', 'receipt-write'] as const) {
  test(`[case:recover-${point}] reconcile durable intent against actual Git before any retry`, async () => {
    const f = await gitCommitFixture();
    const verified = await f.inspector.inspect(f.baseline);
    const request = { projectId: f.box.projectId, operationId: f.authorization.intent.operationId };
    const initial = gitScene(f.root);
    await withGitFaultEvidence(`recover-${point}`, () => ({ git: gitScene(f.root), initial,
      verified: verificationCodeIdentity(verified), source: readFileSync(join(f.root, 'source.ts'), 'utf8'),
      operation: createSqliteGitOperationStore(f.box.session).getGitOperation(request.projectId, request.operationId),
      feature: f.box.session.database.prepare('SELECT status, delivery_status FROM features').all() }), async () => {
      if (point === 'before-commit') f.beforeCommit(() => { throw new Error('before_git_fault'); });
      else f.box.session.database.exec(`CREATE TRIGGER f012_receipt_fault BEFORE UPDATE ON git_operations
        WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'receipt_write_fault'); END`);
      await expect(f.execute()).rejects.toThrow(point === 'before-commit' ? 'before_git_fault' : 'receipt_write_fault');
      const observed = gitScene(f.root);
      const intent = f.store.getGitOperation(request.projectId, request.operationId);
      expect(intent.status).toBe('pending');
      expect(intent.actualCommit).toBeNull();
      expect(intent.intent.expectedHead).toBe(initial.head);
      expect(intent.intent.codeDigest).toBe(verificationCodeIdentity(verified).codeDigest);
      expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(true);
      await expect(f.execute()).rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
      f.box.reopen();
      if (point === 'receipt-write') f.box.session.database.exec('DROP TRIGGER f012_receipt_fault');
      const operations = createSqliteGitOperationStore(f.box.session);
      const service = createGitCommitReconciliationService({ ...f.deps, operations,
        readVerificationInspection: () => verified });
      const recovered = await service.reconcile(request);
      if (point === 'before-commit') {
        expect(observed.head).toBe(initial.head);
        expect(recovered).toMatchObject({ outcome: 'not_executed', operation: { status: 'pending', actualCommit: null } });
        expect(recovered.operation.status).not.toBe('no_change');
        expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(true);
      } else {
        expect(observed.head).not.toBe(initial.head);
        expect(observed.tree).toBe(intent.intent.candidateTree);
        expect(recovered).toMatchObject({ outcome: 'matched', operation: { status: 'succeeded',
          actualCommit: observed.head, actualTree: observed.tree, exitCode: null, durationMs: null } });
        expect(existsSync(join(f.baseline.gitCommonDir, 'shiploop-baseline.claim'))).toBe(false);
      }
      const bytes = f.box.session.database.serialize();
      expect(await service.reconcile(request)).toEqual(recovered);
      expect(f.box.session.database.serialize()).toEqual(bytes);
      expect(gitScene(f.root)).toEqual(observed);
      expect(git(['rev-list', '--count', `${initial.head}..HEAD`], f.root).trim()).toBe(point === 'before-commit' ? '0' : '1');
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM git_operations').get()).toEqual({ n: 1 });
    });
  }, 120_000);
}
