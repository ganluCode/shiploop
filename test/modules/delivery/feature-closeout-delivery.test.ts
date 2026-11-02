import { expect, it, vi } from 'vitest';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { createFeatureCloseoutDelivery } from '../../../packages/core/src/application/feature-closeout-delivery.ts';
import type { VerificationBatchRecord, CheckResultRecord } from '../../../packages/core/src/ports/verification-store.ts';

async function setup() {
  const f = await openBudgetFixture();
  const ids = await f.start();
  // Unit fixture setup only: these consumers are not default Host assembly.
  f.session.database.prepare("UPDATE tasks SET status='passed',revision=revision+1 WHERE id=?").run(ids.taskId);
  const key = { projectId: f.projectId, featureId: f.featureId, runId: ids.runId, inputDigest: 'a'.repeat(64) };
  const batch = { ...key, id: 'verification', operation: 'FeatureVerification.full', status: 'passed',
    codeDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64), checkSnapshot: [{ checkKey: 'unit' }] } as unknown as VerificationBatchRecord;
  const results = [{ checkKey: 'unit', status: 'passed', outputArtifactId: 'output' }] as CheckResultRecord[];
  const commit = vi.fn(async () => ({ intent: { operationId: 'commit-operation' }, status: 'succeeded', deliveryStatus: 'succeeded' }) as never);
  const readApproval = vi.fn(async () => ({ valid: true, reason: 'approved' }));
  const verifyEvidence = vi.fn(async () => true);
  const options = { atomic: f.services.atomic, commit: { commit }, verification: { getVerificationBatch: () => batch, listCheckResults: () => results },
    prepare: async () => ({ inputDigest: key.inputDigest, input: { projectId: f.projectId, featureId: f.featureId,
      runId: ids.runId, batchId: ids.batchId, operationId: 'commit-operation' }, codeDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) }),
    readApproval, verifyEvidence };
  return { f, key, options, commit, readApproval, verifyEvidence, batch, results };
}

it('settles Feature/Run/Batch through the existing transaction and reuses its terminal result', async () => {
  const t = await setup();
  try {
    const service = createFeatureCloseoutDelivery(t.options);
    expect(await service.complete(t.key, 'verification')).toBe('completed');
    expect(await service.complete(t.key, 'verification')).toBe('completed');
    expect(t.commit).toHaveBeenCalledTimes(1);
    expect(t.verifyEvidence).toHaveBeenCalledTimes(1);
    expect(t.f.session.database.prepare('SELECT status FROM runs WHERE id=?').get(t.key.runId)).toEqual({ status: 'succeeded' });
  } finally { t.f.close(); }
});

it('does not commit mismatched verification identity or corrupt output evidence', async () => {
  for (const corrupt of [false, true]) {
    const t = await setup();
    try {
      const verification = { ...t.options.verification, getVerificationBatch: () => ({ ...t.batch, codeDigest: corrupt ? t.batch.codeDigest : 'd'.repeat(64) }) };
      t.verifyEvidence.mockResolvedValue(!corrupt);
      expect(await createFeatureCloseoutDelivery({ ...t.options, verification }).complete(t.key, 'verification')).toBe('blocked');
      expect(t.commit).not.toHaveBeenCalled();
      expect(t.readApproval).not.toHaveBeenCalled();
    } finally { t.f.close(); }
  }
});

it('keeps a manual approval wait distinct from a passing machine result', async () => {
  const t = await setup();
  try {
    t.readApproval.mockResolvedValue({ valid: false, reason: 'manual_block' });
    expect(await createFeatureCloseoutDelivery(t.options).complete(t.key, 'verification')).toBe('blocked');
    expect(t.commit).not.toHaveBeenCalled();
    expect(t.f.session.database.prepare('SELECT status FROM runs WHERE id=?').get(t.key.runId)).toEqual({ status: 'paused' });
  } finally { t.f.close(); }
});

it('leaves an unknown commit outcome pending and never starts a second commit', async () => {
  const t = await setup();
  try {
    t.commit.mockRejectedValue(new Error('lost_receipt'));
    const service = createFeatureCloseoutDelivery(t.options);
    expect(await service.complete(t.key, 'verification')).toBe('reconcile_required');
    expect(await service.complete(t.key, 'verification')).toBe('reconcile_required');
    expect(t.commit).toHaveBeenCalledTimes(1);
  } finally { t.f.close(); }
});
