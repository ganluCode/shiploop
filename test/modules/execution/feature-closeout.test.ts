import { expect, it, vi } from 'vitest';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createSqliteFeatureCloseoutStore } from '../../../packages/core/src/adapters/sqlite/feature-closeout-store.ts';
import { createFeatureCloseoutCoordinator, type FeatureCloseoutConsumers } from '../../../packages/core/src/application/feature-closeout.ts';
import { FeatureCloseoutPreparationError } from '../../../packages/core/src/ports/feature-closeout.ts';

async function fixture() {
  const f = await openBudgetFixture();
  const { runId } = await f.start();
  const key = { projectId: f.projectId, featureId: f.featureId, runId, inputDigest: 'a'.repeat(64) };
  const consumers: FeatureCloseoutConsumers = {
    authorize: vi.fn(async () => ({ allowed: true, reason: 'approved' })),
    verify: vi.fn(async () => ({ passed: true, evidenceRef: 'verification-1', reason: 'verified' })),
    repair: vi.fn(async () => ({ stopped: true, repaired: true })),
    complete: vi.fn(async () => 'completed' as const),
  };
  const store = createSqliteFeatureCloseoutStore(f.session);
  return { f, key, store, consumers };
}

it('coalesces duplicate wakes and does not repeat completed verification or delivery', async () => {
  const t = await fixture();
  try {
    const service = createFeatureCloseoutCoordinator({ ...t, owner: 'host-a' });
    const [a, b] = await Promise.all([service.execute(t.key), service.execute(t.key)]);
    expect(a).toEqual(b); expect(a.stage).toBe('completed');
    await service.execute(t.key);
    expect(t.consumers.verify).toHaveBeenCalledTimes(1);
    expect(t.consumers.complete).toHaveBeenCalledTimes(1);
  } finally { t.f.close(); }
});

it('persists three repairs at most, rechecks after each and never delivers failed checks', async () => {
  const t = await fixture();
  try {
    t.consumers.verify = vi.fn(async () => ({ passed: false, evidenceRef: 'failed-verification', reason: 'checks_failed' }));
    const service = createFeatureCloseoutCoordinator({ ...t, owner: 'host-a', maxRepairs: 3 });
    const result = await service.execute(t.key);
    expect(result.stage).toBe('failed'); expect(result.repairCount).toBe(3);
    expect(result.evidenceRef).toBe('failed-verification');
    expect(t.consumers.repair).toHaveBeenCalledTimes(3);
    expect(t.consumers.verify).toHaveBeenCalledTimes(4);
    expect(t.consumers.complete).not.toHaveBeenCalled();
    t.f.reopen();
    const next = createFeatureCloseoutCoordinator({ store: createSqliteFeatureCloseoutStore(t.f.session), consumers: t.consumers, owner: 'host-b', maxRepairs: 3 });
    expect((await next.execute(t.key)).repairCount).toBe(3);
    expect(t.consumers.verify).toHaveBeenCalledTimes(4);
  } finally { t.f.close(); }
});

it('honors a manual hold after verification and quarantines an unknown delivery without retry', async () => {
  const t = await fixture();
  try {
    let allowed = true;
    t.consumers.authorize = vi.fn(async () => ({ allowed, reason: 'manual_hold' }));
    t.consumers.verify = vi.fn(async () => { allowed = false; return { passed: true, evidenceRef: 'verified', reason: 'verified' }; });
    const service = createFeatureCloseoutCoordinator({ ...t, owner: 'host-a' });
    expect((await service.execute(t.key)).stage).toBe('blocked');
    expect(t.consumers.complete).not.toHaveBeenCalled();
  } finally { t.f.close(); }
  const u = await fixture();
  try {
    u.consumers.complete = vi.fn(async () => { throw new Error('lost_response'); });
    const service = createFeatureCloseoutCoordinator({ ...u, owner: 'host-a' });
    expect((await service.execute(u.key)).stage).toBe('reconcile_required');
    await service.execute(u.key);
    expect(u.consumers.complete).toHaveBeenCalledTimes(1);
  } finally { u.f.close(); }
});

it('does not steal an in-progress side effect from another Host after reopen', async () => {
  const t = await fixture();
  try {
    const first = t.store.admit(t.key, 'old-host', 0);
    t.store.transition(first, { stage: 'verifying' });
    t.f.reopen();
    const service = createFeatureCloseoutCoordinator({ store: createSqliteFeatureCloseoutStore(t.f.session), consumers: t.consumers, owner: 'new-host' });
    expect((await service.execute(t.key)).stage).toBe('verifying');
    expect(t.consumers.verify).not.toHaveBeenCalled();
    expect(t.consumers.complete).not.toHaveBeenCalled();
  } finally { t.f.close(); }
});

it('does not accept a successful verifier response without a persistent evidence reference', async () => {
  const t = await fixture();
  try {
    t.consumers.verify = vi.fn(async () => ({ passed: true, evidenceRef: '', reason: 'verified' }));
    const service = createFeatureCloseoutCoordinator({ ...t, owner: 'host-a' });
    expect(await service.execute(t.key)).toMatchObject({ stage: 'failed', reason: 'verification_evidence_missing' });
    expect(t.consumers.complete).not.toHaveBeenCalled();
  } finally { t.f.close(); }
});

it('reports prelaunch configuration blocks without attempting a model repair', async () => {
  const t = await fixture();
  try {
    t.consumers.verify = vi.fn(async () => { throw new FeatureCloseoutPreparationError('feature_check_scope_missing'); });
    const service = createFeatureCloseoutCoordinator({ ...t, owner: 'host-a', maxRepairs: 3 });
    expect(await service.execute(t.key)).toMatchObject({ stage: 'blocked', reason: 'feature_check_scope_missing', repairCount: 0 });
    expect(t.consumers.repair).not.toHaveBeenCalled();
  } finally { t.f.close(); }
});
