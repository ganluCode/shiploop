/**
 * P03-1 / F-002 计划结构存储回归：迁移 v6（phases/features/tasks/task_dependencies）、
 * 真实 SQLite 负例与 CommandTransaction 窄存储原语（真实临时 SQLite，非 mock）。
 *
 * 覆盖（F-002 验收点，全部为真实断言）：
 * - 迁移：真实空库与包含项目、配置、Artifact、回执及事件的真实 P02 v5 库升级到 v6
 *   成功；既有数据与事件序列逐字段保留；历史 v1–v5 SQL/checksum 与冻结摘要一致；
 *   v6 迁移失败整组回滚、库保持一致 v5；高版本/checksum 漂移拒写继续有效；
 * - 真实 SQLite 负例（直接 SQL 命中 DDL 约束，不用 TypeScript 校验模拟数据库约束）：
 *   不存在或跨项目父级（复合外键）、跨 Feature 依赖（同 Feature 复合外键）、自依赖
 *   （CHECK）、重复身份/边（主键与 UNIQUE(feature_id,task_id,depends_on_id)）、
 *   非法状态（枚举 CHECK）与非法 JSON（json_valid/json_type CHECK）；每项失败后行数
 *   不变。环由应用层（原语内 DFS）校验并测试；完整策略语义属 F-003；
 * - CommandTransaction 窄存储原语：insertPhase/insertFeature/insertTask/
 *   insertTaskDependency 同一原子命令事务内可用，返回应用侧记录；标签默认空数组
 *   且不继承父级；UTC 时间与 revision=1 沿用既有规范；重开数据库后持久值一致；
 *   事务内后续原语失败时整组回滚，无半条记录。
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { ProjectRecord, StateStore } from '../packages/core/src/ports/state-store.ts';
import type { AtomicCommandStore, CommandTransaction } from '../packages/core/src/ports/atomic-commands.ts';
import { SQLITE_MIGRATIONS as DECLARED_SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { migrateSqliteStorage as migrateDeclaredSqliteStorage, SqliteMigrationError } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const NOW_MS = 1_700_600_000_000;
const VALID_SHA256 = 'ab'.repeat(32);
// Historical migration snapshots include the v9 receipt columns, before v10 rebuilds them.
const SQLITE_MIGRATIONS = DECLARED_SQLITE_MIGRATIONS.slice(0, 9);
function migrateSqliteStorage(session: SqliteStorageSession,
  options: Parameters<typeof migrateDeclaredSqliteStorage>[1] = {}) {
  return migrateDeclaredSqliteStorage(session, { migrations: SQLITE_MIGRATIONS, ...options });
}
/** 形态合法但不存在的稳定 ID（走 not_found 而非格式校验路径）。 */
const MISSING_ID = 'missing-entity-0f8';

/** F-002 Payload Schema 的最小合法配置（真实 P02 v5 库种子）。 */
const PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
  },
};

/**
 * 历史 v1–v5 迁移 SQL 的冻结 SHA-256（P03-1 / F-002 开工时计算）。
 * F-002 只允许追加 v6；任何对 v1–v5 内容的改动都会使本断言失败。
 */
const FROZEN_V1_TO_V5_CHECKSUMS: Readonly<Record<number, string>> = {
  1: 'd5c70af3fe49fc43eba42d92e65d1bb4f305360671942d76e3c5805369723aba',
  2: 'bd8a2aa9c77c53f4bc56bf38ce9077f3068d6c9d47ee905f774530e66f3bdcb5',
  3: 'd49e96aaa8d84d9d6c44e16a99e617b8d8b67fbbb801e3b9724827c7ec629d79',
  4: '12df77d50cacf7e12c88ed453897f8f988760b6860d13dddfb8e8f9a26e3a059',
  5: 'bbb3dd79d4944b7fd0b4cd87ba0aa475aba0932a68b74acf50e7b9f446fba8b3',
};

/** v6 建立的本项必需表；feature_dependencies/完整 Attempt/Session/Worktree/通知/业务版本表等不提前建立
 * （P03-3 / F-002 起 execution_batches/runs/batch_budget_revisions 由迁移 v9 正式建立，移出本清单）。 */
const V6_TABLES = ['phases', 'features', 'tasks', 'task_dependencies'] as const;
const V6_FORBIDDEN_TABLES = [
  'feature_dependencies',
  'attempts',
  'workspace_leases',
  'configuration_revisions',
] as const;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function listUserTables(db: SqliteStorageSession['database']): string[] {
  return (
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** P02 既有业务表的完整行快照（升级前后逐字段比对；schema_migrations 另行断言 v6 新增）。 */
const P02_SNAPSHOT_TABLES = [
  'projects',
  'repository_bindings',
  'global_settings',
  'project_settings',
  'artifacts',
  'command_receipts',
  'state_events',
] as const;

function snapshotTables(db: SqliteStorageSession['database']): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of P02_SNAPSHOT_TABLES) {
    snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  return snapshot;
}

/** 在真实临时库上打开会话（不迁移；由调用方决定迁移版本）。 */
function openSession(dbPath: string, startMs = NOW_MS): { session: SqliteStorageSession; tick: () => number } {
  let tick = startMs;
  const session = openSqliteStorageSession({ path: dbPath });
  return {
    session,
    tick: () => {
      const value = tick;
      tick += 1_000;
      return value;
    },
  };
}

/** 组装迁移后的原子命令存储 + StateStore（真实项目父级经端口创建）。 */
async function withPlanHarness(
  fn: (harness: {
    readonly session: SqliteStorageSession;
    readonly state: StateStore;
    readonly atomic: AtomicCommandStore;
    readonly projectA: ProjectRecord;
    readonly projectB: ProjectRecord;
  }) => Promise<void>,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p03-1-f002-');
  try {
    const { session, tick } = openSession(join(sandbox.path, 'state.db'));
    try {
      await migrateSqliteStorage(session, { nowUtcMs: tick });
      const state = createSqliteStateStore(session, { nowUtcMs: tick });
      const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: tick });
      const projectA = await state.createProject({ displayName: '项目 A', labels: ['alpha'] });
      const projectB = await state.createProject({ displayName: '项目 B', labels: ['beta'] });
      await fn({ session, state, atomic, projectA, projectB });
    } finally {
      session.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

/** 经原语建立最小结构夹具：Phase + Feature + Tasks（a、b、c）。 */
async function seedStructure(
  atomic: AtomicCommandStore,
  projectId: string,
): Promise<{ phaseId: string; featureId: string }> {
  return atomic.transact('test.seed.structure', (tx) => {
    const phase = tx.insertPhase({ projectId, title: 'P03 计划阶段', labels: ['phase-label'] });
    const feature = tx.insertFeature({
      projectId,
      phaseId: phase.id,
      title: 'Feature 登录',
      planDigest: VALID_SHA256,
      sourceRefs: [{ artifactId: 'art-source-1' }],
    });
    for (const [id, title] of [
      ['t-a', '任务 A'],
      ['t-b', '任务 B'],
      ['t-c', '任务 C'],
    ] as const) {
      tx.insertTask({
        projectId,
        featureId: feature.id,
        id,
        title,
        acceptance: { criteria: [`${title} 完成验收`] },
        complexity: 'low',
        executionConfig: { schemaVersion: 2, strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
        configSource: 'project_default',
        configSourceKey: 'defaultStrategy',
      });
    }
    return { phaseId: phase.id, featureId: feature.id };
  });
}

/* ------------------------------------------------------------------ *
 * 迁移 v6：空库 / 真实 P02 v5 库升级、历史冻结、失败回滚
 * ------------------------------------------------------------------ */

describe('F-002 迁移 v6：计划结构四表', () => {
  it('历史 v1–v5 SQL/checksum 与开工冻结摘要一致，v6/v7/v8/v9 为新增追加版本', () => {
    expect(SQLITE_MIGRATIONS.length).toBe(9);
    for (const [version, frozen] of Object.entries(FROZEN_V1_TO_V5_CHECKSUMS)) {
      const migration = SQLITE_MIGRATIONS[Number(version) - 1];
      expect(migration?.version, `v${version} 版本号`).toBe(Number(version));
      expect(migration?.checksum, `v${version} checksum 不得改动`).toBe(frozen);
      expect(migration?.checksum).toBe(sha256Hex(migration?.sql ?? ''));
    }
    const v6 = SQLITE_MIGRATIONS[5];
    expect(v6?.version).toBe(6);
    expect(v6?.checksum).toBe(sha256Hex(v6?.sql ?? ''));
    for (const table of V6_TABLES) {
      expect(v6?.sql, `v6 必须建立 ${table}`).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
    }
    // 不提前建立 Feature DAG / Batch / Run / Attempt / Approval / 配置或计划版本表。
    for (const forbidden of V6_FORBIDDEN_TABLES) {
      expect(v6?.sql, `v6 不得建立 ${forbidden}`).not.toContain(`CREATE TABLE ${forbidden}`);
    }
    // P03-2 / F-002：v7 为 v6 之后的新增追加版本（approvals 决策记录表；checkpoint
    // 接续纪律——历史 v1–v6 SQL/checksum 不变，已由上方冻结摘要循环覆盖 v1–v5，
    // v6 内容断言仍在本用例，v7 内容/约束由 test/sqlite-schema-migrations.test.ts 覆盖）。
    const v7 = SQLITE_MIGRATIONS[6];
    expect(v7?.version).toBe(7);
    expect(v7?.checksum).toBe(sha256Hex(v7?.sql ?? ''));
    expect(v7?.sql).toContain('CREATE TABLE approvals (');
    expect(v6?.checksum).toBe(sha256Hex(v6?.sql ?? ''));
    // P03-2 / F-003：v8 为 v7 之后的新增追加版本（approvals.check_policy_digest
    // 检查政策身份绑定列 + 决策身份复合唯一索引重建；不重建表、不改写既有行）。
    const v8 = SQLITE_MIGRATIONS[7];
    expect(v8?.version).toBe(8);
    expect(v8?.checksum).toBe(sha256Hex(v8?.sql ?? ''));
    expect(v8?.sql).toContain('ALTER TABLE approvals ADD COLUMN check_policy_digest');
    expect(v8?.sql).toContain('check_policy_digest');
    expect(v8?.sql).not.toContain('CREATE TABLE');
    // P03-3 / F-002：v9 为 v8 之后的新增追加版本（单 Feature 执行域三表
    // execution_batches/runs/batch_budget_revisions + 不可变内容触发器；历史
    // v1–v8 SQL/checksum 不变，v9 内容/约束由 test/p03-3-execution-schema.test.ts
    // 与 test/sqlite-schema-migrations.test.ts 覆盖）。
    const v9 = SQLITE_MIGRATIONS[8];
    expect(v9?.version).toBe(9);
    expect(v9?.checksum).toBe(sha256Hex(v9?.sql ?? ''));
    expect(v9?.sql).toContain('CREATE TABLE execution_batches (');
    expect(v9?.sql).toContain('CREATE TABLE runs (');
    expect(v9?.sql).toContain('CREATE TABLE batch_budget_revisions (');
  });

  it('真实空库迁移到 v9：计划结构四表、approvals 与执行域三表建立且为空，不建立后续表', async () => {
    const sandbox = createTempSandbox('shiploop-p03-1-f002-empty-');
    try {
      const { session } = openSession(join(sandbox.path, 'state.db'));
      try {
        const result = await migrateSqliteStorage(session);
        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(9);
        expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const tables = listUserTables(session.database);
        for (const table of [
          ...V6_TABLES,
          'approvals',
          // P03-3 / F-002 起执行域三表是正式表（空表，不代表创建执行实体）。
          'execution_batches',
          'runs',
          'batch_budget_revisions',
        ]) {
          expect(tables).toContain(table);
          expect(session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        // 其余后续表（完整 Attempt/Session/Worktree/配置或计划版本表）仍不得生成。
        for (const forbidden of V6_FORBIDDEN_TABLES) {
          expect(tables, `不得生成后续表 ${forbidden}`).not.toContain(forbidden);
        }
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('真实 P02 v5 库（项目、配置、Artifact、回执、事件）升级到 v6：既有数据与事件序列逐字段保留', async () => {
    const sandbox = createTempSandbox('shiploop-p03-1-f002-v5-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      try {
        const v5 = SQLITE_MIGRATIONS.slice(0, 5);
        await migrateSqliteStorage(session, { migrations: v5, nowUtcMs: tick });
        // 经真实端口建立项目 + 绑定 + 全局/项目配置；元数据更新产生 state_events。
        const state = createSqliteStateStore(session, { nowUtcMs: tick });
        const project = await state.createProjectWithRepositoryBinding(
          { displayName: 'P02 项目', labels: ['p02'] },
          { canonicalPath: '/tmp/shiploop-f002-v5/repo-a', repoIdentity: 'repo-identity-a' },
        );
        await state.createGlobalSettings({ payload: PAYLOAD });
        await state.createProjectSettings(project.project.id, { payload: PAYLOAD });
        await state.updateProject(project.project.id, { expectedRevision: 1, description: '升级前说明' });
        // Artifact 与命令回执按 v5 DDL 真实落行（发布/命令通道属 P02 既有测试，这里补齐行覆盖）。
        session.database
          .prepare(
            'INSERT INTO artifacts (id, created_at, revision, updated_at, project_id, kind, status, media_type, ' +
              'expected_hash, content_hash, size_bytes, storage_locator) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run('art-f002-1', NOW_MS, NOW_MS, project.project.id, 'requirements', 'ready', 'application/json', VALID_SHA256, VALID_SHA256, 42, 'projects/x/artifacts/art-f002-1');
        session.database
          .prepare(
            'INSERT INTO command_receipts (id, created_at, revision, updated_at, principal_id, command_id, scope_kind, ' +
              'project_id, operation, request_digest, status, operation_id, result_json, result_ref, issued_at, completed_at) ' +
              'VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
          )
          .run('receipt-f002-1', NOW_MS, NOW_MS, 'local-owner', 'cmd-f002-1', 'project', project.project.id, 'project.register', VALID_SHA256, 'completed', '{"ok":true}', 'ref-f002-1', NOW_MS, NOW_MS);
        const eventsBefore = session.database
          .prepare<[], { max: number }>('SELECT MAX(sequence) AS max FROM state_events')
          .get();
        expect(eventsBefore?.max).toBeGreaterThan(0);
        const before = snapshotTables(session.database);

        const result = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(result.fromVersion).toBe(5);
        expect(result.toVersion).toBe(9);
        expect(result.appliedVersions).toEqual([6, 7, 8, 9]);
        expect(snapshotTables(session.database)).toEqual(before);
        // 迁移记录：v1–v5 checksum 原样，v6/v7/v8/v9 为新记录。
        const rows = session.database
          .prepare<[], { version: number; checksum: string }>(
            'SELECT version, checksum FROM schema_migrations ORDER BY version',
          )
          .all();
        expect(rows).toHaveLength(9);
        for (const [version, frozen] of Object.entries(FROZEN_V1_TO_V5_CHECKSUMS)) {
          expect(rows[Number(version) - 1]?.checksum).toBe(frozen);
        }
        expect(rows[5]?.checksum).toBe(SQLITE_MIGRATIONS[5]?.checksum);
        expect(rows[6]?.checksum).toBe(SQLITE_MIGRATIONS[6]?.checksum);
        expect(rows[7]?.checksum).toBe(SQLITE_MIGRATIONS[7]?.checksum);
        expect(rows[8]?.checksum).toBe(SQLITE_MIGRATIONS[8]?.checksum);
        // 重开再核对：数据仍在、四表为空且结构可写（插入合法行成功）。
        session.close();
        const reopened = openSqliteStorageSession({ path: dbPath });
        try {
          expect(snapshotTables(reopened.database)).toEqual(before);
          reopened.database
            .prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)')
            .run('phase-reopen-1', NOW_MS, project.project.id, NOW_MS, '重开写入');
          expect(reopened.database.prepare('SELECT COUNT(*) AS n FROM phases').get()).toEqual({ n: 1 });
        } finally {
          reopened.close();
        }
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('v6 迁移失败整组回滚：库保持一致 v5，修复后升级成功且不伪装', async () => {
    const sandbox = createTempSandbox('shiploop-p03-1-f002-rollback-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      try {
        const v5 = SQLITE_MIGRATIONS.slice(0, 5);
        await migrateSqliteStorage(session, { migrations: v5, nowUtcMs: tick });
        const state = createSqliteStateStore(session, { nowUtcMs: tick });
        const project = await state.createProject({ displayName: '回滚项目' });
        const badSql =
          'CREATE TABLE f6_bad_probe (id TEXT PRIMARY KEY NOT NULL); THIS IS NOT VALID SQL;';
        const badV6 = { version: 6, sql: badSql, checksum: sha256Hex(badSql) };
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: [...v5, badV6], nowUtcMs: tick });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        expect((caught as SqliteMigrationError).step).toBe('apply');
        expect((caught as SqliteMigrationError).version).toBe(6);
        // 库保持 v5：无探针表、无 phases 表，既有数据不变。
        const tables = listUserTables(session.database);
        expect(tables).not.toContain('f6_bad_probe');
        expect(tables).not.toContain('phases');
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
        const versions = session.database
          .prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version')
          .all();
        expect(versions).toHaveLength(5);
        // 修复后（真实清单）从一致 v5 继续升级成功。
        const retry = await migrateSqliteStorage(session, { nowUtcMs: tick });
        expect(retry.appliedVersions).toEqual([6, 7, 8, 9]);
        expect(listUserTables(session.database)).toContain('task_dependencies');
        expect(listUserTables(session.database)).toContain('approvals');
        expect(project.id).toMatch(/^[A-Za-z0-9._-]+$/);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('高版本与 checksum 漂移拒写在 v9 清单下继续有效', async () => {
    const sandbox = createTempSandbox('shiploop-p03-1-f002-reject-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session } = openSession(dbPath);
      try {
        await migrateSqliteStorage(session);
        // 高版本：插入 v10 探针记录（超出支持范围）。
        session.database
          .prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)')
          .run('migration-v10', 1, 10, VALID_SHA256, 1);
        session.close();
        const highVersion = openSqliteStorageSession({ path: dbPath });
        let high: unknown;
        try {
          await migrateSqliteStorage(highVersion);
        } catch (error) {
          high = error;
        } finally {
          highVersion.close();
        }
        expect(isStorageError(high, 'unsupported_version'), `实际 ${String(high)}`).toBe(true);

        // checksum 漂移：篡改 v3 记录后拒写。
        const driftPath = join(sandbox.path, 'drift.db');
        const drift = openSqliteStorageSession({ path: driftPath });
        try {
          await migrateSqliteStorage(drift);
          drift.database
            .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 3')
            .run('cd'.repeat(32));
        } finally {
          drift.close();
        }
        const drifted = openSqliteStorageSession({ path: driftPath });
        let driftError: unknown;
        try {
          await migrateSqliteStorage(drifted);
        } catch (error) {
          driftError = error;
        } finally {
          drifted.close();
        }
        expect(isStorageError(driftError, 'corrupt'), `实际 ${String(driftError)}`).toBe(true);
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 真实 SQLite 负例：直接 SQL 命中 DDL 约束（不是 TypeScript 校验模拟）
 * ------------------------------------------------------------------ */

describe('F-002 计划结构 DDL 约束负例（真实 SQLite）', () => {
  it('不存在或跨项目父级由外键/复合外键拒绝，行数不变', async () => {
    await withPlanHarness(async ({ session, atomic, projectA, projectB }) => {
      const { featureId } = await seedStructure(atomic, projectA.id);
      const db = session.database;
      const phaseId = db.prepare('SELECT id FROM phases').get() as { id: string };

      // 不存在项目：phases 插入 FK 失败。
      expect(() =>
        db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)').run('phase-x1', NOW_MS, MISSING_ID, NOW_MS, '孤儿阶段'),
      ).toThrow(/FOREIGN KEY|constraint/i);
      // 跨项目父级：features 声明项目 B 但引用项目 A 的 Phase。
      expect(() =>
        db.prepare('INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title) VALUES (?, ?, ?, 1, ?, ?, ?)').run('feat-x1', NOW_MS, projectB.id, NOW_MS, phaseId.id, '跨项目 Feature'),
      ).toThrow(/FOREIGN KEY|constraint/i);
      // 跨项目父级：tasks 声明项目 B 但引用项目 A 的 Feature。
      expect(() =>
        db.prepare('INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, acceptance, execution_config, config_source) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run('t-x1', NOW_MS, projectB.id, NOW_MS, featureId, '跨项目任务', '{"criteria":["x"]}', '{}', 'project_default'),
      ).toThrow(/FOREIGN KEY|constraint/i);
      // 不存在 Feature：tasks 插入 FK 失败。
      expect(() =>
        db.prepare('INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, acceptance, execution_config, config_source) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run('t-x2', NOW_MS, projectA.id, NOW_MS, MISSING_ID, '孤儿任务', '{"criteria":["x"]}', '{}', 'project_default'),
      ).toThrow(/FOREIGN KEY|constraint/i);

      expect(db.prepare('SELECT COUNT(*) AS n FROM phases').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM features').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 3 });
    });
  });

  it('跨 Feature 依赖、自依赖与重复边由同 Feature 复合外键/CHECK/唯一索引拒绝', async () => {
    await withPlanHarness(async ({ session, atomic, projectA }) => {
      const first = await seedStructure(atomic, projectA.id);
      // 第二个 Feature + 任务 t-z（同项目同 Phase）。
      atomic.transact('test.seed.second', (tx) => {
        tx.insertFeature({ projectId: projectA.id, phaseId: first.phaseId, title: 'Feature 二' });
      });
      const secondFeatureId = (
        session.database.prepare('SELECT id FROM features WHERE id <> ?').get(first.featureId) as { id: string }
      ).id;
      session.database
        .prepare('INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, acceptance, execution_config, config_source) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)')
        .run('t-z', NOW_MS, projectA.id, NOW_MS, secondFeatureId, '外部任务', '{"criteria":["x"]}', '{}', 'project_default');
      const db = session.database;
      const edgeCount = () => (db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number }).n;

      // 跨 Feature 依赖：边声明 feature1 但 depends_on 属 feature2。
      expect(() =>
        db.prepare('INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, NOW_MS, projectA.id, first.featureId, 't-a', 't-z'),
      ).toThrow(/FOREIGN KEY|constraint/i);
      // 跨 Feature 依赖：task_id 本身不属于声明的 Feature。
      expect(() =>
        db.prepare('INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, NOW_MS, projectA.id, first.featureId, 't-z', 't-b'),
      ).toThrow(/FOREIGN KEY|constraint/i);
      // 自依赖：CHECK(task_id <> depends_on_id)。
      expect(() =>
        db.prepare('INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, NOW_MS, projectA.id, first.featureId, 't-a', 't-a'),
      ).toThrow(/CHECK|constraint/i);
      // 合法边先落一条，再验证重复边被唯一索引拒绝。
      db.prepare('INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, NOW_MS, projectA.id, first.featureId, 't-b', 't-a');
      expect(edgeCount()).toBe(1);
      expect(() =>
        db.prepare('INSERT INTO task_dependencies (id, created_at, revision, updated_at, project_id, feature_id, task_id, depends_on_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, NOW_MS, projectA.id, first.featureId, 't-b', 't-a'),
      ).toThrow(/UNIQUE|constraint/i);
      // 重复身份：phases 主键冲突。
      const existingPhase = (db.prepare('SELECT id, created_at, project_id, updated_at, title FROM phases LIMIT 1').get() as { id: string; created_at: number; project_id: string; updated_at: number; title: string });
      expect(() =>
        db.prepare('INSERT INTO phases (id, created_at, project_id, updated_at, title) VALUES (?, ?, ?, ?, ?)').run(existingPhase.id, NOW_MS, projectA.id, NOW_MS, '重复阶段'),
      ).toThrow(/UNIQUE|constraint/i);
      expect(edgeCount()).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM phases').get()).toEqual({ n: 1 });
    });
  });

  it('非法状态与非法 JSON 由枚举/JSON CHECK 拒绝，行数不变', async () => {
    await withPlanHarness(async ({ session, atomic, projectA }) => {
      const { featureId } = await seedStructure(atomic, projectA.id);
      const db = session.database;
      const phaseId = (db.prepare('SELECT id FROM phases').get() as { id: string }).id;

      const insertPhase = (status: string, labels: string) =>
        db.prepare('INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, projectA.id, NOW_MS, '状态探测', status, labels);
      // 非法状态。
      expect(() => insertPhase('bogus', '[]')).toThrow(/CHECK|constraint/i);
      // 非法 JSON：labels 不是数组。
      expect(() => insertPhase('open', '{"not":"array"}')).toThrow(/CHECK|constraint/i);
      expect(() => insertPhase('open', 'not-json')).toThrow(/CHECK|constraint/i);

      const insertFeature = (status: string, planStatus: string, sourceRefs: string) =>
        db.prepare('INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, source_refs) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, projectA.id, NOW_MS, phaseId, '状态探测', status, planStatus, sourceRefs);
      expect(() => insertFeature('bogus', 'draft', '[]')).toThrow(/CHECK|constraint/i);
      expect(() => insertFeature('draft', 'bogus', '[]')).toThrow(/CHECK|constraint/i);
      expect(() => insertFeature('draft', 'draft', 'not-json')).toThrow(/CHECK|constraint/i);
      // plan_digest 形态：非 64 位小写 hex 拒绝。
      expect(() =>
        db.prepare('INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, plan_digest) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, projectA.id, NOW_MS, phaseId, '摘要探测', 'ZZZ'),
      ).toThrow(/CHECK|constraint/i);

      const insertTask = (column: string, value: string) =>
        db.prepare(`INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, ${column}, execution_config, config_source) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), NOW_MS, projectA.id, NOW_MS, featureId, 'JSON 探测', value, '{}', 'project_default');
      expect(() => insertTask('status', 'bogus')).toThrow(/CHECK|constraint/i);
      expect(() => insertTask('complexity', 'extreme')).toThrow(/CHECK|constraint/i);
      expect(() => insertTask('labels', '"text"')).toThrow(/CHECK|constraint/i);
      expect(() => insertTask('acceptance', '[]')).toThrow(/CHECK|constraint/i);
      expect(() => insertTask('requirements_refs', '{}')).toThrow(/CHECK|constraint/i);
      expect(() => insertTask('execution_config', '"text"')).toThrow(/CHECK|constraint/i);
      expect(() =>
        db.prepare('INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, acceptance, execution_config, config_source) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(randomUUID(), NOW_MS, projectA.id, NOW_MS, featureId, '空来源', '{"criteria":["x"]}', '{}', ''),
      ).toThrow(/CHECK|constraint/i);

      expect(db.prepare('SELECT COUNT(*) AS n FROM phases').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM features').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 3 });
    });
  });
});

/* ------------------------------------------------------------------ *
 * CommandTransaction 窄存储原语：原子使用、规范与持久化
 * ------------------------------------------------------------------ */

describe('F-002 CommandTransaction 计划结构原语', () => {
  it('insertPhase/insertFeature/insertTask 保存完整字段，合法依赖边可插入，重开后持久值一致', async () => {
    const sandbox = createTempSandbox('shiploop-p03-1-f002-primitives-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const { session, tick } = openSession(dbPath);
      const saved: { phaseId: string; featureId: string } = { phaseId: '', featureId: '' };
      try {
        await migrateSqliteStorage(session, { nowUtcMs: tick });
        const state = createSqliteStateStore(session, { nowUtcMs: tick });
        const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: tick });
        const project = await state.createProject({ displayName: '原语项目', labels: ['proj-label'] });
        atomic.transact('test.primitives', (tx) => {
          const phase = tx.insertPhase({ projectId: project.id, title: '阶段标题', labels: ['phase-label'] });
          expect(phase).toMatchObject({
            projectId: project.id,
            title: '阶段标题',
            labels: ['phase-label'],
            status: 'open',
            revision: 1,
          });
          expect(phase.createdAtUtcMs).toBeGreaterThanOrEqual(NOW_MS);
          expect(phase.updatedAtUtcMs).toBe(phase.createdAtUtcMs);
          saved.phaseId = phase.id;

          const feature = tx.insertFeature({
            projectId: project.id,
            phaseId: phase.id,
            title: 'Feature 标题',
            planDigest: VALID_SHA256,
            sourceRefs: [{ artifactId: 'art-src', contentHash: VALID_SHA256 }],
          });
          // 标签默认空数组且不继承父级（Phase 有标签、Feature/Task 无）。
          expect(feature).toMatchObject({
            projectId: project.id,
            phaseId: phase.id,
            status: 'draft',
            planStatus: 'draft',
            planDigest: VALID_SHA256,
            labels: [],
            sourceRefs: [{ artifactId: 'art-src', contentHash: VALID_SHA256 }],
            revision: 1,
          });
          saved.featureId = feature.id;

          for (const [id, complexity] of [
            ['t-save-1', 'high'],
            ['t-save-2', null],
          ] as const) {
            const task = tx.insertTask({
              projectId: project.id,
              featureId: feature.id,
              id,
              title: `任务 ${id}`,
              complexity,
              acceptance: { criteria: [`${id} 验收一`, `${id} 验收二`] },
              requirementsRefs: id === 't-save-1' ? [{ artifactId: 'art-req' }] : undefined,
              executionConfig: { schemaVersion: 2, strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
              configSource: 'user_override',
              configSourceKey: 'modelMap.high',
            });
            expect(task).toMatchObject({
              id,
              featureId: feature.id,
              status: 'pending',
              complexity,
              revision: 1,
              configSource: 'user_override',
              configSourceKey: 'modelMap.high',
            });
            expect(task.labels).toEqual([]);
            expect(task.requirementsRefs).toEqual(id === 't-save-1' ? [{ artifactId: 'art-req' }] : []);
          }
          const edge = tx.insertTaskDependency({
            projectId: project.id,
            featureId: feature.id,
            taskId: 't-save-2',
            dependsOnId: 't-save-1',
          });
          expect(edge).toMatchObject({
            projectId: project.id,
            featureId: feature.id,
            taskId: 't-save-2',
            dependsOnId: 't-save-1',
          });
          expect(edge.createdAtUtcMs).toBeGreaterThanOrEqual(NOW_MS);
        });
      } finally {
        session.close();
      }
      // 重开数据库后逐字段核对持久值（UTC 毫秒、revision=1、JSON 列原文）。
      const reopened = openSqliteStorageSession({ path: dbPath });
      try {
        const phaseRow = reopened.database
          .prepare('SELECT id, project_id, revision, title, status, description, labels FROM phases WHERE id = ?')
          .get(saved.phaseId) as Record<string, unknown>;
        expect(phaseRow).toMatchObject({
          project_id: expect.any(String),
          revision: 1,
          title: '阶段标题',
          status: 'open',
          description: null,
          labels: '["phase-label"]',
        });
        const featureRow = reopened.database
          .prepare('SELECT project_id, phase_id, revision, title, status, plan_status, plan_digest, labels, source_refs FROM features WHERE id = ?')
          .get(saved.featureId) as Record<string, unknown>;
        expect(featureRow).toMatchObject({
          revision: 1,
          title: 'Feature 标题',
          status: 'draft',
          plan_status: 'draft',
          plan_digest: VALID_SHA256,
          labels: '[]',
          source_refs: '[{"artifactId":"art-src","contentHash":"' + VALID_SHA256 + '"}]',
        });
        const taskRows = reopened.database
          .prepare('SELECT id, revision, title, status, complexity, acceptance, requirements_refs, execution_config, config_source, config_source_key FROM tasks ORDER BY id')
          .all() as Record<string, unknown>[];
        expect(taskRows).toHaveLength(2);
        expect(taskRows[0]).toMatchObject({
          id: 't-save-1',
          revision: 1,
          status: 'pending',
          complexity: 'high',
          acceptance: '{"criteria":["t-save-1 验收一","t-save-1 验收二"]}',
          requirements_refs: '[{"artifactId":"art-req"}]',
          config_source: 'user_override',
          config_source_key: 'modelMap.high',
        });
        expect(taskRows[1]).toMatchObject({ id: 't-save-2', complexity: null, requirements_refs: '[]' });
        const edgeRow = reopened.database
          .prepare('SELECT task_id, depends_on_id FROM task_dependencies')
          .get() as Record<string, unknown>;
        expect(edgeRow).toEqual({ task_id: 't-save-2', depends_on_id: 't-save-1' });
      } finally {
        reopened.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('端口层负例：自依赖/跨 Feature/缺失或跨项目父级/重复身份与边/环均结构化拒绝且零残留', async () => {
    await withPlanHarness(async ({ session, atomic, projectA, projectB }) => {
      const first = await seedStructure(atomic, projectA.id);
      const db = session.database;
      const counts = () => ({
        phases: (db.prepare('SELECT COUNT(*) AS n FROM phases').get() as { n: number }).n,
        features: (db.prepare('SELECT COUNT(*) AS n FROM features').get() as { n: number }).n,
        tasks: (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
        edges: (db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get() as { n: number }).n,
      });
      const before = counts();

      const expectRejected = (
        run: (tx: CommandTransaction) => void,
        kind: StorageError['kind'],
        detail?: (error: StorageError) => void,
      ): void => {
        let caught: unknown;
        try {
          atomic.transact('test.negative', run);
        } catch (error) {
          caught = error;
        }
        expect(isStorageError(caught), `实际 ${String(caught)}`).toBe(true);
        const storageError = caught as StorageError;
        expect(storageError.kind, `kind 实际 ${storageError.kind}`).toBe(kind);
        detail?.(storageError);
      };

      // 不存在项目 → not_found；跨项目 Phase → ownership。
      expectRejected((tx) => tx.insertPhase({ projectId: MISSING_ID, title: '孤儿' }), 'not_found');
      expectRejected(
        (tx) => tx.insertFeature({ projectId: projectB.id, phaseId: first.phaseId, title: '跨项目' }),
        'ownership',
      );
      // 不存在 Phase → not_found；缺失 planDigest 形态非法 → validation。
      expectRejected(
        (tx) => tx.insertFeature({ projectId: projectA.id, phaseId: MISSING_ID, title: '缺失阶段' }),
        'not_found',
      );
      expectRejected(
        (tx) => tx.insertFeature({ projectId: projectA.id, phaseId: first.phaseId, title: '坏摘要', planDigest: 'zz' }),
        'validation',
      );
      // 重复任务身份 → conflict；跨项目 Feature → ownership；缺失 Feature → not_found。
      expectRejected(
        (tx) =>
          tx.insertTask({
            projectId: projectA.id,
            featureId: first.featureId,
            id: 't-a',
            title: '重复任务',
            acceptance: { criteria: ['x'] },
            executionConfig: {},
            configSource: 'project_default',
          }),
        'conflict',
      );
      expectRejected(
        (tx) =>
          tx.insertTask({
            projectId: projectB.id,
            featureId: first.featureId,
            id: 't-cross',
            title: '跨项目任务',
            acceptance: { criteria: ['x'] },
            executionConfig: {},
            configSource: 'project_default',
          }),
        'ownership',
      );
      expectRejected(
        (tx) =>
          tx.insertTask({
            projectId: projectA.id,
            featureId: MISSING_ID,
            id: 't-orphan',
            title: '孤儿任务',
            acceptance: { criteria: ['x'] },
            executionConfig: {},
            configSource: 'project_default',
          }),
        'not_found',
      );
      // executionConfig 非普通对象 → validation。
      expectRejected(
        (tx) =>
          tx.insertTask({
            projectId: projectA.id,
            featureId: first.featureId,
            id: 't-bad-cfg',
            title: '坏配置',
            acceptance: { criteria: ['x'] },
            executionConfig: 'not-object',
            configSource: 'project_default',
          }),
        'validation',
      );

      // 自依赖 → validation（节点定位）。
      expectRejected(
        (tx) => tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-a', dependsOnId: 't-a' }),
        'validation',
        (error) => {
          expect(error.details).toMatchObject({ taskId: 't-a', dependsOnTaskId: 't-a' });
        },
      );
      // 缺失任务 → not_found；跨 Feature 依赖 → ownership。
      expectRejected(
        (tx) => tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-a', dependsOnId: MISSING_ID }),
        'not_found',
      );
      expectRejected(
        (tx) => tx.insertTaskDependency({ projectId: projectB.id, featureId: first.featureId, taskId: 't-a', dependsOnId: 't-b' }),
        'ownership',
      );
      // 合法边 a→b、b→c；重复边与环被应用层拒绝。
      atomic.transact('test.edges', (tx) => {
        tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-b', dependsOnId: 't-a' });
        tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-c', dependsOnId: 't-b' });
      });
      expectRejected(
        (tx) => tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-b', dependsOnId: 't-a' }),
        'conflict',
      );
      expectRejected(
        (tx) => tx.insertTaskDependency({ projectId: projectA.id, featureId: first.featureId, taskId: 't-a', dependsOnId: 't-c' }),
        'validation',
        (error) => {
          expect(Array.isArray(error.details?.cycle)).toBe(true);
        },
      );
      // 全部失败样例零残留（只保留 seedStructure 与两条合法边）。
      expect(counts()).toEqual({ ...before, edges: before.edges + 2 });
    });
  });

  it('事务内后续原语失败时整组回滚，无半条记录', async () => {
    await withPlanHarness(async ({ session, atomic, projectA }) => {
      let caught: unknown;
      try {
        atomic.transact('test.rollback', (tx) => {
          tx.insertPhase({ projectId: projectA.id, title: '待回滚阶段' });
          tx.insertPhase({ projectId: MISSING_ID, title: '触发失败' });
        });
      } catch (error) {
        caught = error;
      }
      expect(isStorageError(caught, 'not_found'), `实际 ${String(caught)}`).toBe(true);
      expect(session.database.prepare('SELECT COUNT(*) AS n FROM phases').get()).toEqual({ n: 0 });
    });
  });
});
