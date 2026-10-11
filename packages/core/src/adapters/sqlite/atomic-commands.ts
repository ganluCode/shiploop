/**
 * F-007：同会话同步 SQL 原语的组合；唯一写事务由此拥有。
 * 不调用异步 StateStore/CommandReceiptStore，也不嵌套事务。
 * P02-3 / F-007 起组合基线窄存储原语（ports/baseline-store.ts 的事务面）。
 */
import type { AtomicCommandStore, CommandTransaction } from '../../ports/atomic-commands.js';
import { createSqliteBaselineAccess } from './baseline-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqlitePlanAccess } from './plan-store.js';
import type { SqliteStorageSession } from './session.js';
import { createSqliteStateAccess } from './state-store.js';
import type { SqliteStateStoreOptions } from './state-store.js';

export function createSqliteAtomicCommandStore(
  session: SqliteStorageSession,
  options: SqliteStateStoreOptions = {},
): AtomicCommandStore {
  const state = createSqliteStateAccess(session, options);
  const receipts = createSqliteCommandReceiptAccess(session, options);
  const baseline = createSqliteBaselineAccess(session, options);
  const plan = createSqlitePlanAccess(session, options);
  return {
    findReceipt: receipts.findReceiptByCommandId,
    // F-009：配置命令一致性视图的事务外只读来源；写事务内调用是编程错误。
    getGlobalSettingsOrNull() {
      if (session.database.inTransaction) {
        throw new TypeError('配置一致性快照必须在写事务之外读取');
      }
      return state.getGlobalSettingsOrNull();
    },
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
          getRepositoryBinding: guarded(state.getRepositoryBinding),
          updateProjectMetadata: guarded(state.updateProjectInTransaction),
          // F-008：命令路径新建项目时同事务写 project.registered 创建事件。
          registerProject: guarded((project: unknown, binding: unknown) =>
            state.createProjectWithBindingInTransaction(project, binding, {
              recordRegisteredEvent: true,
            })),
          // F-009：配置读写原语；创建路径同事务写 settings.*_created 创建事件
          // （P01 直接服务首建不写，契约 §15.3），更新路径复用 P01 既有 *_updated 写入。
          getGlobalSettingsOrNull: guarded(state.getGlobalSettingsOrNull),
          getProjectSettingsOrNull: guarded(state.getProjectSettingsOrNull),
          createGlobalSettings: guarded((input: unknown) =>
            state.createGlobalSettingsInTransaction(input, { recordCreatedEvent: true })),
          updateGlobalSettings: guarded((input: unknown) =>
            state.updateGlobalSettingsInTransaction(input)),
          createProjectSettings: guarded((projectId: string, input: unknown) =>
            state.createProjectSettingsInTransaction(projectId, input, { recordCreatedEvent: true })),
          updateProjectSettings: guarded((projectId: string, input: unknown) =>
            state.updateProjectSettingsInTransaction(projectId, input)),
          // P02-3 / F-007：基线原语（不可变授权/操作 CAS/检查种子与一次性收尾/
          // 全局占用/事件追加），同一 BEGIN IMMEDIATE 内原子生效。
          insertBaselineAuthorization: guarded(baseline.insertBaselineAuthorizationInTransaction),
          insertBaselineOperation: guarded(baseline.insertBaselineOperationInTransaction),
          insertBaselineCheckResults: guarded(baseline.insertBaselineCheckResultsInTransaction),
          finalizeBaselineCheckResult: guarded(baseline.finalizeBaselineCheckResultInTransaction),
          updateBaselineOperation: guarded(baseline.updateBaselineOperationInTransaction),
          acquireBaselineOccupancy: guarded(baseline.acquireBaselineOccupancyInTransaction),
          heartbeatBaselineOccupancy: guarded(baseline.heartbeatBaselineOccupancyInTransaction),
          releaseBaselineOccupancy: guarded(baseline.releaseBaselineOccupancyInTransaction),
          appendBaselineEvent: guarded(baseline.appendBaselineEventInTransaction),
          // P03-1 / F-002：计划结构原语（Phase/Feature/Task/依赖边插入；归属核验与
          // 环检测在同一事务内完成），同一 BEGIN IMMEDIATE 内原子生效。
          insertPhase: guarded(plan.insertPhaseInTransaction),
          insertFeature: guarded(plan.insertFeatureInTransaction),
          insertTask: guarded(plan.insertTaskInTransaction),
          insertTaskDependency: guarded(plan.insertTaskDependencyInTransaction),
          // P03-1 / F-004：计划域脱敏事件追加（同一 BEGIN IMMEDIATE 内原子生效）。
          appendPlanEvent: guarded(plan.appendPlanEventInTransaction),
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
