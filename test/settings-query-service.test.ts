/**
 * P01-3 / F-011 ConfigurationService 查询切片验收
 * （真实临时 SQLite + 真实适配器 + 可信装配注入的静态能力目录，非 mock）。
 *
 * 覆盖（F-011 验收点，全部为真实断言）：
 * - 当前值查询按 scope 区分 global/project，返回 schemaVersion/payload/revision；
 *   缺失为 not_found，未知版本/损坏为 corrupt（不静默误读）；非法 scope 先于
 *   任何 I/O 拒绝（读取端口未被调用）；
 * - 有效配置查询调用 F-009 合并：精确合并值与逐项来源（project_default /
 *   global_default + sourceKey + scopeRevision），项目完整条目整体替换不跨来源
 *   拼接；未知项目 not_found；项目存在但双方均无策略时 configured:false 的明确
 *   未配置/不可执行状态；不注入默认 Claude/API；
 * - 关闭重开后当前值/有效值/凭据引用/来源修订一致；修改全局后未覆盖字段反映
 *   新默认与新 global revision，项目完整覆盖保持原值/原来源；
 * - 普通脱敏导出：格式版本 + scope 元数据 + 当前值白名单投影 + 有效配置来源；
 *   `credentialRef`/`endpointRef` 只保留引用字符串；明文秘密在持久化前被拒绝，
 *   且不泄漏进序列化输出/结构化错误/变更记录；
 * - 查询只读、无副作用：不调用任何写入端口，不读环境/认证文件/Keychain/
 *   CredentialProvider、不导入 Pi SDK、不解析 YAML 外部覆盖；
 * - 未装配执行能力不被标为就绪（导出/结果不含 executable/ready 标记；F-008
 *   assessSettingsConfiguration 仍为 executable:false）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import {
  assessSettingsConfiguration,
  createStaticRuntimeCapabilityCatalog,
} from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { SETTINGS_SCHEMA_VERSION } from '../packages/core/src/ports/settings-schema.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import {
  createConfigurationService,
  SETTINGS_EXPORT_FORMAT_VERSION,
} from '../packages/core/src/application/configuration-service.ts';
import type {
  ConfigurationService,
  ExportedSettings,
} from '../packages/core/src/application/configuration-service.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_900_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

/** 可信装配注入的静态能力目录：runtime `pi` 支持 anthropic（枚举模型）与 openai（不枚举）。 */
function createCatalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    {
      runtimeId: 'pi',
      providers: [
        { providerId: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
        { providerId: 'openai' },
      ],
    },
  ]);
}

const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: 'keychain://shiploop/global-default',
    },
    modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-global-low' } },
  },
  policies: {
    executionLimits: { maxConcurrentWorks: 2, workTimeoutMs: 5000, envAllowlist: ['HOME', 'PATH'] },
    verification: { requireChecksBeforeDone: true },
  },
};

const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-project-default',
      endpointRef: 'endpoint://shiploop/project-endpoint',
    },
    purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' } },
  },
  policies: {
    executionLimits: { workTimeoutMs: 9000 },
  },
};

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  readonly service: ConfigurationService;
  close(): void;
};

function openHarness(dbPath: string, clock: Clock, catalog: RuntimeCapabilityCatalog = createCatalog()): Harness {
  const session = openSqliteStorageSession({ path: dbPath });
  const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
  const service = createConfigurationService({ stateStore: store, capabilityCatalog: catalog });
  return {
    session,
    store,
    service,
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(fn: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p013-f011-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
    } finally {
      session.close();
    }
    await fn(dbPath, sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

async function expectStorageError(
  kind: StorageErrorKind,
  fn: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await fn();
  } catch (error) {
    expect(isStorageError(error, kind), `expected StorageError(${kind}), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error(`expected StorageError(${kind})`);
}

function countRows(session: SqliteStorageSession, table: string): number {
  const row = session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function rawRow(session: SqliteStorageSession, sql: string, ...params: unknown[]): Record<string, unknown> {
  return session.database.prepare(sql).get(...params) as Record<string, unknown>;
}

/** 端口调用间谍：记录读取/写入端口调用，其余方法透传真实存储。 */
function wrapWithPortSpy(store: StateStore, calls: string[]): StateStore {
  return {
    ...store,
    getProject(projectId) {
      calls.push('getProject');
      return store.getProject(projectId);
    },
    getGlobalSettings() {
      calls.push('getGlobalSettings');
      return store.getGlobalSettings();
    },
    getProjectSettings(projectId) {
      calls.push('getProjectSettings');
      return store.getProjectSettings(projectId);
    },
    createGlobalSettings(input) {
      calls.push('createGlobalSettings');
      return store.createGlobalSettings(input);
    },
    updateGlobalSettings(input) {
      calls.push('updateGlobalSettings');
      return store.updateGlobalSettings(input);
    },
    createProjectSettings(projectId, input) {
      calls.push('createProjectSettings');
      return store.createProjectSettings(projectId, input);
    },
    updateProjectSettings(projectId, input) {
      calls.push('updateProjectSettings');
      return store.updateProjectSettings(projectId, input);
    },
  };
}

/** 直接注入损坏/未知版本的持久配置（绕过应用层，模拟历史或外部损坏数据）。 */
function injectStoredPayload(
  session: SqliteStorageSession,
  table: 'global_settings' | 'project_settings',
  whereColumn: 'id' | 'project_id',
  whereValue: string,
  payloadText: string,
  schemaVersion = 1,
): void {
  session.database
    .prepare(`UPDATE ${table} SET payload = ?, schema_version = ? WHERE ${whereColumn} = ?`)
    .run(payloadText, schemaVersion, whereValue);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_DOC_PATH = 'docs/p01-3-application-contract.md';
const SERVICE_SOURCE_PATH = 'packages/core/src/application/configuration-service.ts';

describe('F-011 getCurrentSettings (current value by scope)', () => {
  it('returns global and project current records with schemaVersion/payload/revision', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '当前值项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });

        const global = await harness.service.getCurrentSettings({ kind: 'global' });
        expect(global.id).toBe('global');
        expect(global.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
        expect(global.revision).toBe(1);
        expect(global.payload).toEqual(GLOBAL_PAYLOAD);
        expect('projectId' in global).toBe(false);

        const projectRecord = await harness.service.getCurrentSettings({ kind: 'project', projectId: project.id });
        expect('projectId' in projectRecord && projectRecord.projectId).toBe(project.id);
        expect(projectRecord.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
        expect(projectRecord.revision).toBe(1);
        expect(projectRecord.payload).toEqual(PROJECT_PAYLOAD);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for missing global/project and rejects illegal scopes before any I/O', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const missingGlobal = await expectStorageError('not_found', () =>
          harness.service.getCurrentSettings({ kind: 'global' }),
        );
        expect(missingGlobal.entity?.type).toBe('global_settings');

        const project = await harness.store.createProject({ displayName: '无配置项目' });
        await expectStorageError('not_found', () =>
          harness.service.getCurrentSettings({ kind: 'project', projectId: project.id }),
        );

        const calls: string[] = [];
        const spyService = createConfigurationService({
          stateStore: wrapWithPortSpy(harness.store, calls),
          capabilityCatalog: createCatalog(),
        });
        for (const scope of [{ kind: 'tenant' }, { kind: 'project' }, { kind: 'global', projectId: project.id }, null, 'global']) {
          const error = await expectStorageError('validation', () => spyService.getCurrentSettings(scope));
          expect(error.operation).toBe('ConfigurationService.getCurrentSettings');
          expect(String(error.details?.['field'])).toMatch(/^scope/);
        }
        expect(calls).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-011 getEffectiveSettings (F-009 merge + sources)', () => {
  it('returns exact merged values and per-key sources without cross-source stitching', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '有效配置项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });

        const effective = await harness.service.getEffectiveSettings(project.id);
        expect(effective.configured).toBe(true);
        expect(effective.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);

        // 项目完整条目整体替换全局条目（不跨来源拼接）——provider/model/endpointRef 均来自项目。
        expect(effective.strategies.defaultStrategy?.strategy).toEqual({
          runtime: 'pi',
          provider: 'openai',
          model: 'gpt-project-default',
          endpointRef: 'endpoint://shiploop/project-endpoint',
        });
        expect(effective.strategies.defaultStrategy?.source).toEqual({
          kind: 'project_default',
          scopeRevision: 1,
          sourceKey: 'defaultStrategy',
        });

        // 未覆盖键继承全局，来源标注 global_default。
        expect(effective.strategies.modelMap.low?.strategy).toEqual({
          runtime: 'pi',
          provider: 'openai',
          model: 'gpt-global-low',
        });
        expect(effective.strategies.modelMap.low?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 1,
          sourceKey: 'modelMap.low',
        });

        expect(effective.strategies.purposeStrategies.planner?.strategy).toEqual({
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-opus',
        });
        expect(effective.strategies.purposeStrategies.planner?.source).toMatchObject({
          kind: 'project_default',
          sourceKey: 'purposeStrategies.planner',
        });

        // 政策段级整体覆盖：项目段只含 workTimeoutMs，全局段字段不进入有效配置。
        expect(effective.policies.executionLimits?.value).toEqual({ workTimeoutMs: 9000 });
        expect(effective.policies.executionLimits?.source).toMatchObject({
          kind: 'project_default',
          sourceKey: 'policies.executionLimits',
        });
        // 未覆盖政策段继承全局。
        expect(effective.policies.verification?.value).toEqual({ requireChecksBeforeDone: true });
        expect(effective.policies.verification?.source).toMatchObject({
          kind: 'global_default',
          sourceKey: 'policies.verification',
        });
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for unknown project and configured:false when no strategy exists', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        await expectStorageError('not_found', () => harness.service.getEffectiveSettings('p-missing'));

        const project = await harness.store.createProject({ displayName: '未配置项目' });
        const noConfig = await harness.service.getEffectiveSettings(project.id);
        expect(noConfig.configured).toBe(false);
        expect(noConfig.strategies.defaultStrategy).toBeUndefined();
        expect(Object.keys(noConfig.strategies.modelMap)).toEqual([]);
        expect(noConfig.policies.executionLimits).toBeUndefined();

        // 仅全局时项目继承全部全局条目（含来源）。
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        const inherited = await harness.service.getEffectiveSettings(project.id);
        expect(inherited.configured).toBe(true);
        expect(inherited.strategies.defaultStrategy?.source.kind).toBe('global_default');
        expect(inherited.strategies.modelMap.low?.source.kind).toBe('global_default');
      } finally {
        harness.close();
      }
    });
  });

  it('is consistent across close/reopen; global changes reflect on unoverridden keys while project overrides keep their value/source', async () => {
    await withMigratedDb(async (dbPath) => {
      const projectIdRef = { id: '' };
      const first = openHarness(dbPath, createClock());
      try {
        const project = await first.store.createProject({ displayName: '重开一致性项目' });
        projectIdRef.id = project.id;
        await first.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await first.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });
      } finally {
        first.close();
      }

      const before = openHarness(dbPath, createClock(1_701_000_000_000));
      let effectiveBefore: Awaited<ReturnType<ConfigurationService['getEffectiveSettings']>>;
      try {
        const current = await before.service.getCurrentSettings({ kind: 'project', projectId: projectIdRef.id });
        expect(current.payload.strategies?.defaultStrategy?.endpointRef).toBe('endpoint://shiploop/project-endpoint');
        effectiveBefore = await before.service.getEffectiveSettings(projectIdRef.id);
      } finally {
        before.close();
      }

      // 修改全局未覆盖键（modelMap.low）到新值 + 新 revision 2。
      const second = openHarness(dbPath, createClock(1_701_100_000_000));
      try {
        await second.service.updateSettings(
          { kind: 'global' },
          {
            expectedRevision: 1,
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: {
                  runtime: 'pi',
                  provider: 'anthropic',
                  model: 'claude-opus',
                  credentialRef: 'keychain://shiploop/global-default',
                },
                modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-global-low-v2' } },
              },
              policies: {
                executionLimits: { maxConcurrentWorks: 3 },
                verification: { requireChecksBeforeDone: true },
              },
            },
          },
        );
      } finally {
        second.close();
      }

      const third = openHarness(dbPath, createClock(1_701_200_000_000));
      try {
        const effectiveAfter = await third.service.getEffectiveSettings(projectIdRef.id);
        // 未覆盖键反映新全局默认与新 global revision；项目完整覆盖保持原值/原来源。
        expect(effectiveAfter.strategies.modelMap.low?.strategy.model).toBe('gpt-global-low-v2');
        expect(effectiveAfter.strategies.modelMap.low?.source).toMatchObject({
          kind: 'global_default',
          scopeRevision: 2,
        });
        expect(effectiveAfter.strategies.defaultStrategy?.strategy.model).toBe('gpt-project-default');
        expect(effectiveAfter.strategies.defaultStrategy?.source).toMatchObject({
          kind: 'project_default',
          scopeRevision: 1,
        });
        expect(effectiveAfter.strategies.defaultStrategy).toEqual(effectiveBefore.strategies.defaultStrategy);
        // 项目覆盖的政策段仍为原项目值（未被全局新值污染）。
        expect(effectiveAfter.policies.executionLimits?.value).toEqual({ workTimeoutMs: 9000 });
      } finally {
        third.close();
      }
    });
  });
});

describe('F-011 exportSettings (plain redacted export)', () => {
  it('exports scope metadata, current projection and effective sources; references are preserved verbatim', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '导出项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });

        const globalExport: ExportedSettings = await harness.service.exportSettings();
        expect(globalExport.exportFormatVersion).toBe(SETTINGS_EXPORT_FORMAT_VERSION);
        expect(globalExport.scope).toBe('global');
        expect('projectId' in globalExport).toBe(false);
        expect(globalExport.current).toEqual({
          schemaVersion: 2,
          revision: 1,
          strategies: {
            defaultStrategy: {
              runtime: 'pi',
              provider: 'anthropic',
              model: 'claude-sonnet',
              credentialRef: 'keychain://shiploop/global-default',
            },
            modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-global-low' } },
          },
          policies: {
            executionLimits: { maxConcurrentWorks: 2, workTimeoutMs: 5000, envAllowlist: ['HOME', 'PATH'] },
            verification: { requireChecksBeforeDone: true },
          },
        });
        expect(globalExport.effective.strategies.defaultStrategy?.source).toEqual({
          kind: 'global_default',
          scopeRevision: 1,
          sourceKey: 'defaultStrategy',
        });

        const projectExport = await harness.service.exportSettings(project.id);
        expect(projectExport.scope).toBe('project');
        expect(projectExport.projectId).toBe(project.id);
        expect(projectExport.current).toEqual({
          schemaVersion: 2,
          revision: 1,
          strategies: {
            defaultStrategy: {
              runtime: 'pi',
              provider: 'openai',
              model: 'gpt-project-default',
              endpointRef: 'endpoint://shiploop/project-endpoint',
            },
            purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-opus' } },
          },
          policies: { executionLimits: { workTimeoutMs: 9000 } },
        });
        // 导出包含有效配置的精确值与来源。
        expect(projectExport.effective.strategies.modelMap.low?.source.kind).toBe('global_default');
        expect(projectExport.effective.strategies.defaultStrategy?.source.kind).toBe('project_default');
        expect(projectExport.effective.policies.executionLimits?.value).toEqual({ workTimeoutMs: 9000 });

        // 导出字段 Schema 白名单：不泄漏存储内部 id，也不含 executable/ready 执行标记。
        expect(Object.keys(projectExport).sort()).toEqual(
          ['current', 'effective', 'exportFormatVersion', 'projectId', 'scope'].sort(),
        );
        expect(Object.keys(projectExport.current).sort()).toEqual(['policies', 'revision', 'schemaVersion', 'strategies'].sort());
        const serialized = JSON.stringify(projectExport);
        expect(serialized).not.toContain('project_settings');
        expect(serialized).not.toContain('executable');
        expect(serialized).not.toContain('"ready"');
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for a missing scope record and rejects illegal project ids before any I/O', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        await expectStorageError('not_found', () => harness.service.exportSettings());

        const project = await harness.store.createProject({ displayName: '无配置导出项目' });
        await expectStorageError('not_found', () => harness.service.exportSettings(project.id));
        await expectStorageError('not_found', () => harness.service.exportSettings('p-missing'));

        const calls: string[] = [];
        const spyService = createConfigurationService({
          stateStore: wrapWithPortSpy(harness.store, calls),
          capabilityCatalog: createCatalog(),
        });
        const error = await expectStorageError('validation', () => spyService.exportSettings('非法/ID'));
        expect(error.operation).toBe('ConfigurationService.exportSettings');
        expect(calls).toEqual([]);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-011 redaction and no side channels', () => {
  it('rejects plaintext secrets before persistence and never leaks them via errors, exports or change records', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const plaintextSecret = 'sk-live-TOP-SECRET-SENTINEL-F011';
        const reference = 'keychain://shiploop/reference-marker-F011';
        const project = await harness.store.createProject({ displayName: '脱敏项目' });

        const invalidPayloads: readonly unknown[] = [
          {
            schemaVersion: 2,
            strategies: {
              defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'm', apiKey: plaintextSecret },
            },
          },
          {
            schemaVersion: 2,
            strategies: {
              defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'm', token: plaintextSecret },
            },
          },
          {
            schemaVersion: 2,
            strategies: {
              defaultStrategy: {
                runtime: 'pi',
                provider: 'openai',
                model: 'm',
                credentialRef: `https://user:${plaintextSecret}@example.com`,
              },
            },
          },
          { schemaVersion: 2, policies: { executionLimits: { envAllowlist: ['API_TOKEN'] } } },
        ];
        for (const payload of invalidPayloads) {
          const error = await expectStorageError('validation', () =>
            harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload }),
          );
          expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(plaintextSecret);
        }
        expect(countRows(harness.session, 'project_settings')).toBe(0);

        // 合法引用可以保存并出现在导出中（引用不是秘密），但绝不解析成明文。
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.updateSettings(
          { kind: 'global' },
          {
            expectedRevision: 1,
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', credentialRef: reference },
              },
            },
          },
        );
        const exported = await harness.service.exportSettings();
        const serialized = JSON.stringify(exported);
        expect(serialized).toContain(reference);
        expect(serialized).not.toContain(plaintextSecret);
        // 变更记录摘要不含引用值，也不含秘密。
        const events = harness.session.database
          .prepare('SELECT payload FROM state_events')
          .all() as ReadonlyArray<{ payload: string }>;
        expect(events.length).toBeGreaterThan(0);
        const eventsText = JSON.stringify(events);
        expect(eventsText).not.toContain(reference);
        expect(eventsText).not.toContain(plaintextSecret);
      } finally {
        harness.close();
      }
    });
  });

  it('query/export are read-only and the application source has no environment/auth/keychain/fs/Pi SDK access', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '只读项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });

        const calls: string[] = [];
        const spyService = createConfigurationService({
          stateStore: wrapWithPortSpy(harness.store, calls),
          capabilityCatalog: createCatalog(),
        });
        await spyService.getCurrentSettings({ kind: 'global' });
        await spyService.getCurrentSettings({ kind: 'project', projectId: project.id });
        await spyService.getEffectiveSettings(project.id);
        await spyService.exportSettings();
        await spyService.exportSettings(project.id);
        expect(calls.some((method) => method.startsWith('create') || method.startsWith('update'))).toBe(false);
      } finally {
        harness.close();
      }
    });

    const source = readFileSync(resolve(REPO_ROOT, SERVICE_SOURCE_PATH), 'utf8');
    // 不绑定环境/认证文件/Keychain/子进程/文件系统：查询只经 StateStore 端口。
    expect(source).not.toMatch(/\bfrom ['"]node:(fs|os|child_process|http|https|net|dns|tls)['"]/);
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('pi-coding-agent');
    expect(source).not.toMatch(/new\s+CredentialProvider/);
    expect(source).not.toContain('adapters/sqlite');
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('drizzle');
  });

  it('does not mark unassembled execution capability as ready', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '执行能力项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        const effective = await harness.service.getEffectiveSettings(project.id);
        expect(effective.configured).toBe(true);

        // 合法 ≠ 可执行：F-008 评估仍明确 executable:false。
        const assessment = assessSettingsConfiguration(GLOBAL_PAYLOAD);
        expect(assessment.configured).toBe(true);
        expect(assessment.executable).toBe(false);
        expect(assessment.reason).toBe('execution_capability_not_assembled');

        // 查询/导出结果本身不携带 executable/ready 等执行就绪标记。
        expect(Object.keys(effective)).not.toContain('executable');
        const exported = await harness.service.exportSettings();
        expect(Object.keys(exported)).not.toContain('executable');
        expect(Object.keys(exported.effective)).not.toContain('executable');
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-011 persisted version/schema validation', () => {
  it('rejects unknown schema versions / damaged persisted settings as corrupt (no silent fallback, not exported)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '版本校验项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: PROJECT_PAYLOAD });

        // 全局被注入 v1 未知版本：当前值/有效配置/导出一律 corrupt（不作为可执行配置导出）。
        injectStoredPayload(harness.session, 'global_settings', 'id', 'global', '{"schemaVersion":1}', 1);
        await expectStorageError('corrupt', () => harness.service.getCurrentSettings({ kind: 'global' }));
        await expectStorageError('corrupt', () => harness.service.getEffectiveSettings(project.id));
        await expectStorageError('corrupt', () => harness.service.exportSettings());
        await expectStorageError('corrupt', () => harness.service.exportSettings(project.id));

        // 恢复全局，改为项目持久结构损坏（缺字段）：项目读取/有效配置/项目导出一律 corrupt。
        injectStoredPayload(harness.session, 'global_settings', 'id', 'global', JSON.stringify(GLOBAL_PAYLOAD), 2);
        injectStoredPayload(
          harness.session,
          'project_settings',
          'project_id',
          project.id,
          '{"schemaVersion":2,"strategies":{"defaultStrategy":{"runtime":"pi","provider":"gpt-4"}}}',
          2,
        );
        await expectStorageError('corrupt', () => harness.service.getCurrentSettings({ kind: 'project', projectId: project.id }));
        const effectiveError = await expectStorageError('corrupt', () => harness.service.getEffectiveSettings(project.id));
        expect(effectiveError.entity).toMatchObject({ type: 'project_settings', projectId: project.id });
        await expectStorageError('corrupt', () => harness.service.exportSettings(project.id));

        // 全局仍可读：不因项目损坏而回落/掩盖。
        const globalStillReadable = await harness.service.getCurrentSettings({ kind: 'global' });
        expect(globalStillReadable.revision).toBe(1);

        // 全局仍可导出：证明错误严格来自被损坏的项目记录，而非静默回落到其他来源。
        const globalExport = await harness.service.exportSettings();
        expect(globalExport.effective.strategies.defaultStrategy?.strategy.model).toBe('claude-sonnet');
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-011 export schema is documented', () => {
  it('contract doc documents the query methods and export schema markers matching the implementation', () => {
    const doc = readFileSync(resolve(REPO_ROOT, CONTRACT_DOC_PATH), 'utf8');
    expect(doc).toContain('F-011');
    expect(doc).toContain('getCurrentSettings');
    expect(doc).toContain('getEffectiveSettings');
    expect(doc).toContain('exportSettings');
    expect(doc).toContain('ExportedSettings');
    expect(doc).toContain('exportFormatVersion');
    expect(doc).toContain(`SETTINGS_EXPORT_FORMAT_VERSION = ${SETTINGS_EXPORT_FORMAT_VERSION}`);
    expect(doc).toContain('普通脱敏导出');
    expect(doc).toContain('credentialRef');
    expect(doc).toContain('corrupt');
  });
});
