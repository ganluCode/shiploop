import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqlitePlanningClaimStore } from '../../../packages/core/src/adapters/sqlite/planning-claim-store.ts';

/**
 * P05-1 / F-005 planning 认领竞争子进程：独立 SQLite 连接 + 独立可信工作区
 * 权威实例，与父/其他子进程并发 claimPlanningTask（BEGIN IMMEDIATE 串行化，
 * Task CAS 与唯一索引保证至多一个有效执行者）。
 */
const config = readChildConfig();
void runBarrierChild({ scenario: { name: 'planning-claim-race', onGo: async () => {
  const session = openSqliteStorageSession({ path: String(config.dbPath) });
  try {
    const input = config.input as Record<string, unknown>;
    const authority = createWorkWorkspaceAuthority({ authorizedRoots: [String(config.root)] });
    const binding = createSqliteStateAccess(session).getRepositoryBinding(String(input.projectId));
    const workspace = await authority.verify(binding, config.path);
    try {
      const result = createSqlitePlanningClaimStore(session, { workspaceAuthority: authority, nowUtcMs: () => Number(config.now) })
        .claimPlanningTask({ ...input, workspace });
      process.send?.({ kind: 'race-result', ok: true, replayed: result.replayed });
    } catch (error) {
      const failure = error as { kind?: string; details?: { reason?: string; eligibility?: string } };
      process.send?.({ kind: 'race-result', ok: false, errorKind: failure.kind,
        reason: failure.details?.reason, eligibility: failure.details?.eligibility });
    }
  } finally { session.close(); }
} }, goTimeoutMs: 15000, watchdogMs: 45000 });
