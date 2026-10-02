/**
 * F-003 Drizzle Schema 与可版本控制 SQLite 迁移回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-003 验收点，全部为真实断言）：
 * - 迁移描述符：唯一递增版本（自 1 起）、稳定 SHA-256 校验摘要（与 SQL 内容一致、
 *   可经 F-002 ports 契约 validateMigrationDescriptor 校验）；SQL 为自包含 DDL，
 *   不含文件系统路径、cwd 或源码位置，随构建产物（dist 内编译模块）可定位；
 * - 空临时库执行 v1 迁移后建立 projects、repository_bindings、global_settings、
 *   project_settings、artifacts、schema_migrations 六表，不生成 Phase/Feature/Task/
 *   Run/Attempt/Batch/Session/Chat 等后续表；v2 迁移（F-006）新增 state_events
 *   审计表；重复应用同一迁移真实失败；
 * - 实际表/列/索引与 Drizzle Schema 一致：列名/可空性/主键/默认值经 pragma table_info
 *   与 getTableColumns/getTableConfig 交叉核对；命名 CHECK 与索引（含 UNIQUE）经
 *   sqlite_master 与 pragma index_list/index_info 核对；外键目标与 ON DELETE RESTRICT
 *   经 pragma foreign_key_list 核对；
 * - 真实 SQL 失败样例：revision/版本/size 数值限制、状态枚举、JSON 合法性（含 labels
 *   数组类型）、摘要长度/小写 hex、全局单例 id=global、项目配置 UNIQUE(project_id)、
 *   仓库规范路径唯一、ready 必须带 hash/size、缺失项目外键失败、被引用行 RESTRICT 删除
 *   保护——每项都断言抛错且行数不变；关闭重开后 schema 与数据逐字段一致。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../packages/core/src/adapters/sqlite/schema.ts';
import { SQLITE_MIGRATIONS } from '../packages/core/src/adapters/sqlite/migrations.ts';
import { validateMigrationDescriptor } from '../packages/core/src/ports/migrations.ts';
import { openSqliteConnection } from '../packages/core/src/adapters/sqlite/connection.ts';
import { withTempSandbox } from './helpers/temp-sandbox.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type CoreConnection = ReturnType<typeof openSqliteConnection>;
type CoreDatabase = CoreConnection['database'];

/** Drizzle Schema 声明的全部表：名称必须与设计 11 §3/§8/§9 的逻辑表一致。 */
const SCHEMA_TABLES = [
  ['projects', schema.projects],
  ['repository_bindings', schema.repositoryBindings],
  ['global_settings', schema.globalSettings],
  ['project_settings', schema.projectSettings],
  ['artifacts', schema.artifacts],
  // F-006：状态事件审计切片（设计 11 §9）。
  ['state_events', schema.stateEvents],
  ['schema_migrations', schema.schemaMigrations],
] as const;

const EXPECTED_TABLE_NAMES = SCHEMA_TABLES.map(([name]) => name).sort();

/** 迁移与未来功能明确不在本 Feature 建立的后续表（设计 11 §4-§7、§9）。 */
const FORBIDDEN_TABLE_NAMES = [
  'phases',
  'features',
  'tasks',
  'feature_dependencies',
  'task_dependencies',
  'execution_batches',
  'batch_budget_revisions',
  'runs',
  'attempts',
  'workspace_leases',
  'sessions',
  'chat_turns',
  'session_messages',
  'recording_manifests',
  'verification_batches',
  'check_definitions',
  'check_results',
  'approvals',
  'command_receipts',
  'operations',
  'notification_channels',
  'notification_deliveries',
  'documents',
  'document_versions',
  'memory_records',
];

const VALID_SHA256 = 'ab'.repeat(32);
const OTHER_SHA256 = 'cd'.repeat(32);
const NOW_MS = 1_700_000_123_456;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 在独立临时沙箱中打开文件库并应用全部已声明迁移（真实 exec，非 mock）。 */
function withMigratedDatabase<T>(fn: (db: CoreDatabase, root: string) => T): T {
  return withTempSandbox(
    (root) => {
      const connection = openSqliteConnection(join(root, 'state.db'));
      try {
        const db = connection.database;
        db.exec('PRAGMA foreign_keys = ON');
        for (const migration of SQLITE_MIGRATIONS) {
          db.exec('BEGIN IMMEDIATE');
          try {
            db.exec(migration.sql);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
        return fn(db, root);
      } finally {
        connection.close();
      }
    },
    { prefix: 'shiploop-f003-' },
  );
}

function listUserTables(db: CoreDatabase): string[] {
  const rows = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

type TableInfoRow = {
  name: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function tableInfo(db: CoreDatabase, tableName: string): TableInfoRow[] {
  return db.prepare<[], TableInfoRow>(`PRAGMA table_info(${tableName})`).all();
}

function tableDdl(db: CoreDatabase, tableName: string): string {
  const row = db
    .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  expect(row, `${tableName} 的 DDL 必须存在于 sqlite_master`).toBeDefined();
  return String(row?.sql);
}

function countRows(db: CoreDatabase, tableName: string): number {
  const row = db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// 夹具级合法种子：真实 INSERT，供失败样例测试在其上注入非法记录。
// ---------------------------------------------------------------------------

function seedProject(db: CoreDatabase, id = 'proj-1'): void {
  db.prepare(
    'INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) ' +
      "VALUES (?, ?, 1, ?, '示例项目', 'active', NULL, '[]')",
  ).run(id, NOW_MS, NOW_MS);
}

function seedBinding(db: CoreDatabase, id = 'bind-1', projectId = 'proj-1', canonicalPath = '/repo/a'): void {
  db.prepare(
    'INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity) ' +
      "VALUES (?, ?, ?, 1, ?, ?, NULL, 'identity-1')",
  ).run(id, NOW_MS, projectId, NOW_MS, canonicalPath);
}

function seedGlobalSettings(db: CoreDatabase): void {
  db.prepare(
    'INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) ' +
      "VALUES ('global', ?, 1, ?, 1, ?)",
  ).run(NOW_MS, NOW_MS, JSON.stringify({ schemaVersion: 1, strategies: {} }));
}

function seedProjectSettings(db: CoreDatabase, projectId = 'proj-1', id = 'ps-1'): void {
  db.prepare(
    'INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) ' +
      'VALUES (?, ?, ?, 1, ?, 1, ?)',
  ).run(id, NOW_MS, projectId, NOW_MS, JSON.stringify({ schemaVersion: 1, strategies: {} }));
}

function seedArtifact(db: CoreDatabase, id = 'art-1', projectId = 'proj-1'): void {
  db.prepare(
    'INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, version, storage_locator) ' +
      "VALUES (?, ?, ?, 1, ?, 'report', 'pending', 'application/json', ?, 1, 'artifacts/a1/v1/report.json')",
  ).run(id, NOW_MS, projectId, NOW_MS, VALID_SHA256);
}

function seedStateEvent(
  db: CoreDatabase,
  id = 'ev-1',
  projectId: string | null = 'proj-1',
  aggregateType = 'project',
): void {
  db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
      'VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?, 1, ?, ?)',
  ).run(
    id,
    NOW_MS,
    NOW_MS,
    projectId,
    'project.metadata_updated',
    aggregateType,
    projectId ?? 'global',
    JSON.stringify({ changedFields: ['displayName'] }),
    NOW_MS,
  );
}

// ---------------------------------------------------------------------------
// 迁移描述符与自包含性
// ---------------------------------------------------------------------------

describe('F-003 versioned migration descriptors', () => {
  it('declares migrations with unique ascending versions starting at 1', () => {
    expect(SQLITE_MIGRATIONS.length).toBeGreaterThan(0);
    expect(SQLITE_MIGRATIONS[0]?.version).toBe(1);
    for (let index = 1; index < SQLITE_MIGRATIONS.length; index += 1) {
      const previous = SQLITE_MIGRATIONS[index - 1]?.version ?? 0;
      const current = SQLITE_MIGRATIONS[index]?.version ?? 0;
      expect(
        current,
        `迁移版本必须严格递增：第 ${index} 个为 ${current}，前一个为 ${previous}`,
      ).toBeGreaterThan(previous);
    }
  });

  it('derives a stable lowercase SHA-256 checksum from the migration SQL content', () => {
    for (const migration of SQLITE_MIGRATIONS) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.checksum).toBe(sha256Hex(migration.sql));
      // F-002 ports 契约可校验同一描述符形态（版本 + 摘要），不依赖实现细节。
      expect(() =>
        validateMigrationDescriptor(
          { version: migration.version, checksum: migration.checksum },
          'F-003-test',
        ),
      ).not.toThrow();
    }
  });

  it('embeds self-contained DDL that ships with the build artifacts, free of source-cwd or absolute paths', () => {
    // 迁移内容内嵌在编译模块中（packages/core/dist/adapters/sqlite/migrations.js），
    // 属于包 tsconfig include 的 src/**/*.ts 编译范围；这里断言其不读取任何外部文件。
    const sourcePath = resolve(repoRoot, 'packages/core/src/adapters/sqlite/migrations.ts');
    expect(existsSync(sourcePath)).toBe(true);
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfrom\s+['"]node:(fs|path)['"]/);
    for (const migration of SQLITE_MIGRATIONS) {
      expect(migration.sql).not.toMatch(/\/Users\/|process\.cwd|__dirname|import\.meta/);
    }
    // v1 建立基础六表；v2（F-006）建立 state_events 审计表。
    expect(SQLITE_MIGRATIONS[0]?.sql).toMatch(/CREATE TABLE projects/);
    expect(SQLITE_MIGRATIONS[0]?.sql).toMatch(/CREATE TABLE schema_migrations/);
    expect(SQLITE_MIGRATIONS[1]?.sql).toMatch(/CREATE TABLE state_events/);
  });
});

// ---------------------------------------------------------------------------
// 空临时库迁移执行与表集合
// ---------------------------------------------------------------------------

describe('F-003 versioned migrations applied to an empty temporary database', () => {
  it('creates exactly the designed tables and no future-phase tables', () => {
    withMigratedDatabase((db) => {
      expect(listUserTables(db)).toEqual(EXPECTED_TABLE_NAMES);
      for (const forbidden of FORBIDDEN_TABLE_NAMES) {
        expect(listUserTables(db), `不得生成后续表 ${forbidden}`).not.toContain(forbidden);
      }
    });
  });

  it('fails recognizably when the same migration is applied a second time', () => {
    withMigratedDatabase((db) => {
      expect(() => db.exec(SQLITE_MIGRATIONS[0]?.sql ?? '')).toThrow(/already exists/i);
      // 重复应用失败不损坏既有结构。
      expect(listUserTables(db)).toEqual(EXPECTED_TABLE_NAMES);
    });
  });

  it('keeps the schema intact across close and reopen of the same file database', () => {
    withTempSandbox(
      (root) => {
        const dbPath = join(root, 'state.db');
        const first = openSqliteConnection(dbPath);
        first.database.exec('PRAGMA foreign_keys = ON');
        for (const migration of SQLITE_MIGRATIONS) {
          first.database.exec(migration.sql);
        }
        seedProject(first.database);
        seedProjectSettings(first.database);
        first.close();

        const second = openSqliteConnection(dbPath);
        try {
          expect(listUserTables(second.database)).toEqual(EXPECTED_TABLE_NAMES);
          expect(countRows(second.database, 'projects')).toBe(1);
          expect(countRows(second.database, 'project_settings')).toBe(1);
        } finally {
          second.close();
        }
      },
      { prefix: 'shiploop-f003-reopen-' },
    );
  });
});

// ---------------------------------------------------------------------------
// Drizzle Schema 与实际 DDL 的一致性交叉核对
// ---------------------------------------------------------------------------

describe('F-003 migrated DDL matches the Drizzle schema', () => {
  it('keeps column names, nullability, primary keys and default presence aligned', () => {
    withMigratedDatabase((db) => {
      for (const [tableName, table] of SCHEMA_TABLES) {
        const actual = tableInfo(db, tableName).sort((a, b) => a.name.localeCompare(b.name));
        const drizzleColumns = (
          Object.values(getTableColumns(table)) as {
            name: string;
            notNull: boolean;
            primary: boolean;
            hasDefault: boolean;
          }[]
        ).sort((a, b) => a.name.localeCompare(b.name));
        expect(
          actual.map((row) => row.name),
          `${tableName} 实际列必须与 Drizzle Schema 完全一致`,
        ).toEqual(drizzleColumns.map((column) => column.name));
        for (const column of drizzleColumns) {
          const info = actual.find((row) => row.name === column.name);
          expect(info, `${tableName}.${column.name} 必须存在于实际 DDL`).toBeDefined();
          if (column.primary) {
            expect(info?.pk, `${tableName}.${column.name} 必须是主键`).toBeGreaterThan(0);
          } else {
            expect(info?.pk, `${tableName}.${column.name} 不得是主键`).toBe(0);
            expect(info?.notnull, `${tableName}.${column.name} 的 NOT NULL 必须一致`).toBe(
              column.notNull ? 1 : 0,
            );
          }
          expect(info?.dflt_value !== null, `${tableName}.${column.name} 默认值存在性必须一致`).toBe(
            column.hasDefault,
          );
        }
      }
    });
  });

  it('declares every named CHECK constraint from the Drizzle schema in the actual DDL', () => {
    withMigratedDatabase((db) => {
      for (const [tableName, table] of SCHEMA_TABLES) {
        const ddl = tableDdl(db, tableName);
        const actualNames = [...ddl.matchAll(/CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK/g)].map(
          (match) => match[1],
        );
        const expectedNames = getTableConfig(table).checks.map((check) => check.name).sort();
        expect(
          actualNames.sort(),
          `${tableName} 的 CHECK 约束必须与 Drizzle Schema 一致`,
        ).toEqual(expectedNames);
      }
    });
  });

  it('keeps declared indexes and UNIQUE constraints aligned, including composite keys', () => {
    withMigratedDatabase((db) => {
      for (const [tableName, table] of SCHEMA_TABLES) {
        const configIndexes = getTableConfig(table).indexes;
        const actualRows = db
          .prepare<[], { name: string; unique: number; origin: string }>(
            `PRAGMA index_list(${tableName})`,
          )
          .all()
          .filter((row) => row.origin === 'c');
        expect(
          actualRows.map((row) => row.name).sort(),
          `${tableName} 的 CREATE INDEX 索引必须与 Drizzle Schema 一致`,
        ).toEqual(configIndexes.map((index) => index.config.name).sort());
        for (const index of configIndexes) {
          const row = actualRows.find((candidate) => candidate.name === index.config.name);
          expect(row, `${tableName} 索引 ${index.config.name} 必须存在`).toBeDefined();
          expect(row?.unique).toBe(index.config.unique ? 1 : 0);
          const actualColumns = db
            .prepare<[string], { name: string }>('SELECT name FROM pragma_index_info(?)')
            .all(index.config.name)
            .map((info) => info.name);
          expect(actualColumns).toEqual(
            (index.config.columns as readonly { name: string }[]).map((column) => column.name),
          );
        }
      }
    });
  });

  it('enforces same-project RESTRICT foreign keys declared by the Drizzle schema', () => {
    withMigratedDatabase((db) => {
      // 期望的外键映射（子列 → 父列；复合外键逐列对应），含 F-008 补齐的同项目复合外键。
      const expectedFks = new Set([
        'projects:(repository_binding_id)->repository_bindings.(id)',
        'projects:(id,repository_binding_id)->repository_bindings.(project_id,id)',
        'repository_bindings:(project_id)->projects.(id)',
        'project_settings:(project_id)->projects.(id)',
        'artifacts:(project_id)->projects.(id)',
        'state_events:(project_id)->projects.(id)',
      ]);
      type FkPragmaRow = { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string };
      const actualFks = new Set<string>();
      for (const [tableName, table] of SCHEMA_TABLES) {
        const pragmaRows = db
          .prepare<[], FkPragmaRow>(`PRAGMA foreign_key_list(${tableName})`)
          .all();
        // 按 FK id 分组：pragma 中每个外键占一组（复合外键一组多行）。
        const groups = new Map<number, FkPragmaRow[]>();
        for (const row of pragmaRows) {
          const group = groups.get(row.id) ?? [];
          group.push(row);
          groups.set(row.id, group);
        }
        const configFks = getTableConfig(table).foreignKeys;
        expect(groups.size, `${tableName} 外键数量必须一致`).toBe(configFks.length);
        for (const foreignKey of configFks) {
          const reference = foreignKey.reference();
          expect(foreignKey.onDelete, `${tableName} 外键必须 RESTRICT`).toBe('restrict');
          const childNames = reference.columns.map((column) => column.name);
          const parentTable = getTableName(reference.foreignTable);
          const parentNames = reference.foreignColumns.map((column) => column.name);
          // 逐列核对：找到列映射完全匹配且全组 RESTRICT 的外键组。
          const orderedGroups = [...groups.values()].map((group) => [...group].sort((a, b) => a.seq - b.seq));
          const match = orderedGroups.find(
            (group) =>
              group.length === childNames.length &&
              group.every((row) => row.table === parentTable && row.on_delete === 'RESTRICT') &&
              group.every((row, index) => row.from === childNames[index] && row.to === parentNames[index]),
          );
          expect(
            match,
            `${tableName} 外键 (${childNames.join(',')}) -> ${parentTable}(${parentNames.join(',')}) 必须在实际 DDL 中逐列存在且 RESTRICT`,
          ).toBeDefined();
          actualFks.add(`${tableName}:(${childNames.join(',')})->${parentTable}.(${parentNames.join(',')})`);
        }
      }
      expect([...actualFks].sort()).toEqual([...expectedFks].sort());
    });
  });
});

// ---------------------------------------------------------------------------
// 真实 Drizzle 会话在迁移后的库上往返（中文多字节、JSON 默认值、ready 转换）
// ---------------------------------------------------------------------------

describe('F-003 real Drizzle session round-trip on the migrated database', () => {
  it('inserts and reads back every table through the Drizzle schema objects', () => {
    withMigratedDatabase((db) => {
      const session = drizzle(db);
      session
        .insert(schema.projects)
        .values({
          id: 'proj-1',
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
          displayName: '示例项目🚢',
          description: '中文说明',
          labels: JSON.stringify(['alpha', 'beta']),
        })
        .run();
      session
        .insert(schema.repositoryBindings)
        .values({
          id: 'bind-1',
          createdAt: NOW_MS,
          projectId: 'proj-1',
          updatedAt: NOW_MS,
          canonicalPath: '/repos/example',
          repoIdentity: 'identity-1',
        })
        .run();
      session
        .update(schema.projects)
        .set({ repositoryBindingId: 'bind-1' })
        .run();
      session
        .insert(schema.globalSettings)
        .values({
          id: 'global',
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
          schemaVersion: 1,
          payload: JSON.stringify({ schemaVersion: 1, strategies: {} }),
        })
        .run();
      session
        .insert(schema.projectSettings)
        .values({
          id: 'ps-1',
          createdAt: NOW_MS,
          projectId: 'proj-1',
          updatedAt: NOW_MS,
          schemaVersion: 1,
          payload: JSON.stringify({ schemaVersion: 1, strategies: {} }),
        })
        .run();
      session
        .insert(schema.artifacts)
        .values({
          id: 'art-1',
          createdAt: NOW_MS,
          projectId: 'proj-1',
          updatedAt: NOW_MS,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash: VALID_SHA256,
          storageLocator: 'artifacts/art-1/v1/report.json',
        })
        .run();

      const project = session.select().from(schema.projects).all()[0];
      expect(project?.displayName).toBe('示例项目🚢');
      expect(JSON.parse(project?.labels ?? 'null')).toEqual(['alpha', 'beta']);
      expect(project?.status).toBe('active');
      expect(project?.repositoryBindingId).toBe('bind-1');

      // pending → ready 的真实更新经 Drizzle 完成（hash/size 由 DB CHECK 保护）。
      session
        .update(schema.artifacts)
        .set({
          status: 'ready',
          contentHash: VALID_SHA256,
          sizeBytes: 128,
          updatedAt: NOW_MS + 1,
        })
        .run();
      const artifact = session.select().from(schema.artifacts).all()[0];
      expect(artifact?.status).toBe('ready');
      expect(artifact?.contentHash).toBe(VALID_SHA256);
      expect(artifact?.sizeBytes).toBe(128);
      // 未显式提供的默认值来自 DDL 默认表达式，而非内存缓存。
      expect(artifact?.version).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// DDL 约束失败矩阵：每个样例断言真实 SQLite 抛错且行数不变
// ---------------------------------------------------------------------------

type ConstraintCase = {
  readonly name: string;
  readonly seed: (db: CoreDatabase) => void;
  readonly statement: string;
  readonly params: readonly unknown[];
  readonly table: string;
  readonly error: RegExp;
};

const CONSTRAINT_CASES: readonly ConstraintCase[] = [
  {
    name: 'projects.revision 必须为正整数（拒绝 0）',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('bad', ?, 0, ?, 'x', 'active', '[]')",
    params: [NOW_MS, NOW_MS],
    table: 'projects',
    error: /CHECK constraint failed: projects_revision_positive_check/,
  },
  {
    name: 'projects.status 枚举外的取值拒绝写入',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('bad', ?, 1, ?, 'x', 'bogus', '[]')",
    params: [NOW_MS, NOW_MS],
    table: 'projects',
    error: /CHECK constraint failed: projects_status_enum_check/,
  },
  {
    name: 'projects.display_name 空字符串拒绝写入',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('bad', ?, 1, ?, '', 'active', '[]')",
    params: [NOW_MS, NOW_MS],
    table: 'projects',
    error: /CHECK constraint failed: projects_display_name_not_empty_check/,
  },
  {
    name: 'projects.labels 必须是合法 JSON',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('bad', ?, 1, ?, 'x', 'active', 'not-json')",
    params: [NOW_MS, NOW_MS],
    table: 'projects',
    error: /CHECK constraint failed: projects_labels_json_array_check/,
  },
  {
    name: 'projects.labels 必须是 JSON 数组（对象拒绝）',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('bad', ?, 1, ?, 'x', 'active', '{\"a\":1}')",
    params: [NOW_MS, NOW_MS],
    table: 'projects',
    error: /CHECK constraint failed: projects_labels_json_array_check/,
  },
  {
    name: 'global_settings 单例限制 id=global',
    seed: (db) => seedGlobalSettings(db),
    statement:
      "INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) VALUES ('other', ?, 1, ?, 1, '{}')",
    params: [NOW_MS, NOW_MS],
    table: 'global_settings',
    error: /CHECK constraint failed: global_settings_singleton_id_check/,
  },
  {
    name: 'global_settings 主键拒绝第二条 global 记录',
    seed: (db) => seedGlobalSettings(db),
    statement:
      "INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) VALUES ('global', ?, 1, ?, 1, '{}')",
    params: [NOW_MS, NOW_MS],
    table: 'global_settings',
    error: /UNIQUE constraint failed: global_settings\.id/,
  },
  {
    name: 'global_settings.schema_version 必须为正整数',
    seed: (db) => seedGlobalSettings(db),
    statement:
      "INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) VALUES ('global', ?, 1, ?, 0, '{}')",
    params: [NOW_MS, NOW_MS],
    table: 'global_settings',
    error: /CHECK constraint failed: global_settings_schema_version_positive_check/,
  },
  {
    name: 'global_settings.payload 必须是合法 JSON',
    seed: (db) => seedGlobalSettings(db),
    statement:
      "INSERT INTO global_settings (id, created_at, revision, updated_at, schema_version, payload) VALUES ('global', ?, 1, ?, 1, 'broken')",
    params: [NOW_MS, NOW_MS],
    table: 'global_settings',
    error: /CHECK constraint failed: global_settings_payload_json_check/,
  },
  {
    name: 'project_settings 缺失项目时外键失败',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) VALUES ('ps-x', ?, 'missing', 1, ?, 1, '{}')",
    params: [NOW_MS, NOW_MS],
    table: 'project_settings',
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'project_settings 每项目仅一条（UNIQUE project_id）',
    seed: (db) => {
      seedProject(db);
      seedProjectSettings(db);
    },
    statement:
      "INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) VALUES ('ps-2', ?, 'proj-1', 1, ?, 1, '{}')",
    params: [NOW_MS, NOW_MS],
    table: 'project_settings',
    error: /UNIQUE constraint failed: project_settings\.project_id/,
  },
  {
    name: 'project_settings.payload 必须是合法 JSON',
    seed: (db) => {
      seedProject(db);
      seedProjectSettings(db);
    },
    statement:
      "INSERT INTO project_settings (id, created_at, project_id, revision, updated_at, schema_version, payload) VALUES ('ps-x', ?, 'proj-1', 1, ?, 1, 'nope')",
    params: [NOW_MS, NOW_MS],
    table: 'project_settings',
    error: /CHECK constraint failed: project_settings_payload_json_check/,
  },
  {
    name: 'repository_bindings.canonical_path 唯一',
    seed: (db) => {
      seedProject(db);
      seedBinding(db);
    },
    statement:
      "INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, repo_identity) VALUES ('bind-2', ?, 'proj-1', 1, ?, '/repo/a', 'identity-2')",
    params: [NOW_MS, NOW_MS],
    table: 'repository_bindings',
    error: /UNIQUE constraint failed: repository_bindings\.canonical_path/,
  },
  {
    name: 'repository_bindings 缺失项目时外键失败',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, repo_identity) VALUES ('bind-x', ?, 'missing', 1, ?, '/repo/x', 'identity-x')",
    params: [NOW_MS, NOW_MS],
    table: 'repository_bindings',
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'repository_bindings.repo_identity 空字符串拒绝',
    seed: (db) => {
      seedProject(db);
      seedBinding(db);
    },
    statement:
      "INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, repo_identity) VALUES ('bind-2', ?, 'proj-1', 1, ?, '/repo/b', '')",
    params: [NOW_MS, NOW_MS],
    table: 'repository_bindings',
    error: /CHECK constraint failed: repository_bindings_repo_identity_not_empty_check/,
  },
  {
    name: 'artifacts 缺失项目时外键失败',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, storage_locator) VALUES ('art-x', ?, 'missing', 1, ?, 'report', 'application/json', ?, 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS, VALID_SHA256],
    table: 'artifacts',
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'artifacts.status 枚举外的取值拒绝',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'published', 'application/json', ?, 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS, VALID_SHA256],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_status_enum_check/,
  },
  {
    name: 'artifacts.expected_hash 长度必须是 64',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'application/json', 'ab', 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_expected_hash_sha256_check/,
  },
  {
    name: 'artifacts.expected_hash 必须是小写 hex（拒绝大写）',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'application/json', ?, 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS, 'AB'.repeat(32)],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_expected_hash_sha256_check/,
  },
  {
    name: 'artifacts.size_bytes 必须非负',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, size_bytes, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'application/json', ?, -1, 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS, VALID_SHA256],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_size_bytes_non_negative_check/,
  },
  {
    name: 'artifacts.version 必须为正整数',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, version, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'application/json', ?, 0, 'artifacts/x/v1/r.json')",
    params: [NOW_MS, NOW_MS, VALID_SHA256],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_version_positive_check/,
  },
  {
    name: 'artifacts ready 状态必须携带 hash 与 size',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement: "UPDATE artifacts SET status = 'ready' WHERE id = 'art-1'",
    params: [],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_ready_identity_check/,
  },
  {
    name: 'artifacts ready 的 content_hash 必须是小写 hex',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "UPDATE artifacts SET status = 'ready', content_hash = 'ZZ', size_bytes = 1 WHERE id = 'art-1'",
    params: [],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_content_hash_sha256_check/,
  },
  {
    name: 'artifacts.storage_locator 空字符串拒绝',
    seed: (db) => {
      seedProject(db);
      seedArtifact(db);
    },
    statement:
      "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, media_type, expected_hash, storage_locator) VALUES ('art-x', ?, 'proj-1', 1, ?, 'report', 'application/json', ?, '')",
    params: [NOW_MS, NOW_MS, VALID_SHA256],
    table: 'artifacts',
    error: /CHECK constraint failed: artifacts_locator_not_empty_check/,
  },
  {
    name: 'state_events.sequence 必须为正整数',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-x', ?, 1, ?, 'proj-1', 0, 'project.metadata_updated', 'project', 'proj-1', 1, '{}', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /CHECK constraint failed: state_events_sequence_positive_check/,
  },
  {
    name: 'state_events.sequence 唯一',
    seed: (db) => {
      seedProject(db);
      seedStateEvent(db);
    },
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-2', ?, 1, ?, 'proj-1', 1, 'project.metadata_updated', 'project', 'proj-1', 1, '{}', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /UNIQUE constraint failed: state_events\.sequence/,
  },
  {
    name: 'state_events.payload 必须是合法 JSON',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-x', ?, 1, ?, 'proj-1', 1, 'project.metadata_updated', 'project', 'proj-1', 1, 'broken', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /CHECK constraint failed: state_events_payload_json_object_check/,
  },
  {
    name: 'state_events.payload 必须是 JSON 对象（拒绝数组）',
    seed: (db) => seedProject(db),
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-x', ?, 1, ?, 'proj-1', 1, 'project.metadata_updated', 'project', 'proj-1', 1, '[]', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /CHECK constraint failed: state_events_payload_json_object_check/,
  },
  {
    name: 'state_events 非全局事件不得缺 project_id',
    seed: () => undefined,
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-x', ?, 1, ?, NULL, 1, 'project.metadata_updated', 'project', 'proj-1', 1, '{}', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /CHECK constraint failed: state_events_project_scope_check/,
  },
  {
    name: 'state_events 缺失项目时外键失败',
    seed: () => undefined,
    statement:
      "INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES ('ev-x', ?, 1, ?, 'missing', 1, 'project.metadata_updated', 'project', 'missing', 1, '{}', ?)",
    params: [NOW_MS, NOW_MS, NOW_MS],
    table: 'state_events',
    error: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'schema_migrations.version 必须为正整数',
    seed: () => undefined,
    statement:
      "INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES ('m-1', ?, 0, ?, ?)",
    params: [NOW_MS, VALID_SHA256, NOW_MS],
    table: 'schema_migrations',
    error: /CHECK constraint failed: schema_migrations_version_positive_check/,
  },
  {
    name: 'schema_migrations.version 唯一',
    seed: (db) => {
      db.prepare(
        "INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES ('m-1', ?, 1, ?, ?)",
      ).run(NOW_MS, VALID_SHA256, NOW_MS);
    },
    statement:
      "INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES ('m-2', ?, 1, ?, ?)",
    params: [NOW_MS, OTHER_SHA256, NOW_MS],
    table: 'schema_migrations',
    error: /UNIQUE constraint failed: schema_migrations\.version/,
  },
  {
    name: 'schema_migrations.checksum 必须是 64 位小写 hex',
    seed: (db) => {
      db.prepare(
        "INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES ('m-1', ?, 1, ?, ?)",
      ).run(NOW_MS, VALID_SHA256, NOW_MS);
    },
    statement:
      "INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES ('m-2', ?, 2, 'ZZ', ?)",
    params: [NOW_MS, NOW_MS],
    table: 'schema_migrations',
    error: /CHECK constraint failed: schema_migrations_checksum_sha256_check/,
  },
];

describe.each(CONSTRAINT_CASES)('F-003 DDL constraint: %s', (testCase) => {
  it('rejects the illegal record without changing stored rows', () => {
    withMigratedDatabase((db) => {
      testCase.seed(db);
      const before = countRows(db, testCase.table);
      expect(() => db.prepare(testCase.statement).run(...testCase.params)).toThrow(testCase.error);
      expect(countRows(db, testCase.table)).toBe(before);
    });
  });
});

describe('F-003 RESTRICT delete protection and schema_migrations record', () => {
  it('blocks deleting a project referenced by settings, artifacts or bindings', () => {
    withMigratedDatabase((db) => {
      seedProject(db);
      seedBinding(db);
      seedProjectSettings(db);
      seedArtifact(db);
      for (const table of ['projects', 'project_settings', 'artifacts', 'repository_bindings']) {
        expect(countRows(db, table)).toBe(1);
      }
      expect(() => db.prepare("DELETE FROM projects WHERE id = 'proj-1'").run()).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      for (const table of ['projects', 'project_settings', 'artifacts', 'repository_bindings']) {
        expect(countRows(db, table), `${table} 行必须保留`).toBe(1);
      }
    });
  });

  it('blocks deleting a binding referenced by its project (RESTRICT)', () => {
    withMigratedDatabase((db) => {
      seedProject(db);
      seedBinding(db);
      db.prepare("UPDATE projects SET repository_binding_id = 'bind-1' WHERE id = 'proj-1'").run();
      expect(() => db.prepare("DELETE FROM repository_bindings WHERE id = 'bind-1'").run()).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(countRows(db, 'repository_bindings')).toBe(1);
      expect(countRows(db, 'projects')).toBe(1);
    });
  });

  it('accepts a valid migration record and returns it unchanged after reopen', () => {
    withTempSandbox(
      (root) => {
        const dbPath = join(root, 'state.db');
        const first = openSqliteConnection(dbPath);
        first.database.exec(SQLITE_MIGRATIONS[0]?.sql ?? '');
        first.database
          .prepare(
            'INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('m-1', NOW_MS, SQLITE_MIGRATIONS[0]?.version ?? 1, SQLITE_MIGRATIONS[0]?.checksum, NOW_MS);
        first.close();

        const second = openSqliteConnection(dbPath);
        try {
          const row = second.database
            .prepare<[], { version: number; checksum: string }>(
              'SELECT version, checksum FROM schema_migrations',
            )
            .get();
          expect(row?.version).toBe(SQLITE_MIGRATIONS[0]?.version);
          expect(row?.checksum).toBe(SQLITE_MIGRATIONS[0]?.checksum);
        } finally {
          second.close();
        }
      },
      { prefix: 'shiploop-f003-migration-record-' },
    );
  });
});
