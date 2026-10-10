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
  EVENT_CURSOR_PREFIX,
  ONBOARDING_QUERY_SCHEMA_VERSION,
  PUBLIC_EVENT_SCHEMA_VERSION,
  PUBLIC_STATE_EVENT_TYPES,
  SETTINGS_EXPORT_FORMAT_VERSION,
  SETTINGS_SCHEMA_VERSION,
  STATE_EVENT_TYPE_SPECS,
  WIRE_MESSAGE_SCHEMA_VERSION,
  isIsoUtcDateTime,
  isUuidV4,
  validateSettingsPayload,
  validateWireCommandReceipt,
} from 'shiploop-core/protocol';
import type {
  CommandReceipt,
  EffectiveSettings,
  ExportedSettings,
  ProjectBindingResult,
  ProjectDetailResult,
  ProjectHealthSummary,
  ProjectInspectionResult,
  ProjectLabelCountsResult,
  ProjectListResult,
  ProjectOverviewResult,
  ProjectSettingsPresence,
  PublicProjectRecord,
  PublicRepositoryBindingRecord,
  PublicSettingsState,
  PublicStateEvent,
  PublicStateEventType,
  SettingsScope,
  SnapshotResult,
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
  | 'snapshot.get';

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
 * 校验线上回执并核对期望身份。schemaVersion ≠ 2 → unsupported_schema_version；
 * 其余形状/不变量违反与身份/摘要不符 → response_malformed。accepted 由 Core
 * 校验器拒绝（本版本不是合法线上状态），客户端绝不放行。
 */
export function validateCommandReceiptWire(
  value: unknown,
  expected: CommandReceiptExpectation = {},
  operation: HostOperation = 'receipts.get',
): CommandReceipt {
  if (
    isPlainObject(value) &&
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION
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
    default: {
      const exhaustive: never = operation;
      throw new TypeError(`未覆盖的查询操作：${String(exhaustive)}`);
    }
  }
}
