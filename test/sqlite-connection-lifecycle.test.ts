/**
 * F-004 SQLite 连接生命周期、短同步事务与有界 busy 处理回归（真实临时 SQLite，非 mock）。
 *
 * 覆盖（P01-2 / F-004 验收点，全部为真实断言）：
 * - PRAGMA 策略：每个实际连接启用并核验 foreign_keys=ON、journal_mode=WAL、
 *   synchronous=FULL 及显式 busy_timeout；pragmaSnapshot 每次现场查询 PRAGMA 实际值，
 *   并与直接经驱动查询的结果交叉核对；关闭后可重新打开同一文件库，数据逐字段一致，
 *   per-connection 的 foreign_keys 在新连接上重新启用并核验，WAL 随文件持久；
 * - 短同步事务：成功事务整组提交并返回回调结果；回调中途抛错整组回滚、无部分行；
 *   async/Promise 回调被拒绝（事务已回滚，无半提交），连接随后仍可正常使用；
 * - 有界 busy：第二个真实连接持有写锁（BEGIN IMMEDIATE）时，本会话写入在配置的
 *   有限 busy 等待/重试预算内返回可识别的 StorageError(kind='busy')，事务无部分行；
 *   断言耗时有限（外层另有测试超时），锁释放后同一写入成功；WAL 下持锁期间读取仍可用；
 * - 生命周期安全：不存在目录/非法数据库文件的初始化失败不暴露可写会话且失败路径关闭
 *   句柄；重复 close 幂等；关闭后的操作返回明确错误而非使用已失效连接；
 *   非法 busy 预算/空路径在任何文件创建前被拒绝；
 * - 连接装配显式接收受控数据库位置；本模块属 adapters 层，不经公共端口泄漏驱动对象。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import { openSqliteConnection } from '../packages/core/src/adapters/sqlite/connection.ts';
import {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  DEFAULT_BUSY_TIMEOUT_MS,
  openSqliteStorageSession,
  type SqliteStorageSession,
} from '../packages/core/src/adapters/sqlite/session.ts';
import { withTempSandbox } from './helpers/temp-sandbox.ts';

/** 夹具表只属于本测试文件；正式六表 Schema 已由 F-003 迁移测试覆盖。 */
const NOTES_DDL = 'CREATE TABLE f4_notes (id TEXT PRIMARY KEY NOT NULL, note TEXT NOT NULL)';
const PARENTS_DDL = 'CREATE TABLE f4_parents (id TEXT PRIMARY KEY NOT NULL)';
const CHILDREN_DDL =
  'CREATE TABLE f4_children (' +
  'id TEXT PRIMARY KEY NOT NULL, ' +
  'parent_id TEXT NOT NULL, ' +
  'CONSTRAINT f4_children_parent_fk FOREIGN KEY (parent_id) REFERENCES f4_parents (id) ON DELETE RESTRICT)';

function createFixtureTables(session: SqliteStorageSession): void {
  session.database.exec(`${NOTES_DDL}; ${PARENTS_DDL}; ${CHILDREN_DDL}`);
}

function insertNote(session: SqliteStorageSession, id: string, note: string): void {
  session.transactWrite('fixture.insert_note', (db) => {
    db.prepare('INSERT INTO f4_notes (id, note) VALUES (?, ?)').run(id, note);
  });
}

function noteIds(session: SqliteStorageSession): string[] {
  const rows = session.database
    .prepare<[], { id: string }>('SELECT id FROM f4_notes ORDER BY id')
    .all();
  return rows.map((row) => row.id);
}

function childIds(session: SqliteStorageSession): string[] {
  const rows = session.database
    .prepare<[], { id: string }>('SELECT id FROM f4_children ORDER BY id')
    .all();
  return rows.map((row) => row.id);
}

describe('F-004 PRAGMA policy applied and verified on every real connection', () => {
  it('applies and verifies foreign_keys, journal_mode, synchronous and busy_timeout', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      const session = openSqliteStorageSession({
        path: dbPath,
        busyTimeoutMs: 120,
        busyRetryAttempts: 2,
      });
      try {
        // pragmaSnapshot 现场查询 PRAGMA 实际值（非打开时缓存）。
        expect(session.pragmaSnapshot()).toEqual({
          foreignKeysEnabled: true,
          journalMode: 'wal',
          synchronous: 2,
          busyTimeoutMs: 120,
        });
        // 直接经驱动查询同一连接的实际 PRAGMA 值交叉核对。
        expect(session.database.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(
          String(session.database.pragma('journal_mode', { simple: true })).toLowerCase(),
        ).toBe('wal');
        expect(session.database.pragma('busy_timeout', { simple: true })).toBe(120);
        expect(Number(session.database.pragma('synchronous', { simple: true }))).toBe(2);
        expect(session.busyTimeoutMs).toBe(120);
        expect(session.busyRetryAttempts).toBe(2);
      } finally {
        session.close();
      }
    });
  });

  it('applies documented default busy budget when options are omitted', () => {
    withTempSandbox((root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        expect(Number.isInteger(DEFAULT_BUSY_TIMEOUT_MS)).toBe(true);
        expect(DEFAULT_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
        expect(Number.isInteger(DEFAULT_BUSY_RETRY_ATTEMPTS)).toBe(true);
        expect(DEFAULT_BUSY_RETRY_ATTEMPTS).toBeGreaterThan(0);
        expect(session.busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS);
        expect(session.busyRetryAttempts).toBe(DEFAULT_BUSY_RETRY_ATTEMPTS);
        expect(session.pragmaSnapshot().busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS);
      } finally {
        session.close();
      }
    });
  });

  it('enforces foreign keys behaviorally: orphan insert fails and leaves no row', () => {
    withTempSandbox((root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        createFixtureTables(session);
        expect(() =>
          session.transactWrite('fixture.insert_orphan_child', (db) => {
            db.prepare(
              "INSERT INTO f4_children (id, parent_id) VALUES ('c1', 'missing-parent')",
            ).run();
          }),
        ).toThrowError(/FOREIGN KEY/i);
        expect(childIds(session)).toEqual([]);
        // 合法引用在同一事务内成功。
        session.transactWrite('fixture.insert_parent_and_child', (db) => {
          db.prepare("INSERT INTO f4_parents (id) VALUES ('p1')").run();
          db.prepare("INSERT INTO f4_children (id, parent_id) VALUES ('c1', 'p1')").run();
        });
        expect(childIds(session)).toEqual(['c1']);
      } finally {
        session.close();
      }
    });
  });

  it('reopens the same file after close: data intact, per-connection policy re-applied', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      const first = openSqliteStorageSession({ path: dbPath });
      createFixtureTables(first);
      insertNote(first, 'persist', '关闭重开后仍然存在');
      first.close();
      expect(first.isOpen()).toBe(false);

      const second = openSqliteStorageSession({ path: dbPath });
      try {
        expect(noteIds(second)).toEqual(['persist']);
        const snapshot = second.pragmaSnapshot();
        // journal_mode 为持久设置，随数据库文件保留；foreign_keys 为 per-connection
        // 设置，新连接上必须重新启用并经打开时核验。
        expect(snapshot.journalMode).toBe('wal');
        expect(snapshot.foreignKeysEnabled).toBe(true);
        expect(snapshot.busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS);
      } finally {
        second.close();
      }
    });
  });
});

describe('F-004 short synchronous transactions', () => {
  it('commits the whole transaction and returns the callback result', () => {
    withTempSandbox((root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        createFixtureTables(session);
        const result = session.transactWrite('fixture.commit_two_rows', (db) => {
          db.prepare("INSERT INTO f4_notes (id, note) VALUES ('row-1', '一')").run();
          db.prepare("INSERT INTO f4_notes (id, note) VALUES ('row-2', '二')").run();
          return 42;
        });
        expect(result).toBe(42);
        expect(noteIds(session)).toEqual(['row-1', 'row-2']);
      } finally {
        session.close();
      }
    });
  });

  it('rolls back all rows when the callback throws mid-transaction', () => {
    withTempSandbox((root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        createFixtureTables(session);
        expect(() =>
          session.transactWrite('fixture.injected_failure', (db) => {
            db.prepare("INSERT INTO f4_notes (id, note) VALUES ('row-a', 'A')").run();
            db.prepare("INSERT INTO f4_notes (id, note) VALUES ('row-b', 'B')").run();
            throw new Error('injected failure after first writes');
          }),
        ).toThrowError('injected failure after first writes');
        // 整组回滚：断言实际行，没有半提交。
        expect(noteIds(session)).toEqual([]);
      } finally {
        session.close();
      }
    });
  });

  it('rejects async and Promise-returning callbacks without any half-commit', () => {
    withTempSandbox((root) => {
      const session = openSqliteStorageSession({ path: join(root, 'state.db') });
      try {
        createFixtureTables(session);
        // async 回调：函数体同步部分已写入一行，事务整体回滚，拒绝异步等待。
        expect(() =>
          session.transactWrite('fixture.async_callback', async (db) => {
            db.prepare("INSERT INTO f4_notes (id, note) VALUES ('async-row', '不应提交')").run();
            await Promise.resolve();
          }),
        ).toThrowError(TypeError);
        expect(() =>
          session.transactWrite('fixture.async_callback', async (db) => {
            db.prepare("INSERT INTO f4_notes (id, note) VALUES ('async-row', '不应提交')").run();
          }),
        ).toThrowError(/同步|async|Promise/);
        // 返回 Promise 的非 async 回调同样被拒绝。
        expect(() =>
          session.transactWrite('fixture.promise_callback', (db) => {
            db.prepare("INSERT INTO f4_notes (id, note) VALUES ('promise-row', '不应提交')").run();
            return Promise.resolve('pending');
          }),
        ).toThrowError(TypeError);
        // 无半提交，且连接随后仍可正常使用。
        expect(noteIds(session)).toEqual([]);
        insertNote(session, 'after-reject', '连接仍可写入');
        expect(noteIds(session)).toEqual(['after-reject']);
      } finally {
        session.close();
      }
    });
  });
});

describe('F-004 bounded busy handling against a real lock holder', () => {
  it('returns identifiable storage_busy within the configured budget; write succeeds after release', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      const busyTimeoutMs = 50;
      const busyRetryAttempts = 3;
      const session = openSqliteStorageSession({ path: dbPath, busyTimeoutMs, busyRetryAttempts });
      // 第二个真实连接持有写锁（BEGIN IMMEDIATE 未提交）。
      const locker = openSqliteConnection(dbPath);
      try {
        createFixtureTables(session);
        locker.database.exec('BEGIN IMMEDIATE');
        locker.database
          .prepare("INSERT INTO f4_notes (id, note) VALUES ('held', '锁持有者写入')")
          .run();

        const startedAt = Date.now();
        let caught: unknown;
        try {
          insertNote(session, 'blocked', '应因 busy 被拒绝');
        } catch (error) {
          caught = error;
        }
        const elapsedMs = Date.now() - startedAt;

        // 可识别的结构化 busy 错误，且预算是有限的（外层另有测试超时兜底）。
        expect(isStorageError(caught, 'busy')).toBe(true);
        const busyError = caught as StorageError;
        expect(busyError.kind).toBe('busy');
        expect(busyError.operation).toBe('fixture.insert_note');
        expect(busyError.details).toEqual({ attempts: busyRetryAttempts, busyTimeoutMs });
        // 诊断信息不泄漏完整数据库路径。
        expect(busyError.message).not.toContain(dbPath);
        // 有限预算：总耗时显著小于外层超时，且确实经过了等待（非瞬时失败）。
        expect(elapsedMs).toBeLessThan(5_000);
        expect(elapsedMs).toBeGreaterThanOrEqual(busyTimeoutMs);
        // 事务无部分行；WAL 下持锁期间读取与 PRAGMA 现场查询仍可用。
        expect(noteIds(session)).toEqual([]);
        expect(session.pragmaSnapshot().foreignKeysEnabled).toBe(true);

        // 锁释放后同一写入成功。
        locker.database.exec('COMMIT');
        insertNote(session, 'after-release', '锁释放后写入成功');
        expect(noteIds(session)).toEqual(['after-release', 'held']);
      } finally {
        locker.close();
        session.close();
      }
    });
  });
});

describe('F-004 initialization failure and closed-connection safety', () => {
  it('fails to open under a non-existent directory without creating files', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'missing-dir', 'state.db');
      expect(() => openSqliteStorageSession({ path: dbPath })).toThrowError();
      expect(existsSync(join(root, 'missing-dir'))).toBe(false);
    });
  });

  it('fails post-open verification on a non-database file and exposes no writable session', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      const garbage = Buffer.from('this is not a sqlite database file, definitely not.');
      writeFileSync(dbPath, garbage);
      // 打开后 PRAGMA 应用/核验真实失败（file is not a database），入口不得返回半开会话。
      expect(() => openSqliteStorageSession({ path: dbPath })).toThrowError(
        /not a database|NOTADB/i,
      );
      // 失败路径不伪造内容：原文件保持不变。
      expect(readFileSync(dbPath)).toEqual(garbage);
    });
  });

  it('rejects operations after close with a clear error; close is idempotent', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      const session = openSqliteStorageSession({ path: dbPath });
      createFixtureTables(session);
      session.close();
      expect(session.isOpen()).toBe(false);
      expect(() => session.close()).not.toThrow();
      expect(() => insertNote(session, 'late', '不应写入')).toThrowError(/已关闭/);
      expect(() => session.pragmaSnapshot()).toThrowError(/已关闭/);
      expect(noteIdsAfterReopen(dbPath)).toEqual([]);
    });
  });

  it('rejects invalid busy budgets and empty paths before any file is created', () => {
    withTempSandbox((root) => {
      const dbPath = join(root, 'state.db');
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
        expect(() => openSqliteStorageSession({ path: dbPath, busyTimeoutMs: bad })).toThrowError(
          TypeError,
        );
      }
      for (const bad of [0, -1, 2.5, Number.NaN, 17]) {
        expect(() =>
          openSqliteStorageSession({ path: dbPath, busyRetryAttempts: bad }),
        ).toThrowError(TypeError);
      }
      expect(() => openSqliteStorageSession({ path: '' })).toThrowError(TypeError);
      // 校验先于打开：任何非法输入都不创建数据库文件。
      expect(existsSync(dbPath)).toBe(false);
    });
  });
});

/** 重新打开同一文件库读取 f4_notes（验证关闭后没有偷偷写入）。 */
function noteIdsAfterReopen(dbPath: string): string[] {
  const session = openSqliteStorageSession({ path: dbPath });
  try {
    return noteIds(session);
  } finally {
    session.close();
  }
}
