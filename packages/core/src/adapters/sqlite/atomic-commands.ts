/**
 * F-007：同会话同步 SQL 原语的组合；唯一写事务由此拥有。
 * 不调用异步 StateStore/CommandReceiptStore，也不嵌套事务。
 * P02-3 / F-007 起组合基线窄存储原语（ports/baseline-store.ts 的事务面）。
 */
import { StorageError } from '../../ports/errors.js';
import type { FeatureFinalizationRecord } from '../../ports/feature-finalization.js';
import type { AtomicCommandStore, CommandTransaction } from '../../ports/atomic-commands.js';
import { createSqliteBaselineAccess } from './baseline-store.js';
import { createSqliteCommandReceiptAccess } from './command-receipts.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import { createSqliteGitOperationStore } from './git-operations.js';
import { createSqliteIntegrationPlanAccess } from './integration-plan-store.js';
import { createSqlitePlanAccess } from './plan-store.js';
import { createSqlitePlanningContextStore } from './planning-context-store.js';
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
  const gitOperations = createSqliteGitOperationStore(session, options);
  const planningContexts = createSqlitePlanningContextStore(session, options);
  const integrationPlans = createSqliteIntegrationPlanAccess(session, options);
  return {
    findReceipt: receipts.findReceiptByCommandId,
    // P03-9 / F-003：停止 operation 的持久状态/证据引用读取（不进入写事务）。
    getExecutionStopOperation(projectId, stopOperationId) {
      return executions.getExecutionStopOperationInTransaction(projectId, stopOperationId);
    },
    // F-009：配置命令一致性视图的事务外只读来源；写事务内调用是编程错误。
    getGlobalSettingsOrNull() {
      if (session.database.inTransaction) {
        throw new TypeError('配置一致性快照必须在写事务之外读取');
      }
      return state.getGlobalSettingsOrNull();
    },
    // P05-1 / F-008：候选正文预读的规划上下文。
    getPlanningContextByCandidate(projectId, candidateId) {
      return planningContexts.getPlanningContextByCandidate(projectId, candidateId);
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
        const finalizeFeatureDeliveryInTransaction = (input: unknown, transaction: CommandTransaction): FeatureFinalizationRecord => {
          if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new StorageError('validation', operation, '最终收尾输入必须是对象');
          const value = input as Record<string, unknown>;
          const required = ['projectId', 'featureId', 'batchId', 'runId', 'expectedFeatureRevision', 'expectedRunRevision', 'expectedBatchRevision', 'outcome', 'reason', 'deliveryStatus', 'operationId'];
          if (Object.keys(value).some(key => !required.includes(key))) throw new StorageError('validation', operation, '最终收尾输入包含未知字段');
          const projectId = value.projectId as string;
          const featureId = value.featureId as string;
          const batchId = value.batchId as string;
          const runId = value.runId as string;
          const outcome = value.outcome as FeatureFinalizationRecord['outcome'];
          const deliveryStatus = value.deliveryStatus as FeatureFinalizationRecord['deliveryStatus'];
          if (typeof projectId !== 'string' || typeof featureId !== 'string' || typeof batchId !== 'string' || typeof runId !== 'string' ||
            !Number.isSafeInteger(value.expectedFeatureRevision) || !Number.isSafeInteger(value.expectedRunRevision) || !Number.isSafeInteger(value.expectedBatchRevision) ||
            typeof value.reason !== 'string' || value.reason.trim().length === 0 || (value.operationId !== null && typeof value.operationId !== 'string')) {
            throw new StorageError('validation', operation, '最终收尾身份、revision 或 reason 非法');
          }
          if (!['completed', 'partial', 'failed', 'awaiting_approval'].includes(outcome) || !['not_requested', 'pending', 'succeeded', 'failed'].includes(deliveryStatus)) {
            throw new StorageError('validation', operation, '最终收尾结果非法');
          }
          if (outcome === 'completed' && deliveryStatus !== 'succeeded') throw new StorageError('validation', operation, 'completed 必须具有 succeeded deliveryStatus');
          if (outcome === 'awaiting_approval' && deliveryStatus !== 'not_requested') throw new StorageError('validation', operation, 'awaiting_approval 不得具有交付结果');
          const snapshot = plan.getFeaturePlanInTransaction(projectId, featureId);
          if (outcome === 'completed' && snapshot.tasks.some(task => task.status !== 'passed')) throw new StorageError('conflict', operation, '必需 Task 尚未全部有效通过');
          const currentRun = executions.getExecutionRunInTransaction(projectId, runId);
          const currentBatch = executions.getExecutionBatchInTransaction(projectId, batchId);
          if (currentRun.batchId !== batchId || currentRun.featureId !== featureId || currentBatch.featureId !== featureId) {
            throw new StorageError('ownership', operation, 'Feature、Run、Batch 归属不一致');
          }
          const alreadySettled = ['completed', 'partial', 'failed'].includes(snapshot.feature.status) &&
            ['succeeded', 'failed', 'cancelled'].includes(currentRun.status) &&
            ['succeeded', 'failed', 'cancelled'].includes(currentBatch.status);
          if (!alreadySettled) {
            if (snapshot.feature.revision !== value.expectedFeatureRevision || currentRun.revision !== value.expectedRunRevision || currentBatch.revision !== value.expectedBatchRevision) {
              throw new StorageError('conflict', operation, 'Feature 收尾期间身份或 revision 已变化');
            }
            const timestamp = (options.nowUtcMs ?? Date.now)();
            const runStatus = outcome === 'completed' ? 'succeeded' : outcome === 'awaiting_approval' ? 'paused' : 'failed';
            const batchStatus = runStatus;
            const featureUpdate = session.database.prepare('UPDATE features SET status = ?, delivery_status = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?').run(outcome, deliveryStatus, timestamp, projectId, featureId, value.expectedFeatureRevision);
            const runUpdate = session.database.prepare('UPDATE runs SET status = ?, reason = ?, ended_at = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND status IN (\'queued\', \'running\', \'pausing\', \'paused\')').run(runStatus, value.reason, outcome === 'awaiting_approval' ? null : timestamp, timestamp, projectId, runId, value.expectedRunRevision);
            const batchUpdate = session.database.prepare('UPDATE execution_batches SET status = ?, reason = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? AND status IN (\'queued\', \'running\', \'pausing\', \'paused\')').run(batchStatus, value.reason, timestamp, projectId, batchId, value.expectedBatchRevision);
            if (featureUpdate.changes !== 1 || runUpdate.changes !== 1 || batchUpdate.changes !== 1) throw new StorageError('conflict', operation, '最终收尾 CAS 未命中');
            executions.appendExecutionEventInTransaction({ projectId, eventType: outcome === 'completed' ? 'feature.finalized' : 'feature.finalization_blocked', aggregateType: 'feature', aggregateId: featureId, aggregateRevision: snapshot.feature.revision + 1, payload: outcome === 'completed' ? { finalized: true } : { blocked: true } });
          }
          const resultFeature = plan.getFeaturePlanInTransaction(projectId, featureId).feature;
          const resultRun = executions.getExecutionRunInTransaction(projectId, runId);
          const resultBatch = executions.getExecutionBatchInTransaction(projectId, batchId);
          const settled = ['completed', 'partial', 'failed'].includes(resultFeature.status) && ['succeeded', 'failed', 'cancelled'].includes(resultRun.status) && ['succeeded', 'failed', 'cancelled'].includes(resultBatch.status);
          return { feature: resultFeature, run: resultRun, batch: resultBatch, deliveryStatus: settled ? resultFeature.deliveryStatus : deliveryStatus, outcome: settled ? resultFeature.status as FeatureFinalizationRecord['outcome'] : outcome, reason: settled ? (resultRun.reason ?? value.reason as string) : value.reason as string, operationId: (value.operationId as string | null) ?? null };
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
          rebindRepository: guarded(state.rebindRepositoryInTransaction),
          listRepositoryBindingSnapshots: guarded(state.listRepositoryBindingSnapshots),
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
          updatePhase: guarded(plan.updatePhaseInTransaction),
          moveFeaturePhase: guarded(plan.moveFeaturePhaseInTransaction),
          updateFeatureDag: guarded(plan.updateFeatureDagInTransaction),
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
          hasTaskExecutionHistory: guarded(plan.hasTaskExecutionHistoryInTransaction),
          // P03-1 / F-008：实质修订事务内快照读取与整体替换原语。
          getFeaturePlan: guarded(plan.getFeaturePlanInTransaction),
          replaceFeaturePlan: guarded(plan.replaceFeaturePlanInTransaction),
          // P03-2 / F-001：Task 策略副本 CAS 编辑事务内读取与写入原语。
          getTask: guarded(plan.getTaskInTransaction),
          readTaskStrategyReapplicationViewInTransaction: guarded(plan.readTaskStrategyReapplicationViewInTransaction),
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
          finalizeFeatureDelivery: guarded((input: unknown) => finalizeFeatureDeliveryInTransaction(input, transaction)),
          // P03-2 / F-003：有效批准核验的事务内决策记录读取（同一权威视图）。
          listPlanApprovals: guarded(plan.listPlanApprovalsInTransaction),
          // P03-3 / F-005：执行域原语（迁移 v9 三表；同事务原子生效）。
          insertExecutionBatch: guarded(executions.insertExecutionBatchInTransaction),
          insertBatchBudgetRevision: guarded(executions.insertBatchBudgetRevisionInTransaction),
          reviseBatchBudget: guarded(executions.reviseBatchBudgetInTransaction),
          getExecutionBatch: guarded(executions.getExecutionBatchInTransaction),
          listExecutionBatchMemberFeatureIds: guarded(executions.listExecutionBatchMemberFeatureIdsInTransaction),
          listExecutionRunsForWorkKey: guarded(executions.listExecutionRunsForWorkKeyInTransaction),
          getActiveExecutionRun: guarded(executions.getActiveExecutionRunInTransaction),
          getActiveProjectExecutionRun: guarded(executions.getActiveProjectExecutionRunInTransaction),
          getActivePhaseExecutionBatch: guarded(executions.getActivePhaseExecutionBatchInTransaction),
          recordExecutionRunDispatch: guarded(executions.recordExecutionRunDispatchInTransaction),
          insertExecutionRun: guarded(executions.insertExecutionRunInTransaction),
          appendExecutionEvent: guarded(executions.appendExecutionEventInTransaction),
          // P04-9 / F-002：Run 持久入队意图（与 Run/回执/事件同一 BEGIN IMMEDIATE）。
          registerRunDispatchIntent: guarded(executions.registerRunDispatchIntentInTransaction),
          getRunDispatchIntent: guarded(executions.getRunDispatchIntentInTransaction),
          listRunDispatchIntents: guarded(executions.listRunDispatchIntentsInTransaction),
          requestExecutionPause: guarded(executions.requestExecutionPauseInTransaction),
          requestExecutionCancel: guarded(executions.requestExecutionCancelInTransaction),
          recordExecutionStopManualAction: guarded(executions.recordExecutionStopManualActionInTransaction),
          resumeExecution: guarded(executions.resumeExecutionInTransaction),
          reopenExecutionBatchForFinalizationRetry: guarded(
            executions.reopenExecutionBatchForFinalizationRetryInTransaction,
          ),
          settleExecutionStop: guarded(executions.settleExecutionStopInTransaction),
          interruptAttemptForStop: guarded(executions.interruptAttemptForStopInTransaction),
          getExecutionStopOperation: guarded(executions.getExecutionStopOperationInTransaction),
          // P03-3 / F-006：Task 尝试预算预占与分类记账原语（迁移 v11；同一
          // BEGIN IMMEDIATE 内原子生效；受信 Core 内部面，不经命令路由暴露）。
          reserveTaskAttempt: guarded(executions.reserveTaskAttemptInTransaction),
          reclassifyTaskAttemptAsInfrastructure: guarded(
            executions.reclassifyTaskAttemptAsInfrastructureInTransaction,
          ),
          settleTaskAttemptBudget: guarded(executions.settleTaskAttemptBudgetInTransaction),
          getTaskAttemptReservation: guarded(executions.getTaskAttemptReservationInTransaction),
          getTaskExecutionCounters: guarded(executions.getTaskExecutionCountersInTransaction),
          getExecutionRun: guarded(executions.getExecutionRunInTransaction),
          // P05-6 / F-002：集成计划及前置成果在同一短写事务内整体插入、冻结和结果 CAS。
          createIntegrationPlan: guarded(integrationPlans.createIntegrationPlanInTransaction),
          freezeIntegrationPlan: guarded(integrationPlans.freezeIntegrationPlanInTransaction),
          updateIntegrationPlanResult: guarded(integrationPlans.updateIntegrationPlanResultInTransaction),
          updateIntegrationPlanStatus: guarded(integrationPlans.updateIntegrationPlanStatusInTransaction),
          getIntegrationPlan: guarded(integrationPlans.getIntegrationPlanInTransaction),
          createPlanningContextInTransaction: guarded(planningContexts.createPlanningContextInTransaction),

          getActivePlanningContextForFeature: guarded(planningContexts.getActivePlanningContextForFeatureInTransaction),
          // P05-1 / F-006：规划候选受限提交的短事务重核与发布绑定原语。
          getPlanningContextByCandidate: guarded(planningContexts.getPlanningContextByCandidate),
          getPlanningContextByRun: guarded(planningContexts.getPlanningContextByRun),
          decidePlanningCandidate: guarded(planningContexts.decidePlanningCandidateInTransaction),
          publishPlanningCandidate: guarded(planningContexts.publishPlanningCandidateInTransaction),
          // P03-3 / F-007：Runtime 启动额度预占原语（迁移 v12；同一 BEGIN IMMEDIATE
          // 内原子生效；SDK 启动前的受信边界，不经命令路由暴露）。
          reserveRuntimeStart: guarded(executions.reserveRuntimeStartInTransaction),
          getRuntimeStartReservation: guarded(executions.getRuntimeStartReservationInTransaction),
          // F-008：受信结果结算与账本读取，仅在此短写事务上下文内有效。
          settleExecutionRunOutcome: guarded(executions.settleExecutionRunOutcomeInTransaction),
          getRunOutcomeSettlement: guarded(executions.getRunOutcomeSettlementInTransaction),
          // P03-8 / F-002：Git 意图/回执（迁移 v26；同一 BEGIN IMMEDIATE 内）。
          getGitOperation: guarded((projectId: string, operationId: string) =>
            gitOperations.getGitOperationInTransaction(transaction, projectId, operationId)),
          registerGitOperation: guarded((input: unknown) =>
            gitOperations.registerGitOperationInTransaction(transaction, input)),
          finalizeGitOperation: guarded((input: unknown) =>
            gitOperations.finalizeGitOperationInTransaction(transaction, input)),
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
