import { expect, it } from 'vitest';
import { openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';
import { createSqliteFeatureCloseoutStore } from '../../../../packages/core/src/adapters/sqlite/feature-closeout-store.ts';
import { openSqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';

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
