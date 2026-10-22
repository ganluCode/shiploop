/**
 * P04-9 / F-003 子进程侧：真实 SQLite 连接竞争同一执行槽位（夹具脚本，非测试入口）。
 * 只执行槽位获取原语并回传结构化结果；不启动 Runner、不写 Attempt/预算。
 */
import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';

const config = readChildConfig();

void runBarrierChild({
  scenario: {
    name: 'execution-slot-race',
    onGo: async () => {
      const session = openSqliteStorageSession({ path: String(config.dbPath) });
      try {
        const access = createSqliteExecutionSlotAccess(session, { nowUtcMs: () => Number(config.now) });
        const slot = session.transactWrite('race.execution-slot', () => access.acquireInTransaction(config.acquire));
        process.send?.({ kind: 'race-result', ok: true, slotId: slot.id, slotIndex: slot.slotIndex });
      } catch (error) {
        const structured = error as { kind?: string; details?: { reason?: string } };
        process.send?.({
          kind: 'race-result',
          ok: false,
          errorKind: structured.kind,
          reason: structured.details?.reason,
        });
      } finally {
        session.close();
      }
    },
  },
  goTimeoutMs: 15_000,
  watchdogMs: 45_000,
});
