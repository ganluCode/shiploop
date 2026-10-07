/**
 * F-007：同会话同步 SQL 原语的组合；唯一写事务由此拥有。
 * 不调用异步 StateStore/CommandReceiptStore，也不嵌套事务。
 */
import type { AtomicCommandStore, CommandTransaction } from '../../ports/atomic-commands.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteStateAccess } from './state-store.js';
import type { SqliteStateStoreOptions } from './state-store.js';

export function createSqliteAtomicCommandStore(
  session: SqliteStorageSession,
  options: SqliteStateStoreOptions = {},
): AtomicCommandStore {
  const state = createSqliteStateAccess(session, options);
  const receipts = createSqliteCommandReceiptAccess(session, options);
  return {
    findReceipt: receipts.findReceiptByCommandId,
    transact<T>(operation: string, submit: (transaction: CommandTransaction) => T): T {
      // 不允许在其他事务内使用；防止 savepoint 伪装成独立原子提交。
      if (session.database.inTransaction) throw new TypeError('原子命令不能嵌套事务');
      return session.transactWrite(operation, () => {
        let active = true;
        const guarded = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
          if (!active) throw new TypeError('命令事务上下文已失效');
          return fn(...args);
        };
        const transaction: CommandTransaction = Object.freeze({
          findReceipt: guarded(receipts.findReceiptByCommandId),
          getProject: guarded(state.getProject),
          updateProjectMetadata: guarded(state.updateProjectInTransaction),
          saveReceipt: guarded(receipts.saveReceiptInTransaction),
        });
        try {
          return submit(transaction);
        } finally {
          active = false;
        }
      });
    },
  };
}
