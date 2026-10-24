/**
 * HostClient 可依赖的纯线协议入口。仅显式暴露数据形状、常量与确定性校验；
 * 不从根入口重导出，不加载 application 服务或 adapters 装配。
 * 服务端仍负责授权和业务语义，客户端校验不能替代服务端校验。
 */
export {
  isIsoUtcDateTime, isUuidV4, isValidResultRef, validateCommandEnvelope,
  isPublicError, publicErrorHttpStatus, validateCommandEnvelopeFields, WORK_TOOL_OPERATION_SPECS,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORK_ACCEPTED_SCHEMA_VERSION,
} from './ports/commands.js';
export type { AppOperation, CommandReceipt, CommandScope } from './ports/commands.js';
export {
  BASELINE_CAPABILITIES, BASELINE_CHECKS_MAX, BASELINE_CHECKS_MIN,
  BASELINE_CHECK_OUTPUT_MAX_BYTES, BASELINE_CHECK_TAIL_MAX_BYTES,
  BASELINE_CHECK_TIMEOUT_DEFAULT_MS, BASELINE_CHECK_TIMEOUT_MAX_MS, BASELINE_CHECK_TIMEOUT_MIN_MS,
  BASELINE_LIST_DEFAULT_LIMIT, BASELINE_LIST_MAX_LIMIT,
  BASELINE_COMMAND_OPERATIONS, BASELINE_OPERATION_STATUSES, BASELINE_PREVIEW_WARNING_CODES,
  BASELINE_QUERY_OPERATIONS, BASELINE_REASON_CODES, BASELINE_CHECK_STATUSES,
  computeBaselinePlanDigest, computeBaselinePreviewDigest, validateBaselineAuthorizationSummary,
  validateBaselineCapability, validateBaselineCheckPlan, validateBaselineCodeIdentity,
  validateBaselineListQuery, validateBaselinePreviewPayload, validateBaselineRunPayload,
  validateBaselineCancelPayload, validateProjectInitRequest, validateRepositoryRootPath,
  ONBOARDING_QUERY_SCHEMA_VERSION,
} from './ports/baseline.js';
export type {
  BaselineAuthorizationSummary, BaselineCapability, BaselineCheck, BaselineCheckCounts,
  BaselineCheckOutputRef, BaselineCheckPlan, BaselineCheckResult, BaselineCheckStatus,
  BaselineDeclinedResult, BaselineDetailResult, BaselineListQuery, BaselineListResult,
  BaselineOperationStatus, BaselineOperationSummary, BaselinePreviewCheckView,
  BaselinePreviewPayload, BaselinePreviewResult, BaselinePreviewWarning,
  BaselinePreviewWorkspaceView, BaselineRunPayload, BaselineReasonCode,
  BaselineCancelPayload, ValidatedProjectInitRequest,
  ProjectHealthSummary, ProjectInspectionResult, ProjectOverviewResult,
  ProjectSettingsPresence,
} from './ports/baseline.js';
export { computeCommandRequestDigest, validateWireCommandReceipt } from './ports/command-receipts.js';
export {
  EVENT_CURSOR_PREFIX, PUBLIC_EVENT_SCHEMA_VERSION, PUBLIC_STATE_EVENT_TYPES,
  STATE_EVENT_TYPE_SPECS,
} from './ports/events.js';
export type { PublicStateEvent, PublicStateEventType } from './ports/events.js';
export {
  SETTINGS_SCHEMA_VERSION, SETTINGS_EXPORT_FORMAT_VERSION, validateSettingsPayload,
} from './ports/settings-schema.js';
export type { SettingsScope } from './ports/settings-schema.js';
export type {
  ProjectBindingResult, ProjectDetailResult, ProjectLabelCountsResult, ProjectListResult,
  PublicProjectRecord, PublicRepositoryBindingRecord, PublicSettingsState,
  PublicPhaseRecord, PublicFeatureRecord,
} from './ports/queries.js';
// P03-1 / F-006 计划查询面：公开形状、分页常量与纯校验/游标函数（服务端负责授权）。
export {
  PLAN_LIST_CURSOR_PREFIX, PLAN_LIST_DEFAULT_LIMIT, PLAN_LIST_MAX_LIMIT,
  PLAN_QUERY_OPERATIONS, FEATURE_NOT_EXECUTABLE_REASONS, validatePlanListFilter,
  encodePlanListCursor, decodePlanListCursor,
} from './ports/queries.js';
export type {
  FeatureDetailResult, FeatureListResult, FeatureNotExecutableReason,
  FeaturePlanValidationSummary, PhaseDetailResult, PhaseListResult,
  PlanListResultBase, PublicTaskDependencyEdge, PublicTaskRecord,
  TaskDetailResult, TaskListResult,
} from './ports/queries.js';
// P03-2 / F-007 计划审批查询与决策记录：公开形状（服务端负责授权；HostClient
// 线校验器复用同一形状与原因词汇）。
export { PLAN_APPROVAL_QUERY_OPERATION, toPublicPlanApprovalRecord } from './ports/queries.js';
export type {
  FeatureApprovalsResult, PublicPlanApprovalDecision, PublicPlanApprovalRecord,
} from './ports/queries.js';
export {
  FEATURE_PLAN_DECISIONS, PLAN_APPROVAL_STATUSES, PLAN_APPROVAL_SUBJECT_TYPES,
} from './ports/plan-store.js';
export type {
  FeaturePlanDecision, PlanApprovalStatus, PlanApprovalSubjectType,
} from './ports/plan-store.js';
export {
  PLAN_APPROVAL_VERIFICATION_REASONS,
} from './ports/plan-approval-verification.js';
export type {
  PlanApprovalValidity, PlanApprovalVerificationReason,
} from './ports/plan-approval-verification.js';
// P03-3 / F-010 执行预算只读查询面：公开形状、操作身份与阻塞原因冻结词汇
// （服务端负责授权；HostClient 线校验器复用同一形状）。
export {
  EXECUTION_BUDGET_BLOCK_REASONS,
  EXECUTION_BUDGET_GET_OPERATION,
  EXECUTION_BUDGET_QUERY_OPERATIONS,
  EXECUTION_BUDGET_REVISIONS_OPERATION,
} from './ports/execution-budget-query.js';
export type {
  BudgetRevisionListResult,
  ExecutionBudgetBlockDimension,
  ExecutionBudgetBlockReasonCode,
  ExecutionBudgetQueryOperation,
  ExecutionBudgetStatusResult,
  PublicBatchBudgetRevisionRecord,
  PublicExecutionBudgetBatchView,
  PublicExecutionBudgetBlockReason,
  PublicExecutionBudgetRunView,
  PublicExecutionBudgetTaskView,
} from './ports/execution-budget-query.js';
// P03-4 / F-007 Run 调度原因/Task 派生就绪视图与 Attempt/占用审计只读查询面：
// 公开形状、操作身份与诊断原因冻结词汇（服务端负责授权；Host 接线属 F-008）。
export {
  ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS,
  EXECUTION_ATTEMPT_DIAGNOSTICS_OPERATION,
  EXECUTION_ATTEMPTS_LIST_OPERATION,
  EXECUTION_DISPATCH_LIST_OPERATION,
  EXECUTION_DISPATCH_QUERY_OPERATIONS,
  EXECUTION_RUN_SCHEDULE_OPERATION,
  EXECUTION_SCHEDULE_QUERY_OPERATIONS,
} from './ports/execution-schedule-query.js';
export type {
  AttemptDiagnosticsResult,
  AttemptListResult,
  AttemptNotificationDiagnosticReason,
  DispatchQueueListResult,
  ExecutionDispatchQueryOperation,
  ExecutionScheduleQueryOperation,
  PublicAttemptDiagnosticRecord,
  PublicAttemptRecord,
  PublicAttemptSummary,
  PublicDispatchAttemptView,
  PublicDispatchClaimView,
  PublicDispatchQueueRecord,
  PublicDispatchSlotSummary,
  PublicDispatchSlotView,
  PublicOccupancyRecord,
  PublicScheduleRunView,
  PublicScheduleTaskView,
  RunScheduleEvaluation,
  RunScheduleStatusResult,
} from './ports/execution-schedule-query.js';
// P03-4 / F-008 Host 线校验复用的冻结词汇（同一来源，不复制第二份枚举）。
export { TASK_DAG_REASONS } from './ports/task-dag.js';
export type { TaskDagReason } from './ports/task-dag.js';
export { ATTEMPT_EXECUTION_STAGES, ATTEMPT_STATUSES } from './ports/attempt-store.js';
export type { AttemptExecutionStage, AttemptStatus, AttemptUsageSummary } from './ports/attempt-store.js';
// P04-9 / F-009 派发投影冻结词汇（Host 响应解码复用 Core 单一来源）。
export {
  DISPATCH_BLOCKING_REASONS,
  DISPATCH_DISPLAY_STATES,
  RUN_DISPATCH_CLAIM_ORIGINS,
  RUN_DISPATCH_CLAIM_STATES,
} from './ports/execution-dispatch.js';
export type {
  DispatchBlockingReason,
  DispatchDisplayState,
  RunDispatchClaimOrigin,
  RunDispatchClaimState,
} from './ports/execution-dispatch.js';
// P03-2 / F-007 执行输入制品组身份（回执 result 形状的公共成分；正文永不内联）。
export type { ContextTokenEstimate } from './ports/context-build.js';
export { validateExecutionBudgetProposal } from './ports/execution-budget.js';
export type { ExecutionBudgetProposal } from './ports/execution-budget.js';
export type { ExecutionPreviewResult } from './ports/execution-preview.js';
export {
  EXECUTION_BATCH_STATUSES,
  EXECUTION_RUN_STATUSES,
  EXECUTION_STOP_OPERATION_STATUSES,
} from './ports/execution-store.js';
export { FEATURE_PLAN_STATUSES, FEATURE_STATUSES, TASK_STATUSES } from './ports/plan-store.js';
export type { ExecutionInputOrigin, ExecutionInputRef } from './ports/execution-input.js';
export {
  EXECUTION_INPUT_GROUP_LOCATOR_PREFIX,
  EXECUTION_GROUP_JSON_MEDIA_TYPE,
  EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
  EXECUTION_GROUP_MANIFEST_PURPOSE,
  EXECUTION_GROUP_PROMPT_PURPOSE,
  EXECUTION_GROUP_SNAPSHOT_PURPOSE,
} from './ports/execution-input-prepare.js';
export type {
  ExecutionInputGroupBodyRef, ExecutionInputGroupDigests, ExecutionInputApprovalIdentity,
  PreparedExecutionInputGroup,
} from './ports/execution-input-prepare.js';
// P03-5 / F-012 工作区状态只读查询与人工丢弃预览/确认公共面：公开投影形状、
// 状态/kind/阶段冻结词汇、分页常量与预览形状（服务端负责授权与业务语义；
// Host 接线属 F-011，HostClient/CLI 入口属 F-012）。
export {
  WORKSPACE_STATUSES,
  WORKSPACE_OPERATION_KINDS,
  WORKSPACE_OPERATION_STATUSES,
} from './ports/workspace.js';
export type {
  WorkspaceStatus,
  WorkspaceOperationKind,
  WorkspaceOperationStatus,
} from './ports/workspace.js';
export {
  WORKSPACE_LIST_CURSOR_PREFIX,
  WORKSPACE_LIST_DEFAULT_LIMIT,
  WORKSPACE_LIST_MAX_LIMIT,
  WORKSPACE_QUERY_OPERATIONS,
} from './ports/workspace-query.js';
export type {
  PublicWorkspaceOperationRecord,
  PublicWorkspaceOperationResult,
  PublicWorkspaceRecord,
  WorkspaceDetailResult,
  WorkspaceListResult,
  WorkspaceOperationDetailResult,
  WorkspaceOperationListResult,
  WorkspaceOperationReceiptView,
} from './ports/workspace-query.js';
// P03-6 / F-011 Work Session/Runtime 结果/停止证据/诊断制品只读查询面：
// 公开形状与操作身份冻结词汇（服务端负责授权；Host 接线属 F-012）。
export {
  EXECUTION_WORK_SESSION_EVIDENCE_OPERATION,
  EXECUTION_WORK_SESSION_GET_OPERATION,
  EXECUTION_WORK_SESSIONS_LIST_OPERATION,
  WORK_SESSION_QUERY_OPERATIONS,
  WORK_SESSION_QUERY_STATES,
  validatePublicWorkSessionResultEvidence,
} from './ports/work-session-query.js';
export type {
  PublicWorkSessionAttempt,
  PublicWorkSessionEvidenceRef,
  PublicWorkSessionRecord,
  PublicWorkSessionResultEvidence,
  PublicWorkSessionSummary,
  WorkSessionDetailResult,
  WorkSessionEvidenceContent,
  WorkSessionListResult,
  WorkSessionQueryOperation,
  WorkSessionQueryState,
} from './ports/work-session-query.js';
export { WORK_RECORDING_LIST_OPERATION, WORK_RECORDING_BODY_OPERATION } from './ports/work-recording-query.js';
export type { WorkRecordingPage, WorkRecordingBody, WorkRecordingTarget, WorkRecordingRecordType,
  PublicWorkRecordingArtifactRef } from './ports/work-recording-query.js';
// P04-5 / F-007 公开记录行的冻结词汇（wire 校验与 Core 同源，不漂移）。
export {
  WORK_RECORDING_SOURCES,
  WORK_RECORDING_COVERAGES,
  WORK_RECORDING_SEQUENCE_RECONCILIATIONS,
  WORK_RECORDING_MESSAGE_KINDS,
  WORK_RECORDING_MESSAGE_ROLES,
} from './ports/work-recording.js';
// P03-7 / F-013 Task 机器证据/人审事项/有限返工链只读查询面：公开形状与
// 操作身份冻结词汇（服务端负责授权；Host 接线同源同步）。
export {
  TASK_APPROVAL_ITEMS_LIST_OPERATION,
  TASK_CODE_ACCOUNTING_CLASSIFICATIONS,
  TASK_EVIDENCE_QUERY_OPERATIONS,
  TASK_MACHINE_REASONS,
  TASK_MACHINE_STATUSES,
  TASK_REWORK_CHAIN_LIST_OPERATION,
  TASK_VERIFICATION_GET_OPERATION,
  TASK_VERIFICATION_SELECTION_MODES,
} from './ports/task-evidence-query.js';
export { CODE_ATTEMPT_OUTCOMES } from './ports/code-attempt-budget.js';
export {
  CHECK_RESULT_STATUSES,
  VERIFICATION_BATCH_STATUSES,
} from './ports/verification-store.js';
export type {
  PublicReworkAttemptRecord,
  PublicReworkChainSummary,
  PublicReworkCodeAccounting,
  PublicReworkCodeEligibility,
  PublicReworkRunView,
  PublicReworkSuccessorView,
  PublicTaskApprovalArtifactRef,
  PublicTaskApprovalItemRecord,
  PublicTaskEvidenceState,
  PublicTaskMachineConclusion,
  PublicVerificationBatchRecord,
  PublicVerificationCheckResult,
  PublicVerificationSelection,
  TaskApprovalItemListResult,
  TaskEvidenceQueryOperation,
  TaskMachineReason,
  TaskMachineStatus,
  TaskReworkChainListResult,
  TaskVerificationDetailResult,
  TaskVerificationSelectionMode,
} from './ports/task-evidence-query.js';
export {
  WORKSPACE_DISCARD_BLOCKERS,
  WORKSPACE_DISCARD_OPERATION,
  WORKSPACE_DISCARD_PREVIEW_MAX_ENTRIES,
  WORKSPACE_DISCARD_PREVIEW_OPERATION,
  WORKSPACE_DISCARD_SCOPE,
} from './ports/workspace-discard.js';
export type {
  WorkspaceDiscardBlocker,
  WorkspaceDiscardPreview,
  WorkspaceDiscardPreviewBinding,
  WorkspaceDiscardPreviewEntry,
} from './ports/workspace-discard.js';
// P03-8 / F-009 Git 意图/实际提交/操作回执只读查询面：公开形状、操作身份与
// 状态/原因冻结词汇（服务端负责授权；Host 接线与 HostClient 线校验同源同步）。
export {
  GIT_OPERATION_QUERY_OPERATIONS,
  GIT_OPERATIONS_LIST_OPERATION,
  GIT_OPERATION_GET_OPERATION,
} from './ports/git-operation-query.js';
export type {
  GitOperationDetailResult,
  GitOperationListParent,
  GitOperationListResult,
  GitOperationQueryOperation,
  PublicGitOperationRecord,
} from './ports/git-operation-query.js';
// P03-8 / F-010 Feature 分轴结果只读查询面：公开形状、操作身份与冻结词汇
//（Task/最终检查/人工审批/交付四轴 + 可区分总体 outcome；服务端负责授权）。
export {
  FEATURE_APPROVAL_AXIS_STATUSES,
  FEATURE_DELIVERY_GET_OPERATION,
  FEATURE_DELIVERY_NEXT_STEPS,
  FEATURE_DELIVERY_OUTCOMES,
  FEATURE_DELIVERY_QUERY_OPERATIONS,
  FEATURE_DELIVERY_STAGES,
  FEATURE_VERIFICATION_AXIS_STATUSES,
} from './ports/feature-delivery-query.js';
export type { FeatureExecutionReport } from './application/feature-execution-report.js';
export { FEATURE_REPORT_GET_OPERATION } from './ports/feature-execution-report.js';
export { validateRuntimeRecoverySelection, validateRuntimeRecoveryDecision } from './ports/runtime-recovery.js';
export type {
  FeatureApprovalAxisStatus,
  FeatureDeliveryDetailResult,
  FeatureDeliveryNextStep,
  FeatureDeliveryOutcome,
  FeatureDeliveryQueryOperation,
  FeatureDeliveryStage,
  FeatureVerificationAxisStatus,
  PublicFeatureDeliveryOutcome,
  PublicFeatureDeliveryTaskResult,
} from './ports/feature-delivery-query.js';
// P03-9 / F-013 Run/Batch 控制进度、恢复诊断与 finalization 收尾结果只读查询
// 面：操作身份、显式后续动作冻结词汇与公开形状（服务端负责授权）。
export {
  EXECUTION_BATCH_CONTROL_GET_OPERATION,
  EXECUTION_CONTROL_ATTEMPTS_MAX,
  EXECUTION_CONTROL_NEXT_ACTIONS,
  EXECUTION_CONTROL_QUERY_OPERATIONS,
  EXECUTION_CONTROL_RUNS_MAX,
  EXECUTION_CONTROL_STOP_OPERATIONS_MAX,
  EXECUTION_RECOVERY_CONTINUATIONS_MAX,
  EXECUTION_RUN_CONTROL_GET_OPERATION,
  EXECUTION_RUN_RECOVERY_GET_OPERATION,
  validateRunFinalizationScope,
} from './ports/execution-control-query.js';
export type {
  BatchControlDetailResult,
  ExecutionControlNextAction,
  ExecutionControlQueryOperation,
  PublicExecutionControlAttempt,
  PublicExecutionControlStopOperation,
  PublicExecutionRecoveryContinuation,
  RunControlDetailResult,
  RunRecoveryDetailResult,
} from './ports/execution-control-query.js';
export {
  FEATURE_DELIVERY_STATUSES,
  GIT_OPERATION_EVIDENCE_KINDS,
  GIT_OPERATION_RECEIPT_SCHEMA_VERSION,
  GIT_OPERATION_STATUSES,
  GIT_OPERATION_TERMINAL_STATUSES,
} from './ports/git-operations.js';
export type {
  FeatureDeliveryStatus,
  GitOperationEvidenceKind,
  GitOperationEvidenceRef,
  GitOperationReceipt,
  GitOperationStatus,
} from './ports/git-operations.js';
// Work 客户端只消费纯信封校验和查询结果形状，不加载业务通道。
export type { WorkTaskResult } from './application/work-tool-channel.js';
// P05-1 / F-006：规划候选受限提交的纯常量（操作身份/正支上限；供 Host 工具桥
// 组装命令信封与客户端侧入口限界，服务端仍独立校验）。
export {
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
  PLANNING_CANDIDATE_SUBMIT_MAX_BODY_BYTES,
} from './ports/planning-candidates.js';
// P05-1 / F-011：规划上下文/候选只读查询面：公开形状、操作身份与展示状态
// 冻结词汇（服务端负责授权；HostClient 线校验器复用同一形状）。
export {
  PLANNING_CANDIDATE_BODY_MAX_READ_BYTES,
  PLANNING_CANDIDATE_QUERY_STATES,
  PLANNING_CONTEXTS_LIST_OPERATION,
  PLANNING_CONTEXT_GET_OPERATION,
  PLANNING_CANDIDATE_GET_OPERATION,
  PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT,
  PLANNING_QUERY_OPERATIONS,
  PLANNING_QUERY_STATES,
  derivePlanningOutcomeAxes,
  derivePlanningQueryState,
} from './ports/planning-query.js';
export type {
  PlanningCandidateDetailResult,
  PlanningCandidateQueryState,
  PlanningContextDetailResult,
  PlanningContextListResult,
  PlanningQueryOperation,
  PlanningQueryState,
  PublicPlanningAttemptRecord,
  PublicPlanningCandidateBody,
  PublicPlanningCandidateRef,
  PublicPlanningContextRecord,
  PublicPlanningContextSummary,
  PublicPlanningDecision,
  PublicPlanningRunRecord,
  PublicPlanningTaskSummary,
} from './ports/planning-query.js';
// type-only 导出擦除后不加载业务服务。
export type { EffectiveSettings } from './application/effective-settings.js';
export type { ExportedSettings } from './application/configuration-service.js';
export type {
  GlobalSnapshotResult, ProjectSnapshotResult, SnapshotResult,
} from './application/query-service.js';
