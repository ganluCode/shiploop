import { openSqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteGitAgentRepairStore } from '../../packages/core/src/adapters/sqlite/git-agent-repair-store.ts';
import { createGitAgentRepairService } from '../../packages/core/src/application/git-agent-repair.ts';
import type { GitAgentRepairClaim } from '../../packages/core/src/ports/git-agent-repair-store.ts';
import { readChildConfig, runBarrierChild } from './host/child-runtime.ts';

const config = readChildConfig();
const session = openSqliteStorageSession({ path: String(config.dbPath), busyTimeoutMs: 250, busyRetryAttempts: 4 });
const clock = () => Number(config.now);
const service = createGitAgentRepairService({ atomic: createSqliteAtomicCommandStore(session, { nowUtcMs: clock }),
  store: createSqliteGitAgentRepairStore(session, { nowUtcMs: clock }) });
void runBarrierChild({
  scenario: { name: 'git-agent-repair-race', async onGo() {
    try {
      const record = config.mode === 'authorize' ? service.authorize(config.request)
        : service.claim(config.input as unknown as GitAgentRepairClaim);
      process.send?.({ kind: 'race-result', record });
    } finally { session.close(); }
  } },
  goTimeoutMs: 10_000, watchdogMs: 30_000,
});
