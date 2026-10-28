/**
 * F-013 HostClient 应用面线上响应校验器（client/ 纯函数模块；P02-2 契约 §11.2：
 * 对响应也做运行时校验，畸形回执/事件与未知版本一律协议错误）。
 *
 * 规则落实：
 * - 回执：复用 Core validateWireCommandReceipt（§5.3 同一组不变量，线上
 *   replayed 布尔合法）；schemaVersion ≠ 2 单独分类 unsupported_schema_version，
 *   其余形状/不变量违反一律 response_malformed；accepted 绝不放行；可选核对
 *   期望的 commandId/requestDigest/operation（不符即 response_malformed，
 *   不把别的命令的回执当成本次结果）；
 * - 事件：封套 schemaVersion ≠ 1 → unsupported_schema_version；类型白名单外、
 *   type↔aggregate↔scope 不一致或 payload 形状越界 → response_malformed
 *   （与 §9.2 白名单同一冻结面，客户端侧不复核持久行列语义）；
 * - 查询响应：按 §7.2/§8 冻结字段集精确键校验；配置 payload 复用 Core
 *   validateSettingsPayload 复核；快照 scope 与请求不符 → response_malformed；
 * - 本模块只做结构校验：无 I/O、不读时钟、不导入 node:http/net/fs；错误为
 *   HostProtocolError，details 只含受控 reason，不回显响应原文或秘密。
 */
import { validateBatchDeliveryCommandResult, validateKnowledgeQueryResponse } from 'shiploop-core/protocol';
import type { KnowledgeSearchResultSet, KnowledgeReadResult, MemorySearchResultSet } from 'shiploop-core/protocol';
export type { KnowledgeSearchInput, KnowledgeReadInput, MemorySearchInput, KnowledgeSearchResultSet, KnowledgeReadResult, MemorySearchResultSet } from 'shiploop-core/protocol';
import { BATCH_DELIVERY_STATUSES, isBatchDeliveryPublicSummary } from 'shiploop-core/protocol';
import type { PublicBatchDeliveryResult } from 'shiploop-core/protocol';
export type { PublicBatchDeliveryResult } from 'shiploop-core/protocol';
import { FEATURE_GRAPH_BLOCKER_REASONS, FEATURE_DAG_REASONS, FEATURE_DEPENDENCY_COMPLETION } from 'shiploop-core/protocol';
import { validateGitAgentRepairQueryResult as validateCoreGitAgentRepairQueryResult } from 'shiploop-core/protocol';
import type { GitAgentRepairListResult, GitAgentRepairDetailResult } from 'shiploop-core/protocol';
import type { PhaseGraphResult, PublicFeatureDependencyEdge } from 'shiploop-core/protocol';
export type { PhaseGraphResult, PhaseGraphFeatureReadiness, PublicFeatureDependencyEdge } from 'shiploop-core/protocol';
import { validateFeatureReportWire } from './feature-report-wire.js';
import { validateWorkSessionListWire, validateWorkSessionDetailWire, validateWorkSessionEvidenceWire } from './work-session-wire.js';
import { validateWorkRecordingListWire, validateWorkRecordingBodyWire } from './work-recording-wire.js';
import type { WorkSessionListResult, WorkSessionDetailResult, WorkSessionEvidenceContent, WorkRecordingPage, WorkRecordingBody } from 'shiploop-core/protocol';
export type { WorkSessionListResult, WorkSessionDetailResult, WorkSessionEvidenceContent, WorkRecordingPage, WorkRecordingBody } from 'shiploop-core/protocol';
import {
  ATTEMPT_EXECUTION_STAGES,
  ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS,
  ATTEMPT_STATUSES,
  BASELINE_CHECKS_MAX,
  BASELINE_CHECK_STATUSES,
  BASELINE_CHECK_TAIL_MAX_BYTES,
  BASELINE_OPERATION_STATUSES,
  BASELINE_PREVIEW_WARNING_CODES,
  BASELINE_REASON_CODES,
  EVENT_CURSOR_PREFIX,
  FEATURE_NOT_EXECUTABLE_REASONS,
  ONBOARDING_QUERY_SCHEMA_VERSION,
  PLAN_LIST_CURSOR_PREFIX,
  PUBLIC_EVENT_SCHEMA_VERSION,
  PUBLIC_STATE_EVENT_TYPES,
  validateProfileAuditPayload,
  SETTINGS_EXPORT_FORMAT_VERSION,
  SETTINGS_SCHEMA_VERSION,
  STATE_EVENT_TYPE_SPECS,
  TASK_DAG_REASONS,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORKSPACE_DISCARD_BLOCKERS,
  WORKSPACE_DISCARD_SCOPE,
  WORKSPACE_LIST_CURSOR_PREFIX,
  WORKSPACE_LIST_MAX_LIMIT,
  WORKSPACE_OPERATION_KINDS,
  WORKSPACE_OPERATION_STATUSES,
  WORKSPACE_STATUSES,
  WORK_ACCEPTED_SCHEMA_VERSION,
  PLANNING_ACCEPTED_SCHEMA_VERSION,
  PLANNING_CANDIDATE_QUERY_STATES,
  PLANNING_CONTEXT_DECISIONS,
  PLANNING_CONTEXT_STATUSES,
  PLANNING_QUERY_STATES,
  PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS,
  PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT,
  derivePlanningQueryState,
  EXECUTION_INPUT_GROUP_LOCATOR_PREFIX,
  EXECUTION_GROUP_JSON_MEDIA_TYPE,
  EXECUTION_GROUP_MANIFEST_PURPOSE,
  EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
  EXECUTION_GROUP_PROMPT_PURPOSE,
  EXECUTION_GROUP_SNAPSHOT_PURPOSE,
  FEATURE_PLAN_DECISIONS,
  PLAN_APPROVAL_STATUSES,
  PLAN_APPROVAL_SUBJECT_TYPES,
  PLAN_APPROVAL_VERIFICATION_REASONS,
  isIsoUtcDateTime,
  isUuidV4,
  validateBaselineAuthorizationSummary,
  validateBaselineDirtyScope,
  validateBaselineEnvironmentIdentity,
  validateExecutionBudgetProposal,
  EXECUTION_BATCH_STATUSES,
  EXECUTION_RUN_STATUSES,
  EXECUTION_STOP_OPERATION_STATUSES,
  EXECUTION_CONTROL_ATTEMPTS_MAX,
  EXECUTION_CONTROL_NEXT_ACTIONS,
  EXECUTION_CONTROL_RUNS_MAX,
  EXECUTION_CONTROL_STOP_OPERATIONS_MAX,
  EXECUTION_RECOVERY_CONTINUATIONS_MAX,
  validateRunFinalizationScope,
  TASK_STATUSES,
  EXECUTION_BUDGET_BLOCK_REASONS,
  // P04-9 / F-009：派发投影线校验用冻结词汇（同一来源，不复制第二份枚举）。
  DISPATCH_BLOCKING_REASONS,
  DISPATCH_DISPLAY_STATES,
  RUN_DISPATCH_CLAIM_ORIGINS,
  RUN_DISPATCH_CLAIM_STATES,
  // P03-7 / F-013：Task 证据/人审/返工链线校验用冻结词汇。
  TASK_MACHINE_STATUSES,
  TASK_MACHINE_REASONS,
  TASK_CODE_ACCOUNTING_CLASSIFICATIONS,
  TASK_VERIFICATION_SELECTION_MODES,
  CODE_ATTEMPT_OUTCOMES,
  VERIFICATION_BATCH_STATUSES,
  CHECK_RESULT_STATUSES,
  // P03-8 / F-009：Git 操作查询线校验用冻结词汇（同一来源，不复制第二份枚举）。
  FEATURE_DELIVERY_STATUSES,
  GIT_OPERATION_EVIDENCE_KINDS,
  GIT_OPERATION_RECEIPT_SCHEMA_VERSION,
  GIT_OPERATION_STATUSES,
  GIT_OPERATION_TERMINAL_STATUSES,
  // P05-6 / F-005：集成计划查询线校验复用 Core 冻结词汇。
  INTEGRATION_PLAN_NEXT_STEPS,
  INTEGRATION_PLAN_STATUSES,
  INTEGRATION_PLAN_MODES,
  FEATURE_APPROVAL_AXIS_STATUSES,
  FEATURE_DELIVERY_NEXT_STEPS,
  FEATURE_DELIVERY_OUTCOMES,
  FEATURE_DELIVERY_STAGES,
  FEATURE_PLAN_STATUSES,
  FEATURE_STATUSES,
  FEATURE_VERIFICATION_AXIS_STATUSES,
  validateSettingsPayload,
  validateWireCommandReceipt,
} from 'shiploop-core/protocol';
import type {
  AttemptDiagnosticsResult,
  AttemptListResult,
  DispatchQueueListResult,
  PublicTaskApprovalArtifactRef,
  TaskApprovalItemListResult,
  TaskReworkChainListResult,
  TaskVerificationDetailResult,
  PlanningCandidateDetailResult,
  PlanningContextDetailResult,
  PlanningContextListResult,
  PublicPlanningContextRecord,
  BaselineAuthorizationSummary,
  BaselineCheckCounts,
  BaselineCheckOutputRef,
  BaselineCheckResult,
  BaselineDetailResult,
  BaselineListResult,
  BaselineOperationSummary,
  BaselinePreviewResult,
  CommandReceipt,
  ContextTokenEstimate,
  EffectiveSettings,
  ExecutionInputOrigin,
  ExportedSettings,
  FeatureApprovalsResult,
  ExecutionBudgetStatusResult,
  BudgetRevisionListResult,
  ExecutionPreviewResult,
  FeatureDetailResult,
  FeatureListResult,
  FeaturePlanDecision,
  PhaseDetailResult,
  PhaseListResult,
  PlanApprovalValidity,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectHealthSummary,
  ProjectInspectionResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  ProjectOverviewResult,
  ProjectSettingsPresence,
  PublicFeatureRecord,
  PublicPhaseRecord,
  PublicPlanApprovalDecision,
  PublicProjectRecord,
  PublicRepositoryBindingRecord,
  PublicSettingsState,
  PublicStateEvent,
  PublicStateEventType,
  PublicTaskRecord,
  RunScheduleStatusResult,
  RunControlDetailResult,
  BatchControlDetailResult,
  RunRecoveryDetailResult,
  ResourceListResult,
  SettingsScope,
  SnapshotResult,
  TaskDetailResult,
  TaskListResult,
  GitOperationDetailResult,
  GitOperationListResult,
  FeatureDeliveryDetailResult,
  IntegrationPlanQueryResult,
  WorkspaceDetailResult,
  WorkspaceDiscardPreview,
  WorkspaceListResult,
  WorkspaceOperationDetailResult,
  WorkspaceOperationListResult,
} from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject } from '../contract/index.js';
import type { HostOperation } from '../contract/index.js';
import type { ProjectProfileQueryResult, ProjectProfileMatchQueryResult } from 'shiploop-core/protocol';
import type { ProjectResourceConfiguration, ProjectResourceCandidateDiscoveryResult, ProjectResourceCandidatePreview } from 'shiploop-core';
import { validateProjectResourceCandidate, validateProjectResourceSettings, PROJECT_RESOURCE_CANDIDATE_REASONS } from 'shiploop-core';



/** P03-3 / F-012：执行预览/预算查询结果形状经公共面再导出（供 CLI 纯视图层使用）。 */
export type {
  ExecutionPreviewResult,
  ExecutionBudgetStatusResult,
  BudgetRevisionListResult,
} from 'shiploop-core/protocol';

/** P03-4 / F-008：调度诊断与 Attempt 审计查询结果形状经公共面再导出。 */
export type {
  RunScheduleStatusResult,
  AttemptListResult,
  AttemptDiagnosticsResult,
} from 'shiploop-core/protocol';

/** P04-9 / F-009：派发队列与执行槽位只读投影形状经公共面再导出。 */
export type {
  DispatchQueueListResult,
  PublicDispatchAttemptView,
  PublicDispatchClaimView,
  PublicDispatchQueueRecord,
  PublicDispatchSlotSummary,
  PublicDispatchSlotView,
} from 'shiploop-core/protocol';

/** P03-7 / F-013：Task 证据/人审/返工链查询结果形状经公共面再导出。 */
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
  TaskReworkChainListResult,
  TaskVerificationDetailResult,
} from 'shiploop-core/protocol';

/** P03-5 / F-012：工作区状态查询与人工丢弃预览/确认结果形状经公共面再导出。 */
export type {
  PublicWorkspaceOperationRecord,
  PublicWorkspaceOperationResult,
  PublicWorkspaceRecord,
  WorkspaceDetailResult,
  WorkspaceDiscardPreview,
  WorkspaceDiscardPreviewBinding,
  WorkspaceDiscardPreviewEntry,
  WorkspaceListResult,
  WorkspaceOperationDetailResult,
  WorkspaceOperationListResult,
  WorkspaceOperationReceiptView,
} from 'shiploop-core/protocol';

/** P03-8 / F-009：Git 意图/实际提交/操作回执查询结果形状经公共面再导出。 */
export type {
  GitOperationDetailResult,
  GitOperationListResult,
  PublicGitOperationRecord,
  GitAgentRepairListResult,
  GitAgentRepairDetailResult,
} from 'shiploop-core/protocol';


/** P03-8 / F-010：Feature 分轴结果查询形状经公共面再导出。 */
export type { FeatureDeliveryDetailResult, FeatureExecutionReport, IntegrationPlanQueryResult } from 'shiploop-core/protocol';
import type { FeatureExecutionReport } from 'shiploop-core/protocol';

/** P05-5 / F-007：资源租约列表查询形状经公共面再导出。 */
export type { ResourceListResult, PublicExecutionResourceRecord } from 'shiploop-core/protocol';

/** P03-9 / F-014：控制进度与恢复诊断查询形状经公共面再导出。 */
export type {
  BatchControlDetailResult,
  RunControlDetailResult,
  RunRecoveryDetailResult,
} from 'shiploop-core/protocol';

/** §11.3 查询能力清单（回执/结果读取经 validateCommandReceiptWire，不在本类型内）。 */
export type AppQueryOperation =
  | 'knowledge.search' | 'knowledge.read' | 'memory.search'
  | 'execution.sessions.list'
  | 'execution.session.get'
  | 'execution.session.evidence.get'
  | 'execution.recording.list'
  | 'execution.recording.body.get'
  | 'projects.list'
  | 'projects.get'
  | 'projects.binding.get'
  | 'projects.labelCounts'
  | 'projects.inspect'
  | 'projects.overview'
  | 'projects.profile.get'
  | 'projects.profile.match'
  | 'settings.global.get'
  | 'settings.global.export'
  | 'settings.project.get'
  | 'settings.project.effective'
  | 'settings.project.export'
  | 'snapshot.get'
  | 'baselines.list'
  | 'baselines.get'
  // P03-1 / F-009 §6.6：计划域查询（与 Core PLAN_QUERY_OPERATIONS 同源）。
  | 'phases.list'
  | 'phases.get'
  | 'phases.graph.get'
  | 'features.list'
  | 'features.get'
  | 'tasks.list'
  | 'tasks.get'
  // P03-2 / F-007：审批决策查询（与 Core PLAN_APPROVAL_QUERY_OPERATION 同源）。
  | 'features.approvals'
  | 'execution.budget.get'
  | 'execution.budget.revisions'
  // P03-4 / F-008：调度诊断与 Attempt 审计查询（与 Core
  // EXECUTION_SCHEDULE_QUERY_OPERATIONS 同源）。
  | 'execution.run.schedule'
  | 'execution.attempts.list'
  | 'execution.attempt.diagnostics'
  // P03-7 / F-013：Task 机器证据/人审/返工链查询（与 Core
  // TASK_EVIDENCE_QUERY_OPERATIONS 同源）。
  | 'execution.task.verification.get'
  | 'execution.task.approvals.list'
  | 'execution.task.rework-chain.list'
  // P03-5 / F-011/F-012：工作区状态只读查询（与 Core WORKSPACE_QUERY_OPERATIONS 同源）。
  | 'workspaces.list'
  | 'workspaces.get'
  | 'workspace.operations.list'
  | 'workspace.operations.get'
  // P03-8 / F-009：Git 意图/实际提交/操作回执查询（与 Core
  // GIT_OPERATION_QUERY_OPERATIONS 同源）。
  | 'git.operations.list'
  | 'git.operations.get'
  | 'git.repairs.list'
  | 'git.repairs.get'
  // P03-8 / F-010：Feature 分轴结果查询（与 Core
  // FEATURE_DELIVERY_QUERY_OPERATIONS 同源）。
  | 'features.delivery.get'
  | 'features.report.get'
  // P05-6 / F-005：固定集成计划只读投影。
  | 'integration.plan.get'
  // P03-9 / F-013/F-014：Run/Batch 控制进度、恢复诊断与 finalization 收尾
  // 结果查询（与 Core EXECUTION_CONTROL_QUERY_OPERATIONS 同源）。
  | 'execution.run.control.get'
  | 'execution.batch.control.get'
  | 'execution.batch.delivery.get'
  | 'execution.run.recovery.get'
  // P04-9 / F-009：派发队列与槽位只读投影（与 Core
  // EXECUTION_DISPATCH_QUERY_OPERATIONS 同源）。
  | 'execution.dispatch.list'
  | 'execution.resources.list'
  // P05-1 / F-012：规划上下文/候选只读查询（与 Core PLANNING_QUERY_OPERATIONS
  // 同源；候选正文经受管内容接口核验读取）。
  | 'planning.contexts.list'
  | 'planning.context.get'
  | 'planning.candidate.get'
  | 'project.resources.list'
  | 'project.resources.candidates'
  | 'project.resources.preview';

function validateProjectProfileQueryWire(operation: HostOperation, body: unknown): ProjectProfileQueryResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'projectId', 'candidate', 'confirmed', 'modules']);
  if (object.schemaVersion !== 1) unsupportedVersion(operation, 'schemaVersion');
  if (typeof object.projectId !== 'string') malformed(operation, 'profile_query_header_invalid');
  requireStableId(operation, object.projectId as string);
  const validateRecord = (value: unknown): unknown => {
    if (value === null) return null;
    const record = requirePlain(operation, value);
    exactKeys(operation, record, ['projectId', 'version', 'revision', 'status', 'confirmed', 'confirmedBy', 'modules', 'evidence', 'profileDigest', 'storeRevision']);
    if (record.projectId !== object.projectId || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1 || typeof record.confirmed !== 'boolean' || typeof record.profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.profileDigest) || !['candidate', 'confirmed', 'rejected', 'manual_configuration_required'].includes(record.status as string) || record.confirmed !== (record.status === 'confirmed')) malformed(operation, 'profile_record_invalid');
    if (!Array.isArray(record.modules) || !Array.isArray(record.evidence)) malformed(operation, 'profile_record_invalid');
    for (const item of record.modules) {
      const module = requirePlain(operation, item);
      exactKeys(operation, module, ['id', 'version', 'roots', 'languages', 'frameworks', 'capabilityRefs', 'checkRefs']);
      if (typeof module.id !== 'string' || typeof module.version !== 'string'
        || !Array.isArray(module.roots) || !Array.isArray(module.languages)
        || !Array.isArray(module.frameworks) || !Array.isArray(module.capabilityRefs)
        || !Array.isArray(module.checkRefs)
        || [module.roots, module.languages, module.frameworks, module.capabilityRefs, module.checkRefs]
          .some(values => values.some(value => typeof value !== 'string'))) malformed(operation, 'profile_module_invalid');
    }
    for (const item of record.evidence) {
      const evidence = requirePlain(operation, item);
      exactKeys(operation, evidence, ['id', 'detectorId', 'detectorVersion', 'source', 'summary', 'status', 'confirmed']);
      if (typeof evidence.id !== 'string' || typeof evidence.summary !== 'string' || typeof evidence.confirmed !== 'boolean' || !['candidate', 'confirmed', 'rejected', 'manual_configuration_required'].includes(evidence.status as string)) malformed(operation, 'profile_evidence_invalid');
    }
    return record;
  };
  const candidate = validateRecord(object.candidate);
  const confirmed = validateRecord(object.confirmed);
  if (!Array.isArray(object.modules)) malformed(operation, 'profile_modules_invalid');
  for (const item of object.modules) {
    const module = requirePlain(operation, item);
    exactKeys(operation, module, ['id', 'version', 'status', 'scope', 'appliesTo', 'dependencies', 'digest']);
    if (typeof module.id !== 'string' || typeof module.version !== 'string' || typeof module.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(module.digest) || !['candidate', 'confirmed', 'rejected', 'manual_configuration_required'].includes(module.status as string)) malformed(operation, 'profile_module_invalid');
    for (const key of ['scope', 'appliesTo', 'dependencies'] as const) if (!Array.isArray(module[key]) || module[key].some(value => typeof value !== 'string')) malformed(operation, 'profile_module_invalid');
  }
  return object as unknown as ProjectProfileQueryResult;
}

function validateProjectProfileMatchQueryWire(operation: HostOperation, body: unknown): ProjectProfileMatchQueryResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'projectId', 'match']);
  if (object.schemaVersion !== 1) unsupportedVersion(operation, 'schemaVersion');
  if (typeof object.projectId !== 'string') malformed(operation, 'profile_match_header_invalid');
  requireStableId(operation, object.projectId as string);
  const match = requirePlain(operation, object.match);
  exactKeys(operation, match, ['status', 'profileVersion', 'modules', 'missing', 'reason']);
  if (!['ready', 'not_ready'].includes(match.status as string) || (match.profileVersion !== null && typeof match.profileVersion !== 'number') || !Array.isArray(match.modules) || !Array.isArray(match.missing)) malformed(operation, 'profile_match_invalid');
  for (const item of match.modules) {
    const module = requirePlain(operation, item);
    exactKeys(operation, module, ['id', 'version', 'reason']);
    if (typeof module.id !== 'string' || typeof module.version !== 'string' || typeof module.reason !== 'string') malformed(operation, 'profile_match_invalid');
  }
  if (match.missing.some(value => typeof value !== 'string')) malformed(operation, 'profile_match_invalid');
  return object as unknown as ProjectProfileMatchQueryResult;
}
function malformed(operation: HostOperation, reason: string): never {
  throw new HostProtocolError('response_malformed', operation, 'Host 响应不符合线协议', {
    details: { reason },
  });
}


function unsupportedVersion(operation: HostOperation, field: string): never {
  throw new HostProtocolError(
    'unsupported_schema_version',
    operation,
    'Host 响应的 schema 版本不受支持',
    { details: { reason: 'unsupported_schema_version', field } },
  );
}

function exactKeys(
  operation: HostOperation,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      malformed(operation, 'unknown_response_key');
    }
  }
}

function requirePlain(
  operation: HostOperation,
  value: unknown,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    malformed(operation, 'response_not_object');
  }
  return value;
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireStableId(operation: HostOperation, value: unknown): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    malformed(operation, 'invalid_stable_id');
  }
  return value;
}

function requirePositiveInteger(operation: HostOperation, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    malformed(operation, 'invalid_revision');
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 回执
 * ------------------------------------------------------------------ */

/** 回执身份/摘要核对期望（submitCommand 冻结信封；getReceipt 的 commandId）。 */
export interface CommandReceiptExpectation {
  readonly expectedCommandId?: string;
  readonly expectedRequestDigest?: string;
  readonly expectedOperation?: string;
  readonly expectedProjectId?: string;
}

/**
 * 接受既有 v5、显式 Work accepted v6 与 P05-1 / F-003 规划 accepted v7；其他
 * schemaVersion → unsupported_schema_version；其余形状/不变量违反与身份/摘要
 * 不符 → response_malformed。Core 同时核验版本、操作和关联身份，不能用 v6/v7
 * 绕过 v5 回执的未知字段拒绝规则。握手能力与命令白名单不随本扩展变化。
 */
export function validateCommandReceiptWire(
  value: unknown,
  expected: CommandReceiptExpectation = {},
  operation: HostOperation = 'receipts.get',
): CommandReceipt {
  if (
    isPlainObject(value) &&
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION &&
    !(value.schemaVersion === WORK_ACCEPTED_SCHEMA_VERSION &&
      value.operation === 'execution.start' && value.status === 'accepted') &&
    !(value.schemaVersion === PLANNING_ACCEPTED_SCHEMA_VERSION &&
      value.operation === 'planning.start' && value.status === 'accepted')
  ) {
    unsupportedVersion(operation, 'schemaVersion');
  }
  let receipt: CommandReceipt;
  try {
    receipt = validateWireCommandReceipt(value, operation);
  } catch {
    // StorageError(validation) 的字段定位是 Core 内部诊断；客户端只暴露受控 reason。
    malformed(operation, 'receipt_malformed');
  }
  if (
    expected.expectedCommandId !== undefined &&
    receipt.commandId !== expected.expectedCommandId
  ) {
    malformed(operation, 'receipt_command_id_mismatch');
  }
  if (
    expected.expectedRequestDigest !== undefined &&
    receipt.requestDigest !== expected.expectedRequestDigest
  ) {
    malformed(operation, 'receipt_digest_mismatch');
  }
  if (
    expected.expectedOperation !== undefined &&
    receipt.operation !== expected.expectedOperation
  ) {
    malformed(operation, 'receipt_operation_mismatch');
  }
  if (expected.expectedProjectId !== undefined && (receipt.scope.kind !== 'project' || receipt.scope.projectId !== expected.expectedProjectId)) {
    malformed(operation, 'receipt_scope_mismatch');
  }
  if (receipt.status === 'completed' && ['project.resource.import', 'project.resource.enable', 'project.resource.disable', 'project.resource.revoke'].includes(receipt.operation)) {
    const result = requirePlain(operation, receipt.result);
    exactKeys(operation, result, ['configuration', 'resourceLoaded', 'runtimeExecuted', 'appliesTo']);
    if (result.resourceLoaded !== false || result.runtimeExecuted !== false || result.appliesTo !== 'new_attempts_only') malformed(operation, 'project_resource_receipt_invalid');
    let configuration: ProjectResourceConfiguration;
    try { configuration = validateProjectResourceQueryWire('project.resources.list', result.configuration) as ProjectResourceConfiguration; }
    catch { malformed(operation, 'project_resource_receipt_invalid'); }
    if (receipt.scope.kind !== 'project' || configuration.projectId !== receipt.scope.projectId) malformed(operation, 'project_resource_receipt_scope_invalid');
  }
  if (receipt.status === 'completed' && (receipt.operation === 'execution.batch.finalize' || receipt.operation === 'phase.delivery.approve')) {
    let result;
    try { result = validateBatchDeliveryCommandResult(receipt.result); } catch { malformed(operation, 'batch_delivery_command_result_invalid'); }
    if (receipt.scope.kind !== 'project' || result.projectId !== receipt.scope.projectId ||
      result.status !== (receipt.operation === 'phase.delivery.approve' ? 'approved' : 'ready_for_phase_approval')) malformed(operation, 'batch_delivery_command_scope_invalid');
  }
  return receipt;
}

/* ------------------------------------------------------------------ *
 * 事件封套（§9.1/§9.2）
 * ------------------------------------------------------------------ */

const EVENT_WIRE_KEYS = [
  'schemaVersion',
  'eventId',
  'sequence',
  'type',
  'scope',
  'aggregate',
  'occurredAt',
  'payload',
] as const;

function validateEventPayload(
  operation: HostOperation,
  type: PublicStateEventType,
  payload: unknown,
): Record<string, unknown> {
  const object = requirePlain(operation, payload);
  const kind = STATE_EVENT_TYPE_SPECS[type].payloadKind;
  if (kind === 'projectProfile') {
    try {
      const checked = validateProfileAuditPayload(object);
      if (type !== `project_profile.${checked.action}`) malformed(operation, 'event_payload_violation');
      return { ...checked };
    } catch { malformed(operation, 'event_payload_violation'); }
  }
  if (kind === 'registered') {
    exactKeys(operation, object, ['registered']);
    if (object.registered !== true) {
      malformed(operation, 'event_payload_violation');
    }
    return { registered: true };
  }
  // P03-1 / F-004（§9.2）：Phase 创建事件脱敏 payload（与服务端 mapStateEvent
  // 同一冻结形状），绝不落入 settingsSummary 分支造成误拒。
  if (kind === 'phaseCreated') {
    exactKeys(operation, object, ['created']);
    if (object.created !== true) {
      malformed(operation, 'event_payload_violation');
    }
    return { created: true };
  }
  // P03-1 / F-005（§9.2）：Feature 计划导入事件脱敏 payload。
  if (kind === 'phaseDelivery') {
    exactKeys(operation, object, ['deliveryUpdated']);
    if (object.deliveryUpdated !== true) malformed(operation, 'event_payload_violation');
    return { deliveryUpdated: true };
  }
  if (kind === 'phaseMutation' || kind === 'featurePhaseMoved' || kind === 'featureDagUpdated') {
    const key = kind === 'featurePhaseMoved' ? 'phaseMoved' : kind === 'featureDagUpdated' ? 'dagUpdated' :
      ({ 'phase.metadata.updated': 'metadataUpdated', 'phase.closed': 'closed', 'phase.reopened': 'reopened', 'phase.archived': 'archived' } as Partial<Record<PublicStateEventType, string>>)[type];
    if (key === undefined) malformed(operation, 'event_payload_violation');
    exactKeys(operation, object, [key]);
    if (object[key] !== true) malformed(operation, 'event_payload_violation');
    return { [key]: true };
  }
  if (kind === 'featurePlanImported') {
    exactKeys(operation, object, ['imported']);
    if (object.imported !== true) {
      malformed(operation, 'event_payload_violation');
    }
    return { imported: true };
  }
  // P03-1 / F-007（§9.2）：纯标签 CAS 编辑事件脱敏 payload（phase/feature/task
  // 三个目标实体各自一条，均不携带标签正文）。
  if (kind === 'planLabelsUpdated') {
    exactKeys(operation, object, ['labelsUpdated']);
    if (object.labelsUpdated !== true) {
      malformed(operation, 'event_payload_violation');
    }
    return { labelsUpdated: true };
  }
  // P03-1 / F-008（§9.2）：实质计划修订事件脱敏 payload（不携带成员变更明细）。
  if (kind === 'featurePlanRevised') {
    exactKeys(operation, object, ['revised']);
    if (object.revised !== true) {
      malformed(operation, 'event_payload_violation');
    }
    return { revised: true };
  }
  if (kind === 'changedFields') {
    exactKeys(operation, object, ['changedFields']);
    const fields = object.changedFields;
    if (
      !Array.isArray(fields) ||
      fields.length === 0 ||
      !fields.every((field) => typeof field === 'string')
    ) {
      malformed(operation, 'event_payload_violation');
    }
    return { changedFields: [...(fields as string[])] };
  }
  // P02-3 / F-014（§9.2）：基线事件 payload 独立校验（脱敏摘要/身份），
  // 绝不落入 settingsSummary 分支造成误拒。
  if (kind.startsWith('baseline')) {
    return validateBaselineEventPayload(operation, kind, object);
  }
  if (kind === 'workRecovery') {
    exactKeys(operation, object, ['recoveryUpdated']);
    if (object.recoveryUpdated !== true) malformed(operation, 'event_payload_violation');
    return { recoveryUpdated: true };
  }
  // P03-3/P03-9 执行域脱敏事件：payload 与服务端 mapStateEvent 同一冻结形状
  //（布尔意图/派发标记，绝不携带预算数值、目标正文或停止证据）。命中这些分支
  // 前不得落入 settingsSummary，否则合法事件会被误判为畸形。
  if (kind === 'executionInputPrepared') {
    exactKeys(operation, object, ['prepared']);
    if (object.prepared !== true) malformed(operation, 'event_payload_violation');
    return { prepared: true };
  }
  if (kind === 'executionRunDispatched') {
    exactKeys(operation, object, ['dispatched']);
    if (object.dispatched !== true) malformed(operation, 'event_payload_violation');
    return { dispatched: true };
  }
  if (kind === 'executionBudgetRevised') {
    exactKeys(operation, object, ['revised']);
    if (object.revised !== true) malformed(operation, 'event_payload_violation');
    return { revised: true };
  }
  if (kind === 'executionPaused') {
    exactKeys(operation, object, ['paused']);
    if (object.paused !== true) malformed(operation, 'event_payload_violation');
    return { paused: true };
  }
  if (kind === 'executionResumed') {
    exactKeys(operation, object, ['resumed']);
    if (object.resumed !== true) malformed(operation, 'event_payload_violation');
    return { resumed: true };
  }
  if (kind === 'executionCancelling' || kind === 'executionCancelled') {
    const key = kind === 'executionCancelling' ? 'cancelling' : 'cancelled';
    exactKeys(operation, object, [key]);
    if (object[key] !== true) malformed(operation, 'event_payload_violation');
    return { [key]: true };
  }
  if (kind === 'taskClaimed') {
    exactKeys(operation, object, ['claimed']);
    if (object.claimed !== true) malformed(operation, 'event_payload_violation');
    return { claimed: true };
  }
  if (kind === 'attemptUpdated' || kind === 'taskApprovalBlocked' || kind === 'taskApprovalDecided') {
    const key = kind === 'attemptUpdated' ? 'updated' : kind === 'taskApprovalBlocked' ? 'blocked' : 'decided';
    exactKeys(operation, object, [key]);
    if (object[key] !== true) malformed(operation, 'event_payload_violation');
    return { [key]: true };
  }
  if (kind === 'featureFinalized' || kind === 'featureFinalizationBlocked') {
    const key = kind === 'featureFinalized' ? 'finalized' : 'blocked';
    exactKeys(operation, object, [key]);
    if (object[key] !== true) malformed(operation, 'event_payload_violation');
    return { [key]: true };
  }
  if (kind === 'workspaceOperationUpdated') {
    exactKeys(operation, object, ['schemaVersion', 'operationId', 'status', 'executionStage']);
    if (
      object.schemaVersion !== 1 ||
      !(WORKSPACE_OPERATION_STATUSES as readonly unknown[]).includes(object.status) ||
      !(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(object.executionStage)
    ) {
      malformed(operation, 'event_payload_violation');
    }
    const operationId = requireStableId(operation, object.operationId);
    return {
      schemaVersion: 1,
      operationId,
      status: object.status,
      executionStage: object.executionStage,
    } as never;
  }
  if (kind === 'gitOperationRegistered') {
    exactKeys(operation, object, ['operationId']);
    if (!isUuidV4(object.operationId)) malformed(operation, 'event_payload_violation');
    return { operationId: object.operationId };
  }
  if (kind === 'gitOperationSettled') {
    exactKeys(operation, object, ['operationId', 'status']);
    if (
      !isUuidV4(object.operationId) ||
      !(GIT_OPERATION_TERMINAL_STATUSES as readonly unknown[]).includes(object.status)
    ) {
      malformed(operation, 'event_payload_violation');
    }
    return { operationId: object.operationId, status: object.status };
  }
  // settingsSummary
  exactKeys(operation, object, ['schemaVersion', 'strategies', 'policies', 'resources']);
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    malformed(operation, 'event_payload_violation');
  }
  for (const key of ['strategies', 'policies'] as const) {
    const list = object[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
      malformed(operation, 'event_payload_violation');
    }
  }
  let resources: { count: number; digest: string } | undefined;
  if (object.resources !== undefined) {
    const raw = object.resources;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) malformed(operation, 'event_payload_violation');
    const item = raw as Record<string, unknown>;
    exactKeys(operation, item, ['count', 'digest']);
    if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0 || item.count > 64
      || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)) malformed(operation, 'event_payload_violation');
    resources = { count: item.count as number, digest: item.digest as string };
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    strategies: [...(object.strategies as string[])],
    policies: [...(object.policies as string[])],
    ...(resources === undefined ? {} : { resources }),
  };
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 §9.2：基线事件 payload（与服务端 mapStateEvent 同一冻结
 * 形状——只携带脱敏摘要与操作/检查身份，绝无输出正文/路径/环境值）
 * ------------------------------------------------------------------ */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CHECK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requireEventOperationId(operation: HostOperation, value: unknown): string {
  if (!isUuidV4(value)) {
    malformed(operation, 'event_payload_violation');
  }
  return value;
}

function optionalEventReasonCode(
  operation: HostOperation,
  object: Record<string, unknown>,
): { readonly reasonCode?: string } {
  if (object.reasonCode === undefined) {
    return {};
  }
  if (
    typeof object.reasonCode !== 'string' ||
    !(BASELINE_REASON_CODES as readonly string[]).includes(object.reasonCode)
  ) {
    malformed(operation, 'event_payload_violation');
  }
  return { reasonCode: object.reasonCode };
}

function validateBaselineCountsPayload(
  operation: HostOperation,
  value: unknown,
): BaselineCheckCounts {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun']);
  const counts: Record<string, number> = {};
  for (const key of ['total', 'passed', 'failed', 'error', 'inconclusive', 'notRun'] as const) {
    const count = object[key];
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > BASELINE_CHECKS_MAX
    ) {
      malformed(operation, 'event_payload_violation');
    }
    counts[key] = count;
  }
  return counts as unknown as BaselineCheckCounts;
}

/** 基线事件 payload 校验（kind → 冻结形状）；返回可透传的净 payload。 */
function validateBaselineEventPayload(
  operation: HostOperation,
  kind: string,
  object: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'baselineAuthorized': {
      exactKeys(operation, object, ['operationId', 'planDigest', 'checkCount']);
      const operationId = requireEventOperationId(operation, object.operationId);
      if (typeof object.planDigest !== 'string' || !SHA256_HEX_PATTERN.test(object.planDigest)) {
        malformed(operation, 'event_payload_violation');
      }
      if (
        typeof object.checkCount !== 'number' ||
        !Number.isSafeInteger(object.checkCount) ||
        object.checkCount < 1 ||
        object.checkCount > BASELINE_CHECKS_MAX
      ) {
        malformed(operation, 'event_payload_violation');
      }
      return { operationId, planDigest: object.planDigest, checkCount: object.checkCount };
    }
    case 'baselineStarted': {
      exactKeys(operation, object, ['operationId']);
      return { operationId: requireEventOperationId(operation, object.operationId) };
    }
    case 'baselineCheckCompleted': {
      exactKeys(operation, object, ['operationId', 'checkKey', 'status', 'reasonCode']);
      const operationId = requireEventOperationId(operation, object.operationId);
      if (typeof object.checkKey !== 'string' || !CHECK_KEY_PATTERN.test(object.checkKey)) {
        malformed(operation, 'event_payload_violation');
      }
      if (
        typeof object.status !== 'string' ||
        !(BASELINE_CHECK_STATUSES as readonly string[]).includes(object.status)
      ) {
        malformed(operation, 'event_payload_violation');
      }
      return {
        operationId,
        checkKey: object.checkKey,
        status: object.status,
        ...optionalEventReasonCode(operation, object),
      };
    }
    case 'baselineCompleted': {
      exactKeys(operation, object, ['operationId', 'status', 'reasonCode', 'summary']);
      const operationId = requireEventOperationId(operation, object.operationId);
      if (
        typeof object.status !== 'string' ||
        !(BASELINE_OPERATION_STATUSES as readonly string[]).includes(object.status)
      ) {
        malformed(operation, 'event_payload_violation');
      }
      return {
        operationId,
        status: object.status,
        ...optionalEventReasonCode(operation, object),
        summary: validateBaselineCountsPayload(operation, object.summary),
      };
    }
    case 'baselineCancelled': {
      exactKeys(operation, object, ['operationId', 'reasonCode']);
      return {
        operationId: requireEventOperationId(operation, object.operationId),
        ...optionalEventReasonCode(operation, object),
      };
    }
    default:
      malformed(operation, 'event_payload_violation');
  }
}

/**
 * 校验 SSE 线上的公开事件封套（unknown → PublicStateEvent）。
 * schemaVersion ≠ 1 → unsupported_schema_version；其余违反 → response_malformed。
 */
export function validateStateEventWire(
  value: unknown,
  operation: HostOperation = 'events.subscribe',
): PublicStateEvent {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, EVENT_WIRE_KEYS);
  if (
    typeof object.schemaVersion === 'number' &&
    object.schemaVersion !== PUBLIC_EVENT_SCHEMA_VERSION
  ) {
    unsupportedVersion(operation, 'schemaVersion');
  }
  if (object.schemaVersion !== PUBLIC_EVENT_SCHEMA_VERSION) {
    malformed(operation, 'event_schema_version_invalid');
  }
  if (!isUuidV4(object.eventId)) {
    malformed(operation, 'event_id_invalid');
  }
  if (
    typeof object.sequence !== 'number' ||
    !Number.isSafeInteger(object.sequence) ||
    object.sequence < 1
  ) {
    malformed(operation, 'event_sequence_invalid');
  }
  if (
    typeof object.type !== 'string' ||
    !(PUBLIC_STATE_EVENT_TYPES as readonly string[]).includes(object.type)
  ) {
    // 白名单外类型：显式失败，绝不透传未知 payload。
    malformed(operation, 'unknown_event_type');
  }
  const type = object.type as PublicStateEventType;
  const spec = STATE_EVENT_TYPE_SPECS[type];

  const scope = requirePlain(operation, object.scope);
  exactKeys(operation, scope, ['kind', 'projectId']);
  let eventScope: PublicStateEvent['scope'];
  if (spec.scopeKind === 'global') {
    if (scope.kind !== 'global' || Object.prototype.hasOwnProperty.call(scope, 'projectId')) {
      malformed(operation, 'event_scope_mismatch');
    }
    eventScope = { kind: 'global' };
  } else {
    if (scope.kind !== 'project' || !STABLE_ID_PATTERN.test(scope.projectId as string)) {
      malformed(operation, 'event_scope_mismatch');
    }
    eventScope = { kind: 'project', projectId: scope.projectId as string };
  }

  const aggregate = requirePlain(operation, object.aggregate);
  exactKeys(operation, aggregate, ['type', 'id', 'revision']);
  if (aggregate.type !== spec.aggregateType || typeof aggregate.id !== 'string') {
    malformed(operation, 'event_scope_mismatch');
  }
  const revision = requirePositiveInteger(operation, aggregate.revision);
  if (!isIsoUtcDateTime(object.occurredAt)) {
    malformed(operation, 'event_occurred_at_invalid');
  }
  const payload = validateEventPayload(operation, type, object.payload);
  if (spec.payloadKind === 'projectProfile' && revision !== payload.version) {
    malformed(operation, 'event_payload_violation');
  }

  return {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    eventId: object.eventId,
    sequence: object.sequence,
    type,
    scope: eventScope,
    aggregate: { type: spec.aggregateType, id: aggregate.id as string, revision },
    occurredAt: object.occurredAt,
    payload,
  };
}

/* ------------------------------------------------------------------ *
 * 查询响应记录（§7.2）
 * ------------------------------------------------------------------ */

const PROJECT_RECORD_KEYS = [
  'id',
  'displayName',
  'description',
  'status',
  'labels',
  'repositoryBindingId',
  'revision',
  'createdAt',
  'updatedAt',
] as const;

function validateProjectRecord(operation: HostOperation, value: unknown): PublicProjectRecord {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, PROJECT_RECORD_KEYS);
  const id = requireStableId(operation, object.id);
  if (typeof object.displayName !== 'string' || object.displayName.length === 0) {
    malformed(operation, 'project_display_name_invalid');
  }
  if (object.description !== null && typeof object.description !== 'string') {
    malformed(operation, 'project_description_invalid');
  }
  // status 由服务端生命周期枚举管理；客户端只做结构把关（非空字符串），
  // 不在客户端复制服务端领域枚举（避免两侧枚举漂移造成误拒）。
  if (typeof object.status !== 'string' || object.status.length === 0) {
    malformed(operation, 'project_status_invalid');
  }
  if (
    !Array.isArray(object.labels) ||
    !object.labels.every((label) => typeof label === 'string')
  ) {
    malformed(operation, 'project_labels_invalid');
  }
  if (object.repositoryBindingId !== null && typeof object.repositoryBindingId !== 'string') {
    malformed(operation, 'project_binding_id_invalid');
  }
  const revision = requirePositiveInteger(operation, object.revision);
  if (!isIsoUtcDateTime(object.createdAt) || !isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'project_time_invalid');
  }
  return {
    id,
    displayName: object.displayName,
    description: object.description,
    status: object.status as PublicProjectRecord['status'],
    labels: [...(object.labels as string[])],
    repositoryBindingId: object.repositoryBindingId,
    revision,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

const BINDING_RECORD_KEYS = [
  'id',
  'projectId',
  'canonicalPath',
  'gitCommonDir',
  'repoIdentity',
  'revision',
  'bindingRevision',
  'createdAt',
  'updatedAt',
] as const;

function validateBindingRecord(
  operation: HostOperation,
  value: unknown,
): PublicRepositoryBindingRecord {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, BINDING_RECORD_KEYS);
  const id = requireStableId(operation, object.id);
  const projectId = requireStableId(operation, object.projectId);
  if (typeof object.canonicalPath !== 'string' || object.canonicalPath.length === 0) {
    malformed(operation, 'binding_path_invalid');
  }
  if (object.gitCommonDir !== null && typeof object.gitCommonDir !== 'string') {
    malformed(operation, 'binding_git_common_dir_invalid');
  }
  if (typeof object.repoIdentity !== 'string' || object.repoIdentity.length === 0) {
    malformed(operation, 'binding_repo_identity_invalid');
  }
  const revision = requirePositiveInteger(operation, object.revision);
  const bindingRevision = requirePositiveInteger(operation, object.bindingRevision);
  if (!isIsoUtcDateTime(object.createdAt) || !isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'binding_time_invalid');
  }
  return {
    id,
    projectId,
    canonicalPath: object.canonicalPath,
    gitCommonDir: object.gitCommonDir,
    repoIdentity: object.repoIdentity,
    revision,
    bindingRevision,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

function validateScopeField(
  operation: HostOperation,
  value: unknown,
  expectedKind: 'global' | 'project',
): SettingsScope {
  const scope = requirePlain(operation, value);
  exactKeys(operation, scope, ['kind', 'projectId']);
  if (expectedKind === 'global') {
    if (scope.kind !== 'global' || Object.prototype.hasOwnProperty.call(scope, 'projectId')) {
      malformed(operation, 'settings_scope_mismatch');
    }
    return { kind: 'global' };
  }
  if (scope.kind !== 'project') {
    malformed(operation, 'settings_scope_mismatch');
  }
  return { kind: 'project', projectId: requireStableId(operation, scope.projectId) };
}

/** settings.*.get 当前值：payload 复用 Core 配置 Schema 复核（不另立第二份校验）。 */
function validateSettingsState(operation: HostOperation, value: unknown): PublicSettingsState {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['scope', 'schemaVersion', 'revision', 'payload']);
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'settings_schema_version_invalid');
  }
  const revision = requirePositiveInteger(operation, object.revision);
  const scopeKind = isPlainObject(object.scope) && object.scope.kind === 'project'
    ? 'project'
    : 'global';
  const scope = validateScopeField(operation, object.scope, scopeKind);
  try {
    const payload = validateSettingsPayload(object.payload, {
      operation,
      entity: { type: scope.kind === 'global' ? 'global_settings' : 'project_settings' },
    });
    return { scope, schemaVersion: SETTINGS_SCHEMA_VERSION, revision, payload };
  } catch {
    malformed(operation, 'settings_payload_invalid');
  }
}

/** 有效配置/导出投影的结构把关（深度语义校验是服务端职责，客户端校验封套）。 */
function validateEffectiveSettings(operation: HostOperation, value: unknown): EffectiveSettings {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['configured', 'schemaVersion', 'strategies', 'policies']);
  if (typeof object.configured !== 'boolean') {
    malformed(operation, 'effective_configured_invalid');
  }
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'effective_schema_version_invalid');
  }
  const strategies = requirePlain(operation, object.strategies);
  exactKeys(operation, strategies, [
    'defaultStrategy',
    'modelMap',
    'purposeStrategies',
    'agentOverrides',
  ]);
  const policies = requirePlain(operation, object.policies);
  exactKeys(operation, policies, ['executionLimits', 'verification', 'securityPolicy']);
  return value as EffectiveSettings;
}

function validateExportedSettings(operation: HostOperation, value: unknown): ExportedSettings {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['exportFormatVersion', 'scope', 'projectId', 'current', 'effective']);
  if (object.exportFormatVersion !== SETTINGS_EXPORT_FORMAT_VERSION) {
    if (typeof object.exportFormatVersion === 'number') {
      unsupportedVersion(operation, 'exportFormatVersion');
    }
    malformed(operation, 'export_format_version_invalid');
  }
  if (object.scope !== 'global' && object.scope !== 'project') {
    malformed(operation, 'export_scope_invalid');
  }
  if (object.scope === 'project') {
    requireStableId(operation, object.projectId);
  } else if (object.projectId !== undefined) {
    malformed(operation, 'export_scope_invalid');
  }
  const current = requirePlain(operation, object.current);
  exactKeys(operation, current, ['schemaVersion', 'revision', 'strategies', 'policies']);
  if (current.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    if (typeof current.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'export_current_schema_version_invalid');
  }
  requirePositiveInteger(operation, current.revision);
  if (current.strategies !== undefined) {
    requirePlain(operation, current.strategies);
  }
  if (current.policies !== undefined) {
    requirePlain(operation, current.policies);
  }
  validateEffectiveSettings(operation, object.effective);
  return value as ExportedSettings;
}

/* ------------------------------------------------------------------ *
 * P03-1 / F-009 计划域查询响应与命令结果（§6.6；线消息 v4）
 * ------------------------------------------------------------------ */

const PLAN_CURSOR_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 计划列表 nextCursor：plcur_v1_ 前缀 + base64url 字符集（不透明透传）。 */
function requirePlanCursorOrNull(
  operation: HostOperation,
  value: unknown,
): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    !value.startsWith(PLAN_LIST_CURSOR_PREFIX) ||
    !PLAN_CURSOR_BODY_PATTERN.test(value.slice(PLAN_LIST_CURSOR_PREFIX.length))
  ) {
    malformed(operation, 'plan_cursor_invalid');
  }
  return value;
}

function requireLabelsArray(operation: HostOperation, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((label) => typeof label === 'string')) {
    malformed(operation, 'plan_labels_invalid');
  }
  return [...(value as string[])];
}

/** 引用条目（sourceRefs/requirementsRefs）：{artifactId, contentHash?}。 */
function validatePlanArtifactRefsWire(
  operation: HostOperation,
  value: unknown,
): { readonly artifactId: string; readonly contentHash?: string }[] {
  if (!Array.isArray(value)) {
    malformed(operation, 'plan_refs_invalid');
  }
  return value.map((item) => {
    const object = requirePlain(operation, item);
    exactKeys(operation, object, ['artifactId', 'contentHash']);
    const ref: { artifactId: string; contentHash?: string } = {
      artifactId: requireStableId(operation, object.artifactId),
    };
    if (object.contentHash !== undefined) {
      if (typeof object.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(object.contentHash)) {
        malformed(operation, 'plan_refs_invalid');
      }
      ref.contentHash = object.contentHash;
    }
    return ref;
  });
}

/** Phase 公开记录（§7.2 字段集冻结；status 由服务端枚举管理，客户端只做结构把关）。 */
function validatePhaseRecordWire(operation: HostOperation, value: unknown): PublicPhaseRecord {
  const object = requirePlain(operation, value);
  if (!['open', 'closed', 'archived'].includes(object.status as string)) malformed(operation, 'phase_status_invalid');
  exactKeys(operation, object, [
    'id',
    'projectId',
    'title',
    'description',
    'labels',
    'status',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  const record = {
    id: requireStableId(operation, object.id),
    projectId: requireStableId(operation, object.projectId),
    title: typeof object.title === 'string' && object.title.length > 0 ? object.title : malformed(operation, 'plan_title_invalid'),
    description:
      object.description === null || typeof object.description === 'string'
        ? object.description
        : malformed(operation, 'plan_description_invalid'),
    labels: requireLabelsArray(operation, object.labels),
    status: typeof object.status === 'string' && object.status.length > 0 ? object.status : malformed(operation, 'plan_status_invalid'),
    revision: requirePositiveInteger(operation, object.revision),
  };
  if (!isIsoUtcDateTime(object.createdAt) || !isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'plan_time_invalid');
  }
  return {
    ...record,
    status: record.status as PublicPhaseRecord['status'],
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

/** Feature 公开记录（planDigest 64hex 或 null；不携带策略副本正文）。 */
function validateFeatureRecordWire(operation: HostOperation, value: unknown): PublicFeatureRecord {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'id',
    'projectId',
    'phaseId',
    'title',
    'description',
    'labels',
    'status',
    'planStatus',
    'planDigest',
    'sourceRefs',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  if (
    object.planDigest !== null &&
    (typeof object.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(object.planDigest))
  ) {
    malformed(operation, 'plan_digest_invalid');
  }
  const record = {
    id: requireStableId(operation, object.id),
    projectId: requireStableId(operation, object.projectId),
    phaseId: requireStableId(operation, object.phaseId),
    title: typeof object.title === 'string' && object.title.length > 0 ? object.title : malformed(operation, 'plan_title_invalid'),
    description:
      object.description === null || typeof object.description === 'string'
        ? object.description
        : malformed(operation, 'plan_description_invalid'),
    labels: requireLabelsArray(operation, object.labels),
    status: typeof object.status === 'string' && object.status.length > 0 ? object.status : malformed(operation, 'plan_status_invalid'),
    planStatus:
      typeof object.planStatus === 'string' && object.planStatus.length > 0
        ? object.planStatus
        : malformed(operation, 'plan_status_invalid'),
    sourceRefs: validatePlanArtifactRefsWire(operation, object.sourceRefs),
    revision: requirePositiveInteger(operation, object.revision),
  };
  if (!isIsoUtcDateTime(object.createdAt) || !isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'plan_time_invalid');
  }
  return {
    ...record,
    status: record.status as PublicFeatureRecord['status'],
    planStatus: record.planStatus as PublicFeatureRecord['planStatus'],
    planDigest: object.planDigest,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

/**
 * Task 公开记录（含结构化验收、引用与完整策略副本）。executionConfig 只做
 * JSON 对象结构把关（深度语义由服务端 validateTaskExecutionConfig 单一权威
 * 校验，客户端不复制第二份配置 Schema）。
 */
function validateTaskRecordWire(operation: HostOperation, value: unknown): PublicTaskRecord {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'id',
    'projectId',
    'featureId',
    'title',
    'description',
    'labels',
    'status',
    'complexity',
    'acceptance',
    'requirementsRefs',
    'executionConfig',
    'configSource',
    'configSourceKey',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  if (
    object.complexity !== null &&
    (typeof object.complexity !== 'string' || object.complexity.length === 0)
  ) {
    malformed(operation, 'plan_complexity_invalid');
  }
  const acceptance = requirePlain(operation, object.acceptance);
  exactKeys(operation, acceptance, ['criteria']);
  if (
    !Array.isArray(acceptance.criteria) ||
    !acceptance.criteria.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    malformed(operation, 'plan_acceptance_invalid');
  }
  if (!isPlainObject(object.executionConfig)) {
    malformed(operation, 'plan_execution_config_invalid');
  }
  if (
    typeof object.configSource !== 'string' ||
    object.configSource.length === 0 ||
    (object.configSourceKey !== null && typeof object.configSourceKey !== 'string')
  ) {
    malformed(operation, 'plan_config_source_invalid');
  }
  const record = {
    id: requireStableId(operation, object.id),
    projectId: requireStableId(operation, object.projectId),
    featureId: requireStableId(operation, object.featureId),
    title: typeof object.title === 'string' && object.title.length > 0 ? object.title : malformed(operation, 'plan_title_invalid'),
    description:
      object.description === null || typeof object.description === 'string'
        ? object.description
        : malformed(operation, 'plan_description_invalid'),
    labels: requireLabelsArray(operation, object.labels),
    status: typeof object.status === 'string' && object.status.length > 0 ? object.status : malformed(operation, 'plan_status_invalid'),
    acceptance: { criteria: [...(acceptance.criteria as string[])] },
    requirementsRefs: validatePlanArtifactRefsWire(operation, object.requirementsRefs),
    executionConfig: object.executionConfig as Record<string, unknown>,
    configSource: object.configSource,
    configSourceKey: object.configSourceKey as string | null,
    revision: requirePositiveInteger(operation, object.revision),
  };
  if (!isIsoUtcDateTime(object.createdAt) || !isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'plan_time_invalid');
  }
  return {
    ...record,
    status: record.status as PublicTaskRecord['status'],
    complexity: object.complexity as PublicTaskRecord['complexity'],
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
  };
}

/** 计划层级列表页（schemaVersion + scope 字面量 + 记录数组 + 受控游标）。 */
interface ValidatedPlanListPage<R> {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly records: readonly R[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

function validatePlanListPageOf<R>(
  operation: HostOperation,
  scope: 'phase-list' | 'feature-list' | 'task-list',
  validateRecord: (op: HostOperation, value: unknown) => R,
  body: unknown,
): ValidatedPlanListPage<R> {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'list_schema_version_invalid');
  }
  if (object.scope !== scope) {
    malformed(operation, 'list_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'list_records_invalid');
  }
  const records = object.records.map((record) => validateRecord(operation, record));
  const nextCursor = requirePlanCursorOrNull(operation, object.nextCursor);
  const limit = requirePositiveInteger(operation, object.limit);
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    records,
    nextCursor,
    limit,
  };
}

function validatePhaseListPage(operation: HostOperation, body: unknown): PhaseListResult {
  const page = validatePlanListPageOf(operation, 'phase-list', validatePhaseRecordWire, body);
  return { schemaVersion: page.schemaVersion, scope: 'phase-list', records: page.records, nextCursor: page.nextCursor, limit: page.limit };
}

function validateFeatureListPage(operation: HostOperation, body: unknown): FeatureListResult {
  const page = validatePlanListPageOf(operation, 'feature-list', validateFeatureRecordWire, body);
  return { schemaVersion: page.schemaVersion, scope: 'feature-list', records: page.records, nextCursor: page.nextCursor, limit: page.limit };
}

function validateTaskListPage(operation: HostOperation, body: unknown): TaskListResult {
  const page = validatePlanListPageOf(operation, 'task-list', validateTaskRecordWire, body);
  return { schemaVersion: page.schemaVersion, scope: 'task-list', records: page.records, nextCursor: page.nextCursor, limit: page.limit };
}

/** features.get 完整 DAG 详情（Feature + 校验摘要 + 不可执行原因 + Task + 边）。 */
function validateFeaturePlanDetailWire(operation: HostOperation, body: unknown): FeatureDetailResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, [
    'feature',
    'validation',
    'notExecutableReasons',
    'tasks',
    'dependencies',
  ]);
  const feature = validateFeatureRecordWire(operation, object.feature);
  const validation = requirePlain(operation, object.validation);
  exactKeys(operation, validation, ['taskCount', 'dependencyEdgeCount', 'executable']);
  for (const key of ['taskCount', 'dependencyEdgeCount'] as const) {
    if (
      typeof validation[key] !== 'number' ||
      !Number.isSafeInteger(validation[key]) ||
      validation[key] < 0
    ) {
      malformed(operation, 'plan_validation_invalid');
    }
  }
  if (typeof validation.executable !== 'boolean') {
    malformed(operation, 'plan_validation_invalid');
  }
  if (!Array.isArray(object.notExecutableReasons)) {
    malformed(operation, 'plan_not_executable_invalid');
  }
  const reasons = object.notExecutableReasons.map((reason) => {
    if (
      typeof reason !== 'string' ||
      !(FEATURE_NOT_EXECUTABLE_REASONS as readonly string[]).includes(reason)
    ) {
      malformed(operation, 'plan_not_executable_invalid');
    }
    return reason as FeatureDetailResult['notExecutableReasons'][number];
  });
  if (!Array.isArray(object.tasks)) {
    malformed(operation, 'plan_tasks_invalid');
  }
  const tasks = object.tasks.map((task) => validateTaskRecordWire(operation, task));
  if (!Array.isArray(object.dependencies)) {
    malformed(operation, 'plan_dependencies_invalid');
  }
  const taskIds = new Set(tasks.map((task) => task.id));
  const dependencies = object.dependencies.map((edge) => {
    const edgeObject = requirePlain(operation, edge);
    exactKeys(operation, edgeObject, ['taskId', 'dependsOnId']);
    const taskEdge = {
      taskId: requireStableId(operation, edgeObject.taskId),
      dependsOnId: requireStableId(operation, edgeObject.dependsOnId),
    };
    if (!taskIds.has(taskEdge.taskId) || !taskIds.has(taskEdge.dependsOnId)) {
      malformed(operation, 'plan_dependencies_invalid');
    }
    return taskEdge;
  });
  return {
    feature,
    validation: {
      taskCount: validation.taskCount as number,
      dependencyEdgeCount: validation.dependencyEdgeCount as number,
      executable: validation.executable as boolean,
    },
    notExecutableReasons: reasons,
    tasks,
    dependencies,
  };
}

/* ------------------------- 命令结果（completed 回执内嵌） ------------------------- */

/** phase.create completed 结果：{phase}。 */
export interface PhaseCreateResult {
  readonly phase: PublicPhaseRecord;
}

export function validatePhaseCreateResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): PhaseCreateResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['phase']);
  return { phase: validatePhaseRecordWire(operation, object.phase) };
}

/** P05-2 图与修改回执：字段冻结，响应归属由 HostClient 绑定本次请求。 */
function validateFeatureEdgeWire(operation: HostOperation, value: unknown): PublicFeatureDependencyEdge {
  const edge = requirePlain(operation, value);
  exactKeys(operation, edge, ['id', 'projectId', 'phaseId', 'featureId', 'dependsOnId', 'codeBaselineRef']);
  for (const key of ['id', 'projectId', 'phaseId', 'featureId', 'dependsOnId']) requireStableId(operation, edge[key]);
  if (edge.codeBaselineRef !== null && (typeof edge.codeBaselineRef !== 'string' || edge.codeBaselineRef.length === 0 || edge.codeBaselineRef.length > 512)) malformed(operation, 'feature_edge_baseline_invalid');
  return edge as unknown as PublicFeatureDependencyEdge;
}
export function validateFeatureMoveResultWire(value: unknown, operation: HostOperation = 'commands.submit') {
  const result = requirePlain(operation, value);
  exactKeys(operation, result, ['feature']);
  return { feature: validateFeatureRecordWire(operation, result.feature) };
}
export function validateFeatureDagResultWire(value: unknown, operation: HostOperation = 'commands.submit') {
  const result = requirePlain(operation, value);
  exactKeys(operation, result, ['phase', 'edges']);
  const phase = validatePhaseRecordWire(operation, result.phase);
  if (!Array.isArray(result.edges)) malformed(operation, 'feature_edges_invalid');
  const edges = result.edges.map(edge => validateFeatureEdgeWire(operation, edge));
  if (edges.some(edge => edge.projectId !== phase.projectId || edge.phaseId !== phase.id)) malformed(operation, 'scope_mismatch');
  return { phase, edges };
}
function validatePhaseGraphWire(value: unknown): PhaseGraphResult {
  const operation = 'phases.graph.get';
  const graph = requirePlain(operation, value);
  exactKeys(operation, graph, ['schemaVersion', 'scope', 'phase', 'features', 'dependencies', 'readiness', 'readyFeatureIds', 'executableFeatureIds', 'nextCursor', 'limit']);
  if (graph.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) throw new HostProtocolError('unsupported_schema_version', operation, '不支持的图协议版本');
  if (graph.scope !== 'phase-graph' || !Number.isInteger(graph.limit) || (graph.limit as number) < 1 || (graph.limit as number) > 200) malformed(operation, 'phase_graph_page_invalid');
  if (graph.nextCursor !== null && (typeof graph.nextCursor !== 'string' || !graph.nextCursor.startsWith(PLAN_LIST_CURSOR_PREFIX))) malformed(operation, 'phase_graph_cursor_invalid');
  const phase = validatePhaseRecordWire(operation, graph.phase);
  if (!Array.isArray(graph.features) || graph.features.length > (graph.limit as number) || !Array.isArray(graph.dependencies) || !Array.isArray(graph.readiness)) malformed(operation, 'phase_graph_invalid');
  const features = graph.features.map(item => validateFeatureRecordWire(operation, item));
  const ids = new Set(features.map(item => item.id));
  if (ids.size !== features.length || features.some(item => item.projectId !== phase.projectId || item.phaseId !== phase.id)) malformed(operation, 'scope_mismatch');
  const dependencies = graph.dependencies.map(item => validateFeatureEdgeWire(operation, item));
  // Dependencies cover the whole graph, including nodes outside this page.
  if (dependencies.some(edge => edge.projectId !== phase.projectId || edge.phaseId !== phase.id)) malformed(operation, 'scope_mismatch');
  const readiness = graph.readiness.map(value => {
    const item = requirePlain(operation, value);
    exactKeys(operation, item, ['featureId', 'dependencyCompleted', 'dependencyCompletion', 'integrationReady', 'dependencyIntegrationReady', 'ready', 'reason', 'blockers']);
    requireStableId(operation, item.featureId);
    for (const key of ['dependencyCompleted', 'integrationReady', 'dependencyIntegrationReady', 'ready']) if (typeof item[key] !== 'boolean') malformed(operation, 'phase_graph_readiness_invalid');
    if (!(FEATURE_DAG_REASONS as readonly unknown[]).includes(item.reason) || !(FEATURE_DEPENDENCY_COMPLETION as readonly unknown[]).includes(item.dependencyCompletion) || !Array.isArray(item.blockers) || item.blockers.some(reason => !(FEATURE_GRAPH_BLOCKER_REASONS as readonly unknown[]).includes(reason))) malformed(operation, 'phase_graph_readiness_invalid');
    if (!ids.has(item.featureId as string) || item.dependencyCompleted !== (item.dependencyCompletion === 'complete') || item.ready !== (item.reason === 'ready') || (item.ready && (!item.dependencyCompleted || !item.dependencyIntegrationReady))) malformed(operation, 'phase_graph_readiness_invalid');
    return item as unknown as PhaseGraphResult['readiness'][number];
  });
  if (readiness.length !== ids.size || new Set(readiness.map(item => item.featureId)).size !== ids.size) malformed(operation, 'phase_graph_readiness_invalid');
  for (const key of ['readyFeatureIds', 'executableFeatureIds'] as const) {
    const candidates = graph[key];
    if (!Array.isArray(candidates) || new Set(candidates).size !== candidates.length || candidates.some(id => !ids.has(id as string))) malformed(operation, 'phase_graph_candidates_invalid');
    if (candidates.some(id => !readiness.some(item => item.featureId === id && item.ready && (key !== 'executableFeatureIds' || item.blockers.length === 0)))) malformed(operation, 'phase_graph_candidates_invalid');
  }
  return { ...graph, phase, features, dependencies, readiness } as unknown as PhaseGraphResult;
}

/** feature.plan.import completed 结果：{feature, tasks:[{id}], validation}。 */
export interface FeaturePlanImportResult {
  readonly feature: PublicFeatureRecord;
  readonly tasks: readonly { readonly id: string }[];
  readonly validation: { readonly taskCount: number; readonly dependencyEdgeCount: number; readonly executable: boolean };
}

function validatePlanValidationSummaryWire(
  operation: HostOperation,
  value: unknown,
): FeaturePlanImportResult['validation'] {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['taskCount', 'dependencyEdgeCount', 'executable']);
  if (
    typeof object.taskCount !== 'number' ||
    !Number.isSafeInteger(object.taskCount) ||
    object.taskCount < 0 ||
    typeof object.dependencyEdgeCount !== 'number' ||
    !Number.isSafeInteger(object.dependencyEdgeCount) ||
    object.dependencyEdgeCount < 0 ||
    typeof object.executable !== 'boolean'
  ) {
    malformed(operation, 'plan_validation_invalid');
  }
  return {
    taskCount: object.taskCount,
    dependencyEdgeCount: object.dependencyEdgeCount,
    executable: object.executable,
  };
}

function validateTaskIdListWire(
  operation: HostOperation,
  value: unknown,
): readonly { readonly id: string }[] {
  if (!Array.isArray(value)) {
    malformed(operation, 'plan_task_ids_invalid');
  }
  return value.map((item) => {
    const object = requirePlain(operation, item);
    exactKeys(operation, object, ['id']);
    return { id: requireStableId(operation, object.id) };
  });
}

export function validateFeaturePlanImportResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): FeaturePlanImportResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['feature', 'tasks', 'validation']);
  return {
    feature: validateFeatureRecordWire(operation, object.feature),
    tasks: validateTaskIdListWire(operation, object.tasks),
    validation: validatePlanValidationSummaryWire(operation, object.validation),
  };
}

/** plan.labels.update completed 结果：{entityType, id, labels, revision, updatedAt}。 */
export interface PlanLabelsUpdateResult {
  readonly entityType: 'phase' | 'feature' | 'task';
  readonly id: string;
  readonly labels: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
}

export function validatePlanLabelsUpdateResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): PlanLabelsUpdateResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['entityType', 'id', 'labels', 'revision', 'updatedAt']);
  if (object.entityType !== 'phase' && object.entityType !== 'feature' && object.entityType !== 'task') {
    malformed(operation, 'plan_entity_type_invalid');
  }
  if (!isIsoUtcDateTime(object.updatedAt)) {
    malformed(operation, 'plan_time_invalid');
  }
  return {
    entityType: object.entityType,
    id: requireStableId(operation, object.id),
    labels: requireLabelsArray(operation, object.labels),
    revision: requirePositiveInteger(operation, object.revision),
    updatedAt: object.updatedAt,
  };
}

/** feature.plan.revise completed 结果：导入结果 + 有界成员分类。 */
export interface FeaturePlanReviseResult extends FeaturePlanImportResult {
  readonly memberChanges: {
    readonly keptTaskCount: number;
    readonly createdTaskCount: number;
    readonly removedTaskCount: number;
  };
}

export function validateFeaturePlanReviseResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): FeaturePlanReviseResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['feature', 'tasks', 'memberChanges', 'validation']);
  const memberChanges = requirePlain(operation, object.memberChanges);
  exactKeys(operation, memberChanges, ['keptTaskCount', 'createdTaskCount', 'removedTaskCount']);
  for (const key of ['keptTaskCount', 'createdTaskCount', 'removedTaskCount'] as const) {
    if (
      typeof memberChanges[key] !== 'number' ||
      !Number.isSafeInteger(memberChanges[key]) ||
      memberChanges[key] < 0
    ) {
      malformed(operation, 'plan_member_changes_invalid');
    }
  }
  return {
    feature: validateFeatureRecordWire(operation, object.feature),
    tasks: validateTaskIdListWire(operation, object.tasks),
    memberChanges: {
      keptTaskCount: memberChanges.keptTaskCount as number,
      createdTaskCount: memberChanges.createdTaskCount as number,
      removedTaskCount: memberChanges.removedTaskCount as number,
    },
    validation: validatePlanValidationSummaryWire(operation, object.validation),
  };
}

/* --------------------- P03-2 / F-007 决策/策略/输入准备结果 --------------------- */

/** 64 位小写 hex 摘要（身份级；不是正文）。 */
function requireSha256Hex(operation: HostOperation, value: unknown, reason: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    malformed(operation, reason);
  }
  return value;
}

function requireSha256HexOrNull(
  operation: HostOperation,
  value: unknown,
  reason: string,
): string | null {
  return value === null ? null : requireSha256Hex(operation, value, reason);
}

function requireNonEmptyString(
  operation: HostOperation,
  value: unknown,
  reason: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    malformed(operation, reason);
  }
  return value;
}

/**
 * 公开决策记录（PublicPlanApprovalDecision）：服务端权威字段集冻结；
 * `requireCurrent` 时 `current` 必须为 true（completed 结果的当前决定形态）。
 */
function validatePlanApprovalDecisionWire(
  operation: HostOperation,
  value: unknown,
  options: { readonly requireCurrent: boolean },
): PublicPlanApprovalDecision {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'id',
    'projectId',
    'subjectId',
    'subjectType',
    'subjectDigest',
    'checkPolicyDigest',
    'status',
    'decisionActor',
    'reason',
    'decidedAt',
    'revision',
    'createdAt',
    'updatedAt',
    'current',
  ]);
  if (
    typeof object.subjectType !== 'string' ||
    !(PLAN_APPROVAL_SUBJECT_TYPES as readonly string[]).includes(object.subjectType)
  ) {
    malformed(operation, 'approval_subject_type_invalid');
  }
  if (
    typeof object.status !== 'string' ||
    !(PLAN_APPROVAL_STATUSES as readonly string[]).includes(object.status)
  ) {
    malformed(operation, 'approval_status_invalid');
  }
  if (
    object.decisionActor !== null &&
    (typeof object.decisionActor !== 'string' || object.decisionActor.length === 0)
  ) {
    malformed(operation, 'approval_actor_invalid');
  }
  if (object.reason !== null && typeof object.reason !== 'string') {
    malformed(operation, 'approval_reason_invalid');
  }
  if (
    (object.decidedAt !== null && !isIsoUtcDateTime(object.decidedAt)) ||
    !isIsoUtcDateTime(object.createdAt) ||
    !isIsoUtcDateTime(object.updatedAt)
  ) {
    malformed(operation, 'approval_time_invalid');
  }
  if (typeof object.current !== 'boolean') {
    malformed(operation, 'approval_current_invalid');
  }
  if (options.requireCurrent && object.current !== true) {
    malformed(operation, 'approval_current_invalid');
  }
  return {
    id: requireStableId(operation, object.id),
    projectId: requireStableId(operation, object.projectId),
    subjectId: requireStableId(operation, object.subjectId),
    subjectType: object.subjectType as PublicPlanApprovalDecision['subjectType'],
    subjectDigest: requireSha256Hex(operation, object.subjectDigest, 'approval_digest_invalid'),
    checkPolicyDigest: requireSha256HexOrNull(
      operation,
      object.checkPolicyDigest,
      'approval_digest_invalid',
    ),
    status: object.status as PublicPlanApprovalDecision['status'],
    decisionActor: object.decisionActor as string | null,
    reason: object.reason as string | null,
    decidedAt: object.decidedAt as string | null,
    revision: requirePositiveInteger(operation, object.revision),
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    current: object.current,
  };
}

/** 有效批准评估块（fail-closed 词汇；批准不是启动授权）。 */
function validatePlanApprovalValidityWire(
  operation: HostOperation,
  value: unknown,
): PlanApprovalValidity {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'valid',
    'reason',
    'planDigest',
    'checkPolicyDigest',
    'currentDecisionId',
  ]);
  if (typeof object.valid !== 'boolean') {
    malformed(operation, 'approval_validity_invalid');
  }
  if (
    typeof object.reason !== 'string' ||
    !(PLAN_APPROVAL_VERIFICATION_REASONS as readonly string[]).includes(object.reason)
  ) {
    malformed(operation, 'approval_validity_invalid');
  }
  if (
    object.currentDecisionId !== null &&
    (typeof object.currentDecisionId !== 'string' || object.currentDecisionId.length === 0)
  ) {
    malformed(operation, 'approval_validity_invalid');
  }
  return {
    valid: object.valid,
    reason: object.reason as PlanApprovalValidity['reason'],
    planDigest: requireSha256HexOrNull(operation, object.planDigest, 'approval_validity_invalid'),
    checkPolicyDigest: requireSha256Hex(operation, object.checkPolicyDigest, 'approval_validity_invalid'),
    currentDecisionId: object.currentDecisionId as string | null,
  };
}

/** feature.plan.decide completed 结果：{feature, decision, approval(current)}。 */
export interface FeaturePlanDecideResult {
  readonly feature: PublicFeatureRecord;
  readonly decision: FeaturePlanDecision;
  readonly approval: PublicPlanApprovalDecision;
}

export function validateFeaturePlanDecideResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): FeaturePlanDecideResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['feature', 'decision', 'approval']);
  if (
    typeof object.decision !== 'string' ||
    !(FEATURE_PLAN_DECISIONS as readonly string[]).includes(object.decision)
  ) {
    malformed(operation, 'plan_decision_invalid');
  }
  return {
    feature: validateFeatureRecordWire(operation, object.feature),
    decision: object.decision as FeaturePlanDecision,
    approval: validatePlanApprovalDecisionWire(operation, object.approval, {
      requireCurrent: true,
    }),
  };
}

/** task.strategy.update completed 结果：{task}（策略副本与来源是编辑事实）。 */
export interface TaskStrategyUpdateResult {
  readonly task: PublicTaskRecord;
}

export function validateTaskStrategyUpdateResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): TaskStrategyUpdateResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['task']);
  return { task: validateTaskRecordWire(operation, object.task) };
}

/** 制品组单正文引用（身份级；正文永不内联）。 */
export interface ExecutionInputGroupBodyRefWire {
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
}

function validateExecutionInputGroupBodyRefWire(
  operation: HostOperation,
  value: unknown,
  part: 'snapshot' | 'manifest' | 'prompt',
): ExecutionInputGroupBodyRefWire {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'artifactId',
    'version',
    'contentHash',
    'sizeBytes',
    'locator',
    'mediaType',
  ]);
  const expectedMediaType =
    part === 'prompt' ? EXECUTION_GROUP_PROMPT_MEDIA_TYPE : EXECUTION_GROUP_JSON_MEDIA_TYPE;
  const locator = requireNonEmptyString(operation, object.locator, 'input_group_locator_invalid');
  // locator = <EXECUTION_INPUT_GROUP_LOCATOR_PREFIX>/<taskId>/<part>（身份字段，
  // 不是文件路径；物理位置仅由 artifactId 推导，本层绝不按 locator 读文件）。
  const pattern = new RegExp(
    `^${EXECUTION_INPUT_GROUP_LOCATOR_PREFIX}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/${part}$`,
  );
  if (!pattern.test(locator)) {
    malformed(operation, 'input_group_locator_invalid');
  }
  if (object.mediaType !== expectedMediaType) {
    malformed(operation, 'input_group_media_type_invalid');
  }
  if (
    typeof object.sizeBytes !== 'number' ||
    !Number.isSafeInteger(object.sizeBytes) ||
    object.sizeBytes < 0
  ) {
    malformed(operation, 'input_group_size_invalid');
  }
  return {
    artifactId: requireStableId(operation, object.artifactId),
    version: requirePositiveInteger(operation, object.version),
    contentHash: requireSha256Hex(operation, object.contentHash, 'input_group_hash_invalid'),
    sizeBytes: object.sizeBytes,
    locator,
    mediaType: expectedMediaType,
  };
}

/** 必需输入引用（F-004 ExecutionInputRef 的回执投影：不含 projectId/kind）。 */
export interface ExecutionInputRefWire {
  readonly purpose: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
  readonly origin: ExecutionInputOrigin;
}

function validateExecutionInputOriginWire(
  operation: HostOperation,
  value: unknown,
): ExecutionInputOrigin {
  const object = requirePlain(operation, value);
  if (object.kind === 'artifact') {
    exactKeys(operation, object, ['kind']);
    return { kind: 'artifact' };
  }
  if (object.kind === 'file') {
    exactKeys(operation, object, ['kind', 'root', 'relativePath']);
    const relativePath = requireNonEmptyString(
      operation,
      object.relativePath,
      'input_origin_invalid',
    );
    if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      malformed(operation, 'input_origin_invalid');
    }
    return {
      kind: 'file',
      root: requireStableId(operation, object.root),
      relativePath,
    };
  }
  malformed(operation, 'input_origin_invalid');
}

function validateExecutionInputRefWire(
  operation: HostOperation,
  value: unknown,
): ExecutionInputRefWire {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'purpose',
    'artifactId',
    'version',
    'contentHash',
    'sizeBytes',
    'locator',
    'mediaType',
    'origin',
  ]);
  if (
    typeof object.sizeBytes !== 'number' ||
    !Number.isSafeInteger(object.sizeBytes) ||
    object.sizeBytes < 0
  ) {
    malformed(operation, 'input_ref_size_invalid');
  }
  return {
    purpose: requireNonEmptyString(operation, object.purpose, 'input_ref_purpose_invalid'),
    artifactId: requireStableId(operation, object.artifactId),
    version: requirePositiveInteger(operation, object.version),
    contentHash: requireSha256Hex(operation, object.contentHash, 'input_ref_hash_invalid'),
    sizeBytes: object.sizeBytes,
    locator: requireNonEmptyString(operation, object.locator, 'input_ref_locator_invalid'),
    mediaType: requireNonEmptyString(operation, object.mediaType, 'input_ref_media_invalid'),
    origin: validateExecutionInputOriginWire(operation, object.origin),
  };
}

/** execution.input.prepare completed 结果（可绑定制品组身份；正文永不内联）。 */
export interface ExecutionInputPrepareResult {
  readonly schemaVersion: number;
  readonly bindable: true;
  readonly preparedAt: string;
  readonly group: {
    readonly snapshot: ExecutionInputGroupBodyRefWire;
    readonly manifest: ExecutionInputGroupBodyRefWire;
    readonly prompt: ExecutionInputGroupBodyRefWire;
  };
  readonly requiredInputs: readonly ExecutionInputRefWire[];
  readonly digests: {
    readonly snapshotDigest: string;
    readonly manifestDigest: string;
    readonly promptDigest: string;
    readonly strategyCopyDigest: string;
    readonly permissionsDigest: string;
  };
  readonly approval: {
    readonly planDigest: string;
    readonly checkPolicyDigest: string;
    readonly decisionId: string | null;
    readonly featureRevision: number;
  };
  readonly taskRevision: number;
  readonly promptBytes: number;
  readonly tokenEstimate: ContextTokenEstimate;
}

export function validateExecutionInputPrepareResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): ExecutionInputPrepareResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion',
    'bindable',
    'preparedAt',
    'group',
    'requiredInputs',
    'digests',
    'approval',
    'taskRevision',
    'promptBytes',
    'tokenEstimate',
  ]);
  if (object.bindable !== true) {
    malformed(operation, 'input_group_not_bindable');
  }
  if (!isIsoUtcDateTime(object.preparedAt)) {
    malformed(operation, 'input_group_time_invalid');
  }
  const group = requirePlain(operation, object.group);
  exactKeys(operation, group, ['snapshot', 'manifest', 'prompt']);
  if (!Array.isArray(object.requiredInputs)) {
    malformed(operation, 'input_refs_invalid');
  }
  const digests = requirePlain(operation, object.digests);
  exactKeys(operation, digests, [
    'snapshotDigest',
    'manifestDigest',
    'promptDigest',
    'strategyCopyDigest',
    'permissionsDigest',
  ]);
  const approval = requirePlain(operation, object.approval);
  exactKeys(operation, approval, [
    'planDigest',
    'checkPolicyDigest',
    'decisionId',
    'featureRevision',
  ]);
  if (
    approval.decisionId !== null &&
    (typeof approval.decisionId !== 'string' || approval.decisionId.length === 0)
  ) {
    malformed(operation, 'input_group_approval_invalid');
  }
  if (
    typeof object.promptBytes !== 'number' ||
    !Number.isSafeInteger(object.promptBytes) ||
    object.promptBytes < 0
  ) {
    malformed(operation, 'input_group_size_invalid');
  }
  const tokenEstimate = requirePlain(operation, object.tokenEstimate);
  exactKeys(operation, tokenEstimate, ['value', 'kind', 'method']);
  if (
    tokenEstimate.kind !== 'estimation' ||
    typeof tokenEstimate.value !== 'number' ||
    !Number.isSafeInteger(tokenEstimate.value) ||
    tokenEstimate.value < 0
  ) {
    malformed(operation, 'input_group_token_estimate_invalid');
  }
  return {
    schemaVersion: requirePositiveInteger(operation, object.schemaVersion),
    bindable: true,
    preparedAt: object.preparedAt,
    group: {
      snapshot: validateExecutionInputGroupBodyRefWire(operation, group.snapshot, 'snapshot'),
      manifest: validateExecutionInputGroupBodyRefWire(operation, group.manifest, 'manifest'),
      prompt: validateExecutionInputGroupBodyRefWire(operation, group.prompt, 'prompt'),
    },
    requiredInputs: (object.requiredInputs as unknown[]).map((item) =>
      validateExecutionInputRefWire(operation, item),
    ),
    digests: {
      snapshotDigest: requireSha256Hex(operation, digests.snapshotDigest, 'input_group_hash_invalid'),
      manifestDigest: requireSha256Hex(operation, digests.manifestDigest, 'input_group_hash_invalid'),
      promptDigest: requireSha256Hex(operation, digests.promptDigest, 'input_group_hash_invalid'),
      strategyCopyDigest: requireSha256Hex(
        operation,
        digests.strategyCopyDigest,
        'input_group_hash_invalid',
      ),
      permissionsDigest: requireSha256Hex(
        operation,
        digests.permissionsDigest,
        'input_group_hash_invalid',
      ),
    },
    approval: {
      planDigest: requireSha256Hex(operation, approval.planDigest, 'input_group_approval_invalid'),
      checkPolicyDigest: requireSha256Hex(
        operation,
        approval.checkPolicyDigest,
        'input_group_approval_invalid',
      ),
      decisionId: approval.decisionId as string | null,
      featureRevision: requirePositiveInteger(operation, approval.featureRevision),
    },
    taskRevision: requirePositiveInteger(operation, object.taskRevision),
    promptBytes: object.promptBytes,
    tokenEstimate: {
      value: tokenEstimate.value as number,
      kind: 'estimation',
      method: requireNonEmptyString(operation, tokenEstimate.method, 'input_group_token_estimate_invalid'),
    },
  };
}

/** features.approvals 查询响应（当前决定 vs 历史 + fail-closed validity）。 */
export function validateFeatureApprovalsResultWire(
  operation: HostOperation,
  body: unknown,
): FeatureApprovalsResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['feature', 'currentDecision', 'decisions', 'validity']);
  const currentDecision =
    object.currentDecision === null
      ? null
      : validatePlanApprovalDecisionWire(operation, object.currentDecision, {
          requireCurrent: true,
        });
  if (!Array.isArray(object.decisions)) {
    malformed(operation, 'approval_decisions_invalid');
  }
  const decisions = object.decisions.map((item) =>
    validatePlanApprovalDecisionWire(operation, item, { requireCurrent: false }),
  );
  // 同一主体同一身份至多一条当前决定（服务端契约；漂移即协议错误）。
  if (decisions.filter((decision) => decision.current).length > 1) {
    malformed(operation, 'approval_decisions_invalid');
  }
  return {
    feature: validateFeatureRecordWire(operation, object.feature),
    currentDecision,
    decisions,
    validity: validatePlanApprovalValidityWire(operation, object.validity),
  };
}

/* ------------------------------------------------------------------ *
 * 查询响应分发（§7.2/§8）
 * ------------------------------------------------------------------ */

/** getSnapshot 的期望 scope（响应 scope 必须与请求一致，防止错投）。 */
export interface SnapshotExpectation {
  readonly scope?: SettingsScope;
}

function scopeEquals(a: SettingsScope, b: SettingsScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'project' && b.kind === 'project') {
    return a.projectId === b.projectId;
  }
  return true;
}

function validateProjectListPage(operation: HostOperation, value: unknown): ProjectListResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'list_schema_version_invalid');
  }
  if (object.scope !== 'project-list') {
    malformed(operation, 'list_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'list_records_invalid');
  }
  const records = object.records.map((record) => validateProjectRecord(operation, record));
  if (object.nextCursor !== null && typeof object.nextCursor !== 'string') {
    malformed(operation, 'list_cursor_invalid');
  }
  const limit = requirePositiveInteger(operation, object.limit);
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'project-list',
    records,
    nextCursor: object.nextCursor,
    limit,
  };
}

function validateWatermark(
  operation: HostOperation,
  value: unknown,
): { readonly sequence: number; readonly cursor: string } {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['sequence', 'cursor']);
  if (
    typeof object.sequence !== 'number' ||
    !Number.isSafeInteger(object.sequence) ||
    object.sequence < 0
  ) {
    malformed(operation, 'watermark_sequence_invalid');
  }
  if (
    typeof object.cursor !== 'string' ||
    !object.cursor.startsWith(EVENT_CURSOR_PREFIX) ||
    !/^[A-Za-z0-9_-]+$/.test(object.cursor.slice(EVENT_CURSOR_PREFIX.length))
  ) {
    malformed(operation, 'watermark_cursor_invalid');
  }
  return { sequence: object.sequence, cursor: object.cursor };
}

function validateSnapshot(
  operation: HostOperation,
  value: unknown,
  expectation?: SnapshotExpectation,
): SnapshotResult {
  const object = requirePlain(operation, value);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'snapshot_schema_version_invalid');
  }
  const scopeValue = requirePlain(operation, object.scope);
  exactKeys(operation, scopeValue, ['kind', 'projectId']);
  const scope = validateScopeField(
    operation,
    scopeValue,
    scopeValue.kind === 'project' ? 'project' : 'global',
  );
  if (expectation?.scope !== undefined && !scopeEquals(scope, expectation.scope)) {
    malformed(operation, 'snapshot_scope_mismatch');
  }
  const watermark = validateWatermark(operation, object.watermark);
  if (!isIsoUtcDateTime(object.readAt)) {
    malformed(operation, 'snapshot_read_at_invalid');
  }
  if (scope.kind === 'global') {
    exactKeys(operation, object, ['schemaVersion', 'scope', 'settings', 'watermark', 'readAt']);
    const settings =
      object.settings === null ? null : validateSettingsState(operation, object.settings);
    return {
      schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
      scope,
      settings,
      watermark,
      readAt: object.readAt,
    };
  }
  exactKeys(operation, object, [
    'schemaVersion',
    'scope',
    'project',
    'binding',
    'settings',
    'effective',
    'watermark',
    'readAt',
  ]);
  const project = validateProjectRecord(operation, object.project);
  const binding =
    object.binding === null ? null : validateBindingRecord(operation, object.binding);
  const settings =
    object.settings === null ? null : validateSettingsState(operation, object.settings);
  const effective = validateEffectiveSettings(operation, object.effective);
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope,
    project,
    binding,
    settings,
    effective,
    watermark,
    readAt: object.readAt,
  };
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-006 静态接入查询响应（§7.2/§7.3；线消息 v3）
 * ------------------------------------------------------------------ */

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function requireOnboardingSchemaVersion(
  operation: HostOperation,
  value: unknown,
): void {
  if (value === ONBOARDING_QUERY_SCHEMA_VERSION) {
    return;
  }
  if (typeof value === 'number') {
    unsupportedVersion(operation, 'schemaVersion');
  }
  malformed(operation, 'onboarding_schema_version_invalid');
}

/** §7.2 projects.inspect 响应：只读仓库事实 + 既有项目身份，永不包含文件内容。 */
function validateProjectInspection(
  operation: HostOperation,
  body: unknown,
): ProjectInspectionResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, [
    'schemaVersion',
    'canonicalPath',
    'repoIdentity',
    'headCommit',
    'hasInitialCommit',
    'hasUncommittedChanges',
    'alreadyRegistered',
    'readAt',
  ]);
  requireOnboardingSchemaVersion(operation, object.schemaVersion);
  if (
    typeof object.canonicalPath !== 'string' ||
    object.canonicalPath.length === 0 ||
    object.canonicalPath.includes('\u0000')
  ) {
    malformed(operation, 'inspection_path_invalid');
  }
  if (
    typeof object.repoIdentity !== 'string' ||
    object.repoIdentity.length === 0
  ) {
    malformed(operation, 'inspection_repo_identity_invalid');
  }
  if (
    object.headCommit !== null &&
    (typeof object.headCommit !== 'string' || !COMMIT_ID_PATTERN.test(object.headCommit))
  ) {
    malformed(operation, 'inspection_head_invalid');
  }
  if (typeof object.hasInitialCommit !== 'boolean' || typeof object.hasUncommittedChanges !== 'boolean') {
    malformed(operation, 'inspection_flags_invalid');
  }
  let alreadyRegistered: { readonly projectId: string } | null = null;
  if (object.alreadyRegistered !== null) {
    const record = requirePlain(operation, object.alreadyRegistered);
    exactKeys(operation, record, ['projectId']);
    alreadyRegistered = { projectId: requireStableId(operation, record.projectId) };
  }
  if (!isIsoUtcDateTime(object.readAt)) {
    malformed(operation, 'inspection_read_at_invalid');
  }
  return {
    schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
    canonicalPath: object.canonicalPath,
    repoIdentity: object.repoIdentity,
    headCommit: object.headCommit,
    hasInitialCommit: object.hasInitialCommit,
    hasUncommittedChanges: object.hasUncommittedChanges,
    alreadyRegistered,
    readAt: object.readAt,
  };
}

const REGISTRATION_STATUSES = ['registered', 'not_registered'] as const;
const HEALTH_STATUSES = ['healthy', 'unhealthy', 'not_run'] as const;

/** §7.3 projects.overview 响应：注册状态与健康状态严格分开。 */
function validateProjectOverview(
  operation: HostOperation,
  body: unknown,
): ProjectOverviewResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, [
    'schemaVersion',
    'project',
    'binding',
    'registration',
    'settings',
    'health',
    'readAt',
  ]);
  requireOnboardingSchemaVersion(operation, object.schemaVersion);
  const project = validateProjectRecord(operation, object.project);
  const binding =
    object.binding === null ? null : validateBindingRecord(operation, object.binding);
  const registration = requirePlain(operation, object.registration);
  exactKeys(operation, registration, ['status']);
  if (!REGISTRATION_STATUSES.includes(registration.status as (typeof REGISTRATION_STATUSES)[number])) {
    malformed(operation, 'overview_registration_status_invalid');
  }
  const settingsRecord = requirePlain(operation, object.settings);
  let settings: ProjectSettingsPresence;
  if (settingsRecord.configured === false) {
    exactKeys(operation, settingsRecord, ['configured']);
    settings = { configured: false };
  } else if (settingsRecord.configured === true) {
    exactKeys(operation, settingsRecord, ['configured', 'revision', 'schemaVersion']);
    settings = {
      configured: true,
      revision: requirePositiveInteger(operation, settingsRecord.revision),
      schemaVersion: settingsRecord.schemaVersion as number,
    };
  } else {
    malformed(operation, 'overview_settings_invalid');
  }
  const healthRecord = requirePlain(operation, object.health);
  let health: ProjectHealthSummary;
  const healthKeys = Object.keys(healthRecord);
  if (
    !healthKeys.every((key) => ['status', 'lastBaselineOperationId', 'lastCompletedAt', 'reasonCode'].includes(key)) ||
    healthKeys.length < 3
  ) {
    malformed(operation, 'overview_health_invalid');
  }
  if (!HEALTH_STATUSES.includes(healthRecord.status as (typeof HEALTH_STATUSES)[number])) {
    malformed(operation, 'overview_health_status_invalid');
  }
  if (
    (healthRecord.lastBaselineOperationId !== null && typeof healthRecord.lastBaselineOperationId !== 'string') ||
    (healthRecord.lastCompletedAt !== null && typeof healthRecord.lastCompletedAt !== 'string')
  ) {
    malformed(operation, 'overview_health_invalid');
  }
  if (
    healthRecord.reasonCode !== undefined &&
    typeof healthRecord.reasonCode !== 'string'
  ) {
    malformed(operation, 'overview_health_invalid');
  }
  health = {
    status: healthRecord.status as ProjectHealthSummary['status'],
    lastBaselineOperationId: healthRecord.lastBaselineOperationId as string | null,
    lastCompletedAt: healthRecord.lastCompletedAt as string | null,
    ...(healthRecord.reasonCode !== undefined
      ? { reasonCode: healthRecord.reasonCode as ProjectHealthSummary['reasonCode'] }
      : {}),
  };
  if (!isIsoUtcDateTime(object.readAt)) {
    malformed(operation, 'overview_read_at_invalid');
  }
  return {
    schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
    project,
    binding,
    registration: { status: registration.status as 'registered' | 'not_registered' },
    settings,
    health,
    readAt: object.readAt,
  };
}

/* ------------------------------------------------------------------ *
 * P02-3 / F-014 基线查询与命令结果响应（§7.4/§7.5/§6；线消息 v3）
 * ------------------------------------------------------------------ */

function requireNonNegativeInteger(operation: HostOperation, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(operation, 'invalid_revision');
  }
  return value;
}

/** §7.4 操作摘要（计数经逐项把关；reasonCode 为可选键）。 */
function validateBaselineOperationSummaryWire(
  operation: HostOperation,
  value: unknown,
): BaselineOperationSummary {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'operationId',
    'kind',
    'status',
    'reasonCode',
    'createdAt',
    'startedAt',
    'endedAt',
    'summary',
  ]);
  if (!isUuidV4(object.operationId)) {
    malformed(operation, 'baseline_operation_id_invalid');
  }
  if (object.kind !== 'baseline') {
    malformed(operation, 'baseline_kind_invalid');
  }
  if (
    typeof object.status !== 'string' ||
    !(BASELINE_OPERATION_STATUSES as readonly string[]).includes(object.status)
  ) {
    malformed(operation, 'baseline_status_invalid');
  }
  if (
    object.reasonCode !== undefined &&
    (typeof object.reasonCode !== 'string' ||
      !(BASELINE_REASON_CODES as readonly string[]).includes(object.reasonCode))
  ) {
    malformed(operation, 'baseline_reason_code_invalid');
  }
  if (!isIsoUtcDateTime(object.createdAt)) {
    malformed(operation, 'baseline_time_invalid');
  }
  if (
    (object.startedAt !== null && !isIsoUtcDateTime(object.startedAt)) ||
    (object.endedAt !== null && !isIsoUtcDateTime(object.endedAt))
  ) {
    malformed(operation, 'baseline_time_invalid');
  }
  const summary = validateBaselineCountsPayload(operation, object.summary);
  return {
    operationId: object.operationId,
    kind: 'baseline',
    status: object.status as BaselineOperationSummary['status'],
    ...(object.reasonCode !== undefined
      ? { reasonCode: object.reasonCode as BaselineOperationSummary['reasonCode'] }
      : {}),
    createdAt: object.createdAt,
    startedAt: object.startedAt as string | null,
    endedAt: object.endedAt as string | null,
    summary,
  };
}

/** §7.5 逐项检查明细（output 引用与 tail 是脱敏尾部视图，不携带路径/环境值）。 */
function validateBaselineCheckResultWire(
  operation: HostOperation,
  value: unknown,
): BaselineCheckResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'checkKey',
    'argv',
    'cwdRef',
    'environmentRef',
    'timeoutMs',
    'required',
    'status',
    'reasonCode',
    'exitCode',
    'signal',
    'timedOut',
    'output',
    'tail',
    'startedAt',
    'endedAt',
    'durationMs',
  ]);
  if (typeof object.checkKey !== 'string' || !CHECK_KEY_PATTERN.test(object.checkKey)) {
    malformed(operation, 'baseline_check_key_invalid');
  }
  if (
    !Array.isArray(object.argv) ||
    object.argv.length === 0 ||
    !object.argv.every((arg) => typeof arg === 'string')
  ) {
    malformed(operation, 'baseline_argv_invalid');
  }
  if (
    (object.cwdRef !== null && typeof object.cwdRef !== 'string') ||
    (object.environmentRef !== null && typeof object.environmentRef !== 'string')
  ) {
    malformed(operation, 'baseline_check_ref_invalid');
  }
  if (
    typeof object.timeoutMs !== 'number' ||
    !Number.isSafeInteger(object.timeoutMs) ||
    object.timeoutMs < 1
  ) {
    malformed(operation, 'baseline_timeout_invalid');
  }
  if (typeof object.required !== 'boolean' || typeof object.timedOut !== 'boolean') {
    malformed(operation, 'baseline_check_flags_invalid');
  }
  if (
    typeof object.status !== 'string' ||
    !(BASELINE_CHECK_STATUSES as readonly string[]).includes(object.status)
  ) {
    malformed(operation, 'baseline_check_status_invalid');
  }
  if (
    object.reasonCode !== undefined &&
    (typeof object.reasonCode !== 'string' ||
      !(BASELINE_REASON_CODES as readonly string[]).includes(object.reasonCode))
  ) {
    malformed(operation, 'baseline_reason_code_invalid');
  }
  if (
    (object.exitCode !== null &&
      (typeof object.exitCode !== 'number' || !Number.isSafeInteger(object.exitCode))) ||
    (object.signal !== null && typeof object.signal !== 'string') ||
    (object.durationMs !== null &&
      (typeof object.durationMs !== 'number' ||
        !Number.isSafeInteger(object.durationMs) ||
        object.durationMs < 0))
  ) {
    malformed(operation, 'baseline_check_result_fields_invalid');
  }
  let output: BaselineCheckOutputRef | null = null;
  if (object.output !== null) {
    const ref = requirePlain(operation, object.output);
    exactKeys(operation, ref, ['artifactId', 'byteSize', 'truncated']);
    output = {
      artifactId: requireStableId(operation, ref.artifactId),
      byteSize: requireNonNegativeInteger(operation, ref.byteSize),
      truncated: typeof ref.truncated === 'boolean' ? ref.truncated : malformed(operation, 'baseline_output_ref_invalid'),
    };
  }
  if (
    object.tail !== null &&
    (typeof object.tail !== 'string' ||
      Buffer.byteLength(object.tail, 'utf8') > BASELINE_CHECK_TAIL_MAX_BYTES)
  ) {
    malformed(operation, 'baseline_tail_invalid');
  }
  if (
    (object.startedAt !== null && !isIsoUtcDateTime(object.startedAt)) ||
    (object.endedAt !== null && !isIsoUtcDateTime(object.endedAt))
  ) {
    malformed(operation, 'baseline_time_invalid');
  }
  return {
    checkKey: object.checkKey,
    argv: [...(object.argv as string[])],
    cwdRef: object.cwdRef as string | null,
    environmentRef: object.environmentRef as string | null,
    timeoutMs: object.timeoutMs,
    required: object.required,
    status: object.status as BaselineCheckResult['status'],
    ...(object.reasonCode !== undefined
      ? { reasonCode: object.reasonCode as BaselineCheckResult['reasonCode'] }
      : {}),
    exitCode: object.exitCode as number | null,
    signal: object.signal as string | null,
    timedOut: object.timedOut,
    output,
    tail: object.tail as string | null,
    startedAt: object.startedAt as string | null,
    endedAt: object.endedAt as string | null,
    durationMs: object.durationMs as number | null,
  };
}

/** §6.2 授权摘要：复用 Core 校验器（同一权威），形状违反 → response_malformed。 */
function validateAuthorizationSummaryWire(
  operation: HostOperation,
  value: unknown,
): BaselineAuthorizationSummary {
  try {
    return validateBaselineAuthorizationSummary(value, operation);
  } catch {
    malformed(operation, 'baseline_authorization_invalid');
  }
}

function validateBaselineListPage(operation: HostOperation, body: unknown): BaselineListResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'projectId', 'records', 'nextCursor', 'limit']);
  requireOnboardingSchemaVersion(operation, object.schemaVersion);
  const projectId = requireStableId(operation, object.projectId);
  if (!Array.isArray(object.records)) {
    malformed(operation, 'baseline_records_invalid');
  }
  const records = object.records.map((record) =>
    validateBaselineOperationSummaryWire(operation, record),
  );
  if (object.nextCursor !== null && !isUuidV4(object.nextCursor)) {
    malformed(operation, 'baseline_cursor_invalid');
  }
  const limit = requirePositiveInteger(operation, object.limit);
  return {
    schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
    projectId,
    records,
    nextCursor: object.nextCursor,
    limit,
  };
}

function validateBaselineDetail(operation: HostOperation, body: unknown): BaselineDetailResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'operation', 'authorization', 'checks']);
  requireOnboardingSchemaVersion(operation, object.schemaVersion);
  const summary = validateBaselineOperationSummaryWire(operation, object.operation);
  const authorization =
    object.authorization === null
      ? null
      : validateAuthorizationSummaryWire(operation, object.authorization);
  if (!Array.isArray(object.checks)) {
    malformed(operation, 'baseline_checks_invalid');
  }
  const checks = object.checks.map((check) => validateBaselineCheckResultWire(operation, check));
  return {
    schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
    operation: summary,
    authorization,
    checks,
  };
}

/**
 * §6 baseline.preview 回执内嵌 result（completed 时）：预览摘要形状把关。
 * 只在 completed 回执上调用；返回已校验的预览结果。
 */
export function validateBaselinePreviewResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): BaselinePreviewResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'previewDigest',
    'policyRevision',
    'repositoryBindingId',
    'repositoryBindingRevision',
    'bindingRecordRevision',
    'codeIdentity',
    'dirtyScope',
    'environmentIdentity',
    'workspace',
    'checks',
    'warnings',
  ]);
  if (
    typeof object.previewDigest !== 'string' ||
    !SHA256_HEX_PATTERN.test(object.previewDigest) ||
    typeof object.policyRevision !== 'string' ||
    !SHA256_HEX_PATTERN.test(object.policyRevision)
  ) {
    malformed(operation, 'preview_digest_invalid');
  }
  if (
    typeof object.repositoryBindingId !== 'string' ||
    !isUuidV4(object.repositoryBindingId) ||
    typeof object.repositoryBindingRevision !== 'number' ||
    !Number.isSafeInteger(object.repositoryBindingRevision) ||
    object.repositoryBindingRevision < 1 ||
    typeof object.bindingRecordRevision !== 'number' ||
    !Number.isSafeInteger(object.bindingRecordRevision) ||
    object.bindingRecordRevision < 1
  ) {
    malformed(operation, 'preview_binding_identity_invalid');
  }
  let dirtyScope: BaselinePreviewResult['dirtyScope'];
  let environmentIdentity: BaselinePreviewResult['environmentIdentity'];
  try {
    dirtyScope = validateBaselineDirtyScope(object.dirtyScope, operation, 'dirtyScope');
    environmentIdentity = validateBaselineEnvironmentIdentity(object.environmentIdentity, operation, 'environmentIdentity');
  } catch {
    malformed(operation, 'preview_environment_identity_invalid');
  }
  const codeIdentity = requirePlain(operation, object.codeIdentity);
  exactKeys(operation, codeIdentity, ['headCommit', 'workingTreeDigest', 'hasUncommittedChanges']);
  if (
    (codeIdentity.headCommit !== null &&
      (typeof codeIdentity.headCommit !== 'string' ||
        !COMMIT_ID_PATTERN.test(codeIdentity.headCommit))) ||
    typeof codeIdentity.workingTreeDigest !== 'string' ||
    !SHA256_HEX_PATTERN.test(codeIdentity.workingTreeDigest) ||
    typeof codeIdentity.hasUncommittedChanges !== 'boolean'
  ) {
    malformed(operation, 'preview_code_identity_invalid');
  }
  const workspace = requirePlain(operation, object.workspace);
  exactKeys(operation, workspace, ['excludedDirNames', 'fileCount']);
  if (
    !Array.isArray(workspace.excludedDirNames) ||
    !workspace.excludedDirNames.every((name) => typeof name === 'string') ||
    typeof workspace.fileCount !== 'number' ||
    !Number.isSafeInteger(workspace.fileCount) ||
    workspace.fileCount < 0
  ) {
    malformed(operation, 'preview_workspace_invalid');
  }
  if (!Array.isArray(object.checks)) {
    malformed(operation, 'preview_checks_invalid');
  }
  const checks = object.checks.map((item) => {
    const check = requirePlain(operation, item);
    exactKeys(operation, check, [
      'checkKey',
      'kind',
      'argv',
      'cwdRef',
      'cwd',
      'environmentRef',
      'allowedVariables',
      'timeoutMs',
      'required',
    ]);
    if (
      typeof check.checkKey !== 'string' ||
      !CHECK_KEY_PATTERN.test(check.checkKey) ||
      check.kind !== 'command' ||
      !Array.isArray(check.argv) ||
      check.argv.length === 0 ||
      !check.argv.every((arg) => typeof arg === 'string') ||
      (check.cwdRef !== null && typeof check.cwdRef !== 'string') ||
      typeof check.cwd !== 'string' ||
      !check.cwd.startsWith('/') ||
      (check.environmentRef !== null && typeof check.environmentRef !== 'string') ||
      !Array.isArray(check.allowedVariables) ||
      !check.allowedVariables.every((name) => typeof name === 'string') ||
      typeof check.timeoutMs !== 'number' ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      typeof check.required !== 'boolean'
    ) {
      malformed(operation, 'preview_check_invalid');
    }
    return check as unknown as BaselinePreviewResult['checks'][number];
  });
  if (!Array.isArray(object.warnings)) {
    malformed(operation, 'preview_warnings_invalid');
  }
  const warnings = object.warnings.map((item) => {
    const warning = requirePlain(operation, item);
    exactKeys(operation, warning, ['code', 'checkKey']);
    if (
      typeof warning.code !== 'string' ||
      !(BASELINE_PREVIEW_WARNING_CODES as readonly string[]).includes(warning.code) ||
      (warning.checkKey !== undefined && typeof warning.checkKey !== 'string')
    ) {
      malformed(operation, 'preview_warning_invalid');
    }
    return warning as unknown as BaselinePreviewResult['warnings'][number];
  });
  return {
    previewDigest: object.previewDigest,
    policyRevision: object.policyRevision,
    repositoryBindingId: object.repositoryBindingId,
    repositoryBindingRevision: object.repositoryBindingRevision,
    bindingRecordRevision: object.bindingRecordRevision,
    codeIdentity: codeIdentity as unknown as BaselinePreviewResult['codeIdentity'],
    dirtyScope,
    environmentIdentity,
    workspace: workspace as unknown as BaselinePreviewResult['workspace'],
    checks,
    warnings,
  };
}

/**
 * §6 baseline.run decline / baseline.cancel 的 completed 回执内嵌 result：
 * {operationId, status, reasonCode?}（取消/拒绝结果只含身份与三轴状态）。
 */
export function validateBaselineCommandResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): { readonly operationId: string; readonly status: string; readonly reasonCode?: string } {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['operationId', 'status', 'reasonCode']);
  if (!isUuidV4(object.operationId)) {
    malformed(operation, 'baseline_operation_id_invalid');
  }
  if (
    typeof object.status !== 'string' ||
    !(BASELINE_OPERATION_STATUSES as readonly string[]).includes(object.status)
  ) {
    malformed(operation, 'baseline_status_invalid');
  }
  if (
    object.reasonCode !== undefined &&
    (typeof object.reasonCode !== 'string' ||
      !(BASELINE_REASON_CODES as readonly string[]).includes(object.reasonCode))
  ) {
    malformed(operation, 'baseline_reason_code_invalid');
  }
  return {
    operationId: object.operationId,
    status: object.status,
    ...(object.reasonCode !== undefined ? { reasonCode: object.reasonCode } : {}),
  };
}

function executionFeatureIdsWire(operation: HostOperation, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) malformed(operation, 'execution_feature_scope_invalid');
  const ids = value.map(id => requireStableId(operation, id));
  if (new Set(ids).size !== ids.length) malformed(operation, 'execution_feature_scope_invalid');
  return ids;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every(id => right.includes(id));
}

function validateExecutionPreviewMembershipWire(
  operation: HostOperation,
  scope: Record<string, unknown>,
  summary: Record<string, unknown>,
  expanded: boolean,
): void {
  const ids = scope.featureIds as string[];
  if (expanded && !Array.isArray(summary.members)) malformed(operation, 'execution_preview_members_invalid');
  const members = (summary.members as unknown[] | undefined)?.map(value => requirePlain(operation, value));
  if (members !== undefined) {
    if (!sameIds(ids, members.map(member => member.featureId as string))) malformed(operation, 'execution_preview_members_invalid');
    for (const member of members) {
      const identity = (scope.members as Record<string, unknown>[] | undefined)?.find(row => row.featureId === member.featureId);
      if (identity !== undefined && (identity.revision !== member.revision || identity.planDigest !== member.planDigest)) malformed(operation, 'execution_preview_members_invalid');
      const readiness = requirePlain(operation, member.readiness);
      if (readiness.featureId !== member.featureId ||
          !['complete', 'pending', 'failed'].includes(readiness.dependencyCompletion as string) ||
          !['ready', 'dependency_pending', 'dependency_failed', 'integration_not_ready', 'invalid_graph'].includes(readiness.reason as string) ||
          readiness.dependencyCompleted !== (readiness.dependencyCompletion === 'complete') ||
          readiness.ready !== (readiness.dependencyCompleted && readiness.dependencyIntegrationReady)) malformed(operation, 'execution_preview_members_invalid');
    }
  }
  const tasks = (summary.tasks as unknown[]).map(value => requirePlain(operation, value));
  const permissions = (requirePlain(operation, summary.permissions).tasks as unknown[]).map(value => requirePlain(operation, value));
  const key = (row: Record<string, unknown>): string => {
    if ((ids.length > 1 && row.featureId === undefined) || (row.featureId !== undefined && !ids.includes(row.featureId as string))) malformed(operation, 'execution_preview_members_invalid');
    return `${row.featureId ?? ids[0]}\u0000${row.taskId}`;
  };
  if (!sameIds(tasks.map(key), permissions.map(key))) malformed(operation, 'execution_preview_members_invalid');
  const plan = requirePlain(operation, summary.plan);
  const approval = requirePlain(operation, summary.approval);
  if (plan.taskCount !== tasks.length || plan.planDigest !== approval.planDigest || approval.checkPolicyDigest !== summary.checkPolicyDigest) malformed(operation, 'execution_preview_members_invalid');
  const pending = tasks.filter(task => task.status === 'pending' || task.status === 'failed').map(task => task.taskId as string).sort();
  if (pending.length === 0) malformed(operation, 'execution_preview_members_invalid');
  if (JSON.stringify(pending) !== JSON.stringify([...(plan.pendingTaskIds as string[])].sort())) malformed(operation, 'execution_preview_members_invalid');
  if (members !== undefined) for (const member of members) {
    const own = tasks.filter(task => (task.featureId ?? ids[0]) === member.featureId);
    const ownPending = own.filter(task => task.status === 'pending' || task.status === 'failed').map(task => task.taskId as string).sort();
    if (member.taskCount !== own.length || JSON.stringify(ownPending) !== JSON.stringify([...(member.pendingTaskIds as string[])].sort())) malformed(operation, 'execution_preview_members_invalid');
  }
}

function validateExecutionPreviewSummaryWire(operation: HostOperation, value: unknown): void {
  const summary = requirePlain(operation, value);
  exactKeys(operation, summary, ['members', 'approval', 'plan', 'code', 'checkPolicyDigest', 'tasks', 'permissions', 'inputs', 'budget', 'concurrency']);
  if (summary.members !== undefined) {
    if (!Array.isArray(summary.members)) malformed(operation, 'execution_preview_members_invalid');
    for (const value of summary.members) {
      const member = requirePlain(operation, value);
      exactKeys(operation, member, ['featureId', 'revision', 'planDigest', 'planStatus', 'status', 'readiness', 'codeBaselineRefs', 'dependencyFeatureIds', 'taskCount', 'pendingTaskIds']);
      requireStableId(operation, member.featureId);
      requirePositiveInteger(operation, member.revision);
      if (member.planDigest !== null) requireSha256Hex(operation, member.planDigest, 'execution_preview_digest_invalid');
      if (!(FEATURE_PLAN_STATUSES as readonly unknown[]).includes(member.planStatus) ||
          !(FEATURE_STATUSES as readonly unknown[]).includes(member.status)) malformed(operation, 'execution_preview_member_invalid');
      if (!Array.isArray(member.codeBaselineRefs) || !member.codeBaselineRefs.every((ref) => typeof ref === 'string') ||
          (member.dependencyFeatureIds !== undefined && (!Array.isArray(member.dependencyFeatureIds) || !member.dependencyFeatureIds.every((id) => typeof id === 'string')))) malformed(operation, 'execution_preview_member_invalid');
      requireNonNegativeInteger(operation, member.taskCount);
      if (!Array.isArray(member.pendingTaskIds)) malformed(operation, 'execution_preview_member_invalid');
      for (const id of member.pendingTaskIds) requireStableId(operation, id);
      const readiness = requirePlain(operation, member.readiness);
      exactKeys(operation, readiness, ['featureId', 'dependencyCompleted', 'dependencyCompletion', 'integrationReady', 'dependencyIntegrationReady', 'ready', 'reason']);
      requireStableId(operation, readiness.featureId);
      for (const key of ['dependencyCompleted', 'integrationReady', 'dependencyIntegrationReady', 'ready']) {
        if (typeof readiness[key] !== 'boolean') malformed(operation, 'execution_preview_member_invalid');
      }
      requireNonEmptyString(operation, readiness.dependencyCompletion, 'execution_preview_member_invalid');
      requireNonEmptyString(operation, readiness.reason, 'execution_preview_member_invalid');
    }
  }
  const hash = (value: unknown): void => { requireSha256Hex(operation, value, 'execution_preview_digest_invalid'); };
  const text = (value: unknown): void => { requireNonEmptyString(operation, value, 'execution_preview_text_invalid'); };
  const rows = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) malformed(operation, 'execution_preview_rows_invalid');
    return value;
  };
  const approval = requirePlain(operation, summary.approval);
  exactKeys(operation, approval, ['planDigest', 'checkPolicyDigest', 'decisionId']);
  hash(approval.planDigest);
  hash(approval.checkPolicyDigest);
  if (approval.decisionId !== null) requireStableId(operation, approval.decisionId);
  hash(summary.checkPolicyDigest);
  const plan = requirePlain(operation, summary.plan);
  exactKeys(operation, plan, ['planDigest', 'taskCount', 'pendingTaskIds']);
  if (plan.planDigest !== null) hash(plan.planDigest);
  requireNonNegativeInteger(operation, plan.taskCount);
  for (const id of rows(plan.pendingTaskIds)) requireStableId(operation, id);
  const code = requirePlain(operation, summary.code);
  exactKeys(operation, code, ['headCommit', 'workingTreeDigest', 'hasUncommittedChanges']);
  if (code.headCommit !== null && (typeof code.headCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(code.headCommit))) {
    malformed(operation, 'execution_preview_commit_invalid');
  }
  hash(code.workingTreeDigest);
  if (typeof code.hasUncommittedChanges !== 'boolean') malformed(operation, 'execution_preview_code_invalid');
  const tasks = rows(summary.tasks);
  for (const value of tasks) {
    const task = requirePlain(operation, value);
    exactKeys(operation, task, ['taskId', 'featureId', 'status', 'strategyCopyDigest', 'strategyConfigSource']);
    if (task.featureId !== undefined) requireStableId(operation, task.featureId);
    requireStableId(operation, task.taskId);
    if (!(TASK_STATUSES as readonly unknown[]).includes(task.status)) malformed(operation, 'execution_preview_task_invalid');
    hash(task.strategyCopyDigest);
    text(task.strategyConfigSource);
  }
  const permissions = requirePlain(operation, summary.permissions);
  exactKeys(operation, permissions, ['tasks']);
  for (const value of rows(permissions.tasks)) {
    const task = requirePlain(operation, value);
    exactKeys(operation, task, ['taskId', 'featureId', 'digest']);
    if (task.featureId !== undefined) requireStableId(operation, task.featureId);
    requireStableId(operation, task.taskId);
    hash(task.digest);
  }
  const inputs = requirePlain(operation, summary.inputs);
  exactKeys(operation, inputs, ['refs']);
  for (const value of rows(inputs.refs)) {
    const ref = requirePlain(operation, value);
    exactKeys(operation, ref, ['artifactId', 'version', 'contentHash', 'sizeBytes']);
    requireStableId(operation, ref.artifactId);
    requirePositiveInteger(operation, ref.version);
    hash(ref.contentHash);
    requireNonNegativeInteger(operation, ref.sizeBytes);
  }
  try {
    validateExecutionBudgetProposal(summary.budget, { operation: `${operation}.preview.budget` });
  } catch {
    malformed(operation, 'execution_preview_budget_invalid');
  }
  const concurrency = requirePlain(operation, summary.concurrency);
  exactKeys(operation, concurrency, ['maxConcurrentWorks', 'source']);
  if (concurrency.maxConcurrentWorks !== 1) malformed(operation, 'execution_preview_concurrency_invalid');
  text(concurrency.source);
}

function validateExecutionPreviewBlockerWire(operation: HostOperation, value: unknown): void {
  const row = requirePlain(operation, value);
  const fields: Record<string, readonly string[]> = {
    plan_approval: ['kind', 'reason', 'featureId'], project_not_active: ['kind', 'status', 'featureId'],
    phase_not_executable: ['kind', 'status', 'featureId'], active_run: ['kind', 'runId', 'status', 'featureId'],
    active_batch_in_phase: ['kind', 'batchId', 'featureId', 'status'],
    baseline_occupancy: ['kind', 'holderOperationId', 'featureId'],
    required_input_unavailable: ['kind', 'artifactId', 'detail', 'featureId'],
    feature_dependency: ['kind', 'featureId', 'reason'], feature_integration: ['kind', 'featureId', 'reason'],
  };
  const requiredFields: Record<string, readonly string[]> = {
    plan_approval: ['kind', 'reason'], project_not_active: ['kind', 'status'],
    phase_not_executable: ['kind', 'status'], active_run: ['kind', 'runId', 'status'],
    active_batch_in_phase: ['kind', 'batchId', 'featureId', 'status'],
    baseline_occupancy: ['kind', 'holderOperationId'], required_input_unavailable: ['kind', 'artifactId', 'detail'],
    feature_dependency: ['kind', 'featureId', 'reason'], feature_integration: ['kind', 'featureId', 'reason'],
  };
  if (typeof row.kind !== 'string' || !Object.hasOwn(fields, row.kind)) malformed(operation, 'execution_preview_blocked_invalid');
  exactKeys(operation, row, fields[row.kind]!);
  for (const key of requiredFields[row.kind]!) {
    if (key.endsWith('Id')) requireStableId(operation, row[key]);
    else requireNonEmptyString(operation, row[key], 'execution_preview_blocked_invalid');
  }
  if (row.featureId !== undefined && !['feature_dependency', 'feature_integration'].includes(row.kind as string)) {
    requireStableId(operation, row.featureId);
  }
  if (row.kind === 'required_input_unavailable' && !['not_found', 'not_ready', 'content_mismatch'].includes(row.detail as string)) {
    malformed(operation, 'execution_preview_blocked_invalid');
  }
}

export function validateExecutionPreviewResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): ExecutionPreviewResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion', 'projectId', 'scope', 'status', 'noWorkReason', 'blocked',
    'previewDigest', 'summary', 'runtimeExecution', 'generatedAtUtcMs',
  ]);
  if (object.schemaVersion !== 1) unsupportedVersion(operation, 'result.schemaVersion');
  requireStableId(operation, object.projectId);
  const scope = requirePlain(operation, object.scope);
  exactKeys(operation, scope, ['featureIds', 'phaseId', 'phaseRevision', 'requestedFeatureIds', 'memberFeatureIds', 'members']);
  const featureIds = executionFeatureIdsWire(operation, scope.featureIds);
  const expandedScope = Object.keys(scope).some(key => key !== 'featureIds');
  if (expandedScope) {
    requireStableId(operation, scope.phaseId);
    if (scope.phaseRevision !== undefined) requirePositiveInteger(operation, scope.phaseRevision);
    const requested = executionFeatureIdsWire(operation, scope.requestedFeatureIds);
    const members = executionFeatureIdsWire(operation, scope.memberFeatureIds);
    if (!sameIds(featureIds, members) || requested.some(id => !members.includes(id)) || !Array.isArray(scope.members)) malformed(operation, 'execution_preview_scope_invalid');
    const identities = scope.members.map(value => {
      const member = requirePlain(operation, value);
      exactKeys(operation, member, ['featureId', 'revision', 'planDigest']);
      requireStableId(operation, member.featureId);
      requirePositiveInteger(operation, member.revision);
      if (member.planDigest !== null) requireSha256Hex(operation, member.planDigest, 'execution_preview_digest_invalid');
      return member.featureId as string;
    });
    if (!sameIds(featureIds, identities)) malformed(operation, 'execution_preview_scope_invalid');
  } else if (featureIds.length > 1) {
    malformed(operation, 'execution_preview_scope_invalid');
  }
  if (object.status !== 'ready' && object.status !== 'no_work' && object.status !== 'blocked') {
    malformed(operation, 'execution_preview_status_invalid');
  }
  if (object.noWorkReason !== null && object.noWorkReason !== 'empty_scope' && object.noWorkReason !== 'no_pending_tasks') {
    malformed(operation, 'execution_preview_no_work_reason_invalid');
  }
  if (!Array.isArray(object.blocked)) malformed(operation, 'execution_preview_blocked_invalid');
  for (const reason of object.blocked) {
    validateExecutionPreviewBlockerWire(operation, reason);
    const row = reason as Record<string, unknown>;
    if (row.featureId !== undefined && !featureIds.includes(row.featureId as string)) malformed(operation, 'execution_preview_scope_invalid');
  }
  if (object.previewDigest !== null) requireSha256Hex(operation, object.previewDigest, 'execution_preview_digest_invalid');
  if (object.summary !== null) {
    validateExecutionPreviewSummaryWire(operation, object.summary);
    validateExecutionPreviewMembershipWire(operation, scope, requirePlain(operation, object.summary), expandedScope);
  }
  if (object.runtimeExecution !== false || typeof object.generatedAtUtcMs !== 'number' || !Number.isSafeInteger(object.generatedAtUtcMs) || object.generatedAtUtcMs < 0) {
    malformed(operation, 'execution_preview_runtime_invalid');
  }
  if (object.status === 'ready' && (object.previewDigest === null || object.summary === null || object.noWorkReason !== null || object.blocked.length !== 0 || featureIds.length === 0)) {
    malformed(operation, 'execution_preview_ready_invariant');
  }
  if (object.status !== 'ready' && (object.previewDigest !== null || object.summary !== null)) {
    malformed(operation, 'execution_preview_non_ready_invariant');
  }
  if (object.status === 'blocked' && (object.blocked.length === 0 || object.noWorkReason !== null || featureIds.length === 0)) {
    malformed(operation, 'execution_preview_blocked_invariant');
  }
  if (object.status === 'no_work' && (object.noWorkReason === null || object.blocked.length !== 0 || (object.noWorkReason === 'empty_scope') !== (featureIds.length === 0))) {
    malformed(operation, 'execution_preview_no_work_invariant');
  }
  return object as unknown as ExecutionPreviewResult;
}

function validateBudgetSnapshot(operation: HostOperation, value: unknown, field: string): void {
  const snapshot = requirePlain(operation, value);
  exactKeys(operation, snapshot, ['schemaVersion', 'batch', 'run']);
  if (snapshot.schemaVersion !== 1) unsupportedVersion(operation, `${field}.schemaVersion`);
  try {
    validateExecutionBudgetProposal(
      { batch: snapshot.batch, run: snapshot.run },
      { operation: `${operation}.${field}` },
    );
  } catch {
    malformed(operation, 'execution_budget_snapshot_invalid');
  }
}

function validateExecutionBudgetCommon(
  operation: HostOperation,
  value: unknown,
  expectedScope: string,
  keys: readonly string[],
): Record<string, unknown> {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, keys);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) unsupportedVersion(operation, 'result.schemaVersion');
  if (object.scope !== expectedScope) malformed(operation, 'execution_budget_scope_invalid');
  return object;
}

function budgetNumber(operation: HostOperation, value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) malformed(operation, 'execution_budget_number_invalid');
}

function budgetDate(operation: HostOperation, value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (!isIsoUtcDateTime(value)) malformed(operation, 'execution_budget_date_invalid');
}

function budgetDimensions(operation: HostOperation, value: unknown, keys: readonly string[], optional: readonly string[] = []): void {
  const dimensions = requirePlain(operation, value);
  exactKeys(operation, dimensions, [...keys, ...optional.filter((key) => Object.hasOwn(dimensions, key))]);
  if (keys.some((key) => !Object.hasOwn(dimensions, key))) malformed(operation, 'execution_budget_dimension_invalid');
  for (const value of Object.values(dimensions)) {
    const dimension = requirePlain(operation, value);
    exactKeys(operation, dimension, ['limit', 'used', 'remaining', 'exhausted']);
    budgetNumber(operation, dimension.limit);
    budgetNumber(operation, dimension.used, true);
    budgetNumber(operation, dimension.remaining, true);
    if (dimension.used === null ? dimension.remaining !== null || dimension.exhausted !== null : typeof dimension.exhausted !== 'boolean' || dimension.remaining === null) {
      malformed(operation, 'execution_budget_dimension_invalid');
    }
  }
}

export function validateExecutionBudgetStatusResultWire(
  value: unknown,
  operation: HostOperation = 'execution.budget.get',
): ExecutionBudgetStatusResult {
  const object = validateExecutionBudgetCommon(
    operation, value, 'execution-budget', ['schemaVersion', 'scope', 'batch', 'runs', 'tasks', 'blockingReasons'],
  );
  const batch = requirePlain(operation, object.batch);
  exactKeys(operation, batch, [
    'id', 'projectId', 'phaseId', 'featureId', 'featureIds', 'status', 'budgetRevision',
    'budget', 'deadlineAtUtcMs', 'dimensions', 'unconfirmedDimensions', 'runtimeStartsReserved',
    'usage', 'reason', 'createdAt', 'updatedAt',
  ]);
  requireStableId(operation, batch.id);
  requireStableId(operation, batch.projectId);
  requireStableId(operation, batch.phaseId);
  requireStableId(operation, batch.featureId);
  if (!(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(batch.status)) malformed(operation, 'execution_budget_status_invalid');
  budgetDate(operation, batch.createdAt);
  budgetDate(operation, batch.updatedAt);
  if (batch.reason !== null) requireNonEmptyString(operation, batch.reason, 'execution_budget_reason_invalid');
  requireNonNegativeInteger(operation, batch.runtimeStartsReserved);
  const featureIds = executionFeatureIdsWire(operation, batch.featureIds);
  if (featureIds.length === 0 || !featureIds.includes(batch.featureId as string)) {
    malformed(operation, 'execution_budget_feature_scope_invalid');
  }
  if (typeof batch.budgetRevision !== 'number' || !Number.isSafeInteger(batch.budgetRevision) || batch.budgetRevision < 1) {
    malformed(operation, 'execution_budget_revision_invalid');
  }
  if (typeof batch.deadlineAtUtcMs !== 'number' || !Number.isSafeInteger(batch.deadlineAtUtcMs)) {
    malformed(operation, 'execution_budget_deadline_invalid');
  }
  validateBudgetSnapshot(operation, batch.budget, 'batch.budget');
  if (!isPlainObject(batch.dimensions) || !Array.isArray(batch.unconfirmedDimensions)) {
    malformed(operation, 'execution_budget_batch_invalid');
  }
  budgetDimensions(operation, batch.dimensions, ['maxRuns', 'maxTotalAttempts', 'maxRuntimeStarts', 'maxNoProgressRuns', 'deadlineUtcMs'], ['maxTokenTotal', 'maxCostTotal']);
  if (!batch.unconfirmedDimensions.every((dimension) => dimension === 'maxTokenTotal' || dimension === 'maxCostTotal')) malformed(operation, 'execution_budget_dimension_invalid');
  const usage = requirePlain(operation, batch.usage);
  exactKeys(operation, usage, ['tokenUsed', 'costUsed']);
  budgetNumber(operation, usage.tokenUsed, true);
  budgetNumber(operation, usage.costUsed, true);
  if (!Array.isArray(object.runs) || !Array.isArray(object.tasks) || !Array.isArray(object.blockingReasons)) {
    malformed(operation, 'execution_budget_rows_invalid');
  }
  const runIds = object.runs.map(value => requirePlain(operation, value).id);
  const taskKeys = object.tasks.map(value => {
    const task = requirePlain(operation, value);
    return `${task.featureId ?? batch.featureId}/${task.taskId}`;
  });
  if (new Set(runIds).size !== runIds.length || new Set(taskKeys).size !== taskKeys.length) malformed(operation, 'execution_budget_rows_invalid');
  for (const value of object.runs) {
    const run = requirePlain(operation, value);
    exactKeys(operation, run, ['id', 'batchId', 'featureId', 'purpose', 'workKey', 'dispatchOrdinal', 'status', 'limits', 'dimensions', 'attemptsCreated', 'startedAt', 'endedAt', 'elapsedMs', 'reason', 'createdAt']);
    requireStableId(operation, run.id);
    if (run.batchId !== batch.id || !featureIds.includes(run.featureId as string) || !(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(run.status)) malformed(operation, 'execution_budget_run_invalid');
    requireNonEmptyString(operation, run.purpose, 'execution_budget_run_invalid');
    requireNonEmptyString(operation, run.workKey, 'execution_budget_run_invalid');
    requirePositiveInteger(operation, run.dispatchOrdinal);
    requireNonNegativeInteger(operation, run.attemptsCreated);
    const limits = requirePlain(operation, run.limits);
    exactKeys(operation, limits, ['maxAttemptsPerRun', 'runTimeLimitMs']);
    requirePositiveInteger(operation, limits.maxAttemptsPerRun);
    requirePositiveInteger(operation, limits.runTimeLimitMs);
    budgetDimensions(operation, run.dimensions, ['maxAttemptsPerRun', 'runTimeLimitMs']);
    budgetDate(operation, run.startedAt, true);
    budgetDate(operation, run.endedAt, true);
    budgetDate(operation, run.createdAt);
    if (run.elapsedMs !== null) requireNonNegativeInteger(operation, run.elapsedMs);
    if (run.reason !== null) requireNonEmptyString(operation, run.reason, 'execution_budget_reason_invalid');
  }
  for (const value of object.tasks) {
    const task = requirePlain(operation, value);
    exactKeys(operation, task, ['taskId', 'featureId', 'status', 'firstPassedAt', 'attempts', 'codeAttempts', 'caps']);
    if ((featureIds.length > 1 && task.featureId === undefined) || (task.featureId !== undefined && !featureIds.includes(task.featureId as string))) malformed(operation, 'execution_budget_task_invalid');
    requireStableId(operation, task.taskId);
    if (!(TASK_STATUSES as readonly unknown[]).includes(task.status)) malformed(operation, 'execution_budget_task_invalid');
    budgetDate(operation, task.firstPassedAt, true);
    for (const field of ['attempts', 'codeAttempts']) {
      const counts = requirePlain(operation, task[field]);
      exactKeys(operation, counts, ['used', 'limit', 'remaining']);
      requireNonNegativeInteger(operation, counts.used);
      if (field === 'attempts' && counts.limit === null) {
        if (counts.remaining !== null) malformed(operation, 'execution_budget_task_invalid');
      } else {
        requirePositiveInteger(operation, counts.limit);
        requireNonNegativeInteger(operation, counts.remaining);
      }
    }
    const caps = requirePlain(operation, task.caps);
    exactKeys(operation, caps, ['maxCodeAttempts', 'maxAttemptsPerTask', 'effectiveMaxCodeAttempts', 'rule']);
    requirePositiveInteger(operation, caps.maxCodeAttempts);
    if (caps.maxAttemptsPerTask !== null) requirePositiveInteger(operation, caps.maxAttemptsPerTask);
    requirePositiveInteger(operation, caps.effectiveMaxCodeAttempts);
    if (!['code_cap_default', 'code_cap_only', 'total_cap_only', 'code_cap_binds', 'total_cap_binds', 'equal', 'code_cap_default_bounded_by_total'].includes(caps.rule as string)) malformed(operation, 'execution_budget_task_invalid');
  }
  for (const value of object.blockingReasons) {
    const reason = requirePlain(operation, value);
    const optional = ['dimension', 'limit', 'used'].filter((key) => Object.hasOwn(reason, key));
    exactKeys(operation, reason, ['layer', 'layerId', 'reason', ...optional]);
    requireStableId(operation, reason.layerId);
    if (!['batch', 'run', 'task'].includes(reason.layer as string) || !(EXECUTION_BUDGET_BLOCK_REASONS as readonly unknown[]).includes(reason.reason)) malformed(operation, 'execution_budget_block_invalid');
    if (Object.hasOwn(reason, 'dimension') && !['maxRuns', 'maxTotalAttempts', 'maxRuntimeStarts', 'maxNoProgressRuns', 'deadlineUtcMs', 'maxTokenTotal', 'maxCostTotal', 'maxAttemptsPerRun', 'runTimeLimitMs', 'maxCodeAttempts', 'maxAttemptsPerTask'].includes(reason.dimension as string)) malformed(operation, 'execution_budget_dimension_invalid');
    if (Object.hasOwn(reason, 'limit')) budgetNumber(operation, reason.limit);
    if (Object.hasOwn(reason, 'used')) budgetNumber(operation, reason.used, true);
  }
  return object as unknown as ExecutionBudgetStatusResult;
}

export function validateBudgetRevisionListResultWire(
  value: unknown,
  operation: HostOperation = 'execution.budget.revisions',
): BudgetRevisionListResult {
  const object = validateExecutionBudgetCommon(
    operation, value, 'budget-revision-list', ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit'],
  );
  if (!Array.isArray(object.records) || (object.nextCursor !== null && typeof object.nextCursor !== 'string')) {
    malformed(operation, 'execution_budget_revisions_invalid');
  }
  if (typeof object.limit !== 'number' || !Number.isSafeInteger(object.limit) || object.limit < 1 || object.limit > 200 || object.records.length > object.limit) {
    malformed(operation, 'execution_budget_limit_invalid');
  }
  for (const recordValue of object.records) {
    const record = requirePlain(operation, recordValue);
    exactKeys(operation, record, ['id', 'batchId', 'version', 'budget', 'deadlineAtUtcMs', 'approvedBy', 'reason', 'createdAt']);
    requireStableId(operation, record.id);
    requireStableId(operation, record.batchId);
    validateBudgetSnapshot(operation, record.budget, 'revision.budget');
    if (typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) {
      malformed(operation, 'execution_budget_revision_record_invalid');
    }
    if (typeof record.deadlineAtUtcMs !== 'number' || !Number.isSafeInteger(record.deadlineAtUtcMs) || typeof record.approvedBy !== 'string' || typeof record.reason !== 'string' || !isIsoUtcDateTime(record.createdAt)) {
      malformed(operation, 'execution_budget_revision_record_invalid');
    }
  }
  return object as unknown as BudgetRevisionListResult;
}

/* ------------------------------------------------------------------ *
 * P03-4 / F-008 调度诊断与 Attempt 审计查询响应（与 Core 公开形状同一冻结面）
 * ------------------------------------------------------------------ */

/** ISO UTC 时间或 null（未启动/未结束等未知事实保持 null，不接受 0 冒充）。 */
function requireIsoUtcOrNull(operation: HostOperation, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (!isIsoUtcDateTime(value)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
  return value;
}

/** 有界非负整数或 null（已知耗时/退出信息保留，未知保持 null）。 */
function requireNonNegativeIntegerOrNull(operation: HostOperation, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    malformed(operation, 'execution_schedule_number_invalid');
  }
  return value;
}

/** 稳定身份或 null（session/invocation/code/diagnostic 链接身份）。 */
function requireStableIdOrNull(operation: HostOperation, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireStableId(operation, value);
}

/** 非负有界数或 null（用量度量；部分上报的未知维度保持 null）。 */
function requireUsageMeasureOrNull(operation: HostOperation, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    malformed(operation, 'execution_attempt_usage_invalid');
  }
  return value;
}

function validateAttemptUsageSummaryWire(operation: HostOperation, value: unknown): void {
  const summary = requirePlain(operation, value);
  exactKeys(operation, summary, [
    'schemaVersion',
    'inputTokens',
    'outputTokens',
    'costMicros',
    'currency',
  ]);
  if (summary.schemaVersion !== 1) {
    if (typeof summary.schemaVersion === 'number') {
      unsupportedVersion(operation, 'usageSummary.schemaVersion');
    }
    malformed(operation, 'execution_attempt_usage_invalid');
  }
  requireUsageMeasureOrNull(operation, summary.inputTokens);
  requireUsageMeasureOrNull(operation, summary.outputTokens);
  requireUsageMeasureOrNull(operation, summary.costMicros);
  if (summary.currency !== null && typeof summary.currency !== 'string') {
    malformed(operation, 'execution_attempt_usage_invalid');
  }
}

/** Attempt 审计公开记录（精确键集：快照正文/凭据/路径字段一律未知键拒绝）。 */
function validatePublicAttemptRecordWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'runId',
    'taskId',
    'number',
    'owner',
    'hostInstanceId',
    'executionVersion',
    'leaseUntil',
    'status',
    'executionStage',
    'inputDigest',
    'inputRef',
    'sessionId',
    'invocationId',
    'codeRef',
    'errorKind',
    'diagnosticRef',
    'startedAt',
    'endedAt',
    'durationMs',
    'exitCode',
    'usageSummary',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.runId);
  requireStableId(operation, record.taskId);
  requirePositiveInteger(operation, record.number);
  requireNonEmptyString(operation, record.owner, 'execution_attempt_record_invalid');
  requireNonEmptyString(operation, record.hostInstanceId, 'execution_attempt_record_invalid');
  requireNonNegativeInteger(operation, record.executionVersion);
  if (!isIsoUtcDateTime(record.leaseUntil)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'execution_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(record.executionStage)) {
    malformed(operation, 'execution_attempt_stage_invalid');
  }
  requireSha256Hex(operation, record.inputDigest, 'execution_attempt_digest_invalid');
  requireStableId(operation, record.inputRef);
  requireStableIdOrNull(operation, record.sessionId);
  requireStableIdOrNull(operation, record.invocationId);
  requireStableIdOrNull(operation, record.codeRef);
  requireStableIdOrNull(operation, record.diagnosticRef);
  if (record.errorKind !== null && typeof record.errorKind !== 'string') {
    malformed(operation, 'execution_attempt_record_invalid');
  }
  requireIsoUtcOrNull(operation, record.startedAt);
  requireIsoUtcOrNull(operation, record.endedAt);
  requireNonNegativeIntegerOrNull(operation, record.durationMs);
  if (record.exitCode !== null && !Number.isSafeInteger(record.exitCode)) {
    malformed(operation, 'execution_attempt_record_invalid');
  }
  if (record.usageSummary !== null) {
    validateAttemptUsageSummaryWire(operation, record.usageSummary);
  }
  requirePositiveInteger(operation, record.revision);
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
}

/** 任务最近 Attempt 摘要（调度视图内嵌；executionStage 原样展示不代表验收）。 */
function validatePublicAttemptSummaryWire(operation: HostOperation, value: unknown): void {
  const summary = requirePlain(operation, value);
  exactKeys(operation, summary, [
    'id',
    'number',
    'status',
    'executionStage',
    'exitCode',
    'durationMs',
    'startedAt',
    'endedAt',
    'errorKind',
  ]);
  requireStableId(operation, summary.id);
  requirePositiveInteger(operation, summary.number);
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(summary.status)) {
    malformed(operation, 'execution_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(summary.executionStage)) {
    malformed(operation, 'execution_attempt_stage_invalid');
  }
  if (summary.exitCode !== null && !Number.isSafeInteger(summary.exitCode)) {
    malformed(operation, 'execution_attempt_record_invalid');
  }
  requireNonNegativeIntegerOrNull(operation, summary.durationMs);
  requireIsoUtcOrNull(operation, summary.startedAt);
  requireIsoUtcOrNull(operation, summary.endedAt);
  if (summary.errorKind !== null && typeof summary.errorKind !== 'string') {
    malformed(operation, 'execution_attempt_record_invalid');
  }
}

function validateScheduleResultCommon(
  operation: HostOperation,
  value: unknown,
  expectedScope: string,
): Record<string, unknown> {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'list_schema_version_invalid');
  }
  if (object.scope !== expectedScope) {
    malformed(operation, 'list_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'list_records_invalid');
  }
  requirePlanCursorOrNull(operation, object.nextCursor);
  requirePositiveInteger(operation, object.limit);
  return object;
}

/** execution.run.schedule：Run 调度原因 + Task 派生就绪视图 + 占用审计。 */
export function validateRunScheduleStatusResultWire(
  value: unknown,
  operation: HostOperation = 'execution.run.schedule',
): RunScheduleStatusResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'run', 'schedule', 'tasks', 'occupancy']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'execution_schedule_version_invalid');
  }
  if (object.scope !== 'run-schedule') {
    malformed(operation, 'execution_schedule_scope_invalid');
  }
  const run = requirePlain(operation, object.run);
  exactKeys(operation, run, [
    'id',
    'projectId',
    'batchId',
    'featureId',
    'purpose',
    'workKey',
    'dispatchOrdinal',
    'status',
    'reason',
    'startedAt',
    'endedAt',
    'createdAt',
  ]);
  requireStableId(operation, run.id);
  requireStableId(operation, run.projectId);
  requireStableId(operation, run.batchId);
  requireStableId(operation, run.featureId);
  requireNonEmptyString(operation, run.purpose, 'execution_schedule_run_invalid');
  requireSha256Hex(operation, run.workKey, 'execution_schedule_digest_invalid');
  requirePositiveInteger(operation, run.dispatchOrdinal);
  if (!(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(run.status)) {
    malformed(operation, 'execution_schedule_status_invalid');
  }
  if (run.reason !== null) {
    requireNonEmptyString(operation, run.reason, 'execution_schedule_run_invalid');
  }
  requireIsoUtcOrNull(operation, run.startedAt);
  requireIsoUtcOrNull(operation, run.endedAt);
  if (!isIsoUtcDateTime(run.createdAt)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
  const schedule = requirePlain(operation, object.schedule);
  exactKeys(operation, schedule, ['reason', 'diagnostic', 'readyTaskIds', 'handoff']);
  if (!(TASK_DAG_REASONS as readonly unknown[]).includes(schedule.reason)) {
    malformed(operation, 'execution_schedule_reason_invalid');
  }
  if (schedule.diagnostic !== null && typeof schedule.diagnostic !== 'string') {
    malformed(operation, 'execution_schedule_diagnostic_invalid');
  }
  if (!Array.isArray(schedule.readyTaskIds)) {
    malformed(operation, 'execution_schedule_ready_invalid');
  }
  for (const taskId of schedule.readyTaskIds) {
    requireStableId(operation, taskId);
  }
  if (schedule.handoff !== null && schedule.handoff !== 'feature_final_verification') {
    malformed(operation, 'execution_schedule_handoff_invalid');
  }
  if (!Array.isArray(object.tasks) || !Array.isArray(object.occupancy)) {
    malformed(operation, 'execution_schedule_rows_invalid');
  }
  const taskRows = object.tasks as unknown[];
  const occupancyRows = object.occupancy as unknown[];
  for (const value of taskRows) {
    const task = requirePlain(operation, value);
    exactKeys(operation, task, [
      'taskId',
      'status',
      'reason',
      'dependencyIds',
      'executionVersion',
      'manualBlock',
      'latestAttempt',
    ]);
    requireStableId(operation, task.taskId);
    if (!(TASK_STATUSES as readonly unknown[]).includes(task.status)) {
      malformed(operation, 'execution_schedule_status_invalid');
    }
    if (!(TASK_DAG_REASONS as readonly unknown[]).includes(task.reason)) {
      malformed(operation, 'execution_schedule_reason_invalid');
    }
    if (!Array.isArray(task.dependencyIds)) {
      malformed(operation, 'execution_schedule_dependencies_invalid');
    }
    for (const dependencyId of task.dependencyIds) {
      requireStableId(operation, dependencyId);
    }
    requireNonNegativeInteger(operation, task.executionVersion);
    if (typeof task.manualBlock !== 'boolean') {
      malformed(operation, 'execution_schedule_task_invalid');
    }
    if (task.latestAttempt !== null) {
      validatePublicAttemptSummaryWire(operation, task.latestAttempt);
    }
  }
  for (const value of occupancyRows) {
    const lease = requirePlain(operation, value);
    exactKeys(operation, lease, [
      'id',
      'attemptId',
      'runId',
      'resourceKind',
      'resourceKey',
      'state',
      'leaseUntil',
      'processIdentity',
    ]);
    requireStableId(operation, lease.id);
    requireStableId(operation, lease.attemptId);
    requireStableId(operation, lease.runId);
    if (!['global', 'project', 'workspace'].includes(lease.resourceKind as string)) {
      malformed(operation, 'execution_occupancy_kind_invalid');
    }
    requireNonEmptyString(operation, lease.resourceKey, 'execution_occupancy_invalid');
    if (lease.state !== 'held' && lease.state !== 'quarantined') {
      malformed(operation, 'execution_occupancy_state_invalid');
    }
    if (!isIsoUtcDateTime(lease.leaseUntil)) {
      malformed(operation, 'execution_schedule_date_invalid');
    }
    if (typeof lease.processIdentity !== 'boolean') {
      malformed(operation, 'execution_occupancy_invalid');
    }
  }
  return object as unknown as RunScheduleStatusResult;
}

/* ------------------------------------------------------------------ *
 * P03-9 / F-013/F-014 Run/Batch 控制进度、恢复诊断与 finalization 收尾结果
 *（查询响应冻结字段集；未知用量/退出/停止确认保持 null，不以 0/false 冒充）
 * ------------------------------------------------------------------ */

function validateExecutionControlUsageWire(operation: HostOperation, value: unknown): void {
  const usage = requirePlain(operation, value);
  exactKeys(operation, usage, ['inputTokens', 'outputTokens', 'costMicros', 'currency']);
  requireUsageMeasureOrNull(operation, usage.inputTokens);
  requireUsageMeasureOrNull(operation, usage.outputTokens);
  requireUsageMeasureOrNull(operation, usage.costMicros);
  if (usage.currency !== null && typeof usage.currency !== 'string') {
    malformed(operation, 'execution_control_usage_invalid');
  }
}

function validateExecutionControlAttemptWire(operation: HostOperation, value: unknown): void {
  const attempt = requirePlain(operation, value);
  exactKeys(operation, attempt, [
    'attemptId',
    'taskId',
    'attemptNumber',
    'status',
    'executionStage',
    'errorKind',
    'diagnosticRef',
    'startedAt',
    'endedAt',
    'durationMs',
    'exitCode',
    'usage',
  ]);
  requireStableId(operation, attempt.attemptId);
  requireStableId(operation, attempt.taskId);
  requirePositiveInteger(operation, attempt.attemptNumber);
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(attempt.status)) {
    malformed(operation, 'execution_control_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(attempt.executionStage)) {
    malformed(operation, 'execution_control_attempt_stage_invalid');
  }
  if (attempt.errorKind !== null && typeof attempt.errorKind !== 'string') {
    malformed(operation, 'execution_control_attempt_invalid');
  }
  requireStableIdOrNull(operation, attempt.diagnosticRef);
  requireIsoUtcOrNull(operation, attempt.startedAt);
  requireIsoUtcOrNull(operation, attempt.endedAt);
  requireNonNegativeIntegerOrNull(operation, attempt.durationMs);
  if (attempt.exitCode !== null && (typeof attempt.exitCode !== 'number' || !Number.isSafeInteger(attempt.exitCode))) {
    malformed(operation, 'execution_control_attempt_invalid');
  }
  if (attempt.usage !== null) validateExecutionControlUsageWire(operation, attempt.usage);
}

function validateExecutionControlStopOperationWire(operation: HostOperation, value: unknown): void {
  const stop = requirePlain(operation, value);
  exactKeys(operation, stop, [
    'operationId',
    'targetKind',
    'targetId',
    'batchId',
    'featureId',
    'runId',
    'status',
    'reason',
    'requestedAt',
    'settledAt',
    'evidenceRef',
    'stopConfirmed',
    'forced',
    'checkedAt',
  ]);
  requireStableId(operation, stop.operationId);
  if (stop.targetKind !== 'run' && stop.targetKind !== 'batch' && stop.targetKind !== 'feature') {
    malformed(operation, 'execution_control_stop_target_invalid');
  }
  requireStableId(operation, stop.targetId);
  requireStableId(operation, stop.batchId);
  requireStableIdOrNull(operation, stop.featureId);
  requireStableIdOrNull(operation, stop.runId);
  if (!(EXECUTION_STOP_OPERATION_STATUSES as readonly unknown[]).includes(stop.status)) {
    malformed(operation, 'execution_control_stop_status_invalid');
  }
  requireNonEmptyString(operation, stop.reason, 'execution_control_stop_invalid');
  if (!isIsoUtcDateTime(stop.requestedAt)) {
    malformed(operation, 'execution_control_date_invalid');
  }
  requireIsoUtcOrNull(operation, stop.settledAt);
  requireStableIdOrNull(operation, stop.evidenceRef);
  for (const flag of [stop.stopConfirmed, stop.forced]) {
    if (flag !== null && typeof flag !== 'boolean') {
      malformed(operation, 'execution_control_stop_invalid');
    }
  }
  requireIsoUtcOrNull(operation, stop.checkedAt);
}

function validateExecutionControlLeaseWire(operation: HostOperation, value: unknown): void {
  const lease = requirePlain(operation, value);
  exactKeys(operation, lease, ['leaseId', 'attemptId', 'resourceKey', 'state', 'leaseUntil']);
  requireStableId(operation, lease.leaseId);
  requireStableId(operation, lease.attemptId);
  requireNonEmptyString(operation, lease.resourceKey, 'execution_control_lease_invalid');
  if (lease.state !== 'held' && lease.state !== 'quarantined') {
    malformed(operation, 'execution_control_lease_state_invalid');
  }
  if (!isIsoUtcDateTime(lease.leaseUntil)) {
    malformed(operation, 'execution_control_date_invalid');
  }
}

function validateExecutionControlRunBriefWire(operation: HostOperation, value: unknown): void {
  const run = requirePlain(operation, value);
  exactKeys(operation, run, [
    'runId',
    'batchId',
    'featureId',
    'purpose',
    'status',
    'reason',
    'pauseRequestedAt',
    'startedAt',
    'endedAt',
    'updatedAt',
  ]);
  requireStableId(operation, run.runId);
  requireStableId(operation, run.batchId);
  requireStableId(operation, run.featureId);
  requireNonEmptyString(operation, run.purpose, 'execution_control_run_invalid');
  if (!(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(run.status)) {
    malformed(operation, 'execution_control_run_status_invalid');
  }
  if (run.reason !== null) requireNonEmptyString(operation, run.reason, 'execution_control_run_invalid');
  requireIsoUtcOrNull(operation, run.pauseRequestedAt);
  requireIsoUtcOrNull(operation, run.startedAt);
  requireIsoUtcOrNull(operation, run.endedAt);
  if (!isIsoUtcDateTime(run.updatedAt)) {
    malformed(operation, 'execution_control_date_invalid');
  }
}

function validateExecutionControlCountersWire(operation: HostOperation, value: unknown): void {
  const counters = requirePlain(operation, value);
  exactKeys(operation, counters, ['runsCreated', 'attemptsCreated', 'runtimeStarts', 'noProgressRuns']);
  for (const count of Object.values(counters)) requireNonNegativeInteger(operation, count);
}

function validateExecutionControlBatchBriefWire(operation: HostOperation, value: unknown): void {
  const batch = requirePlain(operation, value);
  exactKeys(operation, batch, [
    'batchId',
    'featureId',
    'featureIds',
    'phaseId',
    'status',
    'reason',
    'pauseRequestedAt',
    'deadlineAt',
    'budgetRevision',
    'counters',
    'updatedAt',
  ]);
  requireStableId(operation, batch.batchId);
  requireStableId(operation, batch.featureId);
  if (!(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(batch.status)) {
    malformed(operation, 'execution_control_batch_status_invalid');
  }
  if (batch.featureIds !== undefined || batch.phaseId !== undefined) {
    requireStableId(operation, batch.phaseId);
    const ids = executionFeatureIdsWire(operation, batch.featureIds);
    if (ids.length === 0 || !ids.includes(batch.featureId as string)) malformed(operation, 'execution_control_batch_scope_invalid');
  }
  if (batch.reason !== null) requireNonEmptyString(operation, batch.reason, 'execution_control_batch_invalid');
  requireIsoUtcOrNull(operation, batch.pauseRequestedAt);
  if (!isIsoUtcDateTime(batch.deadlineAt)) {
    malformed(operation, 'execution_control_date_invalid');
  }
  requirePositiveInteger(operation, batch.budgetRevision);
  validateExecutionControlCountersWire(operation, batch.counters);
  if (!isIsoUtcDateTime(batch.updatedAt)) {
    malformed(operation, 'execution_control_date_invalid');
  }
}

function validateExecutionControlNextActionsWire(operation: HostOperation, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    malformed(operation, 'execution_control_actions_invalid');
  }
  const seen = new Set<unknown>();
  for (const action of value) {
    if (!(EXECUTION_CONTROL_NEXT_ACTIONS as readonly unknown[]).includes(action) || seen.has(action)) {
      malformed(operation, 'execution_control_actions_invalid');
    }
    seen.add(action);
  }
}

function validateExecutionControlAttemptListWire(
  operation: HostOperation,
  value: unknown,
  limit: number,
): void {
  const list = requirePlain(operation, value);
  exactKeys(operation, list, ['records', 'truncated']);
  if (!Array.isArray(list.records) || list.records.length > limit || typeof list.truncated !== 'boolean') {
    malformed(operation, 'execution_control_attempts_invalid');
  }
  for (const record of list.records as unknown[]) validateExecutionControlAttemptWire(operation, record);
}

function validateExecutionControlStopOperationsWire(operation: HostOperation, value: unknown): void {
  if (!Array.isArray(value) || value.length > EXECUTION_CONTROL_STOP_OPERATIONS_MAX) {
    malformed(operation, 'execution_control_stop_operations_invalid');
  }
  for (const stop of value as unknown[]) validateExecutionControlStopOperationWire(operation, stop);
}

function validateExecutionControlLeasesWire(operation: HostOperation, value: unknown): void {
  if (!Array.isArray(value)) malformed(operation, 'execution_control_leases_invalid');
  for (const lease of value as unknown[]) validateExecutionControlLeaseWire(operation, lease);
}

/** execution.run.control.get：Run 控制进度（冻结字段集）。 */
export function validateRunControlDetailResultWire(
  value: unknown,
  operation: HostOperation = 'execution.run.control.get',
): RunControlDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion',
    'scope',
    'run',
    'batch',
    'attempts',
    'stopOperations',
    'leases',
    'nextActions',
  ]);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') unsupportedVersion(operation, 'schemaVersion');
    malformed(operation, 'execution_control_schema_version_invalid');
  }
  if (object.scope !== 'run-control') malformed(operation, 'execution_control_scope_invalid');
  validateExecutionControlRunBriefWire(operation, object.run);
  validateExecutionControlBatchBriefWire(operation, object.batch);
  validateExecutionControlAttemptListWire(operation, object.attempts, EXECUTION_CONTROL_ATTEMPTS_MAX);
  validateExecutionControlStopOperationsWire(operation, object.stopOperations);
  validateExecutionControlLeasesWire(operation, object.leases);
  validateExecutionControlNextActionsWire(operation, object.nextActions);
  return object as unknown as RunControlDetailResult;
}

/** execution.batch.control.get：Batch 控制进度（冻结字段集）。 */
export function validateBatchControlDetailResultWire(
  value: unknown,
  operation: HostOperation = 'execution.batch.control.get',
): BatchControlDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion',
    'scope',
    'batch',
    'runs',
    'attempts',
    'stopOperations',
    'leases',
    'nextActions',
  ]);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') unsupportedVersion(operation, 'schemaVersion');
    malformed(operation, 'execution_control_schema_version_invalid');
  }
  if (object.scope !== 'batch-control') malformed(operation, 'execution_control_scope_invalid');
  validateExecutionControlBatchBriefWire(operation, object.batch);
  const runs = requirePlain(operation, object.runs);
  exactKeys(operation, runs, ['records', 'truncated']);
  if (!Array.isArray(runs.records) || runs.records.length > EXECUTION_CONTROL_RUNS_MAX || typeof runs.truncated !== 'boolean') {
    malformed(operation, 'execution_control_runs_invalid');
  }
  for (const value of runs.records as unknown[]) {
    validateExecutionControlRunBriefWire(operation, value);
    const run = requirePlain(operation, value);
    const batch = requirePlain(operation, object.batch);
    const ids = (batch.featureIds ?? [batch.featureId]) as string[];
    if (run.batchId !== batch.batchId || !ids.includes(run.featureId as string)) malformed(operation, 'execution_control_batch_scope_invalid');
  }
  validateExecutionControlAttemptListWire(operation, object.attempts, EXECUTION_CONTROL_ATTEMPTS_MAX);
  validateExecutionControlStopOperationsWire(operation, object.stopOperations);
  validateExecutionControlLeasesWire(operation, object.leases);
  validateExecutionControlNextActionsWire(operation, object.nextActions);
  return object as unknown as BatchControlDetailResult;
}

function validateExecutionRecoveryContinuationWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'attemptId',
    'taskId',
    'attemptNumber',
    'sourceAttemptId',
    'sourceSessionId',
    'requested',
    'decided',
    'handoff',
    'recordedAt',
  ]);
  requireStableId(operation, record.attemptId);
  requireStableId(operation, record.taskId);
  requirePositiveInteger(operation, record.attemptNumber);
  requireStableIdOrNull(operation, record.sourceAttemptId);
  requireStableIdOrNull(operation, record.sourceSessionId);
  const requested = requirePlain(operation, record.requested);
  exactKeys(operation, requested, ['mode', 'kind', 'nativeArchiveRef']);
  if (requested.mode !== 'new' && requested.mode !== 'auto' && requested.mode !== 'required') {
    malformed(operation, 'execution_recovery_mode_invalid');
  }
  if (requested.kind !== null && requested.kind !== 'conversation' && requested.kind !== 'checkpoint') {
    malformed(operation, 'execution_recovery_mode_invalid');
  }
  if ((requested.mode === 'new') !== (requested.kind === null)) {
    malformed(operation, 'execution_recovery_mode_invalid');
  }
  requireStableIdOrNull(operation, requested.nativeArchiveRef);
  const decided = requirePlain(operation, record.decided);
  exactKeys(operation, decided, ['mode', 'reasons']);
  if (decided.mode !== 'resume' && decided.mode !== 'new') {
    malformed(operation, 'execution_recovery_mode_invalid');
  }
  if (!Array.isArray(decided.reasons) || decided.reasons.length > 256) {
    malformed(operation, 'execution_recovery_reasons_invalid');
  }
  for (const reason of decided.reasons as unknown[]) {
    requireNonEmptyString(operation, reason, 'execution_recovery_reasons_invalid');
  }
  if (record.handoff !== null) {
    const handoff = requirePlain(operation, record.handoff);
    exactKeys(operation, handoff, ['previousAttemptId', 'previousStatus']);
    requireStableId(operation, handoff.previousAttemptId);
    requireNonEmptyString(operation, handoff.previousStatus, 'execution_recovery_handoff_invalid');
  }
  if (!isIsoUtcDateTime(record.recordedAt)) {
    malformed(operation, 'execution_recovery_date_invalid');
  }
}

/** execution.run.recovery.get：恢复诊断与 finalization 收尾结果（冻结字段集）。 */
export function validateRunRecoveryDetailResultWire(
  value: unknown,
  operation: HostOperation = 'execution.run.recovery.get',
): RunRecoveryDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion',
    'scope',
    'run',
    'finalization',
    'recovery',
    'budget',
  ]);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') unsupportedVersion(operation, 'schemaVersion');
    malformed(operation, 'execution_recovery_schema_version_invalid');
  }
  if (object.scope !== 'run-recovery') malformed(operation, 'execution_recovery_scope_invalid');
  const run = requirePlain(operation, object.run);
  exactKeys(operation, run, [
    'runId',
    'batchId',
    'featureId',
    'purpose',
    'workKey',
    'dispatchOrdinal',
    'status',
    'reason',
    'startedAt',
    'endedAt',
  ]);
  requireStableId(operation, run.runId);
  requireStableId(operation, run.batchId);
  requireStableId(operation, run.featureId);
  requireNonEmptyString(operation, run.purpose, 'execution_recovery_run_invalid');
  requireSha256Hex(operation, run.workKey, 'execution_recovery_run_invalid');
  requirePositiveInteger(operation, run.dispatchOrdinal);
  if (!(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(run.status)) {
    malformed(operation, 'execution_recovery_run_status_invalid');
  }
  if (run.reason !== null) requireNonEmptyString(operation, run.reason, 'execution_recovery_run_invalid');
  requireIsoUtcOrNull(operation, run.startedAt);
  requireIsoUtcOrNull(operation, run.endedAt);
  const finalization = requirePlain(operation, object.finalization);
  exactKeys(operation, finalization, ['present', 'scope', 'axes']);
  if (typeof finalization.present !== 'boolean') {
    malformed(operation, 'execution_recovery_finalization_invalid');
  }
  let scopePresent = false;
  try {
    scopePresent = validateRunFinalizationScope(finalization.scope) !== null;
  } catch {
    malformed(operation, 'execution_recovery_finalization_invalid');
  }
  if (finalization.present !== scopePresent) {
    malformed(operation, 'execution_recovery_finalization_invalid');
  }
  validateFeatureDeliveryAxesWire(operation, finalization.axes);
  const recovery = requirePlain(operation, object.recovery);
  exactKeys(operation, recovery, ['records', 'truncated', 'attemptsScanned']);
  if (
    !Array.isArray(recovery.records) ||
    recovery.records.length > EXECUTION_RECOVERY_CONTINUATIONS_MAX ||
    typeof recovery.truncated !== 'boolean'
  ) {
    malformed(operation, 'execution_recovery_records_invalid');
  }
  requireNonNegativeInteger(operation, recovery.attemptsScanned);
  for (const record of recovery.records as unknown[]) {
    validateExecutionRecoveryContinuationWire(operation, record);
  }
  const budget = requirePlain(operation, object.budget);
  exactKeys(operation, budget, ['batchId', 'budgetRevision', 'deadlineAt', 'limits', 'counters', 'usage']);
  requireStableId(operation, budget.batchId);
  requirePositiveInteger(operation, budget.budgetRevision);
  if (!isIsoUtcDateTime(budget.deadlineAt)) {
    malformed(operation, 'execution_recovery_date_invalid');
  }
  validateBudgetSnapshot(operation, budget.limits, 'budget.limits');
  validateExecutionControlCountersWire(operation, budget.counters);
  const usage = requirePlain(operation, budget.usage);
  exactKeys(operation, usage, ['tokenUsed', 'costUsed']);
  // 当前结算账本无用量列：未知恒 null，不以 0 冒充。
  if (usage.tokenUsed !== null || usage.costUsed !== null) {
    malformed(operation, 'execution_recovery_usage_invalid');
  }
  return object as unknown as RunRecoveryDetailResult;
}

/** execution.attempts.list：Task 的 Attempt 审计分页（受控游标复用计划规范）。 */
export function validateAttemptListResultWire(
  value: unknown,
  operation: HostOperation = 'execution.attempts.list',
): AttemptListResult {
  const object = validateScheduleResultCommon(operation, value, 'attempt-list');
  for (const record of object.records as unknown[]) {
    validatePublicAttemptRecordWire(operation, record);
  }
  return object as unknown as AttemptListResult;
}

/** execution.attempt.diagnostics：迟到/越权通知诊断分页（固定原因冻结词汇）。 */
export function validateAttemptDiagnosticsResultWire(
  value: unknown,
  operation: HostOperation = 'execution.attempt.diagnostics',
): AttemptDiagnosticsResult {
  const object = validateScheduleResultCommon(operation, value, 'attempt-diagnostic-list');
  for (const value of object.records as unknown[]) {
    const record = requirePlain(operation, value);
    exactKeys(operation, record, [
      'id',
      'projectId',
      'attemptId',
      'notificationDigest',
      'reason',
      'occurredAt',
    ]);
    requireStableId(operation, record.id);
    requireStableId(operation, record.projectId);
    requireStableId(operation, record.attemptId);
    requireSha256Hex(operation, record.notificationDigest, 'execution_diagnostic_digest_invalid');
    if (
      !(ATTEMPT_NOTIFICATION_DIAGNOSTIC_REASONS as readonly unknown[]).includes(record.reason)
    ) {
      malformed(operation, 'execution_diagnostic_reason_invalid');
    }
    if (!isIsoUtcDateTime(record.occurredAt)) {
      malformed(operation, 'execution_schedule_date_invalid');
    }
  }
  return object as unknown as AttemptDiagnosticsResult;
}

/* ------------------------------------------------------------------ *
 * P04-9 / F-009 派发队列与执行槽位投影线校验
 *（冻结字段集精确键校验；跨项目只允许布尔摘要；无任何写字段）
 * ------------------------------------------------------------------ */

function validateDispatchSlotSummaryWire(operation: HostOperation, value: unknown): void {
  const summary = requirePlain(operation, value);
  exactKeys(operation, summary, [
    'capacity',
    'activeCount',
    'availableCount',
    'quarantinedCount',
    'projectActiveCount',
    'otherProjectActive',
  ]);
  requirePositiveInteger(operation, summary.capacity);
  for (const key of [
    'activeCount',
    'availableCount',
    'quarantinedCount',
    'projectActiveCount',
  ] as const) {
    requireNonNegativeInteger(operation, summary[key]);
  }
  if (typeof summary.otherProjectActive !== 'boolean') {
    malformed(operation, 'execution_dispatch_slots_invalid');
  }
}

function validateDispatchClaimViewWire(operation: HostOperation, value: unknown): void {
  const claim = requirePlain(operation, value);
  exactKeys(operation, claim, [
    'claimId',
    'claimVersion',
    'origin',
    'resumedFromClaimId',
    'resumedFromClaimVersion',
    'ownerId',
    'hostInstanceId',
    'state',
    'acquiredAt',
    'leaseUntil',
    'settledAt',
    'reason',
  ]);
  requireStableId(operation, claim.claimId);
  requirePositiveInteger(operation, claim.claimVersion);
  if (!(RUN_DISPATCH_CLAIM_ORIGINS as readonly unknown[]).includes(claim.origin)) {
    malformed(operation, 'execution_dispatch_claim_invalid');
  }
  requireStableIdOrNull(operation, claim.resumedFromClaimId);
  if (claim.resumedFromClaimVersion !== null) {
    requirePositiveInteger(operation, claim.resumedFromClaimVersion);
  }
  requireNonEmptyString(operation, claim.ownerId, 'execution_dispatch_claim_invalid');
  requireNonEmptyString(operation, claim.hostInstanceId, 'execution_dispatch_claim_invalid');
  if (!(RUN_DISPATCH_CLAIM_STATES as readonly unknown[]).includes(claim.state)) {
    malformed(operation, 'execution_dispatch_claim_invalid');
  }
  if (!isIsoUtcDateTime(claim.acquiredAt) || !isIsoUtcDateTime(claim.leaseUntil)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
  requireIsoUtcOrNull(operation, claim.settledAt);
  if (claim.reason !== null && typeof claim.reason !== 'string') {
    malformed(operation, 'execution_dispatch_claim_invalid');
  }
}

function validateDispatchSlotViewWire(operation: HostOperation, value: unknown): void {
  const slot = requirePlain(operation, value);
  exactKeys(operation, slot, [
    'slotId',
    'slotIndex',
    'claimId',
    'claimVersion',
    'ownerId',
    'hostInstanceId',
    'state',
    'acquiredAt',
    'leaseUntil',
    'releasedAt',
    'reason',
  ]);
  requireStableId(operation, slot.slotId);
  requireNonNegativeInteger(operation, slot.slotIndex);
  requireStableId(operation, slot.claimId);
  requirePositiveInteger(operation, slot.claimVersion);
  requireNonEmptyString(operation, slot.ownerId, 'execution_dispatch_slot_invalid');
  requireNonEmptyString(operation, slot.hostInstanceId, 'execution_dispatch_slot_invalid');
  if (!(RUN_DISPATCH_CLAIM_STATES as readonly unknown[]).includes(slot.state)) {
    malformed(operation, 'execution_dispatch_slot_invalid');
  }
  if (!isIsoUtcDateTime(slot.acquiredAt) || !isIsoUtcDateTime(slot.leaseUntil)) {
    malformed(operation, 'execution_schedule_date_invalid');
  }
  requireIsoUtcOrNull(operation, slot.releasedAt);
  if (slot.reason !== null && typeof slot.reason !== 'string') {
    malformed(operation, 'execution_dispatch_slot_invalid');
  }
}

/** 关联 Attempt 摘要（executionStage 原样展示，不代表验收通过）。 */
function validateDispatchAttemptViewWire(operation: HostOperation, value: unknown): void {
  const attempt = requirePlain(operation, value);
  exactKeys(operation, attempt, [
    'id',
    'taskId',
    'number',
    'status',
    'executionStage',
    'ownerId',
    'executionVersion',
    'startedAt',
    'endedAt',
    'exitCode',
    'durationMs',
  ]);
  requireStableId(operation, attempt.id);
  requireStableId(operation, attempt.taskId);
  requirePositiveInteger(operation, attempt.number);
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(attempt.status)) {
    malformed(operation, 'execution_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(attempt.executionStage)) {
    malformed(operation, 'execution_attempt_stage_invalid');
  }
  requireNonEmptyString(operation, attempt.ownerId, 'execution_dispatch_attempt_invalid');
  requireNonNegativeInteger(operation, attempt.executionVersion);
  requireIsoUtcOrNull(operation, attempt.startedAt);
  requireIsoUtcOrNull(operation, attempt.endedAt);
  if (attempt.exitCode !== null && !Number.isSafeInteger(attempt.exitCode)) {
    malformed(operation, 'execution_dispatch_attempt_invalid');
  }
  requireNonNegativeIntegerOrNull(operation, attempt.durationMs);
}

/** execution.resources.list：Feature 资源租约只读投影，拒绝路径/正文/凭据字段。 */
export function validateResourceListResultWire(
  value: unknown,
  operation: HostOperation = 'execution.resources.list',
): ResourceListResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') unsupportedVersion(operation, 'schemaVersion');
    malformed(operation, 'list_schema_version_invalid');
  }
  if (object.scope !== 'execution-resources' || !Array.isArray(object.records)) {
    malformed(operation, 'resource_list_shape_invalid');
  }
  const nextCursor = object.nextCursor;
  const limit = object.limit;
  if (nextCursor !== null && typeof nextCursor !== 'string') malformed(operation, 'resource_cursor_invalid');
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) malformed(operation, 'resource_limit_invalid');
  for (const item of object.records as unknown[]) {
    const record = requirePlain(operation, item);
    exactKeys(operation, record, [
      'id', 'projectId', 'featureId', 'batchId', 'runId', 'claimId', 'ownerId',
      'ownerVersion', 'revision', 'kind', 'accessMode', 'leaseMode', 'resourceKey',
      'state', 'waitingReason', 'blockingReason', 'acquiredAt', 'leaseUntil',
    ]);
    for (const field of ['id', 'projectId', 'featureId', 'batchId', 'runId', 'claimId', 'ownerId']) {
      requireStableId(operation, record[field]);
    }
    const ownerVersion = record.ownerVersion;
    const revision = record.revision;
    if (typeof ownerVersion !== 'number' || !Number.isSafeInteger(ownerVersion) || ownerVersion < 1 ||
        typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      malformed(operation, 'execution_resource_revision_invalid');
    }
    if (!(['planning_exclusive', 'feature_code_shared', 'worktree_write_exclusive', 'git_public_metadata_short', 'migration', 'contract'] as readonly unknown[]).includes(record.kind)) malformed(operation, 'execution_resource_kind_invalid');
    if (record.accessMode !== 'exclusive' && record.accessMode !== 'shared') malformed(operation, 'execution_resource_access_invalid');
    if (record.leaseMode !== 'lease' && record.leaseMode !== 'short') malformed(operation, 'execution_resource_lease_mode_invalid');
    if (typeof record.resourceKey !== 'string' || record.resourceKey.length === 0 || record.resourceKey.includes('/') || record.resourceKey.includes('\\')) malformed(operation, 'execution_resource_key_invalid');
    if (record.state !== 'held' && record.state !== 'quarantined') malformed(operation, 'execution_resource_state_invalid');
    if (record.blockingReason !== null && !['resource_conflict', 'stop_verification', 'authorization_blocked'].includes(record.blockingReason as string)) malformed(operation, 'execution_resource_blocking_reason_invalid');
    if (record.waitingReason !== null) {
      const waiting = requirePlain(operation, record.waitingReason);
      exactKeys(operation, waiting, ['code', 'resourceKey', 'blockingOwnerId', 'blockingOwnerVersion']);
      if (!['resource_occupied', 'resource_quarantined', 'lease_expired_unverified'].includes(waiting.code as string)) malformed(operation, 'execution_resource_waiting_reason_invalid');
      if (waiting.resourceKey !== record.resourceKey || typeof waiting.resourceKey !== 'string') malformed(operation, 'execution_resource_waiting_reason_invalid');
      if (waiting.blockingOwnerId !== null) requireStableId(operation, waiting.blockingOwnerId);
      if (waiting.blockingOwnerVersion !== null) {
        if (typeof waiting.blockingOwnerVersion !== 'number' || !Number.isSafeInteger(waiting.blockingOwnerVersion) || waiting.blockingOwnerVersion < 1) malformed(operation, 'execution_resource_waiting_reason_invalid');
      }
    }
    if (!isIsoUtcDateTime(record.acquiredAt) || !isIsoUtcDateTime(record.leaseUntil)) malformed(operation, 'execution_resource_date_invalid');
  }
  return object as unknown as ResourceListResult;
}

/** execution.dispatch.list：派发队列 + 槽位摘要只读投影（无写字段）。 */
export function validateDispatchQueueListResultWire(
  value: unknown,
  operation: HostOperation = 'execution.dispatch.list',
): DispatchQueueListResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'slots', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'list_schema_version_invalid');
  }
  if (object.scope !== 'dispatch-queue') {
    malformed(operation, 'list_scope_invalid');
  }
  validateDispatchSlotSummaryWire(operation, object.slots);
  if (!Array.isArray(object.records)) {
    malformed(operation, 'list_records_invalid');
  }
  for (const value of object.records as unknown[]) {
    const record = requirePlain(operation, value);
    exactKeys(operation, record, [
      'runId',
      'projectId',
      'featureId',
      'runStatus',
      'runReason',
      'dispatchOrdinal',
      'state',
      'blockingReason',
      'claim',
      'slot',
      'activeAttempt',
      'latestAttempt',
      'attemptCount',
      'createdAt',
      'startedAt',
      'endedAt',
      'pauseRequestedAt',
    ]);
    requireStableId(operation, record.runId);
    requireStableId(operation, record.projectId);
    requireStableId(operation, record.featureId);
    if (!(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(record.runStatus)) {
      malformed(operation, 'execution_schedule_status_invalid');
    }
    if (record.runReason !== null && typeof record.runReason !== 'string') {
      malformed(operation, 'execution_dispatch_record_invalid');
    }
    requireNonNegativeInteger(operation, record.dispatchOrdinal);
    if (!(DISPATCH_DISPLAY_STATES as readonly unknown[]).includes(record.state)) {
      malformed(operation, 'execution_dispatch_state_invalid');
    }
    if (
      record.blockingReason !== null &&
      !(DISPATCH_BLOCKING_REASONS as readonly unknown[]).includes(record.blockingReason)
    ) {
      malformed(operation, 'execution_dispatch_reason_invalid');
    }
    if (record.claim !== null) {
      validateDispatchClaimViewWire(operation, record.claim);
    }
    if (record.slot !== null) {
      validateDispatchSlotViewWire(operation, record.slot);
    }
    if (record.activeAttempt !== null) {
      validateDispatchAttemptViewWire(operation, record.activeAttempt);
    }
    if (record.latestAttempt !== null) {
      validateDispatchAttemptViewWire(operation, record.latestAttempt);
    }
    requireNonNegativeInteger(operation, record.attemptCount);
    if (!isIsoUtcDateTime(record.createdAt)) {
      malformed(operation, 'execution_schedule_date_invalid');
    }
    requireIsoUtcOrNull(operation, record.startedAt);
    requireIsoUtcOrNull(operation, record.endedAt);
    requireIsoUtcOrNull(operation, record.pauseRequestedAt);
  }
  requirePlanCursorOrNull(operation, object.nextCursor);
  requirePositiveInteger(operation, object.limit);
  return object as unknown as DispatchQueueListResult;
}

/* ------------------------------------------------------------------ *
 * P03-7 / F-013 Task 机器证据/人审事项/有限返工链查询线校验
 *（冻结字段集精确键校验；机器 passed 不折算为有效 Task passed；未知退出/
 *  耗时保持 null；代码资格记账不把基础设施错误折算为代码额度消耗）
 * ------------------------------------------------------------------ */

function requireIntegerOrNull(operation: HostOperation, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    malformed(operation, 'task_evidence_integer_invalid');
  }
  return value;
}

function requireStringArray(
  operation: HostOperation,
  value: unknown,
  reason: string,
): string[] {
  if (!Array.isArray(value)) {
    malformed(operation, reason);
  }
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      malformed(operation, reason);
    }
  }
  return value as string[];
}

function validateTaskEvidenceStateWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'taskId',
    'featureId',
    'status',
    'executionVersion',
    'manualBlock',
    'firstPassedAt',
    'effectivePassed',
  ]);
  requireStableId(operation, record.taskId);
  requireStableId(operation, record.featureId);
  if (!(TASK_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'task_evidence_status_invalid');
  }
  requireNonNegativeInteger(operation, record.executionVersion);
  if (typeof record.manualBlock !== 'boolean') {
    malformed(operation, 'task_evidence_state_invalid');
  }
  if (record.firstPassedAt !== null && !isIsoUtcDateTime(record.firstPassedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (typeof record.effectivePassed !== 'boolean') {
    malformed(operation, 'task_evidence_state_invalid');
  }
  // 机器 passed 不展示为有效 Task passed：有效通过只绑定持久 Task 状态。
  if (record.effectivePassed !== (record.status === 'passed')) {
    malformed(operation, 'task_evidence_effective_passed_invalid');
  }
}

function validateTaskMachineConclusionWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'status',
    'outcome',
    'reason',
    'attemptId',
    'batchId',
    'codeDigest',
    'policyDigest',
    'codeRef',
    'observationDigest',
  ]);
  if (!(TASK_MACHINE_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'task_machine_status_invalid');
  }
  if (record.outcome !== null && !(CODE_ATTEMPT_OUTCOMES as readonly unknown[]).includes(record.outcome)) {
    malformed(operation, 'task_machine_outcome_invalid');
  }
  if (!(TASK_MACHINE_REASONS as readonly unknown[]).includes(record.reason)) {
    malformed(operation, 'task_machine_reason_invalid');
  }
  requireStableIdOrNull(operation, record.attemptId);
  requireStableIdOrNull(operation, record.batchId);
  requireSha256HexOrNull(operation, record.codeDigest, 'task_evidence_digest_invalid');
  requireSha256HexOrNull(operation, record.policyDigest, 'task_evidence_digest_invalid');
  requireStableIdOrNull(operation, record.codeRef);
  requireSha256HexOrNull(operation, record.observationDigest, 'task_evidence_digest_invalid');
}

function validateVerificationSelectionWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['mode', 'reason', 'selectedCheckKeys']);
  if (!(TASK_VERIFICATION_SELECTION_MODES as readonly unknown[]).includes(record.mode)) {
    malformed(operation, 'task_evidence_selection_invalid');
  }
  requireNonEmptyString(operation, record.reason, 'task_evidence_selection_invalid');
  requireStringArray(operation, record.selectedCheckKeys, 'task_evidence_selection_invalid');
}

function validateVerificationCheckResultWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'checkKey',
    'argv',
    'cwdRef',
    'environmentRef',
    'timeoutMs',
    'required',
    'status',
    'exitCode',
    'signal',
    'timedOut',
    'outputArtifactId',
    'outputDigest',
    'outputTail',
    'startedAt',
    'endedAt',
  ]);
  requireStableId(operation, record.id);
  requireNonEmptyString(operation, record.checkKey, 'task_evidence_check_invalid');
  requireStringArray(operation, record.argv, 'task_evidence_check_argv_invalid');
  if (record.cwdRef !== null) requireNonEmptyString(operation, record.cwdRef, 'task_evidence_check_invalid');
  if (record.environmentRef !== null) {
    requireNonEmptyString(operation, record.environmentRef, 'task_evidence_check_invalid');
  }
  requirePositiveInteger(operation, record.timeoutMs);
  if (typeof record.required !== 'boolean' || typeof record.timedOut !== 'boolean') {
    malformed(operation, 'task_evidence_check_invalid');
  }
  if (!(CHECK_RESULT_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'task_evidence_check_status_invalid');
  }
  requireIntegerOrNull(operation, record.exitCode);
  if (record.signal !== null) requireNonEmptyString(operation, record.signal, 'task_evidence_check_invalid');
  requireStableIdOrNull(operation, record.outputArtifactId);
  requireSha256HexOrNull(operation, record.outputDigest, 'task_evidence_digest_invalid');
  if ((record.outputArtifactId === null) !== (record.outputDigest === null)) {
    malformed(operation, 'task_evidence_check_evidence_invalid');
  }
  if (record.outputTail !== null && typeof record.outputTail !== 'string') {
    malformed(operation, 'task_evidence_check_tail_invalid');
  }
  if (record.startedAt !== null && !isIsoUtcDateTime(record.startedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (record.endedAt !== null && !isIsoUtcDateTime(record.endedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
}

function validateVerificationBatchWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'runId',
    'taskId',
    'attemptId',
    'executionVersion',
    'operation',
    'codeDigest',
    'policyDigest',
    'environmentSummary',
    'selection',
    'status',
    'startedAt',
    'endedAt',
    'checks',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.runId);
  requireStableId(operation, record.taskId);
  requireStableId(operation, record.attemptId);
  requireNonNegativeInteger(operation, record.executionVersion);
  requireNonEmptyString(operation, record.operation, 'task_evidence_batch_invalid');
  requireSha256Hex(operation, record.codeDigest, 'task_evidence_digest_invalid');
  requireSha256Hex(operation, record.policyDigest, 'task_evidence_digest_invalid');
  requirePlain(operation, record.environmentSummary);
  validateVerificationSelectionWire(operation, record.selection);
  if (!(VERIFICATION_BATCH_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'task_evidence_batch_status_invalid');
  }
  if (record.startedAt !== null && !isIsoUtcDateTime(record.startedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (record.endedAt !== null && !isIsoUtcDateTime(record.endedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (!Array.isArray(record.checks)) {
    malformed(operation, 'task_evidence_checks_invalid');
  }
  for (const check of record.checks as unknown[]) {
    validateVerificationCheckResultWire(operation, check);
  }
}

/** execution.task.verification.get：Task 机器证据（冻结字段集）。 */
export function validateTaskVerificationResultWire(
  value: unknown,
  operation: HostOperation = 'execution.task.verification.get',
): TaskVerificationDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'task', 'machine', 'batches', 'batchesTruncated']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'task_evidence_schema_version_invalid');
  }
  if (object.scope !== 'task-verification') {
    malformed(operation, 'task_evidence_scope_invalid');
  }
  validateTaskEvidenceStateWire(operation, object.task);
  validateTaskMachineConclusionWire(operation, object.machine);
  if (!Array.isArray(object.batches) || typeof object.batchesTruncated !== 'boolean') {
    malformed(operation, 'task_evidence_batches_invalid');
  }
  for (const batch of object.batches as unknown[]) {
    validateVerificationBatchWire(operation, batch);
  }
  return object as unknown as TaskVerificationDetailResult;
}

function validateTaskApprovalArtifactRefWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['artifactId', 'contentHash']);
  requireStableId(operation, record.artifactId);
  requireSha256HexOrNull(operation, record.contentHash, 'task_evidence_digest_invalid');
}

function validateTaskApprovalItemWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'taskId',
    'kind',
    'description',
    'responsibleParty',
    'status',
    'planDigest',
    'codeDigest',
    'artifactRefs',
    'createdBy',
    'decision',
    'decisionActor',
    'decisionReason',
    'decisionCodeDigest',
    'decisionArtifactRefs',
    'decidedAt',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.taskId);
  if (record.kind !== 'block' && record.kind !== 'approval') {
    malformed(operation, 'task_approval_kind_invalid');
  }
  requireNonEmptyString(operation, record.description, 'task_approval_invalid');
  requireNonEmptyString(operation, record.responsibleParty, 'task_approval_invalid');
  if (!['pending', 'approved', 'rejected', 'unblocked'].includes(record.status as string)) {
    malformed(operation, 'task_approval_status_invalid');
  }
  requireSha256Hex(operation, record.planDigest, 'task_evidence_digest_invalid');
  requireSha256HexOrNull(operation, record.codeDigest, 'task_evidence_digest_invalid');
  if (!Array.isArray(record.artifactRefs) || !Array.isArray(record.decisionArtifactRefs)) {
    malformed(operation, 'task_approval_refs_invalid');
  }
  for (const ref of record.artifactRefs as unknown[]) validateTaskApprovalArtifactRefWire(operation, ref);
  for (const ref of record.decisionArtifactRefs as unknown[]) validateTaskApprovalArtifactRefWire(operation, ref);
  requireNonEmptyString(operation, record.createdBy, 'task_approval_invalid');
  if (record.decision !== null && !['approve', 'reject', 'unblock'].includes(record.decision as string)) {
    malformed(operation, 'task_approval_decision_invalid');
  }
  if (record.decisionActor !== null) requireNonEmptyString(operation, record.decisionActor, 'task_approval_invalid');
  if (record.decisionReason !== null && typeof record.decisionReason !== 'string') {
    malformed(operation, 'task_approval_invalid');
  }
  requireSha256HexOrNull(operation, record.decisionCodeDigest, 'task_evidence_digest_invalid');
  if (record.decidedAt !== null && !isIsoUtcDateTime(record.decidedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  requirePositiveInteger(operation, record.revision);
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  // 决定绑定：pending 无决定；已决定必须同时有决定主体与时间（与持久 CHECK 同源）。
  const hasDecision = record.decision !== null;
  if (hasDecision !== (record.status !== 'pending') || hasDecision !== (record.decisionActor !== null) || hasDecision !== (record.decidedAt !== null)) {
    malformed(operation, 'task_approval_decision_binding_invalid');
  }
}

/** execution.task.approvals.list：独立人审事项分页（冻结字段集）。 */
export function validateTaskApprovalItemListResultWire(
  value: unknown,
  operation: HostOperation = 'execution.task.approvals.list',
): TaskApprovalItemListResult {
  const object = validateScheduleResultCommon(operation, value, 'task-approval-item-list');
  for (const record of object.records as unknown[]) {
    validateTaskApprovalItemWire(operation, record);
  }
  return object as unknown as TaskApprovalItemListResult;
}

function validateReworkCodeAccountingWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['classification', 'outcome', 'observationDigest', 'countsAsCodeAttempt']);
  if (record.classification !== null && !(TASK_CODE_ACCOUNTING_CLASSIFICATIONS as readonly unknown[]).includes(record.classification)) {
    malformed(operation, 'rework_accounting_invalid');
  }
  if (record.outcome !== null && !(CODE_ATTEMPT_OUTCOMES as readonly unknown[]).includes(record.outcome)) {
    malformed(operation, 'rework_accounting_invalid');
  }
  requireSha256HexOrNull(operation, record.observationDigest, 'task_evidence_digest_invalid');
  if (typeof record.countsAsCodeAttempt !== 'boolean') {
    malformed(operation, 'rework_accounting_invalid');
  }
  // 基础设施错误不消耗代码资格；只有 code 分类才折算为代码额度消耗。
  if (record.countsAsCodeAttempt !== (record.classification === 'code')) {
    malformed(operation, 'rework_accounting_mismatch');
  }
}

function validatePublicReworkAttemptWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'number',
    'runId',
    'status',
    'executionStage',
    'executionVersion',
    'inputRef',
    'codeRef',
    'diagnosticRef',
    'errorKind',
    'startedAt',
    'endedAt',
    'durationMs',
    'exitCode',
    'codeAccounting',
  ]);
  requireStableId(operation, record.id);
  requirePositiveInteger(operation, record.number);
  requireStableId(operation, record.runId);
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'rework_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(record.executionStage)) {
    malformed(operation, 'rework_attempt_stage_invalid');
  }
  requireNonNegativeInteger(operation, record.executionVersion);
  requireStableId(operation, record.inputRef);
  requireStableIdOrNull(operation, record.codeRef);
  requireStableIdOrNull(operation, record.diagnosticRef);
  if (record.errorKind !== null) requireNonEmptyString(operation, record.errorKind, 'rework_attempt_invalid');
  if (record.startedAt !== null && !isIsoUtcDateTime(record.startedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (record.endedAt !== null && !isIsoUtcDateTime(record.endedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  // 未知退出码/耗时保持 null，绝不以 0 冒充。
  requireNonNegativeIntegerOrNull(operation, record.durationMs);
  requireIntegerOrNull(operation, record.exitCode);
  validateReworkCodeAccountingWire(operation, record.codeAccounting);
}

function validatePublicReworkRunWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['id', 'batchId', 'status', 'reason', 'startedAt', 'endedAt']);
  requireStableId(operation, record.id);
  requireStableId(operation, record.batchId);
  if (!(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'rework_run_status_invalid');
  }
  if (record.reason !== null && typeof record.reason !== 'string') {
    malformed(operation, 'rework_run_reason_invalid');
  }
  if (record.startedAt !== null && !isIsoUtcDateTime(record.startedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
  if (record.endedAt !== null && !isIsoUtcDateTime(record.endedAt)) {
    malformed(operation, 'task_evidence_date_invalid');
  }
}

function validateReworkBlockReasonWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['layer', 'layerId', 'reason', 'dimension', 'limit', 'used']);
  if (!['batch', 'run', 'task'].includes(record.layer as string)) {
    malformed(operation, 'rework_block_layer_invalid');
  }
  requireStableId(operation, record.layerId);
  if (!(EXECUTION_BUDGET_BLOCK_REASONS as readonly unknown[]).includes(record.reason)) {
    malformed(operation, 'rework_block_reason_invalid');
  }
  if (record.dimension !== undefined && typeof record.dimension !== 'string') {
    malformed(operation, 'rework_block_dimension_invalid');
  }
  if (record.limit !== undefined) requireNonNegativeInteger(operation, record.limit);
  if (record.used !== undefined && record.used !== null) {
    requireNonNegativeInteger(operation, record.used);
  }
}

function validateReworkChainSummaryWire(operation: HostOperation, value: unknown): void {
  const summary = requirePlain(operation, value);
  exactKeys(operation, summary, ['codeEligibility', 'attempts', 'run', 'budgetBlockReasons', 'blockedSuccessors']);
  const eligibility = requirePlain(operation, summary.codeEligibility);
  exactKeys(operation, eligibility, ['used', 'limit', 'remaining', 'rule']);
  requireNonNegativeInteger(operation, eligibility.used);
  requireNonNegativeInteger(operation, eligibility.limit);
  requireNonNegativeInteger(operation, eligibility.remaining);
  requireNonEmptyString(operation, eligibility.rule, 'rework_eligibility_rule_invalid');
  const attempts = requirePlain(operation, summary.attempts);
  exactKeys(operation, attempts, ['used', 'limit', 'remaining']);
  requireNonNegativeInteger(operation, attempts.used);
  if (attempts.limit !== null) requireNonNegativeInteger(operation, attempts.limit);
  if (attempts.remaining !== null) requireNonNegativeInteger(operation, attempts.remaining);
  if (summary.run !== null) validatePublicReworkRunWire(operation, summary.run);
  if (!Array.isArray(summary.budgetBlockReasons) || !Array.isArray(summary.blockedSuccessors)) {
    malformed(operation, 'rework_summary_invalid');
  }
  for (const reason of summary.budgetBlockReasons as unknown[]) {
    validateReworkBlockReasonWire(operation, reason);
  }
  for (const successor of summary.blockedSuccessors as unknown[]) {
    const record = requirePlain(operation, successor);
    exactKeys(operation, record, ['taskId', 'status', 'reason']);
    requireStableId(operation, record.taskId);
    if (!(TASK_STATUSES as readonly unknown[]).includes(record.status)) {
      malformed(operation, 'rework_successor_status_invalid');
    }
    if (!(TASK_DAG_REASONS as readonly unknown[]).includes(record.reason)) {
      malformed(operation, 'rework_successor_reason_invalid');
    }
  }
}

/** execution.task.rework-chain.list：有限返工链分页 + 汇总（冻结字段集）。 */
export function validateTaskReworkChainResultWire(
  value: unknown,
  operation: HostOperation = 'execution.task.rework-chain.list',
): TaskReworkChainListResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit', 'summary']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'rework_schema_version_invalid');
  }
  if (object.scope !== 'task-rework-chain') {
    malformed(operation, 'rework_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'rework_records_invalid');
  }
  requirePlanCursorOrNull(operation, object.nextCursor);
  requirePositiveInteger(operation, object.limit);
  for (const record of object.records as unknown[]) {
    validatePublicReworkAttemptWire(operation, record);
  }
  validateReworkChainSummaryWire(operation, object.summary);
  return object as unknown as TaskReworkChainListResult;
}

/* ------------------------------------------------------------------ *
 * P03-8 / F-009 Git 意图/实际提交/操作回执查询响应线校验（冻结字段集）
 * ------------------------------------------------------------------ */

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function requireGitOid(operation: HostOperation, value: unknown): string {
  if (typeof value !== 'string' || !GIT_OID_PATTERN.test(value)) {
    malformed(operation, 'git_operation_oid_invalid');
  }
  return value;
}

function requireGitOidOrNull(operation: HostOperation, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireGitOid(operation, value);
}

function validateGitEvidenceRefsWire(operation: HostOperation, value: unknown): void {
  if (!Array.isArray(value)) {
    malformed(operation, 'git_operation_refs_invalid');
  }
  for (const entry of value as unknown[]) {
    const record = requirePlain(operation, entry);
    exactKeys(operation, record, ['kind', 'id', 'digest']);
    if (!(GIT_OPERATION_EVIDENCE_KINDS as readonly unknown[]).includes(record.kind)) {
      malformed(operation, 'git_operation_ref_kind_invalid');
    }
    requireStableId(operation, record.id);
    requireSha256Hex(operation, record.digest, 'git_operation_digest_invalid');
  }
}

function validateGitIdentityWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['name', 'email', 'confirmed']);
  requireNonEmptyString(operation, record.name, 'git_identity_invalid');
  requireNonEmptyString(operation, record.email, 'git_identity_invalid');
  // 用户身份来源：恒为用户明确配置并确认的提交身份（绝不回落全局身份）。
  if (record.confirmed !== true) {
    malformed(operation, 'git_identity_unconfirmed');
  }
}

function validateGitRuntimeSourceWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, ['runtime', 'provider', 'model', 'source']);
  requireNonEmptyString(operation, record.runtime, 'git_runtime_source_invalid');
  requireNonEmptyString(operation, record.provider, 'git_runtime_source_invalid');
  requireNonEmptyString(operation, record.model, 'git_runtime_source_invalid');
  const source = requirePlain(operation, record.source);
  exactKeys(operation, source, ['kind', 'sourceKey']);
  if (source.kind !== 'global_default' && source.kind !== 'project_default') {
    malformed(operation, 'git_runtime_source_invalid');
  }
  requireNonEmptyString(operation, source.sourceKey, 'git_runtime_source_invalid');
}

function validateGitOperationReceiptWire(
  operation: HostOperation,
  value: unknown,
): Record<string, unknown> {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'schemaVersion',
    'operationId',
    'status',
    'intentDigest',
    'expectedHead',
    'candidateTree',
    'actualCommit',
    'actualTree',
    'exitCode',
    'durationMs',
    'reasonCode',
    'integrationResult',
    'recoveryState',
    'workspacePreserved',
    'deliveryStatus',
    'recordedAtUtcMs',
  ]);
  if (record.schemaVersion !== GIT_OPERATION_RECEIPT_SCHEMA_VERSION) {
    malformed(operation, 'git_receipt_schema_version_invalid');
  }
  if (!(GIT_OPERATION_TERMINAL_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'git_receipt_status_invalid');
  }
  requireStableId(operation, record.operationId);
  requireSha256Hex(operation, record.intentDigest, 'git_operation_digest_invalid');
  requireGitOid(operation, record.expectedHead);
  requireGitOid(operation, record.candidateTree);
  requireGitOidOrNull(operation, record.actualCommit);
  requireGitOidOrNull(operation, record.actualTree);
  requireNonNegativeIntegerOrNull(operation, record.exitCode);
  requireNonNegativeIntegerOrNull(operation, record.durationMs);
  if (
    record.reasonCode !== null &&
    (typeof record.reasonCode !== 'string' || !GIT_REASON_CODE_PATTERN.test(record.reasonCode))
  ) {
    malformed(operation, 'git_operation_reason_invalid');
  }
  if (!(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(record.deliveryStatus)) {
    malformed(operation, 'git_delivery_status_invalid');
  }
  requireNonNegativeInteger(operation, record.recordedAtUtcMs);
  if (record.integrationResult !== undefined && record.integrationResult !== null) {
    validateGitIntegrationResultWire(operation, record.integrationResult);
  }
  if (record.recoveryState !== undefined && record.recoveryState !== null && !['none', 'resumable', 'preserved', 'cleaned', 'quarantined'].includes(record.recoveryState as string)) malformed(operation, 'integration_recovery_invalid');
  if (record.workspacePreserved !== undefined && typeof record.workspacePreserved !== 'boolean') malformed(operation, 'integration_preserved_invalid');
  return record;
}

function validateGitIntegrationResultWire(operation: HostOperation, value: unknown): Record<string, unknown> {
  const result = requirePlain(operation, value);
  exactKeys(operation, result, ['commitSha', 'treeSha', 'inputDigest', 'verificationEvidence']);
  requireGitOidOrNull(operation, result.commitSha);
  requireGitOidOrNull(operation, result.treeSha);
  requireSha256Hex(operation, result.inputDigest, 'integration_digest_invalid');
  if (result.verificationEvidence !== null) {
    const evidence = requirePlain(operation, result.verificationEvidence);
    exactKeys(operation, evidence, ['evidenceId', 'evidenceDigest']);
    requireStableId(operation, evidence.evidenceId);
    requireSha256Hex(operation, evidence.evidenceDigest, 'integration_evidence_invalid');
  }
  return result;
}

/** 公开 Git 操作记录（冻结字段集 + 与持久 CHECK 同源的生命周期不变量）。 */
function validateGitIntegrationWire(operation: HostOperation, value: unknown): Record<string, unknown> {
  const view = requirePlain(operation, value);
  exactKeys(operation, view, ['integrationId', 'targetBase', 'inputDigest', 'approvedInputs',
    'mergeOrder', 'verificationScope', 'predecessors', 'result', 'recoveryState', 'workspacePreserved']);
  requireStableId(operation, view.integrationId);
  requireGitOid(operation, view.targetBase);
  requireSha256Hex(operation, view.inputDigest, 'integration_digest_invalid');
  if (!Array.isArray(view.approvedInputs) || view.approvedInputs.length > 4096) malformed(operation, 'integration_inputs_invalid');
  for (const raw of view.approvedInputs as unknown[]) {
    const input = requirePlain(operation, raw);
    exactKeys(operation, input, ['inputId', 'digest']);
    requireStableId(operation, input.inputId);
    requireSha256Hex(operation, input.digest, 'integration_digest_invalid');
  }
  requireStringArrayWire(operation, view.mergeOrder, 'integration_order_invalid');
  requireStringArrayWire(operation, view.verificationScope, 'integration_scope_invalid');
  if (!Array.isArray(view.predecessors) || view.predecessors.length > 128) malformed(operation, 'integration_predecessors_invalid');
  for (const raw of view.predecessors as unknown[]) {
    const predecessor = requirePlain(operation, raw);
    exactKeys(operation, predecessor, ['featureId', 'commitSha', 'coveredInputIds']);
    requireStableId(operation, predecessor.featureId);
    requireGitOidOrNull(operation, predecessor.commitSha);
    requireStringArrayWire(operation, predecessor.coveredInputIds, 'integration_coverage_invalid');
  }
  if (view.recoveryState !== null && !['none', 'resumable', 'preserved', 'cleaned', 'quarantined'].includes(view.recoveryState as string)) malformed(operation, 'integration_recovery_invalid');
  if (typeof view.workspacePreserved !== 'boolean') malformed(operation, 'integration_preserved_invalid');
  if (view.result !== null) {
    const result = validateGitIntegrationResultWire(operation, view.result);
    if (result.inputDigest !== view.inputDigest) malformed(operation, 'integration_digest_mismatch');
  }
  return view;
}

function validatePublicGitOperationWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'operationId',
    'projectId',
    'featureId',
    'runId',
    'attemptId',
    'executionVersion',
    'operationType',
    'intentDigest',
    'repositoryBindingId',
    'repoIdentity',
    'expectedHead',
    'candidateTree',
    'codeDigest',
    'actualCommit',
    'actualTree',
    'actualParent',
    'verificationRefs',
    'approvalRefs',
    'message',
    'gitIdentity',
    'deliveryPolicyDigest',
    'runtimeSource',
    'status',
    'exitCode',
    'durationMs',
    'reasonCode',
    'deliveryStatus',
    'receipt',
    'integration',
    'settledAt',
    'revision',
    'createdAt',
    'updatedAt',
  ]);
  requireStableId(operation, record.operationId);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.runId);
  requireStableIdOrNull(operation, record.attemptId);
  requirePositiveInteger(operation, record.executionVersion);
  const integrationOperation = record.operationType === 'integration' || record.operationType === 'integration_commit';
  if (record.operationType !== 'feature_final_commit' && record.operationType !== 'task_commit' && !integrationOperation) {
    malformed(operation, 'git_operation_type_invalid');
  }
  if (integrationOperation) {
    const integration = validateGitIntegrationWire(operation, record.integration);
    if (integration.integrationId !== record.operationId) malformed(operation, 'integration_identity_invalid');
    if (integration.result !== null) {
      const facts = integration.result as Record<string, unknown>;
      if (facts.commitSha !== record.actualCommit || facts.treeSha !== record.actualTree) malformed(operation, 'integration_result_mismatch');
    }
  } else if (record.integration !== undefined && record.integration !== null) {
    malformed(operation, 'git_operation_type_invalid');
  }
  if (record.operationType === 'task_commit' && record.attemptId === null) {
    malformed(operation, 'git_operation_type_invalid');
  }
  requireSha256Hex(operation, record.intentDigest, 'git_operation_digest_invalid');
  requireStableId(operation, record.repositoryBindingId);
  requireNonEmptyString(operation, record.repoIdentity, 'git_operation_repo_invalid');
  requireGitOid(operation, record.expectedHead);
  requireGitOid(operation, record.candidateTree);
  requireSha256Hex(operation, record.codeDigest, 'git_operation_digest_invalid');
  requireGitOidOrNull(operation, record.actualCommit);
  requireGitOidOrNull(operation, record.actualTree);
  requireGitOidOrNull(operation, record.actualParent);
  validateGitEvidenceRefsWire(operation, record.verificationRefs);
  validateGitEvidenceRefsWire(operation, record.approvalRefs);
  requireNonEmptyString(operation, record.message, 'git_operation_message_invalid');
  validateGitIdentityWire(operation, record.gitIdentity);
  requireSha256Hex(operation, record.deliveryPolicyDigest, 'git_operation_digest_invalid');
  if (record.runtimeSource !== null) {
    validateGitRuntimeSourceWire(operation, record.runtimeSource);
  }
  if (!(GIT_OPERATION_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'git_operation_status_invalid');
  }
  requireNonNegativeIntegerOrNull(operation, record.exitCode);
  requireNonNegativeIntegerOrNull(operation, record.durationMs);
  if (
    record.reasonCode !== null &&
    (typeof record.reasonCode !== 'string' || !GIT_REASON_CODE_PATTERN.test(record.reasonCode))
  ) {
    malformed(operation, 'git_operation_reason_invalid');
  }
  if (
    record.deliveryStatus !== null &&
    !(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(record.deliveryStatus)
  ) {
    malformed(operation, 'git_delivery_status_invalid');
  }
  if (record.settledAt !== null && !isIsoUtcDateTime(record.settledAt)) {
    malformed(operation, 'git_operation_date_invalid');
  }
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'git_operation_date_invalid');
  }
  requirePositiveInteger(operation, record.revision);
  // 生命周期不变量（与持久 CHECK 同源）：pending 回执缺失且无终态事实；
  // 终态必须携带回执/deliveryStatus/settledAt；待核对绝不显示为成功。
  if (record.status === 'pending') {
    if (
      record.receipt !== null ||
      record.deliveryStatus !== null ||
      record.settledAt !== null ||
      record.actualCommit !== null ||
      record.actualTree !== null ||
      record.actualParent !== null ||
      record.exitCode !== null ||
      record.durationMs !== null ||
      record.reasonCode !== null
    ) {
      malformed(operation, 'git_operation_pending_facts_invalid');
    }
    return;
  }
  if (record.receipt === null || record.deliveryStatus === null || record.settledAt === null) {
    malformed(operation, 'git_operation_terminal_facts_invalid');
  }
  const taskCommit = record.operationType === 'task_commit' || integrationOperation;
  if (record.status === 'unknown') {
    if (
      record.actualCommit !== null ||
      record.actualTree !== null ||
      record.actualParent !== null ||
      record.deliveryStatus !== (taskCommit ? 'not_requested' : 'pending')
    ) {
      malformed(operation, 'git_operation_unknown_facts_invalid');
    }
  } else if (record.status === 'succeeded') {
    if (
      record.actualCommit === null ||
      record.actualTree === null ||
      (!integrationOperation && record.actualTree !== record.candidateTree) ||
      record.actualParent !== record.expectedHead ||
      record.deliveryStatus !== (taskCommit ? 'not_requested' : 'succeeded')
    ) {
      malformed(operation, 'git_operation_succeeded_facts_invalid');
    }
  } else if (record.status === 'no_change') {
    if (
      record.actualCommit !== record.expectedHead ||
      record.actualTree === null ||
      record.actualParent !== null ||
      record.deliveryStatus !== (taskCommit ? 'not_requested' : 'succeeded')
    ) {
      malformed(operation, 'git_operation_no_change_facts_invalid');
    }
  } else if (record.deliveryStatus !== (taskCommit ? 'not_requested' : 'failed') || record.actualParent !== null) {
    malformed(operation, 'git_operation_failed_facts_invalid');
  }
  const receipt = validateGitOperationReceiptWire(operation, record.receipt);
  if (
    receipt.operationId !== record.operationId ||
    receipt.status !== record.status ||
    receipt.intentDigest !== record.intentDigest ||
    receipt.expectedHead !== record.expectedHead ||
    receipt.candidateTree !== record.candidateTree ||
    receipt.actualCommit !== record.actualCommit ||
    receipt.actualTree !== record.actualTree ||
    receipt.exitCode !== record.exitCode ||
    receipt.durationMs !== record.durationMs ||
    receipt.reasonCode !== record.reasonCode ||
    receipt.deliveryStatus !== record.deliveryStatus
  ) {
    malformed(operation, 'git_operation_receipt_mismatch');
  }
}

/** git.operations.list：Git 意图/实际提交/回执分页（冻结字段集）。 */
export function validateGitOperationListResultWire(
  value: unknown,
  operation: HostOperation = 'git.operations.list',
): GitOperationListResult {
  const object = validateScheduleResultCommon(operation, value, 'git-operation-list');
  for (const record of object.records as unknown[]) {
    validatePublicGitOperationWire(operation, record);
  }
  return object as unknown as GitOperationListResult;
}

/** git.operations.get：单次操作完整意图 + 实际事实 + 回执（冻结字段集）。 */
export function validateGitOperationDetailResultWire(
  value: unknown,
  operation: HostOperation = 'git.operations.get',
): GitOperationDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['operation']);
  validatePublicGitOperationWire(operation, object.operation);
  return object as unknown as GitOperationDetailResult;
}

/* ------------------------------------------------------------------ *
 * P03-8 / F-010 Feature 分轴结果查询响应线校验（冻结字段集精确键校验；
 * completed outcome 不掩盖其他轴失败：completed 恒 executionStage null）
 * ------------------------------------------------------------------ */

function validateFeatureDeliveryTaskResultWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'taskId',
    'status',
    'effectivePassed',
    'manualBlock',
    'firstPassedAt',
    'latestAttemptId',
  ]);
  requireStableId(operation, record.taskId);
  if (!(TASK_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'feature_delivery_task_status_invalid');
  }
  if (typeof record.effectivePassed !== 'boolean' || typeof record.manualBlock !== 'boolean') {
    malformed(operation, 'feature_delivery_task_invalid');
  }
  // 有效通过恒等于持久 status==='passed'（机器绿色不折算的线协议同源约束）。
  if (record.effectivePassed !== (record.status === 'passed')) {
    malformed(operation, 'feature_delivery_task_effective_invalid');
  }
  if (record.firstPassedAt !== null && !isIsoUtcDateTime(record.firstPassedAt)) {
    malformed(operation, 'feature_delivery_date_invalid');
  }
  requireStableIdOrNull(operation, record.latestAttemptId);
}

/** F-010/F-014：Task/最终检查/审批/交付四轴公共线校验（结果查询与恢复诊断复用）。 */
function validateFeatureDeliveryAxesWire(operation: HostOperation, value: unknown): void {
  const axes = requirePlain(operation, value);
  exactKeys(operation, axes, ['tasks', 'verification', 'approval', 'delivery']);
  const tasks = requirePlain(operation, axes.tasks);
  exactKeys(operation, tasks, ['total', 'passed', 'allPassed', 'records']);
  const tasksTotal = requireNonNegativeInteger(operation, tasks.total);
  const tasksPassed = requireNonNegativeInteger(operation, tasks.passed);
  if (typeof tasks.allPassed !== 'boolean' || !Array.isArray(tasks.records)) {
    malformed(operation, 'feature_delivery_tasks_invalid');
  }
  if (
    (tasks.records as unknown[]).length !== tasksTotal ||
    tasksPassed > tasksTotal ||
    tasks.allPassed !== (tasksTotal > 0 && tasksPassed === tasksTotal)
  ) {
    malformed(operation, 'feature_delivery_tasks_invalid');
  }
  for (const record of tasks.records as unknown[]) {
    validateFeatureDeliveryTaskResultWire(operation, record);
  }
  const verification = requirePlain(operation, axes.verification);
  exactKeys(operation, verification, ['status', 'batch']);
  if (!(FEATURE_VERIFICATION_AXIS_STATUSES as readonly unknown[]).includes(verification.status)) {
    malformed(operation, 'feature_delivery_verification_status_invalid');
  }
  if (verification.batch === null) {
    if (verification.status !== 'none') {
      malformed(operation, 'feature_delivery_verification_invalid');
    }
  } else {
    validateVerificationBatchWire(operation, verification.batch);
    const batch = verification.batch as { status: string };
    if (verification.status !== batch.status) {
      malformed(operation, 'feature_delivery_verification_invalid');
    }
  }
  const approval = requirePlain(operation, axes.approval);
  exactKeys(operation, approval, ['status', 'reason', 'items', 'itemsTruncated']);
  if (!(FEATURE_APPROVAL_AXIS_STATUSES as readonly unknown[]).includes(approval.status)) {
    malformed(operation, 'feature_delivery_approval_status_invalid');
  }
  if (approval.reason !== null && typeof approval.reason !== 'string') {
    malformed(operation, 'feature_delivery_reason_invalid');
  }
  if (typeof approval.itemsTruncated !== 'boolean' || !Array.isArray(approval.items)) {
    malformed(operation, 'feature_delivery_approval_invalid');
  }
  for (const item of approval.items as unknown[]) {
    validateTaskApprovalItemWire(operation, item);
  }
  const delivery = requirePlain(operation, axes.delivery);
  exactKeys(operation, delivery, ['status', 'operation']);
  if (!(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(delivery.status)) {
    malformed(operation, 'feature_delivery_status_invalid');
  }
  if (delivery.operation !== null) {
    validatePublicGitOperationWire(operation, delivery.operation);
  }
}

export function validateGitAgentRepairQueryResultWire(
  value: unknown,
  operation: HostOperation = 'git.repairs.get',
): GitAgentRepairListResult | GitAgentRepairDetailResult {
  const root = requirePlain(operation, value);
  exactKeys(operation, root, operation === 'git.repairs.list'
    ? ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']
    : ['schemaVersion', 'repair']);
  const checkRecord = (value: unknown): void => {
    const record = requirePlain(operation, value);
    exactKeys(operation, record, ['repairId', 'projectId', 'featureId', 'parentBatchId', 'sourceOperationId', 'runId', 'authorizationDigest', 'authorizationVersion', 'blockedReason', 'source', 'target', 'workspaceId', 'conflictFiles', 'writablePaths', 'intentId', 'verificationStrategyId', 'budget', 'attempts', 'sourceOperation', 'candidateOperation']);
    const source = requirePlain(operation, record.source);
    exactKeys(operation, source, ['failureKind', 'evidenceId', 'inputDigest']);
    const target = requirePlain(operation, record.target);
    exactKeys(operation, target, ['repoIdentity', 'baselineCommitSha']);
    const budget = requirePlain(operation, record.budget);
    exactKeys(operation, budget, ['remainingAttempts', 'remainingTokens', 'remainingRuntimeMs', 'deadline']);
    if (!Array.isArray(record.conflictFiles) || !Array.isArray(record.writablePaths) || !Array.isArray(record.attempts)) malformed(operation, 'git_repair_record_malformed');
    for (const path of [...record.conflictFiles, ...record.writablePaths]) {
      if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\\\') || path.includes('..')) malformed(operation, 'git_repair_path_invalid');
    }
    for (const attemptValue of record.attempts) {
      const attempt = requirePlain(operation, attemptValue);
      exactKeys(operation, attempt, ['attemptId', 'runId', 'status', 'changedPaths', 'consumedTokens', 'runtimeMs', 'failureCode', 'startedAt', 'stoppedAt']);
      if (!Array.isArray(attempt.changedPaths)) malformed(operation, 'git_repair_attempt_malformed');
    }
    if (record.sourceOperation !== null) validatePublicGitOperationWire(operation, record.sourceOperation);
    if (record.candidateOperation !== null) validatePublicGitOperationWire(operation, record.candidateOperation);
  };
  if (operation === 'git.repairs.get') checkRecord(root.repair);
  else {
    if (root.scope !== 'git-repair-list' || !Array.isArray(root.records)) malformed(operation, 'git_repair_list_malformed');
    for (const record of root.records) checkRecord(record);
  }
  try {
    return validateCoreGitAgentRepairQueryResult(value, operation === 'git.repairs.list' ? 'git.repairs.list' : 'git.repairs.get');
  } catch {
    malformed(operation, 'git_repair_query_malformed');
  }
}

function validateIntegrationPlanQueryResultWire(
  value: unknown,
  operation: HostOperation = 'integration.plan.get',
): IntegrationPlanQueryResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'integration', 'predecessors', 'integrationResult', 'outcome']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') unsupportedVersion(operation, 'schemaVersion');
    malformed(operation, 'integration_plan_schema_version_invalid');
  }
  if (object.scope !== 'integration-plan') malformed(operation, 'integration_plan_scope_invalid');
  const integration = requirePlain(operation, object.integration);
  exactKeys(operation, integration, ['integrationId', 'projectId', 'phaseId', 'batchId', 'successorFeatureId', 'mode', 'status', 'inputDigest', 'targetBaseline', 'mergeOrder', 'verificationScope', 'strategySummary', 'coverage', 'blockReasons', 'staleReasons', 'revision', 'createdAt', 'updatedAt', 'frozenAt']);
  for (const key of ['integrationId', 'projectId', 'phaseId', 'batchId', 'successorFeatureId']) requireStableId(operation, integration[key]);
  if (!(INTEGRATION_PLAN_MODES as readonly unknown[]).includes(integration.mode)) malformed(operation, 'integration_plan_mode_invalid');
  if (!(INTEGRATION_PLAN_STATUSES as readonly unknown[]).includes(integration.status)) malformed(operation, 'integration_plan_status_invalid');
  requireSha256Hex(operation, integration.inputDigest, 'integration_plan_digest_invalid');
  if (typeof integration.targetBaseline !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(integration.targetBaseline)) malformed(operation, 'integration_plan_baseline_invalid');
  requireStringArrayWire(operation, integration.mergeOrder, 'integration_plan_order_invalid');
  requireStringArrayWire(operation, integration.verificationScope, 'integration_plan_scope_items_invalid');
  requirePlain(operation, integration.strategySummary);
  const coverage = requirePlain(operation, integration.coverage);
  exactKeys(operation, coverage, ['approvedInputCount', 'coveredInputCount', 'complete', 'missingInputIds']);
  requirePositiveInteger(operation, coverage.approvedInputCount);
  if (typeof coverage.coveredInputCount !== 'number' || coverage.coveredInputCount < 0 || !Number.isSafeInteger(coverage.coveredInputCount) || typeof coverage.complete !== 'boolean') malformed(operation, 'integration_plan_coverage_invalid');
  requireStringArrayWire(operation, coverage.missingInputIds, 'integration_plan_missing_inputs_invalid');
  if (!Array.isArray(integration.blockReasons) || !integration.blockReasons.every(reason => typeof reason === 'string') || !Array.isArray(integration.staleReasons) || !integration.staleReasons.every(reason => typeof reason === 'string')) malformed(operation, 'integration_plan_reasons_invalid');
  requirePositiveInteger(operation, integration.revision);
  if (!isIsoUtcDateTime(integration.createdAt) || !isIsoUtcDateTime(integration.updatedAt) || (integration.frozenAt !== null && !isIsoUtcDateTime(integration.frozenAt))) malformed(operation, 'integration_plan_time_invalid');
  if (!Array.isArray(object.predecessors) || object.predecessors.length > 128) malformed(operation, 'integration_plan_predecessors_invalid');
  for (const raw of object.predecessors as unknown[]) {
    const predecessor = requirePlain(operation, raw);
    exactKeys(operation, predecessor, ['featureId', 'dependencyPassed', 'commitSha', 'evidenceId', 'evidenceDigest', 'coveredInputIds', 'ancestorVerified']);
    requireStableId(operation, predecessor.featureId);
    if (typeof predecessor.dependencyPassed !== 'boolean' || typeof predecessor.ancestorVerified !== 'boolean') malformed(operation, 'integration_plan_predecessor_invalid');
    if (predecessor.commitSha !== null && (typeof predecessor.commitSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(predecessor.commitSha))) malformed(operation, 'integration_plan_commit_invalid');
    if (predecessor.evidenceId !== null) requireStableId(operation, predecessor.evidenceId);
    if (predecessor.evidenceDigest !== null) requireSha256Hex(operation, predecessor.evidenceDigest, 'integration_plan_evidence_invalid');
    requireStringArrayWire(operation, predecessor.coveredInputIds, 'integration_plan_covered_inputs_invalid');
  }
  if (object.integrationResult !== null) {
    const result = requirePlain(operation, object.integrationResult);
    exactKeys(operation, result, ['commitSha', 'treeSha', 'verificationEvidence', 'operationStatus']);
    for (const key of ['commitSha', 'treeSha']) if (result[key] !== null && (typeof result[key] !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result[key]))) malformed(operation, 'integration_plan_result_oid_invalid');
    if (result.verificationEvidence !== null) {
      const evidence = requirePlain(operation, result.verificationEvidence);
      exactKeys(operation, evidence, ['evidenceId', 'evidenceDigest']);
      requireStableId(operation, evidence.evidenceId);
      requireSha256Hex(operation, evidence.evidenceDigest, 'integration_plan_result_evidence_invalid');
    }
    if (result.operationStatus !== null && !['pending', 'succeeded', 'failed', 'unknown'].includes(result.operationStatus as string)) malformed(operation, 'integration_plan_operation_status_invalid');
  }
  const outcome = requirePlain(operation, object.outcome);
  exactKeys(operation, outcome, ['status', 'reason', 'blockReasons', 'staleReasons', 'nextStep']);
  if (!(INTEGRATION_PLAN_STATUSES as readonly unknown[]).includes(outcome.status) || typeof outcome.reason !== 'string' || !(INTEGRATION_PLAN_NEXT_STEPS as readonly unknown[]).includes(outcome.nextStep)) malformed(operation, 'integration_plan_outcome_invalid');
  if (!Array.isArray(outcome.blockReasons) || !Array.isArray(outcome.staleReasons)) malformed(operation, 'integration_plan_outcome_reasons_invalid');
  return object as unknown as IntegrationPlanQueryResult;
}

/** Batch delivery uses the existing v5 envelope and a frozen, bounded projection. */
export function validateBatchDeliveryResultWire(value: unknown, operation: HostOperation = 'execution.batch.delivery.get'): PublicBatchDeliveryResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'batch', 'records', 'summary', 'currentRunningCount', 'readyCount', 'resourceWaitingCount', 'stopOperations', 'integrations', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) unsupportedVersion(operation, 'schemaVersion');
  if (object.scope !== 'batch-delivery') malformed(operation, 'batch_delivery_scope_invalid');
  if (!isBatchDeliveryPublicSummary(object)) malformed(operation, 'batch_delivery_private_content');
  const enumeration = (v: unknown, values: readonly unknown[]) => { if (!values.includes(v)) malformed(operation, 'batch_delivery_enum_invalid'); };
  const array = (v: unknown): unknown[] => { if (!Array.isArray(v) || v.length > 1000) malformed(operation, 'batch_delivery_array_invalid'); return v; };
  const ids = (v: unknown): string[] => {
    const result = array(v).map(id => requireStableId(operation, id));
    if (new Set(result).size !== result.length) malformed(operation, 'batch_delivery_duplicate_identity');
    return result;
  };
  const text = (v: unknown) => { if (typeof v !== 'string' || v.length === 0 || v.length > 512 || /(?:Bearer\s|\/Users\/|\/home\/|[A-Za-z]:\\|(?:token|password|api[_-]?key)\s*[=:])/i.test(v)) malformed(operation, 'batch_delivery_text_invalid'); };
  const texts = (v: unknown) => array(v).forEach(text);
  const budget = (v: unknown) => {
    const b = requirePlain(operation, v);
    exactKeys(operation, b, ['status', 'blockingReasons', 'runsCreated', 'attemptsCreated', 'runtimeStarts', 'deadlineAt', 'tokenUsed', 'costUsed']);
    enumeration(b.status, ['available', 'exhausted', 'unknown']); texts(b.blockingReasons);
    for (const key of ['runsCreated', 'attemptsCreated', 'runtimeStarts', 'tokenUsed']) requireNonNegativeIntegerOrNull(operation, b[key]);
    requireUsageMeasureOrNull(operation, b.costUsed); requireIsoUtcOrNull(operation, b.deadlineAt);
  };
  const batch = requirePlain(operation, object.batch);
  exactKeys(operation, batch, ['id', 'projectId', 'phaseId', 'status', 'revision', 'featureIds', 'maxConcurrentFeatures', 'concurrencySource', 'deadlineAt', 'budget']);
  for (const key of ['id', 'projectId', 'phaseId']) requireStableId(operation, batch[key]);
  requirePositiveInteger(operation, batch.revision); enumeration(batch.status, EXECUTION_BATCH_STATUSES);
  const members = ids(batch.featureIds); if (members.length === 0) malformed(operation, 'batch_delivery_members_invalid');
  if (batch.maxConcurrentFeatures !== null) requirePositiveInteger(operation, batch.maxConcurrentFeatures);
  if (batch.concurrencySource !== null) text(batch.concurrencySource);
  requireIsoUtcOrNull(operation, batch.deadlineAt); budget(batch.budget);
  const stops = (v: unknown) => {
    const records = array(v); const seen = new Set<string>();
    for (const entry of records) {
      const s = requirePlain(operation, entry);
      exactKeys(operation, s, ['operationId', 'targetKind', 'targetId', 'status', 'reason', 'stopConfirmed', 'forced', 'evidenceRef', 'requestedAt', 'settledAt']);
      const id = requireStableId(operation, s.operationId); if (seen.has(id)) malformed(operation, 'batch_delivery_duplicate_identity'); seen.add(id);
      requireStableId(operation, s.targetId); enumeration(s.targetKind, ['run', 'batch', 'feature']); enumeration(s.status, ['stopping', 'stopped', 'uncertain']);
      if ((s.targetKind === 'batch' && s.targetId !== batch.id) || (s.targetKind === 'feature' && !members.includes(s.targetId as string))) malformed(operation, 'batch_delivery_stop_scope_invalid');
      text(s.reason); for (const key of ['stopConfirmed', 'forced']) if (s[key] !== null && typeof s[key] !== 'boolean') malformed(operation, 'batch_delivery_stop_invalid');
      if (s.evidenceRef !== null) text(s.evidenceRef);
      if (!isIsoUtcDateTime(s.requestedAt)) malformed(operation, 'batch_delivery_date_invalid'); requireIsoUtcOrNull(operation, s.settledAt);
    }
  };
  const integrations = (v: unknown, featureId?: string) => {
    const seen = new Set<string>();
    for (const entry of array(v)) {
      const i = requirePlain(operation, entry);
      exactKeys(operation, i, ['integrationId', 'successorFeatureId', 'status', 'blockReasons', 'staleReasons', 'commitSha', 'treeSha', 'evidenceRef']);
      const id = requireStableId(operation, i.integrationId); if (seen.has(id)) malformed(operation, 'batch_delivery_duplicate_identity'); seen.add(id);
      requireStableId(operation, i.successorFeatureId);
      if (!members.includes(i.successorFeatureId as string) || (featureId !== undefined && i.successorFeatureId !== featureId)) malformed(operation, 'batch_delivery_integration_scope_invalid');
      enumeration(i.status, ['dependency_passed', 'integration_passed', 'stale', 'blocked']); texts(i.blockReasons); texts(i.staleReasons);
      requireGitOidOrNull(operation, i.commitSha); requireGitOidOrNull(operation, i.treeSha); if (i.evidenceRef !== null) text(i.evidenceRef);
    }
  };
  const records = array(object.records); const seen = new Set<string>();
  requirePositiveInteger(operation, object.limit); if ((object.limit as number) > 200 || records.length > (object.limit as number)) malformed(operation, 'batch_delivery_page_invalid');
  for (const entry of records) {
    const r = requirePlain(operation, entry);
    exactKeys(operation, r, ['featureId', 'featureStatus', 'deliveryStatus', 'status', 'reason', 'failurePredecessors', 'blockingReasons', 'delivery', 'runs', 'integrations', 'stopOperations', 'budget', 'evidenceRefs']);
    const id = requireStableId(operation, r.featureId);
    if (!members.includes(id) || seen.has(id)) malformed(operation, 'batch_delivery_feature_scope_invalid'); seen.add(id);
    enumeration(r.featureStatus, FEATURE_STATUSES); enumeration(r.deliveryStatus, FEATURE_DELIVERY_STATUSES); enumeration(r.status, BATCH_DELIVERY_STATUSES);
    text(r.reason); texts(r.blockingReasons); texts(r.evidenceRefs);
    if (ids(r.failurePredecessors).some(id => !members.includes(id))) malformed(operation, 'batch_delivery_predecessor_invalid');
    const delivery = validateFeatureDeliveryDetailResultWire(r.delivery, operation);
    if (delivery.feature.featureId !== id || delivery.feature.status !== r.featureStatus || delivery.feature.deliveryStatus !== r.deliveryStatus || delivery.outcome.identities.featureId !== id
      || (delivery.run !== null && delivery.run.batchId !== batch.id)
      || delivery.axes.approval.items.some(item => item.projectId !== batch.projectId || item.featureId !== id)
      || (delivery.axes.verification.batch !== null && (delivery.axes.verification.batch.projectId !== batch.projectId || delivery.axes.verification.batch.featureId !== id))
      || (delivery.axes.delivery.operation !== null && (delivery.axes.delivery.operation.projectId !== batch.projectId || delivery.axes.delivery.operation.featureId !== id))) malformed(operation, 'batch_delivery_nested_scope_invalid');
    const runs = new Set<string>();
    for (const entry of array(r.runs)) {
      const run = requirePlain(operation, entry);
      exactKeys(operation, run, ['runId', 'featureId', 'status', 'reason', 'durationMs', 'startedAt', 'endedAt']);
      const runId = requireStableId(operation, run.runId); if (runs.has(runId) || run.featureId !== id) malformed(operation, 'batch_delivery_run_scope_invalid'); runs.add(runId);
      enumeration(run.status, EXECUTION_RUN_STATUSES); if (run.reason !== null) text(run.reason);
      requireNonNegativeIntegerOrNull(operation, run.durationMs); requireIsoUtcOrNull(operation, run.startedAt); requireIsoUtcOrNull(operation, run.endedAt);
    }
    integrations(r.integrations, id); stops(r.stopOperations); budget(r.budget);
  }
  const summary = requirePlain(operation, object.summary); exactKeys(operation, summary, BATCH_DELIVERY_STATUSES);
  for (const status of BATCH_DELIVERY_STATUSES) requireNonNegativeInteger(operation, summary[status]);
  if (Object.values(summary).reduce<number>((sum, count) => sum + (count as number), 0) !== members.length) malformed(operation, 'batch_delivery_summary_invalid');
  for (const key of ['currentRunningCount', 'readyCount', 'resourceWaitingCount']) {
    requireNonNegativeInteger(operation, object[key]); if ((object[key] as number) > members.length) malformed(operation, 'batch_delivery_count_invalid');
  }
  stops(object.stopOperations); integrations(object.integrations);
  if (object.nextCursor !== null && (typeof object.nextCursor !== 'string' || !object.nextCursor.startsWith(PLAN_LIST_CURSOR_PREFIX) || object.nextCursor.length > 4096 || records.length === 0)) malformed(operation, 'batch_delivery_cursor_invalid');
  return object as unknown as PublicBatchDeliveryResult;
}

/** features.delivery.get：Feature 分轴结果（冻结字段集）。 */
export function validateFeatureDeliveryDetailResultWire(
  value: unknown,
  operation: HostOperation = 'features.delivery.get',
): FeatureDeliveryDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'feature', 'run', 'axes', 'outcome']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'feature_delivery_schema_version_invalid');
  }
  if (object.scope !== 'feature-delivery') {
    malformed(operation, 'feature_delivery_scope_invalid');
  }
  const feature = requirePlain(operation, object.feature);
  exactKeys(operation, feature, [
    'featureId',
    'status',
    'deliveryStatus',
    'planStatus',
    'planDigest',
    'revision',
    'updatedAt',
  ]);
  requireStableId(operation, feature.featureId);
  if (!(FEATURE_STATUSES as readonly unknown[]).includes(feature.status)) {
    malformed(operation, 'feature_delivery_feature_status_invalid');
  }
  if (!(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(feature.deliveryStatus)) {
    malformed(operation, 'feature_delivery_status_invalid');
  }
  if (!(FEATURE_PLAN_STATUSES as readonly unknown[]).includes(feature.planStatus)) {
    malformed(operation, 'feature_delivery_plan_status_invalid');
  }
  requireSha256HexOrNull(operation, feature.planDigest, 'feature_delivery_digest_invalid');
  requirePositiveInteger(operation, feature.revision);
  if (!isIsoUtcDateTime(feature.updatedAt)) {
    malformed(operation, 'feature_delivery_date_invalid');
  }
  if (object.run !== null) {
    const run = requirePlain(operation, object.run);
    exactKeys(operation, run, ['id', 'batchId', 'status', 'reason', 'startedAt', 'endedAt']);
    requireStableId(operation, run.id);
    requireStableId(operation, run.batchId);
    if (!(EXECUTION_BATCH_STATUSES as readonly unknown[]).includes(run.status)) {
      malformed(operation, 'feature_delivery_run_status_invalid');
    }
    if (run.reason !== null && typeof run.reason !== 'string') {
      malformed(operation, 'feature_delivery_reason_invalid');
    }
    if (run.startedAt !== null && !isIsoUtcDateTime(run.startedAt)) {
      malformed(operation, 'feature_delivery_date_invalid');
    }
    if (run.endedAt !== null && !isIsoUtcDateTime(run.endedAt)) {
      malformed(operation, 'feature_delivery_date_invalid');
    }
  }
  validateFeatureDeliveryAxesWire(operation, object.axes);
  const outcomeRecord = requirePlain(operation, object.outcome);
  exactKeys(operation, outcomeRecord, ['status', 'executionStage', 'reason', 'nextStep', 'identities']);
  if (!(FEATURE_DELIVERY_OUTCOMES as readonly unknown[]).includes(outcomeRecord.status)) {
    malformed(operation, 'feature_delivery_outcome_invalid');
  }
  if (
    outcomeRecord.executionStage !== null &&
    !(FEATURE_DELIVERY_STAGES as readonly unknown[]).includes(outcomeRecord.executionStage)
  ) {
    malformed(operation, 'feature_delivery_stage_invalid');
  }
  // completed 不携带失败阶段；completed 之外必须定位失败阶段。
  if ((outcomeRecord.status === 'completed') !== (outcomeRecord.executionStage === null)) {
    malformed(operation, 'feature_delivery_stage_invalid');
  }
  requireNonEmptyString(operation, outcomeRecord.reason, 'feature_delivery_reason_invalid');
  if (!(FEATURE_DELIVERY_NEXT_STEPS as readonly unknown[]).includes(outcomeRecord.nextStep)) {
    malformed(operation, 'feature_delivery_next_step_invalid');
  }
  const identities = requirePlain(operation, outcomeRecord.identities);
  exactKeys(operation, identities, [
    'featureId',
    'runId',
    'batchId',
    'verificationBatchId',
    'gitOperationId',
  ]);
  requireStableId(operation, identities.featureId);
  requireStableIdOrNull(operation, identities.runId);
  requireStableIdOrNull(operation, identities.batchId);
  requireStableIdOrNull(operation, identities.verificationBatchId);
  requireStableIdOrNull(operation, identities.gitOperationId);
  return object as unknown as FeatureDeliveryDetailResult;
}

/* ------------------------------------------------------------------ *
 * P03-8 / F-011 feature.verification.continue 命令回执 result 线校验
 *（冻结字段集精确键校验；命令回执与 Git 操作回执分开，outcome 非
 * completed 不是交付成功；绝不携带原生路径、Git 身份或 Runtime 调用）
 * ------------------------------------------------------------------ */

/** feature.verification.continue completed 回执 result（冻结字段集）。 */
export interface FeatureDeliveryCommandResult {
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly gitOperationId: string;
  /** 收尾总体结果：completed 之外（含 awaiting_approval）都不是交付成功。 */
  readonly outcome: 'completed' | 'partial' | 'failed' | 'awaiting_approval';
  readonly reason: string;
  readonly deliveryStatus: (typeof FEATURE_DELIVERY_STATUSES)[number];
  readonly runtimeCalled: false;
  readonly executionStarted: false;
}

export function validateFeatureDeliveryCommandResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): FeatureDeliveryCommandResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'featureId',
    'runId',
    'batchId',
    'gitOperationId',
    'outcome',
    'reason',
    'deliveryStatus',
    'runtimeCalled',
    'executionStarted',
  ]);
  requireStableId(operation, object.featureId);
  requireStableId(operation, object.runId);
  requireStableId(operation, object.batchId);
  requireStableId(operation, object.gitOperationId);
  if (
    !['completed', 'partial', 'failed', 'awaiting_approval'].includes(object.outcome as string)
  ) {
    malformed(operation, 'delivery_outcome_invalid');
  }
  requireNonEmptyString(operation, object.reason, 'delivery_reason_invalid');
  if (!(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(object.deliveryStatus)) {
    malformed(operation, 'git_delivery_status_invalid');
  }
  // 显式收尾不调用 Runtime、不启动新执行。
  if (object.runtimeCalled !== false || object.executionStarted !== false) {
    malformed(operation, 'delivery_execution_boundary_invalid');
  }
  return object as unknown as FeatureDeliveryCommandResult;
}

export interface IntegrationStartCommandResult {
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly gitOperationId: string;
  readonly outcome: 'merging' | 'pending_verification' | 'blocked' | 'unknown';
  readonly reason: string | null;
  readonly deliveryStatus: null;
  readonly runtimeCalled: false;
  readonly executionStarted: true;
}

export function validateIntegrationStartCommandResultWire(value: unknown, operation: HostOperation = 'commands.submit'): IntegrationStartCommandResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['featureId', 'runId', 'batchId', 'gitOperationId', 'outcome', 'reason', 'deliveryStatus', 'runtimeCalled', 'executionStarted']);
  for (const key of ['featureId', 'runId', 'batchId', 'gitOperationId']) requireStableId(operation, object[key]);
  if (!['merging', 'pending_verification', 'blocked', 'unknown'].includes(object.outcome as string)) malformed(operation, 'integration_start_outcome_invalid');
  if (object.reason !== null && typeof object.reason !== 'string') malformed(operation, 'integration_start_reason_invalid');
  if (object.deliveryStatus !== null || object.runtimeCalled !== false || object.executionStarted !== true) malformed(operation, 'integration_start_execution_boundary_invalid');
  return object as unknown as IntegrationStartCommandResult;
}

export interface IntegrationReconcileCommandResult {
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly gitOperationId: string;
  readonly outcome: 'pending' | 'matched' | 'blocked' | 'unknown';
  readonly reason: string;
  readonly deliveryStatus: (typeof FEATURE_DELIVERY_STATUSES)[number] | null;
  readonly runtimeCalled: false;
  readonly executionStarted: false;
}

export function validateIntegrationReconcileCommandResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): IntegrationReconcileCommandResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'featureId', 'runId', 'batchId', 'gitOperationId', 'outcome', 'reason',
    'deliveryStatus', 'runtimeCalled', 'executionStarted',
  ]);
  requireStableId(operation, object.featureId);
  requireStableId(operation, object.runId);
  requireStableId(operation, object.batchId);
  requireStableId(operation, object.gitOperationId);
  if (!['pending', 'matched', 'blocked', 'unknown'].includes(object.outcome as string)) {
    malformed(operation, 'integration_reconcile_outcome_invalid');
  }
  if (object.deliveryStatus !== null && !(FEATURE_DELIVERY_STATUSES as readonly unknown[]).includes(object.deliveryStatus)) {
    malformed(operation, 'integration_reconcile_delivery_status_invalid');
  }
  requireNonEmptyString(operation, object.reason, 'integration_reconcile_reason_invalid');
  if (object.runtimeCalled !== false || object.executionStarted !== false) {
    malformed(operation, 'integration_reconcile_execution_boundary_invalid');
  }
  return object as unknown as IntegrationReconcileCommandResult;
}

/* ------------------------------------------------------------------ *
 * P03-7 / F-014 人审事项决定/阻塞与显式验证继续命令回执结果线校验
 *（冻结字段集精确键校验；命令结果的 item 是持久事项记录（毫秒时间戳形态），
 * 与查询面的公开投影（ISO 时间）分开冻结，不互相折算）
 * ------------------------------------------------------------------ */

/** 命令回执 result.item：持久 Task approval item 记录（冻结字段集）。 */
export interface TaskApprovalItemRecordWire {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly kind: 'block' | 'approval';
  readonly description: string;
  readonly responsibleParty: string;
  readonly planDigest: string;
  readonly codeDigest: string | null;
  readonly artifactRefs: readonly PublicTaskApprovalArtifactRef[];
  readonly status: 'pending' | 'approved' | 'rejected' | 'unblocked';
  readonly createdBy: string;
  readonly decision: 'approve' | 'reject' | 'unblock' | null;
  readonly decisionActor: string | null;
  readonly decisionReason: string | null;
  readonly decisionCodeDigest: string | null;
  readonly decisionArtifactRefs: readonly PublicTaskApprovalArtifactRef[];
  readonly decidedAtUtcMs: number | null;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
}

function validateTaskApprovalItemRecordWire(
  operation: HostOperation,
  value: unknown,
): TaskApprovalItemRecordWire {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'taskId',
    'revision',
    'kind',
    'description',
    'responsibleParty',
    'planDigest',
    'codeDigest',
    'artifactRefs',
    'status',
    'createdBy',
    'decision',
    'decisionActor',
    'decisionReason',
    'decisionCodeDigest',
    'decisionArtifactRefs',
    'decidedAtUtcMs',
    'createdAtUtcMs',
    'updatedAtUtcMs',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.taskId);
  requirePositiveInteger(operation, record.revision);
  if (record.kind !== 'block' && record.kind !== 'approval') {
    malformed(operation, 'task_approval_kind_invalid');
  }
  requireNonEmptyString(operation, record.description, 'task_approval_invalid');
  requireNonEmptyString(operation, record.responsibleParty, 'task_approval_invalid');
  requireSha256Hex(operation, record.planDigest, 'task_evidence_digest_invalid');
  requireSha256HexOrNull(operation, record.codeDigest, 'task_evidence_digest_invalid');
  if (!Array.isArray(record.artifactRefs) || !Array.isArray(record.decisionArtifactRefs)) {
    malformed(operation, 'task_approval_refs_invalid');
  }
  for (const ref of record.artifactRefs as unknown[]) validateTaskApprovalArtifactRefWire(operation, ref);
  for (const ref of record.decisionArtifactRefs as unknown[]) validateTaskApprovalArtifactRefWire(operation, ref);
  if (!['pending', 'approved', 'rejected', 'unblocked'].includes(record.status as string)) {
    malformed(operation, 'task_approval_status_invalid');
  }
  requireNonEmptyString(operation, record.createdBy, 'task_approval_invalid');
  if (record.decision !== null && !['approve', 'reject', 'unblock'].includes(record.decision as string)) {
    malformed(operation, 'task_approval_decision_invalid');
  }
  if (record.decisionActor !== null) requireNonEmptyString(operation, record.decisionActor, 'task_approval_invalid');
  if (record.decisionReason !== null && typeof record.decisionReason !== 'string') {
    malformed(operation, 'task_approval_invalid');
  }
  requireSha256HexOrNull(operation, record.decisionCodeDigest, 'task_evidence_digest_invalid');
  if (record.decidedAtUtcMs !== null) requireNonNegativeInteger(operation, record.decidedAtUtcMs);
  requireNonNegativeInteger(operation, record.createdAtUtcMs);
  requireNonNegativeInteger(operation, record.updatedAtUtcMs);
  // 决定绑定：pending 无决定；已决定必须同时有决定主体与时间（与持久 CHECK 同源）。
  const hasDecision = record.decision !== null;
  if (
    hasDecision !== (record.status !== 'pending') ||
    hasDecision !== (record.decisionActor !== null) ||
    hasDecision !== (record.decidedAtUtcMs !== null)
  ) {
    malformed(operation, 'task_approval_decision_binding_invalid');
  }
  return record as unknown as TaskApprovalItemRecordWire;
}

/** task.approval.block completed 结果（添加阻塞/必需审批事项）。 */
export interface TaskApprovalBlockResult {
  readonly taskId: string;
  readonly manualBlock: true;
  readonly revision: number;
  readonly item: TaskApprovalItemRecordWire;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
}

export function validateTaskApprovalBlockResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): TaskApprovalBlockResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['taskId', 'manualBlock', 'revision', 'item', 'planDigest', 'checkPolicyDigest']);
  requireStableId(operation, object.taskId);
  if (object.manualBlock !== true) {
    malformed(operation, 'task_approval_block_result_invalid');
  }
  requirePositiveInteger(operation, object.revision);
  validateTaskApprovalItemRecordWire(operation, object.item);
  requireSha256Hex(operation, object.planDigest, 'task_evidence_digest_invalid');
  requireSha256Hex(operation, object.checkPolicyDigest, 'task_evidence_digest_invalid');
  return object as unknown as TaskApprovalBlockResult;
}

/** task.approval.approve/reject/unblock completed 结果（只写事项决定事实）。 */
export interface TaskApprovalDecisionResult {
  readonly taskId: string;
  readonly item: TaskApprovalItemRecordWire;
  readonly decision: 'approve' | 'reject' | 'unblock';
  readonly executionStarted: false;
  readonly runtimeCalled: false;
}

export function validateTaskApprovalDecisionResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): TaskApprovalDecisionResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['taskId', 'item', 'decision', 'executionStarted', 'runtimeCalled']);
  requireStableId(operation, object.taskId);
  validateTaskApprovalItemRecordWire(operation, object.item);
  if (!['approve', 'reject', 'unblock'].includes(object.decision as string)) {
    malformed(operation, 'task_approval_decision_invalid');
  }
  // 决定命令绝不启动执行/调用 Runtime：回执必须明确携带两个 false。
  if (object.executionStarted !== false || object.runtimeCalled !== false) {
    malformed(operation, 'task_approval_execution_boundary_invalid');
  }
  return object as unknown as TaskApprovalDecisionResult;
}

/** task.verification.continue completed 结果（显式验证继续；零新增编码调用）。 */
export interface TaskVerificationContinueResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly verificationBatchId: string;
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly status: string | null;
  readonly waitingFor: 'approval' | 'verification_not_assembled' | 'recording_required' | 'execution_uncertain' | null;
  readonly reason: string | null;
  readonly runtimeCalled: false;
  readonly executionStarted: false;
}

export function validateTaskVerificationContinueResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): TaskVerificationContinueResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'taskId',
    'attemptId',
    'verificationBatchId',
    'disposition',
    'status',
    'waitingFor',
    'reason',
    'runtimeCalled',
    'executionStarted',
  ]);
  requireStableId(operation, object.taskId);
  requireStableId(operation, object.attemptId);
  requireStableId(operation, object.verificationBatchId);
  if (!['applied', 'replayed', 'ignored'].includes(object.disposition as string)) {
    malformed(operation, 'verification_continue_disposition_invalid');
  }
  if (object.status !== null && !(ATTEMPT_STATUSES as readonly unknown[]).includes(object.status)) {
    malformed(operation, 'verification_continue_status_invalid');
  }
  if (
    object.waitingFor !== null &&
    !['approval', 'verification_not_assembled', 'recording_required', 'execution_uncertain'].includes(
      object.waitingFor as string,
    )
  ) {
    malformed(operation, 'verification_continue_waiting_invalid');
  }
  if (object.reason !== null && typeof object.reason !== 'string') {
    malformed(operation, 'verification_continue_reason_invalid');
  }
  // 显式继续只复用已保存机器证据：绝不调用 Runtime、绝不启动新执行。
  if (object.runtimeCalled !== false || object.executionStarted !== false) {
    malformed(operation, 'verification_continue_execution_boundary_invalid');
  }
  return object as unknown as TaskVerificationContinueResult;
}

/* ------------------------------------------------------------------ *
 * P03-5 / F-012 工作区状态查询与人工丢弃预览/确认线校验
 *（冻结字段集精确键校验；公开投影不含绝对路径与内部身份哈希）
 * ------------------------------------------------------------------ */

const COMMIT_HEX_PATTERN = /^[0-9a-f]{40}$/;
const WORKSPACE_CURSOR_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;

function requireCommitHex(operation: HostOperation, value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_HEX_PATTERN.test(value)) {
    malformed(operation, 'workspace_commit_invalid');
  }
  return value;
}

function requireCommitHexOrNull(operation: HostOperation, value: unknown): string | null {
  return value === null ? null : requireCommitHex(operation, value);
}

function requireWorkspaceCursorOrNull(operation: HostOperation, value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    !value.startsWith(WORKSPACE_LIST_CURSOR_PREFIX) ||
    !WORKSPACE_CURSOR_BODY_PATTERN.test(value.slice(WORKSPACE_LIST_CURSOR_PREFIX.length))
  ) {
    malformed(operation, 'workspace_cursor_invalid');
  }
  return value;
}

/** 公开工作区记录（PublicWorkspaceRecord）：剔除路径/内部哈希后的冻结字段集。 */
function validatePublicWorkspaceRecordWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'runId',
    'attemptId',
    'preparationOperationId',
    'status',
    'revision',
    'branch',
    'baseCommit',
    'headCommit',
    'codeDigest',
    'repositoryBindingId',
    'repositoryBindingRevision',
    'ownerId',
    'hostInstanceId',
    'executionVersion',
    'createdAt',
    'updatedAt',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.runId);
  requireStableId(operation, record.attemptId);
  requireStableId(operation, record.preparationOperationId);
  if (!(WORKSPACE_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'workspace_status_invalid');
  }
  requirePositiveInteger(operation, record.revision);
  requireNonEmptyString(operation, record.branch, 'workspace_branch_invalid');
  requireCommitHex(operation, record.baseCommit);
  requireCommitHexOrNull(operation, record.headCommit);
  requireSha256HexOrNull(operation, record.codeDigest, 'workspace_digest_invalid');
  requireStableId(operation, record.repositoryBindingId);
  requirePositiveInteger(operation, record.repositoryBindingRevision);
  requireStableId(operation, record.ownerId);
  requireStableId(operation, record.hostInstanceId);
  requireNonNegativeInteger(operation, record.executionVersion);
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'workspace_date_invalid');
  }
}

/** operation 结果投影：已知耗时/退出信息保留，未知保持 null（不填零）。 */
function validateWorkspaceOperationResultWire(operation: HostOperation, value: unknown): void {
  const result = requirePlain(operation, value);
  exactKeys(operation, result, [
    'evidenceRefs',
    'errorRef',
    'startedAt',
    'endedAt',
    'durationMs',
    'exitCode',
    'signal',
  ]);
  if (!Array.isArray(result.evidenceRefs)) {
    malformed(operation, 'workspace_operation_result_invalid');
  }
  for (const evidenceRef of result.evidenceRefs) {
    requireStableId(operation, evidenceRef);
  }
  if (result.errorRef !== null) {
    requireStableId(operation, result.errorRef);
  }
  requireIsoUtcOrNull(operation, result.startedAt);
  requireIsoUtcOrNull(operation, result.endedAt);
  requireNonNegativeIntegerOrNull(operation, result.durationMs);
  if (result.exitCode !== null) {
    if (typeof result.exitCode !== 'number' || !Number.isSafeInteger(result.exitCode)) {
      malformed(operation, 'workspace_operation_result_invalid');
    }
  }
  if (result.signal !== null && typeof result.signal !== 'string') {
    malformed(operation, 'workspace_operation_result_invalid');
  }
}

/**
 * 公开工作区 operation 记录（PublicWorkspaceOperationRecord）：用户命令身份
 * （principalId/commandId）与当前 receipt 投影分层；receipt.reason 只从持久
 * 回执结果白名单解析，缺失为 null，绝不回显正文/路径。
 */
function validatePublicWorkspaceOperationRecordWire(operation: HostOperation, value: unknown): void {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id',
    'projectId',
    'featureId',
    'workspaceId',
    'runId',
    'attemptId',
    'kind',
    'executionStage',
    'status',
    'revision',
    'principalId',
    'commandId',
    'requestDigest',
    'result',
    'receipt',
    'createdAt',
    'updatedAt',
  ]);
  requireStableId(operation, record.id);
  requireStableId(operation, record.projectId);
  requireStableId(operation, record.featureId);
  requireStableId(operation, record.workspaceId);
  requireStableId(operation, record.runId);
  requireStableId(operation, record.attemptId);
  if (!(WORKSPACE_OPERATION_KINDS as readonly unknown[]).includes(record.kind)) {
    malformed(operation, 'workspace_operation_kind_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(record.executionStage)) {
    malformed(operation, 'workspace_operation_stage_invalid');
  }
  if (!(WORKSPACE_OPERATION_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'workspace_operation_status_invalid');
  }
  requirePositiveInteger(operation, record.revision);
  requireStableId(operation, record.principalId);
  if (!isUuidV4(record.commandId)) {
    malformed(operation, 'workspace_operation_command_invalid');
  }
  requireSha256Hex(operation, record.requestDigest, 'workspace_operation_digest_invalid');
  if (record.result !== null) {
    validateWorkspaceOperationResultWire(operation, record.result);
  }
  const receipt = requirePlain(operation, record.receipt);
  exactKeys(operation, receipt, ['commandId', 'resultRef', 'status', 'reason']);
  if (!isUuidV4(receipt.commandId)) {
    malformed(operation, 'workspace_operation_command_invalid');
  }
  if (receipt.resultRef !== null) {
    requireNonEmptyString(operation, receipt.resultRef, 'workspace_operation_receipt_invalid');
  }
  if (receipt.status !== 'completed' && receipt.status !== 'rejected') {
    malformed(operation, 'workspace_operation_receipt_invalid');
  }
  if (receipt.reason !== null && typeof receipt.reason !== 'string') {
    malformed(operation, 'workspace_operation_receipt_invalid');
  }
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'workspace_date_invalid');
  }
}

function validateWorkspaceListCommon(
  operation: HostOperation,
  value: unknown,
  expectedScope: 'workspace-list' | 'workspace-operation-list',
): Record<string, unknown> {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'workspace_list_version_invalid');
  }
  if (object.scope !== expectedScope) {
    malformed(operation, 'workspace_list_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'workspace_list_records_invalid');
  }
  requireWorkspaceCursorOrNull(operation, object.nextCursor);
  const limit = requirePositiveInteger(operation, object.limit);
  if (limit > WORKSPACE_LIST_MAX_LIMIT) {
    malformed(operation, 'workspace_list_limit_invalid');
  }
  return object;
}

/** workspaces.list：项目内受管工作区分页（wscur_v1_ 受控游标）。 */
export function validateWorkspaceListResultWire(
  value: unknown,
  operation: HostOperation = 'workspaces.list',
): WorkspaceListResult {
  const object = validateWorkspaceListCommon(operation, value, 'workspace-list');
  for (const record of object.records as unknown[]) {
    validatePublicWorkspaceRecordWire(operation, record);
  }
  return object as unknown as WorkspaceListResult;
}

/** workspaces.get：工作区 + 准备 operation + 最新 operation（缺失为 null）。 */
export function validateWorkspaceDetailResultWire(
  value: unknown,
  operation: HostOperation = 'workspaces.get',
): WorkspaceDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['workspace', 'preparationOperation', 'latestOperation']);
  validatePublicWorkspaceRecordWire(operation, object.workspace);
  if (object.preparationOperation !== null) {
    validatePublicWorkspaceOperationRecordWire(operation, object.preparationOperation);
  }
  if (object.latestOperation !== null) {
    validatePublicWorkspaceOperationRecordWire(operation, object.latestOperation);
  }
  return object as unknown as WorkspaceDetailResult;
}

/** workspace.operations.list：工作区 operation 审计分页（wscur_v1_ 受控游标）。 */
export function validateWorkspaceOperationListResultWire(
  value: unknown,
  operation: HostOperation = 'workspace.operations.list',
): WorkspaceOperationListResult {
  const object = validateWorkspaceListCommon(operation, value, 'workspace-operation-list');
  for (const record of object.records as unknown[]) {
    validatePublicWorkspaceOperationRecordWire(operation, record);
  }
  return object as unknown as WorkspaceOperationListResult;
}

/** workspace.operations.get：单次 operation 详情（含结果与当前回执投影）。 */
export function validateWorkspaceOperationDetailResultWire(
  value: unknown,
  operation: HostOperation = 'workspace.operations.get',
): WorkspaceOperationDetailResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['operation']);
  validatePublicWorkspaceOperationRecordWire(operation, object.operation);
  return object as unknown as WorkspaceOperationDetailResult;
}

/** 丢弃预览内容条目（有界清单；相对路径，state/protection 冻结词汇）。 */
function validateDiscardPreviewEntryWire(operation: HostOperation, value: unknown): void {
  const entry = requirePlain(operation, value);
  exactKeys(operation, entry, ['path', 'state', 'sizeBytes', 'protection']);
  requireNonEmptyString(operation, entry.path, 'discard_preview_entry_invalid');
  if (entry.state !== 'present' && entry.state !== 'deleted') {
    malformed(operation, 'discard_preview_entry_invalid');
  }
  requireNonNegativeIntegerOrNull(operation, entry.sizeBytes);
  if (entry.protection !== 'preserve' && entry.protection !== 'tracked') {
    malformed(operation, 'discard_preview_entry_invalid');
  }
}

const DISCARD_PREVIEW_PRESERVES = [
  'source_repository',
  'feature_branch',
  'committed_work',
  'audit_records',
] as const;

/**
 * workspace.discard.preview completed 回执 result（WorkspaceDiscardPreview）：
 * 只读预览 + 确认绑定（previewDigest/HEAD/内容摘要/revision/有效期）；
 * 不携带绝对路径；blockers 为冻结词汇。
 */
export function validateWorkspaceDiscardPreviewWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): WorkspaceDiscardPreview {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, [
    'schemaVersion',
    'projectId',
    'featureId',
    'workspaceId',
    'branch',
    'baseCommit',
    'status',
    'scope',
    'workspaceRevision',
    'headCommit',
    'codeDigest',
    'ignoredDigest',
    'expiresAtUtcMs',
    'previewDigest',
    'contents',
    'impact',
    'blockers',
    'observedAtUtcMs',
    'evidenceRef',
  ]);
  if (object.schemaVersion !== 1) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'discard_preview_version_invalid');
  }
  requireStableId(operation, object.projectId);
  requireStableId(operation, object.featureId);
  requireStableId(operation, object.workspaceId);
  requireNonEmptyString(operation, object.branch, 'discard_preview_branch_invalid');
  requireCommitHex(operation, object.baseCommit);
  if (!(WORKSPACE_STATUSES as readonly unknown[]).includes(object.status)) {
    malformed(operation, 'workspace_status_invalid');
  }
  if (object.scope !== WORKSPACE_DISCARD_SCOPE) {
    malformed(operation, 'discard_preview_scope_invalid');
  }
  requirePositiveInteger(operation, object.workspaceRevision);
  requireCommitHex(operation, object.headCommit);
  requireSha256Hex(operation, object.codeDigest, 'discard_preview_digest_invalid');
  requireSha256Hex(operation, object.ignoredDigest, 'discard_preview_digest_invalid');
  requireSha256Hex(operation, object.previewDigest, 'discard_preview_digest_invalid');
  requirePositiveInteger(operation, object.expiresAtUtcMs);
  requirePositiveInteger(operation, object.observedAtUtcMs);
  const contents = requirePlain(operation, object.contents);
  exactKeys(operation, contents, ['tracked', 'untracked', 'ignored', 'counts', 'truncated']);
  for (const key of ['tracked', 'untracked', 'ignored'] as const) {
    const entries = contents[key];
    if (!Array.isArray(entries)) {
      malformed(operation, 'discard_preview_contents_invalid');
    }
    for (const entry of entries) {
      validateDiscardPreviewEntryWire(operation, entry);
    }
  }
  const counts = requirePlain(operation, contents.counts);
  exactKeys(operation, counts, ['tracked', 'untracked', 'ignored', 'bytes']);
  requireNonNegativeInteger(operation, counts.tracked);
  requireNonNegativeInteger(operation, counts.untracked);
  requireNonNegativeInteger(operation, counts.ignored);
  requireNonNegativeInteger(operation, counts.bytes);
  if (typeof contents.truncated !== 'boolean') {
    malformed(operation, 'discard_preview_contents_invalid');
  }
  const impact = requirePlain(operation, object.impact);
  exactKeys(operation, impact, [
    'irreversible',
    'discardsUncommittedTrackedChanges',
    'discardsUntrackedFiles',
    'discardsIgnoredFiles',
    'discardsBytes',
    'preserves',
  ]);
  if (impact.irreversible !== true) {
    malformed(operation, 'discard_preview_impact_invalid');
  }
  requireNonNegativeInteger(operation, impact.discardsUncommittedTrackedChanges);
  requireNonNegativeInteger(operation, impact.discardsUntrackedFiles);
  requireNonNegativeInteger(operation, impact.discardsIgnoredFiles);
  requireNonNegativeInteger(operation, impact.discardsBytes);
  if (
    !Array.isArray(impact.preserves) ||
    impact.preserves.length !== DISCARD_PREVIEW_PRESERVES.length ||
    !DISCARD_PREVIEW_PRESERVES.every((preserve) => (impact.preserves as unknown[]).includes(preserve))
  ) {
    malformed(operation, 'discard_preview_impact_invalid');
  }
  if (!Array.isArray(object.blockers)) {
    malformed(operation, 'discard_preview_blockers_invalid');
  }
  for (const blocker of object.blockers) {
    if (!(WORKSPACE_DISCARD_BLOCKERS as readonly unknown[]).includes(blocker)) {
      malformed(operation, 'discard_preview_blockers_invalid');
    }
  }
  requireStableId(operation, object.evidenceRef);
  return object as unknown as WorkspaceDiscardPreview;
}

/**
 * workspace.discard completed 回执 result：确认命令已登记的用户回执摘要
 *（命令 completed ≠ 丢弃成功；实际删除结果经 workspace.operations 查询读取）。
 */
export function validateWorkspaceDiscardConfirmResultWire(
  value: unknown,
  operation: HostOperation = 'commands.submit',
): WorkspaceDiscardConfirmResult {
  const object = requirePlain(operation, value);
  exactKeys(operation, object, ['workspaceOperationId', 'workspaceId', 'previewDigest']);
  requireStableId(operation, object.workspaceOperationId);
  requireStableId(operation, object.workspaceId);
  requireSha256Hex(operation, object.previewDigest, 'discard_confirm_digest_invalid');
  return object as unknown as WorkspaceDiscardConfirmResult;
}

/** workspace.discard 用户回执 result 形状（脱敏摘要；不含路径/正文）。 */
export interface WorkspaceDiscardConfirmResult {
  readonly workspaceOperationId: string;
  readonly workspaceId: string;
  readonly previewDigest: string;
}

/* ------------------------------------------------------------------ *
 * P05-1 / F-012 规划上下文/候选查询线校验（冻结字段集精确键校验；候选
 * 生成前明确 pending_generation，不伪造空候选；决策/时间空值保持 null）
 * ------------------------------------------------------------------ */

export function validatePlanningDecisionResultWire(
  value: unknown,
  expected: { candidateId: string; candidateDigest: string; decision: 'approve' | 'reject' },
): void {
  const operation = 'commands.submit';
  const result = requirePlain(operation, value);
  if (result.decision !== expected.decision || result.candidateId !== expected.candidateId || result.candidateDigest !== expected.candidateDigest) {
    malformed(operation, 'planning_decision_identity_mismatch');
  }
  if (expected.decision === 'reject') {
    exactKeys(operation, result, ['decision', 'candidateId', 'candidateDigest', 'summary', 'planningContextStatus', 'applied']);
    if (typeof result.summary !== 'string' || result.planningContextStatus !== 'rejected' || result.applied !== false) malformed(operation, 'planning_decision_result_invalid');
    return;
  }
  exactKeys(operation, result, ['decision', 'candidateId', 'candidateDigest', 'feature', 'application', 'verification', 'approval']);
  const feature = requirePlain(operation, result.feature);
  exactKeys(operation, feature, ['id', 'revision', 'planDigest', 'planStatus']);
  requireStableId(operation, feature.id);
  requirePositiveInteger(operation, feature.revision);
  requireSha256Hex(operation, feature.planDigest, 'planning_decision_digest_invalid');
  if (feature.planStatus !== 'approved') malformed(operation, 'planning_decision_result_invalid');
  const application = requirePlain(operation, result.application);
  exactKeys(operation, application, ['createdTaskIds', 'keptTaskIds', 'removedTaskIds', 'planningContextStatus']);
  for (const key of ['createdTaskIds', 'keptTaskIds', 'removedTaskIds']) {
    for (const id of requireStringArrayWire(operation, application[key], 'planning_decision_result_invalid')) requireStableId(operation, id);
  }
  if (application.planningContextStatus !== 'applied' || !Array.isArray(result.verification)) malformed(operation, 'planning_decision_result_invalid');
  for (const value of result.verification as unknown[]) {
    const intent = requirePlain(operation, value);
    exactKeys(operation, intent, ['taskId', 'checkRefs', 'moduleRefs', 'impactScope']);
    requireStableId(operation, intent.taskId);
    for (const key of ['checkRefs', 'moduleRefs', 'impactScope']) requireStringArrayWire(operation, intent[key], 'planning_decision_result_invalid');
  }
  const approval = requirePlain(operation, result.approval);
  exactKeys(operation, approval, ['id', 'subjectDigest', 'checkPolicyDigest', 'status']);
  requireStableId(operation, approval.id);
  requireSha256Hex(operation, approval.subjectDigest, 'planning_decision_digest_invalid');
  requireSha256Hex(operation, approval.checkPolicyDigest, 'planning_decision_digest_invalid');
  if (approval.status !== 'approved' || approval.subjectDigest !== feature.planDigest) malformed(operation, 'planning_decision_result_invalid');
}

function requireIsoOrNull(operation: HostOperation, value: unknown, reason: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isIsoUtcDateTime(value)) {
    malformed(operation, reason);
  }
  return value as string;
}

function requireStringArrayWire(operation: HostOperation, value: unknown, reason: string): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    malformed(operation, reason);
  }
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length > 512) {
      malformed(operation, reason);
    }
  }
  return [...(value as string[])];
}

function validatePlanningCandidateRefWire(operation: HostOperation, value: unknown): void {
  const ref = requirePlain(operation, value);
  if (ref.state === 'pending_generation') {
    exactKeys(operation, ref, ['state']);
    return;
  }
  exactKeys(operation, ref, ['state', 'artifactId', 'contentHash', 'candidateDigest', 'summary']);
  if (ref.state !== 'published') {
    malformed(operation, 'planning_candidate_state_invalid');
  }
  requireStableId(operation, ref.artifactId);
  requireSha256Hex(operation, ref.contentHash, 'planning_candidate_digest_invalid');
  requireSha256Hex(operation, ref.candidateDigest, 'planning_candidate_digest_invalid');
  if (typeof ref.summary !== 'string' || [...ref.summary].length > PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS) {
    malformed(operation, 'planning_candidate_summary_invalid');
  }
}

function validatePlanningContextRecordWire(operation: HostOperation, value: unknown): PublicPlanningContextRecord {
  const record = requirePlain(operation, value);
  exactKeys(operation, record, [
    'id', 'projectId', 'phaseId', 'featureId', 'runId', 'planningTaskId', 'candidateId',
    'inputDigest', 'targetRevision', 'planDigest', 'status', 'candidate', 'decision',
    'planningTask', 'createdAt', 'updatedAt',
  ]);
  for (const key of ['id', 'projectId', 'phaseId', 'featureId', 'runId', 'planningTaskId', 'candidateId'] as const) {
    requireStableId(operation, record[key]);
  }
  requireSha256Hex(operation, record.inputDigest, 'planning_context_digest_invalid');
  requirePositiveInteger(operation, record.targetRevision);
  if (record.planDigest !== null) {
    requireSha256Hex(operation, record.planDigest, 'planning_context_digest_invalid');
  }
  if (!(PLANNING_CONTEXT_STATUSES as readonly unknown[]).includes(record.status)) {
    malformed(operation, 'planning_context_status_invalid');
  }
  validatePlanningCandidateRefWire(operation, record.candidate);
  if (record.decision !== null) {
    const decision = requirePlain(operation, record.decision);
    exactKeys(operation, decision, ['decision', 'reason', 'decidedAt', 'appliedRevision', 'appliedAt']);
    if (!(PLANNING_CONTEXT_DECISIONS as readonly unknown[]).includes(decision.decision)) {
      malformed(operation, 'planning_decision_invalid');
    }
    if (decision.reason !== null && (typeof decision.reason !== 'string' || decision.reason.length > 512)) {
      malformed(operation, 'planning_decision_invalid');
    }
    requireIsoOrNull(operation, decision.decidedAt, 'planning_decision_date_invalid');
    if (decision.appliedRevision !== null) {
      requirePositiveInteger(operation, decision.appliedRevision);
    }
    requireIsoOrNull(operation, decision.appliedAt, 'planning_decision_date_invalid');
  }
  const task = requirePlain(operation, record.planningTask);
  exactKeys(operation, task, ['id', 'status', 'strategy']);
  requireStableId(operation, task.id);
  if (!(TASK_STATUSES as readonly unknown[]).includes(task.status) || task.id !== record.planningTaskId) {
    malformed(operation, 'planning_task_summary_invalid');
  }
  const strategy = requirePlain(operation, task.strategy);
  exactKeys(operation, strategy, ['runtime', 'provider', 'model']);
  for (const key of ['runtime', 'provider', 'model'] as const) {
    if (typeof strategy[key] !== 'string' || (strategy[key] as string).length === 0) {
      malformed(operation, 'planning_task_summary_invalid');
    }
  }
  if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
    malformed(operation, 'planning_context_date_invalid');
  }
  const published = (record.candidate as Record<string, unknown>).state === 'published';
  if (record.status !== 'open' && record.status !== 'cancelled' && !published) malformed(operation, 'planning_context_candidate_mismatch');
  if ((record.status === 'applied' || record.status === 'rejected') !== (record.decision !== null)) malformed(operation, 'planning_context_decision_mismatch');
  if (record.decision !== null) {
    const decision = record.decision as Record<string, unknown>;
    if (decision.decidedAt === null || (record.status === 'applied'
      ? decision.decision !== 'approved' || decision.appliedRevision === null || decision.appliedAt === null
      : decision.decision !== 'rejected' || decision.appliedRevision !== null || decision.appliedAt !== null)) malformed(operation, 'planning_context_decision_mismatch');
  }
  return record as unknown as PublicPlanningContextRecord;
}

function validatePlanningRunRecordWire(operation: HostOperation, value: unknown): void {
  const run = requirePlain(operation, value);
  exactKeys(operation, run, [
    'id', 'batchId', 'purpose', 'status', 'reason', 'startedAt', 'endedAt',
    'pauseRequestedAt', 'attemptsCreated', 'maxAttemptsPerRun', 'runTimeLimitMs',
  ]);
  requireStableId(operation, run.id);
  requireStableId(operation, run.batchId);
  if (run.purpose !== 'plan') {
    malformed(operation, 'planning_run_purpose_invalid');
  }
  if (!(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(run.status)) {
    malformed(operation, 'planning_run_status_invalid');
  }
  if (run.reason !== null && typeof run.reason !== 'string') {
    malformed(operation, 'planning_run_reason_invalid');
  }
  requireIsoOrNull(operation, run.startedAt, 'planning_run_date_invalid');
  requireIsoOrNull(operation, run.endedAt, 'planning_run_date_invalid');
  requireIsoOrNull(operation, run.pauseRequestedAt, 'planning_run_date_invalid');
  requireNonNegativeInteger(operation, run.attemptsCreated);
  requirePositiveInteger(operation, run.maxAttemptsPerRun);
  requirePositiveInteger(operation, run.runTimeLimitMs);
}

function validatePlanningAttemptRecordWire(operation: HostOperation, value: unknown): void {
  const attempt = requirePlain(operation, value);
  exactKeys(operation, attempt, [
    'id', 'number', 'status', 'executionStage', 'startedAt', 'endedAt', 'exitCode', 'durationMs',
  ]);
  requireStableId(operation, attempt.id);
  requirePositiveInteger(operation, attempt.number);
  if (!(ATTEMPT_STATUSES as readonly unknown[]).includes(attempt.status)) {
    malformed(operation, 'planning_attempt_status_invalid');
  }
  if (!(ATTEMPT_EXECUTION_STAGES as readonly unknown[]).includes(attempt.executionStage)) {
    malformed(operation, 'planning_attempt_stage_invalid');
  }
  requireIsoOrNull(operation, attempt.startedAt, 'planning_attempt_date_invalid');
  requireIsoOrNull(operation, attempt.endedAt, 'planning_attempt_date_invalid');
  if (attempt.exitCode !== null) {
    requireIntegerOrNull(operation, attempt.exitCode);
  }
  if (attempt.durationMs !== null) {
    requireNonNegativeInteger(operation, attempt.durationMs);
  }
}

/** planning.contexts.list 响应：schemaVersion/scope/records/nextCursor/limit。 */
export function validatePlanningContextListResultWire(
  body: unknown,
  operation: HostOperation = 'planning.contexts.list',
): PlanningContextListResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'records', 'nextCursor', 'limit']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'planning_list_schema_version_invalid');
  }
  if (object.scope !== 'planning-context-list') {
    malformed(operation, 'planning_list_scope_invalid');
  }
  if (!Array.isArray(object.records)) {
    malformed(operation, 'planning_list_records_invalid');
  }
  for (const value of object.records as unknown[]) {
    const record = requirePlain(operation, value);
    exactKeys(operation, record, [
      'id', 'projectId', 'phaseId', 'featureId', 'runId', 'planningTaskId', 'candidateId',
      'status', 'candidateState', 'candidateDigest', 'decision', 'runStatus', 'createdAt', 'updatedAt',
    ]);
    for (const key of ['id', 'projectId', 'phaseId', 'featureId', 'runId', 'planningTaskId', 'candidateId'] as const) {
      requireStableId(operation, record[key]);
    }
    if (!(PLANNING_CONTEXT_STATUSES as readonly unknown[]).includes(record.status)) {
      malformed(operation, 'planning_context_status_invalid');
    }
    if (!(PLANNING_CANDIDATE_QUERY_STATES as readonly unknown[]).includes(record.candidateState)) {
      malformed(operation, 'planning_candidate_state_invalid');
    }
    if (record.candidateDigest !== null) {
      requireSha256Hex(operation, record.candidateDigest, 'planning_candidate_digest_invalid');
    }
    if (record.decision !== null && !(PLANNING_CONTEXT_DECISIONS as readonly unknown[]).includes(record.decision)) {
      malformed(operation, 'planning_decision_invalid');
    }
    if ((record.candidateState === 'published') !== (record.candidateDigest !== null)) malformed(operation, 'planning_candidate_digest_mismatch');
    if (record.runStatus !== null && !(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(record.runStatus)) {
      malformed(operation, 'planning_run_status_invalid');
    }
    if (!isIsoUtcDateTime(record.createdAt) || !isIsoUtcDateTime(record.updatedAt)) {
      malformed(operation, 'planning_context_date_invalid');
    }
  }
  requirePlanCursorOrNull(operation, object.nextCursor);
  requirePositiveInteger(operation, object.limit);
  return object as unknown as PlanningContextListResult;
}

/** planning.context.get 响应：上下文详情 + 展示状态 + 三轴 + Run/Attempt/预算。 */
export function validatePlanningContextDetailResultWire(
  body: unknown,
  operation: HostOperation = 'planning.context.get',
): PlanningContextDetailResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, [
    'schemaVersion', 'scope', 'context', 'executionState', 'outcomeAxes', 'run',
    'attempts', 'attemptsTruncated', 'budget',
  ]);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'planning_detail_schema_version_invalid');
  }
  if (object.scope !== 'planning-context') {
    malformed(operation, 'planning_detail_scope_invalid');
  }
  validatePlanningContextRecordWire(operation, object.context);
  if (!(PLANNING_QUERY_STATES as readonly unknown[]).includes(object.executionState)) {
    malformed(operation, 'planning_execution_state_invalid');
  }
  const axes = requirePlain(operation, object.outcomeAxes);
  exactKeys(operation, axes, ['runSucceeded', 'planApproved', 'codingExecutable', 'notExecutableReasons']);
  for (const key of ['runSucceeded', 'planApproved', 'codingExecutable'] as const) {
    if (typeof axes[key] !== 'boolean') {
      malformed(operation, 'planning_outcome_axes_invalid');
    }
  }
  if (!Array.isArray(axes.notExecutableReasons) || axes.notExecutableReasons.some(reason => !(FEATURE_NOT_EXECUTABLE_REASONS as readonly unknown[]).includes(reason))) {
    malformed(operation, 'planning_outcome_axes_invalid');
  }
  validatePlanningRunRecordWire(operation, object.run);
  if (!Array.isArray(object.attempts) || object.attempts.length > PLANNING_QUERY_DETAIL_ATTEMPTS_MAX_COUNT) {
    malformed(operation, 'planning_attempts_invalid');
  }
  for (const attempt of object.attempts as unknown[]) {
    validatePlanningAttemptRecordWire(operation, attempt);
  }
  if (typeof object.attemptsTruncated !== 'boolean') {
    malformed(operation, 'planning_attempts_invalid');
  }
  const budget = validateExecutionBudgetStatusResultWire(object.budget, operation);
  const context = object.context as PublicPlanningContextRecord;
  const run = object.run as PlanningContextDetailResult['run'];
  const attempts = object.attempts as PlanningContextDetailResult['attempts'];
  if (run.id !== context.runId || budget.batch.id !== run.batchId || budget.batch.projectId !== context.projectId
    || axes.runSucceeded !== (run.status === 'succeeded') || axes.codingExecutable !== (axes.notExecutableReasons.length === 0)
    || object.executionState !== derivePlanningQueryState({ contextStatus: context.status, runStatus: run.status, latestAttemptStatus: attempts.at(-1)?.status ?? null })) {
    malformed(operation, 'planning_detail_identity_mismatch');
  }
  return object as unknown as PlanningContextDetailResult;
}

/** planning.candidate.get 响应：上下文 + Run 状态 + 候选（正文/生成前形态）。 */
export function validatePlanningCandidateDetailResultWire(
  body: unknown,
  operation: HostOperation = 'planning.candidate.get',
): PlanningCandidateDetailResult {
  const object = requirePlain(operation, body);
  exactKeys(operation, object, ['schemaVersion', 'scope', 'context', 'runStatus', 'candidate']);
  if (object.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    if (typeof object.schemaVersion === 'number') {
      unsupportedVersion(operation, 'schemaVersion');
    }
    malformed(operation, 'planning_candidate_schema_version_invalid');
  }
  if (object.scope !== 'planning-candidate') {
    malformed(operation, 'planning_candidate_scope_invalid');
  }
  validatePlanningContextRecordWire(operation, object.context);
  if (!(EXECUTION_RUN_STATUSES as readonly unknown[]).includes(object.runStatus)) {
    malformed(operation, 'planning_run_status_invalid');
  }
  const candidate = requirePlain(operation, object.candidate);
  if (candidate.state === 'pending_generation') {
    exactKeys(operation, candidate, ['state']);
    if ((object.context as PublicPlanningContextRecord).candidate.state !== 'pending_generation') malformed(operation, 'planning_candidate_state_mismatch');
    return object as unknown as PlanningCandidateDetailResult;
  }
  exactKeys(operation, candidate, [
    'state', 'artifact', 'candidateDigest', 'summary', 'plan', 'taskVerification',
  ]);
  if (candidate.state !== 'published') {
    malformed(operation, 'planning_candidate_state_invalid');
  }
  const artifact = requirePlain(operation, candidate.artifact);
  exactKeys(operation, artifact, ['artifactId', 'contentHash', 'sizeBytes']);
  requireStableId(operation, artifact.artifactId);
  requireSha256Hex(operation, artifact.contentHash, 'planning_candidate_digest_invalid');
  requireNonNegativeInteger(operation, artifact.sizeBytes);
  requireSha256Hex(operation, candidate.candidateDigest, 'planning_candidate_digest_invalid');
  if (typeof candidate.summary !== 'string' || [...candidate.summary].length > PLANNING_CANDIDATE_SUMMARY_MAX_CODE_POINTS) {
    malformed(operation, 'planning_candidate_summary_invalid');
  }
  const plan = requirePlain(operation, candidate.plan);
  exactKeys(operation, plan, ['feature', 'tasks', 'taskCount', 'dependencyEdgeCount']);
  const feature = requirePlain(operation, plan.feature);
  exactKeys(operation, feature, ['title', 'description', 'labels']);
  if (typeof feature.title !== 'string' || feature.title.length === 0 || feature.title.length > 512) {
    malformed(operation, 'planning_candidate_plan_invalid');
  }
  if (feature.description !== null && typeof feature.description !== 'string') {
    malformed(operation, 'planning_candidate_plan_invalid');
  }
  requireStringArrayWire(operation, feature.labels, 'planning_candidate_plan_invalid');
  if (!Array.isArray(plan.tasks)) {
    malformed(operation, 'planning_candidate_plan_invalid');
  }
  for (const taskValue of plan.tasks as unknown[]) {
    const task = requirePlain(operation, taskValue);
    exactKeys(operation, task, ['id', 'title', 'complexity', 'dependsOn']);
    requireStableId(operation, task.id);
    if (typeof task.title !== 'string' || task.title.length === 0 || task.title.length > 512) {
      malformed(operation, 'planning_candidate_plan_invalid');
    }
    if (task.complexity !== null && !['low', 'medium', 'high'].includes(task.complexity as string)) {
      malformed(operation, 'planning_candidate_plan_invalid');
    }
    requireStringArrayWire(operation, task.dependsOn, 'planning_candidate_plan_invalid');
  }
  requireNonNegativeInteger(operation, plan.taskCount);
  requireNonNegativeInteger(operation, plan.dependencyEdgeCount);
  if (!Array.isArray(candidate.taskVerification)) {
    malformed(operation, 'planning_candidate_verification_invalid');
  }
  for (const intentValue of candidate.taskVerification as unknown[]) {
    const intent = requirePlain(operation, intentValue);
    exactKeys(operation, intent, ['taskId', 'checkRefs', 'moduleRefs', 'impactScope']);
    requireStableId(operation, intent.taskId);
    requireStringArrayWire(operation, intent.checkRefs, 'planning_candidate_verification_invalid');
    requireStringArrayWire(operation, intent.moduleRefs, 'planning_candidate_verification_invalid');
    requireStringArrayWire(operation, intent.impactScope, 'planning_candidate_verification_invalid');
  }
  const ref = (object.context as PublicPlanningContextRecord).candidate;
  if (ref.state !== 'published' || ref.artifactId !== artifact.artifactId || ref.contentHash !== artifact.contentHash
    || ref.candidateDigest !== candidate.candidateDigest || ref.summary !== candidate.summary) malformed(operation, 'planning_candidate_identity_mismatch');
  if (plan.taskCount !== plan.tasks.length || plan.dependencyEdgeCount !== (plan.tasks as { dependsOn: string[] }[]).reduce((count, task) => count + task.dependsOn.length, 0)) malformed(operation, 'planning_candidate_plan_counts_invalid');
  return object as unknown as PlanningCandidateDetailResult;
}

function validateProjectResourceQueryWire(operation: HostOperation, body: unknown): unknown {
  const object = requirePlain(operation, body);
  if (object.schemaVersion !== 1) throw new HostProtocolError('unsupported_schema_version', operation, '项目资源响应版本不受支持');
  if (typeof object.projectId !== 'string') malformed(operation, 'project_resource_identity_invalid');
  if (operation === 'project.resources.list') {
    exactKeys(operation, object, ['schemaVersion', 'projectId', 'revision', 'resources', 'digest']);
    if (typeof object.revision !== 'number' || !Number.isSafeInteger(object.revision) || object.revision < 0
      || !Array.isArray(object.resources) || object.resources.length > 64 || typeof object.digest !== 'string' || !/^[a-f0-9]{64}$/.test(object.digest)) malformed(operation, 'project_resource_configuration_invalid');
    if (object.resources.length > 0) {
      try { validateProjectResourceSettings({ schemaVersion: 1, projectId: object.projectId, resources: object.resources }, { operation }); }
      catch { malformed(operation, 'project_resource_configuration_invalid'); }
    }
    return object;
  }
  exactKeys(operation, object, operation === 'project.resources.preview'
    ? ['schemaVersion', 'projectId', 'entries', 'candidates', 'rejected', 'configurationChanged']
    : ['schemaVersion', 'projectId', 'sources', 'candidates', 'rejected', 'configurationChanged']);
  if (!Array.isArray(object.candidates) || object.candidates.length > 2048 || !Array.isArray(object.rejected) || object.rejected.length > 32 || object.configurationChanged !== false) {
    malformed(operation, 'project_resource_candidates_invalid');
  }
  for (const value of object.candidates) {
    const candidate = requirePlain(operation, value);
    const { metadata: rawMetadata, availability, ...identity } = candidate;
    if (availability !== 'available' && availability !== 'unverified') malformed(operation, 'project_resource_candidate_invalid');
    try {
      const parsed = validateProjectResourceCandidate(identity);
      if (parsed.projectId !== object.projectId || typeof identity.digest !== 'string' || identity.summary === undefined) malformed(operation, 'project_resource_candidate_invalid');
    } catch { malformed(operation, 'project_resource_candidate_invalid'); }
    const metadata = requirePlain(operation, rawMetadata);
    exactKeys(operation, metadata, ['description', 'promptSummary', 'toolNames']);
    if (![metadata.description, metadata.promptSummary].every(v => v === null || (typeof v === 'string' && v.length <= 4096))
      || !Array.isArray(metadata.toolNames) || metadata.toolNames.length > 128 || metadata.toolNames.some(v => typeof v !== 'string' || v.length > 128)) malformed(operation, 'project_resource_metadata_invalid');
  }
  const reasons = new Set<string>(PROJECT_RESOURCE_CANDIDATE_REASONS);
  for (const value of object.rejected) {
    const item = requirePlain(operation, value);
    exactKeys(operation, item, ['sourceId', 'reason']);
    requireStableId(operation, item.sourceId);
    if (typeof item.reason !== 'string' || !reasons.has(item.reason)) malformed(operation, 'project_resource_rejection_invalid');
  }
  if (operation === 'project.resources.preview') {
    if (!Array.isArray(object.entries) || object.entries.length > 2080) malformed(operation, 'project_resource_preview_invalid');
    for (const value of object.entries) {
      const entry = requirePlain(operation, value);
      exactKeys(operation, entry, ['sourceId', 'candidateId', 'name', 'status', 'reason']);
      requireStableId(operation, entry.sourceId);
      if (entry.candidateId !== null) requireStableId(operation, entry.candidateId);
      if (!(entry.name === null || typeof entry.name === 'string') || !['pending', 'selected', 'conflict', 'rejected'].includes(entry.status as string)
        || !(entry.reason === null || (typeof entry.reason === 'string' && (reasons.has(entry.reason) || ['already_selected', 'already_configured'].includes(entry.reason))))) malformed(operation, 'project_resource_preview_invalid');
    }
  } else {
    if (!Array.isArray(object.sources) || object.sources.length > 32) malformed(operation, 'project_resource_sources_invalid');
    for (const value of object.sources) {
      const source = requirePlain(operation, value);
      exactKeys(operation, source, ['sourceId', 'sourceDigest', 'status', 'candidateIds', 'error']);
      requireStableId(operation, source.sourceId);
      if (!Array.isArray(source.candidateIds) || source.candidateIds.length > 64) malformed(operation, 'project_resource_sources_invalid');
      source.candidateIds.forEach(id => requireStableId(operation, id));
      if (source.status === 'accepted') {
        if (typeof source.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceDigest) || source.error !== null) malformed(operation, 'project_resource_sources_invalid');
      } else if (source.status === 'rejected') {
        const error = requirePlain(operation, source.error);
        exactKeys(operation, error, ['reason']);
        if (source.sourceDigest !== null || source.candidateIds.length !== 0 || typeof error.reason !== 'string' || !reasons.has(error.reason)) malformed(operation, 'project_resource_sources_invalid');
      } else malformed(operation, 'project_resource_sources_invalid');
    }
  }
  return object;
}

/**
 * 按 §7.2/§8 冻结形状校验查询响应。schema 版本不符 → unsupported_schema_version；
 * 形状/字段/scope 不符 → response_malformed。不修改输入对象以外的任何状态。
 */
export function validateAppQueryResponse(
  operation: 'projects.profile.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectProfileQueryResult;
export function validateAppQueryResponse(
  operation: 'projects.profile.match',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectProfileMatchQueryResult;
export function validateAppQueryResponse(
  operation: 'execution.budget.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): ExecutionBudgetStatusResult;
export function validateAppQueryResponse(
  operation: 'execution.budget.revisions',
  body: unknown,
  expectation?: SnapshotExpectation,
): BudgetRevisionListResult;
export function validateAppQueryResponse(
  operation: 'baselines.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): BaselineListResult;

export function validateAppQueryResponse(
  operation: 'baselines.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): BaselineDetailResult;
// P03-1 / F-009 §6.6：计划域查询响应重载。
export function validateAppQueryResponse(operation: 'phases.graph.get', body: unknown, expectation?: SnapshotExpectation): PhaseGraphResult;
export function validateAppQueryResponse(
  operation: 'phases.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): PhaseListResult;
export function validateAppQueryResponse(
  operation: 'phases.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): PhaseDetailResult;
export function validateAppQueryResponse(
  operation: 'features.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): FeatureListResult;
export function validateAppQueryResponse(
  operation: 'features.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): FeatureDetailResult;
export function validateAppQueryResponse(
  operation: 'tasks.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): TaskListResult;
export function validateAppQueryResponse(
  operation: 'tasks.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): TaskDetailResult;
// P03-2 / F-007：审批决策查询响应重载。
export function validateAppQueryResponse(
  operation: 'features.approvals',
  body: unknown,
  expectation?: SnapshotExpectation,
): FeatureApprovalsResult;
// P03-4 / F-008：调度诊断与 Attempt 审计查询响应重载。
export function validateAppQueryResponse(
  operation: 'execution.run.schedule',
  body: unknown,
  expectation?: SnapshotExpectation,
): RunScheduleStatusResult;
export function validateAppQueryResponse(
  operation: 'execution.attempts.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): AttemptListResult;
export function validateAppQueryResponse(
  operation: 'execution.attempt.diagnostics',
  body: unknown,
  expectation?: SnapshotExpectation,
): AttemptDiagnosticsResult;
// P04-9 / F-009：派发队列与执行槽位只读投影响应重载。
export function validateAppQueryResponse(
  operation: 'execution.dispatch.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): DispatchQueueListResult;
export function validateAppQueryResponse(
  operation: 'execution.resources.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): ResourceListResult;
// P05-1 / F-012：规划上下文/候选查询响应重载。
export function validateAppQueryResponse(
  operation: 'planning.contexts.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): PlanningContextListResult;
export function validateAppQueryResponse(
  operation: 'planning.context.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): PlanningContextDetailResult;
export function validateAppQueryResponse(
  operation: 'planning.candidate.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): PlanningCandidateDetailResult;
// P03-7 / F-013：Task 证据/人审/返工链查询响应重载。
export function validateAppQueryResponse(
  operation: 'execution.task.verification.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): TaskVerificationDetailResult;
export function validateAppQueryResponse(
  operation: 'execution.task.approvals.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): TaskApprovalItemListResult;
export function validateAppQueryResponse(
  operation: 'execution.task.rework-chain.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): TaskReworkChainListResult;
// P03-5 / F-012：工作区状态只读查询响应重载。
export function validateAppQueryResponse(
  operation: 'workspaces.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): WorkspaceListResult;
// P03-8 / F-009：Git 意图/实际提交/操作回执查询响应重载。
export function validateAppQueryResponse(
  operation: 'git.operations.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): GitOperationListResult;
export function validateAppQueryResponse(
  operation: 'git.operations.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): GitOperationDetailResult;
export function validateAppQueryResponse(
  operation: 'integration.plan.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): IntegrationPlanQueryResult;
// P06-2：知识与记忆查询复用 Core 的同一线协议校验器。
export function validateAppQueryResponse(operation: 'knowledge.search', body: unknown): KnowledgeSearchResultSet;
export function validateAppQueryResponse(operation: 'knowledge.read', body: unknown): KnowledgeReadResult;
export function validateAppQueryResponse(operation: 'memory.search', body: unknown): MemorySearchResultSet;
export function validateAppQueryResponse(operation: 'features.report.get', body: unknown, expectation?: SnapshotExpectation): FeatureExecutionReport;
export function validateAppQueryResponse(operation: 'project.resources.list', body: unknown, expectation?: SnapshotExpectation): ProjectResourceConfiguration;
export function validateAppQueryResponse(operation: 'project.resources.candidates', body: unknown, expectation?: SnapshotExpectation): ProjectResourceCandidateDiscoveryResult;
export function validateAppQueryResponse(operation: 'project.resources.preview', body: unknown, expectation?: SnapshotExpectation): ProjectResourceCandidatePreview;

export function validateAppQueryResponse(
  operation: 'features.delivery.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): FeatureDeliveryDetailResult;
// P03-9 / F-014：Run/Batch 控制进度、恢复诊断与 finalization 收尾结果查询重载。
export function validateAppQueryResponse(
  operation: 'execution.run.control.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): RunControlDetailResult;
export function validateAppQueryResponse(
  operation: 'execution.batch.control.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): BatchControlDetailResult;
export function validateAppQueryResponse(
  operation: 'execution.run.recovery.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): RunRecoveryDetailResult;
export function validateAppQueryResponse(
  operation: 'workspaces.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): WorkspaceDetailResult;
export function validateAppQueryResponse(
  operation: 'workspace.operations.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): WorkspaceOperationListResult;
export function validateAppQueryResponse(operation: 'execution.sessions.list', body: unknown, expectation?: SnapshotExpectation): WorkSessionListResult;
export function validateAppQueryResponse(operation: 'execution.session.get', body: unknown, expectation?: SnapshotExpectation): WorkSessionDetailResult;
export function validateAppQueryResponse(operation: 'execution.session.evidence.get', body: unknown, expectation?: SnapshotExpectation): WorkSessionEvidenceContent;
export function validateAppQueryResponse(operation: 'execution.recording.list', body: unknown, expectation?: SnapshotExpectation): WorkRecordingPage;
export function validateAppQueryResponse(operation: 'execution.batch.delivery.get', body: unknown, expectation?: SnapshotExpectation): PublicBatchDeliveryResult;
export function validateAppQueryResponse(operation: 'execution.recording.body.get', body: unknown, expectation?: SnapshotExpectation): WorkRecordingBody;
export function validateAppQueryResponse(
  operation: 'workspace.operations.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): WorkspaceOperationDetailResult;
export function validateAppQueryResponse(
  operation: 'projects.list',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectListResult;
export function validateAppQueryResponse(
  operation: 'projects.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectDetailResult;
export function validateAppQueryResponse(
  operation: 'projects.binding.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectBindingResult;
export function validateAppQueryResponse(
  operation: 'projects.labelCounts',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectLabelCountsResult;
export function validateAppQueryResponse(
  operation: 'projects.inspect',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectInspectionResult;
export function validateAppQueryResponse(
  operation: 'projects.overview',
  body: unknown,
  expectation?: SnapshotExpectation,
): ProjectOverviewResult;
export function validateAppQueryResponse(
  operation: 'settings.global.get' | 'settings.project.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): PublicSettingsState;
export function validateAppQueryResponse(
  operation: 'settings.global.export' | 'settings.project.export',
  body: unknown,
  expectation?: SnapshotExpectation,
): ExportedSettings;
export function validateAppQueryResponse(
  operation: 'settings.project.effective',
  body: unknown,
  expectation?: SnapshotExpectation,
): EffectiveSettings;
export function validateAppQueryResponse(
  operation: 'snapshot.get',
  body: unknown,
  expectation?: SnapshotExpectation,
): SnapshotResult;
/**
 * 按 §7.2/§8 冻结形状校验查询响应。schema 版本不符 → unsupported_schema_version；
 * 形状/字段/scope 不符 → response_malformed。不修改输入对象以外的任何状态。
 */
export function validateAppQueryResponse(
  operation: AppQueryOperation,
  body: unknown,
  expectation?: SnapshotExpectation,
): unknown {
  switch (operation) {
    case 'knowledge.search':
    case 'knowledge.read':
    case 'memory.search':
      if (isPlainObject(body) && body.schemaVersion !== 1) throw new HostProtocolError('unsupported_schema_version', operation, '知识查询响应版本不受支持');
      try { return validateKnowledgeQueryResponse(operation, body); }
      catch { throw new HostProtocolError('response_malformed', operation, '知识查询响应无效'); }
    case 'execution.sessions.list': return validateWorkSessionListWire(body);
    case 'execution.session.get': return validateWorkSessionDetailWire(body);
    case 'execution.session.evidence.get': return validateWorkSessionEvidenceWire(body);
    case 'execution.recording.list': return validateWorkRecordingListWire(body);
    case 'execution.recording.body.get': return validateWorkRecordingBodyWire(body);
    case 'projects.list':
      return validateProjectListPage(operation, body);
    case 'projects.get': {
      const object = requirePlain(operation, body);
      exactKeys(operation, object, ['project', 'binding']);
      const project = validateProjectRecord(operation, object.project);
      const binding =
        object.binding === null ? null : validateBindingRecord(operation, object.binding);
      return { project, binding };
    }
    case 'projects.binding.get': {
      const object = requirePlain(operation, body);
      exactKeys(operation, object, ['binding']);
      return { binding: validateBindingRecord(operation, object.binding) };
    }
    case 'projects.labelCounts': {
      const object = requirePlain(operation, body);
      exactKeys(operation, object, ['labels']);
      if (!Array.isArray(object.labels)) {
        malformed(operation, 'label_counts_invalid');
      }
      const labels = object.labels.map((entry) => {
        const record = requirePlain(operation, entry);
        exactKeys(operation, record, ['label', 'projectCount']);
        if (typeof record.label !== 'string' || record.label.length === 0) {
          malformed(operation, 'label_counts_invalid');
        }
        if (
          typeof record.projectCount !== 'number' ||
          !Number.isSafeInteger(record.projectCount) ||
          record.projectCount < 0
        ) {
          malformed(operation, 'label_counts_invalid');
        }
        return { label: record.label, projectCount: record.projectCount };
      });
      return { labels };
    }
    case 'projects.inspect':
      return validateProjectInspection(operation, body);
    case 'projects.profile.get':
      return validateProjectProfileQueryWire(operation, body);
    case 'projects.profile.match':
      return validateProjectProfileMatchQueryWire(operation, body);
    case 'projects.overview':
      return validateProjectOverview(operation, body);
    case 'settings.global.get':
      return validateSettingsState(operation, body);
    case 'settings.project.get':
      return validateSettingsState(operation, body);
    case 'settings.global.export':
    case 'settings.project.export':
      return validateExportedSettings(operation, body);
    case 'settings.project.effective':
      return validateEffectiveSettings(operation, body);
    case 'snapshot.get':
      return validateSnapshot(operation, body, expectation);
    case 'baselines.list':
      return validateBaselineListPage(operation, body);
    case 'baselines.get':
      return validateBaselineDetail(operation, body);
    // P03-1 / F-009 §6.6：计划域查询响应分发（同一冻结字段集纪律）。
    case 'phases.graph.get': return validatePhaseGraphWire(body);
    case 'phases.list':
      return validatePhaseListPage(operation, body);
    case 'phases.get': {
      const object = requirePlain(operation, body);
      exactKeys(operation, object, ['phase']);
      return { phase: validatePhaseRecordWire(operation, object.phase) };
    }
    case 'features.list':
      return validateFeatureListPage(operation, body);
    case 'features.get':
      return validateFeaturePlanDetailWire(operation, body);
    case 'tasks.list':
      return validateTaskListPage(operation, body);
    case 'tasks.get': {
      const object = requirePlain(operation, body);
      exactKeys(operation, object, ['task']);
      return { task: validateTaskRecordWire(operation, object.task) };
    }
    // P03-2 / F-007：审批决策查询响应分发（同一冻结字段集纪律）。
    case 'features.approvals':
      return validateFeatureApprovalsResultWire(operation, body);
    case 'execution.budget.get':
      return validateExecutionBudgetStatusResultWire(body, operation);
    case 'execution.budget.revisions':
      return validateBudgetRevisionListResultWire(body, operation);
    // P03-4 / F-008：调度诊断与 Attempt 审计查询响应分发（同一冻结字段集纪律）。
    case 'execution.run.schedule':
      return validateRunScheduleStatusResultWire(body, operation);
    case 'execution.attempts.list':
      return validateAttemptListResultWire(body, operation);
    case 'execution.attempt.diagnostics':
      return validateAttemptDiagnosticsResultWire(body, operation);
    // P04-9 / F-009：派发队列与槽位投影响应分发（同一冻结字段集纪律）。
    case 'execution.dispatch.list':
      return validateDispatchQueueListResultWire(body, operation);
    case 'execution.resources.list':
      return validateResourceListResultWire(body, operation);
    // P05-1 / F-012：规划上下文/候选查询响应分发（同一冻结字段集纪律）。
    case 'planning.contexts.list':
      return validatePlanningContextListResultWire(body, operation);
    case 'planning.context.get':
      return validatePlanningContextDetailResultWire(body, operation);
    case 'planning.candidate.get':
      return validatePlanningCandidateDetailResultWire(body, operation);
    case 'project.resources.list':
    case 'project.resources.candidates':
    case 'project.resources.preview':
      return validateProjectResourceQueryWire(operation, body);
    // P03-7 / F-013：Task 证据/人审/返工链查询响应分发（同一冻结字段集纪律）。
    case 'execution.task.verification.get':
      return validateTaskVerificationResultWire(body, operation);
    case 'execution.task.approvals.list':
      return validateTaskApprovalItemListResultWire(body, operation);
    case 'execution.task.rework-chain.list':
      return validateTaskReworkChainResultWire(body, operation);
    // P03-5 / F-012：工作区状态查询响应分发（同一冻结字段集纪律）。
    case 'workspaces.list':
      return validateWorkspaceListResultWire(body, operation);
    case 'workspaces.get':
      return validateWorkspaceDetailResultWire(body, operation);
    case 'workspace.operations.list':
      return validateWorkspaceOperationListResultWire(body, operation);
    case 'workspace.operations.get':
      return validateWorkspaceOperationDetailResultWire(body, operation);
    // P03-8 / F-009：Git 操作查询响应分发（同一冻结字段集纪律）。
    case 'git.operations.list':
      return validateGitOperationListResultWire(body, operation);
    case 'git.operations.get':
      return validateGitOperationDetailResultWire(body, operation);
    case 'git.repairs.list':
    case 'git.repairs.get':
      return validateGitAgentRepairQueryResultWire(body, operation);
    // P03-8 / F-010：Feature 分轴结果查询响应分发（同一冻结字段集纪律）。
    case 'features.report.get':
      return validateFeatureReportWire(body, {
        delivery: value => validateFeatureDeliveryDetailResultWire(value, operation),
        verification: value => validateVerificationBatchWire(operation, value),
        operation: value => validatePublicGitOperationWire(operation, value),
      });
    case 'features.delivery.get':
      return validateFeatureDeliveryDetailResultWire(body, operation);
    case 'integration.plan.get':
      return validateIntegrationPlanQueryResultWire(body, operation);
    // P03-9 / F-014：控制进度与恢复诊断查询响应分发（同一冻结字段集纪律）。
    case 'execution.run.control.get':
      return validateRunControlDetailResultWire(body, operation);
    case 'execution.batch.delivery.get':
      return validateBatchDeliveryResultWire(body, operation);
    case 'execution.batch.control.get':
      return validateBatchControlDetailResultWire(body, operation);
    case 'execution.run.recovery.get':
      return validateRunRecoveryDetailResultWire(body, operation);
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`未覆盖的查询操作：${String(exhaustive)}`);
    }
  }
}
