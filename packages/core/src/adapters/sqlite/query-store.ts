/**
 * F-010 授权查询/一致读视图/事件分页窄读取端口的 SQLite 装配（adapters 层）。
 *
 * 依据 docs/p02-2-commands-events-contract.md §7/§8/§9.3：
 * - listVisibleProjects / countVisibleProjectLabels：可见范围谓词下推 SQL
 *   （先收窄再分页/计数），复用 P01 标签筛选/键集分页的同一 SQL 构建器；
 * - readProjectSnapshotView / readGlobalSnapshotView：§8 一致读视图——同一
 *   BEGIN DEFERRED 读事务内取得内容行与 MAX(state_events.sequence) 水位；
 * - listPersistedEvents：持久 state_events 是唯一事件来源，scope 谓词下推，
 *   sequence 升序、排他下界、每批有界；F-012 起 findPersistedEventSequence
 *   在同一 scope 谓词内把 Last-Event-ID 解析为持久 sequence（未命中即
 *   undefined，不区分不存在与跨 scope）。
 *
 * 全部实现共享 createSqliteStateAccess 的行映射/校验/事件原语，不另立第二套
 * 规则；import 本模块无副作用，会话生命周期由调用方管理，返回面不泄漏驱动句柄。
 */
import type { StateEventReadStore } from '../../ports/events.js';
import type { PersistedStateEventRow } from '../../ports/events.js';
import type {
  AuthorizedProjectReadStore,
  ConsistentSnapshotStore,
  FeatureApprovalsView,
  FeaturePlanView,
  PlanListRequest,
  PlanQueryReadStore,
  PlanRecordPage,
  RepositoryBindingLookupStore,
  SnapshotView,
} from '../../ports/queries.js';
import type { ExecutionBudgetQueryReadStore } from '../../ports/execution-budget-query.js';
import type {
  BatchBudgetRevisionRecord,
  ExecutionBatchRecord,
} from '../../ports/execution-store.js';
import type { ExecutionBudgetView } from '../../ports/execution-budget-query.js';
import type {
  AttemptNotificationDiagnosticRecord,
  DispatchQueuePage,
  ExecutionListRequest,
  ExecutionRecordPage,
  ExecutionScheduleQueryReadStore,
  RunScheduleView,
} from '../../ports/execution-schedule-query.js';
import type { AttemptRecord } from '../../ports/attempt-store.js';
import { createSqliteExecutionScheduleQueryStore } from './execution-schedule-query-store.js';
import { createSqliteWorkspaceQueryStore } from './workspace-query-store.js';
import type { WorkspaceQueryReadStore } from '../../ports/workspace-query.js';
import { createSqliteWorkSessionQueryStore } from './work-session-query-store.js';
import type {
  WorkSessionDetailView,
  WorkSessionQueryReadStore,
} from '../../ports/work-session-query.js';
import { createSqliteTaskEvidenceQueryStore } from './task-evidence-query-store.js';
import { createSqliteGitOperationQueryStore } from './git-operation-query-store.js';
import type { GitOperationQueryReadStore } from '../../ports/git-operation-query.js';
import type { GitOperationRecord } from '../../ports/git-operations.js';
import { createSqliteFeatureExecutionReportStore } from './feature-execution-report-store.js';
import type { FeatureExecutionReportReadStore } from '../../ports/feature-execution-report.js';
import { createSqliteFeatureDeliveryQueryStore } from './feature-delivery-query-store.js';
import type {
  FeatureDeliveryQueryReadStore,
  FeatureDeliveryView,
} from '../../ports/feature-delivery-query.js';
import { createSqliteExecutionControlQueryStore } from './execution-control-query-store.js';
import { createSqlitePlanningQueryStore } from './planning-query-store.js';
import type {
  PlanningContextListRow,
  PlanningContextQueryView,
  PlanningQueryReadStore,
} from '../../ports/planning-query.js';
import type {
  ExecutionBatchControlView,
  ExecutionControlQueryReadStore,
  ExecutionRunControlView,
  ExecutionRunRecoveryView,
} from '../../ports/execution-control-query.js';
import type {
  TaskApprovalItemRow,
  TaskEvidenceQueryReadStore,
  TaskReworkAttemptRow,
  TaskReworkView,
  TaskVerificationView,
} from '../../ports/task-evidence-query.js';
import type {
  FeatureRecord,
  PhaseRecord,
  TaskRecord,
} from '../../ports/plan-store.js';
import type { ProjectLabelCount, ProjectPage, RepositoryBindingRecord } from '../../ports/state-store.js';
import type { SqliteStorageSession } from './session.js';
import { createSqlitePlanAccess } from './plan-store.js';
import { createSqliteStateAccess } from './state-store.js';
import { createSqliteExecutionAccess } from './execution-store.js';
import type { SqliteStateStoreOptions } from './state-store.js';

/** F-010 查询读取门面：窄读取端口的并集（应用层 QueryService/OnboardingService 的消费面）；
 * P03-1 / F-006 起追加计划层级列表/详情一致读取（PlanQueryReadStore）；
 * P03-3 / F-010 起追加执行预算查询窄读取（ExecutionBudgetQueryReadStore）；
 * P03-4 / F-007 起追加调度/审计查询窄读取（ExecutionScheduleQueryReadStore）；
 * P03-5 / F-011 起追加工作区状态查询窄读取（WorkspaceQueryReadStore）；
 * P03-6 / F-011 起追加 Work Session/证据查询窄读取（WorkSessionQueryReadStore）；
 * P03-7 / F-013 起追加 Task 证据/人审/返工链窄读取（TaskEvidenceQueryReadStore）；
 * P03-8 / F-009 起追加 Git 操作查询窄读取（GitOperationQueryReadStore）；
 * P03-8 / F-010 起追加 Feature 分轴结果查询窄读取（FeatureDeliveryQueryReadStore）；
 * P03-9 / F-013 起追加 Run/Batch 控制进度与恢复诊断窄读取（ExecutionControlQueryReadStore）；
 * P05-1 / F-011 起追加规划上下文/候选查询窄读取（PlanningQueryReadStore）。 */
export interface SqliteQueryStore
  extends AuthorizedProjectReadStore,
    ConsistentSnapshotStore,
    StateEventReadStore,
    RepositoryBindingLookupStore,
    PlanQueryReadStore,
    ExecutionBudgetQueryReadStore,
    ExecutionScheduleQueryReadStore,
    WorkspaceQueryReadStore,
    WorkSessionQueryReadStore,
    TaskEvidenceQueryReadStore,
    GitOperationQueryReadStore,
    FeatureDeliveryQueryReadStore,
    FeatureExecutionReportReadStore,
    ExecutionControlQueryReadStore,
    PlanningQueryReadStore {}

export function createSqliteQueryStore(
  session: SqliteStorageSession,
  options: SqliteStateStoreOptions = {},
): SqliteQueryStore {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('createSqliteQueryStore: session 必须是 SqliteStorageSession');
  }
  const access = createSqliteStateAccess(session, options);
  const plan = createSqlitePlanAccess(
    session,
    options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs },
  );
  const execution = createSqliteExecutionAccess(
    session,
    options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs },
  );
  const schedule = createSqliteExecutionScheduleQueryStore(session);
  const workspace = createSqliteWorkspaceQueryStore(session);
  const workSessions = createSqliteWorkSessionQueryStore(session);
  const taskEvidence = createSqliteTaskEvidenceQueryStore(session);
  const gitOperations = createSqliteGitOperationQueryStore(session);
  const featureDelivery = createSqliteFeatureDeliveryQueryStore(session);
  const featureReport = createSqliteFeatureExecutionReportStore(session, featureDelivery, workSessions);
  const executionControl = createSqliteExecutionControlQueryStore(session, featureDelivery);
  const planningQueries = createSqlitePlanningQueryStore(
    session,
    options.nowUtcMs === undefined ? {} : { nowUtcMs: options.nowUtcMs },
  );
  return {
    listVisibleProjects(visibility: unknown, filter: unknown): ProjectPage {
      return access.listVisibleProjects(visibility, filter);
    },
    countVisibleProjectLabels(visibility: unknown): readonly ProjectLabelCount[] {
      return access.countVisibleProjectLabels(visibility);
    },
    readProjectSnapshotView(projectId: unknown): SnapshotView {
      return access.readProjectSnapshotView(projectId);
    },
    readGlobalSnapshotView(): SnapshotView {
      return access.readGlobalSnapshotView();
    },
    listPersistedEvents(request: unknown): readonly PersistedStateEventRow[] {
      return access.listPersistedEvents(request);
    },
    findPersistedEventSequence(request: unknown): number | undefined {
      return access.findPersistedEventSequence(request);
    },
    findBindingByCanonicalPath(canonicalPath: unknown): RepositoryBindingRecord | null {
      return access.findBindingByCanonicalPath(canonicalPath);
    },
    readPhaseRecord(phaseId: unknown): PhaseRecord | undefined {
      return plan.readPhaseRecord(phaseId);
    },
    readTaskRecord(taskId: unknown): TaskRecord | undefined {
      return plan.readTaskRecord(taskId);
    },
    readFeaturePlanView(featureId: unknown): FeaturePlanView | undefined {
      return plan.readFeaturePlanView(featureId);
    },
    readFeatureApprovalsView(featureId: unknown): FeatureApprovalsView | undefined {
      return plan.readFeatureApprovalsView(featureId);
    },
    listPhaseRecords(
      visibility: unknown,
      projectId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<PhaseRecord> {
      return plan.listPhaseRecords(visibility, projectId, request);
    },
    listFeatureRecords(
      visibility: unknown,
      projectId: unknown,
      phaseId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<FeatureRecord> {
      return plan.listFeatureRecords(visibility, projectId, phaseId, request);
    },
    listTaskRecords(
      visibility: unknown,
      projectId: unknown,
      featureId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<TaskRecord> {
      return plan.listTaskRecords(visibility, projectId, featureId, request);
    },
    readExecutionBudgetView(projectId: unknown, batchId: unknown): ExecutionBudgetView | undefined {
      return execution.readExecutionBudgetView(projectId, batchId);
    },
    findExecutionBatchRecord(projectId: unknown, batchId: unknown): ExecutionBatchRecord | undefined {
      return execution.findExecutionBatchRecord(projectId, batchId);
    },
    listBatchBudgetRevisionRecords(
      visibility: unknown,
      projectId: unknown,
      batchId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<BatchBudgetRevisionRecord> {
      return execution.listBatchBudgetRevisionRecords(visibility, projectId, batchId, request);
    },
    readRunScheduleView(projectId: unknown, runId: unknown): RunScheduleView | undefined {
      return schedule.readRunScheduleView(projectId, runId);
    },
    readAttemptRecord(projectId: unknown, attemptId: unknown): AttemptRecord | undefined {
      return schedule.readAttemptRecord(projectId, attemptId);
    },
    listTaskAttemptRecords(
      visibility: unknown,
      projectId: unknown,
      taskId: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<AttemptRecord> {
      return schedule.listTaskAttemptRecords(visibility, projectId, taskId, request);
    },
    listAttemptDiagnosticRecords(
      visibility: unknown,
      projectId: unknown,
      attemptId: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<AttemptNotificationDiagnosticRecord> {
      return schedule.listAttemptDiagnosticRecords(visibility, projectId, attemptId, request);
    },
    listDispatchQueueRecords(
      visibility: unknown,
      projectId: unknown,
      request: ExecutionListRequest,
    ): DispatchQueuePage {
      return schedule.listDispatchQueueRecords(visibility, projectId, request);
    },
    readWorkspaceDetail: (projectId: unknown, featureId: unknown) =>
      workspace.readWorkspaceDetail(projectId, featureId),
    readWorkspaceOperationView: (projectId: unknown, operationId: unknown) =>
      workspace.readWorkspaceOperationView(projectId, operationId),
    listWorkspaceRecords: (projectId: unknown, featureId: unknown, request: never) =>
      workspace.listWorkspaceRecords(projectId, featureId, request),
    listWorkspaceOperationViews: (projectId: unknown, featureId: unknown, request: never) =>
      workspace.listWorkspaceOperationViews(projectId, featureId, request),
    listWorkRecordingRows: (...args) => workSessions.listWorkRecordingRows(...args),
    readWorkRecordingArtifactRef: (...args) => workSessions.readWorkRecordingArtifactRef(...args),
    readRunRef: (projectId: unknown, runId: unknown) => workSessions.readRunRef(projectId, runId),
    listRunWorkSessions: (visibility: unknown, projectId: unknown, runId: unknown, request: ExecutionListRequest) =>
      workSessions.listRunWorkSessions(visibility, projectId, runId, request),
    listTaskWorkSessions: (visibility: unknown, projectId: unknown, taskId: unknown, request: ExecutionListRequest) =>
      workSessions.listTaskWorkSessions(visibility, projectId, taskId, request),
    readWorkSessionDetail: (projectId: unknown, attemptId: unknown): WorkSessionDetailView | undefined =>
      workSessions.readWorkSessionDetail(projectId, attemptId),
    readTaskVerificationView: (projectId: unknown, taskId: unknown): TaskVerificationView | undefined =>
      taskEvidence.readTaskVerificationView(projectId, taskId),
    listTaskApprovalItemRows: (
      visibility: unknown,
      projectId: unknown,
      taskId: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<TaskApprovalItemRow> =>
      taskEvidence.listTaskApprovalItemRows(visibility, projectId, taskId, request),
    readTaskReworkView: (projectId: unknown, taskId: unknown): TaskReworkView | undefined =>
      taskEvidence.readTaskReworkView(projectId, taskId),
    listTaskReworkAttemptRows: (
      visibility: unknown,
      projectId: unknown,
      taskId: unknown,
      request: ExecutionListRequest,
    ): ExecutionRecordPage<TaskReworkAttemptRow> =>
      taskEvidence.listTaskReworkAttemptRows(visibility, projectId, taskId, request),
    readGitOperationRecord: (projectId: unknown, operationId: unknown): GitOperationRecord | undefined =>
      gitOperations.readGitOperationRecord(projectId, operationId),
    listGitOperationRecordsByFeature: (
      visibility: unknown,
      projectId: unknown,
      featureId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<GitOperationRecord> =>
      gitOperations.listGitOperationRecordsByFeature(visibility, projectId, featureId, request),
    listGitOperationRecordsByRun: (
      visibility: unknown,
      projectId: unknown,
      runId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<GitOperationRecord> =>
      gitOperations.listGitOperationRecordsByRun(visibility, projectId, runId, request),
    readFeatureExecutionReportView: (projectId, featureId) => featureReport.readFeatureExecutionReportView(projectId, featureId),
    readFeatureDeliveryView: (projectId: unknown, featureId: unknown): FeatureDeliveryView | undefined =>
      featureDelivery.readFeatureDeliveryView(projectId, featureId),
    readRunControlView: (projectId: unknown, runId: unknown): ExecutionRunControlView | undefined =>
      executionControl.readRunControlView(projectId, runId),
    readBatchControlView: (projectId: unknown, batchId: unknown): ExecutionBatchControlView | undefined =>
      executionControl.readBatchControlView(projectId, batchId),
    readRunRecoveryView: (projectId: unknown, runId: unknown): ExecutionRunRecoveryView | undefined =>
      executionControl.readRunRecoveryView(projectId, runId),
    readPlanningContextView: (projectId: unknown, candidateId: unknown): PlanningContextQueryView | undefined =>
      planningQueries.readPlanningContextView(projectId, candidateId),
    listPlanningContextRecords: (
      visibility: unknown,
      projectId: unknown,
      featureId: unknown,
      request: PlanListRequest,
    ): PlanRecordPage<PlanningContextListRow> =>
      planningQueries.listPlanningContextRecords(visibility, projectId, featureId, request),
  };
}
