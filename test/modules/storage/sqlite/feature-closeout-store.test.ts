import { expect, it } from 'vitest';
import { openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import { createSqliteFeatureCloseoutStore } from '../../../../packages/core/src/adapters/sqlite/feature-closeout-store.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteRunDispatchSettlement } from '../../../../packages/core/src/adapters/sqlite/dispatch-settlement.ts';
import { gitCommitFixture } from '../../../helpers/controlled-git-commit.ts';
import { git } from '../../../helpers/git-repo.ts';

it('persists closeout admission, fences old receipts and retains repair count after reopen', async () => {
  const f = await openBudgetFixture();
  try {
    const { runId } = await f.start();
    const key = { projectId: f.projectId, featureId: f.featureId, runId, inputDigest: 'a'.repeat(64) };
    let store = createSqliteFeatureCloseoutStore(f.session);
    const first = store.admit(key, 'host-a', 3);
    expect(store.admit(key, 'host-b', 3)).toEqual(first);
    expect(() => store.admit({ ...key, inputDigest: 'b'.repeat(64) }, 'host-a', 3)).toThrow();
    const verifying = store.transition(first, { stage: 'verifying' });
    expect(() => store.transition(first, { stage: 'verifying' })).toThrow();
    const repairing = store.transition(verifying, { stage: 'repairing', reason: 'verification_failed' });
    expect(repairing.repairCount).toBe(1);
    f.reopen(); store = createSqliteFeatureCloseoutStore(f.session);
    expect(store.read(key.projectId, runId)).toEqual(repairing);
    expect(store.admit(key, 'host-new', 3).stage).toBe('repairing');
    expect(() => store.transition(repairing, { stage: 'completed' })).toThrow();
    let row = store.transition(repairing, { stage: 'pending' });
    for (let i = 1; i < 3; i++) {
      row = store.transition(row, { stage: 'verifying' });
      row = store.transition(row, { stage: 'repairing' });
      row = store.transition(row, { stage: 'pending' });
    }
    row = store.transition(row, { stage: 'verifying' });
    expect(() => store.transition(row, { stage: 'repairing' })).toThrow();
    expect(store.transition(row, { stage: 'failed', reason: 'repair_exhausted' }).repairCount).toBe(3);
  } finally { f.close(); }
});

it('uses the same durable claim across independent connections and rejects unauthorized deletion', async () => {
  const f = await openBudgetFixture();
  let peer: ReturnType<typeof openSqliteStorageSession> | undefined;
  try {
    const { runId } = await f.start();
    const key = { projectId: f.projectId, featureId: f.featureId, runId, inputDigest: 'a'.repeat(64) };
    const store = createSqliteFeatureCloseoutStore(f.session);
    peer = openSqliteStorageSession({ path: f.box.dbPath });
    const other = createSqliteFeatureCloseoutStore(peer);
    const first = store.admit(key, 'host-a', 0);
    expect(other.admit(key, 'host-b', 0)).toEqual(first);
    const active = store.transition(first, { stage: 'verifying' });
    expect(() => other.transition(first, { stage: 'verifying' })).toThrow();
    expect(other.read(key.projectId, runId)).toEqual(active);
    expect(() => f.session.database.prepare('DELETE FROM feature_closeouts WHERE run_id = ?').run(runId)).toThrow(/retained/);
    expect(() => f.session.database.prepare(`INSERT INTO feature_closeouts
      (project_id,run_id,feature_id,input_digest,stage,revision,repair_count,max_repairs,owner)
      VALUES (?,?,?,?,'pending',1,0,0,'other')`).run(f.projectId, 'foreign-run', f.featureId, key.inputDigest)).toThrow(/ownership/);
  } finally { peer?.close(); f.close(); }
});

it('retains dispatch resources when a closeout side effect needs reconciliation', async () => {
  const f = await openBudgetFixture();
  try {
    const { runId } = await f.start();
    const key = { projectId: f.projectId, featureId: f.featureId, runId, inputDigest: 'a'.repeat(64) };
    const dispatch = createSqliteRunDispatchSettlement(f.session);
    expect(dispatch.read({ projectId: key.projectId, runId }).stopUncertain).toBe(false);
    const store = createSqliteFeatureCloseoutStore(f.session);
    const row = store.transition(store.admit(key, 'host-a', 0), { stage: 'verifying' });
    store.transition(row, { stage: 'reconcile_required', reason: 'verification_outcome_unknown' });
    expect(dispatch.read({ projectId: key.projectId, runId }).stopUncertain).toBe(true);
  } finally { f.close(); }
});

it('does not treat an owned in-flight Git intent as lease loss, but retains it after Run termination', async () => {
  const f = await gitCommitFixture();
  const ref = { projectId: f.box.projectId, runId: f.authorization.intent.runId };
  f.store.registerGitOperation({ ...f.authorization.intent, candidateTree: git(['write-tree'], f.root).trim() });
  const dispatch = createSqliteRunDispatchSettlement(f.box.session);
  expect(dispatch.read(ref).stopUncertain).toBe(false);
  f.box.session.transactWrite('test.terminalUnknownGit', () =>
    f.box.session.database.prepare("UPDATE runs SET status='failed',revision=revision+1 WHERE id=?").run(ref.runId));
  expect(dispatch.read(ref).stopUncertain).toBe(true);
});
