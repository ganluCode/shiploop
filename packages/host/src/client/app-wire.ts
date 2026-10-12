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
import {
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
  SETTINGS_EXPORT_FORMAT_VERSION,
  SETTINGS_SCHEMA_VERSION,
  STATE_EVENT_TYPE_SPECS,
  WIRE_MESSAGE_SCHEMA_VERSION,
  WORK_ACCEPTED_SCHEMA_VERSION,
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
  validateSettingsPayload,
  validateWireCommandReceipt,
} from 'shiploop-core/protocol';
import type {
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
  SettingsScope,
  SnapshotResult,
  TaskDetailResult,
  TaskListResult,
} from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject } from '../contract/index.js';
import type { HostOperation } from '../contract/index.js';

/** §11.3 查询能力清单（回执/结果读取经 validateCommandReceiptWire，不在本类型内）。 */
export type AppQueryOperation =
  | 'projects.list'
  | 'projects.get'
  | 'projects.binding.get'
  | 'projects.labelCounts'
  | 'projects.inspect'
  | 'projects.overview'
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
  | 'features.list'
  | 'features.get'
  | 'tasks.list'
  | 'tasks.get'
  // P03-2 / F-007：审批决策查询（与 Core PLAN_APPROVAL_QUERY_OPERATION 同源）。
  | 'features.approvals';

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
}

/**
 * 接受既有 v5 与显式 Work accepted v6；其他 schemaVersion →
 * unsupported_schema_version；其余形状/不变量违反与身份/摘要不符 →
 * response_malformed。Core 同时核验版本、操作和关联身份，不能用 v6
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
      value.operation === 'execution.start' && value.status === 'accepted')
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
  // settingsSummary
  exactKeys(operation, object, ['schemaVersion', 'strategies', 'policies']);
  if (object.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    malformed(operation, 'event_payload_violation');
  }
  for (const key of ['strategies', 'policies'] as const) {
    const list = object[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
      malformed(operation, 'event_payload_violation');
    }
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    strategies: [...(object.strategies as string[])],
    policies: [...(object.policies as string[])],
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
    'codeIdentity',
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
    codeIdentity: codeIdentity as unknown as BaselinePreviewResult['codeIdentity'],
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
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`未覆盖的查询操作：${String(exhaustive)}`);
    }
  }
}
