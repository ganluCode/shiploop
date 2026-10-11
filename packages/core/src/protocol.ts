/**
 * HostClient 可依赖的纯线协议入口。仅显式暴露数据形状、常量与确定性校验；
 * 不从根入口重导出，不加载 application 服务或 adapters 装配。
 * 服务端仍负责授权和业务语义，客户端校验不能替代服务端校验。
 */
export {
  isIsoUtcDateTime, isUuidV4, isValidResultRef, validateCommandEnvelope,
  WIRE_MESSAGE_SCHEMA_VERSION,
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
// type-only 导出擦除后不加载业务服务。
export type { EffectiveSettings } from './application/effective-settings.js';
export type { ExportedSettings } from './application/configuration-service.js';
export type {
  GlobalSnapshotResult, ProjectSnapshotResult, SnapshotResult,
} from './application/query-service.js';
