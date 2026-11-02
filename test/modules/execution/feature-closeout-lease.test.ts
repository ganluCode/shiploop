import { expect, it, vi } from 'vitest';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createSqliteFeatureCloseoutLease } from '../../../packages/core/src/adapters/sqlite/feature-closeout-lease.ts';
import { createSqliteFeatureCloseoutStopVerifier } from '../../../packages/core/src/adapters/sqlite/feature-closeout-stop.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';

it('continues only the owned stopped Run generation, renews its group and quarantines expiry without reviving Task leases', async () => {
  const f = await openDeliveryVertical({ confirmProjectProfile: true });
  try {
    let clock = BINDING_NOW + 1000;
    const key = { projectId: f.fixture.projectId, featureId: f.fixture.featureId, runId: f.fixture.runId, inputDigest: 'a'.repeat(64) };
    const make = (ownerId = f.resourceIdentity.owner) => createSqliteFeatureCloseoutLease(f.fixture.session, {
      ownerId, hostInstanceId: f.resourceIdentity.hostInstanceId, nowUtcMs: () => clock, heartbeatMs: 0,
    });
    const callback = vi.fn(async () => undefined);
    await expect(make('wrong-host').run(key, callback)).rejects.toThrow();
    await expect(make().run(key, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    // Remove only the artificial final Task reservation inserted by this older
    // fixture; a real settled Task already released these exact three rows.
    const removed = f.fixture.session.transactWrite('test.removeFinalReservation', () =>
      f.db.prepare('DELETE FROM workspace_leases WHERE owner_id=?').run(f.resourceIdentity.attemptId));
    expect(removed.changes).toBe(3);
    const bridge = make();
    const before = f.db.prepare('SELECT claim_version FROM run_dispatch_claims WHERE run_id=?').get(key.runId);
    await bridge.run(key, async token => {
      bridge.assertCurrent(token);
      const snapshot = f.core.workResources.read(f.resourceIdentity);
      const stopOptions = { session: f.fixture.session, key, token, assertLease: bridge.assertCurrent,
        artifacts: createArtifactVerifier({ artifacts: f.core.artifactStore, files: f.core.artifactFileStore, limits: { maxReadBytes: 2_097_152 } }),
        processes: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1000 }) };
      const stopped = createSqliteFeatureCloseoutStopVerifier(stopOptions);
      const evidence = await stopped.verify(snapshot);
      expect(evidence).not.toBeNull();
      expect(stopped.inspect(evidence)).toEqual(snapshot);
      expect(await stopped.verify({ ...snapshot, identity: { ...snapshot.identity, owner: 'wrong-owner' } })).toBeNull();
      const missing = createSqliteFeatureCloseoutStopVerifier({ ...stopOptions,
        artifacts: { readVerifiedContent: async () => { throw new Error('missing_artifact'); } } });
      expect(await missing.verify(snapshot)).toBeNull();
      clock += 1000;
      bridge.renew(token);
      expect(token.signal.aborted).toBe(false);
      expect(f.db.prepare('SELECT claim_version FROM run_dispatch_claims WHERE run_id=?').get(key.runId)).toEqual(before);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get()).toEqual({ n: 0 });
      clock = (f.db.prepare('SELECT lease_until FROM execution_slot_claims WHERE run_id=?').get(key.runId) as { lease_until: number }).lease_until + 1;
      expect(() => bridge.renew(token)).toThrow();
      expect(token.signal.aborted).toBe(true);
      expect(() => bridge.assertCurrent(token)).toThrow();
    });
    expect(f.db.prepare('SELECT state FROM run_dispatch_claims WHERE run_id=?').get(key.runId)).toEqual({ state: 'quarantined' });
    expect(f.db.prepare('SELECT state FROM execution_slot_claims WHERE run_id=?').get(key.runId)).toEqual({ state: 'quarantined' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM feature_resource_leases WHERE state='held'").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
}, 90_000);
