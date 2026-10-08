/** F-007 真实独立连接竞争子进程；ready/go + 有界回收复用 P02-1。 */
import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { mapToPublicError } from '../../../packages/core/src/ports/commands.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';

const config = readChildConfig();
const nowUtcMs = () => Number(config.now);
void runBarrierChild({
  scenario: {
    name: 'atomic-command-race',
    onGo: async () => {
      const session = openSqliteStorageSession({ path: String(config.dbPath) });
      try {
        const service = createCommandService({
          atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
          repositoryInspector: createRepositoryInspector(),
          // F-009：可信装配能力目录（与 commands-fixture 同一组合），配置命令复检必需。
          capabilityCatalog: createStaticRuntimeCapabilityCatalog([
            {
              runtimeId: 'pi',
              providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }],
            },
          ]),
          nowUtcMs,
        });
        try {
          const receipt = await service.submit(createLocalOwnerPrincipal(), config.envelope);
          process.send?.({ kind: 'race-result', receipt });
        } catch (error) {
          process.send?.({ kind: 'race-result', error: mapToPublicError(error, { operation: 'commands.submit' }).toErrorShape() });
        }
      } finally { session.close(); }
    },
  },
  goTimeoutMs: 15_000, watchdogMs: 45_000,
});
