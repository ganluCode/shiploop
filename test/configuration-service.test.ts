/**
 * P01-3 / F-010 ConfigurationService 全局/项目当前配置创建与 CAS 更新验收
 * （真实临时 SQLite + 真实适配器 + 可信装配注入的静态能力目录，非 mock）。
 *
 * 覆盖（F-010 验收点，全部为真实断言）：
 * - 合法全局配置与项目覆盖经应用服务保存并返回新 revision；首次创建
 *   insert-only（全局单例/每项目一条，重复创建 conflict 不覆盖），首次创建
 *   失败不留配置行；
 * - 无效 scope/schema/payload、缺失项目在写入前拒绝（写入端口未被调用、
 *   零业务行）；配置错误不改变现有 payload/revision；scope 是唯一目标身份
 *   渠道，写项目 B 不触碰项目 A 的行；
 * - 更新为条件写入（UPDATE ... WHERE revision = expectedRevision）；两个独立
 *   进程在同一真实库以同一 revision 竞争全局与项目配置更新，分别恰有一个
 *   成功、一个 conflict，revision 仅递增一次，实际值等于胜者；
 * - 一致性视图：项目写入的合并校验依赖「当前全局 + 新 payload」，应用服务把
 *   读取时看到的全局 revision 作为 consistency 前置条件随写入传入；与默认
 *   更新竞争时（全局已变）返回 conflict（stale_dependency），不提交基于陈旧
 *   依赖校验过的结果；
 * - 审计：成功的 CAS 更新在同一事务内追加 settings.global_updated /
 *   settings.project_updated 脱敏记录（只含 schemaVersion 与策略键名/政策段名
 *   摘要，不含 payload 值/引用值/合成秘密）；注入记录写入失败时配置与
 *   revision 一并回滚；
 * - 成功或冲突后关闭重开，读取值与 revision 一致；能力兼容检查来自注入的窄
 *   能力目录（未知 runtime/不兼容 provider/未枚举 model 带字段定位拒绝，
 *   合并后的继承条目随当前目录复检）。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import type { ConfigurationService } from '../packages/core/src/application/configuration-service.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_600_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

/**
 * 可信装配注入的静态能力目录：runtime `pi` 支持 anthropic（枚举两个模型）与
 * openai（不枚举模型，model 透传）。与子进程 helpers/settings-race-child.ts 一致。
 */
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

function openAiPayload(model: string): SettingsPayload {
  return {
    schemaVersion: 2,
    strategies: { defaultStrategy: { runtime: 'pi', provider: 'openai', model } },
  };
}

const ANTHROPIC_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
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
  const sandbox = createTempSandbox('shiploop-p013-f010-');
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

interface StateEventRow {
  readonly project_id: string | null;
  readonly sequence: number;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_revision: number;
  readonly payload: string;
  readonly occurred_at: number;
}

function readStateEvents(session: SqliteStorageSession): StateEventRow[] {
  return session.database
    .prepare<[], StateEventRow>(
      'SELECT project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at ' +
        'FROM state_events ORDER BY sequence',
    )
    .all();
}

/** 写入端口间谍：记录四个配置写入方法的调用，其余方法透传真实存储。 */
interface WriteCall {
  readonly method: string;
  readonly input: unknown;
}

function wrapWithWriteSpy(store: StateStore, calls: WriteCall[]): StateStore {
  return {
    ...store,
    createGlobalSettings(input) {
      calls.push({ method: 'createGlobalSettings', input });
      return store.createGlobalSettings(input);
    },
    updateGlobalSettings(input) {
      calls.push({ method: 'updateGlobalSettings', input });
      return store.updateGlobalSettings(input);
    },
    createProjectSettings(projectId, input) {
      calls.push({ method: 'createProjectSettings', input });
      return store.createProjectSettings(projectId, input);
    },
    updateProjectSettings(projectId, input) {
      calls.push({ method: 'updateProjectSettings', input });
      return store.updateProjectSettings(projectId, input);
    },
  };
}

describe('F-010 settings create (insert-only, one current record per scope)', () => {
  it('creates global and project settings via the service; duplicate creates conflict without overwrite', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '配置目标项目' });

        const globalCreated = await harness.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
        expect(globalCreated.id).toBe('global');
        expect(globalCreated.revision).toBe(1);
        expect(globalCreated.schemaVersion).toBe(2);
        expect(globalCreated.payload).toEqual(ANTHROPIC_PAYLOAD);

        const projectCreated = await harness.service.createSettings(
          { kind: 'project', projectId: project.id },
          { payload: openAiPayload('gpt-project') },
        );
        expect(projectCreated.revision).toBe(1);
        expect('projectId' in projectCreated && projectCreated.projectId).toBe(project.id);

        // 首次创建 insert-only：重复创建 conflict，不覆盖既有 payload/revision。
        const duplicateGlobal = await expectStorageError('conflict', () =>
          harness.service.createSettings({ kind: 'global' }, { payload: openAiPayload('gpt-other') }),
        );
        expect(duplicateGlobal.entity?.type).toBe('global_settings');
        const duplicateProject = await expectStorageError('conflict', () =>
          harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: { schemaVersion: 2 } }),
        );
        expect(duplicateProject.entity).toEqual({ type: 'project_settings', projectId: project.id });
        expect((await harness.store.getGlobalSettings()).payload).toEqual(ANTHROPIC_PAYLOAD);
        expect((await harness.store.getProjectSettings(project.id)).payload).toEqual(openAiPayload('gpt-project'));
        expect(countRows(harness.session, 'global_settings')).toBe(1);
        expect(countRows(harness.session, 'project_settings')).toBe(1);
        // 首次创建不写审计记录（与 createProject 一致）。
        expect(countRows(harness.session, 'state_events')).toBe(0);
      } finally {
        harness.close();
      }

      // 关闭重开：创建值逐字段一致。
      const reopened = openHarness(dbPath, createClock(1_700_700_000_000));
      try {
        const project = (await reopened.store.listProjects()).records[0]!;
        expect(await reopened.store.getGlobalSettings()).toMatchObject({
          revision: 1,
          payload: ANTHROPIC_PAYLOAD,
        });
        expect(await reopened.store.getProjectSettings(project.id)).toMatchObject({
          revision: 1,
          payload: openAiPayload('gpt-project'),
        });
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects settings creation for a missing project with not_found and leaves zero rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const missing = await expectStorageError('not_found', () =>
          harness.service.createSettings({ kind: 'project', projectId: 'p-missing' }, { payload: ANTHROPIC_PAYLOAD }),
        );
        expect(missing.entity?.type).toBe('project');
        expect(countRows(harness.session, 'project_settings')).toBe(0);
        expect(countRows(harness.session, 'state_events')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid scopes before any I/O (write port never called)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const calls: WriteCall[] = [];
      const spyService = createConfigurationService({
        stateStore: wrapWithWriteSpy(harness.store, calls),
        capabilityCatalog: createCatalog(),
      });
      try {
        for (const scope of [
          { kind: 'tenant' },
          { kind: 'project' },
          { kind: 'global', projectId: 'p-1' },
          { kind: 'project', projectId: '非法/ID' },
          'global',
          null,
        ]) {
          const error = await expectStorageError('validation', () =>
            spyService.createSettings(scope, { payload: ANTHROPIC_PAYLOAD }),
          );
          expect(error.operation).toBe('ConfigurationService.createSettings');
          expect(String(error.details?.['field'])).toMatch(/^scope/);
        }
        expect(calls).toEqual([]);
        expect(countRows(harness.session, 'global_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid payloads before any I/O without leaking secrets (write port never called)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const calls: WriteCall[] = [];
      const spyService = createConfigurationService({
        stateStore: wrapWithWriteSpy(harness.store, calls),
        capabilityCatalog: createCatalog(),
      });
      try {
        const project = await harness.store.createProject({ displayName: '载荷校验项目' });
        const secret = 'sk-live-TOP-SECRET-SENTINEL-F010';
        const invalidPayloads: readonly unknown[] = [
          { schemaVersion: 1, strategies: {} },
          { schemaVersion: 99 },
          { schemaVersion: 2, unknownKey: {} },
          { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'openai' } } },
          { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'm', apiKey: secret } } },
          {
            schemaVersion: 2,
            strategies: {
              defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'm', credentialRef: `https://user:${secret}@example.com` },
            },
          },
          { schemaVersion: 2, policies: { memoryPolicy: {} } },
          { schemaVersion: 2, policies: { securityPolicy: { isolation: 'strong_sandbox' } } },
        ];
        for (const payload of invalidPayloads) {
          const error = await expectStorageError('validation', () =>
            spyService.createSettings({ kind: 'project', projectId: project.id }, { payload }),
          );
          expect(error.operation).toBe('ConfigurationService.createSettings');
          // 错误不回显合成秘密。
          expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(secret);
        }
        // 更新路径同样先校验后 I/O。
        const updateError = await expectStorageError('validation', () =>
          spyService.updateSettings(
            { kind: 'project', projectId: project.id },
            { expectedRevision: 1, payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'm', token: secret } } } },
          ),
        );
        expect(`${updateError.message} ${JSON.stringify(updateError.details)}`).not.toContain(secret);
        // 调用方不得自行声明 consistency（由服务从自己的一致性读取推导）。
        await expectStorageError('validation', () =>
          spyService.updateSettings(
            { kind: 'project', projectId: project.id },
            { expectedRevision: 1, payload: { schemaVersion: 2 }, consistency: { globalRevision: 1 } },
          ),
        );
        expect(calls).toEqual([]);
        expect(countRows(harness.session, 'project_settings')).toBe(0);
        expect(countRows(harness.session, 'state_events')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-010 settings CAS update with redacted audit record', () => {
  it('applies global/project updates under expectedRevision, persists and records redacted state events', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const secret = 'keychain://shiploop/TOP-SECRET-SENTINEL-F010';
        const project = await harness.store.createProject({ displayName: '审计项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: { schemaVersion: 2 } });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: { schemaVersion: 2 } });

        const globalUpdated = await harness.service.updateSettings(
          { kind: 'global' },
          {
            expectedRevision: 1,
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', credentialRef: secret },
                modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-mini-marker' } },
              },
              policies: {
                executionLimits: { maxConcurrentWorks: 2, envAllowlist: ['HOME', 'PATH'] },
                verification: { requireChecksBeforeDone: true },
              },
            },
          },
        );
        expect(globalUpdated.revision).toBe(2);

        const projectUpdated = await harness.service.updateSettings(
          { kind: 'project', projectId: project.id },
          { expectedRevision: 1, payload: openAiPayload('gpt-project-2') },
        );
        expect(projectUpdated.revision).toBe(2);

        // 脱敏变更记录：scope/适用项目/写后修订身份 + 只含键名的摘要。
        const events = readStateEvents(harness.session);
        expect(events).toHaveLength(2);
        const [globalEvent, projectEvent] = events as [StateEventRow, StateEventRow];
        expect(globalEvent.event_type).toBe('settings.global_updated');
        expect(globalEvent.aggregate_type).toBe('global_settings');
        expect(globalEvent.aggregate_id).toBe('global');
        expect(globalEvent.project_id).toBeNull();
        expect(globalEvent.aggregate_revision).toBe(2);
        expect(globalEvent.sequence).toBe(1);
        expect(globalEvent.occurred_at).toBe(globalUpdated.updatedAtUtcMs);
        expect(JSON.parse(globalEvent.payload)).toEqual({
          schemaVersion: 2,
          strategies: ['defaultStrategy', 'modelMap.low'],
          policies: ['executionLimits', 'verification'],
        });

        expect(projectEvent.event_type).toBe('settings.project_updated');
        expect(projectEvent.aggregate_type).toBe('project_settings');
        expect(projectEvent.project_id).toBe(project.id);
        expect(projectEvent.aggregate_id).toBe((await harness.store.getProjectSettings(project.id)).id);
        expect(projectEvent.aggregate_revision).toBe(2);
        expect(projectEvent.sequence).toBe(2);
        expect(JSON.parse(projectEvent.payload)).toEqual({
          schemaVersion: 2,
          strategies: ['defaultStrategy'],
          policies: [],
        });

        // 记录绝不包含 payload 值、引用值、模型名或合成秘密。
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain('TOP-SECRET-SENTINEL-F010');
        expect(serialized).not.toContain('claude-sonnet');
        expect(serialized).not.toContain('gpt-mini-marker');
        expect(serialized).not.toContain('gpt-project-2');
      } finally {
        harness.close();
      }

      // 关闭重开：更新值、revision 与审计记录逐字段一致。
      const reopened = openHarness(dbPath, createClock(1_700_700_000_000));
      try {
        expect((await reopened.store.getGlobalSettings()).revision).toBe(2);
        const events = readStateEvents(reopened.session);
        expect(events.map((event) => event.event_type)).toEqual([
          'settings.global_updated',
          'settings.project_updated',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1, 2]);
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects stale revisions without changing payload/revision or recording events', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: 'CAS 项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: openAiPayload('gpt-1') });
        const globalBefore = rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global');
        const projectBefore = rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id);

        const staleGlobal = await expectStorageError('conflict', () =>
          harness.service.updateSettings({ kind: 'global' }, { expectedRevision: 5, payload: openAiPayload('gpt-x') }),
        );
        expect(staleGlobal.details).toMatchObject({ expectedRevision: 5, actualRevision: 1 });
        const staleProject = await expectStorageError('conflict', () =>
          harness.service.updateSettings(
            { kind: 'project', projectId: project.id },
            { expectedRevision: 99, payload: openAiPayload('gpt-y') },
          ),
        );
        expect(staleProject.entity).toEqual({ type: 'project_settings', projectId: project.id });

        expect(rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global')).toEqual(globalBefore);
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id)).toEqual(
          projectBefore,
        );
        expect(countRows(harness.session, 'state_events')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rolls back settings and revision when the audit record write fails (real trigger injection)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '回滚项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: openAiPayload('gpt-1') });
        const globalBefore = rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global');
        const projectBefore = rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id);

        // 在 state_events 插入处注入真实失败：配置已在同一事务内更新，失败必须整组回滚。
        harness.session.database.exec(
          'CREATE TEMP TRIGGER f010_fail_event_insert BEFORE INSERT ON state_events ' +
            "BEGIN SELECT RAISE(ABORT, 'f-010 injected event failure'); END",
        );
        await expect(
          harness.service.updateSettings({ kind: 'global' }, { expectedRevision: 1, payload: openAiPayload('gpt-g2') }),
        ).rejects.toThrow(/f-010 injected event failure/);
        await expect(
          harness.service.updateSettings(
            { kind: 'project', projectId: project.id },
            { expectedRevision: 1, payload: openAiPayload('gpt-p2') },
          ),
        ).rejects.toThrow(/f-010 injected event failure/);

        // 配置与 revision 一并回滚，无半条记录。
        expect(rawRow(harness.session, 'SELECT * FROM global_settings WHERE id = ?', 'global')).toEqual(globalBefore);
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id)).toEqual(
          projectBefore,
        );
        expect(countRows(harness.session, 'state_events')).toBe(0);

        // 撤除注入后同一操作成功，证明失败只来自注入点。
        harness.session.database.exec('DROP TRIGGER temp.f010_fail_event_insert');
        const updated = await harness.service.updateSettings(
          { kind: 'global' },
          { expectedRevision: 1, payload: openAiPayload('gpt-g2') },
        );
        expect(updated.revision).toBe(2);
        expect(readStateEvents(harness.session)).toHaveLength(1);
      } finally {
        harness.close();
      }
    });
  });

  it('never touches project A rows when writing project B scope', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await harness.store.createProject({ displayName: '项目A' });
        const projectB = await harness.store.createProject({ displayName: '项目B' });
        await harness.service.createSettings({ kind: 'project', projectId: projectA.id }, { payload: openAiPayload('gpt-a') });
        await harness.service.createSettings({ kind: 'project', projectId: projectB.id }, { payload: openAiPayload('gpt-b') });
        const aBefore = rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectA.id);

        await harness.service.updateSettings(
          { kind: 'project', projectId: projectB.id },
          { expectedRevision: 1, payload: openAiPayload('gpt-b2') },
        );
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', projectA.id)).toEqual(aBefore);
        // B 的审计记录只携带 B 的项目身份。
        const events = readStateEvents(harness.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.project_id).toBe(projectB.id);
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-010 capability compatibility via the injected catalog', () => {
  it('rejects unknown runtime, incompatible provider and unlisted model with field-located errors before any write', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const calls: WriteCall[] = [];
      const spyService = createConfigurationService({
        stateStore: wrapWithWriteSpy(harness.store, calls),
        capabilityCatalog: createCatalog(),
      });
      try {
        const cases: readonly { payload: unknown; reason: string; field: string }[] = [
          {
            payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'ghost', provider: 'openai', model: 'm' } } },
            reason: 'unknown_runtime',
            field: 'payload.strategies.defaultStrategy.runtime',
          },
          {
            payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'ghost', model: 'm' } } },
            reason: 'incompatible_provider',
            field: 'payload.strategies.defaultStrategy.provider',
          },
          {
            payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'gpt-4' } } },
            reason: 'unsupported_model',
            field: 'payload.strategies.defaultStrategy.model',
          },
        ];
        for (const { payload, reason, field } of cases) {
          const error = await expectStorageError('validation', () =>
            spyService.createSettings({ kind: 'global' }, { payload }),
          );
          expect(error.details).toMatchObject({ reason, field });
        }
        expect(calls).toEqual([]);
        expect(countRows(harness.session, 'global_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('re-validates inherited global entries against the current catalog on project writes (consistent view)', async () => {
    await withMigratedDb(async (dbPath) => {
      // 目录 A 认识 legacy runtime：全局配置合法写入。
      const catalogA = createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'legacy', providers: [{ providerId: 'old' }] },
        { runtimeId: 'pi', providers: [{ providerId: 'openai' }] },
      ]);
      const first = openHarness(dbPath, createClock(), catalogA);
      let projectId: string;
      try {
        const project = await first.store.createProject({ displayName: '继承校验项目' });
        projectId = project.id;
        await first.service.createSettings(
          { kind: 'global' },
          {
            payload: {
              schemaVersion: 2,
              strategies: {
                // 全局条目放在 modelMap.low，项目 payload 不覆盖该键时进入合并结果。
                modelMap: { low: { runtime: 'legacy', provider: 'old', model: 'm1' } },
              },
            },
          },
        );
      } finally {
        first.close();
      }

      // 目录 B 不再认识 legacy：项目自身 payload 合法，但合并后继承的
      // modelMap.low 条目随当前目录复检失败——未知 runtime 不被静默忽略
      // （fail-closed，不降级）。
      const second = openHarness(dbPath, createClock(1_700_700_000_000), createCatalog());
      try {
        const error = await expectStorageError('validation', () =>
          second.service.createSettings(
            { kind: 'project', projectId },
            { payload: openAiPayload('gpt-own') },
          ),
        );
        expect(error.details).toMatchObject({
          reason: 'unknown_runtime',
          field: 'payload.strategies.modelMap.low.runtime',
        });
        expect(countRows(second.session, 'project_settings')).toBe(0);

        // 项目以完整条目整体覆盖 modelMap.low 后，合并结果不再含 legacy 条目，写入成功。
        const created = await second.service.createSettings(
          { kind: 'project', projectId },
          {
            payload: {
              schemaVersion: 2,
              strategies: {
                defaultStrategy: { runtime: 'pi', provider: 'openai', model: 'gpt-own' },
                modelMap: { low: { runtime: 'pi', provider: 'openai', model: 'gpt-low' } },
              },
            },
          },
        );
        expect(created.revision).toBe(1);
      } finally {
        second.close();
      }
    });
  });
});

describe('F-010 consistent view and stale dependency guard', () => {
  it('passes the global revision seen during validation as the write precondition (null when absent)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const calls: WriteCall[] = [];
      const spyService = createConfigurationService({
        stateStore: wrapWithWriteSpy(harness.store, calls),
        capabilityCatalog: createCatalog(),
      });
      try {
        const project = await harness.store.createProject({ displayName: '前置条件项目' });
        // 全局不存在：前置条件为 globalRevision=null。
        await spyService.createSettings({ kind: 'project', projectId: project.id }, { payload: openAiPayload('gpt-1') });
        expect(calls[0]?.method).toBe('createProjectSettings');
        expect(calls[0]?.input).toMatchObject({ consistency: { globalRevision: null } });

        // 全局存在（rev 1）：前置条件跟随读取到的 revision。
        await harness.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
        await spyService.updateSettings(
          { kind: 'project', projectId: project.id },
          { expectedRevision: 1, payload: openAiPayload('gpt-2') },
        );
        expect(calls[1]?.method).toBe('updateProjectSettings');
        expect(calls[1]?.input).toMatchObject({ consistency: { globalRevision: 1 } });
      } finally {
        harness.close();
      }
    });
  });

  it('rejects a project write based on a stale global snapshot with conflict (stale_dependency), leaving values unchanged', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({ displayName: '陈旧依赖项目' });
        await harness.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
        await harness.service.createSettings({ kind: 'project', projectId: project.id }, { payload: openAiPayload('gpt-1') });

        // 捕获旧全局快照（rev 1），随后全局被并发更新到 rev 2；
        // 经服务写入时前置条件在真实适配器的写事务内核对失败。
        const staleGlobal = await harness.store.getGlobalSettings();
        await harness.service.updateSettings({ kind: 'global' }, { expectedRevision: 1, payload: openAiPayload('gpt-g2') });
        const staleStore: StateStore = {
          ...harness.store,
          getGlobalSettings: () => Promise.resolve(staleGlobal),
        };
        const staleService = createConfigurationService({ stateStore: staleStore, capabilityCatalog: createCatalog() });

        const before = rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id);
        const error = await expectStorageError('conflict', () =>
          staleService.updateSettings(
            { kind: 'project', projectId: project.id },
            { expectedRevision: 1, payload: openAiPayload('gpt-stale') },
          ),
        );
        expect(error.details).toMatchObject({
          reason: 'stale_dependency',
          expectedGlobalRevision: 1,
          actualGlobalRevision: 2,
        });
        // 陈旧依赖的写入未提交：值与 revision 不变，无审计记录。
        expect(rawRow(harness.session, 'SELECT * FROM project_settings WHERE project_id = ?', project.id)).toEqual(before);
        expect(readStateEvents(harness.session).filter((event) => event.event_type === 'settings.project_updated')).toHaveLength(0);
      } finally {
        harness.close();
      }
    });
  });

  it('enforces the consistency precondition at the port level on a real database (create and update)', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await harness.store.createProject({ displayName: '端口前置A' });
        const projectB = await harness.store.createProject({ displayName: '端口前置B' });

        // 全局不存在时：globalRevision=null 通过；声称见过 rev 1 被拒绝。
        await harness.store.createProjectSettings(projectA.id, {
          payload: { schemaVersion: 2 },
          consistency: { globalRevision: null },
        });
        const phantom = await expectStorageError('conflict', () =>
          harness.store.createProjectSettings(projectB.id, {
            payload: { schemaVersion: 2 },
            consistency: { globalRevision: 1 },
          }),
        );
        expect(phantom.details).toMatchObject({ reason: 'stale_dependency', expectedGlobalRevision: 1, actualGlobalRevision: null });
        await expectStorageError('not_found', () => harness.store.getProjectSettings(projectB.id));

        // 全局存在（rev 1）后：null 前置条件被拒绝；匹配 rev 通过；过期 rev 被拒绝且不消耗 revision。
        await harness.store.createGlobalSettings({ payload: { schemaVersion: 2 } });
        const nullPrecondition = await expectStorageError('conflict', () =>
          harness.store.updateProjectSettings(projectA.id, {
            expectedRevision: 1,
            payload: openAiPayload('gpt-x'),
            consistency: { globalRevision: null },
          }),
        );
        expect(nullPrecondition.details).toMatchObject({ reason: 'stale_dependency', expectedGlobalRevision: null, actualGlobalRevision: 1 });
        expect((await harness.store.getProjectSettings(projectA.id)).revision).toBe(1);

        await harness.store.updateProjectSettings(projectA.id, {
          expectedRevision: 1,
          payload: openAiPayload('gpt-a2'),
          consistency: { globalRevision: 1 },
        });
        expect((await harness.store.getProjectSettings(projectA.id)).revision).toBe(2);

        await harness.store.updateGlobalSettings({ expectedRevision: 1, payload: ANTHROPIC_PAYLOAD });
        const stale = await expectStorageError('conflict', () =>
          harness.store.updateProjectSettings(projectA.id, {
            expectedRevision: 2,
            payload: openAiPayload('gpt-a3'),
            consistency: { globalRevision: 1 },
          }),
        );
        expect(stale.details).toMatchObject({ reason: 'stale_dependency', expectedGlobalRevision: 1, actualGlobalRevision: 2 });
        expect((await harness.store.getProjectSettings(projectA.id)).payload).toEqual(openAiPayload('gpt-a2'));

        // 前置条件形态非法在任何 SQL 之前拒绝。
        await expectStorageError('validation', () =>
          harness.store.updateProjectSettings(projectA.id, {
            expectedRevision: 2,
            payload: openAiPayload('gpt-a4'),
            consistency: { globalRevision: 0 },
          }),
        );
        await expectStorageError('validation', () =>
          harness.store.createProjectSettings(projectB.id, {
            payload: { schemaVersion: 2 },
            consistency: { unknownKey: 1 },
          }),
        );
      } finally {
        harness.close();
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 * 跨进程 CAS 竞争（真实临时库 + 同步屏障子进程）
 * ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 有界等待一组哨兵文件全部出现；超时即失败（不无限等待子进程）。 */
async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`有界等待哨兵文件超时（${timeoutMs}ms）`);
}

/** 有界等待子进程退出；超时先 SIGKILL 再失败，绝不悬挂测试进程。 */
function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`子进程退出超时（${timeoutMs}ms），已 SIGKILL`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

const testDir = dirname(fileURLToPath(import.meta.url));
const SETTINGS_CHILD_SCRIPT = join(testDir, 'helpers', 'settings-race-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

type ChildResult =
  | { readonly outcome: 'success'; readonly revision: number; readonly model: string }
  | { readonly outcome: 'conflict'; readonly expectedRevision?: number; readonly actualRevision?: unknown }
  | { readonly outcome: 'error'; readonly name: string; readonly message: string };

type RacerOutcome = {
  readonly marker: string;
  readonly exit: { code: number | null; signal: NodeJS.Signals | null };
  readonly stderr: string;
  readonly result: ChildResult;
};

/**
 * 真实跨进程竞争：两个独立子进程连接同一临时库，经文件哨兵同步屏障后
 * 以同一旧 revision 经应用服务竞争更新全局或项目当前配置。
 */
async function runSettingsRace(
  root: string,
  dbPath: string,
  mode: 'global' | 'project',
  projectId: string | undefined,
  expectedRevision: number,
): Promise<RacerOutcome[]> {
  const goFile = join(root, `race-${mode}.go`);
  const racers = (['A', 'B'] as const).map((marker) => ({
    marker,
    config: {
      dbPath,
      mode,
      ...(projectId === undefined ? {} : { projectId }),
      expectedRevision,
      marker,
      readyFile: join(root, `race-${mode}.ready.${marker}`),
      goFile,
      resultFile: join(root, `race-${mode}.result.${marker}.json`),
    },
  }));

  const children = racers.map(({ config }) => {
    const child = spawn(
      process.execPath,
      ['--import', CHILD_REGISTER, SETTINGS_CHILD_SCRIPT, JSON.stringify(config)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return { child, stderr: () => stderr };
  });

  try {
    // 同步屏障：两个子进程都就绪后才放行，尽量让写事务真实重叠。
    await waitForFiles(racers.map(({ config }) => config.readyFile), 20_000);
    writeFileSync(goFile, 'go');

    return await Promise.all(
      racers.map(async ({ marker, config }, index) => {
        const exit = await waitForExit(children[index]!.child, 30_000);
        if (!existsSync(config.resultFile)) {
          throw new Error(
            `子进程 ${marker} 未写结果文件（exit=${String(exit.code)}）：${children[index]!.stderr()}`,
          );
        }
        const result = JSON.parse(readFileSync(config.resultFile, 'utf8')) as ChildResult;
        return { marker, exit, stderr: children[index]!.stderr(), result };
      }),
    );
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }
}

async function expectSingleWinner(
  outcomes: RacerOutcome[],
  expectedRevision: number,
): Promise<{ winnerModel: string }> {
  for (const outcome of outcomes) {
    expect(outcome.exit.signal, outcome.stderr).toBeNull();
    expect(outcome.exit.code, outcome.stderr).toBe(0);
  }
  const winners = outcomes.filter((outcome) => outcome.result.outcome === 'success');
  const losers = outcomes.filter((outcome) => outcome.result.outcome === 'conflict');
  // 恰有一个成功、一个 conflict：证明是条件写入，不是先读后无条件覆盖。
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  const winner = winners[0]!;
  const loser = losers[0]!;
  expect(winner.result.outcome === 'success' && winner.result.revision).toBe(expectedRevision + 1);
  if (loser.result.outcome === 'conflict') {
    expect(loser.result.expectedRevision).toBe(expectedRevision);
    expect(loser.result.actualRevision).toBe(expectedRevision + 1);
  }
  return { winnerModel: winner.result.outcome === 'success' ? winner.result.model : '' };
}

describe('F-010 cross-process settings CAS race on the same real database', () => {
  it('lets exactly one of two barrier-synchronized processes win a global settings update; revision increments once', async () => {
    await withMigratedDb(async (dbPath, root) => {
      const setup = openHarness(dbPath, createClock());
      try {
        await setup.service.createSettings({ kind: 'global' }, { payload: ANTHROPIC_PAYLOAD });
      } finally {
        setup.close();
      }

      const outcomes = await runSettingsRace(root, dbPath, 'global', undefined, 1);
      const { winnerModel } = await expectSingleWinner(outcomes, 1);

      // 关闭重开真实库：revision 只增加一次，payload 与胜者一致，恰一条审计记录。
      const verify = openHarness(dbPath, createClock(1_700_700_000_000));
      try {
        const settings = await verify.store.getGlobalSettings();
        expect(settings.revision).toBe(2);
        expect(settings.payload.strategies?.defaultStrategy?.model).toBe(winnerModel);
        expect(countRows(verify.session, 'global_settings')).toBe(1);
        const events = readStateEvents(verify.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.event_type).toBe('settings.global_updated');
        expect(events[0]!.aggregate_revision).toBe(2);
        // 审计摘要不包含胜者的模型标记。
        expect(events[0]!.payload).not.toContain(winnerModel);
      } finally {
        verify.close();
      }
    });
  }, 90_000);

  it('lets exactly one of two barrier-synchronized processes win a project settings update; revision increments once', async () => {
    await withMigratedDb(async (dbPath, root) => {
      const setup = openHarness(dbPath, createClock());
      let projectId: string;
      try {
        const project = await setup.store.createProject({ displayName: '项目竞争目标' });
        projectId = project.id;
        await setup.service.createSettings(
          { kind: 'project', projectId },
          { payload: openAiPayload('gpt-initial') },
        );
      } finally {
        setup.close();
      }

      const outcomes = await runSettingsRace(root, dbPath, 'project', projectId, 1);
      const { winnerModel } = await expectSingleWinner(outcomes, 1);

      // 关闭重开真实库：revision 只增加一次，payload 与胜者一致，恰一条项目审计记录。
      const verify = openHarness(dbPath, createClock(1_700_700_000_000));
      try {
        const settings = await verify.store.getProjectSettings(projectId);
        expect(settings.revision).toBe(2);
        expect(settings.payload.strategies?.defaultStrategy?.model).toBe(winnerModel);
        expect(countRows(verify.session, 'project_settings')).toBe(1);
        const events = readStateEvents(verify.session);
        expect(events).toHaveLength(1);
        expect(events[0]!.event_type).toBe('settings.project_updated');
        expect(events[0]!.project_id).toBe(projectId);
        expect(events[0]!.payload).not.toContain(winnerModel);
      } finally {
        verify.close();
      }
    });
  }, 90_000);
});
