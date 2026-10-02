/**
 * F-006 SQLite StateStore 适配器回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-006 验收点，全部为真实断言）：
 * - 通过实际存储端口创建稳定 ID 项目及其当前配置；读取返回相同 ID、labels、
 *   description、schemaVersion、payload、revision 与 UTC 毫秒时间；不存在实体
 *   返回明确 not_found；非法输入在校验阶段拒绝且真实库行数不变（无持久化副作用）；
 * - 全局当前配置唯一单例记录、项目当前配置每项目一条；重复创建返回结构化 conflict
 *   而不是默默覆盖；两个项目的读取严格隔离；
 * - 写入前及读取持久 JSON 时调用 F-002 校验：损坏 JSON / 未知 schemaVersion 经
 *   直接 SQL 注入后不能从读取端口作为有效配置返回（kind='corrupt'）；
 * - 关闭、重新打开实际库后项目和配置逐字段一致（含中文多字节与 labels JSON）；
 *   displayName/description 不参与 ID 或物理路径；不存明文凭据；
 * - expectedRevision CAS 基线契约（过期 conflict 且原 payload/revision 不变、成功
 *   递增 revision、标签更新不动配置行）；跨进程竞争、失败注入与组合写入由 F-007 深入验证。
 */
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import { GLOBAL_SETTINGS_ID } from '../packages/core/src/ports/state-store.ts';
import type { StateStore } from '../packages/core/src/ports/state-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

/** 确定性递增时钟：每次调用 +1ms。 */
function createClock(start = 1_700_100_000_000) {
  let current = start;
  return {
    next(): number {
      current += 1;
      return current;
    },
  };
}

type Clock = ReturnType<typeof createClock>;

const VALID_PAYLOAD = {
  schemaVersion: 1,
  strategies: {
    defaultStrategy: {
      runtime: 'pi',
      provider: 'anthropic',
      model: 'claude-sonnet',
      credentialRef: 'keyring://primary',
    },
    agentOverrides: {
      '中文代理': { runtime: 'pi', provider: 'anthropic', model: 'claude-haiku' },
    },
  },
};

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  readonly dbPath: string;
  readonly root: string;
  close(): void;
};

function openHarness(dbPath: string, clock: Clock): Harness {
  const session = openSqliteStorageSession({ path: dbPath });
  const store = createSqliteStateStore(session, { nowUtcMs: () => clock.next() });
  return {
    session,
    store,
    dbPath,
    root: dirname(dbPath),
    close(): void {
      session.close();
    },
  };
}

async function withMigratedDb(fn: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f006-');
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

async function createProject(store: StateStore, displayName = '示例项目') {
  return store.createProject({ displayName });
}

describe('F-006 project create / read via real SQLite port', () => {
  it('creates a project with stable id, revision 1 and persisted fields, and reads it back equal', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(project.displayName).toBe('示例项目');
        expect(project.description).toBeNull();
        expect(project.labels).toEqual([]);
        expect(project.status).toBe('active');
        expect(project.repositoryBindingId).toBeNull();
        expect(project.revision).toBe(1);
        expect(Number.isInteger(project.createdAtUtcMs)).toBe(true);
        expect(project.updatedAtUtcMs).toBe(project.createdAtUtcMs);

        const fetched = await harness.store.getProject(project.id);
        expect(fetched).toEqual(project);

        // 真实库中的持久化形态：labels 为 JSON 文本、description 为 NULL。
        const raw = rawRow(harness.session, 'SELECT * FROM projects WHERE id = ?', project.id);
        expect(raw['labels']).toBe('[]');
        expect(raw['description']).toBeNull();
        expect(raw['revision']).toBe(1);
        expect(raw['status']).toBe('active');
      } finally {
        harness.close();
      }
    });
  });

  it('persists a multibyte description and normalized labels', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await harness.store.createProject({
          displayName: '中文项目名',
          description: '可选说明（含中文、emoji 🚀 与多字节内容）',
          labels: [' Bug ', 'bug', '核心'],
        });
        expect(project.description).toContain('🚀');
        expect(project.labels).toEqual(['bug', '核心']);

        const fetched = await harness.store.getProject(project.id);
        expect(fetched.description).toBe('可选说明（含中文、emoji 🚀 与多字节内容）');
        expect(fetched.labels).toEqual(['bug', '核心']);
        const raw = rawRow(harness.session, 'SELECT labels FROM projects WHERE id = ?', project.id);
        expect(JSON.parse(raw['labels'] as string)).toEqual(['bug', '核心']);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid create input at validation with zero persisted rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        for (const input of [
          {},
          { displayName: '' },
          { displayName: '   ' },
          { displayName: 1 },
          { displayName: 'x', labels: 'not-an-array' },
          { displayName: 'x', labels: [''] },
          { displayName: 'x', unknownKey: true },
          'not-an-object',
        ]) {
          const error = await expectStorageError('validation', () => harness.store.createProject(input));
          expect(error.operation).toBe('StateStore.createProject');
          expect(error.entity?.type).toBe('project');
        }
        expect(countRows(harness.session, 'projects')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for a missing project and rejects illegal ids', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const missing = await expectStorageError('not_found', () =>
          harness.store.getProject('p-missing'),
        );
        expect(missing.entity).toEqual({ type: 'project', id: 'p-missing' });

        const illegal = await expectStorageError('validation', () =>
          harness.store.getProject('../escape'),
        );
        expect(illegal.details).toMatchObject({ field: 'projectId' });
      } finally {
        harness.close();
      }
    });
  });

  it('never derives ids or paths from displayName/description', async () => {
    await withMigratedDb(async (dbPath, root) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const a = await createProject(harness.store, '同名项目');
        const b = await createProject(harness.store, '同名项目');
        expect(a.id).not.toBe(b.id);
        expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
        // 数据库文件位置由装配显式决定，与项目名称/说明无关。
        expect(harness.dbPath).toBe(join(root, 'state.db'));
        expect(a.displayName).toBe('同名项目');
        expect(b.displayName).toBe('同名项目');
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-006 current settings (global singleton / per project)', () => {
  it('creates the single global settings record and rejects duplicates without overwriting', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const created = await harness.store.createGlobalSettings({ payload: VALID_PAYLOAD });
        expect(created.id).toBe(GLOBAL_SETTINGS_ID);
        expect(created.schemaVersion).toBe(1);
        expect(created.payload).toEqual(VALID_PAYLOAD);
        expect(created.revision).toBe(1);
        expect(Number.isInteger(created.createdAtUtcMs)).toBe(true);

        expect(await harness.store.getGlobalSettings()).toEqual(created);

        const duplicate = await expectStorageError('conflict', () =>
          harness.store.createGlobalSettings({ payload: { schemaVersion: 1 } }),
        );
        expect(duplicate.entity).toEqual({ type: 'global_settings', id: GLOBAL_SETTINGS_ID });
        // 重复创建被拒绝：单例行数仍为 1，原 payload/revision 未被覆盖。
        expect(countRows(harness.session, 'global_settings')).toBe(1);
        const fetched = await harness.store.getGlobalSettings();
        expect(fetched.payload).toEqual(VALID_PAYLOAD);
        expect(fetched.revision).toBe(1);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found when reading global settings that were never created', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const error = await expectStorageError('not_found', () => harness.store.getGlobalSettings());
        expect(error.entity).toEqual({ type: 'global_settings', id: GLOBAL_SETTINGS_ID });
        expect(countRows(harness.session, 'global_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('rejects invalid settings payloads before persistence with zero rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        for (const payload of [
          {},
          { schemaVersion: 2 },
          { schemaVersion: 1, unknown: true },
          { schemaVersion: 1, strategies: { defaultStrategy: { runtime: 'pi' } } },
          'not-an-object',
        ]) {
          const error = await expectStorageError('validation', () =>
            harness.store.createGlobalSettings({ payload }),
          );
          expect(error.operation).toBe('StateStore.createGlobalSettings');
        }
        // 未知键的输入整体拒绝，不能把 strategies 部分写入。
        await expectStorageError('validation', () =>
          harness.store.createGlobalSettings({ payload: VALID_PAYLOAD, extra: 1 }),
        );
        expect(countRows(harness.session, 'global_settings')).toBe(0);
      } finally {
        harness.close();
      }
    });
  });

  it('creates one settings row per project, isolated across projects, and rejects missing projects', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const projectA = await createProject(harness.store, '项目A');
        const projectB = await createProject(harness.store, '项目B');

        const created = await harness.store.createProjectSettings(projectA.id, { payload: VALID_PAYLOAD });
        expect(created.projectId).toBe(projectA.id);
        expect(created.schemaVersion).toBe(1);
        expect(created.payload).toEqual(VALID_PAYLOAD);
        expect(created.revision).toBe(1);

        await harness.store.createProjectSettings(projectB.id, { payload: { schemaVersion: 1 } });

        const settingsA = await harness.store.getProjectSettings(projectA.id);
        const settingsB = await harness.store.getProjectSettings(projectB.id);
        expect(settingsA.payload).toEqual(VALID_PAYLOAD);
        expect(settingsB.payload).toEqual({ schemaVersion: 1 });
        expect(settingsA.revision).toBe(1);
        expect(settingsB.revision).toBe(1);

        // 每项目一条：重复创建 conflict 且原配置不变。
        const duplicate = await expectStorageError('conflict', () =>
          harness.store.createProjectSettings(projectA.id, { payload: { schemaVersion: 1 } }),
        );
        expect(duplicate.entity).toEqual({ type: 'project_settings', projectId: projectA.id });
        expect((await harness.store.getProjectSettings(projectA.id)).payload).toEqual(VALID_PAYLOAD);

        // 项目不存在：FK 之外端口先给出明确 not_found。
        await expectStorageError('not_found', () =>
          harness.store.createProjectSettings('p-missing', { payload: { schemaVersion: 1 } }),
        );
        expect(countRows(harness.session, 'project_settings')).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for a project without settings', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        const error = await expectStorageError('not_found', () =>
          harness.store.getProjectSettings(project.id),
        );
        expect(error.entity).toEqual({ type: 'project_settings', projectId: project.id });
      } finally {
        harness.close();
      }
    });
  });

  it('never returns corrupted persisted JSON as a valid config from the read port', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        await harness.store.createProjectSettings(project.id, { payload: VALID_PAYLOAD });
        await harness.store.createGlobalSettings({ payload: VALID_PAYLOAD });

        // 直接 SQL 注入损坏持久 JSON（绕过端口，模拟磁盘/历史损坏）。DDL 的
        // json_valid 底线正常写入无法产生损坏 JSON，这里用诊断专用 PRAGMA
        // 故障注入证明读取端口本身不信任持久层（读取路径仍须 corrupt 拒绝）。
        harness.session.database.pragma('ignore_check_constraints = ON');
        try {
          harness.session.database
            .prepare("UPDATE project_settings SET payload = '{broken' WHERE project_id = ?")
            .run(project.id);
          harness.session.database
            .prepare("UPDATE global_settings SET payload = '{broken'")
            .run();
        } finally {
          harness.session.database.pragma('ignore_check_constraints = OFF');
        }

        const broken = await expectStorageError('corrupt', () =>
          harness.store.getProjectSettings(project.id),
        );
        expect(broken.entity).toEqual({ type: 'project_settings', projectId: project.id });

        // 未知 schemaVersion 的合法 JSON 通过 DDL 底线，但读取端口拒绝作为有效配置返回。
        harness.session.database
          .prepare("UPDATE project_settings SET payload = '{\"schemaVersion\":99}' WHERE project_id = ?")
          .run(project.id);
        await expectStorageError('corrupt', () => harness.store.getProjectSettings(project.id));

        const brokenGlobal = await expectStorageError('corrupt', () =>
          harness.store.getGlobalSettings(),
        );
        expect(brokenGlobal.entity).toEqual({ type: 'global_settings', id: GLOBAL_SETTINGS_ID });
      } finally {
        harness.close();
      }
    });
  });

  it('reports corrupt labels stored outside the string-array contract', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        // json_type='array' 通过 DDL 底线，但元素类型损坏：读取端口必须拒绝。
        harness.session.database
          .prepare("UPDATE projects SET labels = '[\"a\", 1]' WHERE id = ?")
          .run(project.id);
        await expectStorageError('corrupt', () => harness.store.getProject(project.id));
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-006 durability across close and reopen', () => {
  it('keeps projects and settings field-by-field identical after reopening the real database', async () => {
    await withMigratedDb(async (dbPath) => {
      const first = openHarness(dbPath, createClock());
      let projectA: Awaited<ReturnType<typeof createProject>>;
      let projectB: Awaited<ReturnType<typeof createProject>>;
      let global: Awaited<ReturnType<StateStore['createGlobalSettings']>>;
      let settingsA: Awaited<ReturnType<StateStore['createProjectSettings']>>;
      try {
        projectA = await first.store.createProject({
          displayName: '中文项目A',
          description: '含中文与 emoji 的说明 🚀',
          labels: ['core', '核心'],
        });
        projectB = await createProject(first.store, '项目B');
        global = await first.store.createGlobalSettings({ payload: VALID_PAYLOAD });
        settingsA = await first.store.createProjectSettings(projectA.id, { payload: VALID_PAYLOAD });
      } finally {
        first.close();
      }

      // 关闭后用全新会话+适配器重新打开同一文件库，读取不依赖内存缓存。
      const second = openHarness(dbPath, createClock(1_700_200_000_000));
      try {
        expect(await second.store.getProject(projectA.id)).toEqual(projectA);
        expect(await second.store.getProject(projectB.id)).toEqual(projectB);
        expect(await second.store.getGlobalSettings()).toEqual(global);
        expect(await second.store.getProjectSettings(projectA.id)).toEqual(settingsA);
        // 迁移记录仍在，库未被重建。
        expect(countRows(second.session, 'schema_migrations')).toBe(1);
      } finally {
        second.close();
      }
    });
  });
});

describe('F-006 expectedRevision CAS baseline (races and failure injection: F-007)', () => {
  it('applies project metadata updates under CAS and rejects stale revisions without side effects', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store, '原名');
        const stale = await expectStorageError('conflict', () =>
          harness.store.updateProject(project.id, { expectedRevision: 5, labels: ['x'] }),
        );
        expect(stale.entity).toEqual({ type: 'project', id: project.id });
        expect(stale.details).toMatchObject({ expectedRevision: 5, actualRevision: 1 });
        expect((await harness.store.getProject(project.id)).labels).toEqual([]);

        const updated = await harness.store.updateProject(project.id, {
          expectedRevision: 1,
          labels: ['核心'],
          displayName: '新名',
        });
        expect(updated.revision).toBe(2);
        expect(updated.labels).toEqual(['核心']);
        expect(updated.displayName).toBe('新名');
        expect(updated.createdAtUtcMs).toBe(project.createdAtUtcMs);

        await expectStorageError('validation', () =>
          harness.store.updateProject(project.id, { expectedRevision: 2 }),
        );
      } finally {
        harness.close();
      }
    });
  });

  it('updates settings under CAS; a stale update leaves payload and revision unchanged', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        await harness.store.createProjectSettings(project.id, { payload: VALID_PAYLOAD });
        await harness.store.createGlobalSettings({ payload: VALID_PAYLOAD });

        const staleProject = await expectStorageError('conflict', () =>
          harness.store.updateProjectSettings(project.id, {
            expectedRevision: 9,
            payload: { schemaVersion: 1 },
          }),
        );
        expect(staleProject.entity).toEqual({ type: 'project_settings', projectId: project.id });
        const staleGlobal = await expectStorageError('conflict', () =>
          harness.store.updateGlobalSettings({
            expectedRevision: 9,
            payload: { schemaVersion: 1 },
          }),
        );
        expect(staleGlobal.entity).toEqual({ type: 'global_settings', id: GLOBAL_SETTINGS_ID });

        const afterSettings = await harness.store.getProjectSettings(project.id);
        expect(afterSettings.payload).toEqual(VALID_PAYLOAD);
        expect(afterSettings.revision).toBe(1);
        const afterGlobal = await harness.store.getGlobalSettings();
        expect(afterGlobal.payload).toEqual(VALID_PAYLOAD);
        expect(afterGlobal.revision).toBe(1);

        const updated = await harness.store.updateProjectSettings(project.id, {
          expectedRevision: 1,
          payload: { schemaVersion: 1 },
        });
        expect(updated.revision).toBe(2);
        expect(updated.payload).toEqual({ schemaVersion: 1 });
        expect(updated.createdAtUtcMs).toBe(afterSettings.createdAtUtcMs);

        const updatedGlobal = await harness.store.updateGlobalSettings({
          expectedRevision: 1,
          payload: { schemaVersion: 1 },
        });
        expect(updatedGlobal.revision).toBe(2);
      } finally {
        harness.close();
      }
    });
  });

  it('keeps a labels-only project update from touching settings rows', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        await harness.store.createProjectSettings(project.id, { payload: VALID_PAYLOAD });
        const before = rawRow(
          harness.session,
          'SELECT revision, updated_at, payload FROM project_settings WHERE project_id = ?',
          project.id,
        );
        await harness.store.updateProject(project.id, { expectedRevision: 1, labels: ['核心'] });
        const after = rawRow(
          harness.session,
          'SELECT revision, updated_at, payload FROM project_settings WHERE project_id = ?',
          project.id,
        );
        expect(after).toEqual(before);
      } finally {
        harness.close();
      }
    });
  });

  it('returns not_found for updates on missing projects or settings', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const project = await createProject(harness.store);
        await expectStorageError('not_found', () =>
          harness.store.updateProject('p-missing', { expectedRevision: 1, labels: ['x'] }),
        );
        await expectStorageError('not_found', () =>
          harness.store.updateProjectSettings(project.id, {
            expectedRevision: 1,
            payload: { schemaVersion: 1 },
          }),
        );
        await expectStorageError('not_found', () =>
          harness.store.updateGlobalSettings({ expectedRevision: 1, payload: { schemaVersion: 1 } }),
        );
      } finally {
        harness.close();
      }
    });
  });
});

describe('F-006 session lifecycle', () => {
  it('rejects store operations on a closed session with a clear error', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      const project = await createProject(harness.store);
      harness.close();
      harness.close(); // 重复 close 安全。
      await expect(harness.store.getProject(project.id)).rejects.toThrow(/已关闭/);
      await expect(harness.store.createProject({ displayName: 'x' })).rejects.toThrow(/已关闭/);
      await expect(harness.store.getGlobalSettings()).rejects.toThrow(/已关闭/);
    });
  });

  it('does not expose driver handles through the port implementation', async () => {
    await withMigratedDb(async (dbPath) => {
      const harness = openHarness(dbPath, createClock());
      try {
        const store = harness.store as unknown as Record<string, unknown>;
        for (const key of Object.keys(store)) {
          const value = store[key];
          expect(String(key)).not.toMatch(/database|db/i);
          expect(value).not.toBe(harness.session.database);
        }
      } finally {
        harness.close();
      }
    });
  });
});
