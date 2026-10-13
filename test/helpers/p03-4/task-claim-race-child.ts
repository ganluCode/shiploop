import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';

const config = readChildConfig();
void runBarrierChild({ scenario: { name: 'task-claim-race', onGo: async () => {
  const session = openSqliteStorageSession({ path: String(config.dbPath) });
  try {
    const input = config.input as Record<string, unknown>;
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [String(config.root)] });
    const binding = createSqliteStateAccess(session).getRepositoryBinding(String(input.projectId));
    const workspace = await authority.verify(binding, config.path);
    try {
      const result = createSqliteTaskClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => Number(config.now) })
        .claimTask({ ...input, workspace });
      process.send?.({ kind: 'race-result', ok: true, replayed: result.replayed });
    } catch (error) {
      const failure = error as { kind?: string; details?: { reason?: string } };
      process.send?.({ kind: 'race-result', ok: false, errorKind: failure.kind, reason: failure.details?.reason });
    }
  } finally { session.close(); }
} }, goTimeoutMs: 15000, watchdogMs: 45000 });
