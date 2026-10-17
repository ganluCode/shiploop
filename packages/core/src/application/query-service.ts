/**
 * F-010 QueryService（application 层）：授权项目/配置查询、一致读视图快照
 * 水位与分页事件读取（docs/p02-2-commands-events-contract.md §4/§7/§8/§9.3）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（AuthorizedProjectReadStore / ConsistentSnapshotStore /
 *   StateEventReadStore / StateStore 只读子集 / ConfigurationService 查询切片）
 *   与 F-005 纯授权判定；不接触适配器、驱动、HTTP 或 Pi SDK；import 本模块
 *   无副作用，装配时不执行任何 I/O；
 * - 授权在 Core 应用层执行（不经 HTTP 也拒绝）：能力核验先于数据库读取；
 *   不可见项目与不存在项目对调用方统一 forbidden（mapProjectLookupError
 *   折算，不回显 projectId）；全局配置/全局事件独立授权（settings.global.read，
 *   项目能力不蕴含）；项目配置读 = project.read 或 settings.project.read；
 * - 可见范围谓词随端口下推 SQL（先收窄再分页/计数），事件行级可见过滤器
 *   （F-005 createEventVisibilityFilter）作为防御纵深复核：SQL 结果与谓词
 *   不一致是适配器编程错误（TypeError），绝不静默跳过；
 * - 快照内容（项目/绑定/当前配置/有效配置/水位）取自 ConsistentSnapshotStore
 *   的同一 SQLite 一致读视图：水位是该视图内的 MAX(state_events.sequence)，
 *   禁止多次独立读取后随手拼水位；有效配置（含全局来源 revision）由同一
 *   视图记录经 F-009 mergeEffectiveSettings 纯函数合并；
 * - 查询全部只读：不写 state_events、不创建任何行、不解析凭据引用、不执行
 *   脚本、不接受任意文件路径参数；无配置是明确结果（configured:false /
 *   not_found），损坏持久 JSON/未知版本为 corrupt_state，绝不降级成「已配置」；
 * - 事件读取：游标经 F-003 decodeEventCursor 绑定数据根身份与 scope（坏游标
 *   invalid_input(invalid_cursor)，绝不当从零读取；未来游标合法）；事件按
 *   sequence 升序有界分页（默认 100/上限 500），eventId 供客户端去重；持久
 *   行列经 mapStateEvents 白名单映射（损坏/未知类型显式 corrupt_state）；
 * - principal 形状非法属于可信装配编程错误（TypeError），不折算客户端错误；
 *   其余错误经 mapToPublicError 脱敏映射（不回显路径/payload 原文/堆栈）。
 */
import {
  assertTrustedPrincipal,
  authorizeEventSubscription,
  authorizeGlobalSettingsRead,
  authorizeProjectLabelCounts,
  authorizeProjectRead,
  authorizeProjectSettingsRead,
  authorizeProjectsList,
  authorizeSnapshot,
  createEventVisibilityFilter,
  isProjectVisible,
  mapProjectLookupError,
  principalProjectVisibility,
  requireCapability,
  requireProjectVisible,
} from '../ports/authorization.js';
import {
  PublicError,
  WIRE_MESSAGE_SCHEMA_VERSION,
  isUuidV4,
  mapToPublicError,
} from '../ports/commands.js';
import {
  createEventCursorBinding,
  createEventWatermark,
  decodeEventCursor,
  encodeEventCursor,
  mapStateEvents,
  normalizeMaxEventSequence,
  validateEventPageLimit,
  validateEventScope,
} from '../ports/events.js';
import type {
  EventCursorBinding,
  PublicEventScope,
  PublicStateEvent,
} from '../ports/events.js';
import {
  createPlanListCursorBinding,
  decodePlanListCursor,
  deriveFeatureNotExecutableReasons,
  encodePlanListCursor,
  PLAN_APPROVAL_QUERY_OPERATION,
  toPublicFeatureRecord,
  toPublicPhaseRecord,
  toPublicPlanApprovalRecord,
  toPublicProjectRecord,
  toPublicRepositoryBindingRecord,
  toPublicSettingsState,
  toPublicTaskDependencyEdge,
  toPublicTaskRecord,
  validatePlanListFilter,
} from '../ports/queries.js';
import type {
  AuthorizedProjectReadStore,
  ConsistentSnapshotStore,
  FeatureApprovalsResult,
  FeatureDetailResult,
  FeatureListResult,
  FeaturePlanValidationSummary,
  PlanListCursorBinding,
  PlanListScope,
  PlanListRequest,
  PlanQueryReadStore,
  ValidatedPlanListFilter,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  PublicSettingsState,
  PhaseDetailResult,
  PhaseListResult,
  TaskDetailResult,
  TaskListResult,
} from '../ports/queries.js';
import type { StateEventReadStore } from '../ports/events.js';
import { isStorageError } from '../ports/errors.js';
import type { SettingsScope } from '../ports/settings-schema.js';
import { validateProjectListFilter } from '../ports/state-store.js';
import type { StateStore } from '../ports/state-store.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import {
  requirePlainObject,
  rejectUnknownKeys,
} from '../ports/validation.js';
import type { ConfigurationService } from './configuration-service.js';
import type { ExportedSettings } from './configuration-service.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import type { EffectiveSettings } from './effective-settings.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { resolveCurrentCheckPolicyDigest } from './plan-approval-verification.js';
import type { EventWatermark } from '../ports/events.js';
import {
  EXECUTION_BUDGET_GET_OPERATION,
  EXECUTION_BUDGET_REVISIONS_OPERATION,
  buildExecutionBudgetStatus,
  toPublicBatchBudgetRevisionRecord,
} from '../ports/execution-budget-query.js';
import type {
  BudgetRevisionListResult,
  ExecutionBudgetQueryReadStore,
  ExecutionBudgetStatusResult,
} from '../ports/execution-budget-query.js';
import {
  EXECUTION_ATTEMPT_DIAGNOSTICS_OPERATION,
  EXECUTION_ATTEMPTS_LIST_OPERATION,
  EXECUTION_RUN_SCHEDULE_OPERATION,
  decodeExecutionListKey,
  encodeExecutionListKey,
  toPublicAttemptDiagnosticRecord,
  toPublicAttemptRecord,
} from '../ports/execution-schedule-query.js';
import type {
  AttemptDiagnosticsResult,
  AttemptListResult,
  ExecutionScheduleQueryReadStore,
  PublicScheduleTaskView,
  RunScheduleEvaluation,
  RunScheduleStatusResult,
} from '../ports/execution-schedule-query.js';
import {
  createWorkspaceListCursorBinding,
  decodeWorkspaceListCursor,
  encodeWorkspaceListCursor,
  toPublicWorkspaceOperationRecord,
  toPublicWorkspaceRecord,
  validateWorkspaceListFilter,
  type WorkspaceDetailResult,
  type WorkspaceListResult,
  type WorkspaceOperationDetailResult,
  type WorkspaceOperationListResult,
  type WorkspaceQueryReadStore,
} from '../ports/workspace-query.js';
import {
  EXECUTION_WORK_SESSION_EVIDENCE_OPERATION,
  EXECUTION_WORK_SESSION_GET_OPERATION,
  EXECUTION_WORK_SESSIONS_LIST_OPERATION,
  WORK_SESSION_EVIDENCE_MAX_READ_BYTES,
  WORK_SESSION_SETTLEMENT_MAX_READ_BYTES,
  deriveWorkSessionQueryState,
  isWorkSessionEvidenceLocator,
  toPublicWorkSessionAttempt,
  toPublicWorkSessionEvidenceRef,
  toPublicWorkSessionRecord,
  toPublicWorkSessionResultEvidence,
  toPublicWorkSessionSummary,
  validateWorkSessionListSelector,
  validateWorkSessionResultEvidence,
  type PublicWorkSessionResultEvidence,
  type WorkSessionDetailResult,
  type WorkSessionEvidenceContent,
  type WorkSessionListResult,
  type WorkSessionQueryReadStore,
} from '../ports/work-session-query.js';
import {
  GIT_OPERATIONS_LIST_OPERATION,
  GIT_OPERATION_GET_OPERATION,
  toPublicGitOperationRecord,
  validateGitOperationListSelector,
  type GitOperationDetailResult,
  type GitOperationListResult,
  type GitOperationQueryReadStore,
} from '../ports/git-operation-query.js';
import {
  FEATURE_DELIVERY_GET_OPERATION,
  buildFeatureDeliveryDetailResult,
  type FeatureDeliveryDetailResult,
  type FeatureDeliveryQueryReadStore,
} from '../ports/feature-delivery-query.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import { createArtifactVerifier } from './artifact-verify.js';
import type { AttemptRecord } from '../ports/attempt-store.js';
import { evaluateTaskDag } from './task-dag.js';
import {
  TASK_APPROVAL_ITEMS_LIST_OPERATION,
  TASK_REWORK_CHAIN_LIST_OPERATION,
  TASK_VERIFICATION_GET_OPERATION,
  buildReworkAttemptTotals,
  buildReworkCodeEligibility,
  deriveTaskMachineConclusion,
  toPublicReworkAttemptRecord,
  toPublicReworkRunView,
  toPublicTaskApprovalItemRecord,
  toPublicTaskEvidenceState,
  toPublicVerificationBatchRecord,
} from '../ports/task-evidence-query.js';
import type {
  PublicReworkSuccessorView,
  TaskApprovalItemListResult,
  TaskEvidenceQueryReadStore,
  TaskReworkChainListResult,
  TaskVerificationDetailResult,
} from '../ports/task-evidence-query.js';

/** 分页事件读取结果（Core 内部面；F-012 SSE 补读复用）。 */
export interface StateEventPage {
  readonly scope: PublicEventScope;
  readonly events: readonly PublicStateEvent[];
  /** 本页用满 limit 时为最后一事件之后的不透明续读游标；否则 null（页末明确）。 */
  readonly nextCursor: string | null;
  readonly limit: number;
}

/** F-012 SSE 建连恢复位置（§9.4）：授权后经游标或 Last-Event-ID 解析。 */
export interface EventResumePosition {
  readonly scope: PublicEventScope;
  /** 排他下界：从 sequence > afterSequence 的已提交事件开始补读。 */
  readonly afterSequence: number;
  /** 同一位置的不透明续读游标（绑定数据根与 scope，供客户端落盘恢复）。 */
  readonly resumeCursor: string;
}

/** F-012 SSE 轮询补读批次（Host 可信传输面自持位置，不来自客户端字段）。 */
export interface StateEventBatch {
  readonly scope: PublicEventScope;
  readonly events: readonly PublicStateEvent[];
  /** 本批最后一事件的 sequence；空批等于请求的 afterSequence（位置不后退）。 */
  readonly lastSequence: number;
  readonly limit: number;
}

interface SnapshotBase {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly watermark: EventWatermark;
  /** 快照装配时刻（ISO UTC；注入时钟）。 */
  readonly readAt: string;
}

/** §8 项目快照：项目 + 绑定（无则 null）+ 项目当前配置（无则 null）+ 有效配置 + 水位。 */
export interface ProjectSnapshotResult extends SnapshotBase {
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly project: ReturnType<typeof toPublicProjectRecord>;
  readonly binding: ReturnType<typeof toPublicRepositoryBindingRecord> | null;
  readonly settings: PublicSettingsState | null;
  readonly effective: EffectiveSettings;
}

/** §8 全局快照：全局当前配置（无则 null）+ 水位。 */
export interface GlobalSnapshotResult extends SnapshotBase {
  readonly scope: { readonly kind: 'global' };
  readonly settings: PublicSettingsState | null;
}

export type SnapshotResult = ProjectSnapshotResult | GlobalSnapshotResult;

/**
 * 授权查询服务：项目/绑定/配置/快照/事件。principal 由可信装配显式传入
 * （生产固定 local-owner；受限主体仅测试装配），本服务绝不从请求数据取身份。
 */
export interface QueryService {
  /** projects.list：project.read + 可见谓词下推 + P01 标签/分页规则。 */
  listProjects(principal: unknown, filter?: unknown): Promise<ProjectListResult>;
  /** projects.labelCounts：与列表同一可见范围的项目层标签去重计数。 */
  countProjectLabels(principal: unknown): Promise<ProjectLabelCountsResult>;
  /** projects.get：项目 + 绑定一次授权组装（无绑定 binding:null）。 */
  getProject(principal: unknown, projectId: unknown): Promise<ProjectDetailResult>;
  /** projects.binding.get：无绑定 not_found（entityType repository_binding）。 */
  getRepositoryBinding(principal: unknown, projectId: unknown): Promise<ProjectBindingResult>;
  /** settings.global.get：settings.global.read 独立授权；缺失 not_found。 */
  getGlobalSettings(principal: unknown): Promise<PublicSettingsState>;
  /** settings.project.get：project.read 或 settings.project.read + 目标可见。 */
  getProjectSettings(principal: unknown, projectId: unknown): Promise<PublicSettingsState>;
  /** settings.project.effective：P01 有效配置合并与逐项来源；configured:false 明确未配置。 */
  getEffectiveSettings(principal: unknown, projectId: unknown): Promise<EffectiveSettings>;
  /** settings.global.export：P01 脱敏导出（引用原样、不解析）。 */
  exportGlobalSettings(principal: unknown): Promise<ExportedSettings>;
  /** settings.project.export：同上，项目 scope。 */
  exportProjectSettings(principal: unknown, projectId: unknown): Promise<ExportedSettings>;
  /** snapshot.get：同一 SQLite 一致读视图 + 事件水位（游标绑定数据根与 scope）。 */
  getSnapshot(principal: unknown, scope: unknown): Promise<SnapshotResult>;
  /**
   * 事件分页读取（F-012 SSE 补读复用）：events.read + 范围读能力授权；
   * 游标必填（缺失 cursor_required），非法/跨根/跨 scope 一律 invalid_cursor。
   */
  listEvents(principal: unknown, input: unknown): Promise<StateEventPage>;
  /**
   * F-012 SSE 建连恢复解析（§9.4）：events.read + 范围读能力授权先于任何
   * 读取；恢复位置按契约优先级 Last-Event-ID → cursor；两者皆缺
   * cursor_required；Last-Event-ID 在当前 scope 内解析不到（不存在或属于
   * 其他 scope，不区分）→ invalid_input(unknown_event_id)；非法游标
   * invalid_cursor，绝不当从零读取；未来游标合法（等待是订阅方策略）。
   */
  resolveEventResume(principal: unknown, input: unknown): Promise<EventResumePosition>;
  /**
   * F-012 SSE 轮询补读：Host 可信传输面自持的排他下界（绝非客户端字段）+
   * 有界分页；每次调用重新核验当前授权（能力/可见性撤销即拒绝）。
   */
  readEventBatch(principal: unknown, input: unknown): Promise<StateEventBatch>;
  /**
   * F-006 phases.get：按 Phase ID 查询（真实父级 projectId、标题/描述/标签/
   * revision）；能力 + 可见性先行，不可见与不存在统一 not_found。
   */
  getPhase(principal: unknown, phaseId: unknown): Promise<PhaseDetailResult>;
  /**
   * F-006 features.get：Feature 详情（真实父级、planDigest/planStatus/不可执行
   * 原因）与完整同 Feature Task DAG（节点 + 依赖边）；内容取自同一一致读视图，
   * 不虚构 Run/Attempt 结果。
   */
  getFeature(principal: unknown, featureId: unknown): Promise<FeatureDetailResult>;
  /**
   * P03-2 / F-002 features.approvals：Feature 计划审批决策查询（当前决定 vs
   * 历史决定按 planDigest 绑定区分；feature.planStatus 为权威审批状态，拒绝
   * 后绝非 approved）。能力位复用 project.read；Host 传输接线属 F-007。
   */
  getFeatureApprovals(principal: unknown, featureId: unknown): Promise<FeatureApprovalsResult>;
  /** F-006 tasks.get：Task 详情（真实父级、验收/需求引用/策略副本及来源）。 */
  getTask(principal: unknown, taskId: unknown): Promise<TaskDetailResult>;
  /**
   * P03-3 / F-010 execution.budget.get：执行预算只读查询（一致读视图：固定
   * 单 Feature 范围、Batch/Run 身份、各层上限、已用/剩余、绝对 deadline、
   * 无进展次数与阻塞原因）；能力位 project.read；跨项目/不存在目标统一
   * not_found（不泄漏存在性）；查询零写入、零事件、零唤醒。
   */
  getExecutionBudgetStatus(principal: unknown, input: unknown): Promise<ExecutionBudgetStatusResult>;
  /**
   * P03-3 / F-010 execution.budget.revisions：预算修订历史（复用计划分页的
   * 有界 limit/受控游标规则；游标绑定数据根 + 项目 + Batch，跨批次/跨项目
   * 重放 invalid_cursor；非法分页与跨项目目标拒绝且不泄漏存在性）。
   */
  listBatchBudgetRevisions(principal: unknown, input: unknown): Promise<BudgetRevisionListResult>;
  /**
   * P03-4 / F-007 execution.run.schedule：Run 调度原因与 Task 派生就绪视图
   * （同一 evaluateTaskDag 就绪规则从一致读视图派生；逐任务 blocked 原因、
   * 稳定候选顺序、最近 Attempt executionStage 与占用 held/quarantined 审计）。
   * 能力位 project.read；跨项目/不存在目标统一 not_found；查询零写入、
   * 零事件、零续租；ready/blocked 不落库为第二套可写 Task 状态。
   */
  getRunScheduleStatus(principal: unknown, input: unknown): Promise<RunScheduleStatusResult>;
  /**
   * P03-4 / F-007 execution.attempts.list：Task 的 Attempt 审计分页（关联
   * 身份/围栏身份/executionStage/已知退出与耗时原样保留，未知为 null；
   * 不含 inputSnapshot 正文；复用计划分页的有界 limit/受控游标规则，
   * 游标绑定数据根 + 项目 + Task，跨项目/跨 Task 重放 invalid_cursor）。
   */
  listExecutionAttempts(principal: unknown, input: unknown): Promise<AttemptListResult>;
  /**
   * P03-4 / F-007 execution.attempt.diagnostics：Attempt 迟到/越权通知诊断
   * 审计分页（只含同项目 Attempt 链接、摘要、固定原因与时间；复用同一
   * 分页/游标规范，游标绑定数据根 + 项目 + Attempt）。
   */
  listAttemptDiagnostics(principal: unknown, input: unknown): Promise<AttemptDiagnosticsResult>;
  /** F-006 phases.list：项目内 Phase 层级列表（稳定排序、有限分页、受控游标）。 */
  listPhases(principal: unknown, input: unknown): Promise<PhaseListResult>;
  /** F-006 features.list：Phase 内 Feature 层级列表（游标绑定项目 + 父级）。 */
  listFeatures(principal: unknown, input: unknown): Promise<FeatureListResult>;
  /** F-006 tasks.list：Feature 内 Task 层级列表（游标绑定项目 + 父级）。 */
  listTasks(principal: unknown, input: unknown): Promise<TaskListResult>;
  /**
   * P03-5 / F-011 workspaces.list：项目（可选 Feature 过滤）工作区列表，
   * 稳定 id 排序、有界分页、wscur_v1_ 游标绑定数据根 + 项目 + Feature。
   */
  listWorkspaces(principal: unknown, input: unknown): Promise<WorkspaceListResult>;
  /** P03-5 / F-011 workspaces.get：按 Feature 的工作区详情（含准备/最新 operation）。 */
  getWorkspace(principal: unknown, input: unknown): Promise<WorkspaceDetailResult>;
  /** P03-5 / F-011 workspace.operations.list：项目（可选 Feature 过滤）操作审计分页。 */
  listWorkspaceOperations(principal: unknown, input: unknown): Promise<WorkspaceOperationListResult>;
  /** P03-5 / F-011 workspace.operations.get：按 operationId 的操作详情（含回执引用）。 */
  getWorkspaceOperation(principal: unknown, input: unknown): Promise<WorkspaceOperationDetailResult>;
  /**
   * P03-6 / F-011 execution.sessions.list：按 Run 或 Task 的顶层 Work Session
   * 分页（kind='work'，Chat 不混入；实际 runtime/executionStage/最后活动/结果
   * 引用/停止时间来自持久一致读视图；复用计划分页的有界 limit/受控游标规则，
   * 游标绑定数据根 + 项目 + 父级，跨项目/跨父级重放 invalid_cursor）。
   */
  listWorkSessions(principal: unknown, input: unknown): Promise<WorkSessionListResult>;
  /**
   * P03-6 / F-011 execution.session.get：按 Attempt 的 Session 详情（Session
   * 记录、executionStage、输入身份、最后活动、占用及证据引用索引 + 经完整性
   * 核验的结果证据投影；usage.basis 原样保留——synthetic 显式标记；执行完成
   * 等待验证与执行不确定分别展示；启动前拒绝场景 Session 为 null）。
   */
  getWorkSession(principal: unknown, input: unknown): Promise<WorkSessionDetailResult>;
  /**
   * P03-6 / F-011 execution.session.evidence.get：Session/Attempt 受控 locator
   * 前缀内 ready 诊断制品的授权正文读取（复用既有 ArtifactVerifier 的
   * hash/size 核验与错误映射；未知/跨项目/非成员/非 ready 统一 not_found
   * 防枚举；绝不接受任意文件路径；查询零写入、零续租）。
   */
  readWorkSessionEvidence(principal: unknown, input: unknown): Promise<WorkSessionEvidenceContent>;
  /**
   * P03-7 / F-013 execution.task.verification.get：Task 当前机器结论 +
   * 有界 VerificationBatch/CheckResult（选择/回退理由、代码身份、输出
   * Artifact/tail 引用）；机器 passed 不展示为有效 Task passed。
   */
  getTaskVerification(principal: unknown, input: unknown): Promise<TaskVerificationDetailResult>;
  /**
   * P03-7 / F-013 execution.task.approvals.list：独立人审事项分页（事项、
   * 责任主体、绑定摘要与决定；与机器证据分开，不混为一谈）。
   */
  listTaskApprovalItems(principal: unknown, input: unknown): Promise<TaskApprovalItemListResult>;
  /**
   * P03-7 / F-013 execution.task.rework-chain.list：有限返工链分页（历次
   * Attempt 与失败引用、代码资格已用/剩余、总预算阻止原因、Run 暂停原因与
   * 后继 blocked 原因；未知退出/耗时保持 null）。
   */
  listTaskReworkChain(principal: unknown, input: unknown): Promise<TaskReworkChainListResult>;
  /**
   * P03-8 / F-009 git.operations.list：同项目 Feature 或 Run 的 Git 意图/实际
   * 提交/操作回执分页（父级二选一；稳定 id 排序、有界分页、plcur_v1_ 游标
   * 绑定数据根 + 项目 + 父级，跨父级/跨项目重放 invalid_cursor）。
   */
  listGitOperations(principal: unknown, input: unknown): Promise<GitOperationListResult>;
  /**
   * P03-8 / F-009 git.operations.get：按 operationId 的完整意图 + 实际事实 +
   * 回执投影；跨项目/不存在统一 not_found；待核对/回执缺失不显示为成功。
   */
  getGitOperation(principal: unknown, input: unknown): Promise<GitOperationDetailResult>;
  /**
   * P03-8 / F-010 features.delivery.get：Feature 分轴结果查询——全部必需
   * Task 当前有效结果与历史引用、独立 Feature VerificationBatch 及逐检查
   * 状态、最终审批/阻塞、Git operation 与 deliveryStatus；completed 不掩盖
   * 缺失证据或其他轴失败；五类关键场景为可区分结构化 outcome（失败阶段
   * 使用 executionStage，附身份/原因码/显式下一步，不暗示自动重跑编码）。
   * 能力位 project.read；跨项目/不存在统一 not_found；结果从持久一致读
   * 视图重建，查询零写入、零事件，重复读取不增加计数。
   */
  getFeatureDelivery(principal: unknown, input: unknown): Promise<FeatureDeliveryDetailResult>;
}

export interface QueryServiceOptions {
  /** F-010 可见谓词下推的项目列表/计数窄读取端口。 */
  readonly projectReads: AuthorizedProjectReadStore;
  /** F-010 §8 一致读视图窄端口。 */
  readonly snapshots: ConsistentSnapshotStore;
  /** F-010 持久事件分页读取窄端口。 */
  readonly eventReads: StateEventReadStore;
  /** P01 StateStore 只读子集（项目/绑定详情读取）。 */
  readonly stateStore: Pick<StateStore, 'getProject' | 'getRepositoryBinding'>;
  /** P01 配置服务查询切片（当前值/有效配置/脱敏导出）。 */
  readonly configurationService: Pick<
    ConfigurationService,
    'getCurrentSettings' | 'getEffectiveSettings' | 'exportSettings'
  >;
  /** P03-1 / F-006 计划层级列表/详情一致读取窄端口。 */
  readonly planReads: PlanQueryReadStore;
  /** P03-3 / F-010 执行预算查询一致读取窄端口（只读）。 */
  readonly executionBudgetReads: ExecutionBudgetQueryReadStore;
  /** P03-4 / F-007 Run 调度/Attempt/占用审计查询一致读取窄端口（只读）。 */
  readonly scheduleReads: ExecutionScheduleQueryReadStore;
  /** P03-5 / F-011 工作区状态查询一致读取窄端口（只读；脱敏投影在端口层）。 */
  readonly workspaceReads: WorkspaceQueryReadStore;
  /** P03-6 / F-011 Work Session/证据查询一致读取窄端口（只读）。 */
  readonly workSessionReads: WorkSessionQueryReadStore;
  /** P03-7 / F-013 Task 证据/人审/返工链一致读取窄端口（只读）。 */
  readonly taskEvidenceReads: TaskEvidenceQueryReadStore;
  /** P03-8 / F-009 Git 操作查询一致读取窄端口（只读）。 */
  readonly gitOperationReads: GitOperationQueryReadStore;
  /** P03-8 / F-010 Feature 分轴结果查询一致读取窄端口（只读）。 */
  readonly featureDeliveryReads: FeatureDeliveryQueryReadStore;
  /** P03-6 / F-011 证据制品索引（正文经完整性核验读取；只读用法）。 */
  readonly artifacts: ArtifactStore;
  /** P03-6 / F-011 证据制品文件（只读用法；不推导任意路径）。 */
  readonly artifactFiles: ArtifactFileStore;
  /** 数据根身份（64hex；可信装配由 realpath 数据根派生，绝不来自请求数据）。 */
  readonly dataRootIdentity: string;
  /** UTC 毫秒时钟（默认 Date.now）；测试注入以获得确定性 readAt。 */
  readonly nowUtcMs?: () => number;
}

const PROJECTS_LIST_OPERATION = 'projects.list';
const PROJECTS_LABEL_COUNTS_OPERATION = 'projects.labelCounts';
const PROJECTS_GET_OPERATION = 'projects.get';
const PROJECTS_BINDING_GET_OPERATION = 'projects.binding.get';
const SETTINGS_GLOBAL_GET_OPERATION = 'settings.global.get';
const SETTINGS_PROJECT_GET_OPERATION = 'settings.project.get';
const SETTINGS_PROJECT_EFFECTIVE_OPERATION = 'settings.project.effective';
const SETTINGS_GLOBAL_EXPORT_OPERATION = 'settings.global.export';
const SETTINGS_PROJECT_EXPORT_OPERATION = 'settings.project.export';
const SNAPSHOT_GET_OPERATION = 'snapshot.get';
const EVENTS_SUBSCRIBE_OPERATION_NAME = 'events.subscribe';
// P03-1 / F-006 计划查询操作身份（与 ports/queries.ts PLAN_QUERY_OPERATIONS 同源）。
const PHASES_LIST_OPERATION = 'phases.list';
const PHASES_GET_OPERATION = 'phases.get';
const FEATURES_LIST_OPERATION = 'features.list';
const FEATURES_GET_OPERATION = 'features.get';
const TASKS_LIST_OPERATION = 'tasks.list';
const TASKS_GET_OPERATION = 'tasks.get';

/**
 * F-006 计划实体「不可见/不存在」统一 not_found（与 receipts.get 同一纪律：
 * 不区分存在性，不回显归属或实体身份）；能力缺失仍先行 forbidden。
 */
function planEntityNotFound(
  operation: string,
  entityType: 'phase' | 'feature' | 'task',
): never {
  throw new PublicError('not_found', operation, '计划实体不存在或不可见', {
    details: { reason: 'plan_entity_not_found', entityType },
  });
}

/**
 * P03-3 / F-010 执行域目标「不可见/不存在/跨项目」统一 not_found（同一错误
 * 形状，不区分存在性，不回显归属或实体身份）；能力缺失仍先行 forbidden。
 */
function executionEntityNotFound(operation: string): never {
  throw new PublicError('not_found', operation, '执行实体不存在或不可见', {
    details: { reason: 'execution_entity_not_found', entityType: 'execution_batch' },
  });
}

/**
 * P03-4 / F-007 调度/审计目标「不可见/不存在/跨项目」统一 not_found（与
 * executionEntityNotFound 同一形状纪律：不区分存在性，不回显归属或实体
 * 身份，逐字段一致）；能力缺失仍先行 forbidden。
 */
function executionScheduleTargetNotFound(
  operation: string,
  entityType: 'run' | 'task' | 'attempt',
): never {
  throw new PublicError('not_found', operation, '执行实体不存在或不可见', {
    details: { reason: 'execution_entity_not_found', entityType },
  });
}

/**
 * P03-6 / F-011 Session/证据目标「不可见/不存在/跨项目/非成员」统一
 * not_found（同一形状纪律：不区分存在性，不回显归属或实体身份，逐字段
 * 一致；防枚举）；能力缺失仍先行 forbidden。
 */
function workSessionTargetNotFound(
  operation: string,
  entityType: 'session' | 'attempt' | 'artifact',
): never {
  throw new PublicError('not_found', operation, '执行实体不存在或不可见', {
    details: { reason: 'execution_entity_not_found', entityType },
  });
}

/**
 * P03-5 / F-011 工作区目标「不可见/不存在/跨项目」统一 not_found（同一形状
 * 纪律：不区分存在性，不回显归属或实体身份，逐字段一致）；能力缺失仍先行
 * forbidden。
 */
function workspaceTargetNotFound(
  operation: string,
  entityType: 'workspace' | 'workspace_operation',
): never {
  throw new PublicError('not_found', operation, '工作区实体不存在或不可见', {
    details: { reason: 'workspace_entity_not_found', entityType },
  });
}

/**
 * P03-8 / F-009 Git 操作查询目标「不可见/不存在/跨项目」统一 not_found（同一
 * 形状纪律：不区分存在性，不回显归属或实体身份，逐字段一致）；能力缺失仍
 * 先行 forbidden。
 */
function gitOperationTargetNotFound(
  operation: string,
  entityType: 'feature' | 'run' | 'git_operation',
): never {
  throw new PublicError('not_found', operation, '执行实体不存在或不可见', {
    details: { reason: 'execution_entity_not_found', entityType },
  });
}

/**
 * P03-8 / F-010 Feature 分轴查询目标「不可见/不存在/跨项目」统一 not_found
 *（同一形状纪律：不区分存在性，不回显归属或实体身份）；能力缺失仍先行
 * forbidden。
 */
function featureDeliveryTargetNotFound(operation: string): never {
  throw new PublicError('not_found', operation, '执行实体不存在或不可见', {
    details: { reason: 'execution_entity_not_found', entityType: 'feature' },
  });
}

/**
 * 装配 QueryService。只校验依赖形态，不执行任何 I/O；import 本模块无副作用。
 */
export function createQueryService(options: QueryServiceOptions): QueryService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createQueryService: options 必须是对象');
  }
  const {
    projectReads,
    snapshots,
    eventReads,
    stateStore,
    configurationService,
    planReads,
    executionBudgetReads,
    scheduleReads,
    workspaceReads,
    workSessionReads,
    taskEvidenceReads,
    gitOperationReads,
    featureDeliveryReads,
    artifacts,
    artifactFiles,
    dataRootIdentity,
  } = options;
  if (typeof dataRootIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(dataRootIdentity)) {
    throw new TypeError('createQueryService: dataRootIdentity 必须是 64 位小写十六进制（可信装配派生）');
  }
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  // P03-6 / F-011：结果证据（小 JSON）与诊断制品正文的完整性核验读取器
  // （复用既有 ArtifactVerifier；缓冲上限显式有限，hash/size 核验失败即拒绝）。
  const settlementVerifier = createArtifactVerifier({
    artifacts,
    files: artifactFiles,
    limits: { maxReadBytes: WORK_SESSION_SETTLEMENT_MAX_READ_BYTES },
  });
  const evidenceVerifier = createArtifactVerifier({
    artifacts,
    files: artifactFiles,
    limits: { maxReadBytes: WORK_SESSION_EVIDENCE_MAX_READ_BYTES },
  });

  /** 结果证据正文读取：完整性核验 + JSON + 形状校验任一失败均为 corrupt_state。 */
  async function readSettlementEvidenceBody(projectId: string, artifactId: string, operation: string) {
    const corrupt = (): PublicError =>
      new PublicError('corrupt_state', operation, '证据完整性核验失败', {
        details: { reason: 'evidence_incomplete' },
      });
    let verified;
    try {
      verified = await settlementVerifier.readVerifiedContent(projectId, artifactId);
    } catch {
      throw corrupt();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(verified.content).toString('utf8'));
    } catch {
      throw corrupt();
    }
    try {
      return validateWorkSessionResultEvidence(parsed);
    } catch {
      throw corrupt();
    }
  }

  /** 游标绑定：数据根身份 + scope（每次构造；createEventCursorBinding 复核形状）。 */
  function cursorBinding(scope: PublicEventScope, operation: string): EventCursorBinding {
    return createEventCursorBinding({ rootIdentity: dataRootIdentity, scope }, operation);
  }

  /** 项目目标身份校验（非法稳定 ID 在任何授权/读取之前 invalid_input）。 */
  function requireProjectId(projectId: unknown, operation: string): string {
    const context: ValidationContext = { operation, entity: { type: 'project' } };
    return validateStableId(projectId, context, 'projectId');
  }

  /** F-006：层级列表分页过滤器（只取 limit/cursor；非法参数/未知键拒绝）。 */
  function validatedPlanFilter(
    object: Record<string, unknown>,
    operation: string,
  ): ValidatedPlanListFilter {
    const filter: Record<string, unknown> = {};
    if (object.limit !== undefined) filter.limit = object.limit;
    if (object.cursor !== undefined) filter.cursor = object.cursor;
    return validatePlanListFilter(filter, operation);
  }

  /** F-006：游标绑定（数据根 + 列表 scope；仅可信装配构造，绝不来自请求字段）。 */
  function planCursorBinding(scope: PlanListScope, operation: string): PlanListCursorBinding {
    return createPlanListCursorBinding({ rootIdentity: dataRootIdentity, scope }, operation);
  }

  /** F-006：游标 → 键集排他下界（非法/跨根/跨项目/跨父级一律 invalid_cursor）。 */
  function planListRequest(
    filter: ValidatedPlanListFilter,
    binding: PlanListCursorBinding,
    operation: string,
  ): PlanListRequest {
    return {
      afterId:
        filter.cursor === undefined
          ? null
          : decodePlanListCursor(filter.cursor, binding, operation).lastId,
      limit: filter.limit,
    };
  }

  return {
    async listProjects(principal: unknown, filter?: unknown): Promise<ProjectListResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_LIST_OPERATION;
      try {
        // 能力核验先于筛选校验与任何读取；可见谓词随端口下推 SQL。
        const visibility = authorizeProjectsList(principal, operation);
        const valid = validateProjectListFilter(filter, operation);
        const page = projectReads.listVisibleProjects(visibility, filter);
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'project-list',
          records: page.records.map(toPublicProjectRecord),
          nextCursor: page.nextCursor,
          limit: valid.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async countProjectLabels(principal: unknown): Promise<ProjectLabelCountsResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_LABEL_COUNTS_OPERATION;
      try {
        const visibility = authorizeProjectLabelCounts(principal, operation);
        return { labels: [...projectReads.countVisibleProjectLabels(visibility)] };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getProject(principal: unknown, projectId: unknown): Promise<ProjectDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectRead(principal, id, operation);
        let project;
        try {
          project = await stateStore.getProject(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        let binding = null;
        try {
          binding = await stateStore.getRepositoryBinding(id);
        } catch (error) {
          // 项目存在但尚无绑定 → binding:null；项目缺失已在上面折算 forbidden。
          if (isStorageError(error, 'not_found') && error.entity?.type === 'repository_binding') {
            binding = null;
          } else {
            throw error;
          }
        }
        return {
          project: toPublicProjectRecord(project),
          binding: binding === null ? null : toPublicRepositoryBindingRecord(binding),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getRepositoryBinding(principal: unknown, projectId: unknown): Promise<ProjectBindingResult> {
      assertTrustedPrincipal(principal);
      const operation = PROJECTS_BINDING_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectRead(principal, id, operation);
        let binding;
        try {
          binding = await stateStore.getRepositoryBinding(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        return { binding: toPublicRepositoryBindingRecord(binding) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getGlobalSettings(principal: unknown): Promise<PublicSettingsState> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_GLOBAL_GET_OPERATION;
      try {
        authorizeGlobalSettingsRead(principal, operation);
        const record = await configurationService.getCurrentSettings({ kind: 'global' });
        return toPublicSettingsState({ kind: 'global' }, record);
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getProjectSettings(principal: unknown, projectId: unknown): Promise<PublicSettingsState> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_GET_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        const scope: SettingsScope = { kind: 'project', projectId: id };
        const record = await configurationService.getCurrentSettings(scope);
        return toPublicSettingsState(scope, record);
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getEffectiveSettings(principal: unknown, projectId: unknown): Promise<EffectiveSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_EFFECTIVE_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        try {
          return await configurationService.getEffectiveSettings(id);
        } catch (error) {
          // 项目缺失折算为与不可见相同的 forbidden；配置损坏等其余错误原样传播。
          mapProjectLookupError(error, operation);
        }
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async exportGlobalSettings(principal: unknown): Promise<ExportedSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_GLOBAL_EXPORT_OPERATION;
      try {
        authorizeGlobalSettingsRead(principal, operation);
        return await configurationService.exportSettings();
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async exportProjectSettings(principal: unknown, projectId: unknown): Promise<ExportedSettings> {
      assertTrustedPrincipal(principal);
      const operation = SETTINGS_PROJECT_EXPORT_OPERATION;
      try {
        const id = requireProjectId(projectId, operation);
        authorizeProjectSettingsRead(principal, id, operation);
        try {
          return await configurationService.exportSettings(id);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getSnapshot(principal: unknown, scopeInput: unknown): Promise<SnapshotResult> {
      assertTrustedPrincipal(principal);
      const operation = SNAPSHOT_GET_OPERATION;
      try {
        const scope = validateEventScope(scopeInput, operation);
        authorizeSnapshot(principal, scope, operation);
        const binding = cursorBinding(scope, operation);
        const readAt = new Date(nowUtcMs()).toISOString();
        if (scope.kind === 'global') {
          const view = snapshots.readGlobalSnapshotView();
          const watermark = createEventWatermark(
            normalizeMaxEventSequence(view.maxEventSequence, operation),
            binding,
          );
          return {
            schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
            scope,
            settings:
              view.globalSettings === null
                ? null
                : toPublicSettingsState({ kind: 'global' }, view.globalSettings),
            watermark,
            readAt,
          };
        }
        let view;
        try {
          view = snapshots.readProjectSnapshotView(scope.projectId);
        } catch (error) {
          mapProjectLookupError(error, operation);
        }
        if (view.project === null) {
          // 端口契约：项目缺失必须抛 not_found 而不是返回空视图（实现缺陷）。
          throw new TypeError('项目快照视图缺失项目行（适配器实现缺陷）');
        }
        const watermark = createEventWatermark(
          normalizeMaxEventSequence(view.maxEventSequence, operation),
          binding,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope,
          project: toPublicProjectRecord(view.project),
          binding:
            view.binding === null ? null : toPublicRepositoryBindingRecord(view.binding),
          settings:
            view.projectSettings === null
              ? null
              : toPublicSettingsState(scope, view.projectSettings),
          // 有效配置与内容/水位同一读视图：全局来源 revision 随视图记录进入合并。
          effective: mergeEffectiveSettings({
            global:
              view.globalSettings === null
                ? null
                : {
                    scopeRevision: view.globalSettings.revision,
                    payload: view.globalSettings.payload,
                  },
            project:
              view.projectSettings === null
                ? null
                : {
                    scopeRevision: view.projectSettings.revision,
                    payload: view.projectSettings.payload,
                  },
          }),
          watermark,
          readAt,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listEvents(principal: unknown, input: unknown): Promise<StateEventPage> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'cursor', 'limit'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        const binding = cursorBinding(scope, operation);
        if (object.cursor === undefined) {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'cursor', reason: 'cursor_required' },
          });
        }
        const cursor = decodeEventCursor(object.cursor, binding, operation);
        const limit = validateEventPageLimit(object.limit, operation);
        // 授权在任何读取之前：events.read + 范围读能力 + 项目可见性。
        authorizeEventSubscription(principal, scope, operation);
        const rows = eventReads.listPersistedEvents({
          scope,
          afterSequence: cursor.sequence,
          limit,
        });
        // 行级可见过滤器复核（F-005）：SQL 谓词已下推，此处为防御纵深——
        // 结果与谓词不一致是适配器编程错误，绝不静默跳过/透传。
        const visibilityFilter = createEventVisibilityFilter(scope);
        for (const row of rows) {
          if (!visibilityFilter(row)) {
            throw new TypeError('事件读取结果越出授权范围（适配器实现缺陷）');
          }
        }
        const events = mapStateEvents(rows, operation);
        const last = events[events.length - 1];
        return {
          scope,
          events,
          nextCursor:
            events.length === limit && last !== undefined
              ? encodeEventCursor(last.sequence, binding)
              : null,
          limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async resolveEventResume(principal: unknown, input: unknown): Promise<EventResumePosition> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'cursor', 'lastEventId'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        // 授权在任何读取之前：events.read + 范围读能力 + 项目可见性。
        authorizeEventSubscription(principal, scope, operation);
        const binding = cursorBinding(scope, operation);
        let afterSequence: number;
        if (object.lastEventId !== undefined) {
          // §9.4 优先级：Last-Event-ID（eventId）先于 ?cursor=；同一授权 scope
          // 内解析，未命中不区分「不存在」与「跨 scope」（防存在性探测）。
          if (typeof object.lastEventId !== 'string' || !isUuidV4(object.lastEventId)) {
            throw new PublicError('invalid_input', operation, undefined, {
              details: { field: 'lastEventId', reason: 'invalid_event_id' },
            });
          }
          const sequence = eventReads.findPersistedEventSequence({
            scope,
            eventId: object.lastEventId,
          });
          if (sequence === undefined) {
            throw new PublicError('invalid_input', operation, undefined, {
              details: { field: 'lastEventId', reason: 'unknown_event_id' },
            });
          }
          afterSequence = sequence;
        } else if (object.cursor !== undefined) {
          afterSequence = decodeEventCursor(object.cursor, binding, operation).sequence;
        } else {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'cursor', reason: 'cursor_required' },
          });
        }
        return {
          scope,
          afterSequence,
          resumeCursor: encodeEventCursor(afterSequence, binding),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async readEventBatch(principal: unknown, input: unknown): Promise<StateEventBatch> {
      assertTrustedPrincipal(principal);
      const operation = EVENTS_SUBSCRIBE_OPERATION_NAME;
      try {
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['scope', 'afterSequence', 'limit'], { operation }, 'input');
        const scope = validateEventScope(object.scope, operation);
        const afterSequence = object.afterSequence;
        if (
          typeof afterSequence !== 'number' ||
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0
        ) {
          throw new PublicError('invalid_input', operation, undefined, {
            details: { field: 'afterSequence', reason: '必须是 0..2^53-1 的安全整数' },
          });
        }
        const limit = validateEventPageLimit(object.limit, operation);
        // 每次轮询重新核验当前授权：能力/可见性撤销即拒绝，不凭建连时快照。
        authorizeEventSubscription(principal, scope, operation);
        const rows = eventReads.listPersistedEvents({ scope, afterSequence, limit });
        // 行级可见过滤器复核（与 listEvents 同一防御纵深）。
        const visibilityFilter = createEventVisibilityFilter(scope);
        for (const row of rows) {
          if (!visibilityFilter(row)) {
            throw new TypeError('事件读取结果越出授权范围（适配器实现缺陷）');
          }
        }
        const events = mapStateEvents(rows, operation);
        const last = events[events.length - 1];
        return {
          scope,
          events,
          lastSequence: last === undefined ? afterSequence : last.sequence,
          limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getPhase(principal: unknown, phaseId: unknown): Promise<PhaseDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = PHASES_GET_OPERATION;
      try {
        const id = validateStableId(phaseId, { operation, entity: { type: 'phase' } }, 'phaseId');
        // 能力核验先于数据库读取；不可见与不存在统一 not_found（不区分存在性）。
        requireCapability(principal, 'project.read', operation);
        const record = planReads.readPhaseRecord(id);
        if (record === undefined || !isProjectVisible(principal, record.projectId)) {
          planEntityNotFound(operation, 'phase');
        }
        return { phase: toPublicPhaseRecord(record) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getFeature(principal: unknown, featureId: unknown): Promise<FeatureDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = FEATURES_GET_OPERATION;
      try {
        const id = validateStableId(featureId, { operation, entity: { type: 'feature' } }, 'featureId');
        requireCapability(principal, 'project.read', operation);
        const view = planReads.readFeaturePlanView(id);
        if (view === undefined || !isProjectVisible(principal, view.feature.projectId)) {
          planEntityNotFound(operation, 'feature');
        }
        // 防御纵深：一致读视图内 Task/边必须属于同一 Feature；混合状态是适配器
        // 实现缺陷（TypeError），绝不静默返回半新半旧的计划。
        const taskIds = new Set<string>();
        for (const task of view.tasks) {
          if (
            task.featureId !== id ||
            task.projectId !== view.feature.projectId ||
            taskIds.has(task.id)
          ) {
            throw new TypeError('Feature 计划视图内 Task 归属不一致（适配器实现缺陷）');
          }
          taskIds.add(task.id);
        }
        for (const edge of view.dependencies) {
          if (
            edge.featureId !== id ||
            edge.projectId !== view.feature.projectId ||
            !taskIds.has(edge.taskId) ||
            !taskIds.has(edge.dependsOnId)
          ) {
            throw new TypeError('Feature 计划视图内依赖边归属不一致（适配器实现缺陷）');
          }
        }
        const validation: FeaturePlanValidationSummary = {
          taskCount: view.tasks.length,
          dependencyEdgeCount: view.dependencies.length,
          // F-001 §3.1 同源结构前提（taskCount>0）；不代表已批准或已执行。
          executable: view.tasks.length > 0,
        };
        return {
          feature: toPublicFeatureRecord(view.feature),
          validation,
          notExecutableReasons: deriveFeatureNotExecutableReasons({
            taskCount: view.tasks.length,
            planStatus: view.feature.planStatus,
          }),
          tasks: view.tasks.map(toPublicTaskRecord),
          dependencies: view.dependencies.map(toPublicTaskDependencyEdge),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getFeatureApprovals(principal: unknown, featureId: unknown): Promise<FeatureApprovalsResult> {
      assertTrustedPrincipal(principal);
      const operation = PLAN_APPROVAL_QUERY_OPERATION;
      try {
        const id = validateStableId(featureId, { operation, entity: { type: 'feature' } }, 'featureId');
        requireCapability(principal, 'project.read', operation);
        const view = planReads.readFeatureApprovalsView(id);
        if (view === undefined || !isProjectVisible(principal, view.feature.projectId)) {
          planEntityNotFound(operation, 'feature');
        }
        // 当前决定 = 绑定当前 planDigest 的记录（同主体同摘要至多一条，DDL
        // 唯一索引保证）；摘要变更后旧决策自然成为历史。planStatus 是权威审批
        // 状态（拒绝后绝非 approved），不把拒绝显示为已批准。
        const currentDigest = view.feature.planDigest;
        const decisions = view.approvals.map((record) => ({
          ...toPublicPlanApprovalRecord(record),
          current: record.subjectDigest === currentDigest,
        }));
        // P03-2 / F-003：同一权威读视图的有效批准核验（fail-closed，明确过期
        // 原因）——适用检查政策身份从视图内全局/项目当前配置合并计算，不依赖
        // 可变配置路径、通用配置 revision 或 labels。
        const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
          view.settings.global,
          view.settings.project,
        );
        const validity = evaluatePlanApprovalValidity({
          planDigest: view.feature.planDigest,
          planStatus: view.feature.planStatus,
          taskCount: view.taskCount,
          decisions: view.approvals,
          currentCheckPolicyDigest: checkPolicyDigest,
        });
        return {
          feature: toPublicFeatureRecord(view.feature),
          currentDecision: decisions.find((decision) => decision.current) ?? null,
          decisions,
          validity,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getTask(principal: unknown, taskId: unknown): Promise<TaskDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = TASKS_GET_OPERATION;
      try {
        const id = validateStableId(taskId, { operation, entity: { type: 'task' } }, 'taskId');
        requireCapability(principal, 'project.read', operation);
        const record = planReads.readTaskRecord(id);
        if (record === undefined || !isProjectVisible(principal, record.projectId)) {
          planEntityNotFound(operation, 'task');
        }
        return { task: toPublicTaskRecord(record) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getExecutionBudgetStatus(
      principal: unknown,
      input: unknown,
    ): Promise<ExecutionBudgetStatusResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_BUDGET_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'batchId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const batchId = validateStableId(
          object.batchId,
          { operation, entity: { type: 'execution_batch' } },
          'batchId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = executionBudgetReads.readExecutionBudgetView(projectId, batchId);
        if (view === undefined) {
          executionEntityNotFound(operation);
        }
        // 总 Attempt 上限：同一读视图内全局/项目配置段合并（未配置 = null，
        // 不虚构上限；策略副本的 maxCodeAttempts 由纯投影单独解析）。
        const effective = mergeEffectiveSettings({
          global: view.settings.global,
          project: view.settings.project,
        });
        const maxAttemptsPerTask = effective.policies.executionLimits?.value.maxAttemptsPerTask ?? null;
        return buildExecutionBudgetStatus(view, { nowUtcMs: nowUtcMs(), maxAttemptsPerTask });
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listBatchBudgetRevisions(
      principal: unknown,
      input: unknown,
    ): Promise<BudgetRevisionListResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_BUDGET_REVISIONS_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'batchId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const batchId = validateStableId(
          object.batchId,
          { operation, entity: { type: 'execution_batch' } },
          'batchId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'budget-revisions', projectId, batchId }, operation);
        // 游标解析先于任何读取：跨批次/跨项目/跨根重放一律 invalid_cursor，
        // 绝不当作从零读取，也不先泄漏目标存在性。
        const request = planListRequest(filter, binding, operation);
        if (executionBudgetReads.findExecutionBatchRecord(projectId, batchId) === undefined) {
          executionEntityNotFound(operation);
        }
        const page = executionBudgetReads.listBatchBudgetRevisionRecords(
          principalProjectVisibility(principal),
          projectId,
          batchId,
          request,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'budget-revision-list',
          records: page.records.map(toPublicBatchBudgetRevisionRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getRunScheduleStatus(
      principal: unknown,
      input: unknown,
    ): Promise<RunScheduleStatusResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_RUN_SCHEDULE_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'runId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const runId = validateStableId(object.runId, { operation, entity: { type: 'run' } }, 'runId');
        requireProjectVisible(principal, projectId, operation);
        const view = scheduleReads.readRunScheduleView(projectId, runId);
        if (view === undefined) {
          executionScheduleTargetNotFound(operation, 'run');
        }
        // 同一就绪判定规则（evaluateTaskDag）从一致读视图派生；ready/blocked
        // 是只读派生结果，绝不落库为第二套可写 Task 状态。损坏持久视图降级为
        // invalid_graph（diagnostic 明确），Run/Attempt/占用事实仍如实可读。
        let schedule: RunScheduleEvaluation;
        let tasks: readonly PublicScheduleTaskView[];
        if (view.dag === null) {
          schedule = {
            reason: 'invalid_graph',
            diagnostic: 'corrupt_persisted_view',
            readyTaskIds: [],
            handoff: null,
          };
          tasks = [];
        } else {
          const evaluation = evaluateTaskDag(view.dag, nowUtcMs());
          schedule = {
            reason: evaluation.reason,
            diagnostic: evaluation.diagnostic,
            readyTaskIds: [...evaluation.readyTaskIds],
            handoff: evaluation.handoff,
          };
          const planTasks = new Map(view.dag.plan.tasks.map((task) => [task.id, task]));
          const facts = new Map(view.dag.facts.map((fact) => [fact.taskId, fact]));
          const latestByTask = new Map<string, AttemptRecord>();
          for (const attempt of view.attempts) {
            const existing = latestByTask.get(attempt.taskId);
            if (existing === undefined || attempt.number > existing.number) {
              latestByTask.set(attempt.taskId, attempt);
            }
          }
          tasks = evaluation.tasks.map((entry) => {
            const planTask = planTasks.get(entry.taskId);
            const fact = facts.get(entry.taskId);
            if (planTask === undefined || fact === undefined) {
              throw new TypeError('DAG 评估结果与一致读视图不一致（适配器实现缺陷）');
            }
            const latest = latestByTask.get(entry.taskId);
            return {
              taskId: entry.taskId,
              status: planTask.status,
              reason: entry.reason,
              dependencyIds: [...entry.dependencyIds],
              executionVersion: fact.executionVersion,
              manualBlock: fact.manualBlock,
              latestAttempt:
                latest === undefined
                  ? null
                  : {
                      id: latest.id,
                      number: latest.number,
                      status: latest.status,
                      executionStage: latest.executionStage,
                      exitCode: latest.exitCode,
                      durationMs: latest.durationMs,
                      startedAt:
                        latest.startedAtUtcMs === null
                          ? null
                          : new Date(latest.startedAtUtcMs).toISOString(),
                      endedAt:
                        latest.endedAtUtcMs === null
                          ? null
                          : new Date(latest.endedAtUtcMs).toISOString(),
                      errorKind: latest.errorKind,
                    },
            };
          });
        }
        const run = view.run;
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'run-schedule',
          run: {
            id: run.id,
            projectId: run.projectId,
            batchId: run.batchId,
            featureId: run.featureId,
            purpose: run.purpose,
            workKey: run.workKey,
            dispatchOrdinal: run.dispatchOrdinal,
            status: run.status,
            reason: run.reason,
            startedAt:
              run.startedAtUtcMs === null ? null : new Date(run.startedAtUtcMs).toISOString(),
            endedAt: run.endedAtUtcMs === null ? null : new Date(run.endedAtUtcMs).toISOString(),
            createdAt: new Date(run.createdAtUtcMs).toISOString(),
          },
          schedule,
          tasks,
          occupancy: view.occupancy.map((row) => ({
            id: row.lease.id,
            attemptId: row.lease.owner,
            runId: row.runId,
            resourceKind: row.lease.resourceKind,
            resourceKey: row.lease.resourceKey,
            state: row.lease.state,
            leaseUntil: new Date(row.lease.leaseUntilUtcMs).toISOString(),
            processIdentity: row.lease.processIdentity !== null,
          })),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listExecutionAttempts(principal: unknown, input: unknown): Promise<AttemptListResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_ATTEMPTS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'taskId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const taskId = validateStableId(object.taskId, { operation, entity: { type: 'task' } }, 'taskId');
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'task-attempts', projectId, taskId }, operation);
        // 游标解析先于任何读取：跨 Task/跨项目/跨根重放或篡改载荷一律
        // invalid_cursor，绝不当作从零读取，也不先泄漏目标存在性。
        const after = planListRequest(filter, binding, operation);
        const request = {
          after: after.afterId === null ? null : decodeExecutionListKey(after.afterId, operation),
          limit: filter.limit,
        };
        const task = planReads.readTaskRecord(taskId);
        if (task === undefined || task.projectId !== projectId) {
          executionScheduleTargetNotFound(operation, 'task');
        }
        const page = scheduleReads.listTaskAttemptRecords(
          principalProjectVisibility(principal),
          projectId,
          taskId,
          request,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'attempt-list',
          records: page.records.map(toPublicAttemptRecord),
          nextCursor:
            page.nextKey === null
              ? null
              : encodePlanListCursor(encodeExecutionListKey(page.nextKey), binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listAttemptDiagnostics(
      principal: unknown,
      input: unknown,
    ): Promise<AttemptDiagnosticsResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_ATTEMPT_DIAGNOSTICS_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(
          object,
          ['projectId', 'attemptId', 'limit', 'cursor'],
          { operation },
          'input',
        );
        const projectId = requireProjectId(object.projectId, operation);
        const attemptId = validateStableId(
          object.attemptId,
          { operation, entity: { type: 'attempt' } },
          'attemptId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'attempt-diagnostics', projectId, attemptId }, operation);
        const after = planListRequest(filter, binding, operation);
        const request = {
          after: after.afterId === null ? null : decodeExecutionListKey(after.afterId, operation),
          limit: filter.limit,
        };
        if (scheduleReads.readAttemptRecord(projectId, attemptId) === undefined) {
          executionScheduleTargetNotFound(operation, 'attempt');
        }
        const page = scheduleReads.listAttemptDiagnosticRecords(
          principalProjectVisibility(principal),
          projectId,
          attemptId,
          request,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'attempt-diagnostic-list',
          records: page.records.map(toPublicAttemptDiagnosticRecord),
          nextCursor:
            page.nextKey === null
              ? null
              : encodePlanListCursor(encodeExecutionListKey(page.nextKey), binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listPhases(principal: unknown, input: unknown): Promise<PhaseListResult> {
      assertTrustedPrincipal(principal);
      const operation = PHASES_LIST_OPERATION;
      try {
        // 能力与可见性先于分页/计数：受限主体对不可见项目 forbidden（与不存在
        // 项目同一错误）；全量范围下未知项目自然空页，不泄漏存在性。
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'phases', projectId }, operation);
        const page = planReads.listPhaseRecords(
          principalProjectVisibility(principal),
          projectId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'phase-list',
          records: page.records.map(toPublicPhaseRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listFeatures(principal: unknown, input: unknown): Promise<FeatureListResult> {
      assertTrustedPrincipal(principal);
      const operation = FEATURES_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'phaseId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const phaseId = validateStableId(
          object.phaseId,
          { operation, entity: { type: 'phase' } },
          'phaseId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'features', projectId, phaseId }, operation);
        const page = planReads.listFeatureRecords(
          principalProjectVisibility(principal),
          projectId,
          phaseId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'feature-list',
          records: page.records.map(toPublicFeatureRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listTasks(principal: unknown, input: unknown): Promise<TaskListResult> {
      assertTrustedPrincipal(principal);
      const operation = TASKS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'featureId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const featureId = validateStableId(
          object.featureId,
          { operation, entity: { type: 'feature' } },
          'featureId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'tasks', projectId, featureId }, operation);
        const page = planReads.listTaskRecords(
          principalProjectVisibility(principal),
          projectId,
          featureId,
          planListRequest(filter, binding, operation),
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'task-list',
          records: page.records.map(toPublicTaskRecord),
          nextCursor: page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    // P03-5 / F-011：工作区状态只读查询（§4：能力核验 → 身份/过滤器校验 →
    // 项目可见 → 一致读；跨项目/不存在折叠 not_found；脱敏投影在端口层）。
    async listWorkspaces(principal: unknown, input: unknown): Promise<WorkspaceListResult> {
      assertTrustedPrincipal(principal);
      const operation = 'workspaces.list';
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const filter = validateWorkspaceListFilter(object, operation);
        requireProjectVisible(principal, projectId, operation);
        const binding = createWorkspaceListCursorBinding(
          { rootIdentity: dataRootIdentity, scope: { kind: 'workspaces', projectId, featureId: filter.featureId } },
          operation,
        );
        const page = workspaceReads.listWorkspaceRecords(projectId, filter.featureId, {
          afterId:
            filter.cursor === undefined
              ? null
              : decodeWorkspaceListCursor(filter.cursor, binding, operation).lastId,
          limit: filter.limit,
        });
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'workspace-list',
          records: page.records.map(toPublicWorkspaceRecord),
          nextCursor: page.nextId === null ? null : encodeWorkspaceListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getWorkspace(principal: unknown, input: unknown): Promise<WorkspaceDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = 'workspaces.get';
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'featureId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const featureId = validateStableId(
          object.featureId,
          { operation, entity: { type: 'feature' } },
          'featureId',
        );
        requireProjectVisible(principal, projectId, operation);
        const detail = workspaceReads.readWorkspaceDetail(projectId, featureId);
        if (detail === undefined) {
          workspaceTargetNotFound(operation, 'workspace');
        }
        return {
          workspace: toPublicWorkspaceRecord(detail.workspace),
          preparationOperation:
            detail.preparation === null ? null : toPublicWorkspaceOperationRecord(detail.preparation),
          latestOperation: detail.latest === null ? null : toPublicWorkspaceOperationRecord(detail.latest),
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listWorkspaceOperations(
      principal: unknown,
      input: unknown,
    ): Promise<WorkspaceOperationListResult> {
      assertTrustedPrincipal(principal);
      const operation = 'workspace.operations.list';
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const filter = validateWorkspaceListFilter(object, operation);
        requireProjectVisible(principal, projectId, operation);
        const binding = createWorkspaceListCursorBinding(
          { rootIdentity: dataRootIdentity, scope: { kind: 'workspace-operations', projectId, featureId: filter.featureId } },
          operation,
        );
        const page = workspaceReads.listWorkspaceOperationViews(projectId, filter.featureId, {
          afterId:
            filter.cursor === undefined
              ? null
              : decodeWorkspaceListCursor(filter.cursor, binding, operation).lastId,
          limit: filter.limit,
        });
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'workspace-operation-list',
          records: page.records.map(toPublicWorkspaceOperationRecord),
          nextCursor: page.nextId === null ? null : encodeWorkspaceListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getWorkspaceOperation(
      principal: unknown,
      input: unknown,
    ): Promise<WorkspaceOperationDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = 'workspace.operations.get';
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'operationId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const operationId = validateStableId(
          object.operationId,
          { operation, entity: { type: 'workspace_operation' } },
          'operationId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = workspaceReads.readWorkspaceOperationView(projectId, operationId);
        if (view === undefined) {
          workspaceTargetNotFound(operation, 'workspace_operation');
        }
        return { operation: toPublicWorkspaceOperationRecord(view) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    // P03-6 / F-011：Work Session 只读查询（能力核验 → 身份/过滤器校验 →
    // 项目可见 → 一致读；跨项目/不存在折叠 not_found；脱敏投影在端口层；
    // 查询零写入、零事件、零续租、不触发取消或执行）。
    async listWorkSessions(principal: unknown, input: unknown): Promise<WorkSessionListResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_WORK_SESSIONS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const selector = validateWorkSessionListSelector(object, operation);
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding(
          selector.parent.kind === 'run'
            ? { kind: 'run-work-sessions', projectId, runId: selector.parent.runId }
            : { kind: 'task-work-sessions', projectId, taskId: selector.parent.taskId },
          operation,
        );
        // 游标解析先于任何读取：跨父级/跨项目/跨根重放或篡改载荷一律
        // invalid_cursor，绝不当作从零读取，也不先泄漏目标存在性。
        const after = planListRequest(filter, binding, operation);
        const request = {
          after: after.afterId === null ? null : decodeExecutionListKey(after.afterId, operation),
          limit: filter.limit,
        };
        let page;
        if (selector.parent.kind === 'run') {
          if (workSessionReads.readRunRef(projectId, selector.parent.runId) === undefined) {
            executionScheduleTargetNotFound(operation, 'run');
          }
          page = workSessionReads.listRunWorkSessions(
            principalProjectVisibility(principal),
            projectId,
            selector.parent.runId,
            request,
          );
        } else {
          const task = planReads.readTaskRecord(selector.parent.taskId);
          if (task === undefined || task.projectId !== projectId) {
            executionScheduleTargetNotFound(operation, 'task');
          }
          page = workSessionReads.listTaskWorkSessions(
            principalProjectVisibility(principal),
            projectId,
            selector.parent.taskId,
            request,
          );
        }
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'work-session-list',
          records: page.records.map(toPublicWorkSessionSummary),
          nextCursor:
            page.nextKey === null
              ? null
              : encodePlanListCursor(encodeExecutionListKey(page.nextKey), binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getWorkSession(principal: unknown, input: unknown): Promise<WorkSessionDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_WORK_SESSION_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'attemptId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const attemptId = validateStableId(
          object.attemptId,
          { operation, entity: { type: 'attempt' } },
          'attemptId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = workSessionReads.readWorkSessionDetail(projectId, attemptId);
        if (view === undefined) {
          workSessionTargetNotFound(operation, 'attempt');
        }
        // 结果证据：Session 已结算时读 resultRef；启动前拒绝场景回退到受控
        // locator 的未启动拒绝证据。正文经完整性核验读取并严格校验；缺失/
        // 损坏为 corrupt_state（fail-closed），绝不降级为「无证据」。
        const settlementRef =
          view.session?.resultRef ??
          view.evidence.find(
            (artifact) =>
              artifact.kind === 'runtime-settlement' &&
              artifact.status === 'ready' &&
              artifact.locator === `attempts/${view.attempt.id}/launch-rejection.json`,
          )?.id ??
          null;
        let resultEvidence: PublicWorkSessionResultEvidence | null = null;
        if (settlementRef !== null) {
          resultEvidence = toPublicWorkSessionResultEvidence(
            await readSettlementEvidenceBody(projectId, settlementRef, operation),
          );
        }
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'work-session',
          attempt: toPublicWorkSessionAttempt(view.attempt),
          executionState: deriveWorkSessionQueryState(view.attempt, view.session),
          session: view.session === null ? null : toPublicWorkSessionRecord(view.session),
          resultEvidence,
          occupancy: view.occupancy.map((lease) => ({
            id: lease.id,
            attemptId: lease.owner,
            runId: view.attempt.runId,
            resourceKind: lease.resourceKind,
            resourceKey: lease.resourceKey,
            state: lease.state,
            leaseUntil: new Date(lease.leaseUntilUtcMs).toISOString(),
            processIdentity: lease.processIdentity !== null,
          })),
          evidence: view.evidence.map(toPublicWorkSessionEvidenceRef),
          evidenceTruncated: view.evidenceTruncated,
          diagnostics: view.diagnostics.map(toPublicAttemptDiagnosticRecord),
          diagnosticsTruncated: view.diagnosticsTruncated,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async readWorkSessionEvidence(
      principal: unknown,
      input: unknown,
    ): Promise<WorkSessionEvidenceContent> {
      assertTrustedPrincipal(principal);
      const operation = EXECUTION_WORK_SESSION_EVIDENCE_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'attemptId', 'artifactId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const attemptId = validateStableId(
          object.attemptId,
          { operation, entity: { type: 'attempt' } },
          'attemptId',
        );
        const artifactId = validateStableId(
          object.artifactId,
          { operation, entity: { type: 'artifact' } },
          'artifactId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = workSessionReads.readWorkSessionDetail(projectId, attemptId);
        if (view === undefined) {
          workSessionTargetNotFound(operation, 'attempt');
        }
        // 成员资格：同项目 ready 制品 + 受控 locator 前缀（sessions/<id>/ 或
        // attempts/<id>/）；未知/跨项目/非成员/非 ready 统一 not_found 防枚举，
        // 绝不接受任意文件路径。
        let artifact;
        try {
          artifact = await artifacts.getArtifact(projectId, artifactId);
        } catch (error) {
          if (isStorageError(error, 'not_found') || isStorageError(error, 'ownership')) {
            workSessionTargetNotFound(operation, 'artifact');
          }
          throw error;
        }
        if (
          artifact.status !== 'ready' ||
          !isWorkSessionEvidenceLocator(artifact.locator, view.session?.id ?? null, attemptId)
        ) {
          workSessionTargetNotFound(operation, 'artifact');
        }
        let verified;
        try {
          verified = await evidenceVerifier.readVerifiedContent(projectId, artifactId);
        } catch {
          throw new PublicError('corrupt_state', operation, '证据完整性核验失败', {
            details: { reason: 'evidence_incomplete' },
          });
        }
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'work-session-evidence',
          artifact: {
            artifactId: verified.artifactId,
            kind: artifact.kind,
            mediaType: artifact.mediaType,
            contentHash: verified.contentHash,
            sizeBytes: verified.sizeBytes,
            version: artifact.version,
          },
          content: verified.content,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    // P03-7 / F-013：Task 机器证据/人审事项/有限返工链只读查询（能力核验 →
    // 身份/分页校验 → 项目可见 → 一致读；跨项目/不存在折叠 not_found；脱敏
    // 投影在端口层；查询零写入、零事件、不触发 Runtime、不扣预算）。
    async getTaskVerification(
      principal: unknown,
      input: unknown,
    ): Promise<TaskVerificationDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = TASK_VERIFICATION_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'taskId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const taskId = validateStableId(
          object.taskId,
          { operation, entity: { type: 'task' } },
          'taskId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = taskEvidenceReads.readTaskVerificationView(projectId, taskId);
        if (view === undefined) {
          executionScheduleTargetNotFound(operation, 'task');
        }
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'task-verification',
          task: toPublicTaskEvidenceState(view.task),
          // 机器结论只反映机器事实；有效 Task passed 恒以 task.status 为准，
          // 机器 passed 绝不展示为有效 Task passed。
          machine: deriveTaskMachineConclusion(view),
          batches: view.batches.map(toPublicVerificationBatchRecord),
          batchesTruncated: view.batchesTruncated,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listTaskApprovalItems(
      principal: unknown,
      input: unknown,
    ): Promise<TaskApprovalItemListResult> {
      assertTrustedPrincipal(principal);
      const operation = TASK_APPROVAL_ITEMS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'taskId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const taskId = validateStableId(
          object.taskId,
          { operation, entity: { type: 'task' } },
          'taskId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'task-approvals', projectId, taskId }, operation);
        // 游标解析先于任何读取：跨 Task/跨项目/跨根重放或篡改载荷一律
        // invalid_cursor，绝不当作从零读取，也不先泄漏目标存在性。
        const after = planListRequest(filter, binding, operation);
        const request = {
          after: after.afterId === null ? null : decodeExecutionListKey(after.afterId, operation),
          limit: filter.limit,
        };
        const task = planReads.readTaskRecord(taskId);
        if (task === undefined || task.projectId !== projectId) {
          executionScheduleTargetNotFound(operation, 'task');
        }
        const page = taskEvidenceReads.listTaskApprovalItemRows(
          principalProjectVisibility(principal),
          projectId,
          taskId,
          request,
        );
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'task-approval-item-list',
          records: page.records.map(toPublicTaskApprovalItemRecord),
          nextCursor:
            page.nextKey === null
              ? null
              : encodePlanListCursor(encodeExecutionListKey(page.nextKey), binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async listTaskReworkChain(
      principal: unknown,
      input: unknown,
    ): Promise<TaskReworkChainListResult> {
      assertTrustedPrincipal(principal);
      const operation = TASK_REWORK_CHAIN_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'taskId', 'limit', 'cursor'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const taskId = validateStableId(
          object.taskId,
          { operation, entity: { type: 'task' } },
          'taskId',
        );
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding({ kind: 'task-rework-chain', projectId, taskId }, operation);
        const after = planListRequest(filter, binding, operation);
        const request = {
          after: after.afterId === null ? null : decodeExecutionListKey(after.afterId, operation),
          limit: filter.limit,
        };
        const view = taskEvidenceReads.readTaskReworkView(projectId, taskId);
        if (view === undefined) {
          executionScheduleTargetNotFound(operation, 'task');
        }
        const page = taskEvidenceReads.listTaskReworkAttemptRows(
          principalProjectVisibility(principal),
          projectId,
          taskId,
          request,
        );
        // 总预算阻止原因与后继 blocked 原因从既有纯派生同一规则取得：预算判定
        // 复用 buildExecutionBudgetStatus（含 Task 代码资格上限），后继阻断复用
        // evaluateTaskDag；均是只读派生，不落第二套可写状态。
        let budgetBlockReasons: TaskReworkChainListResult['summary']['budgetBlockReasons'] = [];
        let blockedSuccessors: readonly PublicReworkSuccessorView[] = [];
        if (view.run !== null) {
          const budgetView = executionBudgetReads.readExecutionBudgetView(projectId, view.run.batchId);
          if (budgetView !== undefined) {
            const effective = mergeEffectiveSettings({
              global: budgetView.settings.global,
              project: budgetView.settings.project,
            });
            budgetBlockReasons = buildExecutionBudgetStatus(budgetView, {
              nowUtcMs: nowUtcMs(),
              maxAttemptsPerTask: effective.policies.executionLimits?.value.maxAttemptsPerTask ?? null,
            }).blockingReasons;
          }
          const scheduleView = scheduleReads.readRunScheduleView(projectId, view.run.id);
          if (scheduleView !== undefined && scheduleView.dag !== null) {
            const evaluation = evaluateTaskDag(scheduleView.dag, nowUtcMs());
            const planTasks = new Map(scheduleView.dag.plan.tasks.map((task) => [task.id, task]));
            blockedSuccessors = evaluation.tasks
              .filter((entry) => entry.dependencyIds.includes(taskId))
              .map((entry) => {
                const planTask = planTasks.get(entry.taskId);
                if (planTask === undefined) {
                  throw new TypeError('DAG 评估结果与一致读视图不一致（适配器实现缺陷）');
                }
                return { taskId: entry.taskId, status: planTask.status, reason: entry.reason };
              });
          }
        }
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'task-rework-chain',
          records: page.records.map(toPublicReworkAttemptRecord),
          nextCursor:
            page.nextKey === null
              ? null
              : encodePlanListCursor(encodeExecutionListKey(page.nextKey), binding),
          limit: filter.limit,
          summary: {
            // 代码资格已用/剩余只取持久计数与策略副本上限；基础设施错误与
            // 等待人审不显示为代码额度消耗。
            codeEligibility: buildReworkCodeEligibility(view.task),
            attempts: buildReworkAttemptTotals(view.task),
            run: view.run === null ? null : toPublicReworkRunView(view.run),
            budgetBlockReasons,
            blockedSuccessors,
          },
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    // P03-8 / F-009：Git 意图/实际提交/操作回执只读查询（能力核验 → 身份/
    // 分页校验 → 项目可见 → 一致读；跨项目/不存在折叠 not_found；脱敏投影
    // 在端口层——不含 worktree 路径/执行归属/凭据；查询零写入、零事件、
    // 不触发 Git 或执行）。
    async listGitOperations(principal: unknown, input: unknown): Promise<GitOperationListResult> {
      assertTrustedPrincipal(principal);
      const operation = GIT_OPERATIONS_LIST_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(
          object,
          ['projectId', 'featureId', 'runId', 'limit', 'cursor'],
          { operation },
          'input',
        );
        const projectId = requireProjectId(object.projectId, operation);
        const parent = validateGitOperationListSelector(object, operation);
        requireProjectVisible(principal, projectId, operation);
        const filter = validatedPlanFilter(object, operation);
        const binding = planCursorBinding(
          parent.kind === 'feature'
            ? { kind: 'feature-git-operations', projectId, featureId: parent.featureId }
            : { kind: 'run-git-operations', projectId, runId: parent.runId },
          operation,
        );
        // 游标解析先于任何读取：跨父级/跨项目/跨根重放或篡改载荷一律
        // invalid_cursor，绝不当作从零读取，也不先泄漏目标存在性。
        const request = planListRequest(filter, binding, operation);
        const page =
          parent.kind === 'feature'
            ? (() => {
                const view = planReads.readFeaturePlanView(parent.featureId);
                if (view === undefined || view.feature.projectId !== projectId) {
                  gitOperationTargetNotFound(operation, 'feature');
                }
                return gitOperationReads.listGitOperationRecordsByFeature(
                  principalProjectVisibility(principal),
                  projectId,
                  parent.featureId,
                  request,
                );
              })()
            : (() => {
                if (workSessionReads.readRunRef(projectId, parent.runId) === undefined) {
                  gitOperationTargetNotFound(operation, 'run');
                }
                return gitOperationReads.listGitOperationRecordsByRun(
                  principalProjectVisibility(principal),
                  projectId,
                  parent.runId,
                  request,
                );
              })();
        return {
          schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
          scope: 'git-operation-list',
          records: page.records.map(toPublicGitOperationRecord),
          nextCursor:
            page.nextId === null ? null : encodePlanListCursor(page.nextId, binding),
          limit: filter.limit,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async getGitOperation(principal: unknown, input: unknown): Promise<GitOperationDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = GIT_OPERATION_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'operationId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const operationId = validateStableId(
          object.operationId,
          { operation, entity: { type: 'git_operation' } },
          'operationId',
        );
        requireProjectVisible(principal, projectId, operation);
        const record = gitOperationReads.readGitOperationRecord(projectId, operationId);
        if (record === undefined) {
          gitOperationTargetNotFound(operation, 'git_operation');
        }
        return { operation: toPublicGitOperationRecord(record) };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    // P03-8 / F-010：Feature 分轴结果只读查询（能力核验 → 身份校验 → 项目
    // 可见 → 一致读视图重建；跨项目/不存在折叠 not_found；脱敏投影复用
    // F-013/F-009 公共形状；查询零写入、零事件、不触发 Git 或执行）。
    async getFeatureDelivery(
      principal: unknown,
      input: unknown,
    ): Promise<FeatureDeliveryDetailResult> {
      assertTrustedPrincipal(principal);
      const operation = FEATURE_DELIVERY_GET_OPERATION;
      try {
        requireCapability(principal, 'project.read', operation);
        const object = requirePlainObject(input, { operation }, 'input');
        rejectUnknownKeys(object, ['projectId', 'featureId'], { operation }, 'input');
        const projectId = requireProjectId(object.projectId, operation);
        const featureId = validateStableId(
          object.featureId,
          { operation, entity: { type: 'feature' } },
          'featureId',
        );
        requireProjectVisible(principal, projectId, operation);
        const view = featureDeliveryReads.readFeatureDeliveryView(projectId, featureId);
        if (view === undefined) {
          featureDeliveryTargetNotFound(operation);
        }
        return buildFeatureDeliveryDetailResult(view);
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
