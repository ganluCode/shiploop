/**
 * F-005 迁移执行、高版本拒写、失败回滚证据与一致性备份回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-005 验收点，全部为真实断言）：
 * - 空库迁移后 schema_migrations 记录版本/checksum/应用时间（注入时钟核对）；
 *   再次启动不重复应用；由真实 v1 库升级后既有项目/配置内容逐字段保留；
 * - 版本与 checksum 核验在任何写入前完成：人工构造的高于支持版本库、checksum
 *   不匹配、应用记录缺口及非法迁移清单均明确拒写，实际行、版本与 Schema 不被修改；
 * - 注入 DDL/数据错误的迁移失败时其变更与记录全部回滚，错误携带版本/步骤/备份证据；
 *   修复后重开可从一致的原版本继续迁移，不伪装初始化成功；
 * - 已有库升级前经 better-sqlite3 backup API 生成独立一致性备份并运行 integrity_check；
 *   备份失败（目录不存在、目标已存在）则不开始迁移；恢复演练从备份读到升级前一致数据；
 * - 恢复不自动覆盖用户新数据：备份与失败证据保留；本 Feature 不实现 Host 停机升级、
 *   自动降级或桌面打包。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import {
  SqliteMigrationError,
  migrateSqliteStorage,
} from '../packages/core/src/adapters/sqlite/migrator.ts';
import {
  openSqliteStorageSession,
  type SqliteStorageSession,
} from '../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const FIXED_NOW_MS = 1_700_000_777_000;
const VALID_SHA256 = 'ab'.repeat(32);
const OTHER_SHA256 = 'cd'.repeat(32);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 良性升级探针迁移：接在真实迁移之后新增一张探针表，用于升级/备份路径测试。 */
const PROBE_SQL = 'CREATE TABLE f5_upgrade_probe (id TEXT PRIMARY KEY NOT NULL);';
const PROBE_MIGRATION = {
  version: SQLITE_MIGRATIONS.length + 1,
  sql: PROBE_SQL,
  checksum: sha256Hex(PROBE_SQL),
} as const;

/** 注入 DDL 错误的第二版迁移：首条语句成功后触发语法错误。 */
const V2_BAD_DDL_SQL =
  'CREATE TABLE f5_bad_ddl (id TEXT PRIMARY KEY NOT NULL); THIS IS NOT VALID SQL;';
const V2_BAD_DDL = { version: 2, sql: V2_BAD_DDL_SQL, checksum: sha256Hex(V2_BAD_DDL_SQL) } as const;

/** 注入数据约束错误的第二版迁移：建表成功后写入违反 CHECK 的行。 */
const V2_BAD_DATA_SQL =
  'CREATE TABLE f5_bad_data (id TEXT PRIMARY KEY NOT NULL); ' +
  "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) " +
  "VALUES ('bad', 1, 0, 1, 'x', 'active', '[]');";
const V2_BAD_DATA = {
  version: 2,
  sql: V2_BAD_DATA_SQL,
  checksum: sha256Hex(V2_BAD_DATA_SQL),
} as const;

const BASE_MIGRATIONS = [...SQLITE_MIGRATIONS, PROBE_MIGRATION];

/** 异步临时沙箱：withTempSandbox 不等待 Promise，本 helper 用 try/finally 保证清理。 */
async function withSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const sandbox = createTempSandbox('shiploop-f005-');
  try {
    return await fn(sandbox.path);
  } finally {
    sandbox.cleanup();
  }
}

function listUserTables(session: SqliteStorageSession): string[] {
  const rows = session.database
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

interface MigrationRow {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly applied_at: number;
}

function migrationRows(session: SqliteStorageSession): MigrationRow[] {
  return session.database
    .prepare<[], MigrationRow>(
      'SELECT id, version, checksum, applied_at FROM schema_migrations ORDER BY version',
    )
    .all();
}

const SEED_PROJECT = {
  id: 'proj-seed-01',
  createdAt: 1_700_000_000_000,
  displayName: '种子项目 α',
  description: '升级前已有的项目（多字节）',
};
const SEED_SETTINGS_PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  strategies: [{ runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' }],
});

/** 在已迁移到 v1 的库中写入一个真实项目与全局配置（升级前数据）。 */
function seedV1Data(session: SqliteStorageSession): void {
  session.transactWrite('fixture.seed', (db) => {
    db.prepare(
      'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) ' +
        "VALUES (?, ?, 1, ?, ?, 'active', ?, ?)",
    ).run(
      SEED_PROJECT.id,
      SEED_PROJECT.createdAt,
      SEED_PROJECT.createdAt,
      SEED_PROJECT.displayName,
      SEED_PROJECT.description,
      JSON.stringify(['alpha', '中文标签']),
    );
    db.prepare(
      'INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) ' +
        "VALUES ('global', ?, 1, ?, 1, ?)",
    ).run(SEED_PROJECT.createdAt, SEED_PROJECT.createdAt, SEED_SETTINGS_PAYLOAD);
  });
}

interface ProjectRow {
  readonly id: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly labels: string;
  readonly revision: number;
}

function projectRows(session: SqliteStorageSession): ProjectRow[] {
  return session.database
    .prepare<[], ProjectRow>(
      'SELECT id, display_name, description, labels, revision FROM projects ORDER BY id',
    )
    .all();
}

function globalSettingsPayload(session: SqliteStorageSession): string | undefined {
  const row = session.database
    .prepare<[], { payload: string }>("SELECT payload FROM global_settings WHERE id = 'global'")
    .get();
  return row?.payload;
}

/** 迁移到 v1 并写入种子数据的真实“上一支持版本”库，返回数据库文件路径。 */
async function createSeededV1Database(root: string): Promise<string> {
  const path = join(root, 'state.db');
  const session = openSqliteStorageSession({ path });
  try {
    await migrateSqliteStorage(session, {
      migrations: [SQLITE_MIGRATIONS[0]!],
      nowUtcMs: () => FIXED_NOW_MS,
    });
    seedV1Data(session);
  } finally {
    session.close();
  }
  return path;
}

describe('F-005 迁移执行与记录', () => {
  it('空库迁移：记录版本/checksum/应用时间，建立全部表，不产生备份', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        const result = await migrateSqliteStorage(session, { nowUtcMs: () => FIXED_NOW_MS });
        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(SQLITE_MIGRATIONS.length);
        expect(result.appliedVersions).toEqual(SQLITE_MIGRATIONS.map((migration) => migration.version));
        expect(result.backupPath).toBeUndefined();

        const rows = migrationRows(session);
        expect(rows).toHaveLength(SQLITE_MIGRATIONS.length);
        expect(rows.map((row) => row.version)).toEqual(SQLITE_MIGRATIONS.map((m) => m.version));
        expect(rows[0]!.checksum).toBe(SQLITE_MIGRATIONS[0]!.checksum);
        expect(rows[0]!.applied_at).toBe(FIXED_NOW_MS);

        expect(listUserTables(session)).toEqual([
          'artifacts',
          'global_settings',
          'project_settings',
          'projects',
          'repository_bindings',
          'schema_migrations',
          'state_events',
        ]);
      } finally {
        session.close();
      }
    });
  });

  it('再次启动不重复应用：记录条数与应用时间不变', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        await migrateSqliteStorage(session, { nowUtcMs: () => FIXED_NOW_MS });
        const later = FIXED_NOW_MS + 60_000;
        const second = await migrateSqliteStorage(session, { nowUtcMs: () => later });
        expect(second.fromVersion).toBe(SQLITE_MIGRATIONS.length);
        expect(second.toVersion).toBe(SQLITE_MIGRATIONS.length);
        expect(second.appliedVersions).toEqual([]);
        const rows = migrationRows(session);
        expect(rows).toHaveLength(SQLITE_MIGRATIONS.length);
        expect(rows[0]!.applied_at).toBe(FIXED_NOW_MS);
      } finally {
        session.close();
      }
    });
  });

  it('v1 库升级到最新版本：既有项目/配置逐字段保留，迁移增量与记录一致', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const backupPath = join(root, 'backups', 'pre-upgrade.db');
      mkdirSync(join(root, 'backups'));

      const session = openSqliteStorageSession({ path });
      try {
        const before = {
          projects: projectRows(session),
          payload: globalSettingsPayload(session),
        };
        const result = await migrateSqliteStorage(session, {
          migrations: BASE_MIGRATIONS,
          backupPath,
          nowUtcMs: () => FIXED_NOW_MS + 1_000,
        });
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(BASE_MIGRATIONS.length);
        expect(result.appliedVersions).toEqual(BASE_MIGRATIONS.slice(1).map((m) => m.version));
        expect(result.backupPath).toBe(backupPath);

        expect(listUserTables(session)).toContain('f5_upgrade_probe');
        expect(listUserTables(session)).toContain('state_events');
        // 既有数据逐字段保留（中文多字节、labels JSON、配置 payload）。
        expect(projectRows(session)).toEqual(before.projects);
        expect(globalSettingsPayload(session)).toBe(before.payload);

        const rows = migrationRows(session);
        expect(rows).toHaveLength(BASE_MIGRATIONS.length);
        expect(rows[0]!.version).toBe(1);
        expect(rows[0]!.checksum).toBe(SQLITE_MIGRATIONS[0]!.checksum);
        expect(rows[0]!.applied_at).toBe(FIXED_NOW_MS);
        expect(rows[1]!.version).toBe(2);
        expect(rows[1]!.checksum).toBe(SQLITE_MIGRATIONS[1]!.checksum);
        expect(rows[2]!.version).toBe(PROBE_MIGRATION.version);
        expect(rows[2]!.checksum).toBe(PROBE_MIGRATION.checksum);
        expect(rows[2]!.applied_at).toBe(FIXED_NOW_MS + 1_000);
      } finally {
        session.close();
      }
    });
  });
});

describe('F-005 拒写：版本与 checksum 核验先于任何写入', () => {
  it('高于支持版本的库明确拒写，行/版本/Schema 均未被修改', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      // 人工构造更高版本记录（checksum 格式合法但超出支持范围）。
      const raw = new Database(path);
      raw
        .prepare(
          'INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('migration-v99', FIXED_NOW_MS, 99, VALID_SHA256, FIXED_NOW_MS);
      raw.close();

      const session = openSqliteStorageSession({ path });
      try {
        const tablesBefore = listUserTables(session);
        const migrationsBefore = migrationRows(session);
        const projectsBefore = projectRows(session);

        let caught: unknown;
        try {
          await migrateSqliteStorage(session);
        } catch (error) {
          caught = error;
        }
        expect(isStorageError(caught, 'unsupported_version')).toBe(true);
        const error = caught as { operation: string; details?: Record<string, unknown> };
        expect(error.operation).toBe('storage.migrate');
        expect(error.details).toMatchObject({ appliedVersion: 99, supportedVersion: SQLITE_MIGRATIONS.length });
        expect((caught as Error).message).not.toContain(path);

        expect(listUserTables(session)).toEqual(tablesBefore);
        expect(migrationRows(session)).toEqual(migrationsBefore);
        expect(projectRows(session)).toEqual(projectsBefore);
      } finally {
        session.close();
      }
    });
  });

  it('已应用 checksum 不匹配明确拒写，不做任何修改', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const raw = new Database(path);
      raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(OTHER_SHA256);
      raw.close();

      const session = openSqliteStorageSession({ path });
      try {
        const migrationsBefore = migrationRows(session);
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: BASE_MIGRATIONS });
        } catch (error) {
          caught = error;
        }
        expect(isStorageError(caught, 'corrupt')).toBe(true);
        expect((caught as { details?: Record<string, unknown> }).details).toMatchObject({
          version: 1,
        });
        expect(migrationRows(session)).toEqual(migrationsBefore);
        expect(listUserTables(session)).not.toContain('f5_upgrade_probe');
      } finally {
        session.close();
      }
    });
  });

  it('应用记录存在版本缺口（非法迁移序列）明确拒写', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const raw = new Database(path);
      raw
        .prepare(
          'INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('migration-v3', FIXED_NOW_MS, 3, VALID_SHA256, FIXED_NOW_MS);
      raw.close();

      const session = openSqliteStorageSession({ path });
      try {
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: BASE_MIGRATIONS });
        } catch (error) {
          caught = error;
        }
        // 版本 3 高于支持范围；序列核验在写入前完成，内容不被修改。
        expect(isStorageError(caught)).toBe(true);
        expect(['unsupported_version', 'corrupt']).toContain(
          (caught as { kind: string }).kind,
        );
        expect(migrationRows(session).map((row) => row.version)).toEqual([1, 3]);
        expect(listUserTables(session)).not.toContain('f5_upgrade_probe');
      } finally {
        session.close();
      }
    });
  });

  it('提供的迁移清单非法（checksum 与 SQL 内容不符/序列断裂）在触碰数据库前拒绝', async () => {
    await withSandbox(async (root) => {
      const path = join(root, 'state.db');
      const session = openSqliteStorageSession({ path });
      try {
        const tampered = [
          { version: 1, sql: SQLITE_MIGRATIONS[0]!.sql, checksum: OTHER_SHA256 },
        ];
        await expect(
          migrateSqliteStorage(session, { migrations: tampered }),
        ).rejects.toMatchObject({ kind: 'validation' });

        const gapped = [
          SQLITE_MIGRATIONS[0]!,
          { version: 3, sql: PROBE_SQL, checksum: sha256Hex(PROBE_SQL) },
        ];
        await expect(
          migrateSqliteStorage(session, { migrations: gapped }),
        ).rejects.toMatchObject({ kind: 'validation' });

        // 清单校验失败发生在任何 DDL 之前：库仍为空。
        expect(listUserTables(session)).toEqual([]);
      } finally {
        session.close();
      }
    });
  });

  it('存在用户表但无迁移记录的未知库拒绝初始化，已有内容不被清除', async () => {
    await withSandbox(async (root) => {
      const path = join(root, 'state.db');
      const raw = new Database(path);
      raw.exec("CREATE TABLE foreign_data (id TEXT PRIMARY KEY NOT NULL); INSERT INTO foreign_data VALUES ('keep-me')");
      raw.close();

      const session = openSqliteStorageSession({ path });
      try {
        let caught: unknown;
        try {
          await migrateSqliteStorage(session);
        } catch (error) {
          caught = error;
        }
        expect(isStorageError(caught, 'corrupt')).toBe(true);
        expect(listUserTables(session)).toEqual(['foreign_data']);
        const kept = session.database
          .prepare<[], { id: string }>('SELECT id FROM foreign_data')
          .all();
        expect(kept).toEqual([{ id: 'keep-me' }]);
      } finally {
        session.close();
      }
    });
  });

  it('已关闭的会话拒绝迁移并报明确错误', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      session.close();
      await expect(migrateSqliteStorage(session)).rejects.toThrow(/已关闭/);
    });
  });
});

describe('F-005 失败迁移回滚与证据', () => {
  it('注入 DDL 错误：失败迁移的变更与记录全部回滚，修复后可从一致 v1 继续', async () => {
    await withSandbox(async (root) => {
      const path = join(root, 'state.db');
      const session = openSqliteStorageSession({ path });
      try {
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, {
            migrations: [SQLITE_MIGRATIONS[0]!, V2_BAD_DDL],
            nowUtcMs: () => FIXED_NOW_MS,
          });
        } catch (error) {
          caught = error;
        }
        // 失败证据：步骤、版本，入口不伪装初始化成功。
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        const failure = caught as SqliteMigrationError;
        expect(failure.step).toBe('apply');
        expect(failure.version).toBe(2);
        expect(failure.message).not.toContain(path);

        // v1 已提交且一致；bad v2 的 DDL 片段与记录全部回滚。
        expect(migrationRows(session).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(session)).not.toContain('f5_bad_ddl');
        expect(listUserTables(session)).toContain('projects');
      } finally {
        session.close();
      }

      // 修复后重开：从一致的原版本（v1）继续，真实 v2 与探针 v3 正常应用。
      const reopened = openSqliteStorageSession({ path });
      try {
        const result = await migrateSqliteStorage(reopened, {
          migrations: BASE_MIGRATIONS,
          nowUtcMs: () => FIXED_NOW_MS + 5_000,
        });
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(BASE_MIGRATIONS.length);
        expect(migrationRows(reopened).map((row) => row.version)).toEqual(
          BASE_MIGRATIONS.map((migration) => migration.version),
        );
        expect(listUserTables(reopened)).toContain('f5_upgrade_probe');
        expect(listUserTables(reopened)).toContain('state_events');
      } finally {
        reopened.close();
      }
    });
  });

  it('注入数据约束错误：同一事务内全部变更回滚，无半条记录', async () => {
    await withSandbox(async (root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, {
            migrations: [SQLITE_MIGRATIONS[0]!, V2_BAD_DATA],
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        expect((caught as SqliteMigrationError).step).toBe('apply');
        expect((caught as SqliteMigrationError).version).toBe(2);
        expect(migrationRows(session).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(session)).not.toContain('f5_bad_data');
        expect(projectRows(session)).toEqual([]);
      } finally {
        session.close();
      }
    });
  });

  it('升级失败保留备份与原始数据证据，修复重开后升级成功且不伪装', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      mkdirSync(join(root, 'backups'));
      const backupPath = join(root, 'backups', 'attempt-1.db');

      const session = openSqliteStorageSession({ path });
      try {
        const projectsBefore = projectRows(session);
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, {
            migrations: [SQLITE_MIGRATIONS[0]!, V2_BAD_DATA],
            backupPath,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        const failure = caught as SqliteMigrationError;
        expect(failure.step).toBe('apply');
        expect(failure.version).toBe(2);
        // 备份证据保留（不删除），原库数据不变、无 v2 残留。
        expect(failure.backupPath).toBe(backupPath);
        expect(existsSync(backupPath)).toBe(true);
        expect(projectRows(session)).toEqual(projectsBefore);
        expect(migrationRows(session).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(session)).not.toContain('f5_bad_data');
      } finally {
        session.close();
      }

      // 修复后重开：使用新的备份位置（不覆盖旧证据）完成升级。
      const backupPath2 = join(root, 'backups', 'attempt-2.db');
      const reopened = openSqliteStorageSession({ path });
      try {
        const result = await migrateSqliteStorage(reopened, {
          migrations: BASE_MIGRATIONS,
          backupPath: backupPath2,
        });
        expect(result.toVersion).toBe(BASE_MIGRATIONS.length);
        expect(existsSync(backupPath)).toBe(true);
        expect(existsSync(backupPath2)).toBe(true);
        expect(projectRows(reopened)).toHaveLength(1);
      } finally {
        reopened.close();
      }
    });
  });
});

describe('F-005 一致性备份与恢复演练', () => {
  it('备份经 backup API 生成且 integrity_check 通过；恢复演练读到升级前一致数据', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      mkdirSync(join(root, 'backups'));
      const backupPath = join(root, 'backups', 'pre-upgrade.db');

      const session = openSqliteStorageSession({ path });
      try {
        const result = await migrateSqliteStorage(session, {
          migrations: BASE_MIGRATIONS,
          backupPath,
        });
        expect(result.backupPath).toBe(backupPath);
      } finally {
        session.close();
      }
      expect(existsSync(backupPath)).toBe(true);

      // 独立核验备份完整性（迁移器已内部核验一次，这里由测试再交叉核对）。
      const backupCheck = new Database(backupPath, { readonly: true, fileMustExist: true });
      expect(backupCheck.pragma('integrity_check', { simple: true })).toBe('ok');
      backupCheck.close();

      // 恢复演练：把备份复制为独立库打开（不是复制正在使用的 db+WAL 冒充备份），
      // 读到升级前一致数据：项目/配置逐字段一致，且只含 v1 迁移记录。
      const restoredPath = join(root, 'restored.db');
      copyFileSync(backupPath, restoredPath);
      const restored = openSqliteStorageSession({ path: restoredPath });
      try {
        expect(projectRows(restored)).toEqual([
          {
            id: SEED_PROJECT.id,
            display_name: SEED_PROJECT.displayName,
            description: SEED_PROJECT.description,
            labels: JSON.stringify(['alpha', '中文标签']),
            revision: 1,
          },
        ]);
        expect(globalSettingsPayload(restored)).toBe(SEED_SETTINGS_PAYLOAD);
        expect(migrationRows(restored).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(restored)).not.toContain('f5_upgrade_probe');
      } finally {
        restored.close();
      }
    });
  });

  it('备份目录不存在时备份失败且不开始迁移', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const backupPath = join(root, 'no-such-dir', 'backup.db');

      const session = openSqliteStorageSession({ path });
      try {
        const projectsBefore = projectRows(session);
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: BASE_MIGRATIONS, backupPath });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        expect((caught as SqliteMigrationError).step).toBe('backup');
        expect((caught as SqliteMigrationError).backupPath).toBe(backupPath);
        // 迁移未开始：无 v2 记录、无探针表、数据不变。
        expect(migrationRows(session).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(session)).not.toContain('f5_upgrade_probe');
        expect(projectRows(session)).toEqual(projectsBefore);
      } finally {
        session.close();
      }
    });
  });

  it('备份目标已存在时拒绝覆盖且不开始迁移，已有文件内容保持不变', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const backupPath = join(root, 'existing-backup.db');
      writeFileSync(backupPath, 'sentinel-previous-backup', 'utf8');

      const session = openSqliteStorageSession({ path });
      try {
        let caught: unknown;
        try {
          await migrateSqliteStorage(session, { migrations: BASE_MIGRATIONS, backupPath });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(SqliteMigrationError);
        expect((caught as SqliteMigrationError).step).toBe('backup');
        expect(readFileSync(backupPath, 'utf8')).toBe('sentinel-previous-backup');
        expect(migrationRows(session).map((row) => row.version)).toEqual([1]);
        expect(listUserTables(session)).not.toContain('f5_upgrade_probe');
      } finally {
        session.close();
      }
    });
  });

  it('默认派生备份位于数据库同目录（受控数据根），文件名含版本区间', async () => {
    await withSandbox(async (root) => {
      const path = await createSeededV1Database(root);
      const session = openSqliteStorageSession({ path });
      try {
        const result = await migrateSqliteStorage(session, {
          migrations: BASE_MIGRATIONS,
          nowUtcMs: () => FIXED_NOW_MS + 2_000,
        });
        expect(result.backupPath).toBeDefined();
        expect(result.backupPath!.startsWith(root)).toBe(true);
        expect(result.backupPath!).toMatch(new RegExp(`v1-to-v${BASE_MIGRATIONS.length}`));
        expect(existsSync(result.backupPath!)).toBe(true);
      } finally {
        session.close();
      }
    });
  });
});
