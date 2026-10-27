/**
 * P06-1 ProjectProfile、静态技术检测证据与 CapabilityModule 契约。
 *
 * 端口层只表达版本化数据和运行时校验；检测适配器在 adapters/fs 中实现。
 * 静态候选不等于用户确认的事实，所有自动检测结果都带有显式状态和证据引用。
 * 契约不导入 Pi/MCP/HTTP/ORM，也不允许正文、凭据或绝对开发机路径进入结果。
 */
import { StorageError } from './errors.js';
import {
  isPlainObject,
  rejectUnknownKeys,
  requireNonEmptyString,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

export const PROJECT_PROFILE_SCHEMA_VERSION = 1 as const;
export const DETECTION_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_MODULE_SCHEMA_VERSION = 1 as const;
export const PROJECT_PROFILE_DETECTOR_VERSION = '1.0.0' as const;

export const PROFILE_CONFIRMATION_STATUSES = [
  'candidate',
  'confirmed',
  'rejected',
  'manual_configuration_required',
] as const;
export type ProfileConfirmationStatus = (typeof PROFILE_CONFIRMATION_STATUSES)[number];
/** Alias for callers describing a detection rather than a saved profile. */
export const PROFILE_DETECTION_STATUSES = PROFILE_CONFIRMATION_STATUSES;

export const DETECTION_KINDS = ['language', 'runtime', 'framework', 'tool'] as const;
export type DetectionKind = (typeof DETECTION_KINDS)[number];

export const DETECTION_UNCERTAINTY_REASONS = [
  'missing_file',
  'unreadable_file',
  'malformed_manifest',
  'unknown_language',
  'scan_limit',
] as const;
export type DetectionUncertaintyReason = (typeof DETECTION_UNCERTAINTY_REASONS)[number];

export const PROFILE_STRING_MAX_LENGTH = 256;
export const PROFILE_SUMMARY_MAX_LENGTH = 1_024;
export const PROFILE_SOURCE_MAX_LENGTH = 512;
export const PROFILE_ARRAY_MAX_LENGTH = 128;
export const PROFILE_MODULE_MAX_COUNT = 64;
export const PROFILE_EVIDENCE_MAX_COUNT = 256;

export interface DetectionEvidence {
  readonly schemaVersion: typeof DETECTION_EVIDENCE_SCHEMA_VERSION;
  readonly id: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  /** 仓库根的相对文件名或 `repository-root`，绝不为绝对路径。 */
  readonly source: string;
  /** 只描述检测结论，不保存文件正文、脚本或环境值。 */
  readonly summary: string;
  readonly status: ProfileConfirmationStatus;
  /** 静态检测产物恒为 false；确认由后续用户流程产生。 */
  readonly confirmed: boolean;
}

export interface DetectionUncertainty {
  readonly schemaVersion: typeof DETECTION_EVIDENCE_SCHEMA_VERSION;
  readonly reason: DetectionUncertaintyReason;
  readonly source: string;
  readonly summary: string;
  readonly status: 'manual_configuration_required';
}

export interface ProjectDetection {
  readonly schemaVersion: typeof DETECTION_EVIDENCE_SCHEMA_VERSION;
  readonly id: string;
  readonly key: string;
  readonly kind: DetectionKind;
  readonly status: ProfileConfirmationStatus;
  readonly confirmed: boolean;
  readonly evidence: readonly DetectionEvidence[];
}

export interface ProfileModuleReference {
  readonly id: string;
  readonly version: string;
  readonly roots: readonly string[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly capabilityRefs: readonly string[];
  readonly checkRefs: readonly string[];
}

export interface ProjectProfile {
  readonly schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly version: number;
  /** Optional human readable revision label; `v<version>` is used by the detector. */
  readonly revision?: string;
  readonly status: ProfileConfirmationStatus;
  readonly modules: readonly ProfileModuleReference[];
  readonly documentRefs: readonly string[];
  readonly detectionEvidenceRefs: readonly string[];
  readonly confirmedBy: string | null;
}

export interface CapabilityModule {
  readonly schemaVersion: typeof CAPABILITY_MODULE_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly scope: readonly string[];
  readonly appliesTo: readonly string[];
  readonly dependencies: readonly string[];
  /** Opaque controlled artifact reference, never a filesystem path or inline body. */
  readonly contentRef: string;
  readonly status: ProfileConfirmationStatus;
}

export interface ProjectProfileInspectionResult {
  readonly schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  readonly detectorVersion: typeof PROJECT_PROFILE_DETECTOR_VERSION;
  readonly detections: readonly ProjectDetection[];
  readonly evidence: readonly DetectionEvidence[];
  readonly uncertainties: readonly DetectionUncertainty[];
  readonly candidateProfile: ProjectProfile;
}

/** 只读静态检测端口；实现位于 adapters/fs，不执行仓库脚本或安装器。 */
export interface ProjectProfileInspector {
  inspect(repositoryPath: unknown): Promise<ProjectProfileInspectionResult>;
}

export type TechnicalDetectionEvidence = DetectionEvidence;
export type ProjectProfileDetection = ProjectDetection;
export type ProfileInspectionResult = ProjectProfileInspectionResult;

const PROFILE_CONTEXT: ValidationContext = { operation: 'ProjectProfile.validate' };
const EVIDENCE_CONTEXT: ValidationContext = { operation: 'DetectionEvidence.validate' };
const MODULE_CONTEXT: ValidationContext = { operation: 'CapabilityModule.validate' };

function fail(context: ValidationContext, field: string, reason: string, value?: unknown): never {
  throw validationError(context, field, reason, value);
}

function boundedString(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxLength: number,
): string {
  const result = requireNonEmptyString(value, context, field);
  if ([...result].length > maxLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(context, field, `长度不得超过 ${maxLength} 且不得包含控制字符`, value);
  }
  return result;
}

function boundedStringArray(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxLength = PROFILE_ARRAY_MAX_LENGTH,
): string[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail(context, field, `必须是最多 ${maxLength} 项的字符串数组`, value);
  }
  return value.map((item, index) => boundedString(item, context, `${field}[${index}]`, PROFILE_STRING_MAX_LENGTH));
}

function relativeReference(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxLength: number,
): string {
  const result = boundedString(value, context, field, maxLength);
  if (
    result.startsWith('/') ||
    result.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(result) ||
    result.includes('\\') ||
    result.split('/').some((part) => part === '..')
  ) {
    fail(context, field, '必须是受控的相对引用', value);
  }
  return result;
}

function opaqueReference(value: unknown, context: ValidationContext, field: string): string {
  const result = boundedString(value, context, field, PROFILE_SOURCE_MAX_LENGTH);
  if (
    result.startsWith('/') ||
    result.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(result) ||
    /(?:^|[?&#])(token|secret|password|api[-_]?key|authorization)=/iu.test(result) ||
    /-----BEGIN [^-]+ KEY-----/u.test(result) ||
    /\r|\n/u.test(result)
  ) {
    fail(context, field, '不得包含绝对路径、凭据或正文', value);
  }
  return result;
}

function statusAndConfirmation(
  object: Record<string, unknown>,
  context: ValidationContext,
  field: string,
): { status: ProfileConfirmationStatus; confirmed: boolean } {
  const status = object.status;
  if (!PROFILE_CONFIRMATION_STATUSES.includes(status as ProfileConfirmationStatus)) {
    fail(context, `${field}.status`, '不是受支持的确认状态', status);
  }
  if (typeof object.confirmed !== 'boolean') {
    fail(context, `${field}.confirmed`, '必须是布尔值', object.confirmed);
  }
  const typedStatus = status as ProfileConfirmationStatus;
  if (object.confirmed !== (typedStatus === 'confirmed')) {
    fail(context, `${field}.confirmed`, '必须与 status=confirmed 保持一致', object.confirmed);
  }
  return { status: typedStatus, confirmed: object.confirmed as boolean };
}

function validateSchemaVersion(
  value: unknown,
  expected: number,
  context: ValidationContext,
  field: string,
): void {
  if (value !== expected) {
    fail(context, field, `仅支持 schemaVersion=${expected}`, value);
  }
}

function validateReferenceArray(
  value: unknown,
  context: ValidationContext,
  field: string,
  maxLength = PROFILE_ARRAY_MAX_LENGTH,
): string[] {
  const values = boundedStringArray(value, context, field, maxLength);
  const normalized = values.map((item, index) => opaqueReference(item, context, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail(context, field, '不允许重复引用');
  }
  return normalized;
}

export function validateDetectionEvidence(value: unknown): DetectionEvidence {
  const object = requirePlainObject(value, EVIDENCE_CONTEXT, 'evidence');
  rejectUnknownKeys(
    object,
    ['schemaVersion', 'id', 'detectorId', 'detectorVersion', 'source', 'summary', 'status', 'confirmed'],
    EVIDENCE_CONTEXT,
    'evidence',
  );
  validateSchemaVersion(object.schemaVersion, DETECTION_EVIDENCE_SCHEMA_VERSION, EVIDENCE_CONTEXT, 'evidence.schemaVersion');
  const id = validateStableId(object.id, EVIDENCE_CONTEXT, 'evidence.id');
  const detectorId = validateStableId(object.detectorId, EVIDENCE_CONTEXT, 'evidence.detectorId');
  const detectorVersion = boundedString(object.detectorVersion, EVIDENCE_CONTEXT, 'evidence.detectorVersion', 64);
  const source = object.source === 'repository-root'
    ? 'repository-root'
    : relativeReference(object.source, EVIDENCE_CONTEXT, 'evidence.source', PROFILE_SOURCE_MAX_LENGTH);
  const summary = boundedString(object.summary, EVIDENCE_CONTEXT, 'evidence.summary', PROFILE_SUMMARY_MAX_LENGTH);
  const { status, confirmed } = statusAndConfirmation(object, EVIDENCE_CONTEXT, 'evidence');
  return Object.freeze({
    schemaVersion: DETECTION_EVIDENCE_SCHEMA_VERSION,
    id,
    detectorId,
    detectorVersion,
    source,
    summary,
    status,
    confirmed,
  });
}

export function validateCapabilityModule(value: unknown): CapabilityModule {
  const object = requirePlainObject(value, MODULE_CONTEXT, 'module');
  rejectUnknownKeys(
    object,
    ['schemaVersion', 'id', 'version', 'scope', 'appliesTo', 'dependencies', 'contentRef', 'status'],
    MODULE_CONTEXT,
    'module',
  );
  validateSchemaVersion(object.schemaVersion, CAPABILITY_MODULE_SCHEMA_VERSION, MODULE_CONTEXT, 'module.schemaVersion');
  const id = validateStableId(object.id, MODULE_CONTEXT, 'module.id');
  const version = boundedString(object.version, MODULE_CONTEXT, 'module.version', 64);
  const scope = validateReferenceArray(object.scope, MODULE_CONTEXT, 'module.scope');
  const appliesTo = validateReferenceArray(object.appliesTo, MODULE_CONTEXT, 'module.appliesTo');
  const dependencies = validateReferenceArray(object.dependencies, MODULE_CONTEXT, 'module.dependencies');
  const contentRef = opaqueReference(object.contentRef, MODULE_CONTEXT, 'module.contentRef');
  const statusValue = object.status;
  if (!PROFILE_CONFIRMATION_STATUSES.includes(statusValue as ProfileConfirmationStatus)) {
    fail(MODULE_CONTEXT, 'module.status', '不是受支持的确认状态', statusValue);
  }
  return Object.freeze({
    schemaVersion: CAPABILITY_MODULE_SCHEMA_VERSION,
    id,
    version,
    scope,
    appliesTo,
    dependencies,
    contentRef,
    status: statusValue as ProfileConfirmationStatus,
  });
}

function validateProfileModule(value: unknown, index: number): ProfileModuleReference {
  const field = `profile.modules[${index}]`;
  const object = requirePlainObject(value, PROFILE_CONTEXT, field);
  rejectUnknownKeys(
    object,
    ['id', 'version', 'roots', 'languages', 'frameworks', 'capabilityRefs', 'checkRefs'],
    PROFILE_CONTEXT,
    field,
  );
  const id = validateStableId(object.id, PROFILE_CONTEXT, `${field}.id`);
  const version = boundedString(object.version, PROFILE_CONTEXT, `${field}.version`, 64);
  const roots = boundedStringArray(object.roots, PROFILE_CONTEXT, `${field}.roots`).map((root, rootIndex) =>
    relativeReference(root, PROFILE_CONTEXT, `${field}.roots[${rootIndex}]`, PROFILE_SOURCE_MAX_LENGTH),
  );
  const languages = validateReferenceArray(object.languages, PROFILE_CONTEXT, `${field}.languages`);
  const frameworks = validateReferenceArray(object.frameworks, PROFILE_CONTEXT, `${field}.frameworks`);
  const capabilityRefs = validateReferenceArray(object.capabilityRefs, PROFILE_CONTEXT, `${field}.capabilityRefs`);
  const checkRefs = validateReferenceArray(object.checkRefs, PROFILE_CONTEXT, `${field}.checkRefs`);
  return Object.freeze({ id, version, roots, languages, frameworks, capabilityRefs, checkRefs });
}

export function validateProjectProfile(value: unknown): ProjectProfile {
  const object = requirePlainObject(value, PROFILE_CONTEXT, 'profile');
  rejectUnknownKeys(
    object,
    ['schemaVersion', 'projectId', 'version', 'revision', 'status', 'modules', 'documentRefs', 'detectionEvidenceRefs', 'confirmedBy'],
    PROFILE_CONTEXT,
    'profile',
  );
  validateSchemaVersion(object.schemaVersion, PROJECT_PROFILE_SCHEMA_VERSION, PROFILE_CONTEXT, 'profile.schemaVersion');
  const projectId = validateStableId(object.projectId, PROFILE_CONTEXT, 'profile.projectId');
  const version = validatePositiveInteger(object.version, PROFILE_CONTEXT, 'profile.version');
  const revision = object.revision === undefined
    ? undefined
    : boundedString(object.revision, PROFILE_CONTEXT, 'profile.revision', 64);
  const statusValue = object.status;
  if (!PROFILE_CONFIRMATION_STATUSES.includes(statusValue as ProfileConfirmationStatus)) {
    fail(PROFILE_CONTEXT, 'profile.status', '不是受支持的确认状态', statusValue);
  }
  if (!Array.isArray(object.modules) || object.modules.length > PROFILE_MODULE_MAX_COUNT) {
    fail(PROFILE_CONTEXT, 'profile.modules', `必须是最多 ${PROFILE_MODULE_MAX_COUNT} 项的数组`, object.modules);
  }
  const modules = object.modules.map((module, index) => validateProfileModule(module, index));
  const moduleKeys = modules.map((module) => `${module.id}@${module.version}`);
  if (new Set(moduleKeys).size !== moduleKeys.length) {
    fail(PROFILE_CONTEXT, 'profile.modules', '不允许重复模块');
  }
  const documentRefs = validateReferenceArray(object.documentRefs, PROFILE_CONTEXT, 'profile.documentRefs');
  const detectionEvidenceRefs = validateReferenceArray(
    object.detectionEvidenceRefs,
    PROFILE_CONTEXT,
    'profile.detectionEvidenceRefs',
    PROFILE_EVIDENCE_MAX_COUNT,
  );
  let confirmedBy: string | null;
  if (object.confirmedBy === null) {
    confirmedBy = null;
  } else {
    confirmedBy = validateStableId(object.confirmedBy, PROFILE_CONTEXT, 'profile.confirmedBy');
  }
  const status = statusValue as ProfileConfirmationStatus;
  if (status === 'confirmed' && confirmedBy === null) {
    fail(PROFILE_CONTEXT, 'profile.confirmedBy', 'confirmed 画像必须记录确认主体');
  }
  if (status !== 'confirmed' && confirmedBy !== null) {
    fail(PROFILE_CONTEXT, 'profile.confirmedBy', '未确认画像不能携带确认主体');
  }
  return Object.freeze({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    projectId,
    version,
    ...(revision === undefined ? {} : { revision }),
    status,
    modules,
    documentRefs,
    detectionEvidenceRefs,
    confirmedBy,
  });
}

export function isProjectProfile(value: unknown): value is ProjectProfile {
  try {
    validateProjectProfile(value);
    return true;
  } catch (error) {
    return error instanceof StorageError;
  }
}

export function isCapabilityModule(value: unknown): value is CapabilityModule {
  try {
    validateCapabilityModule(value);
    return true;
  } catch (error) {
    return error instanceof StorageError;
  }
}

export function createCandidateProfile(input: {
  readonly projectId: string;
  readonly modules: readonly ProfileModuleReference[];
  readonly detectionEvidenceRefs: readonly string[];
  readonly status?: ProfileConfirmationStatus;
}): ProjectProfile {
  const status = input.status ?? (input.modules.length > 0 ? 'candidate' : 'manual_configuration_required');
  return validateProjectProfile({
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    projectId: input.projectId,
    version: 1,
    revision: 'v1',
    status,
    modules: input.modules,
    documentRefs: [],
    detectionEvidenceRefs: input.detectionEvidenceRefs,
    confirmedBy: null,
  });
}

export function createDetectionEvidence(input: Omit<DetectionEvidence, 'schemaVersion'>): DetectionEvidence {
  return validateDetectionEvidence({ schemaVersion: DETECTION_EVIDENCE_SCHEMA_VERSION, ...input });
}

export function createCapabilityModule(input: Omit<CapabilityModule, 'schemaVersion'>): CapabilityModule {
  return validateCapabilityModule({ schemaVersion: CAPABILITY_MODULE_SCHEMA_VERSION, ...input });
}

export function createProjectProfile(input: Omit<ProjectProfile, 'schemaVersion'>): ProjectProfile {
  return validateProjectProfile({ schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION, ...input });
}

/** Explicit input aliases used by application/storage boundaries. */
export const validateProjectProfileInput = validateProjectProfile;
export const validateCapabilityModuleInput = validateCapabilityModule;
export const validateDetectionEvidenceInput = validateDetectionEvidence;
export const validateTechnicalDetectionEvidence = validateDetectionEvidence;

export function createProfileValidationError(field: string, reason: string): StorageError {
  return validationError(PROFILE_CONTEXT, field, reason);
}

export function isPlainProfileObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}
