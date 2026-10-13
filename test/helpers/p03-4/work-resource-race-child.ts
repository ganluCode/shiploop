import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { createSqliteBaselineAccess } from '../../../packages/core/src/adapters/sqlite/baseline-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { validateWorkResourceIdentity } from '../../../packages/core/src/ports/work-resources.ts';

const config = readChildConfig();
void runBarrierChild({ scenario: { name: 'work-resource-race', onGo: async () => {
  const session = openSqliteStorageSession({ path: String(config.dbPath) });
  try {
    const identity = validateWorkResourceIdentity(config.identity);
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [String(config.root)] });
    const binding = createSqliteStateAccess(session).getRepositoryBinding(identity.projectId);
    const workspace = await authority.verify(binding, config.path);
    const access = createSqliteWorkResourceAccess(session, { workspaceAuthority: authority, nowUtcMs: () => Number(config.now) });
    try {
      if (typeof config.baselineOperationId === 'string') {
        const baseline = createSqliteBaselineAccess(session, { nowUtcMs: () => Number(config.now) });
        session.transactWrite('race.baseline-resource', () => baseline.acquireBaselineOccupancyInTransaction({ operationId: config.baselineOperationId }));
      } else {
        session.transactWrite('race.work-resource', () => access.acquireInTransaction(identity, workspace, Number(config.until)));
      }
      process.send?.({ kind: 'race-result', ok: true });
    } catch (error) {
      process.send?.({ kind: 'race-result', ok: false, errorKind: (error as { kind?: string }).kind });
    }
  } finally { session.close(); }
} }, goTimeoutMs: 15000, watchdogMs: 45000 });
