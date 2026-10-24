import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';

const config = readChildConfig();

void runBarrierChild({
  scenario: {
    name: 'feature-resource-race',
    onGo: async () => {
      const session = openSqliteStorageSession({ path: String(config.dbPath), busyTimeoutMs: 5_000 });
      try {
        const access = createSqliteFeatureResourceAccess(session, { nowUtcMs: () => Number(config.now) });
        const leases = session.transactWrite('race.feature-resource', () => access.acquireInTransaction(config.input));
        process.send?.({ kind: 'race-result', ok: true, leaseIds: leases.map((lease) => lease.id) });
      } catch (error) {
        const structured = error as { kind?: string; details?: { reason?: string; resourceKey?: string } };
        process.send?.({ kind: 'race-result', ok: false, errorKind: structured.kind, reason: structured.details?.reason, resourceKey: structured.details?.resourceKey });
      } finally {
        session.close();
      }
    },
  },
  goTimeoutMs: 15_000,
  watchdogMs: 45_000,
});
