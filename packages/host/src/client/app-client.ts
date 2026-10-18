/**
 * F-013 HostClient 应用能力（P02-2 契约 §11.2）：命令提交（冻结信封、超时
 * 先查回执、有限重发、outcome_unknown）、回执/结果读取、授权查询与快照、
 * SSE 订阅（跨分块解析、有界去重、snapshot_required 恢复分支、自动重连）。
 *
 * 规则落实：
 * - 只访问 §3.2 正式路由；不打开 SQLite、不直读业务文件；凭据只经
 *   Authorization 头发送，绝不跟随重定向（http-json 层已冻结 3xx 拒绝）；
 * - 一次逻辑命令一个冻结信封：commandId/issuedAt/expiresAt/payload 在首次
 *   发送前冻结，重发逐字节相同（同一对象序列化）；超时/响应丢失先等待一个
 *   有界提交窗口（SUBMIT_RECEIPT_GRACE_MS）再查该 principal 名下回执，
 *   回执未知才在有限预算（submitBudgetMs / SUBMIT_MAX_ATTEMPTS）内重发；
 *   连接失败不折算为业务拒绝或完成；预算耗尽 → outcome_unknown（保留
 *   commandId 供事后查回执）；AbortSignal 立即以 unreachable(aborted) 中止，
 *   不产生新请求；
 * - 响应运行时校验复用 app-wire 纯校验器（畸形/未知版本 → 协议错误，
 *   不重试）；非 200 且体为合法回执（§5.7 rejected 唯一映射）按回执返回；
 * - SSE：建连等待响应头（非 200 按错误体映射，建连前 409 snapshot_required
 *   是明确恢复分支）；帧解析处理跨分块 UTF-8（TextDecoder stream）与心跳
 *   注释；eventId 去重缓存有界（512，FIFO 逐出，不阻塞新事件）；断线在
 *   有限预算内以 Last-Event-ID 自动重连；建连后 snapshot_required /
 *   stream_overflow 以对应 EventStreamEnd 结束；close()/AbortSignal 只释放
 *   本地观察资源（销毁本连接），绝不触发 stop/cancel；
 * - 事件帧 262 144 B、接收缓冲 1 048 576 B 上限（超限 protocol_error，
 *   不无限缓冲）；重连最多 5 次、间隔 200 ms（§15.6 登记实施值）。
 *
 * import 本模块无副作用：不发起网络、不读文件系统/argv/env。
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import {
  PLAN_LIST_CURSOR_PREFIX,
  PLAN_LIST_MAX_LIMIT,
  WORKSPACE_LIST_CURSOR_PREFIX,
  WORKSPACE_LIST_MAX_LIMIT,
  computeCommandRequestDigest,
  isUuidV4,
  isValidResultRef,
  validateCommandEnvelope,
  WIRE_MESSAGE_SCHEMA_VERSION,
} from 'shiploop-core/protocol';
import type {
  AppOperation,
  AttemptDiagnosticsResult,
  AttemptListResult,
  BaselineDetailResult,
  BaselineListResult,
  CommandReceipt,
  CommandScope,
  EffectiveSettings,
  ExportedSettings,
  FeatureApprovalsResult,
  ExecutionBudgetStatusResult,
  BudgetRevisionListResult,
  FeatureDetailResult,
  FeatureListResult,
  GlobalSnapshotResult,
  PhaseDetailResult,
  PhaseListResult,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectInspectionResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  ProjectOverviewResult,
  ProjectSnapshotResult,
  PublicSettingsState,
  PublicStateEvent,
  RunScheduleStatusResult,
  SettingsScope,
  SnapshotResult,
  TaskDetailResult,
  TaskListResult,
  TaskApprovalItemListResult,
  TaskReworkChainListResult,
  TaskVerificationDetailResult,
  GitOperationDetailResult,
  GitOperationListResult,
  FeatureDeliveryDetailResult,
  WorkSessionListResult,
  WorkSessionDetailResult,
  WorkSessionEvidenceContent,
  WorkspaceDetailResult,
  WorkspaceDiscardPreviewBinding,
  WorkspaceListResult,
  WorkspaceOperationDetailResult,
  WorkspaceOperationListResult,
} from 'shiploop-core/protocol';
import {
  APP_REQUEST_TIMEOUT_MS,
  ARTIFACT_CONTENT_ROUTE_SUFFIX,
  ARTIFACTS_ROUTE_PREFIX,
  ATTEMPTS_ROUTE,
  ATTEMPTS_ROUTE_PREFIX,
  ATTEMPT_DIAGNOSTICS_ROUTE_SUFFIX,
  BATCHES_ROUTE_PREFIX,
  BASELINES_ROUTE_PREFIX,
  COMMANDS_ROUTE,
  EVENTS_ROUTE,
  FEATURE_APPROVALS_ROUTE_SUFFIX,
  FEATURE_DELIVERY_ROUTE_SUFFIX,
  FEATURES_ROUTE,
  FEATURES_ROUTE_PREFIX,
  GIT_OPERATIONS_ROUTE,
  GIT_OPERATIONS_ROUTE_PREFIX,
  HostProtocolError,
  MAX_APP_BODY_BYTES,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES,
  PHASES_ROUTE,
  PHASES_ROUTE_PREFIX,
  PROJECTS_INSPECT_ROUTE,
  PROJECTS_ROUTE,
  PROJECT_LABEL_COUNTS_ROUTE,
  RECEIPTS_ROUTE_PREFIX,
  RESULTS_ROUTE_PREFIX,
  RUNS_ROUTE_PREFIX,
  TASK_APPROVALS_ROUTE_SUFFIX,
  TASK_REWORK_CHAIN_ROUTE_SUFFIX,
  TASK_VERIFICATION_ROUTE_SUFFIX,
  RUN_SCHEDULE_ROUTE_SUFFIX,
  SETTINGS_GLOBAL_EXPORT_ROUTE,
  SETTINGS_GLOBAL_ROUTE,
  SNAPSHOT_ROUTE,
  SUBMIT_COMMAND_BUDGET_MS,
  TASKS_ROUTE,
  TASKS_ROUTE_PREFIX,
  WORKSPACES_ROUTE,
  WORKSPACES_ROUTE_PREFIX,
  WORKSPACE_OPERATIONS_ROUTE,
  WORKSPACE_OPERATIONS_ROUTE_PREFIX,
  isHostProtocolError,
  isPlainObject,
} from '../contract/index.js';
import type { HostOperation } from '../contract/index.js';
import { mapErrorResponse, requestLoopbackJson, requestLoopbackText } from './http-json.js';
import {
  validateAppQueryResponse,
  validateBaselineCommandResultWire,
  validateBaselinePreviewResultWire,
  validateCommandReceiptWire,
  validateExecutionInputPrepareResultWire,
  validateExecutionPreviewResultWire,
  validateExecutionBudgetStatusResultWire,
  validateBudgetRevisionListResultWire,
  validateFeaturePlanDecideResultWire,
  validateFeaturePlanImportResultWire,
  validateFeatureDeliveryCommandResultWire,
  validateFeaturePlanReviseResultWire,
  validatePhaseCreateResultWire,
  validatePlanLabelsUpdateResultWire,
  validateStateEventWire,
  validateTaskApprovalBlockResultWire,
  validateTaskApprovalDecisionResultWire,
  validateTaskStrategyUpdateResultWire,
  validateTaskVerificationContinueResultWire,
  validateWorkspaceDiscardConfirmResultWire,
  validateWorkspaceDiscardPreviewWire,
} from './app-wire.js';

/* ------------------------------------------------------------------ *
 * 预算与重试策略（有限默认值，§15.6 登记）
 * ------------------------------------------------------------------ */

/** 响应丢失后、首次查回执前的提交窗口（ms）：给 Host 完成在途提交的有限余量。 */
export const SUBMIT_RECEIPT_GRACE_MS = 1_000;
/** 重发冻结信封前的有限间隔（ms）。 */
export const SUBMIT_RETRY_DELAY_MS = 100;
/** 一个逻辑命令的最大提交尝试次数（首发 + 有限重发）。 */
export const SUBMIT_MAX_ATTEMPTS = 3;

/** §13：eventId 去重缓存上限（每连接，FIFO 逐出）。 */
export const EVENT_ID_CACHE_LIMIT = 512;
/** 单个 SSE 帧字节上限（与服务端单批序列化上限一致）。 */
export const MAX_SSE_FRAME_BYTES = 262_144;
/** SSE 接收缓冲上限（不无限缓冲未终结帧）。 */
export const MAX_SSE_BUFFER_BYTES = 1_048_576;
/** 断线自动重连上限与间隔（有限预算；耗尽以 protocol_error 结束观察）。 */
export const EVENT_RECONNECT_MAX_ATTEMPTS = 5;
export const EVENT_RECONNECT_DELAY_MS = 200;

/* ------------------------------------------------------------------ *
 * 公共类型
 * ------------------------------------------------------------------ */

/** 一次逻辑命令的输入；commandId/issuedAt/expiresAt 缺省在首次发送前生成一次并冻结。 */
export interface SubmitCommandInput {
  readonly commandId?: string;
  readonly operation: AppOperation;
  readonly scope: CommandScope;
  readonly expectedRevision?: number;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly payload: unknown;
}

export interface SubmitCommandOptions {
  /** 中止信号：立即以 unreachable(aborted) 拒绝，不折算 outcome_unknown。 */
  readonly signal?: AbortSignal;
  /**
   * F-016：显式信封身份（命令幂等重放）。与输入对象中的 commandId 等价；
   * issuedAt 用于按既有回执的原时间重建同一信封（同摘要 → 重放原回执，
   * 不同参数 → conflict）。缺省时由客户端生成一次并冻结。
   */
  readonly commandId?: string;
  readonly issuedAt?: string;
}

/** 项目列表分页/筛选输入（§7.1；取值规则由 Core 复核，客户端做形态把关）。 */
export interface ListProjectsInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly labels?: readonly string[];
  readonly match?: 'any' | 'all';
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 基线面输入/输出类型（§6/§7.4-§7.6）
 * ------------------------------------------------------------------ */

/** baseline.preview 输入（plan 形状由 Core 深校验，客户端只做结构把关）。 */
export interface PreviewBaselineInput {
  readonly projectId: string;
  readonly plan: unknown;
  readonly commandId?: string;
}

/** baseline.run 输入：decision/plan/previewDigest 绑定用户确认的完整输入摘要。 */
export interface RunBaselineInput {
  readonly projectId: string;
  readonly decision: 'authorize' | 'decline';
  readonly plan: unknown;
  readonly previewDigest: string;
  readonly commandId?: string;
}

/** baselines.list 分页输入（§7.4：limit 1..100；cursor 为上一页最后 operationId）。 */
export interface ListBaselinesInput {
  readonly limit?: number;
  readonly cursor?: string;
}

/* ------------------------------------------------------------------ *
 * P03-1 / F-009 计划域输入类型（§6.4-§6.8/§6.6）
 * ------------------------------------------------------------------ */

/** phase.create 输入（id 可缺省由服务端生成；字段语义由服务端单一权威复核）。 */
export interface CreatePhaseInput {
  readonly projectId: string;
  readonly id?: string;
  readonly title: string;
  readonly description?: string | null;
  readonly labels?: readonly string[];
  readonly commandId?: string;
}

/** feature.plan.import 输入（expectedRevision 为目标 Phase 聚合 CAS）。 */
export interface ImportFeaturePlanInput {
  readonly projectId: string;
  readonly phaseId: string;
  readonly expectedRevision: number;
  readonly plan: unknown;
  readonly commandId?: string;
}

/** plan.labels.update 目标实体类型（phase/feature/task）。 */
export type PlanLabelEntityType = 'phase' | 'feature' | 'task';

/** plan.labels.update 输入（expectedRevision 为目标实体自身 revision）。 */
export interface UpdatePlanLabelsInput {
  readonly projectId: string;
  readonly entityType: PlanLabelEntityType;
  readonly id: string;
  readonly expectedRevision: number;
  readonly labels: readonly string[];
  readonly commandId?: string;
}

/** feature.plan.revise 输入（expectedRevision 为目标 Feature 聚合 revision）。 */
export interface ReviseFeaturePlanInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly expectedRevision: number;
  readonly plan: unknown;
  readonly commandId?: string;
}

/** 计划层级列表分页输入（limit 1..200；cursor 为不透明 plcur_v1_ 游标）。 */
export interface PlanListPageInput {
  readonly limit?: number;
  readonly cursor?: string;
}

/** P03-8 / F-009 git.operations.list 父级选择（Feature 或 Run 二选一）。 */
export type GitOperationListParentInput =
  | { readonly featureId: string }
  | { readonly runId: string };

/* ------------------------------------------------------------------ *
 * P03-2 / F-007 决策/策略/输入准备输入类型
 * ------------------------------------------------------------------ */

/**
 * feature.plan.decide 输入（expectedRevision 为 Feature 聚合 revision；
 * planDigest 为提交时绑定的当前计划摘要，失效即 fail-closed；decisionActor
 * 等身份一律不能经请求输入，决策人由可信装配固定绑定）。
 */
export interface DecideFeaturePlanInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly planDigest: string;
  readonly decision: 'approve' | 'reject';
  readonly reason?: string | null;
  readonly expectedRevision: number;
  readonly commandId?: string;
}

/**
 * task.strategy.update 输入（expectedRevision 为 Task 自身 revision；
 * executionConfig 为完整策略副本，configSource 等来源字段由服务端定值）。
 */
export interface UpdateTaskStrategyInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly executionConfig: Record<string, unknown>;
  readonly expectedRevision: number;
  readonly commandId?: string;
}

/**
 * task.approval.block 输入（F-007/F-014：添加阻塞/必需审批事项）。
 * expectedRevision 为 Task 自身 revision；responsibleParty 是业务责任主体
 * 名（不是认证身份），认证主体由可信装配固定绑定，不接受请求声明。
 */
export interface TaskApprovalBlockInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly planDigest: string;
  readonly expectedRevision: number;
  readonly kind?: 'block' | 'approval';
  readonly description?: string;
  readonly responsibleParty?: string;
  readonly codeDigest?: string | null;
  readonly artifactRefs?: readonly { readonly artifactId: string; readonly contentHash: string | null }[];
  readonly commandId?: string;
}

/**
 * task.approval.approve/reject/unblock 输入（F-008/F-014）：决定由 decision
 * 给定并绑定当前 planDigest/codeDigest/产物摘要；decisionActor/principalId
 * 一律不能经请求输入。expectedRevision 为 Task 自身 revision。
 */
export interface TaskApprovalDecisionInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly itemId: string;
  readonly planDigest: string;
  readonly codeDigest: string;
  readonly decision: 'approve' | 'reject' | 'unblock';
  readonly expectedRevision: number;
  readonly artifactRefs?: readonly { readonly artifactId: string; readonly contentHash: string | null }[];
  readonly reason?: string | null;
  readonly commandId?: string;
}

/**
 * task.verification.continue 输入（F-012/F-014）：只携带目标与已保存机器证据
 * 身份（批次/代码/观察摘要）；任何身份漂移由服务端 fail-closed 拒绝。
 */
export interface TaskVerificationContinueInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly verificationBatchId: string;
  readonly codeDigest: string;
  readonly observationDigest: string;
  readonly expectedRevision: number;
  readonly commandId?: string;
}

/**
 * feature.verification.continue 输入（P03-8 / F-008/F-011）：显式 Feature 收尾
 * 请求。expectedRevision 为 Feature 聚合 revision；payload 恰好是 featureId/
 * runId/batchId/operationId（operationId 是 UUID v4 的 Git 操作身份）；Git
 * 身份、证据、主体与授权标志一律不能经请求输入。
 */
export interface FeatureVerificationContinueInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly commandId?: string;
}

/**
 * execution.input.prepare 输入（创建类：不携带 expectedRevision；items 为
 * 必需输入采集清单，逐项深校验在应用层，拒绝任何内联正文/任意路径形态）。
 */
export interface PrepareExecutionInputInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly items: readonly unknown[];
  readonly commandId?: string;
}

/** execution.preview/start 的单 Feature 授权输入。预算深校验由 Core 完成。 */
export interface PreviewExecutionInput {
  readonly projectId: string;
  readonly featureIds: readonly string[];
  readonly budget: unknown;
  readonly commandId?: string;
}

export interface StartExecutionInput {
  readonly projectId: string;
  readonly featureIds: readonly string[];
  readonly budget?: unknown;
  readonly previewDigest?: string;
  readonly retryBatchId?: string;
  readonly commandId?: string;
}

export interface ReviseExecutionBudgetInput {
  readonly projectId: string;
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly budget: unknown;
  readonly reason: string;
  readonly commandId?: string;
}

export interface BudgetRevisionListInput {
  readonly limit?: number;
  readonly cursor?: string;
}

/* ------------------------------------------------------------------ *
 * P03-5 / F-012 工作区状态查询与人工丢弃预览/确认输入类型
 * ------------------------------------------------------------------ */

/** workspaces.list 分页/筛选输入（limit 1..500；cursor 为 wscur_v1_ 不透明游标）。 */
export interface ListWorkspacesInput {
  readonly featureId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** workspace.operations.list 分页/筛选输入（同一工作区分页纪律）。 */
export interface ListWorkspaceOperationsInput {
  readonly featureId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** workspace.discard.preview 输入：只读预览 + 不可变证据发布（创建类命令）。 */
export interface PreviewWorkspaceDiscardInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly commandId?: string;
}

/**
 * workspace.discard 输入：人工确认丢弃（绑定当前 workspace revision、HEAD、
 * 内容摘要与明确预览摘要；客户端只做形态把关，深校验与门禁由 Core 单一权威）。
 */
export interface ConfirmWorkspaceDiscardInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedWorkspaceRevision: number;
  readonly preview: WorkspaceDiscardPreviewBinding;
  readonly evidenceRefs: readonly string[];
  readonly commandId?: string;
}

/** artifacts.get 的授权证据正文（§7.6：text/plain 有界内容，已脱敏）。 */
export interface BaselineArtifactContentResult {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly content: string;
}

/** SSE 订阅输入：恢复位置 cursor/lastEventId 至少其一（缺省零网络拒绝）。 */
export interface SubscribeEventsInput {
  readonly scope: SettingsScope;
  readonly cursor?: string;
  readonly lastEventId?: string;
  readonly onEvent: (event: PublicStateEvent) => void;
  readonly signal?: AbortSignal;
}

/** 观察流结束原因（全部明确分类；不折算成功/业务完成）。 */
export type EventStreamEnd =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'protocol_error'; readonly reason: string }
  | { readonly kind: 'snapshot_required'; readonly snapshotRoute: string }
  | { readonly kind: 'stream_overflow'; readonly snapshotRoute: string };

/** 活跃 SSE 订阅句柄；close 幂等，只释放本地观察资源。 */
export interface HostEventSubscription {
  /** 流结束即 resolve（绝不 reject）。 */
  readonly ended: Promise<EventStreamEnd>;
  /** 最后一个成功投递事件的 eventId（自动重连的 Last-Event-ID）。 */
  lastEventId(): string | undefined;
  /** 建连使用的恢复游标（订阅期间不变）。 */
  resumeCursor(): string | undefined;
  /** 幂等；只释放本地观察资源，绝不触发 stop/cancel。 */
  close(): void;
}

/** HostClient 应用面方法集（connectToHost 返回对象的一部分）。 */
export interface HostClientApplication {
  listWorkSessions(projectId: string, input: { readonly runId?: string; readonly taskId?: string; readonly limit?: number; readonly cursor?: string }): Promise<WorkSessionListResult>;
  getWorkSession(projectId: string, attemptId: string): Promise<WorkSessionDetailResult>;
  readWorkSessionEvidence(projectId: string, attemptId: string, artifactId: string): Promise<WorkSessionEvidenceContent>;
  cancelAttempt(input: { readonly projectId: string; readonly attemptId: string; readonly commandId?: string }, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  submitCommand(input: SubmitCommandInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  getReceipt(commandId: string): Promise<CommandReceipt>;
  resolveResult(resultRef: string): Promise<CommandReceipt>;
  listProjects(options?: ListProjectsInput): Promise<ProjectListResult>;
  getProject(projectId: string): Promise<ProjectDetailResult>;
  /** P02-3 / F-006（§7.2）：注册前只读仓库检查（path 为仓库根绝对路径）。 */
  inspectRepository(path: string): Promise<ProjectInspectionResult>;
  /** P02-3 / F-006（§7.3）：注册状态与健康状态分开的项目概览。 */
  getProjectOverview(projectId: string): Promise<ProjectOverviewResult>;
  getRepositoryBinding(projectId: string): Promise<ProjectBindingResult>;
  countProjectLabels(): Promise<ProjectLabelCountsResult>;
  getGlobalSettings(): Promise<PublicSettingsState>;
  exportGlobalSettings(): Promise<ExportedSettings>;
  getProjectSettings(projectId: string): Promise<PublicSettingsState>;
  getEffectiveSettings(projectId: string): Promise<EffectiveSettings>;
  exportProjectSettings(projectId: string): Promise<ExportedSettings>;
  getSnapshot(scope: { readonly kind: 'project'; readonly projectId: string }): Promise<ProjectSnapshotResult>;
  getSnapshot(scope: { readonly kind: 'global' }): Promise<GlobalSnapshotResult>;
  getSnapshot(scope: SettingsScope): Promise<SnapshotResult>;
  subscribeEvents(input: SubscribeEventsInput): Promise<HostEventSubscription>;
  /**
   * P02-3 / F-014（§6/§7.6）：baseline.preview 命令（只读预览）。completed
   * 回执的 result 经预览形状校验；rejected/业务拒绝按回执原样返回。
   */
  previewBaseline(input: PreviewBaselineInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /**
   * P02-3 / F-014（§5.3/§6）：baseline.run 命令。authorize → 202 accepted
   * 回执（携带 operationId，检查随后台异步执行；本方法不等待执行完成）；
   * decline → completed 回执（result 经形状校验）。
   */
  runBaseline(input: RunBaselineInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /**
   * P02-3 / F-014（§6）：baseline.cancel 显式取消命令（唯一取消途径；
   * 客户端断开/close/Abort 绝不自动取消后台检查）。completed 回执的
   * result 经形状校验。
   */
  cancelBaseline(
    projectId: string,
    operationId: string,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** P02-3 / F-014（§7.4）：项目基线操作键集分页查询。 */
  listBaselines(projectId: string, input?: ListBaselinesInput): Promise<BaselineListResult>;
  /** P02-3 / F-014（§7.5）：单次基线操作详情（授权摘要 + 逐项检查）。 */
  getBaseline(operationId: string): Promise<BaselineDetailResult>;
  /** P02-3 / F-014（§7.6）：正式基线证据制品正文（有界、已授权、已脱敏）。 */
  readArtifactContent(artifactId: string): Promise<BaselineArtifactContentResult>;
  /* ------------------------------------------------------------ *
   * P03-1 / F-009 计划域命令与查询（§6.4-§6.8/§6.6）
   * ------------------------------------------------------------ */
  /** phase.create：创建 open Phase（completed 回执 result 经线校验器复核）。 */
  createPhase(input: CreatePhaseInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /** feature.plan.import：单 Feature 草稿计划导入（Phase 聚合 CAS）。 */
  importFeaturePlan(
    input: ImportFeaturePlanInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** plan.labels.update：纯标签 CAS 编辑（目标实体自身 revision）。 */
  updatePlanLabels(
    input: UpdatePlanLabelsInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** feature.plan.revise：未执行草稿的实质计划修订（Feature 聚合 CAS）。 */
  reviseFeaturePlan(
    input: ReviseFeaturePlanInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** phases.list：项目内 Phase 层级列表（稳定排序、受控游标）。 */
  listPhases(projectId: string, input?: PlanListPageInput): Promise<PhaseListResult>;
  /** phases.get：Phase 详情（真实父级/标签/revision）。 */
  getPhase(phaseId: string): Promise<PhaseDetailResult>;
  /** features.list：Phase 内 Feature 层级列表。 */
  listFeatures(
    projectId: string,
    phaseId: string,
    input?: PlanListPageInput,
  ): Promise<FeatureListResult>;
  /** features.get：Feature 详情与完整同 Feature Task DAG（一致读视图）。 */
  getFeature(featureId: string): Promise<FeatureDetailResult>;
  /** tasks.list：Feature 内 Task 层级列表。 */
  listTasks(
    projectId: string,
    featureId: string,
    input?: PlanListPageInput,
  ): Promise<TaskListResult>;
  /** tasks.get：Task 详情（验收/引用/策略副本与来源）。 */
  getTask(taskId: string): Promise<TaskDetailResult>;
  /* ------------------------------------------------------------ *
   * P03-2 / F-007 决策/策略/输入准备命令与授权查询
   * ------------------------------------------------------------ */
  /**
   * feature.plan.decide：批准/拒绝当前计划摘要（Feature 聚合 CAS；批准只
   * 确认现有计划，不是启动授权）。completed 回执 result 经线校验器复核。
   */
  decideFeaturePlan(
    input: DecideFeaturePlanInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** task.strategy.update：Task 策略副本 CAS 编辑（来源服务端定值 task_edit）。 */
  updateTaskStrategy(
    input: UpdateTaskStrategyInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * task.approval.block：添加阻塞/必需审批事项（F-007/F-014）。只写事项事实，
   * 不创建执行实体、不调用 Runtime；completed 回执 result 经线校验器复核。
   */
  submitTaskApprovalBlock(
    input: TaskApprovalBlockInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * task.approval.approve/reject/unblock：事项决定（F-008/F-014）。决定绑定
   * 当前摘要，绝不启动执行；completed 回执 result 经线校验器复核。
   */
  submitTaskApprovalDecision(
    input: TaskApprovalDecisionInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * task.verification.continue：人工批准后的显式验证继续（F-012/F-014）。
   * 只复用已保存机器证据，不调用 Runtime、不创建 Attempt。
   */
  continueTaskVerification(
    input: TaskVerificationContinueInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * feature.verification.continue：显式 Feature 收尾（P03-8 / F-008/F-011）。
   * 运行既有最终检查、读取当前审批并经受控提交完成交付；completed 回执
   * result 经线校验器复核（runtimeCalled=false；outcome 非 completed 不是
   * 交付成功）。需要 Host 已可信装配 delivery 能力，否则 unsupported。
   */
  continueFeatureVerification(
    input: FeatureVerificationContinueInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * execution.input.prepare：执行输入制品组准备（可绑定输入身份；正文永不
   * 内联，不创建执行实体、不声称已启动执行）。
   */
  prepareExecutionInput(
    input: PrepareExecutionInputInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /** features.approvals：当前批准 vs 历史决定 + fail-closed 有效批准评估。 */
  getFeatureApprovals(featureId: string): Promise<FeatureApprovalsResult>;
  /** execution.preview：只读授权预览，completed result 经线协议校验。 */
  previewExecution(input: PreviewExecutionInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /** execution.start：返回 completed/rejected 或 Work accepted；不等待 Runtime。 */
  startExecution(input: StartExecutionInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  /** execution.budget.revise：通过既有幂等命令入口提交 CAS 修订。 */
  reviseExecutionBudget(input: ReviseExecutionBudgetInput, options?: SubmitCommandOptions): Promise<CommandReceipt>;
  getExecutionBudgetStatus(projectId: string, batchId: string): Promise<ExecutionBudgetStatusResult>;
  listBatchBudgetRevisions(projectId: string, batchId: string, input?: BudgetRevisionListInput): Promise<BudgetRevisionListResult>;
  /* ------------------------------------------------------------ *
   * P03-4 / F-008 调度诊断与 Attempt 审计只读查询
   * ------------------------------------------------------------ */
  /**
   * execution.run.schedule：Run 调度原因与 Task 派生就绪视图（只读派生；
   * ready/blocked 不是第二套可写状态，executionStage 原样展示不代表验收）。
   */
  getRunScheduleStatus(projectId: string, runId: string): Promise<RunScheduleStatusResult>;
  /** execution.attempts.list：Task 的 Attempt 审计分页（受控 plcur_v1_ 游标）。 */
  listExecutionAttempts(
    projectId: string,
    taskId: string,
    input?: PlanListPageInput,
  ): Promise<AttemptListResult>;
  /** execution.attempt.diagnostics：Attempt 迟到/越权通知诊断审计分页。 */
  listAttemptDiagnostics(
    projectId: string,
    attemptId: string,
    input?: PlanListPageInput,
  ): Promise<AttemptDiagnosticsResult>;
  /* ------------------------------------------------------------ *
   * P03-7 / F-013 Task 机器证据/人审事项/有限返工链只读查询
   * ------------------------------------------------------------ */
  /**
   * execution.task.verification.get：Task 当前机器结论 + 有界 VerificationBatch/
   * CheckResult（选择/回退理由、代码身份、输出 Artifact/tail 引用）；机器 passed
   * 不展示为有效 Task passed（effectivePassed 只绑定持久 Task 状态）。
   */
  getTaskVerification(projectId: string, taskId: string): Promise<TaskVerificationDetailResult>;
  /** execution.task.approvals.list：独立人审事项分页（受控 plcur_v1_ 游标）。 */
  listTaskApprovalItems(
    projectId: string,
    taskId: string,
    input?: PlanListPageInput,
  ): Promise<TaskApprovalItemListResult>;
  /**
   * execution.task.rework-chain.list：有限返工链分页 + 代码资格已用/剩余、
   * 总预算阻止原因、Run 暂停原因与后继 blocked 原因汇总；未知退出/耗时保持 null。
   */
  listTaskReworkChain(
    projectId: string,
    taskId: string,
    input?: PlanListPageInput,
  ): Promise<TaskReworkChainListResult>;
  /* ------------------------------------------------------------ *
   * P03-8 / F-009 Git 意图/实际提交/操作回执只读查询
   * ------------------------------------------------------------ */
  /**
   * git.operations.list：同项目 Feature 或 Run 的 Git 意图/实际提交/操作回执
   * 分页（父级二选一；受控 plcur_v1_ 游标；pending/unknown 待核对不显示成功）。
   */
  listGitOperations(
    projectId: string,
    parent: GitOperationListParentInput,
    input?: PlanListPageInput,
  ): Promise<GitOperationListResult>;
  /** git.operations.get：按 operationId 的完整意图 + 实际事实 + 回执投影。 */
  getGitOperation(projectId: string, operationId: string): Promise<GitOperationDetailResult>;
  /* ------------------------------------------------------------ *
   * P03-8 / F-010 Feature 分轴结果只读查询
   * ------------------------------------------------------------ */
  /**
   * features.delivery.get：Feature Task/最终检查/人工审批/交付分轴结果与
   * 可区分总体 outcome；completed 不掩盖缺失证据或其他轴失败。
   */
  getFeatureDelivery(projectId: string, featureId: string): Promise<FeatureDeliveryDetailResult>;
  /* ------------------------------------------------------------ *
   * P03-5 / F-012 工作区状态只读查询与人工丢弃预览/确认
   * ------------------------------------------------------------ */
  /** workspaces.list：项目内受管工作区键集分页（只读；不修改任何状态）。 */
  listWorkspaces(projectId: string, input?: ListWorkspacesInput): Promise<WorkspaceListResult>;
  /** workspaces.get：工作区详情（准备 operation 与最新 operation 完整视图）。 */
  getWorkspace(projectId: string, featureId: string): Promise<WorkspaceDetailResult>;
  /** workspace.operations.list：工作区 operation 审计键集分页。 */
  listWorkspaceOperations(
    projectId: string,
    input?: ListWorkspaceOperationsInput,
  ): Promise<WorkspaceOperationListResult>;
  /** workspace.operations.get：单次 operation 详情（结果与当前回执投影）。 */
  getWorkspaceOperation(
    projectId: string,
    operationId: string,
  ): Promise<WorkspaceOperationDetailResult>;
  /**
   * workspace.discard.preview：人工丢弃只读预览（completed 回执 result 经预览
   * 形状线校验；预览不是删除，也不授权自动确认）。
   */
  previewWorkspaceDiscard(
    input: PreviewWorkspaceDiscardInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
  /**
   * workspace.discard：人工确认丢弃（专属幂等通道；completed 回执 result 经
   * 登记摘要线校验——命令 completed ≠ 丢弃成功，实际结果经 workspace.operations
   * 查询读取）。
   */
  confirmWorkspaceDiscard(
    input: ConfirmWorkspaceDiscardInput,
    options?: SubmitCommandOptions,
  ): Promise<CommandReceipt>;
}

/** 由 connectToHost 注入的会话上下文（身份/预算/生命周期钩子）。 */
export interface AppClientContext {
  readonly port: number;
  readonly token: string;
  readonly connectMs: number;
  readonly appRequestMs: number;
  readonly submitBudgetMs: number;
  /** 客户端关闭即拒绝新操作（client_closed）。 */
  assertOpen(operation: HostOperation): void;
  /** 登记/注销活跃订阅：client.close() 级联释放本地观察资源。 */
  registerSubscription(subscription: HostEventSubscription): void;
  unregisterSubscription(subscription: HostEventSubscription): void;
}

function invalidInput(operation: HostOperation, reason: string, field?: string): HostProtocolError {
  return new HostProtocolError('invalid_input', operation, 'HostClient 输入未通过校验', {
    details: field === undefined ? { reason } : { reason, field },
  });
}

function abortedError(operation: HostOperation): HostProtocolError {
  return new HostProtocolError('unreachable', operation, '操作已被 AbortSignal 中止', {
    details: { reason: 'aborted' },
  });
}

/**
 * 提取可选提交选项（参数以 unknown 视角校验，避免类型守卫收窄干扰调用方类型）：
 * signal / 信封身份（commandId/issuedAt；F-016 幂等重放用）。
 */
function extractAbortSignal(
  options: { readonly signal?: unknown; readonly commandId?: unknown; readonly issuedAt?: unknown } | undefined,
  operation: HostOperation,
): {
  readonly signal: AbortSignal | undefined;
  readonly commandId: string | undefined;
  readonly issuedAt: string | undefined;
} {
  if (options === undefined) {
    return { signal: undefined, commandId: undefined, issuedAt: undefined };
  }
  if (!isPlainObject(options)) {
    throw invalidInput(operation, 'invalid_options');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'signal' && key !== 'commandId' && key !== 'issuedAt') {
      throw invalidInput(operation, 'unknown_option_key', key);
    }
  }
  const signal: unknown = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidInput(operation, 'invalid_signal', 'signal');
  }
  const commandId: unknown = options.commandId;
  if (commandId !== undefined && (typeof commandId !== 'string' || !isUuidV4(commandId))) {
    throw invalidInput(operation, 'invalid_command_id', 'commandId');
  }
  const issuedAt: unknown = options.issuedAt;
  if (issuedAt !== undefined && (typeof issuedAt !== 'string' || issuedAt.length === 0)) {
    throw invalidInput(operation, 'invalid_issued_at', 'issuedAt');
  }
  return {
    signal: signal as AbortSignal | undefined,
    commandId: commandId as string | undefined,
    issuedAt: issuedAt as string | undefined,
  };
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return (
    isHostProtocolError(error, 'unreachable') &&
    (error.details as Record<string, unknown> | undefined)?.reason === 'aborted'
  );
}

/** 有界等待；中止立即抛 unreachable(aborted)，等待不超过 deadline。 */
function boundedDelay(
  ms: number,
  signal: AbortSignal | undefined,
  deadlineMs: number,
  operation: HostOperation,
): Promise<void> {
  const remaining = deadlineMs - Date.now();
  const waitMs = Math.max(0, Math.min(ms, remaining));
  return new Promise<void>((resolveWait, rejectWait) => {
    if (signal?.aborted === true) {
      rejectWait(abortedError(operation));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, waitMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectWait(abortedError(operation));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ *
 * 信封冻结与本地校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const SUBMIT_INPUT_KEYS = [
  'commandId',
  'operation',
  'scope',
  'expectedRevision',
  'issuedAt',
  'expiresAt',
  'payload',
] as const;

interface FrozenEnvelope {
  readonly commandId: string;
  readonly operation: AppOperation;
  readonly wire: Record<string, unknown>;
  readonly requestDigest: string;
}

/**
 * 构造并冻结信封：commandId/issuedAt 缺省生成一次；经 Core
 * validateCommandEnvelope 完整校验（同一权威，不另立第二份），任何
 * PublicError 都折算为客户端 invalid_input（本地输入错误，零网络）。
 */
function freezeCommandEnvelope(input: SubmitCommandInput): FrozenEnvelope {
  if (!isPlainObject(input)) {
    throw invalidInput('commands.submit', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(SUBMIT_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('commands.submit', 'unknown_option_key', key);
    }
  }
  const commandId = input.commandId ?? randomUUID();
  const wire: Record<string, unknown> = {
    // 线消息版本随 shiploop-core 协议常量（P02-3 / F-006 起 v3），不另立字面量。
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    commandId,
    operation: input.operation,
    scope: input.scope,
  };
  if (input.expectedRevision !== undefined) {
    wire.expectedRevision = input.expectedRevision;
  }
  wire.issuedAt = input.issuedAt ?? new Date().toISOString();
  if (input.expiresAt !== undefined) {
    wire.expiresAt = input.expiresAt;
  }
  wire.payload = input.payload;
  try {
    const validated = validateCommandEnvelope(wire);
    return {
      commandId,
      operation: validated.operation,
      wire,
      requestDigest: computeCommandRequestDigest(validated),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'PublicError') {
      const details = (error as { details?: Record<string, unknown> }).details;
      const field = typeof details?.field === 'string' ? details.field : undefined;
      throw invalidInput('commands.submit', 'invalid_command_envelope', field);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 查询输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const LIST_INPUT_KEYS = ['limit', 'cursor', 'labels', 'match'] as const;

/** §7.1/§13：分页 1..200、标签 ≤50 个、match any/all；查询串键序冻结。 */
function buildProjectListQuery(input: ListProjectsInput | undefined): string {
  if (input === undefined) {
    return '';
  }
  if (!isPlainObject(input)) {
    throw invalidInput('projects.list', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(LIST_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('projects.list', 'unknown_option_key', key);
    }
  }
  const params = new URLSearchParams();
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw invalidInput('projects.list', 'invalid_limit', 'limit');
    }
    params.append('limit', String(input.limit));
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length === 0) {
      throw invalidInput('projects.list', 'invalid_cursor', 'cursor');
    }
    params.append('cursor', input.cursor);
  }
  if (input.labels !== undefined) {
    if (
      !Array.isArray(input.labels) ||
      input.labels.length > 50 ||
      !input.labels.every(
        (label) => typeof label === 'string' && label.length > 0 && label.length <= 64,
      )
    ) {
      throw invalidInput('projects.list', 'invalid_labels', 'labels');
    }
    for (const label of input.labels) {
      params.append('label', label);
    }
  }
  if (input.match !== undefined) {
    if (input.match !== 'any' && input.match !== 'all') {
      throw invalidInput('projects.list', 'invalid_match', 'match');
    }
    params.append('match', input.match);
  }
  return params.toString();
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * §7.2 inspect 输入零网络把关：path 必须是非空绝对路径字符串（无 NUL）。
 * 完整校验（存在/目录/Git 仓库根/规范路径）由服务端 RepositoryInspector
 * 单一权威完成；客户端只拒绝明显非法输入，不复制服务端规则。
 */
function requireRepositoryPathInput(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\u0000') ||
    !path.startsWith('/')
  ) {
    throw invalidInput('projects.inspect', 'invalid_repository_path', 'path');
  }
  return path;
}

function requireProjectId(operation: HostOperation, projectId: string): string {
  if (typeof projectId !== 'string' || !STABLE_ID_PATTERN.test(projectId)) {
    throw invalidInput(operation, 'invalid_project_id', 'projectId');
  }
  return projectId;
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 基线输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const PREVIEW_INPUT_KEYS = ['projectId', 'plan', 'commandId'] as const;
const RUN_INPUT_KEYS = ['projectId', 'decision', 'plan', 'previewDigest', 'commandId'] as const;
const BASELINE_LIST_INPUT_KEYS = ['limit', 'cursor'] as const;

function rejectUnknownInputKeys(
  operation: HostOperation,
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw invalidInput(operation, 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw invalidInput(operation, 'unknown_option_key', key);
    }
  }
  return input;
}

function requireOperationIdInput(operation: HostOperation, operationId: string): string {
  if (!isUuidV4(operationId)) {
    throw invalidInput(operation, 'invalid_operation_id', 'operationId');
  }
  return operationId;
}

function requireArtifactIdInput(operation: HostOperation, artifactId: string): string {
  if (typeof artifactId !== 'string' || !STABLE_ID_PATTERN.test(artifactId)) {
    throw invalidInput(operation, 'invalid_artifact_id', 'artifactId');
  }
  return artifactId;
}

/** §7.4：limit 1..100；cursor 是上一页最后 operationId（UUID v4）。键序冻结。 */
function buildBaselineListQuery(input: ListBaselinesInput | undefined): string {
  if (input === undefined) {
    return '';
  }
  const object = rejectUnknownInputKeys('baselines.list', input, BASELINE_LIST_INPUT_KEYS);
  const params = new URLSearchParams();
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > 100
    ) {
      throw invalidInput('baselines.list', 'invalid_limit', 'limit');
    }
    params.append('limit', String(object.limit));
  }
  if (object.cursor !== undefined) {
    if (typeof object.cursor !== 'string' || !isUuidV4(object.cursor)) {
      throw invalidInput('baselines.list', 'invalid_cursor', 'cursor');
    }
    params.append('cursor', object.cursor);
  }
  return params.toString();
}

/** §8 scope：global 无 projectId；project 必须携带稳定 ID。 */
function validateSnapshotScope(operation: HostOperation, scope: SettingsScope): SettingsScope {
  if (!isPlainObject(scope)) {
    throw invalidInput(operation, 'invalid_scope', 'scope');
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'kind' && key !== 'projectId') {
      throw invalidInput(operation, 'unknown_option_key', `scope.${key}`);
    }
  }
  if (scope.kind === 'global') {
    if (Object.prototype.hasOwnProperty.call(scope, 'projectId')) {
      throw invalidInput(operation, 'scope_conflict', 'scope.projectId');
    }
    return { kind: 'global' };
  }
  if (scope.kind === 'project') {
    const projectId = (scope as { projectId?: unknown }).projectId;
    if (typeof projectId !== 'string' || !STABLE_ID_PATTERN.test(projectId)) {
      throw invalidInput(operation, 'invalid_project_id', 'scope.projectId');
    }
    return { kind: 'project', projectId };
  }
  throw invalidInput(operation, 'invalid_scope_kind', 'scope.kind');
}

/* ------------------------------------------------------------------ *
 * P03-1 / F-009 计划域输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const CREATE_PHASE_INPUT_KEYS = ['projectId', 'id', 'title', 'description', 'labels', 'commandId'] as const;
const IMPORT_PLAN_INPUT_KEYS = ['projectId', 'phaseId', 'expectedRevision', 'plan', 'commandId'] as const;
const UPDATE_PLAN_LABELS_INPUT_KEYS = ['projectId', 'entityType', 'id', 'expectedRevision', 'labels', 'commandId'] as const;
const REVISE_PLAN_INPUT_KEYS = ['projectId', 'featureId', 'expectedRevision', 'plan', 'commandId'] as const;
const PLAN_LIST_INPUT_KEYS = ['limit', 'cursor'] as const;
// P03-2 / F-007：决策/策略编辑/输入准备输入键（严格未知键拒绝；身份字段
//（decisionActor/principalId 等）不能经请求输入，命令信封 payload 面冻结）。
const DECIDE_PLAN_INPUT_KEYS = [
  'projectId',
  'featureId',
  'planDigest',
  'decision',
  'reason',
  'expectedRevision',
  'commandId',
] as const;
const UPDATE_TASK_STRATEGY_INPUT_KEYS = [
  'projectId',
  'taskId',
  'executionConfig',
  'expectedRevision',
  'commandId',
] as const;
const PREPARE_EXECUTION_INPUT_KEYS = [
  'projectId',
  'featureId',
  'taskId',
  'items',
  'commandId',
] as const;
// P03-7 / F-014：人审事项阻塞/决定与显式验证继续输入键（严格未知键拒绝：
// principalId/decisionActor/credentials 等身份与凭据字段不能经请求输入）。
const TASK_APPROVAL_BLOCK_INPUT_KEYS = [
  'projectId',
  'taskId',
  'planDigest',
  'expectedRevision',
  'kind',
  'description',
  'responsibleParty',
  'codeDigest',
  'artifactRefs',
  'commandId',
] as const;
const TASK_APPROVAL_DECISION_INPUT_KEYS = [
  'projectId',
  'taskId',
  'itemId',
  'planDigest',
  'codeDigest',
  'decision',
  'expectedRevision',
  'artifactRefs',
  'reason',
  'commandId',
] as const;
const TASK_VERIFICATION_CONTINUE_INPUT_KEYS = [
  'projectId',
  'taskId',
  'attemptId',
  'verificationBatchId',
  'codeDigest',
  'observationDigest',
  'expectedRevision',
  'commandId',
] as const;
const FEATURE_VERIFICATION_CONTINUE_INPUT_KEYS = [
  'projectId',
  'featureId',
  'runId',
  'batchId',
  'operationId',
  'expectedRevision',
  'commandId',
] as const;
const EXECUTION_PREVIEW_INPUT_KEYS = ['projectId', 'featureIds', 'budget', 'commandId'] as const;
const EXECUTION_START_INPUT_KEYS = ['projectId', 'featureIds', 'budget', 'previewDigest', 'retryBatchId', 'commandId'] as const;
const EXECUTION_BUDGET_REVISE_INPUT_KEYS = ['projectId', 'batchId', 'expectedRevision', 'budget', 'reason', 'commandId'] as const;
const BUDGET_REVISION_LIST_INPUT_KEYS = ['limit', 'cursor'] as const;

function requireFeatureIds(operation: HostOperation, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && STABLE_ID_PATTERN.test(id))) {
    throw invalidInput(operation, 'invalid_feature_ids', 'featureIds');
  }
  return [...value];
}

function requireBudgetObject(operation: HostOperation, value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidInput(operation, 'invalid_budget', field);
  return value;
}

function requireSha256Input(operation: HostOperation, value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalidInput(operation, 'invalid_digest', field);
  }
  return value;
}

function buildBudgetRevisionListQuery(
  input: BudgetRevisionListInput | undefined,
  operation: HostOperation,
): string {
  if (input === undefined) return '';
  const object = rejectUnknownInputKeys(operation, input, BUDGET_REVISION_LIST_INPUT_KEYS);
  const params = new URLSearchParams();
  if (object.limit !== undefined) {
    if (typeof object.limit !== 'number' || !Number.isInteger(object.limit) || object.limit < 1 || object.limit > PLAN_LIST_MAX_LIMIT) {
      throw invalidInput(operation, 'invalid_limit', 'limit');
    }
    params.append('limit', String(object.limit));
  }
  if (object.cursor !== undefined) {
    if (typeof object.cursor !== 'string' || !object.cursor.startsWith(PLAN_LIST_CURSOR_PREFIX)) {
      throw invalidInput(operation, 'invalid_cursor', 'cursor');
    }
    params.append('cursor', object.cursor);
  }
  return params.toString();
}

function requireStableIdInput(operation: HostOperation, value: unknown, field: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    throw invalidInput(operation, 'invalid_stable_id', field);
  }
  return value;
}

function requireExpectedRevisionInput(operation: HostOperation, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw invalidInput(operation, 'invalid_expected_revision', 'expectedRevision');
  }
  return value;
}

function optionalCommandIdInput(operation: HostOperation, value: unknown): { readonly commandId?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string' || !isUuidV4(value)) {
    throw invalidInput(operation, 'invalid_command_id', 'commandId');
  }
  return { commandId: value };
}

/** 计划列表分页输入：limit 1..PLAN_LIST_MAX_LIMIT；cursor 为 plcur_v1_ 形态。 */
function buildPlanListQuery(input: PlanListPageInput | undefined, operation: HostOperation): string {
  if (input === undefined) {
    return '';
  }
  const object = rejectUnknownInputKeys(operation, input, PLAN_LIST_INPUT_KEYS);
  const params = new URLSearchParams();
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > PLAN_LIST_MAX_LIMIT
    ) {
      throw invalidInput(operation, 'invalid_limit', 'limit');
    }
    params.append('limit', String(object.limit));
  }
  if (object.cursor !== undefined) {
    if (
      typeof object.cursor !== 'string' ||
      !object.cursor.startsWith(PLAN_LIST_CURSOR_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(object.cursor.slice(PLAN_LIST_CURSOR_PREFIX.length))
    ) {
      throw invalidInput(operation, 'invalid_cursor', 'cursor');
    }
    params.append('cursor', object.cursor);
  }
  return params.toString();
}

/** 计划列表查询串（父级身份 + 分页；键序冻结）。 */
function planListPath(
  base: string,
  parents: readonly [string, string][],
  input: PlanListPageInput | undefined,
  operation: HostOperation,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of parents) {
    params.append(key, value);
  }
  const paging = buildPlanListQuery(input, operation);
  const query = `${params.toString()}${paging.length === 0 ? '' : `&${paging}`}`;
  return `${base}?${query}`;
}

/* ------------------------------------------------------------------ *
 * P03-5 / F-012 工作区查询/命令输入校验（零网络拒绝）
 * ------------------------------------------------------------------ */

const WORKSPACE_LIST_INPUT_KEYS = ['featureId', 'limit', 'cursor'] as const;
const PREVIEW_WORKSPACE_DISCARD_INPUT_KEYS = ['projectId', 'featureId', 'commandId'] as const;
const CONFIRM_WORKSPACE_DISCARD_INPUT_KEYS = [
  'projectId',
  'featureId',
  'workspaceId',
  'operationId',
  'expectedWorkspaceRevision',
  'preview',
  'evidenceRefs',
  'commandId',
] as const;
const DISCARD_PREVIEW_BINDING_KEYS = [
  'previewDigest',
  'headCommit',
  'codeDigest',
  'ignoredDigest',
  'workspaceRevision',
  'expiresAtUtcMs',
] as const;

/** 工作区列表分页输入：limit 1..500；cursor 为 wscur_v1_ 形态（键序冻结）。 */
function buildWorkspaceListQuery(
  input: ListWorkspacesInput | ListWorkspaceOperationsInput | undefined,
  operation: HostOperation,
): string {
  if (input === undefined) {
    return '';
  }
  const object = rejectUnknownInputKeys(operation, input, WORKSPACE_LIST_INPUT_KEYS);
  const params = new URLSearchParams();
  if (object.featureId !== undefined) {
    params.append('featureId', requireStableIdInput(operation, object.featureId, 'featureId'));
  }
  if (object.limit !== undefined) {
    if (
      typeof object.limit !== 'number' ||
      !Number.isInteger(object.limit) ||
      object.limit < 1 ||
      object.limit > WORKSPACE_LIST_MAX_LIMIT
    ) {
      throw invalidInput(operation, 'invalid_limit', 'limit');
    }
    params.append('limit', String(object.limit));
  }
  if (object.cursor !== undefined) {
    if (
      typeof object.cursor !== 'string' ||
      !object.cursor.startsWith(WORKSPACE_LIST_CURSOR_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(object.cursor.slice(WORKSPACE_LIST_CURSOR_PREFIX.length))
    ) {
      throw invalidInput(operation, 'invalid_cursor', 'cursor');
    }
    params.append('cursor', object.cursor);
  }
  return params.toString();
}

/** 确认预览绑定（客户端形态把关；previewDigest 重算与门禁由 Core 单一权威）。 */
function requireDiscardPreviewBinding(
  operation: HostOperation,
  value: unknown,
): WorkspaceDiscardPreviewBinding {
  const object = rejectUnknownInputKeys(operation, value, DISCARD_PREVIEW_BINDING_KEYS);
  const previewDigest = requireSha256Input(operation, object.previewDigest, 'preview.previewDigest');
  const headCommit = object.headCommit;
  if (typeof headCommit !== 'string' || !/^[0-9a-f]{40}$/.test(headCommit)) {
    throw invalidInput(operation, 'invalid_commit', 'preview.headCommit');
  }
  const workspaceRevision = object.workspaceRevision;
  if (
    typeof workspaceRevision !== 'number' ||
    !Number.isInteger(workspaceRevision) ||
    workspaceRevision < 1
  ) {
    throw invalidInput(operation, 'invalid_workspace_revision', 'preview.workspaceRevision');
  }
  const expiresAtUtcMs = object.expiresAtUtcMs;
  if (
    typeof expiresAtUtcMs !== 'number' ||
    !Number.isInteger(expiresAtUtcMs) ||
    expiresAtUtcMs < 1
  ) {
    throw invalidInput(operation, 'invalid_preview_expiry', 'preview.expiresAtUtcMs');
  }
  return {
    previewDigest,
    headCommit,
    codeDigest: requireSha256Input(operation, object.codeDigest, 'preview.codeDigest'),
    ignoredDigest: requireSha256Input(operation, object.ignoredDigest, 'preview.ignoredDigest'),
    workspaceRevision,
    expiresAtUtcMs,
  };
}

/* ------------------------------------------------------------------ *
 * SSE 订阅
 * ------------------------------------------------------------------ */

interface ParsedSubscribeInput {
  readonly scope: SettingsScope;
  readonly cursor: string | undefined;
  readonly lastEventId: string | undefined;
  readonly onEvent: (event: PublicStateEvent) => void;
  readonly signal: AbortSignal | undefined;
}

const SUBSCRIBE_INPUT_KEYS = ['scope', 'cursor', 'lastEventId', 'onEvent', 'signal'] as const;
const EVENT_CURSOR_PREFIX = 'evcur_v1_';

function parseSubscribeInput(input: SubscribeEventsInput): ParsedSubscribeInput {
  if (!isPlainObject(input)) {
    throw invalidInput('events.subscribe', 'invalid_options');
  }
  for (const key of Object.keys(input)) {
    if (!(SUBSCRIBE_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalidInput('events.subscribe', 'unknown_option_key', key);
    }
  }
  const scope = validateSnapshotScope('events.subscribe', input.scope);
  if (typeof input.onEvent !== 'function') {
    throw invalidInput('events.subscribe', 'invalid_on_event', 'onEvent');
  }
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      !input.cursor.startsWith(EVENT_CURSOR_PREFIX) ||
      !/^[A-Za-z0-9_-]+$/.test(input.cursor.slice(EVENT_CURSOR_PREFIX.length))
    ) {
      throw invalidInput('events.subscribe', 'invalid_cursor', 'cursor');
    }
    cursor = input.cursor;
  }
  let lastEventId: string | undefined;
  if (input.lastEventId !== undefined) {
    if (!isUuidV4(input.lastEventId)) {
      throw invalidInput('events.subscribe', 'invalid_event_id', 'lastEventId');
    }
    lastEventId = input.lastEventId;
  }
  // 缺省恢复位置无法续读（服务端会 400 cursor_required）：本地零网络拒绝。
  if (cursor === undefined && lastEventId === undefined) {
    throw invalidInput('events.subscribe', 'cursor_required', 'cursor');
  }
  const signal = input.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw invalidInput('events.subscribe', 'invalid_signal', 'signal');
  }
  return { scope, cursor, lastEventId, onEvent: input.onEvent, signal };
}

interface OpenedStream {
  readonly request: ClientRequest;
  readonly response: IncomingMessage;
}

/** 读取有界错误响应体并解析 JSON（建连前非 200 分支）。 */
function readErrorBody(response: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolveRead) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (value: unknown): void => {
      if (!done) {
        done = true;
        resolveRead(value);
      }
    };
    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_APP_BODY_BYTES) {
        response.destroy();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        finish(undefined);
      }
    });
    response.on('error', () => finish(undefined));
    response.on('close', () => finish(undefined));
  });
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** 产物摘要引用清单（artifactId 稳定 ID + contentHash 64 位 hex 或 null；不重复）。 */
function requireArtifactRefsInput(
  operation: HostOperation,
  value: unknown,
): { readonly artifactId: string; readonly contentHash: string | null }[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 64) {
    throw invalidInput(operation, 'invalid_artifact_refs', 'artifactRefs');
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!isPlainObject(raw)) {
      throw invalidInput(operation, 'invalid_artifact_refs', 'artifactRefs');
    }
    const keys = Object.keys(raw);
    if (keys.some((key) => key !== 'artifactId' && key !== 'contentHash')) {
      throw invalidInput(operation, 'invalid_artifact_refs', 'artifactRefs');
    }
    const artifactId = requireStableIdInput(operation, raw.artifactId, 'artifactRefs.artifactId');
    if (seen.has(artifactId)) {
      throw invalidInput(operation, 'invalid_artifact_refs', 'artifactRefs');
    }
    seen.add(artifactId);
    const contentHash = raw.contentHash ?? null;
    if (contentHash !== null && (typeof contentHash !== 'string' || !SHA256_HEX_PATTERN.test(contentHash))) {
      throw invalidInput(operation, 'invalid_artifact_refs', 'artifactRefs.contentHash');
    }
    return { artifactId, contentHash: contentHash as string | null };
  });
}

export function createHostClientApplication(context: AppClientContext): HostClientApplication {
  const { port, token } = context;

  /** 单请求预算：appRequestMs 与剩余总预算取小（有界）。 */
  function requestBudget(deadlineMs?: number): number {
    const base = context.appRequestMs;
    if (deadlineMs === undefined) {
      return base;
    }
    return Math.max(1, Math.min(base, deadlineMs - Date.now()));
  }

  async function getJson(operation: HostOperation, path: string): Promise<unknown> {
    context.assertOpen(operation);
    const response = await requestLoopbackJson({
      port,
      method: 'GET',
      path,
      operation,
      token,
      connectTimeoutMs: context.connectMs,
      overallTimeoutMs: requestBudget(),
      maxResponseBytes: operation === 'execution.session.evidence.get' ? MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES : MAX_APP_BODY_BYTES,
    });
    if (response.statusCode !== 200) {
      throw mapErrorResponse(response.statusCode, response.json, operation);
    }
    return response.json;
  }

  /**
   * 回执摘要期望：默认要求回执 requestDigest 与冻结信封一致；P03-5 / F-011
   * workspace.discard 走 F-010 专属幂等通道——持久用户回执以丢弃请求摘要
   *（computeWorkspaceDiscardRequestDigest，含服务端主体身份）锚定，与信封摘要
   * 不同不是协议畸形；该操作仅核对 commandId/operation。
   */
  type ReceiptDigestExpectation = 'envelope' | 'server_anchored';

  /** 提交响应 → 回执：200/202 必须是合法回执（§5.3：accepted → 202，P02-3 /
   *  F-008 起为 baseline.run authorize 的合法线上状态）；非 200/202 体为合法
   *  回执按 §5.7 返回，否则错误映射。 */
  function receiptFromSubmitResponse(
    response: { statusCode: number; json: unknown },
    frozen: FrozenEnvelope,
    digestExpectation: ReceiptDigestExpectation,
  ): CommandReceipt {
    const expectation = {
      expectedCommandId: frozen.commandId,
      ...(digestExpectation === 'envelope'
        ? { expectedRequestDigest: frozen.requestDigest }
        : {}),
      expectedOperation: frozen.operation,
    };
    if (response.statusCode === 200 || response.statusCode === 202) {
      return validateCommandReceiptWire(response.json, expectation, 'commands.submit');
    }
    if (
      isPlainObject(response.json) &&
      typeof response.json.commandId === 'string' &&
      (response.json.status === 'completed' ||
        response.json.status === 'rejected' ||
        response.json.status === 'accepted')
    ) {
      return validateCommandReceiptWire(response.json, expectation, 'commands.submit');
    }
    throw mapErrorResponse(response.statusCode, response.json, 'commands.submit');
  }

  /** 回执查询：命中返回已核验回执；明确 not_found / 传输失败返回 undefined（继续有限重发）。 */
  async function lookupReceipt(
    frozen: FrozenEnvelope,
    signal: AbortSignal | undefined,
    deadlineMs: number,
    digestExpectation: ReceiptDigestExpectation,
  ): Promise<CommandReceipt | undefined> {
    try {
      const response = await requestLoopbackJson({
        port,
        method: 'GET',
        path: `${RECEIPTS_ROUTE_PREFIX}${frozen.commandId}`,
        operation: 'receipts.get',
        token,
        connectTimeoutMs: context.connectMs,
        overallTimeoutMs: requestBudget(deadlineMs),
        maxResponseBytes: MAX_APP_BODY_BYTES,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (response.statusCode !== 200) {
        throw mapErrorResponse(response.statusCode, response.json, 'receipts.get');
      }
      return validateCommandReceiptWire(
        response.json,
        {
          expectedCommandId: frozen.commandId,
          ...(digestExpectation === 'envelope'
            ? { expectedRequestDigest: frozen.requestDigest }
            : {}),
          expectedOperation: frozen.operation,
        },
        'receipts.get',
      );
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      if (isHostProtocolError(error, 'not_found') || isHostProtocolError(error, 'unreachable')) {
        return undefined;
      }
      throw error;
    }
  }

  async function submitCommand(
    input: SubmitCommandInput,
    options?: SubmitCommandOptions,
    digestExpectation: ReceiptDigestExpectation = 'envelope',
  ): Promise<CommandReceipt> {
    context.assertOpen('commands.submit');
    const submitOptions = extractAbortSignal(options, 'commands.submit');
    const signal = submitOptions.signal;
    // 信封身份：输入对象优先，提交选项兜底（F-016 显式 --command-id 重放：
    // 以既有回执的原 issuedAt 重建同一信封，同摘要 → 重放原回执）。
    const frozen = freezeCommandEnvelope({
      ...input,
      ...(input.commandId === undefined && submitOptions.commandId !== undefined
        ? { commandId: submitOptions.commandId }
        : {}),
      ...(input.issuedAt === undefined && submitOptions.issuedAt !== undefined
        ? { issuedAt: submitOptions.issuedAt }
        : {}),
    });
    const deadlineMs = Date.now() + context.submitBudgetMs;

    let attempt = 0;
    for (;;) {
      if (signal?.aborted === true) {
        throw abortedError('commands.submit');
      }
      if (attempt >= SUBMIT_MAX_ATTEMPTS || Date.now() >= deadlineMs) {
        // 预算耗尽仍未知：明确结果不确定，保留 commandId 供事后查回执。
        throw new HostProtocolError(
          'outcome_unknown',
          'commands.submit',
          undefined,
          { details: { reason: 'submit_budget_exhausted', commandId: frozen.commandId } },
        );
      }
      attempt += 1;
      try {
        const response = await requestLoopbackJson({
          port,
          method: 'POST',
          path: COMMANDS_ROUTE,
          operation: 'commands.submit',
          token,
          body: frozen.wire,
          connectTimeoutMs: context.connectMs,
          overallTimeoutMs: requestBudget(deadlineMs),
          maxResponseBytes: MAX_APP_BODY_BYTES,
          ...(signal !== undefined ? { signal } : {}),
        });
        return receiptFromSubmitResponse(response, frozen, digestExpectation);
      } catch (error) {
        if (isAbortError(error, signal)) {
          throw abortedError('commands.submit');
        }
        // 仅传输失败（连接丢失/超时）进入查回执路径；业务拒绝/协议错误/重定向
        // 都是明确结果，不重试、不查回执。
        if (!isHostProtocolError(error, 'unreachable')) {
          throw error;
        }
      }
      // 传输失败：先等待有界提交窗口，再查本 principal 名下回执。
      await boundedDelay(SUBMIT_RECEIPT_GRACE_MS, signal, deadlineMs, 'commands.submit');
      const receipt = await lookupReceipt(frozen, signal, deadlineMs, digestExpectation);
      if (receipt !== undefined) {
        return receipt;
      }
      // 回执未知：有限间隔后以完全相同的冻结信封重发。
      await boundedDelay(SUBMIT_RETRY_DELAY_MS, signal, deadlineMs, 'commands.submit');
    }
  }

  /* ---------------------------------------------------------------- *
   * SSE
   * ---------------------------------------------------------------- */

  function buildEventsQuery(scope: SettingsScope, cursor: string | undefined): string {
    const params = new URLSearchParams();
    if (scope.kind === 'project') {
      params.append('scope', 'project');
      params.append('projectId', scope.projectId);
    } else {
      params.append('scope', 'global');
    }
    if (cursor !== undefined) {
      params.append('cursor', cursor);
    }
    return params.toString();
  }

  /** 建立 SSE 连接并等待响应头；非 200 按错误体映射拒绝（含建连前 snapshot_required）。 */
  function openStream(
    parsed: ParsedSubscribeInput,
    resume: { readonly cursor: string | undefined; readonly lastEventId: string | undefined },
  ): Promise<OpenedStream> {
    return new Promise<OpenedStream>((resolveOpen, rejectOpen) => {
      let settled = false;
      const fail = (error: HostProtocolError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        parsed.signal?.removeEventListener('abort', onAbort);
        req.destroy();
        rejectOpen(error);
      };
      const timer = setTimeout(() => {
        fail(
          new HostProtocolError('unreachable', 'events.subscribe', '等待事件流响应头超时', {
            details: { reason: 'request_timeout' },
          }),
        );
      }, requestBudget());
      const onAbort = (): void => {
        fail(abortedError('events.subscribe'));
      };
      parsed.signal?.addEventListener('abort', onAbort, { once: true });

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        host: `127.0.0.1:${port}`,
        accept: 'text/event-stream',
      };
      if (resume.lastEventId !== undefined) {
        headers['last-event-id'] = resume.lastEventId;
      }
      const req = httpRequest(
        {
          host: '127.0.0.1',
          family: 4,
          port,
          method: 'GET',
          path: `${EVENTS_ROUTE}?${buildEventsQuery(parsed.scope, resume.cursor)}`,
          agent: false,
          headers,
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            response.resume();
            fail(
              new HostProtocolError(
                'redirect_rejected',
                'events.subscribe',
                '拒绝重定向（不会向新地址发送凭据）',
                { details: { reason: 'redirect_rejected', statusCode } },
              ),
            );
            return;
          }
          if (statusCode !== 200) {
            void readErrorBody(response).then((json) => {
              fail(mapErrorResponse(statusCode, json, 'events.subscribe'));
            });
            return;
          }
          const contentType = response.headers['content-type'];
          if (
            typeof contentType !== 'string' ||
            !contentType.toLowerCase().startsWith('text/event-stream')
          ) {
            fail(
              new HostProtocolError('response_malformed', 'events.subscribe', '事件流内容类型不符', {
                details: { reason: 'content_type_not_event_stream' },
              }),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          parsed.signal?.removeEventListener('abort', onAbort);
          resolveOpen({ request: req, response });
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        fail(
          new HostProtocolError('unreachable', 'events.subscribe', '无法建立事件流连接', {
            details: { reason: 'connection_lost', ...(error.code ? { causeCode: error.code } : {}) },
          }),
        );
      });
      req.end();
    });
  }

  async function subscribeEvents(input: SubscribeEventsInput): Promise<HostEventSubscription> {
    context.assertOpen('events.subscribe');
    const parsed = parseSubscribeInput(input);
    if (parsed.signal?.aborted === true) {
      throw abortedError('events.subscribe');
    }

    // 订阅状态（跨自动重连共享：去重缓存与最后事件身份）。
    const seenEventIds = new Map<string, true>();
    let lastEventId: string | undefined = parsed.lastEventId;
    let closed = false;
    let current: OpenedStream | undefined;
    let reconnectAttempts = 0;
    let resolveEnded!: (end: EventStreamEnd) => void;
    const ended = new Promise<EventStreamEnd>((resolveEnd) => {
      resolveEnded = resolveEnd;
    });

    const subscription: HostEventSubscription = {
      ended,
      lastEventId: () => lastEventId,
      resumeCursor: () => parsed.cursor,
      close: () => {
        finish({ kind: 'aborted' });
      },
    };

    // AbortSignal 在整个订阅生命周期生效（不只建连阶段）：只释放本地观察资源。
    const onUserAbort = (): void => {
      finish({ kind: 'aborted' });
    };
    parsed.signal?.addEventListener('abort', onUserAbort, { once: true });

    function finish(end: EventStreamEnd): void {
      if (closed) {
        return;
      }
      closed = true;
      parsed.signal?.removeEventListener('abort', onUserAbort);
      context.unregisterSubscription(subscription);
      const stream = current;
      current = undefined;
      if (stream === undefined) {
        resolveEnded(end);
        return;
      }
      // 结算前确认本地连接已收尾：等 response close（本端析构完成）加一段
      // 有界回环交付余量，让对端 close 落账后再 resolve ended；1 000 ms 兜底。
      let resolved = false;
      const resolveOnce = (): void => {
        if (!resolved) {
          resolved = true;
          resolveEnded(end);
        }
      };
      stream.response.once('close', () => {
        setTimeout(resolveOnce, 25);
      });
      try {
        stream.request.destroy();
        stream.response.destroy();
      } catch {
        // 尽力收尾。
      }
      setTimeout(resolveOnce, 1_000);
    }

    function noteEvent(event: PublicStateEvent): boolean {
      if (seenEventIds.has(event.eventId)) {
        return false;
      }
      if (seenEventIds.size >= EVENT_ID_CACHE_LIMIT) {
        const oldest = seenEventIds.keys().next();
        if (!oldest.done) {
          seenEventIds.delete(oldest.value);
        }
      }
      seenEventIds.set(event.eventId, true);
      lastEventId = event.eventId;
      return true;
    }

    function handleErrorFrame(data: string): boolean {
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        finish({ kind: 'protocol_error', reason: 'error_frame_invalid_json' });
        return true;
      }
      const code = isPlainObject(payload) ? payload.code : undefined;
      const snapshotRoute =
        isPlainObject(payload) && typeof payload.snapshotRoute === 'string'
          ? payload.snapshotRoute
          : SNAPSHOT_ROUTE;
      if (code === 'snapshot_required') {
        finish({ kind: 'snapshot_required', snapshotRoute });
        return true;
      }
      if (code === 'stream_overflow') {
        finish({ kind: 'stream_overflow', snapshotRoute });
        return true;
      }
      finish({
        kind: 'protocol_error',
        reason: typeof code === 'string' ? 'error_frame' : 'error_frame_malformed',
      });
      return true;
    }

    function handleStateEventFrame(data: string): void {
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(data) as unknown;
      } catch {
        finish({ kind: 'protocol_error', reason: 'event_data_invalid_json' });
        return;
      }
      let event: PublicStateEvent;
      try {
        event = validateStateEventWire(parsedData, 'events.subscribe');
      } catch {
        finish({ kind: 'protocol_error', reason: 'event_wire_invalid' });
        return;
      }
      if (event.scope.kind !== parsed.scope.kind || (
        event.scope.kind === 'project' && parsed.scope.kind === 'project' &&
        event.scope.projectId !== parsed.scope.projectId
      )) {
        finish({ kind: 'protocol_error', reason: 'event_scope_mismatch' });
        return;
      }
      if (!noteEvent(event)) {
        return;
      }
      try {
        parsed.onEvent(event);
      } catch {
        finish({ kind: 'protocol_error', reason: 'observer_callback_error' });
      }
    }

    function dispatchFrame(rawFrame: string): void {
      if (closed) {
        return;
      }
      if (Buffer.byteLength(rawFrame, 'utf8') > MAX_SSE_FRAME_BYTES) {
        finish({ kind: 'protocol_error', reason: 'frame_too_large' });
        return;
      }
      let eventField: string | undefined;
      const dataLines: string[] = [];
      for (const rawLine of rawFrame.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0 || line.startsWith(':')) {
          continue; // 空行与注释（心跳）忽略。
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        if (field === 'event') {
          eventField = value;
        } else if (field === 'data') {
          dataLines.push(value);
        }
        // id 字段与事件 eventId 同源（服务端一致写入）；去重以事件封套为准。
      }
      if (eventField === undefined && dataLines.length === 0) {
        return; // 纯注释/心跳帧。
      }
      const data = dataLines.join('\n');
      if (eventField === 'error') {
        handleErrorFrame(data);
        return;
      }
      if (eventField === 'state-event') {
        handleStateEventFrame(data);
        return;
      }
      finish({ kind: 'protocol_error', reason: 'unknown_frame_event' });
    }

    function attach(stream: OpenedStream): void {
      current = stream;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      stream.response.on('data', (chunk: Buffer) => {
        if (closed) {
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        let separator = /\r?\n\r?\n/.exec(buffer);
        while (separator !== null) {
          const rawFrame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          dispatchFrame(rawFrame);
          if (closed) {
            return;
          }
          separator = /\r?\n\r?\n/.exec(buffer);
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          finish({ kind: 'protocol_error', reason: 'buffer_overflow' });
        }
      });
      // 连接结束/错误：用户关闭已结算；否则进入有限自动重连。
      const onLost = (): void => {
        if (closed || current !== stream) {
          return;
        }
        current = undefined;
        stream.request.destroy();
        stream.response.destroy();
        void reconnect();
      };
      stream.response.on('end', onLost);
      stream.response.on('error', onLost);
      stream.response.on('close', onLost);
    }

    async function reconnect(): Promise<void> {
      if (closed) {
        return;
      }
      if (reconnectAttempts >= EVENT_RECONNECT_MAX_ATTEMPTS) {
        finish({ kind: 'protocol_error', reason: 'reconnect_budget_exhausted' });
        return;
      }
      try {
        await boundedDelay(
          EVENT_RECONNECT_DELAY_MS,
          parsed.signal,
          Number.POSITIVE_INFINITY,
          'events.subscribe',
        );
      } catch {
        finish({ kind: 'aborted' });
        return;
      }
      if (closed) {
        return;
      }
      reconnectAttempts += 1;
      try {
        // 断线续读：Last-Event-ID 优先（服务端解析持久 sequence），无则原游标。
        const stream = await openStream(parsed, {
          cursor: lastEventId === undefined ? parsed.cursor : undefined,
          lastEventId,
        });
        if (closed) {
          stream.request.destroy();
          stream.response.destroy();
          return;
        }
        attach(stream);
      } catch (error) {
        if (closed) {
          return;
        }
        if (isAbortError(error, parsed.signal)) {
          finish({ kind: 'aborted' });
          return;
        }
        if (isHostProtocolError(error, 'snapshot_required')) {
          // 建连时低于可续读下界：明确恢复分支（重取快照），不偷偷从零重读。
          const details = error.details as Record<string, unknown> | undefined;
          finish({
            kind: 'snapshot_required',
            snapshotRoute:
              typeof details?.snapshotRoute === 'string' ? details.snapshotRoute : SNAPSHOT_ROUTE,
          });
          return;
        }
        if (!isHostProtocolError(error, 'unreachable')) {
          finish({ kind: 'protocol_error', reason: 'reconnect_rejected' });
          return;
        }
        await reconnect();
      }
    }

    // 建连（非 200 拒绝直接向上抛出，不产生订阅句柄）。
    try {
      const stream = await openStream(parsed, {
        cursor: parsed.cursor,
        lastEventId: parsed.lastEventId,
      });
      current = stream;
      context.assertOpen('events.subscribe');
      if (closed) throw abortedError('events.subscribe');
      context.registerSubscription(subscription);
      attach(stream);
      return subscription;
    } catch (error) {
      finish({ kind: 'aborted' });
      throw error;
    }
  }

  /* ---------------------------------------------------------------- *
   * 查询与回执/结果读取
   * ---------------------------------------------------------------- */

  async function getSnapshot(scope: { readonly kind: 'project'; readonly projectId: string }): Promise<ProjectSnapshotResult>;
  async function getSnapshot(scope: { readonly kind: 'global' }): Promise<GlobalSnapshotResult>;
  async function getSnapshot(scope: SettingsScope): Promise<SnapshotResult> {
    context.assertOpen('snapshot.get');
    const validScope = validateSnapshotScope('snapshot.get', scope);
    const json = await getJson('snapshot.get', `${SNAPSHOT_ROUTE}?${buildEventsQuery(validScope, undefined)}`);
    return validateAppQueryResponse('snapshot.get', json, { scope: validScope });
  }

  return {
    submitCommand,

    async getReceipt(commandId: string): Promise<CommandReceipt> {
      context.assertOpen('receipts.get');
      if (!isUuidV4(commandId)) {
        throw invalidInput('receipts.get', 'invalid_uuid_v4', 'commandId');
      }
      const json = await getJson('receipts.get', `${RECEIPTS_ROUTE_PREFIX}${commandId}`);
      return validateCommandReceiptWire(json, { expectedCommandId: commandId }, 'receipts.get');
    },

    async resolveResult(resultRef: string): Promise<CommandReceipt> {
      context.assertOpen('results.resolve');
      if (!isValidResultRef(resultRef)) {
        throw invalidInput('results.resolve', 'invalid_result_ref', 'resultRef');
      }
      const json = await getJson('results.resolve', `${RESULTS_ROUTE_PREFIX}${resultRef}`);
      return validateCommandReceiptWire(json, {}, 'results.resolve');
    },

    async listProjects(options?: ListProjectsInput): Promise<ProjectListResult> {
      context.assertOpen('projects.list');
      const query = buildProjectListQuery(options);
      const json = await getJson(
        'projects.list',
        query.length === 0 ? PROJECTS_ROUTE : `${PROJECTS_ROUTE}?${query}`,
      );
      return validateAppQueryResponse('projects.list', json);
    },

    async getProject(projectId: string): Promise<ProjectDetailResult> {
      const id = requireProjectId('projects.get', projectId);
      const json = await getJson('projects.get', `${PROJECTS_ROUTE}/${id}`);
      return validateAppQueryResponse('projects.get', json);
    },

    async inspectRepository(path: string): Promise<ProjectInspectionResult> {
      context.assertOpen('projects.inspect');
      const repositoryPath = requireRepositoryPathInput(path);
      const params = new URLSearchParams();
      params.append('path', repositoryPath);
      const json = await getJson(
        'projects.inspect',
        `${PROJECTS_INSPECT_ROUTE}?${params.toString()}`,
      );
      return validateAppQueryResponse('projects.inspect', json);
    },

    async getProjectOverview(projectId: string): Promise<ProjectOverviewResult> {
      context.assertOpen('projects.overview');
      const id = requireProjectId('projects.overview', projectId);
      const json = await getJson('projects.overview', `${PROJECTS_ROUTE}/${id}/overview`);
      return validateAppQueryResponse('projects.overview', json);
    },

    async getRepositoryBinding(projectId: string): Promise<ProjectBindingResult> {
      const id = requireProjectId('projects.binding.get', projectId);
      const json = await getJson('projects.binding.get', `${PROJECTS_ROUTE}/${id}/repository-binding`);
      return validateAppQueryResponse('projects.binding.get', json);
    },

    async countProjectLabels(): Promise<ProjectLabelCountsResult> {
      const json = await getJson('projects.labelCounts', PROJECT_LABEL_COUNTS_ROUTE);
      return validateAppQueryResponse('projects.labelCounts', json);
    },

    async getGlobalSettings(): Promise<PublicSettingsState> {
      const json = await getJson('settings.global.get', SETTINGS_GLOBAL_ROUTE);
      return validateAppQueryResponse('settings.global.get', json);
    },

    async exportGlobalSettings(): Promise<ExportedSettings> {
      const json = await getJson('settings.global.export', SETTINGS_GLOBAL_EXPORT_ROUTE);
      return validateAppQueryResponse('settings.global.export', json);
    },

    async getProjectSettings(projectId: string): Promise<PublicSettingsState> {
      const id = requireProjectId('settings.project.get', projectId);
      const json = await getJson('settings.project.get', `${PROJECTS_ROUTE}/${id}/settings`);
      return validateAppQueryResponse('settings.project.get', json);
    },

    async getEffectiveSettings(projectId: string): Promise<EffectiveSettings> {
      const id = requireProjectId('settings.project.effective', projectId);
      const json = await getJson('settings.project.effective', `${PROJECTS_ROUTE}/${id}/settings/effective`);
      return validateAppQueryResponse('settings.project.effective', json);
    },

    async exportProjectSettings(projectId: string): Promise<ExportedSettings> {
      const id = requireProjectId('settings.project.export', projectId);
      const json = await getJson('settings.project.export', `${PROJECTS_ROUTE}/${id}/settings/export`);
      return validateAppQueryResponse('settings.project.export', json);
    },

    getSnapshot,

    subscribeEvents,

    /* ------------------------------------------------------------ *
     * P02-3 / F-014 基线命令与查询（§6/§7.4-§7.6）
     * ------------------------------------------------------------ */

    async previewBaseline(
      input: PreviewBaselineInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, PREVIEW_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'baseline.preview',
          scope: { kind: 'project', projectId },
          payload: { plan: object.plan },
        },
        options,
      );
      // completed 回执的 result 必须是预览摘要形状（§6 冻结）。
      if (receipt.status === 'completed') {
        validateBaselinePreviewResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async runBaseline(
      input: RunBaselineInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, RUN_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      if (object.decision !== 'authorize' && object.decision !== 'decline') {
        throw invalidInput('commands.submit', 'invalid_decision', 'decision');
      }
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'baseline.run',
          scope: { kind: 'project', projectId },
          payload: {
            decision: object.decision,
            plan: object.plan,
            previewDigest: object.previewDigest,
          },
        },
        options,
      );
      // decline → completed 回执 result 形状校验；accepted 只携带 operationId
      //（线校验已保证），本方法不等待后台检查完成。
      if (receipt.status === 'completed') {
        validateBaselineCommandResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async cancelBaseline(
      projectId: string,
      operationId: string,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      // 取消是唯一停止途径且必须显式：本方法只发送 baseline.cancel 命令；
      // 客户端断开/close/Abort 不触发本方法（见 subscribeEvents/close 纪律）。
      const id = requireProjectId('commands.submit', projectId);
      const target = requireOperationIdInput('commands.submit', operationId);
      const receipt = await submitCommand(
        {
          operation: 'baseline.cancel',
          scope: { kind: 'project', projectId: id },
          payload: { operationId: target },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateBaselineCommandResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async listBaselines(
      projectId: string,
      input?: ListBaselinesInput,
    ): Promise<BaselineListResult> {
      context.assertOpen('baselines.list');
      const id = requireProjectId('baselines.list', projectId);
      const query = buildBaselineListQuery(input);
      const base = `${PROJECTS_ROUTE}/${id}/baselines`;
      const json = await getJson(
        'baselines.list',
        query.length === 0 ? base : `${base}?${query}`,
      );
      return validateAppQueryResponse('baselines.list', json);
    },

    async getBaseline(operationId: string): Promise<BaselineDetailResult> {
      context.assertOpen('baselines.get');
      const id = requireOperationIdInput('baselines.get', operationId);
      const json = await getJson('baselines.get', `${BASELINES_ROUTE_PREFIX}${id}`);
      return validateAppQueryResponse('baselines.get', json);
    },

    async readArtifactContent(artifactId: string): Promise<BaselineArtifactContentResult> {
      context.assertOpen('artifacts.get');
      const id = requireArtifactIdInput('artifacts.get', artifactId);
      const response = await requestLoopbackText({
        port,
        method: 'GET',
        path: `${ARTIFACTS_ROUTE_PREFIX}${id}${ARTIFACT_CONTENT_ROUTE_SUFFIX}`,
        operation: 'artifacts.get',
        token,
        connectTimeoutMs: context.connectMs,
        overallTimeoutMs: requestBudget(),
        // §7.6/§13：证据正文上限 8 MiB（超限即 response_malformed，不截断冒充）。
        maxResponseBytes: MAX_ARTIFACT_CONTENT_BYTES,
      });
      if (!response.ok) {
        throw mapErrorResponse(response.statusCode, response.json, 'artifacts.get');
      }
      return { artifactId: id, byteSize: response.byteSize, content: response.text };
    },

    /* ------------------------------------------------------------ *
     * P03-1 / F-009 计划域命令与查询（§6.4-§6.8/§6.6）
     * ------------------------------------------------------------ */

    async createPhase(
      input: CreatePhaseInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, CREATE_PHASE_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      if (object.id !== undefined) {
        requireStableIdInput('commands.submit', object.id, 'id');
      }
      if (typeof object.title !== 'string' || object.title.trim().length === 0) {
        throw invalidInput('commands.submit', 'invalid_title', 'title');
      }
      if (object.description !== undefined && object.description !== null && typeof object.description !== 'string') {
        throw invalidInput('commands.submit', 'invalid_description', 'description');
      }
      if (object.labels !== undefined && !Array.isArray(object.labels)) {
        throw invalidInput('commands.submit', 'invalid_labels', 'labels');
      }
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'phase.create',
          scope: { kind: 'project', projectId },
          payload: {
            ...(object.id !== undefined ? { id: object.id } : {}),
            title: object.title,
            description: object.description ?? null,
            labels: object.labels ?? [],
          },
        },
        options,
      );
      // completed 回执的 result 必须是 Phase 记录形状（§6.4 冻结）。
      if (receipt.status === 'completed') {
        validatePhaseCreateResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async importFeaturePlan(
      input: ImportFeaturePlanInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, IMPORT_PLAN_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const phaseId = requireStableIdInput('commands.submit', object.phaseId, 'phaseId');
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'feature.plan.import',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { phaseId, plan: object.plan },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateFeaturePlanImportResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async updatePlanLabels(
      input: UpdatePlanLabelsInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, UPDATE_PLAN_LABELS_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      if (
        object.entityType !== 'phase' &&
        object.entityType !== 'feature' &&
        object.entityType !== 'task'
      ) {
        throw invalidInput('commands.submit', 'invalid_entity_type', 'entityType');
      }
      const id = requireStableIdInput('commands.submit', object.id, 'id');
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      if (
        !Array.isArray(object.labels) ||
        !object.labels.every((label) => typeof label === 'string')
      ) {
        throw invalidInput('commands.submit', 'invalid_labels', 'labels');
      }
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'plan.labels.update',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { entityType: object.entityType, id, labels: object.labels },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validatePlanLabelsUpdateResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async reviseFeaturePlan(
      input: ReviseFeaturePlanInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, REVISE_PLAN_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'feature.plan.revise',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { featureId, plan: object.plan },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateFeaturePlanReviseResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async listPhases(projectId: string, input?: PlanListPageInput): Promise<PhaseListResult> {
      context.assertOpen('phases.list');
      const id = requireProjectId('phases.list', projectId);
      const json = await getJson(
        'phases.list',
        planListPath(PHASES_ROUTE, [['projectId', id]], input, 'phases.list'),
      );
      return validateAppQueryResponse('phases.list', json);
    },

    async getPhase(phaseId: string): Promise<PhaseDetailResult> {
      context.assertOpen('phases.get');
      const id = requireStableIdInput('phases.get', phaseId, 'phaseId');
      const json = await getJson('phases.get', `${PHASES_ROUTE_PREFIX}${id}`);
      return validateAppQueryResponse('phases.get', json);
    },

    async listFeatures(
      projectId: string,
      phaseId: string,
      input?: PlanListPageInput,
    ): Promise<FeatureListResult> {
      context.assertOpen('features.list');
      const id = requireProjectId('features.list', projectId);
      const parent = requireStableIdInput('features.list', phaseId, 'phaseId');
      const json = await getJson(
        'features.list',
        planListPath(FEATURES_ROUTE, [['projectId', id], ['phaseId', parent]], input, 'features.list'),
      );
      return validateAppQueryResponse('features.list', json);
    },

    async getFeature(featureId: string): Promise<FeatureDetailResult> {
      context.assertOpen('features.get');
      const id = requireStableIdInput('features.get', featureId, 'featureId');
      const json = await getJson('features.get', `${FEATURES_ROUTE_PREFIX}${id}`);
      return validateAppQueryResponse('features.get', json);
    },

    async listTasks(
      projectId: string,
      featureId: string,
      input?: PlanListPageInput,
    ): Promise<TaskListResult> {
      context.assertOpen('tasks.list');
      const id = requireProjectId('tasks.list', projectId);
      const parent = requireStableIdInput('tasks.list', featureId, 'featureId');
      const json = await getJson(
        'tasks.list',
        planListPath(TASKS_ROUTE, [['projectId', id], ['featureId', parent]], input, 'tasks.list'),
      );
      return validateAppQueryResponse('tasks.list', json);
    },

    async getTask(taskId: string): Promise<TaskDetailResult> {
      context.assertOpen('tasks.get');
      const id = requireStableIdInput('tasks.get', taskId, 'taskId');
      const json = await getJson('tasks.get', `${TASKS_ROUTE_PREFIX}${id}`);
      return validateAppQueryResponse('tasks.get', json);
    },

    /* ------------------------------------------------------------ *
     * P03-2 / F-007 决策/策略/输入准备命令与授权查询
     * ------------------------------------------------------------ */

    async decideFeaturePlan(
      input: DecideFeaturePlanInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, DECIDE_PLAN_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      if (typeof object.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(object.planDigest)) {
        throw invalidInput('commands.submit', 'invalid_plan_digest', 'planDigest');
      }
      if (object.decision !== 'approve' && object.decision !== 'reject') {
        throw invalidInput('commands.submit', 'invalid_decision', 'decision');
      }
      const reason = object.reason ?? null;
      if (reason !== null && typeof reason !== 'string') {
        throw invalidInput('commands.submit', 'invalid_reason', 'reason');
      }
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'feature.plan.decide',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: {
            featureId,
            planDigest: object.planDigest,
            decision: object.decision,
            reason,
          },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateFeaturePlanDecideResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async submitTaskApprovalBlock(
      input: TaskApprovalBlockInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, TASK_APPROVAL_BLOCK_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const taskId = requireStableIdInput('commands.submit', object.taskId, 'taskId');
      if (typeof object.planDigest !== 'string' || !SHA256_HEX_PATTERN.test(object.planDigest)) {
        throw invalidInput('commands.submit', 'invalid_plan_digest', 'planDigest');
      }
      if (object.kind !== undefined && object.kind !== 'block' && object.kind !== 'approval') {
        throw invalidInput('commands.submit', 'invalid_approval_kind', 'kind');
      }
      if (object.description !== undefined && typeof object.description !== 'string') {
        throw invalidInput('commands.submit', 'invalid_description', 'description');
      }
      if (object.responsibleParty !== undefined && typeof object.responsibleParty !== 'string') {
        throw invalidInput('commands.submit', 'invalid_responsible_party', 'responsibleParty');
      }
      const codeDigest = object.codeDigest ?? null;
      if (
        codeDigest !== null &&
        (typeof codeDigest !== 'string' || !SHA256_HEX_PATTERN.test(codeDigest))
      ) {
        throw invalidInput('commands.submit', 'invalid_code_digest', 'codeDigest');
      }
      const artifactRefs = requireArtifactRefsInput('commands.submit', object.artifactRefs);
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'task.approval.block',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: {
            taskId,
            planDigest: object.planDigest,
            ...(object.kind !== undefined ? { kind: object.kind } : {}),
            ...(object.description !== undefined ? { description: object.description } : {}),
            ...(object.responsibleParty !== undefined ? { responsibleParty: object.responsibleParty } : {}),
            codeDigest,
            artifactRefs,
          },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateTaskApprovalBlockResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async submitTaskApprovalDecision(
      input: TaskApprovalDecisionInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, TASK_APPROVAL_DECISION_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const taskId = requireStableIdInput('commands.submit', object.taskId, 'taskId');
      const itemId = requireStableIdInput('commands.submit', object.itemId, 'itemId');
      if (typeof object.planDigest !== 'string' || !SHA256_HEX_PATTERN.test(object.planDigest)) {
        throw invalidInput('commands.submit', 'invalid_plan_digest', 'planDigest');
      }
      if (typeof object.codeDigest !== 'string' || !SHA256_HEX_PATTERN.test(object.codeDigest)) {
        throw invalidInput('commands.submit', 'invalid_code_digest', 'codeDigest');
      }
      if (
        object.decision !== 'approve' &&
        object.decision !== 'reject' &&
        object.decision !== 'unblock'
      ) {
        throw invalidInput('commands.submit', 'invalid_decision', 'decision');
      }
      const reason = object.reason ?? null;
      if (reason !== null && typeof reason !== 'string') {
        throw invalidInput('commands.submit', 'invalid_reason', 'reason');
      }
      const artifactRefs = requireArtifactRefsInput('commands.submit', object.artifactRefs);
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: `task.approval.${object.decision}`,
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { taskId, itemId, planDigest: object.planDigest, codeDigest: object.codeDigest, artifactRefs, reason },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateTaskApprovalDecisionResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async continueTaskVerification(
      input: TaskVerificationContinueInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, TASK_VERIFICATION_CONTINUE_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const taskId = requireStableIdInput('commands.submit', object.taskId, 'taskId');
      const attemptId = requireStableIdInput('commands.submit', object.attemptId, 'attemptId');
      const verificationBatchId = requireStableIdInput(
        'commands.submit',
        object.verificationBatchId,
        'verificationBatchId',
      );
      if (typeof object.codeDigest !== 'string' || !SHA256_HEX_PATTERN.test(object.codeDigest)) {
        throw invalidInput('commands.submit', 'invalid_code_digest', 'codeDigest');
      }
      if (
        typeof object.observationDigest !== 'string' ||
        !SHA256_HEX_PATTERN.test(object.observationDigest)
      ) {
        throw invalidInput('commands.submit', 'invalid_observation_digest', 'observationDigest');
      }
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'task.verification.continue',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: {
            taskId,
            attemptId,
            verificationBatchId,
            codeDigest: object.codeDigest,
            observationDigest: object.observationDigest,
          },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateTaskVerificationContinueResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async continueFeatureVerification(
      input: FeatureVerificationContinueInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys(
        'commands.submit',
        input,
        FEATURE_VERIFICATION_CONTINUE_INPUT_KEYS,
      );
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      const runId = requireStableIdInput('commands.submit', object.runId, 'runId');
      const batchId = requireStableIdInput('commands.submit', object.batchId, 'batchId');
      if (typeof object.operationId !== 'string' || !isUuidV4(object.operationId)) {
        throw invalidInput('commands.submit', 'invalid_operation_id', 'operationId');
      }
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'feature.verification.continue',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { featureId, runId, batchId, operationId: object.operationId },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateFeatureDeliveryCommandResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async updateTaskStrategy(
      input: UpdateTaskStrategyInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, UPDATE_TASK_STRATEGY_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const taskId = requireStableIdInput('commands.submit', object.taskId, 'taskId');
      if (!isPlainObject(object.executionConfig)) {
        throw invalidInput('commands.submit', 'invalid_execution_config', 'executionConfig');
      }
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'task.strategy.update',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { taskId, executionConfig: object.executionConfig },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateTaskStrategyUpdateResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async prepareExecutionInput(
      input: PrepareExecutionInputInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, PREPARE_EXECUTION_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      const taskId = requireStableIdInput('commands.submit', object.taskId, 'taskId');
      if (!Array.isArray(object.items)) {
        throw invalidInput('commands.submit', 'invalid_items', 'items');
      }
      // 创建类命令：不携带 expectedRevision（信封校验在公共层统一把关）。
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'execution.input.prepare',
          scope: { kind: 'project', projectId },
          payload: { featureId, taskId, items: object.items },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateExecutionInputPrepareResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async getFeatureApprovals(featureId: string): Promise<FeatureApprovalsResult> {
      context.assertOpen('features.approvals');
      const id = requireStableIdInput('features.approvals', featureId, 'featureId');
      const json = await getJson(
        'features.approvals',
        `${FEATURES_ROUTE_PREFIX}${id}${FEATURE_APPROVALS_ROUTE_SUFFIX}`,
      );
      return validateAppQueryResponse('features.approvals', json);
    },

    async previewExecution(
      input: PreviewExecutionInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, EXECUTION_PREVIEW_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureIds = requireFeatureIds('commands.submit', object.featureIds);
      const budget = requireBudgetObject('commands.submit', object.budget, 'budget');
      const receipt = await submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'execution.preview',
          scope: { kind: 'project', projectId },
          payload: { featureIds, budget },
        },
        options,
      );
      if (receipt.status === 'completed') {
        validateExecutionPreviewResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async startExecution(
      input: StartExecutionInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, EXECUTION_START_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureIds = requireFeatureIds('commands.submit', object.featureIds);
      const retryBatchId = object.retryBatchId;
      let payload: Record<string, unknown>;
      if (retryBatchId !== undefined) {
        if (typeof retryBatchId !== 'string' || !isUuidV4(retryBatchId) || object.budget !== undefined || object.previewDigest !== undefined) {
          throw invalidInput('commands.submit', 'invalid_retry_shape', 'retryBatchId');
        }
        payload = { featureIds, retryBatchId };
      } else {
        const budget = requireBudgetObject('commands.submit', object.budget, 'budget');
        const previewDigest = requireSha256Input('commands.submit', object.previewDigest, 'previewDigest');
        payload = { featureIds, budget, previewDigest, retryBatchId: null };
      }
      return submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'execution.start',
          scope: { kind: 'project', projectId },
          payload,
        },
        options,
      );
    },

    async reviseExecutionBudget(
      input: ReviseExecutionBudgetInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      const object = rejectUnknownInputKeys('commands.submit', input, EXECUTION_BUDGET_REVISE_INPUT_KEYS);
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const batchId = requireStableIdInput('commands.submit', object.batchId, 'batchId');
      const expectedRevision = requireExpectedRevisionInput('commands.submit', object.expectedRevision);
      const budget = requireBudgetObject('commands.submit', object.budget, 'budget');
      if (typeof object.reason !== 'string' || object.reason.trim().length === 0) {
        throw invalidInput('commands.submit', 'invalid_reason', 'reason');
      }
      return submitCommand(
        {
          ...optionalCommandIdInput('commands.submit', object.commandId),
          operation: 'execution.budget.revise',
          scope: { kind: 'project', projectId },
          expectedRevision,
          payload: { batchId, budget, reason: object.reason },
        },
        options,
      );
    },

    async getExecutionBudgetStatus(projectId: string, batchId: string): Promise<ExecutionBudgetStatusResult> {
      context.assertOpen('execution.budget.get');
      const project = requireProjectId('execution.budget.get', projectId);
      const batch = requireStableIdInput('execution.budget.get', batchId, 'batchId');
      const json = await getJson(
        'execution.budget.get',
        `${BATCHES_ROUTE_PREFIX}${batch}/budget?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse('execution.budget.get', json);
      if (result.batch.projectId !== project || result.batch.id !== batch) {
        throw new HostProtocolError('response_malformed', 'execution.budget.get', '预算响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listBatchBudgetRevisions(
      projectId: string,
      batchId: string,
      input?: BudgetRevisionListInput,
    ): Promise<BudgetRevisionListResult> {
      context.assertOpen('execution.budget.revisions');
      const project = requireProjectId('execution.budget.revisions', projectId);
      const batch = requireStableIdInput('execution.budget.revisions', batchId, 'batchId');
      const paging = buildBudgetRevisionListQuery(input, 'execution.budget.revisions');
      const query = `projectId=${encodeURIComponent(project)}${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson('execution.budget.revisions', `${BATCHES_ROUTE_PREFIX}${batch}/budget/revisions?${query}`);
      const result = validateAppQueryResponse('execution.budget.revisions', json);
      if (result.records.some((record) => record.batchId !== batch)) {
        throw new HostProtocolError('response_malformed', 'execution.budget.revisions', '预算修订响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    /* ------------------------------------------------------------ *
     * P03-4 / F-008 调度诊断与 Attempt 审计只读查询
     * ------------------------------------------------------------ */

    async listWorkSessions(projectId, input) {
      const op = 'execution.sessions.list';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const object = rejectUnknownInputKeys(op, input, ['runId', 'taskId', 'limit', 'cursor']);
      if ((object.runId !== undefined) === (object.taskId !== undefined)) throw invalidInput(op, 'parent_required');
      const key = object.runId !== undefined ? 'runId' : 'taskId';
      const parent = requireStableIdInput(op, object[key], key);
      const paging = buildPlanListQuery({ limit: input.limit, cursor: input.cursor }, op);
      const query = `projectId=${encodeURIComponent(project)}&${key}=${encodeURIComponent(parent)}${paging ? `&${paging}` : ''}`;
      const result = validateAppQueryResponse(op, await getJson(op, `/v1/work-sessions?${query}`));
      if (result.records.some(row => row.projectId !== project || row[key] !== parent)) {
        throw new HostProtocolError('response_malformed', op, '会话列表归属不匹配');
      }
      return result;
    },
    async getWorkSession(projectId, attemptId) {
      const op = 'execution.session.get';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId), target = requireStableIdInput(op, attemptId, 'attemptId');
      const result = validateAppQueryResponse(op, await getJson(op, `/v1/attempts/${target}/session?projectId=${encodeURIComponent(project)}`));
      if (result.attempt.projectId !== project || result.attempt.id !== target) throw new HostProtocolError('response_malformed', op, '会话详情归属不匹配');
      return result;
    },
    async readWorkSessionEvidence(projectId, attemptId, artifactId) {
      const op = 'execution.session.evidence.get';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId), target = requireStableIdInput(op, attemptId, 'attemptId');
      const artifact = requireStableIdInput(op, artifactId, 'artifactId');
      const result = validateAppQueryResponse(op, await getJson(op, `/v1/attempts/${target}/session/evidence?projectId=${encodeURIComponent(project)}&artifactId=${artifact}`));
      if (result.artifact.artifactId !== artifact) throw new HostProtocolError('response_malformed', op, '证据归属不匹配');
      return result;
    },
    async cancelAttempt(input, options) {
      const object = rejectUnknownInputKeys('commands.submit', input, ['projectId', 'attemptId', 'commandId']);
      return submitCommand({ ...optionalCommandIdInput('commands.submit', object.commandId), operation: 'execution.attempt.cancel',
        scope: { kind: 'project', projectId: requireProjectId('commands.submit', object.projectId as string) },
        payload: { attemptId: requireStableIdInput('commands.submit', object.attemptId, 'attemptId') } }, options);
    },

    async getRunScheduleStatus(projectId: string, runId: string): Promise<RunScheduleStatusResult> {
      context.assertOpen('execution.run.schedule');
      const project = requireProjectId('execution.run.schedule', projectId);
      const run = requireStableIdInput('execution.run.schedule', runId, 'runId');
      const json = await getJson(
        'execution.run.schedule',
        `${RUNS_ROUTE_PREFIX}${run}/${RUN_SCHEDULE_ROUTE_SUFFIX}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse('execution.run.schedule', json);
      if (result.run.projectId !== project || result.run.id !== run) {
        throw new HostProtocolError('response_malformed', 'execution.run.schedule', '调度响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listExecutionAttempts(
      projectId: string,
      taskId: string,
      input?: PlanListPageInput,
    ): Promise<AttemptListResult> {
      context.assertOpen('execution.attempts.list');
      const project = requireProjectId('execution.attempts.list', projectId);
      const task = requireStableIdInput('execution.attempts.list', taskId, 'taskId');
      const paging = buildPlanListQuery(input, 'execution.attempts.list');
      const query =
        `projectId=${encodeURIComponent(project)}&taskId=${encodeURIComponent(task)}` +
        `${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson('execution.attempts.list', `${ATTEMPTS_ROUTE}?${query}`);
      const result = validateAppQueryResponse('execution.attempts.list', json);
      if (
        result.records.some((record) => record.projectId !== project || record.taskId !== task)
      ) {
        throw new HostProtocolError('response_malformed', 'execution.attempts.list', 'Attempt 审计响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listAttemptDiagnostics(
      projectId: string,
      attemptId: string,
      input?: PlanListPageInput,
    ): Promise<AttemptDiagnosticsResult> {
      context.assertOpen('execution.attempt.diagnostics');
      const project = requireProjectId('execution.attempt.diagnostics', projectId);
      const attempt = requireStableIdInput('execution.attempt.diagnostics', attemptId, 'attemptId');
      const paging = buildPlanListQuery(input, 'execution.attempt.diagnostics');
      const query =
        `projectId=${encodeURIComponent(project)}` +
        `${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson(
        'execution.attempt.diagnostics',
        `${ATTEMPTS_ROUTE_PREFIX}${attempt}/${ATTEMPT_DIAGNOSTICS_ROUTE_SUFFIX}?${query}`,
      );
      const result = validateAppQueryResponse('execution.attempt.diagnostics', json);
      if (
        result.records.some((record) => record.projectId !== project || record.attemptId !== attempt)
      ) {
        throw new HostProtocolError('response_malformed', 'execution.attempt.diagnostics', '诊断响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    /* ------------------------------------------------------------ *
     * P03-7 / F-013 Task 机器证据/人审事项/有限返工链只读查询
     * ------------------------------------------------------------ */

    async getTaskVerification(projectId, taskId) {
      const op = 'execution.task.verification.get';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const task = requireStableIdInput(op, taskId, 'taskId');
      const json = await getJson(
        op,
        `${TASKS_ROUTE_PREFIX}${task}/${TASK_VERIFICATION_ROUTE_SUFFIX}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse(op, json);
      if (result.task.taskId !== task) {
        throw new HostProtocolError('response_malformed', op, 'Task 证据响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listTaskApprovalItems(projectId, taskId, input) {
      const op = 'execution.task.approvals.list';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const task = requireStableIdInput(op, taskId, 'taskId');
      const paging = buildPlanListQuery(input, op);
      const query = `projectId=${encodeURIComponent(project)}${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson(
        op,
        `${TASKS_ROUTE_PREFIX}${task}/${TASK_APPROVALS_ROUTE_SUFFIX}?${query}`,
      );
      const result = validateAppQueryResponse(op, json);
      if (result.records.some((record) => record.projectId !== project || record.taskId !== task)) {
        throw new HostProtocolError('response_malformed', op, '人审事项响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listTaskReworkChain(projectId, taskId, input) {
      const op = 'execution.task.rework-chain.list';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const task = requireStableIdInput(op, taskId, 'taskId');
      const paging = buildPlanListQuery(input, op);
      const query = `projectId=${encodeURIComponent(project)}${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson(
        op,
        `${TASKS_ROUTE_PREFIX}${task}/${TASK_REWORK_CHAIN_ROUTE_SUFFIX}?${query}`,
      );
      const result = validateAppQueryResponse(op, json);
      return result;
    },

    /* ------------------------------------------------------------ *
     * P03-5 / F-012 工作区状态只读查询与人工丢弃预览/确认
     * ------------------------------------------------------------ */

    async listWorkspaces(
      projectId: string,
      input?: ListWorkspacesInput,
    ): Promise<WorkspaceListResult> {
      context.assertOpen('workspaces.list');
      const project = requireProjectId('workspaces.list', projectId);
      const paging = buildWorkspaceListQuery(input, 'workspaces.list');
      const query =
        `projectId=${encodeURIComponent(project)}` +
        `${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson('workspaces.list', `${WORKSPACES_ROUTE}?${query}`);
      const result = validateAppQueryResponse('workspaces.list', json);
      if (
        result.records.some(
          (record) =>
            record.projectId !== project ||
            (input?.featureId !== undefined && record.featureId !== input.featureId)
        )
      ) {
        throw new HostProtocolError('response_malformed', 'workspaces.list', '工作区响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async getWorkspace(projectId: string, featureId: string): Promise<WorkspaceDetailResult> {
      context.assertOpen('workspaces.get');
      const project = requireProjectId('workspaces.get', projectId);
      const feature = requireStableIdInput('workspaces.get', featureId, 'featureId');
      const json = await getJson(
        'workspaces.get',
        `${WORKSPACES_ROUTE_PREFIX}${encodeURIComponent(feature)}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse('workspaces.get', json);
      if (result.workspace.projectId !== project || result.workspace.featureId !== feature) {
        throw new HostProtocolError('response_malformed', 'workspaces.get', '工作区响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async listWorkspaceOperations(
      projectId: string,
      input?: ListWorkspaceOperationsInput,
    ): Promise<WorkspaceOperationListResult> {
      context.assertOpen('workspace.operations.list');
      const project = requireProjectId('workspace.operations.list', projectId);
      const paging = buildWorkspaceListQuery(input, 'workspace.operations.list');
      const query =
        `projectId=${encodeURIComponent(project)}` +
        `${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson('workspace.operations.list', `${WORKSPACE_OPERATIONS_ROUTE}?${query}`);
      const result = validateAppQueryResponse('workspace.operations.list', json);
      if (
        result.records.some(
          (record) =>
            record.projectId !== project ||
            (input?.featureId !== undefined && record.featureId !== input.featureId)
        )
      ) {
        throw new HostProtocolError('response_malformed', 'workspace.operations.list', '工作区操作响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async getWorkspaceOperation(
      projectId: string,
      operationId: string,
    ): Promise<WorkspaceOperationDetailResult> {
      context.assertOpen('workspace.operations.get');
      const project = requireProjectId('workspace.operations.get', projectId);
      const id = requireStableIdInput('workspace.operations.get', operationId, 'operationId');
      const json = await getJson(
        'workspace.operations.get',
        `${WORKSPACE_OPERATIONS_ROUTE_PREFIX}${encodeURIComponent(id)}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse('workspace.operations.get', json);
      if (result.operation.projectId !== project || result.operation.id !== id) {
        throw new HostProtocolError('response_malformed', 'workspace.operations.get', '工作区操作响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    /* ------------------------------------------------------------ *
     * P03-8 / F-009 Git 意图/实际提交/操作回执只读查询
     * ------------------------------------------------------------ */

    async listGitOperations(
      projectId: string,
      parent: GitOperationListParentInput,
      input?: PlanListPageInput,
    ): Promise<GitOperationListResult> {
      const op = 'git.operations.list';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const selector = rejectUnknownInputKeys(op, parent, ['featureId', 'runId']);
      const hasFeature = selector.featureId !== undefined;
      const hasRun = selector.runId !== undefined;
      if (hasFeature === hasRun) {
        throw invalidInput(op, 'exactly_one_parent_required', hasFeature ? 'runId' : 'featureId');
      }
      const parentQuery = hasFeature
        ? `&featureId=${encodeURIComponent(requireStableIdInput(op, selector.featureId, 'featureId'))}`
        : `&runId=${encodeURIComponent(requireStableIdInput(op, selector.runId, 'runId'))}`;
      const paging = buildPlanListQuery(input, op);
      const query =
        `projectId=${encodeURIComponent(project)}${parentQuery}` +
        `${paging.length === 0 ? '' : `&${paging}`}`;
      const json = await getJson(op, `${GIT_OPERATIONS_ROUTE}?${query}`);
      const result = validateAppQueryResponse(op, json);
      if (
        result.records.some(
          (record) =>
            record.projectId !== project ||
            (hasFeature
              ? record.featureId !== selector.featureId
              : record.runId !== selector.runId),
        )
      ) {
        throw new HostProtocolError('response_malformed', op, 'Git 操作响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async getGitOperation(projectId: string, operationId: string): Promise<GitOperationDetailResult> {
      const op = 'git.operations.get';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const id = requireStableIdInput(op, operationId, 'operationId');
      const json = await getJson(
        op,
        `${GIT_OPERATIONS_ROUTE_PREFIX}${encodeURIComponent(id)}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse(op, json);
      if (result.operation.operationId !== id || result.operation.projectId !== project) {
        throw new HostProtocolError('response_malformed', op, 'Git 操作响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    /* ------------------------------------------------------------ *
     * P03-8 / F-010 Feature 分轴结果只读查询
     * ------------------------------------------------------------ */

    async getFeatureDelivery(projectId: string, featureId: string): Promise<FeatureDeliveryDetailResult> {
      const op = 'features.delivery.get';
      context.assertOpen(op);
      const project = requireProjectId(op, projectId);
      const id = requireStableIdInput(op, featureId, 'featureId');
      const json = await getJson(
        op,
        `${FEATURES_ROUTE_PREFIX}${encodeURIComponent(id)}${FEATURE_DELIVERY_ROUTE_SUFFIX}?projectId=${encodeURIComponent(project)}`,
      );
      const result = validateAppQueryResponse(op, json);
      if (result.feature.featureId !== id || result.outcome.identities.featureId !== id) {
        throw new HostProtocolError('response_malformed', op, 'Feature 分轴结果响应归属与请求不一致', { details: { reason: 'scope_mismatch' } });
      }
      return result;
    },

    async previewWorkspaceDiscard(
      input: PreviewWorkspaceDiscardInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      context.assertOpen('commands.submit');
      const object = rejectUnknownInputKeys(
        'commands.submit',
        input,
        PREVIEW_WORKSPACE_DISCARD_INPUT_KEYS,
      );
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'workspace.discard.preview',
          scope: { kind: 'project', projectId },
          payload: { featureId },
        },
        options,
      );
      // completed 回执的 result 必须是丢弃预览形状（绑定摘要/有界清单/不可逆影响）。
      if (receipt.status === 'completed') {
        validateWorkspaceDiscardPreviewWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },

    async confirmWorkspaceDiscard(
      input: ConfirmWorkspaceDiscardInput,
      options?: SubmitCommandOptions,
    ): Promise<CommandReceipt> {
      context.assertOpen('commands.submit');
      const object = rejectUnknownInputKeys(
        'commands.submit',
        input,
        CONFIRM_WORKSPACE_DISCARD_INPUT_KEYS,
      );
      const projectId = requireProjectId('commands.submit', object.projectId as string);
      const featureId = requireStableIdInput('commands.submit', object.featureId, 'featureId');
      const workspaceId = requireStableIdInput('commands.submit', object.workspaceId, 'workspaceId');
      const operationId = requireStableIdInput('commands.submit', object.operationId, 'operationId');
      const expectedWorkspaceRevision = requireExpectedRevisionInput(
        'commands.submit',
        object.expectedWorkspaceRevision,
      );
      const preview = requireDiscardPreviewBinding('commands.submit', object.preview);
      const evidenceRefs = object.evidenceRefs;
      if (
        !Array.isArray(evidenceRefs) ||
        evidenceRefs.length < 1 ||
        evidenceRefs.length > 49 ||
        !evidenceRefs.every((ref) => typeof ref === 'string' && STABLE_ID_PATTERN.test(ref))
      ) {
        throw invalidInput('commands.submit', 'invalid_evidence_refs', 'evidenceRefs');
      }
      const receipt = await submitCommand(
        {
          ...(typeof object.commandId === 'string' ? { commandId: object.commandId } : {}),
          operation: 'workspace.discard',
          scope: { kind: 'project', projectId },
          payload: {
            featureId,
            workspaceId,
            operationId,
            expectedWorkspaceRevision,
            preview,
            evidenceRefs: [...evidenceRefs],
          },
        },
        options,
        // F-010 专属幂等通道：持久用户回执以丢弃请求摘要锚定（非信封摘要）。
        'server_anchored',
      );
      // completed 回执的 result 必须是登记摘要形状；命令 completed ≠ 丢弃成功，
      // 实际删除结果经 workspace.operations 查询读取（本方法不冒充操作终态）。
      if (receipt.status === 'completed') {
        validateWorkspaceDiscardConfirmResultWire(receipt.result, 'commands.submit');
      }
      return receipt;
    },
  };
}
