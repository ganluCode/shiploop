/**
 * F-008 基础存储外键、项目归属与 DDL 约束回归矩阵（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-008 验收点，全部为真实断言）：
 * - 项目归属：真实项目 A/B（经 StateStore 端口创建）与各自仓库绑定。项目 A 引用
 *   项目 B 的绑定在两层均被拒绝——直接 SQL 由 F-008 补齐的同项目复合外键
 *   projects(id, repository_binding_id) → repository_bindings(project_id, id) 拒绝；
 *   存储端口由契约输入校验拒绝（注册流程与绑定写入端口属后续 Feature，端口不
 *   暴露绑定变更，任何携带 repositoryBindingId 的输入都是 validation 错误且零
 *   持久化副作用）；同项目绑定成功；缺失项目的配置/制品插入在端口与直接 SQL
 *   两层均失败；
 * - RESTRICT 删除保护：被配置/制品/绑定引用的项目、被项目引用的绑定删除均被
 *   拒绝；事务中的失败删除整体回滚，事务前后逐行一致；全部外键 ON DELETE
 *   RESTRICT，无任何数据库级级联；行删除（含 RESTRICT 失败）不操作用户源仓库
 *   或制品正文文件（哨兵文件保持不变）；
 * - DDL 约束矩阵：唯一、外键、枚举、JSON、非负/正整数与 ready 字段约束的正常
 *   样例与失败样例成对执行，失败样例断言真实 SQLite 抛出命名的约束错误且行数/
 *   值不变，不只检查错误日志。完整的基础 25 项约束失败矩阵见
 *   test/sqlite-schema-migrations.test.ts（同样在 npm test 中运行），本文件聚焦
 *   A/B 归属、同项目复合外键与成对正常样例；
 * - 只验证本 Feature 已建立的六张表，不为后续执行实体创建占位表或修改验收门槛。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError, StorageErrorKind } from '../packages/core/src/ports/errors.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { ProjectRecord, StateStore } from '../packages/core/src/ports/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW_MS = 1_700_500_000_000;
const VALID_SHA256 = 'ab'.repeat(32);
/** 稳定 ID 形态合法但不存在的项目 ID（走 not_found 路径而非格式校验路径）。 */
const MISSING_PROJECT_ID = 'missing-project-0f8';
const BODY_TEXT = '{"content":"制品正文哨兵 🚀"}';

/** F-002 Payload Schema 的最小合法配置。 */
const PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
};

type Harness = {
  readonly session: SqliteStorageSession;
  readonly store: StateStore;
  close(): void;
};

/**
 * 真实临时文件库 + F-005 迁移 + F-006 StateStore 端口装配。
 * 时钟注入（递增），全程不接触用户数据根。
 */
async function withOwnershipHarness(
  fn: (harness: Harness, root: string) => Promise<void>,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-f008-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    let tick = NOW_MS;
    const session = openSqliteStorageSession({ path: dbPath });
    try {
      await migrateSqliteStorage(session);
      const store = createSqliteStateStore(session, { nowUtcMs: () => (tick += 1) });
      await fn({ session, store, close: () => session.close() }, sandbox.path);
    } finally {
      session.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

interface AB {
  readonly projectA: ProjectRecord;
  readonly projectB: ProjectRecord;
  /** 项目 A/B 各自的绑定 ID。 */
  readonly bindA: string;
  readonly bindB: string;
}

/**
 * A/B 夹具：项目经真实存储端口创建；仓库绑定按 F-006 的边界记录以表级
 * （直接 SQL）方式建立——绑定写入端口属后续注册流程 Feature，本矩阵只验证
 * 表级归属约束，不为其扩展契约面。
 */
async function seedProjectsAndBindings(harness: Harness): Promise<AB> {
  const projectA = await harness.store.createProject({
    displayName: '项目 A',
    description: '归属矩阵 A',
  });
  const projectB = await harness.store.createProject({
    displayName: '项目 B',
    description: '归属矩阵 B',
  });
  insertBinding(harness, 'bind-a', projectA.id, '/repos/a');
  insertBinding(harness, 'bind-b', projectB.id, '/repos/b');
  return { projectA, projectB, bindA: 'bind-a', bindB: 'bind-b' };
}

function insertBinding(
  harness: Harness,
  id: string,
  projectId: string,
  canonicalPath: string,
): void {
  harness.session.transactWrite('f008.insertBinding', (db) => {
    db.prepare(
      'INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity, binding_revision) ' +
        "VALUES (?, ?, ?, 1, ?, ?, NULL, ?, 1)",
    ).run(id, NOW_MS, projectId, NOW_MS, canonicalPath, `identity-${id}`);
  });
}

function insertArtifact(harness: Harness, id: string, projectId: string): void {
  harness.session.transactWrite('f008.insertArtifact', (db) => {
    db.prepare(
      'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, version, storage_locator) ' +
        "VALUES (?, ?, ?, 1, ?, 'verification-report', 'pending', 'application/json', ?, 1, ?)",
    ).run(id, NOW_MS, projectId, NOW_MS, VALID_SHA256, `artifacts/${id}/v1/report.json`);
  });
}

function countRows(harness: Harness, table: string): number {
  const row = harness.session.database
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  return row.n;
}

function rawRow(harness: Harness, sql: string, ...params: unknown[]): Record<string, unknown> {
  return harness.session.database.prepare(sql).get(...params) as Record<string, unknown>;
}

/** 全部业务表的逐行快照（按 id 排序），供事务前后 deep-equal 核对。 */
function snapshotAll(harness: Harness): Record<string, Record<string, unknown>[]> {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of [
    'projects',
    'repository_bindings',
    'global_settings',
    'project_settings',
    'artifacts',
  ]) {
    result[table] = harness.session.database
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all() as Record<string, unknown>[];
  }
  return result;
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

// ---------------------------------------------------------------------------
// 项目归属：项目 A 不能引用项目 B 的仓库绑定
// ---------------------------------------------------------------------------

describe('F-008 项目归属：仓库绑定只能属于同一项目', () => {
  it('正常样例：同项目绑定可被其项目引用，且引用后绑定删除受 RESTRICT 保护', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      // 同项目引用：A 引用自己的 bind-a，成功。
      harness.session.database
        .prepare('UPDATE projects SET repository_binding_id = ? WHERE id = ?')
        .run(ab.bindA, ab.projectA.id);
      const row = rawRow(
        harness,
        'SELECT repository_binding_id FROM projects WHERE id = ?',
        ab.projectA.id,
      );
      expect(row['repository_binding_id']).toBe(ab.bindA);
      // 绑定被项目引用后删除受 RESTRICT 保护，原行保留。
      expect(() =>
        harness.session.database
          .prepare('DELETE FROM repository_bindings WHERE id = ?')
          .run(ab.bindA),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(countRows(harness, 'repository_bindings')).toBe(2);
      expect(countRows(harness, 'projects')).toBe(2);
    });
  });

  it('项目 A 引用项目 B 的绑定被直接 SQL 拒绝，A/B 两行逐字段不变', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      const beforeA = rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id);
      const beforeB = rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectB.id);
      expect(() =>
        harness.session.database
          .prepare('UPDATE projects SET repository_binding_id = ? WHERE id = ?')
          .run(ab.bindB, ab.projectA.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id)).toEqual(beforeA);
      expect(rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectB.id)).toEqual(beforeB);
      // B 引用 A 的绑定同样被拒绝（对称验证）。
      expect(() =>
        harness.session.database
          .prepare('UPDATE projects SET repository_binding_id = ? WHERE id = ?')
          .run(ab.bindA, ab.projectB.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id)).toEqual(beforeA);
    });
  });

  it('引用不存在的绑定 id 被直接 SQL 拒绝，行不变', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      const before = rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id);
      expect(() =>
        harness.session.database
          .prepare('UPDATE projects SET repository_binding_id = ? WHERE id = ?')
          .run('no-such-binding', ab.projectA.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id)).toEqual(before);
    });
  });

  it('项目 A 引用项目 B 的绑定被存储端口拒绝且零持久化副作用', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      const projectsBefore = countRows(harness, 'projects');
      const beforeA = rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id);

      // 端口契约不暴露绑定变更（注册流程属后续 Feature）：任何携带
      // repositoryBindingId 的输入都是 validation 错误，跨项目引用无法经端口建立。
      const updateError = await expectStorageError('validation', () =>
        harness.store.updateProject(ab.projectA.id, {
          expectedRevision: 1,
          repositoryBindingId: ab.bindB,
        }),
      );
      expect(updateError.message).toContain('repositoryBindingId');
      expect(rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id)).toEqual(beforeA);

      const createError = await expectStorageError('validation', () =>
        harness.store.createProject({ displayName: '越权项目', repositoryBindingId: ab.bindB }),
      );
      expect(createError.message).toContain('repositoryBindingId');
      expect(countRows(harness, 'projects')).toBe(projectsBefore);

      // 端口合法路径的元数据更新不会顺带改动绑定引用列。
      const updated = await harness.store.updateProject(ab.projectA.id, {
        expectedRevision: 1,
        labels: ['归属'],
      });
      expect(updated.repositoryBindingId).toBeNull();
      const afterA = rawRow(harness, 'SELECT * FROM projects WHERE id = ?', ab.projectA.id);
      expect(afterA['repository_binding_id']).toBeNull();
      expect(afterA['revision']).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// 缺失项目的配置/制品插入
// ---------------------------------------------------------------------------

describe('F-008 缺失项目的配置与制品插入均失败', () => {
  it('正常样例：A/B 各自的当前配置经端口创建且互相隔离', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      await harness.store.createProjectSettings(ab.projectA.id, { payload: PAYLOAD });
      await harness.store.createProjectSettings(ab.projectB.id, { payload: PAYLOAD });
      const settingsA = await harness.store.getProjectSettings(ab.projectA.id);
      const settingsB = await harness.store.getProjectSettings(ab.projectB.id);
      expect(settingsA.projectId).toBe(ab.projectA.id);
      expect(settingsB.projectId).toBe(ab.projectB.id);
      expect(settingsA.id).not.toBe(settingsB.id);
      // 原始行核验：每项目恰一条，归属列正确。
      const rows = harness.session.database
        .prepare('SELECT project_id FROM project_settings ORDER BY project_id')
        .all() as { project_id: string }[];
      expect(rows.map((row) => row.project_id)).toEqual(
        [ab.projectA.id, ab.projectB.id].sort(),
      );
    });
  });

  it('存储端口为缺失项目创建/更新配置返回 not_found，零写入', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      await harness.store.createProjectSettings(ab.projectA.id, { payload: PAYLOAD });
      const settingsCount = countRows(harness, 'project_settings');

      await expectStorageError('not_found', () =>
        harness.store.createProjectSettings(MISSING_PROJECT_ID, { payload: PAYLOAD }),
      );
      await expectStorageError('not_found', () =>
        harness.store.getProjectSettings(MISSING_PROJECT_ID),
      );
      await expectStorageError('not_found', () =>
        harness.store.updateProjectSettings(MISSING_PROJECT_ID, {
          expectedRevision: 1,
          payload: PAYLOAD,
        }),
      );
      expect(countRows(harness, 'project_settings')).toBe(settingsCount);
    });
  });

  it('直接 SQL 为缺失项目插入配置/制品均被外键拒绝，行数为零', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      expect(() =>
        harness.session.database
          .prepare(
            'INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) ' +
              "VALUES ('ps-orphan', ?, ?, 1, ?, 1, ?)",
          )
          .run(NOW_MS, MISSING_PROJECT_ID, NOW_MS, JSON.stringify(PAYLOAD)),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(() =>
        harness.session.database
          .prepare(
            'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, storage_locator) ' +
              "VALUES ('art-orphan', ?, ?, 1, ?, 'report', 'application/json', ?, 'artifacts/art-orphan/v1/r.json')",
          )
          .run(NOW_MS, MISSING_PROJECT_ID, NOW_MS, VALID_SHA256),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(countRows(harness, 'project_settings')).toBe(0);
      expect(countRows(harness, 'artifacts')).toBe(0);
      // 正常样例：A 的配置与制品插入成功。
      insertArtifact(harness, 'art-a-1', ab.projectA.id);
      expect(countRows(harness, 'artifacts')).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// RESTRICT 删除保护、事务原子性与“不触碰正文文件”
// ---------------------------------------------------------------------------

describe('F-008 RESTRICT 删除保护与事务原子性', () => {
  it('删除被配置/制品/绑定引用的项目被拒绝，全部原行与值保留', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      await harness.store.createProjectSettings(ab.projectA.id, { payload: PAYLOAD });
      insertArtifact(harness, 'art-a-1', ab.projectA.id);
      const before = snapshotAll(harness);

      expect(() =>
        harness.session.database
          .prepare('DELETE FROM projects WHERE id = ?')
          .run(ab.projectA.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(snapshotAll(harness)).toEqual(before);
    });
  });

  it('未被引用的项目可以删除（普通行删除）；被引用的项目删除被拒', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      const projectC = await harness.store.createProject({ displayName: '未引用项目 C' });
      // 未被任何配置/制品/绑定引用的项目 C 可删除，且只是普通行删除。
      harness.session.database
        .prepare('DELETE FROM projects WHERE id = ?')
        .run(projectC.id);
      expect(countRows(harness, 'projects')).toBe(2);
      // 项目 A 被自身绑定引用（bindings.project_id 外键），删除被拒。
      expect(() =>
        harness.session.database
          .prepare('DELETE FROM projects WHERE id = ?')
          .run(ab.projectA.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(countRows(harness, 'projects')).toBe(2);
    });
  });

  it('事务中的失败删除整体回滚，事务前后逐行一致', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      await harness.store.createProjectSettings(ab.projectA.id, { payload: PAYLOAD });
      insertArtifact(harness, 'art-a-1', ab.projectA.id);
      const before = snapshotAll(harness);

      // 同一事务内：先成功插入一条新制品索引，再执行被 RESTRICT 拒绝的项目删除。
      expect(() =>
        harness.session.transactWrite('f008.failed_delete_tx', (db) => {
          db.prepare(
            'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, version, storage_locator) ' +
              "VALUES ('art-ghost', ?, ?, 1, ?, 'report', 'pending', 'application/json', ?, 1, 'artifacts/art-ghost/v1/r.json')",
          ).run(NOW_MS, ab.projectA.id, NOW_MS, VALID_SHA256);
          db.prepare('DELETE FROM projects WHERE id = ?').run(ab.projectA.id);
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
      // 整组回滚：先行插入的制品索引不残留，全部表逐行与事务前一致。
      expect(snapshotAll(harness)).toEqual(before);
    });
  });

  it('行删除与 RESTRICT 失败均不操作制品正文或用户源仓库哨兵文件', async () => {
    await withOwnershipHarness(async (harness, root) => {
      const ab = await seedProjectsAndBindings(harness);
      insertArtifact(harness, 'art-sentinel', ab.projectA.id);
      // 制品正文与用户源仓库哨兵：物理文件由后续制品文件适配器（F-010+）与
      // 仓库注册流程管理；此处验证数据库的行删除（无论成功或 RESTRICT 失败）
      // 都不触碰它们——存储库只保存索引，不存在数据库级级联到文件的能力。
      const contentDir = join(root, 'content-root', 'artifacts', 'art-sentinel', 'v1');
      mkdirSync(contentDir, { recursive: true });
      writeFileSync(join(contentDir, 'body.json'), BODY_TEXT);
      const repoDir = join(root, 'repos', 'a');
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, '.git-meta-sentinel'), 'repo-meta');

      expect(() =>
        harness.session.database
          .prepare('DELETE FROM projects WHERE id = ?')
          .run(ab.projectA.id),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(readFileSync(join(contentDir, 'body.json'), 'utf-8')).toBe(BODY_TEXT);
      expect(existsSync(join(repoDir, '.git-meta-sentinel'))).toBe(true);

      // 成功的行删除（未被引用的制品索引行）同样不操作正文文件。
      harness.session.database
        .prepare('DELETE FROM artifacts WHERE id = ?')
        .run('art-sentinel');
      expect(countRows(harness, 'artifacts')).toBe(0);
      expect(readFileSync(join(contentDir, 'body.json'), 'utf-8')).toBe(BODY_TEXT);
      expect(existsSync(join(repoDir, '.git-meta-sentinel'))).toBe(true);
    });
  });

  it('全部外键均为 ON DELETE RESTRICT，迁移 DDL 不含任何级联动作', async () => {
    await withOwnershipHarness(async (harness) => {
      // 迁移 DDL 不出现 CASCADE（无数据库级级联；行删除不会波及任何其他行/文件）。
      for (const migration of SQLITE_MIGRATIONS) {
        expect(migration.sql).not.toMatch(/CASCADE/i);
      }
      // 真实库核对：每条外键的 on_delete 都是 RESTRICT、on_update 为 NO ACTION。
      type FkRow = { id: number; on_update: string; on_delete: string };
      const seen: FkRow[] = [];
      for (const table of [
        'projects',
        'repository_bindings',
        'global_settings',
        'project_settings',
        'artifacts',
        'state_events',
        'schema_migrations',
      ]) {
        seen.push(
          ...(harness.session.database
            .prepare(`PRAGMA foreign_key_list(${table})`)
            .all() as FkRow[]),
        );
      }
      expect(seen.length).toBeGreaterThan(0);
      for (const row of seen) {
        expect(row.on_delete).toBe('RESTRICT');
        expect(row.on_update).toBe('NO ACTION');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// DDL 约束矩阵：正常样例与失败样例成对（每类约束至少一对）
// ---------------------------------------------------------------------------

type MatrixCase = {
  /** 约束类别（F-008 验收点 3 的枚举）。 */
  readonly category: '唯一' | '外键' | '枚举' | 'JSON' | '非负整数' | '正整数' | 'ready 字段';
  /** 约束描述：对应表/列与约束名。 */
  readonly constraint: string;
  /** 夹具准备（在正常样例之前执行）。 */
  readonly seed?: (harness: Harness, ab: AB) => Promise<void> | void;
  /** 正常样例：必须成功提交。 */
  readonly normal: { readonly sql: string; readonly params: readonly unknown[] };
  /** 失败样例：必须抛出命名的约束错误且该表行数不变。 */
  readonly failure: {
    readonly sql: string;
    readonly params: readonly unknown[];
    readonly table: string;
    readonly error: RegExp;
  };
};

const BINDING_COLUMNS =
  'INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity, binding_revision) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)';

const MATRIX: readonly MatrixCase[] = [
  {
    category: '唯一',
    constraint: 'repository_bindings.canonical_path 全库唯一（repository_bindings_canonical_path_unique）',
    normal: {
      sql: BINDING_COLUMNS,
      params: ['bind-b2', NOW_MS, '__B__', NOW_MS, '/repos/b2', 'identity-bind-b2', 1],
    },
    failure: {
      sql: BINDING_COLUMNS,
      params: ['bind-b3', NOW_MS, '__B__', NOW_MS, '/repos/a', 'identity-bind-b3', 1],
      table: 'repository_bindings',
      error: /UNIQUE constraint failed: repository_bindings\.canonical_path/,
    },
  },
  {
    category: '唯一',
    constraint: 'artifacts.id 主键全局唯一（即使跨项目也不能复用）',
    seed: (harness, ab) => {
      insertArtifact(harness, 'art-dup', ab.projectA.id);
    },
    normal: {
      sql: 'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?)',
      params: ['art-dup-2', NOW_MS, '__B__', NOW_MS, 'report', 'application/json', VALID_SHA256, 'artifacts/art-dup-2/v1/r.json'],
    },
    failure: {
      sql: 'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?)',
      params: ['art-dup', NOW_MS, '__B__', NOW_MS, 'report', 'application/json', VALID_SHA256, 'artifacts/art-dup-x/v1/r.json'],
      table: 'artifacts',
      error: /UNIQUE constraint failed: artifacts\.id/,
    },
  },
  {
    category: '外键',
    constraint: 'repository_bindings.project_id → projects.id（缺失项目拒绝，repository_bindings_project_fk）',
    normal: {
      sql: BINDING_COLUMNS,
      params: ['bind-b2', NOW_MS, '__B__', NOW_MS, '/repos/b2', 'identity-bind-b2', 1],
    },
    failure: {
      sql: BINDING_COLUMNS,
      params: ['bind-x', NOW_MS, MISSING_PROJECT_ID, NOW_MS, '/repos/x', 'identity-bind-x', 1],
      table: 'repository_bindings',
      error: /FOREIGN KEY constraint failed/,
    },
  },
  {
    category: '外键',
    constraint: 'projects(id, repository_binding_id) 同项目复合外键（跨项目引用拒绝，projects_repository_binding_same_project_fk）',
    normal: {
      sql: 'UPDATE projects SET repository_binding_id = ? WHERE id = ?',
      params: ['__BIND_A__', '__A__'],
    },
    failure: {
      sql: 'UPDATE projects SET repository_binding_id = ? WHERE id = ?',
      params: ['__BIND_B__', '__A__'],
      table: 'projects',
      error: /FOREIGN KEY constraint failed/,
    },
  },
  {
    category: '枚举',
    constraint: 'artifacts.status ∈ pending/ready/failed（artifacts_status_enum_check）',
    seed: (harness, ab) => {
      insertArtifact(harness, 'art-enum', ab.projectA.id);
    },
    normal: {
      sql: "UPDATE artifacts SET status = 'failed', failure_reason = '注入失败样例前的正常样例' WHERE id = 'art-enum'",
      params: [],
    },
    failure: {
      sql: "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, version, storage_locator) VALUES ('art-enum-x', ?, ?, 1, ?, 'report', 'published', 'application/json', ?, 1, 'artifacts/art-enum-x/v1/r.json')",
      params: [NOW_MS, '__A__', NOW_MS, VALID_SHA256],
      table: 'artifacts',
      error: /CHECK constraint failed: artifacts_status_enum_check/,
    },
  },
  {
    category: '枚举',
    constraint: "projects.status ∈ active/archiving/archived/deleting（projects_status_enum_check）",
    normal: {
      sql: 'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, ?, NULL, ?)',
      params: ['proj-enum-ok', NOW_MS, NOW_MS, '枚举正常样例', 'archived', '[]'],
    },
    failure: {
      sql: 'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, ?, NULL, ?)',
      params: ['proj-enum-x', NOW_MS, NOW_MS, '枚举失败样例', 'bogus', '[]'],
      table: 'projects',
      error: /CHECK constraint failed: projects_status_enum_check/,
    },
  },
  {
    category: 'JSON',
    constraint: 'projects.labels 必须是 JSON 数组（projects_labels_json_array_check）',
    normal: {
      sql: 'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, ?, NULL, ?)',
      params: ['proj-json-ok', NOW_MS, NOW_MS, 'JSON 正常样例', 'active', '["alpha","中文"]'],
    },
    failure: {
      sql: 'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, ?, NULL, ?)',
      params: ['proj-json-x', NOW_MS, NOW_MS, 'JSON 失败样例', 'active', '{"not":"array"}'],
      table: 'projects',
      error: /CHECK constraint failed: projects_labels_json_array_check/,
    },
  },
  {
    category: '非负整数',
    constraint: 'artifacts.size_bytes ≥ 0（artifacts_size_bytes_non_negative_check）',
    seed: (harness, ab) => {
      insertArtifact(harness, 'art-size', ab.projectA.id);
    },
    normal: {
      sql: "UPDATE artifacts SET size_bytes = 0 WHERE id = 'art-size'",
      params: [],
    },
    failure: {
      sql: "UPDATE artifacts SET size_bytes = -1 WHERE id = 'art-size'",
      params: [],
      table: 'artifacts',
      error: /CHECK constraint failed: artifacts_size_bytes_non_negative_check/,
    },
  },
  {
    category: '正整数',
    constraint: 'repository_bindings.binding_revision ≥ 1（repository_bindings_binding_revision_positive_check）',
    normal: {
      sql: BINDING_COLUMNS,
      params: ['bind-rev-ok', NOW_MS, '__B__', NOW_MS, '/repos/rev-ok', 'identity-bind-rev-ok', 1],
    },
    failure: {
      sql: BINDING_COLUMNS,
      params: ['bind-rev-x', NOW_MS, '__B__', NOW_MS, '/repos/rev-x', 'identity-bind-rev-x', 0],
      table: 'repository_bindings',
      error: /CHECK constraint failed: repository_bindings_binding_revision_positive_check/,
    },
  },
  {
    category: '正整数',
    constraint: 'artifacts.version ≥ 1（artifacts_version_positive_check）',
    normal: {
      sql: 'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, ?)',
      params: ['art-version-ok', NOW_MS, '__A__', NOW_MS, 'report', 'application/json', VALID_SHA256, 'artifacts/art-version-ok/v1/r.json'],
    },
    failure: {
      sql: 'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?)',
      params: ['art-version-x', NOW_MS, '__A__', NOW_MS, 'report', 'application/json', VALID_SHA256, 'artifacts/art-version-x/v1/r.json'],
      table: 'artifacts',
      error: /CHECK constraint failed: artifacts_version_positive_check/,
    },
  },
  {
    category: 'ready 字段',
    constraint: 'ready 必须携带 content_hash 与 size_bytes（artifacts_ready_identity_check）',
    seed: (harness, ab) => {
      insertArtifact(harness, 'art-ready-1', ab.projectA.id);
      insertArtifact(harness, 'art-ready-2', ab.projectA.id);
    },
    normal: {
      sql: "UPDATE artifacts SET status = 'ready', content_hash = ?, size_bytes = 10 WHERE id = 'art-ready-1'",
      params: [VALID_SHA256],
    },
    failure: {
      sql: "UPDATE artifacts SET status = 'ready' WHERE id = 'art-ready-2'",
      params: [],
      table: 'artifacts',
      error: /CHECK constraint failed: artifacts_ready_identity_check/,
    },
  },
];

describe.each(MATRIX)('F-008 约束矩阵[%s] %s', (testCase) => {
  it('正常样例成功、失败样例被拒绝且行数不变', async () => {
    await withOwnershipHarness(async (harness) => {
      const ab = await seedProjectsAndBindings(harness);
      if (testCase.seed) {
        await testCase.seed(harness, ab);
      }
      const resolveParams = (params: readonly unknown[]): unknown[] =>
        params.map((param) =>
          param === '__A__'
            ? ab.projectA.id
            : param === '__B__'
              ? ab.projectB.id
              : param === '__BIND_A__'
                ? ab.bindA
                : param === '__BIND_B__'
                  ? ab.bindB
                  : param,
        );

      // 正常样例：真实提交成功。
      harness.session.database
        .prepare(testCase.normal.sql)
        .run(...resolveParams(testCase.normal.params));

      // 失败样例：真实 SQLite 抛出命名的约束错误，且该表行数不变。
      const before = countRows(harness, testCase.failure.table);
      expect(() =>
        harness.session.database
          .prepare(testCase.failure.sql)
          .run(...resolveParams(testCase.failure.params)),
      ).toThrow(testCase.failure.error);
      expect(countRows(harness, testCase.failure.table)).toBe(before);
    });
  });
});
