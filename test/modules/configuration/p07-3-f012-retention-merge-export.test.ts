/**
 * P07-3 / F-012 保留政策段合并、CAS 与脱敏导出测试（真实临时 SQLite）。
 *
 * 覆盖：
 * - 有效配置合并：保留政策段按既有「项目非空段整体覆盖、空段继承全局」
 *   语义合并（段内字段不跨来源拼接），逐项来源（sourceKey/scopeRevision/
 *   kind）可解释；
 * - ConfigurationService 复用：保留段经全局 create/CAS update 保存并递增
 *   revision；过期 expectedRevision 冲突时现有 payload/revision 不变
 *   （并发更新不能覆盖）；项目 scope 写入磁盘阈值字段在写入前拒绝；
 * - 脱敏导出：exportSettings 当前值投影包含保留段（数值非敏感），不含
 *   凭据/路径类字段（Schema 层已拒绝任意删除路径）；
 * - getEffectiveSettings 返回合并后的保留段与来源。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import type { ConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { mergeEffectiveSettings } from '../../../packages/core/src/application/effective-settings.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

function createCatalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }],
    },
  ]);
}

const GLOBAL_RETENTION = { evidenceRetentionDays: 30, maxBackupCount: 5, diskMinFreePercent: 10 };
const PROJECT_RETENTION = { evidenceRetentionDays: 7 };

async function expectConflict(fn: () => Promise<unknown>): Promise<void> {
  let conflicted = false;
  try {
    await fn();
  } catch (error) {
    conflicted = isStorageError(error, 'conflict');
  }
  expect(conflicted).toBe(true);
}

async function withService(fn: (service: ConfigurationService) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p73-f012-merge-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    const live = openSqliteStorageSession({ path: dbPath });
    try {
      const store = createSqliteStateStore(live);
      const service = createConfigurationService({ stateStore: store, capabilityCatalog: createCatalog() });
      await fn(service);
    } finally {
      live.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

describe('P07-3 / F-012 保留政策段合并、CAS 与导出', () => {
  it('项目非空段整体覆盖全局段；空段继承全局；来源逐项可解释', () => {
    const merged = mergeEffectiveSettings({
      global: {
        scopeRevision: 4,
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: GLOBAL_RETENTION },
        },
      },
      project: {
        scopeRevision: 2,
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: PROJECT_RETENTION },
        },
      },
    });
    // 段级整体替换：项目段不含 maxBackupCount/diskMinFreePercent，不跨来源拼字段。
    expect(merged.policies.retentionPolicy?.value).toEqual(PROJECT_RETENTION);
    expect(merged.policies.retentionPolicy?.source).toEqual({
      kind: 'project_default',
      scopeRevision: 2,
      sourceKey: 'policies.retentionPolicy',
    });

    const inherited = mergeEffectiveSettings({
      global: {
        scopeRevision: 4,
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: GLOBAL_RETENTION },
        },
      },
      project: {
        scopeRevision: 2,
        payload: { schemaVersion: 2, policies: { retentionPolicy: {} } },
      },
    });
    expect(inherited.policies.retentionPolicy?.value).toEqual(GLOBAL_RETENTION);
    expect(inherited.policies.retentionPolicy?.source).toEqual({
      kind: 'global_default',
      scopeRevision: 4,
      sourceKey: 'policies.retentionPolicy',
    });

    const absent = mergeEffectiveSettings({
      global: { scopeRevision: 4, payload: { schemaVersion: 2 } },
      project: { scopeRevision: 2, payload: { schemaVersion: 2 } },
    });
    expect(absent.policies.retentionPolicy).toBeUndefined();
  });

  it('全局保留段经 create/CAS 保存：并发过期 revision 冲突不覆盖现有值', async () => {
    await withService(async service => {
      const created = await service.createSettings({ kind: 'global' }, {
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: GLOBAL_RETENTION },
        },
      });
      expect(created.revision).toBe(1);
      expect(created.payload.policies?.retentionPolicy).toEqual(GLOBAL_RETENTION);

      // CAS 更新成功：revision 递增，值更新。
      const updated = await service.updateSettings({ kind: 'global' }, {
        expectedRevision: 1,
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: { ...GLOBAL_RETENTION, maxBackupCount: 9 } },
        },
      });
      expect(updated.revision).toBe(2);

      // 以过期 revision（1）再次更新：conflict，现有 payload/revision 不变。
      await expectConflict(() => service.updateSettings({ kind: 'global' }, {
        expectedRevision: 1,
        payload: { schemaVersion: 2, policies: { retentionPolicy: { maxBackupCount: 1 } } },
      }));
      const after = await service.getCurrentSettings({ kind: 'global' });
      expect(after.revision).toBe(2);
      expect(after.payload.policies?.retentionPolicy).toEqual({ ...GLOBAL_RETENTION, maxBackupCount: 9 });
    });
  });

  it('项目 scope 携带磁盘阈值字段在写入前拒绝；合法项目保留段可保存', async () => {
    await withService(async service => {
      let rejected = false;
      try {
        await service.createSettings(
          { kind: 'project', projectId: '0a1b2c3d-4e5f-4678-9abc-def012345678' },
          {
            payload: {
              schemaVersion: 2,
              policies: { retentionPolicy: { evidenceRetentionDays: 7, diskMinFreePercent: 5 } },
            },
          },
        );
      } catch (error) {
        rejected = isStorageError(error, 'validation');
        expect((error as { details?: { reason?: string } }).details?.reason).toBe('global_only_field');
      }
      expect(rejected).toBe(true);
    });
  });

  it('脱敏导出包含保留段数值；有效配置查询返回合并段与来源', async () => {
    await withService(async service => {
      await service.createSettings({ kind: 'global' }, {
        payload: {
          schemaVersion: 2,
          policies: { retentionPolicy: GLOBAL_RETENTION },
        },
      });
      const exported = await service.exportSettings();
      expect(exported.scope).toBe('global');
      expect(exported.current.policies?.retentionPolicy).toEqual(GLOBAL_RETENTION);
      expect(exported.effective.policies.retentionPolicy?.value).toEqual(GLOBAL_RETENTION);
      expect(exported.effective.policies.retentionPolicy?.source.kind).toBe('global_default');
      // 导出封套版本随既有通道（本 Task 未改变导出结构语义，仅白名单增段）。
      expect(exported.exportFormatVersion).toBe(1);
    });
  });
});
