import { StorageError } from './errors.js';
import type { ProjectStatus } from './state-store.js';
import {
  requireNonEmptyString,
  requirePlainObject,
  validateExpectedRevision,
  validateSha256Digest,
  validateStableId,
  validationError,
  type ValidationContext,
} from './validation.js';

/** P07-3 的备份封套版本；与线消息、数据库 schema 和原生 SDK 版本独立。 */
export const BACKUP_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BACKUP_PACKAGE_VERSION = 1 as const;
export const RESTORE_CONFIRMATION_SCHEMA_VERSION = 1 as const;
export const DATA_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const DATA_LIFECYCLE_OPERATIONS = [
  'data.backup.create',
  'data.backup.verify',
  'data.backup.restore',
  'project.archive',
  'project.restore',
  'project.delete.preview',
  'project.delete.confirm',
] as const;
export type DataLifecycleOperation = (typeof DATA_LIFECYCLE_OPERATIONS)[number];
export type ProjectLifecycleOperation = 'archive' | 'archiveComplete' | 'restore' | 'delete';

export const PROJECT_LIFECYCLE_TRANSITIONS = Object.freeze({
  archive: Object.freeze({ from: 'active', to: 'archiving' }),
  archiveComplete: Object.freeze({ from: 'archiving', to: 'archived' }),
  restore: Object.freeze({ from: 'archived', to: 'active' }),
  delete: Object.freeze({ from: 'archived', to: 'deleting' }),
} as const);

const CHECKPOINT_STATUSES = ['available', 'unsupported', 'unavailable', 'unverified'] as const;
const RECORDER_COVERAGES = ['complete', 'partial', 'missing', 'unverified'] as const;
const PROJECT_STATUSES = ['active', 'archiving', 'archived', 'deleting'] as const;
const NATIVE_AVAILABILITY = ['readable', 'missing', 'corrupt', 'unsupported'] as const;
const NATIVE_RESUMABILITY = ['resumable', 'not_resumable', 'unsupported', 'unverified'] as const;
const SOURCE_KINDS = ['artifact', 'document', 'input', 'recording', 'native', 'repository', 'worktree'] as const;
const FILE_KINDS = ['database', 'artifact', 'document', 'execution-input', 'recording', 'native', 'attachment'] as const;

export interface BackupDatabaseManifest {
  readonly logicalPath: 'core.sqlite';
  readonly schemaVersion: number;
  readonly migrationDigest: string;
  readonly contentDigest: string;
  readonly integrity: { readonly integrityCheck: 'ok'; readonly foreignKeyCheck: 'ok' };
}

export interface BackupProjectEntry {
  readonly projectId: string;
  readonly status: ProjectStatus;
  readonly entityDigest: string;
}

export interface BackupFileEntry {
  readonly logicalPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: (typeof FILE_KINDS)[number];
  readonly projectId?: string;
  readonly sourceDigest?: string;
}

export interface BackupNativeRecord {
  readonly logicalPath: string;
  readonly format: string;
  readonly version: string;
  readonly sdkVersion: string | null;
  readonly sourceDigest: string;
  readonly availability: (typeof NATIVE_AVAILABILITY)[number];
  readonly resumability: (typeof NATIVE_RESUMABILITY)[number];
  readonly missingReason?: string;
}

export interface BackupSourceSummary {
  readonly kind: (typeof SOURCE_KINDS)[number];
  readonly logicalPath: string;
  readonly digest: string;
  readonly revision?: string;
  readonly status?: 'present' | 'missing' | 'unverified';
}

export type BackupCheckpointSummary =
  | { readonly status: 'available'; readonly logicalPath: string; readonly digest: string; readonly format: string; readonly version: string }
  | { readonly status: 'unsupported' | 'unavailable' | 'unverified'; readonly reason: string };

export interface BackupRecorderWatermark {
  readonly sessionId: string;
  readonly watermark: number | null;
  readonly coverage: (typeof RECORDER_COVERAGES)[number];
  readonly gaps: readonly string[];
}

export interface BackupExternalDependency {
  readonly projectId: string;
  readonly kind: 'repository' | 'worktree';
  readonly logicalLocation: string;
  readonly retention: 'preserved';
  readonly runnable: false;
  readonly reason: string;
}

export interface BackupManifest {
  readonly schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  readonly packageVersion: number;
  readonly backupId: string;
  readonly createdAtUtc: string;
  readonly database: BackupDatabaseManifest;
  readonly projects: readonly BackupProjectEntry[];
  readonly files: readonly BackupFileEntry[];
  readonly nativeRecords: readonly BackupNativeRecord[];
  readonly sources: readonly BackupSourceSummary[];
  readonly checkpoints: BackupCheckpointSummary;
  readonly recorder: readonly BackupRecorderWatermark[];
  readonly externalDependencies: readonly BackupExternalDependency[];
}

function context(operation: string, entity?: { type: 'backup' | 'project'; id?: string }): ValidationContext {
  return { operation, entity };
}

function object(value: unknown, operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): Record<string, unknown> {
  return requirePlainObject(value, context(operation, entity), field);
}

function exact(value: Record<string, unknown>, keys: readonly string[], operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): void {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw validationError(context(operation, entity), field, '包含未知字段');
  }
}

function string(value: unknown, operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): string {
  return requireNonEmptyString(value, context(operation, entity), field);
}

function logicalPath(value: unknown, operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): string {
  const candidate = string(value, operation, field, entity);
  const segments = candidate.split('/');
  if (candidate.startsWith('/') || candidate.includes('\\') || candidate.includes('\0')
    || segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === '.' || segment === '..')) {
    throw validationError(context(operation, entity), field, '必须是受控的非空相对逻辑位置');
  }
  return candidate;
}

function digest(value: unknown, operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): string {
  return validateSha256Digest(value, context(operation, entity), field);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw validationError(context(operation, entity), field, `必须是受支持的枚举值（${values.join(' / ')}）`, value);
  }
  return value as T;
}

function nonNegativeInteger(value: unknown, operation: string, field: string, entity?: { type: 'backup' | 'project'; id?: string }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(context(operation, entity), field, '必须是非负安全整数', value);
  }
  return value;
}

function validateIsoUtc(value: unknown, operation: string, field: string): string {
  const candidate = string(value, operation, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(candidate) || !Number.isFinite(Date.parse(candidate))) {
    throw validationError(context(operation), field, '必须是有效 ISO UTC 时间');
  }
  return candidate;
}

function validateDatabase(value: unknown, operation: string): BackupDatabaseManifest {
  const item = object(value, operation, 'database', { type: 'backup' });
  exact(item, ['logicalPath', 'schemaVersion', 'migrationDigest', 'contentDigest', 'integrity'], operation, 'database', { type: 'backup' });
  const path = logicalPath(item.logicalPath, operation, 'database.logicalPath', { type: 'backup' });
  if (path !== 'core.sqlite') throw validationError(context(operation, { type: 'backup' }), 'database.logicalPath', '必须固定为 core.sqlite');
  const schemaVersion = nonNegativeInteger(item.schemaVersion, operation, 'database.schemaVersion', { type: 'backup' });
  const integrity = object(item.integrity, operation, 'database.integrity', { type: 'backup' });
  exact(integrity, ['integrityCheck', 'foreignKeyCheck'], operation, 'database.integrity', { type: 'backup' });
  if (integrity.integrityCheck !== 'ok' || integrity.foreignKeyCheck !== 'ok') {
    throw new StorageError('corrupt', operation, '备份数据库完整性检查未通过', { entity: { type: 'backup' } });
  }
  return {
    logicalPath: 'core.sqlite', schemaVersion,
    migrationDigest: digest(item.migrationDigest, operation, 'database.migrationDigest', { type: 'backup' }),
    contentDigest: digest(item.contentDigest, operation, 'database.contentDigest', { type: 'backup' }),
    integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' },
  };
}

function validateProjectEntry(value: unknown, operation: string): BackupProjectEntry {
  const item = object(value, operation, 'projects[]', { type: 'backup' });
  exact(item, ['projectId', 'status', 'entityDigest'], operation, 'projects[]', { type: 'backup' });
  const projectId = validateStableId(item.projectId, context(operation, { type: 'project' }), 'projects[].projectId');
  return {
    projectId,
    status: enumValue(item.status, PROJECT_STATUSES, operation, 'projects[].status', { type: 'project', id: projectId }),
    entityDigest: digest(item.entityDigest, operation, 'projects[].entityDigest', { type: 'project', id: projectId }),
  };
}

function validateFile(value: unknown, operation: string): BackupFileEntry {
  const item = object(value, operation, 'files[]', { type: 'backup' });
  exact(item, ['logicalPath', 'sizeBytes', 'sha256', 'kind', 'projectId', 'sourceDigest'], operation, 'files[]', { type: 'backup' });
  return {
    logicalPath: logicalPath(item.logicalPath, operation, 'files[].logicalPath', { type: 'backup' }),
    sizeBytes: nonNegativeInteger(item.sizeBytes, operation, 'files[].sizeBytes', { type: 'backup' }),
    sha256: digest(item.sha256, operation, 'files[].sha256', { type: 'backup' }),
    kind: enumValue(item.kind, FILE_KINDS, operation, 'files[].kind', { type: 'backup' }),
    ...(item.projectId === undefined ? {} : { projectId: validateStableId(item.projectId, context(operation, { type: 'backup' }), 'files[].projectId') }),
    ...(item.sourceDigest === undefined ? {} : { sourceDigest: digest(item.sourceDigest, operation, 'files[].sourceDigest', { type: 'backup' }) }),
  };
}

function validateNativeRecord(value: unknown, operation: string): BackupNativeRecord {
  const item = object(value, operation, 'nativeRecords[]', { type: 'backup' });
  exact(item, ['logicalPath', 'format', 'version', 'sdkVersion', 'sourceDigest', 'availability', 'resumability', 'missingReason'], operation, 'nativeRecords[]', { type: 'backup' });
  const availability = enumValue(item.availability, NATIVE_AVAILABILITY, operation, 'nativeRecords[].availability', { type: 'backup' });
  const missingReason = item.missingReason === undefined
    ? undefined
    : validateStableId(item.missingReason, context(operation), 'nativeRecords[].missingReason');
  if (availability !== 'readable' && missingReason === undefined) {
    throw validationError(context(operation, { type: 'backup' }), 'nativeRecords[].missingReason', '不可用原生记录必须说明原因');
  }
  return {
    logicalPath: logicalPath(item.logicalPath, operation, 'nativeRecords[].logicalPath', { type: 'backup' }),
    format: validateStableId(item.format, context(operation), 'nativeRecords[].format'),
    version: validateStableId(item.version, context(operation), 'nativeRecords[].version'),
    sdkVersion: item.sdkVersion === null ? null : validateStableId(item.sdkVersion, context(operation), 'nativeRecords[].sdkVersion'),
    sourceDigest: digest(item.sourceDigest, operation, 'nativeRecords[].sourceDigest', { type: 'backup' }),
    availability,
    resumability: enumValue(item.resumability, NATIVE_RESUMABILITY, operation, 'nativeRecords[].resumability', { type: 'backup' }),
    ...(missingReason === undefined ? {} : { missingReason }),
  };
}

function validateSource(value: unknown, operation: string): BackupSourceSummary {
  const item = object(value, operation, 'sources[]', { type: 'backup' });
  exact(item, ['kind', 'logicalPath', 'digest', 'revision', 'status'], operation, 'sources[]', { type: 'backup' });
  return {
    kind: enumValue(item.kind, SOURCE_KINDS, operation, 'sources[].kind', { type: 'backup' }),
    logicalPath: logicalPath(item.logicalPath, operation, 'sources[].logicalPath', { type: 'backup' }),
    digest: digest(item.digest, operation, 'sources[].digest', { type: 'backup' }),
    ...(item.revision === undefined ? {} : { revision: string(item.revision, operation, 'sources[].revision', { type: 'backup' }) }),
    ...(item.status === undefined ? {} : { status: enumValue(item.status, ['present', 'missing', 'unverified'] as const, operation, 'sources[].status', { type: 'backup' }) }),
  };
}

function validateCheckpoint(value: unknown, operation: string): BackupCheckpointSummary {
  const item = object(value, operation, 'checkpoints', { type: 'backup' });
  const status = enumValue(item.status, CHECKPOINT_STATUSES, operation, 'checkpoints.status', { type: 'backup' });
  if (status === 'available') {
    exact(item, ['status', 'logicalPath', 'digest', 'format', 'version'], operation, 'checkpoints', { type: 'backup' });
    return {
      status, logicalPath: logicalPath(item.logicalPath, operation, 'checkpoints.logicalPath', { type: 'backup' }),
      digest: digest(item.digest, operation, 'checkpoints.digest', { type: 'backup' }),
      format: string(item.format, operation, 'checkpoints.format', { type: 'backup' }),
      version: string(item.version, operation, 'checkpoints.version', { type: 'backup' }),
    };
  }
  exact(item, ['status', 'reason'], operation, 'checkpoints', { type: 'backup' });
  return { status, reason: validateStableId(item.reason, context(operation), 'checkpoints.reason') };
}

function validateRecorder(value: unknown, operation: string): BackupRecorderWatermark {
  const item = object(value, operation, 'recorder[]', { type: 'backup' });
  exact(item, ['sessionId', 'watermark', 'coverage', 'gaps'], operation, 'recorder[]', { type: 'backup' });
  const gaps = item.gaps;
  if (!Array.isArray(gaps) || gaps.some(gap => typeof gap !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gap))) {
    throw validationError(context(operation, { type: 'backup' }), 'recorder[].gaps', '必须是有界原因字符串数组');
  }
  const coverage = enumValue(item.coverage, RECORDER_COVERAGES, operation, 'recorder[].coverage', { type: 'backup' });
  if (coverage === 'complete' && gaps.length > 0) throw validationError(context(operation), 'recorder[].coverage', '完整覆盖不能含缺口');
  return {
    sessionId: validateStableId(item.sessionId, context(operation, { type: 'backup' }), 'recorder[].sessionId'),
    watermark: item.watermark === null ? null : nonNegativeInteger(item.watermark, operation, 'recorder[].watermark', { type: 'backup' }),
    coverage,
    gaps: [...gaps],
  };
}

function validateExternalDependency(value: unknown, operation: string): BackupExternalDependency {
  const item = object(value, operation, 'externalDependencies[]', { type: 'backup' });
  exact(item, ['projectId', 'kind', 'logicalLocation', 'retention', 'runnable', 'reason'], operation, 'externalDependencies[]', { type: 'backup' });
  if (item.retention !== 'preserved' || item.runnable !== false) {
    throw validationError(context(operation, { type: 'backup' }), 'externalDependencies[]', '外部仓库及工作区保留且恢复后须重新核验');
  }
  return {
    projectId: validateStableId(item.projectId, context(operation), 'externalDependencies[].projectId'),
    kind: enumValue(item.kind, ['repository', 'worktree'] as const, operation, 'externalDependencies[].kind'),
    logicalLocation: logicalPath(item.logicalLocation, operation, 'externalDependencies[].logicalLocation'),
    retention: 'preserved', runnable: false,
    reason: validateStableId(item.reason, context(operation), 'externalDependencies[].reason'),
  };
}

export function validateBackupManifest(input: unknown, operation = 'backup.manifest.validate'): BackupManifest {
  const item = object(input, operation, 'manifest', { type: 'backup' });
  exact(item, ['schemaVersion', 'packageVersion', 'backupId', 'createdAtUtc', 'database', 'projects', 'files', 'nativeRecords', 'sources', 'checkpoints', 'recorder', 'externalDependencies'], operation, 'manifest', { type: 'backup' });
  if (item.schemaVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    throw new StorageError('unsupported_version', operation, '不支持的备份 manifest 版本', { entity: { type: 'backup' }, details: { supportedVersion: BACKUP_MANIFEST_SCHEMA_VERSION } });
  }
  if (item.packageVersion !== BACKUP_PACKAGE_VERSION) {
    throw new StorageError('unsupported_version', operation, '不支持的备份包版本', { entity: { type: 'backup' } });
  }
  const packageVersion = BACKUP_PACKAGE_VERSION;
  const backupId = validateStableId(item.backupId, context(operation, { type: 'backup' }), 'backupId');
  const projects = item.projects;
  const files = item.files;
  const nativeRecords = item.nativeRecords;
  const sources = item.sources;
  const recorder = item.recorder;
  const externalDependencies = item.externalDependencies;
  if (!Array.isArray(projects)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'projects', '必须是数组');
  if (!Array.isArray(files)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'files', '必须是数组');
  if (!Array.isArray(nativeRecords)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'nativeRecords', '必须是数组');
  if (!Array.isArray(sources)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'sources', '必须是数组');
  if (!Array.isArray(recorder)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'recorder', '必须是数组');
  if (!Array.isArray(externalDependencies)) throw validationError(context(operation, { type: 'backup', id: backupId }), 'externalDependencies', '必须是数组');
  const validatedFiles = files.map(value => validateFile(value, operation));
  if (new Set(validatedFiles.map(file => file.logicalPath)).size !== validatedFiles.length) {
    throw validationError(context(operation, { type: 'backup', id: backupId }), 'files', '逻辑位置不得重复');
  }
  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    packageVersion,
    backupId,
    createdAtUtc: validateIsoUtc(item.createdAtUtc, operation, 'createdAtUtc'),
    database: validateDatabase(item.database, operation),
    projects: projects.map(value => validateProjectEntry(value, operation)),
    files: validatedFiles,
    nativeRecords: nativeRecords.map(value => validateNativeRecord(value, operation)),
    sources: sources.map(value => validateSource(value, operation)),
    checkpoints: validateCheckpoint(item.checkpoints, operation),
    recorder: recorder.map(value => validateRecorder(value, operation)),
    externalDependencies: externalDependencies.map(value => validateExternalDependency(value, operation)),
  };
}

export interface RestoreConfirmation {
  readonly schemaVersion: typeof RESTORE_CONFIRMATION_SCHEMA_VERSION;
  readonly backupId: string;
  readonly manifestDigest: string;
  readonly verificationDigest: string;
  readonly targetDataRootId: string;
  readonly targetMode: 'empty-isolated';
  readonly confirmed: true;
}

export function validateRestoreConfirmation(input: unknown, operation = 'restore.confirm'): RestoreConfirmation {
  const item = object(input, operation, 'confirmation', { type: 'backup' });
  exact(item, ['schemaVersion', 'backupId', 'manifestDigest', 'verificationDigest', 'targetDataRootId', 'targetMode', 'confirmed'], operation, 'confirmation', { type: 'backup' });
  if (item.schemaVersion !== RESTORE_CONFIRMATION_SCHEMA_VERSION) {
    throw new StorageError('unsupported_version', operation, '不支持的恢复确认版本', { entity: { type: 'backup' } });
  }
  if (item.confirmed !== true) throw validationError(context(operation, { type: 'backup' }), 'confirmed', '必须明确为 true');
  if (item.targetMode !== 'empty-isolated') throw validationError(context(operation, { type: 'backup' }), 'targetMode', '只支持 empty-isolated');
  return {
    schemaVersion: RESTORE_CONFIRMATION_SCHEMA_VERSION,
    backupId: validateStableId(item.backupId, context(operation, { type: 'backup' }), 'backupId'),
    manifestDigest: digest(item.manifestDigest, operation, 'manifestDigest', { type: 'backup' }),
    verificationDigest: digest(item.verificationDigest, operation, 'verificationDigest', { type: 'backup' }),
    targetDataRootId: validateStableId(item.targetDataRootId, context(operation, { type: 'backup' }), 'targetDataRootId'),
    targetMode: 'empty-isolated',
    confirmed: true,
  };
}

export function assertRestoreConfirmationMatchesManifest(
  confirmation: RestoreConfirmation,
  manifest: BackupManifest,
  expectedManifestDigest: string,
  expectedVerificationDigest: string,
  expectedTargetDataRootId: string,
  operation = 'restore.confirm',
): void {
  if (confirmation.backupId !== manifest.backupId || confirmation.manifestDigest !== expectedManifestDigest
    || confirmation.verificationDigest !== expectedVerificationDigest || confirmation.targetDataRootId !== expectedTargetDataRootId) {
    throw new StorageError('conflict', operation, '恢复确认与已核验备份摘要不匹配', { entity: { type: 'backup', id: manifest.backupId }, details: { reason: 'manifest_digest_mismatch' } });
  }
}

export interface ProjectLifecycleRequest {
  readonly operation: ProjectLifecycleOperation;
  readonly projectId: string;
  readonly expectedRevision: number;
}

export function validateProjectLifecycleRequest(input: unknown, operationName = 'project.lifecycle.validate'): ProjectLifecycleRequest {
  const item = object(input, operationName, 'input', { type: 'project' });
  exact(item, ['operation', 'projectId', 'expectedRevision'], operationName, 'input', { type: 'project' });
  const operation = enumValue(item.operation, ['archive', 'archiveComplete', 'restore', 'delete'] as const, operationName, 'operation', { type: 'project' });
  const projectId = validateStableId(item.projectId, context(operationName, { type: 'project' }), 'projectId');
  return { operation, projectId, expectedRevision: validateExpectedRevision(item.expectedRevision, context(operationName)) };
}

export function assertDeleteConfirmationMatchesPreview(
  confirmedDigest: unknown, expectedDigest: unknown, operation = 'project.delete.confirm',
): void {
  const confirmed = digest(confirmedDigest, operation, 'previewDigest');
  const expected = digest(expectedDigest, operation, 'expectedPreviewDigest');
  if (confirmed !== expected) {
    throw new StorageError('conflict', operation, '删除确认与预览摘要不匹配', { details: { reason: 'preview_digest_mismatch' } });
  }
}

export function projectLifecycleTransition(operation: ProjectLifecycleOperation, current: ProjectStatus): ProjectStatus | null {
  const transition = PROJECT_LIFECYCLE_TRANSITIONS[operation];
  return transition.from === current ? transition.to : null;
}

export interface DataLifecycleQuery {
  readonly kind: 'backup' | 'operation' | 'project';
  readonly backupId?: string;
  readonly operationId?: string;
  readonly projectId?: string;
}

export function validateDataLifecycleQuery(input: unknown, operation = 'data.lifecycle.query'): DataLifecycleQuery {
  const item = object(input, operation, 'query');
  exact(item, ['kind', 'backupId', 'operationId', 'projectId'], operation, 'query');
  const kind = enumValue(item.kind, ['backup', 'operation', 'project'] as const, operation, 'kind');
  if (Object.keys(item).some(key => key !== 'kind' && key !== (kind === 'backup' ? 'backupId' : kind === 'operation' ? 'operationId' : 'projectId'))) {
    throw validationError(context(operation), 'query', '查询包含不适用的字段');
  }
  const result: DataLifecycleQuery = { kind };
  if (kind === 'backup') {
    if (item.backupId === undefined) throw validationError(context(operation), 'backupId', '查询备份必须提供 backupId');
    return { ...result, backupId: validateStableId(item.backupId, context(operation), 'backupId') };
  }
  if (kind === 'operation') {
    if (item.operationId === undefined) throw validationError(context(operation), 'operationId', '查询操作必须提供 operationId');
    return { ...result, operationId: validateStableId(item.operationId, context(operation), 'operationId') };
  }
  if (item.projectId === undefined) throw validationError(context(operation), 'projectId', '查询项目必须提供 projectId');
  return { ...result, projectId: validateStableId(item.projectId, context(operation), 'projectId') };
}

export type DataLifecycleOperationStatus = 'intent' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface DataLifecycleIntent {
  readonly schemaVersion: typeof DATA_LIFECYCLE_SCHEMA_VERSION;
  readonly operationId: string;
  readonly kind: 'backup' | 'restore' | 'project-archive' | 'project-delete';
  readonly targetId: string;
  readonly intentDigest: string;
}
export interface DataLifecycleStep {
  readonly schemaVersion: typeof DATA_LIFECYCLE_SCHEMA_VERSION;
  readonly operationId: string;
  readonly step: string;
  readonly status: DataLifecycleOperationStatus;
  readonly detail?: string;
}
export interface DataLifecycleResult {
  readonly schemaVersion: typeof DATA_LIFECYCLE_SCHEMA_VERSION;
  readonly operationId: string;
  readonly status: Exclude<DataLifecycleOperationStatus, 'intent' | 'running'>;
  readonly resultDigest?: string;
  readonly reason?: string;
}

export function validateDataLifecycleIntent(input: unknown, operation = 'data.lifecycle.intent'): DataLifecycleIntent {
  const item = object(input, operation, 'intent');
  exact(item, ['schemaVersion', 'operationId', 'kind', 'targetId', 'intentDigest'], operation, 'intent');
  if (item.schemaVersion !== DATA_LIFECYCLE_SCHEMA_VERSION) throw new StorageError('unsupported_version', operation, '不支持的操作版本');
  return {
    schemaVersion: DATA_LIFECYCLE_SCHEMA_VERSION,
    operationId: validateStableId(item.operationId, context(operation), 'operationId'),
    kind: enumValue(item.kind, ['backup', 'restore', 'project-archive', 'project-delete'] as const, operation, 'kind'),
    targetId: validateStableId(item.targetId, context(operation), 'targetId'),
    intentDigest: digest(item.intentDigest, operation, 'intentDigest'),
  };
}

export function validateDataLifecycleStep(input: unknown, operation = 'data.lifecycle.step'): DataLifecycleStep {
  const item = object(input, operation, 'step');
  exact(item, ['schemaVersion', 'operationId', 'step', 'status', 'detail'], operation, 'step');
  if (item.schemaVersion !== DATA_LIFECYCLE_SCHEMA_VERSION) throw new StorageError('unsupported_version', operation, '不支持的操作版本');
  return {
    schemaVersion: DATA_LIFECYCLE_SCHEMA_VERSION,
    operationId: validateStableId(item.operationId, context(operation), 'operationId'),
    step: validateStableId(item.step, context(operation), 'step'),
    status: enumValue(item.status, ['intent', 'running', 'completed', 'failed', 'interrupted'] as const, operation, 'status'),
    ...(item.detail === undefined ? {} : { detail: validateStableId(item.detail, context(operation), 'detail') }),
  };
}

export function validateDataLifecycleResult(input: unknown, operation = 'data.lifecycle.result'): DataLifecycleResult {
  const item = object(input, operation, 'result');
  exact(item, ['schemaVersion', 'operationId', 'status', 'resultDigest', 'reason'], operation, 'result');
  if (item.schemaVersion !== DATA_LIFECYCLE_SCHEMA_VERSION) throw new StorageError('unsupported_version', operation, '不支持的操作版本');
  return {
    schemaVersion: DATA_LIFECYCLE_SCHEMA_VERSION,
    operationId: validateStableId(item.operationId, context(operation), 'operationId'),
    status: enumValue(item.status, ['completed', 'failed', 'interrupted'] as const, operation, 'status'),
    ...(item.resultDigest === undefined ? {} : { resultDigest: digest(item.resultDigest, operation, 'resultDigest') }),
    ...(item.reason === undefined ? {} : { reason: validateStableId(item.reason, context(operation), 'reason') }),
  };
}

export interface BackupLifecyclePort {
  createIntent(input: unknown): Promise<DataLifecycleIntent>;
  recordStep(input: unknown): Promise<DataLifecycleStep>;
  complete(input: unknown): Promise<DataLifecycleResult>;
  query(input: unknown): Promise<unknown>;
}
export interface RestoreLifecyclePort {
  validate(input: unknown): Promise<unknown>;
  confirm(input: unknown): Promise<DataLifecycleIntent>;
  recordStep(input: unknown): Promise<DataLifecycleStep>;
  complete(input: unknown): Promise<DataLifecycleResult>;
}
export interface ProjectLifecyclePort {
  archive(input: unknown): Promise<unknown>;
  restore(input: unknown): Promise<unknown>;
  previewDelete(input: unknown): Promise<unknown>;
  confirmDelete(input: unknown): Promise<unknown>;
  query(input: unknown): Promise<unknown>;
}

/** Work/Chat never receives these operations because its operation table is separate. */
export function isDataLifecycleOperation(value: unknown): value is DataLifecycleOperation {
  return typeof value === 'string' && (DATA_LIFECYCLE_OPERATIONS as readonly string[]).includes(value);
}

export function validateDataLifecycleCommandPayload(operation: DataLifecycleOperation, input: unknown): Record<string, unknown> {
  const item = object(input, operation, 'payload');
  if (operation === 'data.backup.create') {
    exact(item, ['backupId', 'target'], operation, 'payload');
    return { backupId: validateStableId(item.backupId, context(operation, { type: 'backup' }), 'payload.backupId'), target: validateStableId(item.target, context(operation, { type: 'backup' }), 'payload.target') };
  }
  if (operation === 'data.backup.verify') {
    exact(item, ['backupId', 'manifestDigest'], operation, 'payload');
    return { backupId: validateStableId(item.backupId, context(operation, { type: 'backup' }), 'payload.backupId'), manifestDigest: digest(item.manifestDigest, operation, 'payload.manifestDigest', { type: 'backup' }) };
  }
  if (operation === 'data.backup.restore') {
    exact(item, ['confirmation'], operation, 'payload');
    return { confirmation: validateRestoreConfirmation(item.confirmation, operation) };
  }
  if (operation === 'project.delete.preview') {
    // F-009：预览分页游标为可选不透明 base64url（结构深校验由预览端口 decode 完成）；
    // projectId 与 scope 的一致性由信封层比对。
    exact(item, ['projectId', 'cursor'], operation, 'payload');
    const result: { projectId: string; cursor?: string } = {
      projectId: validateStableId(item.projectId, context(operation, { type: 'project' }), 'payload.projectId'),
    };
    if (item.cursor !== undefined) {
      const cursor = item.cursor;
      if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw validationError(context(operation, { type: 'project' }), 'payload.cursor', '必须是有效的分页游标');
      }
      result.cursor = cursor;
    }
    return result;
  }
  if (operation === 'project.delete.confirm') {
    exact(item, ['projectId', 'previewDigest', 'confirmed'], operation, 'payload');
    if (item.confirmed !== true) throw validationError(context(operation, { type: 'project' }), 'payload.confirmed', '必须明确为 true');
    return { projectId: validateStableId(item.projectId, context(operation, { type: 'project' }), 'payload.projectId'), previewDigest: digest(item.previewDigest, operation, 'payload.previewDigest', { type: 'project' }), confirmed: true };
  }
  exact(item, ['projectId'], operation, 'payload');
  return { projectId: validateStableId(item.projectId, context(operation, { type: 'project' }), 'payload.projectId') };
}
