/**
 * P04-5 / F-001 Work recording persistence contracts.
 *
 * These records are bounded indexes. Public message/tool/attachment bodies live in
 * ready Artifacts; SQLite stores only their identity and controlled references.
 * Chat history and a Runtime's private archive are deliberately outside this
 * contract.
 */
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateArtifactLocator,
  validateNonNegativeInteger as baseNonNegativeInteger,
  validatePositiveInteger as basePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import { validateWorkSessionNativeRef, type WorkSessionNativeRef } from './work-session.js';
import type { ValidationContext } from './validation.js';

export const WORK_RECORDING_SCHEMA_VERSION = 1;
export const WORK_RECORDING_MAX_SOURCE_REFS = 16;
export const WORK_RECORDING_MAX_ATTACHMENTS = 32;
export const WORK_RECORDING_MAX_MISSING_REASONS = 32;
export const WORK_RECORDING_MAX_DIAGNOSTICS = 32;
export const WORK_RECORDING_MAX_JSON_BYTES = 65_536;
/** complete 只对这些公开范围成立，原生档案与 state_events 审计不属于本投影。 */
export const WORK_RECORDING_PUBLIC_SCOPES = [
  'public_events', 'public_messages', 'public_tools', 'attachments', 'final_result', 'minimal_diagnostics',
] as const;
export const WORK_RECORDING_REQUIRED_EXCLUSIONS = [
  'hidden_reasoning', 'native_private_storage', 'unified_audit',
] as const;

export const WORK_RECORDING_SOURCES = ['live', 'native', 'recovered', 'mixed'] as const;
export type WorkRecordingSource = (typeof WORK_RECORDING_SOURCES)[number];

/* ------------------------------------------------------------------ *
 * P07-2 / F-001 正文发布限制端口契约（原 application/work-recording-publish.ts
 * 内联形状上移；不改变任何字段语义，只补硬上限与统一校验，避免第二套配置）。
 *
 * 计量范围：maxBodyBytes/maxAttachmentBytes 只度量单条公开正文/附件的 retained
 * 字节（脱敏、截断后实际落盘）；maxTotalBytes 度量一条消息正文+附件的 retained
 * 总量；maxChunkBytes 度量单次从上游接收的 byte chunk；maxQueueBytes 度量发布
 * 器内等待 ArtifactPublisher 消费的排队字节（背压上限，不是磁盘上限）；
 * maxAttachments 度量单条消息附件数。上限不能限制授权工具对工作区/仓库的任意
 * 写入，也不能阻止同用户恶意进程（见 ports/work-recording-policy.ts）。
 * ------------------------------------------------------------------ */
export const WORK_RECORDING_PUBLISH_MAX_BODY_BYTES_CAP = 1_048_576;
export const WORK_RECORDING_PUBLISH_MAX_ATTACHMENT_BYTES_CAP = 1_048_576;
export const WORK_RECORDING_PUBLISH_MAX_TOTAL_BYTES_CAP = 8_388_608;
export const WORK_RECORDING_PUBLISH_MAX_CHUNK_BYTES_CAP = 262_144;
export const WORK_RECORDING_PUBLISH_MAX_QUEUE_BYTES_CAP = 1_048_576;
export const WORK_RECORDING_PUBLISH_MAX_ATTACHMENTS_CAP = WORK_RECORDING_MAX_ATTACHMENTS;

export interface WorkRecordingPublishLimits {
  /** 每条公开正文的 retained byte 上限。 */
  readonly maxBodyBytes: number;
  /** 每个附件的 retained byte 上限。 */
  readonly maxAttachmentBytes: number;
  /** 一条消息及其附件的 retained byte 总上限。 */
  readonly maxTotalBytes: number;
  /** 单次从上游接收的 byte chunk 上限。 */
  readonly maxChunkBytes: number;
  /** 发布器正在等待 ArtifactPublisher 消费的 chunk 总上限。 */
  readonly maxQueueBytes: number;
  /** 一条消息最多接收的附件数，缺省与 Work Recording schema 一致。 */
  readonly maxAttachments?: number;
}

/** 正式形式（maxAttachments 总是有值，供清单/有效限制落盘）。 */
export type RequiredWorkRecordingPublishLimits = Required<WorkRecordingPublishLimits>;

function cappedPositiveInteger(value: unknown, context: ValidationContext, field: string, cap: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError(context, field, `必须是 ≥1 的有限安全整数（≤${cap}）`, value);
  }
  if (value > cap) {
    throw validationError(context, field, `超出硬上限 ${cap}`, value);
  }
  return value;
}

/**
 * 正文发布限制校验：拒绝非有限数、非安全整数、负数/零与超过硬上限的输入；
 * 排队上限不得小于单 chunk 上限（否则上游必然永久背压）。返回带缺省值的正式形式。
 */
export function validateWorkRecordingPublishLimits(
  value: unknown,
  context: ValidationContext = { operation: 'WorkRecording.publishLimits' },
  field = 'publishLimits',
): RequiredWorkRecordingPublishLimits {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'maxBodyBytes', 'maxAttachmentBytes', 'maxTotalBytes', 'maxChunkBytes', 'maxQueueBytes', 'maxAttachments',
  ], context, field);
  const limits: RequiredWorkRecordingPublishLimits = {
    maxBodyBytes: cappedPositiveInteger(object.maxBodyBytes, context, `${field}.maxBodyBytes`, WORK_RECORDING_PUBLISH_MAX_BODY_BYTES_CAP),
    maxAttachmentBytes: cappedPositiveInteger(object.maxAttachmentBytes, context, `${field}.maxAttachmentBytes`, WORK_RECORDING_PUBLISH_MAX_ATTACHMENT_BYTES_CAP),
    maxTotalBytes: cappedPositiveInteger(object.maxTotalBytes, context, `${field}.maxTotalBytes`, WORK_RECORDING_PUBLISH_MAX_TOTAL_BYTES_CAP),
    maxChunkBytes: cappedPositiveInteger(object.maxChunkBytes, context, `${field}.maxChunkBytes`, WORK_RECORDING_PUBLISH_MAX_CHUNK_BYTES_CAP),
    maxQueueBytes: cappedPositiveInteger(object.maxQueueBytes, context, `${field}.maxQueueBytes`, WORK_RECORDING_PUBLISH_MAX_QUEUE_BYTES_CAP),
    maxAttachments: object.maxAttachments === undefined
      ? WORK_RECORDING_MAX_ATTACHMENTS
      : cappedPositiveInteger(object.maxAttachments, context, `${field}.maxAttachments`, WORK_RECORDING_PUBLISH_MAX_ATTACHMENTS_CAP),
  };
  if (limits.maxQueueBytes < limits.maxChunkBytes) {
    throw validationError(context, `${field}.maxQueueBytes`, '不得小于 maxChunkBytes（否则必然背压）', limits.maxQueueBytes);
  }
  return limits;
}
export const WORK_RECORDING_COVERAGES = ['complete', 'partial', 'failed'] as const;
export type WorkRecordingCoverage = (typeof WORK_RECORDING_COVERAGES)[number];
export const WORK_RECORDING_SEQUENCE_RECONCILIATIONS = ['match', 'mismatch', 'not_available'] as const;
export type WorkRecordingSequenceReconciliation = (typeof WORK_RECORDING_SEQUENCE_RECONCILIATIONS)[number];
export const WORK_RECORDING_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool', 'error', 'result'] as const;
export type WorkRecordingMessageRole = (typeof WORK_RECORDING_MESSAGE_ROLES)[number];
export const WORK_RECORDING_MESSAGE_KINDS = [
  'message', 'tool_started', 'tool_finished', 'error', 'final_result', 'attachment',
] as const;
export type WorkRecordingMessageKind = (typeof WORK_RECORDING_MESSAGE_KINDS)[number];

export interface WorkRecordingArtifactRef {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
}

export interface WorkRecordingAttachmentRef extends WorkRecordingArtifactRef {
  readonly name: string | null;
  readonly mediaType: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface WorkRecordingMessageRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly sequence: number;
  readonly eventId: string;
  readonly messageKey: string;
  readonly kind: WorkRecordingMessageKind;
  readonly role: WorkRecordingMessageRole;
  readonly contentRef: WorkRecordingArtifactRef;
  readonly providerMessageId: string | null;
  readonly toolCallId: string | null;
  readonly parentToolCallId: string | null;
  readonly source: WorkRecordingSource;
  readonly sourceRefs: readonly string[];
  readonly attachments: readonly WorkRecordingAttachmentRef[];
  readonly occurredAtUtcMs: number;
  readonly recordedAtUtcMs: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface WorkRecordingCoverageScope {
  readonly covers: readonly string[];
  readonly excludes: readonly string[];
}

export interface WorkRecordingCompletenessFlags {
  readonly applied: boolean;
  readonly reasons: readonly string[];
}

export interface WorkRecordingManifestRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly version: number;
  readonly manifestRef: WorkRecordingArtifactRef | null;
  readonly watermark: number | null;
  readonly finalSequence: number | null;
  readonly sequenceReconciliation: WorkRecordingSequenceReconciliation;
  readonly coverage: WorkRecordingCoverage;
  readonly source: WorkRecordingSource;
  readonly scope: WorkRecordingCoverageScope;
  readonly missingReasons: readonly string[];
  readonly diagnostics: readonly string[];
  readonly truncation: WorkRecordingCompletenessFlags;
  readonly redaction: WorkRecordingCompletenessFlags;
  readonly sdkVersion: string | null;
  readonly formatVersion: string;
  readonly nativeRef: WorkSessionNativeRef | null;
  readonly unknownEventCount: number | null;
  readonly finalized: boolean;
}

function validateNonNegativeInteger(value: unknown, context: ValidationContext, field: string): number {
  const result = baseNonNegativeInteger(value, context, field);
  if (!Number.isSafeInteger(result)) throw validationError(context, field, '必须是安全整数');
  return result;
}

function validatePositiveInteger(value: unknown, context: ValidationContext, field: string): number {
  const result = basePositiveInteger(value, context, field);
  if (!Number.isSafeInteger(result)) throw validationError(context, field, '必须是安全整数');
  return result;
}

/** 只度量已经按固定键校验的元数据，不读取或度量正文。 */
function boundedJson<T>(value: T, context: ValidationContext, field: string): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORK_RECORDING_MAX_JSON_BYTES) {
    throw validationError(context, field, '索引元数据不得超过 65536 字节');
  }
  return value;
}

function text(value: unknown, context: ValidationContext, field: string, max = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || [...value].length > max || /[\u0000-\u001F\u007F]/.test(value)) {
    throw validationError(context, field, `必须是无控制字符的有界文本（≤${max} 码点）`, value);
  }
  return value;
}

function nullableText(value: unknown, context: ValidationContext, field: string, max = 256): string | null {
  return value === null ? null : text(value, context, field, max);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], context: ValidationContext, field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw validationError(context, field, `必须是 ${values.join(' | ')}`, value);
  }
  return value as T;
}

function bool(value: unknown, context: ValidationContext, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(context, field, '必须是布尔值', value);
  return value;
}

function boundedList(value: unknown, context: ValidationContext, field: string, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw validationError(context, field, `必须是有界数组（≤${max} 项）`, value);
  }
  return value.map((entry, index) => text(entry, context, `${field}[${index}]`, itemMax));
}

function artifactRef(value: unknown, context: ValidationContext, field: string): WorkRecordingArtifactRef {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['artifactId', 'contentHash', 'sizeBytes', 'locator'], context, field);
  return {
    artifactId: validateStableId(object.artifactId, context, `${field}.artifactId`),
    contentHash: validateSha256Digest(object.contentHash, context, `${field}.contentHash`),
    sizeBytes: validateNonNegativeInteger(object.sizeBytes, context, `${field}.sizeBytes`),
    locator: validateArtifactLocator(text(object.locator, context, `${field}.locator`, 1024), context, `${field}.locator`),
  };
}

function attachmentRef(value: unknown, context: ValidationContext, field: string): WorkRecordingAttachmentRef {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'artifactId', 'contentHash', 'sizeBytes', 'locator', 'name', 'mediaType', 'truncated', 'redacted',
  ], context, field);
  return {
    ...artifactRef({
      artifactId: object.artifactId,
      contentHash: object.contentHash,
      sizeBytes: object.sizeBytes,
      locator: object.locator,
    }, context, field),
    name: nullableText(object.name, context, `${field}.name`, 200),
    mediaType: text(object.mediaType, context, `${field}.mediaType`, 128),
    truncated: bool(object.truncated, context, `${field}.truncated`),
    redacted: bool(object.redacted, context, `${field}.redacted`),
  };
}

const MESSAGE_KEYS = [
  'id', 'createdAtUtcMs', 'revision', 'updatedAtUtcMs', 'projectId', 'sessionId', 'runId', 'attemptId',
  'invocationId', 'executionVersion', 'sequence', 'eventId', 'messageKey', 'kind', 'role', 'contentRef',
  'providerMessageId', 'toolCallId', 'parentToolCallId', 'source', 'sourceRefs', 'attachments',
  'occurredAtUtcMs', 'recordedAtUtcMs', 'truncated', 'redacted',
] as const;

export function validateWorkRecordingMessage(
  value: unknown,
  context: ValidationContext = { operation: 'WorkRecording.message' },
  field = 'message',
): WorkRecordingMessageRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, MESSAGE_KEYS, context, field);
  const occurredAtUtcMs = validateNonNegativeInteger(object.occurredAtUtcMs, context, `${field}.occurredAtUtcMs`);
  const recordedAtUtcMs = validateNonNegativeInteger(object.recordedAtUtcMs, context, `${field}.recordedAtUtcMs`);
  if (recordedAtUtcMs < occurredAtUtcMs) throw validationError(context, `${field}.recordedAtUtcMs`, '不得早于 occurredAtUtcMs');
  const kind = enumValue(object.kind, WORK_RECORDING_MESSAGE_KINDS, context, `${field}.kind`);
  const toolCallId = nullableText(object.toolCallId, context, `${field}.toolCallId`);
  const parentToolCallId = nullableText(object.parentToolCallId, context, `${field}.parentToolCallId`);
  if ((kind === 'tool_started' || kind === 'tool_finished') && toolCallId === null) {
    throw validationError(context, field, '工具事件必须带 toolCallId');
  }
  if (parentToolCallId !== null && (toolCallId === null || parentToolCallId === toolCallId)) {
    throw validationError(context, field, '父工具需要不同的当前工具身份');
  }
  if (!Array.isArray(object.attachments) || object.attachments.length > WORK_RECORDING_MAX_ATTACHMENTS) {
    throw validationError(context, `${field}.attachments`, '必须是有界附件数组（≤32 项）');
  }
  const attachments = boundedJson(object.attachments.map((entry, index) =>
    attachmentRef(entry, context, `${field}.attachments[${index}]`)), context, `${field}.attachments`);
  return {
    id: validateStableId(object.id, context, `${field}.id`),
    createdAtUtcMs: validateNonNegativeInteger(object.createdAtUtcMs, context, `${field}.createdAtUtcMs`),
    revision: validatePositiveInteger(object.revision, context, `${field}.revision`),
    updatedAtUtcMs: validateNonNegativeInteger(object.updatedAtUtcMs, context, `${field}.updatedAtUtcMs`),
    projectId: validateStableId(object.projectId, context, `${field}.projectId`),
    sessionId: validateStableId(object.sessionId, context, `${field}.sessionId`),
    runId: validateStableId(object.runId, context, `${field}.runId`),
    attemptId: validateStableId(object.attemptId, context, `${field}.attemptId`),
    invocationId: validateStableId(object.invocationId, context, `${field}.invocationId`),
    executionVersion: validatePositiveInteger(object.executionVersion, context, `${field}.executionVersion`),
    sequence: validatePositiveInteger(object.sequence, context, `${field}.sequence`),
    eventId: text(object.eventId, context, `${field}.eventId`),
    messageKey: text(object.messageKey, context, `${field}.messageKey`),
    kind,
    role: enumValue(object.role, WORK_RECORDING_MESSAGE_ROLES, context, `${field}.role`),
    contentRef: artifactRef(object.contentRef, context, `${field}.contentRef`),
    providerMessageId: nullableText(object.providerMessageId, context, `${field}.providerMessageId`),
    toolCallId,
    parentToolCallId,
    source: enumValue(object.source, WORK_RECORDING_SOURCES, context, `${field}.source`),
    sourceRefs: boundedList(object.sourceRefs, context, `${field}.sourceRefs`, WORK_RECORDING_MAX_SOURCE_REFS, 256),
    attachments,
    occurredAtUtcMs,
    recordedAtUtcMs,
    truncated: bool(object.truncated, context, `${field}.truncated`),
    redacted: bool(object.redacted, context, `${field}.redacted`),
  };
}

export const validateSessionMessageRecord = validateWorkRecordingMessage;
export type SessionMessageRecord = WorkRecordingMessageRecord;

function flags(value: unknown, context: ValidationContext, field: string): WorkRecordingCompletenessFlags {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['applied', 'reasons'], context, field);
  const applied = bool(object.applied, context, `${field}.applied`);
  const reasons = boundedList(object.reasons, context, `${field}.reasons`, WORK_RECORDING_MAX_DIAGNOSTICS, 256);
  if (applied !== (reasons.length > 0)) throw validationError(context, field, '标记与原因必须一致');
  return { applied, reasons };
}

function scope(value: unknown, context: ValidationContext, field: string): WorkRecordingCoverageScope {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['covers', 'excludes'], context, field);
  const covers = boundedList(object.covers, context, `${field}.covers`, 32, 128);
  const excludes = boundedList(object.excludes, context, `${field}.excludes`, 32, 128);
  if (covers.length === 0 || covers.some((entry) => !(WORK_RECORDING_PUBLIC_SCOPES as readonly string[]).includes(entry) || excludes.includes(entry))
    || WORK_RECORDING_REQUIRED_EXCLUSIONS.some((entry) => !excludes.includes(entry))) {
    throw validationError(context, field, '只允许声明公开记录范围，并须排除隐藏推理、私有档案和统一审计');
  }
  return { covers, excludes };
}

const MANIFEST_KEYS = [
  'id', 'createdAtUtcMs', 'revision', 'updatedAtUtcMs', 'projectId', 'sessionId', 'runId', 'attemptId',
  'invocationId', 'executionVersion', 'version', 'manifestRef', 'watermark', 'finalSequence',
  'sequenceReconciliation', 'coverage', 'source', 'scope', 'missingReasons', 'diagnostics', 'truncation',
  'redaction', 'sdkVersion', 'formatVersion', 'nativeRef', 'unknownEventCount', 'finalized',
] as const;

export function validateWorkRecordingManifest(
  value: unknown,
  context: ValidationContext = { operation: 'WorkRecording.manifest' },
  field = 'manifest',
): WorkRecordingManifestRecord {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, MANIFEST_KEYS, context, field);
  const coverage = enumValue(object.coverage, WORK_RECORDING_COVERAGES, context, `${field}.coverage`);
  const missingReasons = boundedList(object.missingReasons, context, `${field}.missingReasons`, WORK_RECORDING_MAX_MISSING_REASONS, 256);
  if (coverage === 'complete' && missingReasons.length > 0) {
    throw validationError(context, `${field}.coverage`, 'complete 不得带缺失原因');
  }
  const watermark = object.watermark === null ? null : validateNonNegativeInteger(object.watermark, context, `${field}.watermark`);
  const finalSequence = object.finalSequence === null ? null : validateNonNegativeInteger(object.finalSequence, context, `${field}.finalSequence`);
  if (watermark !== null && finalSequence !== null && watermark > finalSequence) {
    throw validationError(context, `${field}.watermark`, '不得超过 finalSequence');
  }
  const finalized = bool(object.finalized, context, `${field}.finalized`);
  const sequenceReconciliation = enumValue(object.sequenceReconciliation, WORK_RECORDING_SEQUENCE_RECONCILIATIONS, context, `${field}.sequenceReconciliation`);
  const unknownEventCount = object.unknownEventCount === null ? null : validateNonNegativeInteger(object.unknownEventCount, context, `${field}.unknownEventCount`);
  const truncation = flags(object.truncation, context, `${field}.truncation`);
  const redaction = flags(object.redaction, context, `${field}.redaction`);
  if (sequenceReconciliation === 'match' && (watermark === null || finalSequence === null || watermark !== finalSequence)) {
    throw validationError(context, field, 'match 必须有相等的已知水位与终态序列');
  }
  if (coverage === 'complete' && (unknownEventCount !== 0 || truncation.applied
    || (finalized && sequenceReconciliation !== 'match'))) {
    throw validationError(context, field, 'complete 不得存在未知事件、截断或未核齐的终态水位');
  }
  if (coverage !== 'complete' && missingReasons.length === 0) {
    throw validationError(context, field, 'partial/failed 必须声明缺失原因');
  }
  return {
    id: validateStableId(object.id, context, `${field}.id`),
    createdAtUtcMs: validateNonNegativeInteger(object.createdAtUtcMs, context, `${field}.createdAtUtcMs`),
    revision: validatePositiveInteger(object.revision, context, `${field}.revision`),
    updatedAtUtcMs: validateNonNegativeInteger(object.updatedAtUtcMs, context, `${field}.updatedAtUtcMs`),
    projectId: validateStableId(object.projectId, context, `${field}.projectId`),
    sessionId: validateStableId(object.sessionId, context, `${field}.sessionId`),
    runId: validateStableId(object.runId, context, `${field}.runId`),
    attemptId: validateStableId(object.attemptId, context, `${field}.attemptId`),
    invocationId: validateStableId(object.invocationId, context, `${field}.invocationId`),
    executionVersion: validatePositiveInteger(object.executionVersion, context, `${field}.executionVersion`),
    version: validatePositiveInteger(object.version, context, `${field}.version`),
    manifestRef: object.manifestRef === null ? null : artifactRef(object.manifestRef, context, `${field}.manifestRef`),
    watermark,
    finalSequence,
    sequenceReconciliation,
    coverage,
    source: enumValue(object.source, WORK_RECORDING_SOURCES, context, `${field}.source`),
    scope: scope(object.scope, context, `${field}.scope`),
    missingReasons,
    diagnostics: boundedList(object.diagnostics, context, `${field}.diagnostics`, WORK_RECORDING_MAX_DIAGNOSTICS, 256),
    truncation,
    redaction,
    sdkVersion: object.sdkVersion === null ? null : text(object.sdkVersion, context, `${field}.sdkVersion`, 128),
    formatVersion: text(object.formatVersion, context, `${field}.formatVersion`, 128),
    nativeRef: object.nativeRef === null ? null : validateWorkSessionNativeRef(object.nativeRef, context, `${field}.nativeRef`),
    unknownEventCount,
    finalized,
  };
}

export const validateRecordingManifestRecord = validateWorkRecordingManifest;
export type RecordingManifestRecord = WorkRecordingManifestRecord;

/** 由已授权的 WorkSession/Attempt 装配；不得从待写记录本身构造。 */
export type WorkRecordingIdentity = Pick<WorkRecordingMessageRecord,
  'projectId' | 'sessionId' | 'runId' | 'attemptId' | 'invocationId' | 'executionVersion'>;

/** 形状校验后核对可信身份。纯记录校验不能替代既有 principal 授权。 */
export function assertWorkRecordingIdentity(
  record: WorkRecordingMessageRecord | WorkRecordingManifestRecord,
  authorized: WorkRecordingIdentity,
  context: ValidationContext = { operation: 'WorkRecording.identity' },
): void {
  for (const key of ['projectId', 'sessionId', 'runId', 'attemptId', 'invocationId'] as const) {
    const expected = validateStableId(authorized[key], context, `authorized.${key}`);
    if (record[key] !== expected) throw validationError(context, key, '不属于已授权的 Work 身份');
  }
  const version = validatePositiveInteger(authorized.executionVersion, context, 'authorized.executionVersion');
  if (record.executionVersion !== version) throw validationError(context, 'executionVersion', '执行版本不匹配');
}
