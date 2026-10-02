/**
 * F-004 SQLite 连接生命周期、短同步事务与有界 busy 处理（adapters 层）。
 *
 * 设计依据：core-design/03 §1（外键启用、本机数据根）、§3（短写事务 BEGIN IMMEDIATE，
 * 事务内不执行文件流/SDK/Git/网络/长检查；busy 冲突有限退避后返回结构化错误，不无限
 * 重试）与 §6（不支持的高版本拒写——版本检查由 F-005 在迁移执行器中实现）；PRAGMA
 * 候选项已经 core-design/03 S2 实验在 macOS arm64 / Node 22.19.0 验证（busy 超时、
 * 回滚、WAL 在线备份均通过）。
 *
 * 不变量：
 * - 装配显式接收受控数据库文件位置：import 本模块不打开任何数据库、不产生副作用；
 * - 每个实际连接都应用并核验固定 PRAGMA 策略（见 SQLITE_PRAGMA_POLICY）后才返回会话；
 *   打开或核验失败的路径必定关闭句柄，绝不暴露半开的可写会话；
 * - transactWrite 只接受同步回调：async/Promise 回调被拒绝并回滚，无半提交。
 *   注意：拒绝只保证事务本身无部分写入；async 回调在首个 await 之后执行的语句不再
 *   受该事务保护，因此契约层面明确禁止（调用方 bug），不在此处做运行时追堵；
 * - busy 预算有限：每次尝试由 SQLite busy_timeout 等待 busyTimeoutMs，最多重试
 *   busyRetryAttempts 次；预算耗尽抛出 StorageError(kind='busy')，诊断字段只含
 *   预算参数，不含数据库路径或 SQL 原文；
 * - close 幂等；关闭后的操作抛出明确的“已关闭”错误，绝不使用已失效连接；
 * - 本模块属 adapters 层：database 句柄仅供本层内部与装配/测试诊断使用，
 *   公共端口（ports）不得暴露该类型（由 scripts/check-boundaries.ts 强制）。
 */
import type Database from 'better-sqlite3';
import { StorageError } from '../../ports/errors.js';
import { openSqliteConnection } from './connection.js';

/**
 * 固定 PRAGMA 策略（设计 03 §1/§3 与 S2 实验结论）：
 * - foreign_keys=ON：外键与 RESTRICT 删除保护由数据库强制，per-connection 设置，
 *   每次打开都重新启用并核验；
 * - journal_mode=WAL：支持持锁期间的并发读取与在线备份（F-005），随数据库文件持久；
 * - synchronous=FULL：耐久性设置，每次提交执行 fsync；比 WAL 常用的 NORMAL 更保守，
 *   首版状态库规模小，优先正确性与断电后可诊断性（断电演练仍为 not_run，见 F-014）；
 * - busy_timeout：由会话预算参数决定，见 openSqliteStorageSession。
 */
export const SQLITE_PRAGMA_POLICY = {
  journalMode: 'wal',
  synchronous: 'FULL',
  synchronousValue: 2,
  foreignKeys: 'ON',
} as const;

/** 默认单次 busy 等待预算（毫秒）；有限且显式，不依赖驱动隐式默认。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 250;
/** 默认 busy 重试次数（含首次尝试）；总预算 = attempts × busyTimeoutMs。 */
export const DEFAULT_BUSY_RETRY_ATTEMPTS = 3;
/** busy 预算上限：防止调用方配置出事实上的无限等待。 */
export const MAX_BUSY_TIMEOUT_MS = 60_000;
export const MAX_BUSY_RETRY_ATTEMPTS = 16;

export interface SqliteStorageSessionOptions {
  /** 受控数据根下的数据库文件位置（显式传入；空路径拒绝隐式临时库）。 */
  readonly path: string;
  /** 单次 busy 等待预算（毫秒），整数且 0 ≤ v ≤ MAX_BUSY_TIMEOUT_MS；默认 250。 */
  readonly busyTimeoutMs?: number;
  /** busy 重试次数（含首次尝试），整数且 1 ≤ v ≤ MAX_BUSY_RETRY_ATTEMPTS；默认 3。 */
  readonly busyRetryAttempts?: number;
}

/** 现场查询得到的 PRAGMA 实际值快照（每次调用重新查询，不是打开时缓存）。 */
export interface SqlitePragmaSnapshot {
  readonly foreignKeysEnabled: boolean;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly busyTimeoutMs: number;
}

export interface SqliteStorageSession {
  /** 打开时显式传入的数据库文件位置（受控路径）。 */
  readonly path: string;
  /**
   * 底层 better-sqlite3 句柄：仅供 adapters 层内部与装配/测试诊断使用；
   * 公共端口契约不得暴露该类型。
   */
  readonly database: Database.Database;
  /** 本会话生效的 busy 预算参数（打开时校验并写入 busy_timeout PRAGMA）。 */
  readonly busyTimeoutMs: number;
  readonly busyRetryAttempts: number;
  /** 会话当前是否仍处于打开状态。 */
  isOpen(): boolean;
  /** 现场查询 PRAGMA 实际值；会话已关闭时抛出明确错误。 */
  pragmaSnapshot(): SqlitePragmaSnapshot;
  /**
   * 短同步写事务（BEGIN IMMEDIATE … COMMIT/ROLLBACK）：
   * - fn 必须同步返回；返回 thenable 时回滚事务并抛出 TypeError（无半提交）；
   * - fn 抛错时整组回滚并把原错误继续抛出；
   * - 争用写锁时在有限 busy 预算内重试，耗尽后抛 StorageError(kind='busy')；
   * - 事务内禁止文件流、SDK、Git、网络或长检查（设计 03 §3，契约约束）。
   * operation 为结构化错误的操作名（如 'state.create_project'），不得包含敏感数据。
   */
  transactWrite<T>(operation: string, fn: (db: Database.Database) => T): T;
  /** 关闭连接；幂等，重复调用安全。 */
  close(): void;
}

function validateBudget(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(
      `openSqliteStorageSession: ${name} 必须是 [${min}, ${max}] 内的有限整数，实际收到：${String(value)}`,
    );
  }
  return value;
}

function readPragmaSnapshot(db: Database.Database): SqlitePragmaSnapshot {
  return {
    foreignKeysEnabled: db.pragma('foreign_keys', { simple: true }) === 1,
    journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
    busyTimeoutMs: Number(db.pragma('busy_timeout', { simple: true })),
  };
}

/** 应用固定 PRAGMA 策略并核验实际值；任何失败都向上抛出（由调用方负责关闭句柄）。 */
function applyAndVerifyPragmas(db: Database.Database, busyTimeoutMs: number): void {
  db.pragma(`foreign_keys = ${SQLITE_PRAGMA_POLICY.foreignKeys}`);
  db.pragma(`journal_mode = ${SQLITE_PRAGMA_POLICY.journalMode.toUpperCase()}`);
  db.pragma(`synchronous = ${SQLITE_PRAGMA_POLICY.synchronous}`);
  // busyTimeoutMs 已校验为有限整数，插值不构成注入面（PRAGMA 不支持参数绑定）。
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  const snapshot = readPragmaSnapshot(db);
  const mismatches: string[] = [];
  if (!snapshot.foreignKeysEnabled) {
    mismatches.push('foreign_keys 未启用');
  }
  if (snapshot.journalMode !== SQLITE_PRAGMA_POLICY.journalMode) {
    mismatches.push(`journal_mode 实际为 ${snapshot.journalMode}`);
  }
  if (snapshot.synchronous !== SQLITE_PRAGMA_POLICY.synchronousValue) {
    mismatches.push(`synchronous 实际为 ${snapshot.synchronous}`);
  }
  if (snapshot.busyTimeoutMs !== busyTimeoutMs) {
    mismatches.push(`busy_timeout 实际为 ${snapshot.busyTimeoutMs}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`openSqliteStorageSession: PRAGMA 策略核验失败——${mismatches.join('；')}`);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** better-sqlite3 的 SqliteError 带 code 字段；busy 族（含 _SNAPSHOT 等子码）按前缀识别。 */
function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('SQLITE_BUSY')
  );
}

const ASYNC_CALLBACK_MESSAGE =
  'transactWrite 回调必须同步返回；拒绝 async/Promise 回调（事务已回滚，无半提交）。' +
  '事务内禁止文件流、SDK、Git、网络或长检查';

/**
 * 打开并装配一个受 PRAGMA 策略约束的 SQLite 存储会话。
 *
 * - 参数校验先于任何文件创建；打开或 PRAGMA 核验失败的路径关闭句柄并抛出，
 *   绝不返回半开的可写会话；
 * - import 本模块无副作用：只有调用本函数才会接触文件系统。
 */
export function openSqliteStorageSession(
  options: SqliteStorageSessionOptions,
): SqliteStorageSession {
  const busyTimeoutMs = validateBudget(
    'busyTimeoutMs',
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    0,
    MAX_BUSY_TIMEOUT_MS,
  );
  const busyRetryAttempts = validateBudget(
    'busyRetryAttempts',
    options.busyRetryAttempts ?? DEFAULT_BUSY_RETRY_ATTEMPTS,
    1,
    MAX_BUSY_RETRY_ATTEMPTS,
  );

  // openSqliteConnection 拒绝空路径；父目录不存在等打开失败由驱动抛出可识别错误。
  const connection = openSqliteConnection(options.path);
  try {
    applyAndVerifyPragmas(connection.database, busyTimeoutMs);
  } catch (error) {
    connection.close();
    throw error;
  }

  const db = connection.database;
  const assertOpen = (operation: string): void => {
    if (!connection.isOpen()) {
      throw new Error(`SQLite 存储会话已关闭，拒绝继续操作（operation: ${operation}）`);
    }
  };

  return {
    path: connection.path,
    database: db,
    busyTimeoutMs,
    busyRetryAttempts,
    isOpen(): boolean {
      return connection.isOpen();
    },
    pragmaSnapshot(): SqlitePragmaSnapshot {
      assertOpen('pragmaSnapshot');
      return readPragmaSnapshot(db);
    },
    transactWrite<T>(operation: string, fn: (db: Database.Database) => T): T {
      assertOpen(operation);
      if (typeof fn !== 'function') {
        throw new TypeError(`transactWrite(${operation}): 回调必须是函数`);
      }
      const runner = db.transaction(() => {
        const result = fn(db);
        if (isThenable(result)) {
          // 吞掉调用方 bug 产生的后续 rejection，避免 unhandled rejection 噪音；
          // 事务随即因抛出 TypeError 而整组回滚，同步部分写入不会提交。
          Promise.resolve(result).catch(() => {});
          throw new TypeError(ASYNC_CALLBACK_MESSAGE);
        }
        return result;
      });
      let lastBusy: unknown;
      for (let attempt = 1; attempt <= busyRetryAttempts; attempt += 1) {
        try {
          return runner.immediate();
        } catch (error) {
          if (isSqliteBusyError(error)) {
            lastBusy = error;
            continue;
          }
          throw error;
        }
      }
      throw new StorageError(
        'busy',
        operation,
        `SQLite 写事务在有限 busy 预算内未获得写锁（${busyRetryAttempts} 次尝试 × ${busyTimeoutMs}ms）`,
        { details: { attempts: busyRetryAttempts, busyTimeoutMs }, cause: lastBusy },
      );
    },
    close(): void {
      connection.close();
    },
  };
}
