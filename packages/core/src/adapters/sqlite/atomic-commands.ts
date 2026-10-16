/**
 * F-007：同会话同步 SQL 原语的组合；唯一写事务由此拥有。
 * 不调用异步 StateStore/CommandReceiptStore，也不嵌套事务。
 * P02-3 / F-007 起组合基线窄存储原语（ports/baseline-store.ts 的事务面）。
 */
import { StorageError } from '../../ports/errors.js';
import type { AtomicCommandStore, CommandTransaction } from '../../ports/atomic-commands.js';
import { createSqliteBaselineAccess } from './baseline-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqliteExecutionAccess } from './execution-store.js';
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
  const executions = createSqliteExecutionAccess(session, options);
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
          // P02-3 / F-013：全局占用只读快照（执行启动事务内重核基线占用）。
          readBaselineOccupancy: guarded(baseline.readBaselineOccupancy),
          // P03-1 / F-002：计划结构原语（Phase/Feature/Task/依赖边插入；归属核验与
          // 环检测在同一事务内完成），同一 BEGIN IMMEDIATE 内原子生效。
          insertPhase: guarded(plan.insertPhaseInTransaction),
          insertFeature: guarded(plan.insertFeatureInTransaction),
          insertTask: guarded(plan.insertTaskInTransaction),
          insertTaskDependency: guarded(plan.insertTaskDependencyInTransaction),
          // P03-1 / F-007：纯标签 CAS 编辑（只触达 labels/revision/updated_at）。
          updatePlanEntityLabels: guarded(plan.updatePlanEntityLabelsInTransaction),
          // P03-1 / F-004：计划域脱敏事件追加（同一 BEGIN IMMEDIATE 内原子生效）。
          appendPlanEvent: guarded(plan.appendPlanEventInTransaction),
          // P03-1 / F-005：导入事务内重核原语（Phase/制品/既有任务身份，只读）。
          getPhase: guarded(plan.getPhaseInTransaction),
          getArtifactInputRef: guarded(plan.getArtifactInputRefInTransaction),
          getTaskFeatureLinks: guarded(plan.getTaskFeatureLinksInTransaction),
          // P03-1 / F-008：实质修订事务内快照读取与整体替换原语。
          getFeaturePlan: guarded(plan.getFeaturePlanInTransaction),
          replaceFeaturePlan: guarded(plan.replaceFeaturePlanInTransaction),
          // P03-2 / F-001：Task 策略副本 CAS 编辑事务内读取与写入原语。
          getTask: guarded(plan.getTaskInTransaction),
          blockTaskApproval: guarded((input: { readonly projectId: string; readonly taskId: string; readonly expectedRevision: number }) => {
            const task = plan.getTaskInTransaction(input.projectId, input.taskId);
            if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
              throw new StorageError('validation', operation, 'Invalid Task revision');
            }
            const timestamp = (options.nowUtcMs ?? Date.now)();
            const changed = session.database.prepare(`UPDATE tasks SET manual_block = 1, revision = revision + 1, updated_at = ?
              WHERE project_id = ? AND id = ? AND revision = ?`).run(timestamp, input.projectId, input.taskId, input.expectedRevision);
            if (changed.changes !== 1) throw new StorageError('conflict', operation, 'Task revision conflict', {
              details: { expectedRevision: input.expectedRevision, actualRevision: task.revision } });
            session.database.prepare(`UPDATE features SET status = 'awaiting_approval', revision = revision + 1, updated_at = ?
              WHERE project_id = ? AND id = ? AND status NOT IN ('completed', 'failed')`).run(timestamp, input.projectId, task.featureId);
            session.database.prepare(`UPDATE runs SET status = 'paused', reason = 'approval', revision = revision + 1, updated_at = ?
              WHERE project_id = ? AND feature_id = ? AND status IN ('queued', 'running', 'pausing')`).run(timestamp, input.projectId, task.featureId);
            return task.revision + 1;
          }),
          insertTaskApprovalItem: guarded(plan.insertTaskApprovalItemInTransaction),
          listTaskApprovalItems: guarded(plan.listTaskApprovalItemsInTransaction),
          decideTaskApprovalItem: guarded(plan.decideTaskApprovalItemInTransaction),
          updateTaskStrategy: guarded(plan.updateTaskStrategyInTransaction),
          // P03-2 / F-002：计划批准/拒绝决策事务内原语（重复决策重核、决策
          // 记录插入与 Feature plan_status CAS 更新），同一 BEGIN IMMEDIATE 内
          // 原子生效。
          findPlanApproval: guarded(plan.findPlanApprovalInTransaction),
          insertPlanApproval: guarded(plan.insertPlanApprovalInTransaction),
          updateFeaturePlanStatus: guarded(plan.updateFeaturePlanStatusInTransaction),
          // P03-2 / F-003：有效批准核验的事务内决策记录读取（同一权威视图）。
          listPlanApprovals: guarded(plan.listPlanApprovalsInTransaction),
          // P03-3 / F-005：执行域原语（迁移 v9 三表；同事务原子生效）。
          insertExecutionBatch: guarded(executions.insertExecutionBatchInTransaction),
          insertBatchBudgetRevision: guarded(executions.insertBatchBudgetRevisionInTransaction),
          reviseBatchBudget: guarded(executions.reviseBatchBudgetInTransaction),
          getExecutionBatch: guarded(executions.getExecutionBatchInTransaction),
          listExecutionRunsForWorkKey: guarded(executions.listExecutionRunsForWorkKeyInTransaction),
          getActiveExecutionRun: guarded(executions.getActiveExecutionRunInTransaction),
          getActivePhaseExecutionBatch: guarded(executions.getActivePhaseExecutionBatchInTransaction),
          recordExecutionRunDispatch: guarded(executions.recordExecutionRunDispatchInTransaction),
          insertExecutionRun: guarded(executions.insertExecutionRunInTransaction),
          appendExecutionEvent: guarded(executions.appendExecutionEventInTransaction),
          // P03-3 / F-006：Task 尝试预算预占与分类记账原语（迁移 v11；同一
          // BEGIN IMMEDIATE 内原子生效；受信 Core 内部面，不经命令路由暴露）。
          reserveTaskAttempt: guarded(executions.reserveTaskAttemptInTransaction),
          reclassifyTaskAttemptAsInfrastructure: guarded(
            executions.reclassifyTaskAttemptAsInfrastructureInTransaction,
          ),
          getTaskAttemptReservation: guarded(executions.getTaskAttemptReservationInTransaction),
          getTaskExecutionCounters: guarded(executions.getTaskExecutionCountersInTransaction),
          getExecutionRun: guarded(executions.getExecutionRunInTransaction),
          // P03-3 / F-007：Runtime 启动额度预占原语（迁移 v12；同一 BEGIN IMMEDIATE
          // 内原子生效；SDK 启动前的受信边界，不经命令路由暴露）。
          reserveRuntimeStart: guarded(executions.reserveRuntimeStartInTransaction),
          getRuntimeStartReservation: guarded(executions.getRuntimeStartReservationInTransaction),
          // F-008：受信结果结算与账本读取，仅在此短写事务上下文内有效。
          settleExecutionRunOutcome: guarded(executions.settleExecutionRunOutcomeInTransaction),
          getRunOutcomeSettlement: guarded(executions.getRunOutcomeSettlementInTransaction),
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
