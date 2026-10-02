/**
 * F-001 SQLite 驱动装配入口（adapters 层；better-sqlite3 只允许在本层被引用）。
 *
 * 阶段边界（P01-2 / F-001）：只固定安装驱动并建立真实测试夹具可用的最小装配；
 * 连接 PRAGMA 策略、短同步事务封装、busy 预算与迁移执行由 F-004 / F-005 实现。
 *
 * 不变量：
 * - 本模块只依赖 better-sqlite3 与 Node 内置类型，不导入 domain/application/ports 之外的层；
 * - 不在 import 时打开任何数据库（无副作用），调用方显式传入受控数据库位置；
 * - 打开失败（如父目录不存在、权限拒绝）不产生半开句柄；close 幂等，重复调用安全；
 * - 关闭后的连接拒绝继续操作，由驱动抛出可识别错误。
 */
import Database from 'better-sqlite3';

export type SqliteConnection = {
  /** 打开时显式传入的数据库文件位置（受控路径，非任意用户绝对路径）。 */
  readonly path: string;
  /**
   * 底层 better-sqlite3 句柄。仅供 adapters 层内部与装配入口使用；
   * domain/application/ports 契约不得暴露该类型（见 scripts/check-boundaries.ts）。
   */
  readonly database: Database.Database;
  /** 连接当前是否仍处于打开状态。 */
  isOpen(): boolean;
  /** 关闭连接；幂等，重复调用安全。 */
  close(): void;
};

/**
 * 在显式给定的文件位置打开一个 SQLite 数据库连接。
 *
 * - path 必须是非空字符串：空路径会让 SQLite 静默创建临时库，这里明确拒绝；
 * - 父目录不存在或不可写时驱动抛出可识别错误（SQLITE_CANTOPEN），本函数不吞错；
 * - 不在此设置 journal_mode / busy_timeout 等持久 PRAGMA，属 F-004 范围。
 */
export function openSqliteConnection(path: string): SqliteConnection {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(
      `openSqliteConnection: path 必须是非空字符串（拒绝隐式临时库），实际收到：${String(path)}`,
    );
  }
  const database = new Database(path);
  let closed = false;
  return {
    path,
    database,
    isOpen(): boolean {
      return !closed && database.open;
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },
  };
}
