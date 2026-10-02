/**
 * F-001 固定存储依赖与真实临时 SQLite 测试夹具回归。
 *
 * 覆盖（P01-2 / F-001，真实断言，非 mock）：
 * - 依赖固定：shiploop-core 在适配层精确锁定 better-sqlite3@13.0.3 / drizzle-orm@0.45.3
 *   （设计 core-design/03 S2 实验在 macOS arm64 / Node 22.19.0 已验证的候选版本）与
 *   @types/better-sqlite3@9.6.0；根清单不持有存储栈；package-lock.json 与之一致。
 * - 真实夹具：在独立系统临时目录打开文件型 SQLite（经 Core adapters 层装配入口
 *   openSqliteConnection，驱动引用不出适配层），执行真实 Drizzle 写入/读取断言
 *   （含中文多字节往返）、immediate 事务注入异常后整组回滚、唯一约束失败不落半条记录。
 * - 生命周期与清理：关闭后连接不可再操作、重复 close 安全；关闭重开同一文件库数据
 *   逐字段一致；在不存在的目录打开返回可识别错误且不残留句柄或目录；正常与异常路径
 *   都经 withTempSandbox 清理临时资源，不依赖用户数据根或真实模型。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { openSqliteConnection } from '../packages/core/src/adapters/sqlite/connection.ts';
import { withTempSandbox } from './helpers/temp-sandbox.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PINNED_BETTER_SQLITE3 = '13.0.3';
const PINNED_DRIZZLE_ORM = '0.45.3';
const PINNED_TYPES_BETTER_SQLITE3 = '9.6.0';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('F-001 pinned storage dependencies in the Core adapter layer', () => {
  it('pins better-sqlite3, drizzle-orm and their types to exact versions in shiploop-core', () => {
    const core = readJson('packages/core/package.json');
    expect(core.dependencies).toEqual({
      'better-sqlite3': PINNED_BETTER_SQLITE3,
      'drizzle-orm': PINNED_DRIZZLE_ORM,
    });
    expect(core.devDependencies).toEqual({
      '@types/better-sqlite3': PINNED_TYPES_BETTER_SQLITE3,
    });
  });

  it('keeps the root manifest free of storage stacks (tooling only)', () => {
    const root = readJson('package.json');
    const allDependencies = {
      ...(root.dependencies as Record<string, string> | undefined),
      ...(root.devDependencies as Record<string, string> | undefined),
    };
    for (const banned of ['better-sqlite3', 'drizzle-orm', '@types/better-sqlite3']) {
      expect(allDependencies, `root manifest must not declare ${banned}`).not.toHaveProperty(
        banned,
      );
    }
  });

  it('records the pinned packages with matching versions and integrity in the lockfile', () => {
    const lock = readJson('package-lock.json') as {
      packages?: Record<string, { version?: unknown; integrity?: unknown; resolved?: unknown }>;
    };
    expect(lock.packages).toBeTypeOf('object');
    const packages = lock.packages as Record<string, Record<string, unknown>>;
    for (const [name, version] of [
      ['better-sqlite3', PINNED_BETTER_SQLITE3],
      ['drizzle-orm', PINNED_DRIZZLE_ORM],
      ['@types/better-sqlite3', PINNED_TYPES_BETTER_SQLITE3],
    ] as const) {
      const entry = packages[`node_modules/${name}`];
      expect(entry, `lockfile must contain node_modules/${name}`).toBeTypeOf('object');
      expect(entry?.version).toBe(version);
      expect(typeof entry?.integrity).toBe('string');
    }
    const coreEntry = packages['packages/core'];
    expect(coreEntry?.dependencies).toEqual({
      'better-sqlite3': PINNED_BETTER_SQLITE3,
      'drizzle-orm': PINNED_DRIZZLE_ORM,
    });
    expect(coreEntry?.devDependencies).toEqual({
      '@types/better-sqlite3': PINNED_TYPES_BETTER_SQLITE3,
    });
  });
});

/**
 * 夹具表只属于本测试文件（F-003 才会引入可版本控制的正式 Drizzle Schema 与迁移），
 * 经原始 DDL 建表后由真实 Drizzle 会话执行写入/读取断言。
 */
const fixtureRows = sqliteTable('fixture_rows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull().unique(),
  payload: text('payload').notNull(),
});

const FIXTURE_DDL =
  'CREATE TABLE fixture_rows (' +
  'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
  'label TEXT NOT NULL UNIQUE, ' +
  'payload TEXT NOT NULL)';

describe('F-001 real temporary SQLite fixture through the Core adapter assembly', () => {
  it('opens a file-backed database in a temp sandbox and round-trips real data via Drizzle', () => {
    withTempSandbox(
      (root) => {
        const dbPath = join(root, 'state.db');
        const connection = openSqliteConnection(dbPath);
        try {
          expect(connection.path).toBe(dbPath);
          expect(connection.isOpen()).toBe(true);
          expect(existsSync(dbPath)).toBe(true);
          // 原生驱动真实可用：能执行真实查询并返回 SQLite 版本（macOS arm64 预编译模块加载）。
          const version = connection.database.prepare<[], { version: string }>(
            'SELECT sqlite_version() AS version',
          ).get();
          expect(version?.version).toMatch(/^\d+\.\d+\.\d+$/);

          connection.database.exec(FIXTURE_DDL);
          const session = drizzle(connection.database);
          session
            .insert(fixtureRows)
            .values({ label: 'first', payload: '中文内容🚢' })
            .run();
          const row = session
            .select()
            .from(fixtureRows)
            .where(eq(fixtureRows.label, 'first'))
            .get();
          expect(row?.id).toBe(1);
          expect(row?.payload).toBe('中文内容🚢');
        } finally {
          connection.close();
        }
      },
      { prefix: 'shiploop-f001-roundtrip-' },
    );
  });

  it('rolls back the whole immediate transaction when the callback throws', () => {
    withTempSandbox(
      (root) => {
        const connection = openSqliteConnection(join(root, 'state.db'));
        try {
          connection.database.exec(FIXTURE_DDL);
          const session = drizzle(connection.database);
          expect(() =>
            session.transaction(
              (tx) => {
                tx.insert(fixtureRows).values({ label: 'a', payload: 'a' }).run();
                tx.insert(fixtureRows).values({ label: 'b', payload: 'b' }).run();
                throw new Error('注入的事务中断');
              },
              { behavior: 'immediate' },
            ),
          ).toThrow('注入的事务中断');
          expect(session.select().from(fixtureRows).all()).toEqual([]);
        } finally {
          connection.close();
        }
      },
      { prefix: 'shiploop-f001-rollback-' },
    );
  });

  it('rejects a unique-constraint violation without leaving partial rows', () => {
    withTempSandbox(
      (root) => {
        const connection = openSqliteConnection(join(root, 'state.db'));
        try {
          connection.database.exec(FIXTURE_DDL);
          const session = drizzle(connection.database);
          session.insert(fixtureRows).values({ label: 'dup', payload: 'kept' }).run();
          expect(() => {
            session.transaction((tx) => {
              tx.insert(fixtureRows).values({ label: 'other', payload: 'x' }).run();
              tx.insert(fixtureRows).values({ label: 'dup', payload: 'conflict' }).run();
            });
          }).toThrow(/UNIQUE constraint failed/);
          const rows = session.select().from(fixtureRows).all();
          expect(rows).toHaveLength(1);
          expect(rows[0]?.label).toBe('dup');
        } finally {
          connection.close();
        }
      },
      { prefix: 'shiploop-f001-constraint-' },
    );
  });

  it('persists data across close and reopen, and closed connections refuse operations', () => {
    withTempSandbox(
      (root) => {
        const dbPath = join(root, 'state.db');
        const first = openSqliteConnection(dbPath);
        first.database.exec(FIXTURE_DDL);
        drizzle(first.database)
          .insert(fixtureRows)
          .values({ label: 'keep', payload: 'persisted-中文' })
          .run();
        first.close();
        expect(first.isOpen()).toBe(false);
        expect(() => first.database.prepare('SELECT 1')).toThrow(/not open/i);
        // 重复 close 安全，不抛异常。
        first.close();

        const second = openSqliteConnection(dbPath);
        try {
          expect(second.isOpen()).toBe(true);
          const row = drizzle(second.database)
            .select()
            .from(fixtureRows)
            .where(eq(fixtureRows.label, 'keep'))
            .get();
          expect(row?.id).toBe(1);
          expect(row?.payload).toBe('persisted-中文');
        } finally {
          second.close();
        }
      },
      { prefix: 'shiploop-f001-reopen-' },
    );
  });

  it('fails recognizably when the target directory does not exist and leaves no residue', () => {
    withTempSandbox(
      (root) => {
        const badPath = join(root, 'missing-dir', 'state.db');
        expect(() => openSqliteConnection(badPath)).toThrow(
          /unable to open database file|SQLITE_CANTOPEN|directory does not exist/i,
        );
        expect(existsSync(join(root, 'missing-dir'))).toBe(false);
      },
      { prefix: 'shiploop-f001-cantopen-' },
    );
  });

  it('rejects an empty database path instead of silently creating an anonymous database', () => {
    expect(() => openSqliteConnection('')).toThrow(/path/i);
  });
});
