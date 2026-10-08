/**
 * F-010 快照一致性竞争写入子进程（仅测试使用，不是产品实现，不进 packages/）。
 *
 * ready/go 屏障放行后，以独立真实 SQLite 会话对同一数据根交替执行：
 * 偶数次 = 项目元数据 CAS 更新（project.metadata_updated 事件）；
 * 奇数次 = 全局配置 CAS 更新（settings.global_updated 事件）。
 * 每次写前自读当前 revision（不依赖父进程传入的过时值），与主进程的快照
 * 读取真实并发（WAL 读写并行）；结果消息只报告写入次数，不携带任何路径/值。
 */
import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import type { SettingsPayload } from '../../../packages/core/src/ports/settings-schema.ts';

const config = readChildConfig();

const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};

void runBarrierChild({
  scenario: {
    name: 'snapshot-writer',
    onGo: async () => {
      let tick = Number(config.now);
      const nowUtcMs = (): number => {
        tick += 1;
        return tick;
      };
      const session = openSqliteStorageSession({ path: String(config.dbPath) });
      try {
        const store = createSqliteStateStore(session, { nowUtcMs });
        const projectId = String(config.projectId);
        const updates = Number(config.updates);
        let projectRevision = (await store.getProject(projectId)).revision;
        let globalRevision = (await store.getGlobalSettings()).revision;
        for (let index = 0; index < updates; index += 1) {
          if (index % 2 === 0) {
            const updated = await store.updateProject(projectId, {
              expectedRevision: projectRevision,
              description: `snapshot race update ${index}`,
            });
            projectRevision = updated.revision;
          } else {
            const updated = await store.updateGlobalSettings({
              expectedRevision: globalRevision,
              payload: GLOBAL_PAYLOAD,
            });
            globalRevision = updated.revision;
          }
        }
        process.send?.({ kind: 'race-result', written: updates });
      } finally {
        session.close();
      }
    },
  },
  goTimeoutMs: 15_000,
  watchdogMs: 45_000,
});
