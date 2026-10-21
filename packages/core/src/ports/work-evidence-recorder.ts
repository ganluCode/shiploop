/**
 * P03-6 / F-007 最小有界公开事件与结果证据采集（ports 契约层：类型、常量与
 * 纯校验函数，无任何 I/O）。
 *
 * 设计依据：core-design/05-runtime-and-session-recording.md §5/§6（manifest
 * 至少含适配版本、采集范围、来源、水位、截断/脱敏标记、缺失原因与终态核对
 * 结果；complete 只对已声明范围成立；每批水位只推进到持久内容）、
 * core-design/14-runtime-recovery-and-durable.md §6（恢复后以稳定事件身份
 * 去重，sequence 水位只指向已持久内容；用量声明 incremental/cumulative 及
 * 统计范围，历史基线与新增分开；没有稳定身份的记录标 partial）与
 * input/p03-fake-runtime.md FR-2（Core 建立有界公开事件/结果制品，标记可见
 * 范围和缺口）。
 *
 * 契约要点：
 * - 本契约只覆盖 Fake 可见公开范围：公开事件（含工具事件可见字段）、最终
 *   结果与最小诊断；明确不含原生档案、隐藏推理、真实 Token 审计与供应商
 *   计费保证（scope.excludes 固定词汇，校验器不接受缩减或夸大）；
 * - 事件正文为 NDJSON 分块（WorkEvidenceEventLine）：v/sequence/eventId/
 *   kind/occurredAtUtc/payload 固定键，payload 复用 F-001 事件校验；正文
 *   一律经既有 Artifact 发布端口落盘，本层不接触文件/SQLite；
 * - 覆盖清单（WorkEvidenceManifest）记录关联身份（Project/Feature/Run/
 *   Task/Attempt/Session/invocation/executionVersion/owner/host）、runtime
 *   与适配版本、分块引用（artifactId/hash/size/序列范围）、水位、最终结果
 *   序列核对（match/mismatch/not_available）、缺口与统计、脱敏标记与用量
 *   摘要；读取侧 fail-closed（未知键/形状漂移一律 validation）；
 * - 用量摘要：事件观察按稳定 eventId 去重后计数（semantics 固定
 *   per_event_observation），basis 区分 synthetic/reported/mixed/none，
 *   任一观察字段未知则该字段总量为 null 且 complete=false；最终结果用量
 *   finalReported 单列，historicalBaseline v1 恒 null，notAdditive 恒
 *   true——事件观察与最终结果汇总绝不重复加总，不建立真实缓存/费用汇总；
 * - 采集限制（WorkEvidenceRecorderLimits）全部显式有界：单事件正文字节、
 *   分块事件数/字节、总事件数/总字节、乱序窗口与尾部等待毫秒；装配只能
 *   在硬上限内收窄；
 * - 缺口条目复用 F-006 recording_gaps 边界（≤32 条、每条 ≤256 码点、无
 *   控制字符）；缺口词汇由应用层产出（missing_sequences/event_body_too_
 *   large/late_event_beyond_window/event_identity_conflict/unknown_events/
 *   foreign_events/invalid_event/result_invalid/result_tail_timeout/
 *   events_tail_timeout/final_sequence_mismatch/limit_exceeded/
 *   recording_failed/gaps_overflow），本层只固定边界不枚举取值。
 *
 * 实现者：application/work-evidence-recorder.ts（采集编排）。本层不实现
 * 采集、不导入 SDK/ORM/文件模块。
 */
import {
  validateRuntimeEvent,
  validateRuntimeUsageReport,
  validateRuntimeStopEvidence,
  RUNTIME_TERMINAL_STATES,
} from './runtime-execution.js';
import type {
  RuntimeEventKind,
  RuntimeEventPayload,
  RuntimeTerminalState,
  RuntimeUsageReport,
} from './runtime-execution.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateArtifactLocator,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';
import { validateRuntimeRecoveryRecording } from './runtime-recovery-recording.js';
import { RECORDING_GAPS_MAX_COUNT, RECORDING_GAP_MAX_LENGTH } from './work-session.js';

export const WORK_EVIDENCE_SCHEMA_VERSION = 1;

/** 事件分块制品 kind / mediaType（正文为 NDJSON，一行一条 WorkEvidenceEventLine）。 */
export const WORK_EVIDENCE_EVENTS_KIND = 'work-evidence-events';
export const WORK_EVIDENCE_EVENTS_MEDIA_TYPE = 'application/x-ndjson';
/** 覆盖清单制品 kind / mediaType（正文为 WorkEvidenceManifest JSON）。 */
export const WORK_EVIDENCE_MANIFEST_KIND = 'work-evidence-manifest';
export const WORK_EVIDENCE_MANIFEST_MEDIA_TYPE = 'application/json';

/* ------------------------------------------------------------------ *
 * 采集限制（全部显式有界；装配只能在硬上限内收窄）
 * ------------------------------------------------------------------ */

export const WORK_EVIDENCE_MAX_EVENT_BODY_BYTES_CAP = 65_536;
export const WORK_EVIDENCE_CHUNK_MAX_EVENTS_CAP = 10_000;
export const WORK_EVIDENCE_CHUNK_MAX_BYTES_CAP = 1_048_576;
export const WORK_EVIDENCE_MAX_TOTAL_EVENTS_CAP = 100_000;
export const WORK_EVIDENCE_MAX_TOTAL_BYTES_CAP = 8_388_608;
export const WORK_EVIDENCE_REORDER_WINDOW_CAP = 16;
export const WORK_EVIDENCE_TAIL_WAIT_MS_CAP = 600_000;
/** 清单内最小诊断条目上限（与 F-001 会话诊断上限一致）。 */
export const WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT = 32;
export const WORK_EVIDENCE_DIAGNOSTIC_MAX_LENGTH = 200;

export interface WorkEvidenceRecorderLimits {
  /** 单条序列化事件行字节上限（超限标记省略，不截断正文冒充完整）。 */
  readonly maxEventBodyBytes: number;
  /** 单个事件分块最多事件数。 */
  readonly chunkMaxEvents: number;
  /** 单个事件分块最多字节数。 */
  readonly chunkMaxBytes: number;
  /** 单次采集接收事件总数上限（超限受控停止）。 */
  readonly maxTotalEvents: number;
  /** 单次采集持久化总字节上限（超限受控停止）。 */
  readonly maxTotalBytes: number;
  /** 声明的有限乱序窗口（0 表示不接受任何乱序）。 */
  readonly reorderWindow: number;
  /** 尾部等待上限：一侧完结后等待另一侧的最长毫秒数。 */
  readonly tailWaitMs: number;
}

export function validateWorkEvidenceRecorderLimits(
  value: unknown,
  context: ValidationContext = { operation: 'WorkEvidenceRecorder.limits' },
  field = 'limits',
): WorkEvidenceRecorderLimits {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'maxEventBodyBytes', 'chunkMaxEvents', 'chunkMaxBytes',
    'maxTotalEvents', 'maxTotalBytes', 'reorderWindow', 'tailWaitMs',
  ], context, field);
  const bounded = (key: string, cap: number): number => {
    const parsed = validatePositiveInteger(object[key], context, `${field}.${key}`);
    if (parsed > cap) {
      throw validationError(context, `${field}.${key}`, `超出硬上限 ${cap}`, object[key]);
    }
    return parsed;
  };
  return {
    maxEventBodyBytes: bounded('maxEventBodyBytes', WORK_EVIDENCE_MAX_EVENT_BODY_BYTES_CAP),
    chunkMaxEvents: bounded('chunkMaxEvents', WORK_EVIDENCE_CHUNK_MAX_EVENTS_CAP),
    chunkMaxBytes: bounded('chunkMaxBytes', WORK_EVIDENCE_CHUNK_MAX_BYTES_CAP),
    maxTotalEvents: bounded('maxTotalEvents', WORK_EVIDENCE_MAX_TOTAL_EVENTS_CAP),
    maxTotalBytes: bounded('maxTotalBytes', WORK_EVIDENCE_MAX_TOTAL_BYTES_CAP),
    reorderWindow: (() => {
      const parsed = validateNonNegativeInteger(object.reorderWindow, context, `${field}.reorderWindow`);
      if (parsed > WORK_EVIDENCE_REORDER_WINDOW_CAP) {
        throw validationError(context, `${field}.reorderWindow`, `超出硬上限 ${WORK_EVIDENCE_REORDER_WINDOW_CAP}`, object.reorderWindow);
      }
      return parsed;
    })(),
    tailWaitMs: bounded('tailWaitMs', WORK_EVIDENCE_TAIL_WAIT_MS_CAP),
  };
}

/* ------------------------------------------------------------------ *
 * 事件行（NDJSON 分块正文；payload 复用 F-001 事件校验）
 * ------------------------------------------------------------------ */

export interface WorkEvidenceEventLine {
  readonly v: typeof WORK_EVIDENCE_SCHEMA_VERSION;
  readonly sequence: number;
  readonly eventId: string;
  readonly kind: RuntimeEventKind;
  readonly occurredAtUtc: string;
  readonly payload: RuntimeEventPayload;
}

/** 事件行校验：固定六键；事件部分委托 F-001 validateRuntimeEvent（违约折算 validation）。 */
export function validateWorkEvidenceEventLine(
  value: unknown,
  context: ValidationContext = { operation: 'WorkEvidence.eventLine' },
  field = 'line',
): WorkEvidenceEventLine {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['v', 'sequence', 'eventId', 'kind', 'occurredAtUtc', 'payload'], context, field);
  if (object.v !== WORK_EVIDENCE_SCHEMA_VERSION) {
    throw validationError(context, `${field}.v`, `仅支持版本 ${WORK_EVIDENCE_SCHEMA_VERSION}`, object.v);
  }
  try {
    const payload = requirePlainObject(object.payload, context, `${field}.payload`);
    if (payload.kind !== object.kind) {
      throw validationError(context, `${field}.payload.kind`, '必须与事件 kind 一致');
    }
    const { kind: _kind, ...wirePayload } = payload;
    if (object.kind === 'usage') {
      rejectUnknownKeys(payload, ['kind', 'usage'], context, `${field}.payload`);
    }
    const event = validateRuntimeEvent({
      schemaVersion: 1,
      eventId: object.eventId,
      kind: object.kind,
      sequence: object.sequence,
      occurredAtUtc: object.occurredAtUtc,
      payload: object.kind === 'usage' ? payload.usage : wirePayload,
    });
    return {
      v: WORK_EVIDENCE_SCHEMA_VERSION,
      sequence: event.sequence,
      eventId: event.eventId,
      kind: event.kind,
      occurredAtUtc: event.occurredAtUtc,
      payload: event.payload,
    };
  } catch (error) {
    throw validationError(context, field, '事件行内容违反 F-001 事件契约', error instanceof Error ? error.message : 'invalid');
  }
}

/* ------------------------------------------------------------------ *
 * 覆盖清单（WorkEvidenceManifest）
 * ------------------------------------------------------------------ */

/** 清单声明的采集范围（固定词汇，校验器不接受缩减或夸大）。 */
export const WORK_EVIDENCE_SCOPE_COVERS = [
  'public_events', 'tool_events', 'final_result', 'diagnostics',
] as const;
/** 清单明确排除的保证（无原生档案、隐藏推理、真实 Token 审计与供应商计费）。 */
export const WORK_EVIDENCE_SCOPE_EXCLUDES = [
  'native_archive', 'hidden_reasoning', 'real_token_audit', 'provider_billing',
] as const;

export interface WorkEvidenceIdentity {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly executionVersion: number;
  readonly owner: string;
  readonly hostInstanceId: string;
}

export interface WorkEvidenceChunkRef {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
}

export type WorkEvidenceSequenceReconciliation = 'match' | 'mismatch' | 'not_available';

export type WorkEvidenceResultStatus = 'settled' | 'invalid' | 'tail_timeout' | 'aborted';

export type WorkEvidenceCoverage = 'complete' | 'partial' | 'failed';

export interface WorkEvidenceStats {
  /** 从适配器接收到的事件条目总数（含重复/乱序/未知/外来）。 */
  readonly eventsReceived: number;
  /** 实际持久化进分块的事件条数。 */
  readonly eventsPersisted: number;
  /** 稳定身份全等去重丢弃的重复条数（不重复产生有效事件/用量）。 */
  readonly duplicatesDropped: number;
  /** 未知公开事件条数（仅留有界诊断）。 */
  readonly unknownEvents: number;
  /** 身份不属于本次执行的事件条数（仅留有界诊断，不进水位）。 */
  readonly foreignEvents: number;
  /** 超出声明乱序窗口的迟到事件条数（不持久化）。 */
  readonly lateEvents: number;
  /** 因单事件正文超限而省略的条数（缺口标注）。 */
  readonly eventsOmitted: number;
  /** 已持久化正文总字节。 */
  readonly bytesPersisted: number;
}

export type WorkEvidenceUsageBasis = 'synthetic' | 'reported' | 'mixed' | 'none';

export interface WorkEvidenceUsageTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
  /** 全部计入观察的所有字段均已知才为 true；任一未知即 false 且对应字段为 null。 */
  readonly complete: boolean;
}

export interface WorkEvidenceUsageSummary {
  readonly basis: WorkEvidenceUsageBasis;
  /** 去重后计入的事件观察条数与逐字段总量；semantics 固定 per_event_observation。 */
  readonly observations: {
    readonly counted: number;
    readonly semantics: 'per_event_observation';
    readonly totals: WorkEvidenceUsageTotals;
  };
  /** 最终结果报告的用量（单列，绝不并入观察总量）。 */
  readonly finalReported: RuntimeUsageReport | null;
  /** 恢复历史基线：v1 恒 null（Fake 不实现恢复续接）。 */
  readonly historicalBaseline: null;
  /** 恒 true：事件观察与最终结果汇总不重复加总。 */
  readonly notAdditive: true;
}

export interface WorkEvidenceResultSummary {
  readonly terminal: RuntimeTerminalState;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly usage: RuntimeUsageReport | null;
  readonly lastEventSequence: number | null;
}

export interface WorkEvidenceStopObservation {
  readonly status: 'observed' | 'invalid' | 'tail_timeout';
  readonly evidence: import('./runtime-execution.js').RuntimeStopEvidence | null;
}

export interface WorkEvidenceManifest {
  readonly stop?: WorkEvidenceStopObservation;
  readonly recordingMode?: 'required' | 'best_effort';
  readonly recovery?: import('./runtime-recovery-recording.js').RuntimeRecoveryRecording;
  readonly schemaVersion: typeof WORK_EVIDENCE_SCHEMA_VERSION;
  readonly kind: typeof WORK_EVIDENCE_MANIFEST_KIND;
  readonly identity: WorkEvidenceIdentity;
  readonly runtime: string;
  readonly adapterVersion: string;
  readonly scope: {
    readonly source: 'live';
    readonly covers: readonly (typeof WORK_EVIDENCE_SCOPE_COVERS)[number][];
    readonly excludes: readonly (typeof WORK_EVIDENCE_SCOPE_EXCLUDES)[number][];
  };
  readonly redaction: {
    readonly applied: boolean;
    readonly secretValueCount: number;
  };
  readonly chunks: readonly WorkEvidenceChunkRef[];
  /** 已持久化水位（最后持久序列；缺口由 gaps 标注，水位不暗示空洞已填平）。 */
  readonly watermark: number | null;
  /** 最终结果声明的最后事件序列（未知为 null）。 */
  readonly finalEventSequence: number | null;
  readonly sequenceReconciliation: WorkEvidenceSequenceReconciliation;
  readonly gaps: readonly string[];
  readonly stats: WorkEvidenceStats;
  readonly usage: WorkEvidenceUsageSummary;
  readonly result: WorkEvidenceResultSummary | null;
  readonly resultStatus: WorkEvidenceResultStatus;
  /** 最小诊断（未知/外来/迟到等受限条目；有界，不透传未知 payload）。 */
  readonly diagnostics: readonly string[];
  /** complete 只对已声明范围成立；任何缺口/核对不一致均为 partial。 */
  readonly coverage: WorkEvidenceCoverage;
}

function boundedManifestText(value: unknown, maxCodePoints: number, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxCodePoints) {
    throw validationError(context, field, `必须是有界文本（≤${maxCodePoints} 码点）`, typeof value);
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw validationError(context, field, '不得含控制字符', value);
  }
  return value;
}

function optionalCount(value: unknown, context: ValidationContext, field: string): number | null {
  if (value === null) return null;
  return validateNonNegativeInteger(value, context, field);
}

function optionalToken(value: unknown, context: ValidationContext, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw validationError(context, field, '必须是受限 token 或 null', typeof value);
  }
  return value;
}

function validateIdentity(value: unknown, context: ValidationContext, field: string): WorkEvidenceIdentity {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'projectId', 'featureId', 'runId', 'taskId', 'attemptId', 'sessionId',
    'invocationId', 'executionVersion', 'owner', 'hostInstanceId',
  ], context, field);
  return {
    projectId: validateStableId(object.projectId, context, `${field}.projectId`),
    featureId: validateStableId(object.featureId, context, `${field}.featureId`),
    runId: validateStableId(object.runId, context, `${field}.runId`),
    taskId: validateStableId(object.taskId, context, `${field}.taskId`),
    attemptId: validateStableId(object.attemptId, context, `${field}.attemptId`),
    sessionId: validateStableId(object.sessionId, context, `${field}.sessionId`),
    invocationId: validateStableId(object.invocationId, context, `${field}.invocationId`),
    executionVersion: validateNonNegativeInteger(object.executionVersion, context, `${field}.executionVersion`),
    owner: validateStableId(object.owner, context, `${field}.owner`),
    hostInstanceId: validateStableId(object.hostInstanceId, context, `${field}.hostInstanceId`),
  };
}

function validateChunkRef(value: unknown, context: ValidationContext, field: string): WorkEvidenceChunkRef {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'artifactId', 'contentHash', 'sizeBytes', 'locator', 'firstSequence', 'lastSequence', 'eventCount',
  ], context, field);
  const firstSequence = validatePositiveInteger(object.firstSequence, context, `${field}.firstSequence`);
  const lastSequence = validatePositiveInteger(object.lastSequence, context, `${field}.lastSequence`);
  const eventCount = validatePositiveInteger(object.eventCount, context, `${field}.eventCount`);
  if (lastSequence < firstSequence) {
    throw validationError(context, `${field}.lastSequence`, '分块序列范围倒挂', object.lastSequence);
  }
  if (lastSequence - firstSequence + 1 < eventCount) {
    throw validationError(context, `${field}.eventCount`, '分块事件数超出序列范围', object.eventCount);
  }
  return {
    artifactId: validateStableId(object.artifactId, context, `${field}.artifactId`),
    contentHash: validateSha256Digest(object.contentHash, context, `${field}.contentHash`),
    sizeBytes: validateNonNegativeInteger(object.sizeBytes, context, `${field}.sizeBytes`),
    locator: validateArtifactLocator(object.locator, context, `${field}.locator`),
    firstSequence,
    lastSequence,
    eventCount,
  };
}

function validateGaps(value: unknown, context: ValidationContext, field: string): string[] {
  if (!Array.isArray(value) || value.length > RECORDING_GAPS_MAX_COUNT) {
    throw validationError(context, field, `必须是有界缺口数组（≤${RECORDING_GAPS_MAX_COUNT} 项）`, typeof value);
  }
  return value.map((entry, index) =>
    boundedManifestText(entry, RECORDING_GAP_MAX_LENGTH, context, `${field}[${index}]`));
}

function validateDiagnostics(value: unknown, context: ValidationContext, field: string): string[] {
  if (!Array.isArray(value) || value.length > WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT) {
    throw validationError(context, field, `必须是有界诊断数组（≤${WORK_EVIDENCE_DIAGNOSTICS_MAX_COUNT} 项）`, typeof value);
  }
  return value.map((entry, index) =>
    boundedManifestText(entry, WORK_EVIDENCE_DIAGNOSTIC_MAX_LENGTH, context, `${field}[${index}]`));
}

function validateUsageTotals(value: unknown, context: ValidationContext, field: string): WorkEvidenceUsageTotals {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['inputTokens', 'outputTokens', 'costUsdMicros', 'complete'], context, field);
  if (typeof object.complete !== 'boolean') {
    throw validationError(context, `${field}.complete`, '必须是布尔', typeof object.complete);
  }
  return {
    inputTokens: optionalCount(object.inputTokens, context, `${field}.inputTokens`),
    outputTokens: optionalCount(object.outputTokens, context, `${field}.outputTokens`),
    costUsdMicros: optionalCount(object.costUsdMicros, context, `${field}.costUsdMicros`),
    complete: object.complete,
  };
}

function validateUsageSummary(value: unknown, context: ValidationContext, field: string): WorkEvidenceUsageSummary {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['basis', 'observations', 'finalReported', 'historicalBaseline', 'notAdditive'], context, field);
  const basis = object.basis;
  if (basis !== 'synthetic' && basis !== 'reported' && basis !== 'mixed' && basis !== 'none') {
    throw validationError(context, `${field}.basis`, '必须是 synthetic | reported | mixed | none', basis);
  }
  const observations = requirePlainObject(object.observations, context, `${field}.observations`);
  rejectUnknownKeys(observations, ['counted', 'semantics', 'totals'], context, `${field}.observations`);
  if (observations.semantics !== 'per_event_observation') {
    throw validationError(context, `${field}.observations.semantics`, '仅支持 per_event_observation', observations.semantics);
  }
  if (object.historicalBaseline !== null) {
    throw validationError(context, `${field}.historicalBaseline`, 'v1 必须为 null（无恢复历史基线）', object.historicalBaseline);
  }
  if (object.notAdditive !== true) {
    throw validationError(context, `${field}.notAdditive`, '必须为 true（观察与最终汇总不重复加总）', object.notAdditive);
  }
  let finalReported: RuntimeUsageReport | null;
  if (object.finalReported === null) {
    finalReported = null;
  } else {
    try {
      finalReported = validateRuntimeUsageReport(object.finalReported, `${field}.finalReported`);
    } catch (error) {
      throw validationError(context, `${field}.finalReported`, '最终用量违反 F-001 用量契约', error instanceof Error ? error.message : 'invalid');
    }
  }
  return {
    basis,
    observations: {
      counted: validateNonNegativeInteger(observations.counted, context, `${field}.observations.counted`),
      semantics: 'per_event_observation',
      totals: validateUsageTotals(observations.totals, context, `${field}.observations.totals`),
    },
    finalReported,
    historicalBaseline: null,
    notAdditive: true,
  };
}

function validateResultSummary(value: unknown, context: ValidationContext, field: string): WorkEvidenceResultSummary {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'terminal', 'reason', 'exitCode', 'signal', 'durationMs', 'usage', 'lastEventSequence',
  ], context, field);
  if (typeof object.terminal !== 'string' || !(RUNTIME_TERMINAL_STATES as readonly string[]).includes(object.terminal)) {
    throw validationError(context, `${field}.terminal`, '必须是已知终态词汇', object.terminal);
  }
  let usage: RuntimeUsageReport | null;
  if (object.usage === null) {
    usage = null;
  } else {
    try {
      usage = validateRuntimeUsageReport(object.usage, `${field}.usage`);
    } catch (error) {
      throw validationError(context, `${field}.usage`, '结果用量违反 F-001 用量契约', error instanceof Error ? error.message : 'invalid');
    }
  }
  const exitCode = object.exitCode;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
    throw validationError(context, `${field}.exitCode`, '必须是 0..255 或 null', exitCode);
  }
  return {
    terminal: object.terminal as RuntimeTerminalState,
    reason: optionalToken(object.reason, context, `${field}.reason`),
    exitCode: exitCode as number | null,
    signal: optionalToken(object.signal, context, `${field}.signal`),
    durationMs: optionalCount(object.durationMs, context, `${field}.durationMs`),
    usage,
    lastEventSequence: optionalCount(object.lastEventSequence, context, `${field}.lastEventSequence`),
  };
}

const SCOPE_STATEMENT_ERROR = '采集范围必须完整声明固定 covers/excludes 词汇（不接受缩减或夸大）';

function validateScope(value: unknown, context: ValidationContext, field: string): WorkEvidenceManifest['scope'] {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, ['source', 'covers', 'excludes'], context, field);
  if (object.source !== 'live') {
    throw validationError(context, `${field}.source`, 'v1 仅支持 live 来源', object.source);
  }
  const covers = object.covers;
  const excludes = object.excludes;
  if (!Array.isArray(covers) || covers.length !== WORK_EVIDENCE_SCOPE_COVERS.length ||
      ![...WORK_EVIDENCE_SCOPE_COVERS].every((entry) => (covers as unknown[]).includes(entry))) {
    throw validationError(context, `${field}.covers`, SCOPE_STATEMENT_ERROR, covers);
  }
  if (!Array.isArray(excludes) || excludes.length !== WORK_EVIDENCE_SCOPE_EXCLUDES.length ||
      ![...WORK_EVIDENCE_SCOPE_EXCLUDES].every((entry) => (excludes as unknown[]).includes(entry))) {
    throw validationError(context, `${field}.excludes`, SCOPE_STATEMENT_ERROR, excludes);
  }
  return {
    source: 'live',
    covers: [...WORK_EVIDENCE_SCOPE_COVERS],
    excludes: [...WORK_EVIDENCE_SCOPE_EXCLUDES],
  };
}

/** 覆盖清单校验：读取侧 fail-closed（未知键/形状漂移/范围夸大均 validation）。 */
export function validateWorkEvidenceManifest(
  value: unknown,
  context: ValidationContext = { operation: 'WorkEvidence.manifest' },
  field = 'manifest',
): WorkEvidenceManifest {
  const object = requirePlainObject(value, context, field);
  rejectUnknownKeys(object, [
    'schemaVersion', 'kind', 'identity', 'runtime', 'adapterVersion', 'scope', 'redaction',
    'chunks', 'watermark', 'finalEventSequence', 'sequenceReconciliation', 'gaps', 'stats',
    'usage', 'result', 'resultStatus', 'diagnostics', 'coverage', 'recovery', 'stop', 'recordingMode',
  ], context, field);
  if (object.schemaVersion !== WORK_EVIDENCE_SCHEMA_VERSION) {
    throw validationError(context, `${field}.schemaVersion`, `仅支持版本 ${WORK_EVIDENCE_SCHEMA_VERSION}`, object.schemaVersion);
  }
  if (object.kind !== WORK_EVIDENCE_MANIFEST_KIND) {
    throw validationError(context, `${field}.kind`, `必须是 ${WORK_EVIDENCE_MANIFEST_KIND}`, object.kind);
  }
  const redaction = requirePlainObject(object.redaction, context, `${field}.redaction`);
  rejectUnknownKeys(redaction, ['applied', 'secretValueCount'], context, `${field}.redaction`);
  if (typeof redaction.applied !== 'boolean') {
    throw validationError(context, `${field}.redaction.applied`, '必须是布尔', redaction.applied);
  }
  if (!Array.isArray(object.chunks)) {
    throw validationError(context, `${field}.chunks`, '必须是分块引用数组', typeof object.chunks);
  }
  const chunks = object.chunks.map((chunk, index) =>
    validateChunkRef(chunk, context, `${field}.chunks[${index}]`));
  const reconciliation = object.sequenceReconciliation;
  if (reconciliation !== 'match' && reconciliation !== 'mismatch' && reconciliation !== 'not_available') {
    throw validationError(context, `${field}.sequenceReconciliation`, '必须是 match | mismatch | not_available', reconciliation);
  }
  const resultStatus = object.resultStatus;
  if (resultStatus !== 'settled' && resultStatus !== 'invalid' &&
      resultStatus !== 'tail_timeout' && resultStatus !== 'aborted') {
    throw validationError(context, `${field}.resultStatus`, '必须是 settled | invalid | tail_timeout | aborted', resultStatus);
  }
  const coverage = object.coverage;
  if (coverage !== 'complete' && coverage !== 'partial' && coverage !== 'failed') {
    throw validationError(context, `${field}.coverage`, '必须是 complete | partial | failed', coverage);
  }
  const stats = requirePlainObject(object.stats, context, `${field}.stats`);
  rejectUnknownKeys(stats, [
    'eventsReceived', 'eventsPersisted', 'duplicatesDropped', 'unknownEvents',
    'foreignEvents', 'lateEvents', 'eventsOmitted', 'bytesPersisted',
  ], context, `${field}.stats`);
  const gaps = validateGaps(object.gaps, context, `${field}.gaps`);
  if (coverage === 'complete' && (gaps.length > 0 || resultStatus !== 'settled' || reconciliation === 'mismatch')) {
    throw validationError(context, `${field}.coverage`, 'complete 只对无缺口的已声明范围成立', coverage);
  }
  if (object.recordingMode !== undefined && object.recordingMode !== 'required' && object.recordingMode !== 'best_effort') {
    throw validationError(context, `${field}.recordingMode`, 'required_or_best_effort');
  }
  let stop: WorkEvidenceStopObservation | undefined;
  if (object.stop !== undefined) {
    const rawStop = requirePlainObject(object.stop, context, `${field}.stop`);
    rejectUnknownKeys(rawStop, ['status', 'evidence'], context, `${field}.stop`);
    if (!['observed', 'invalid', 'tail_timeout'].includes(String(rawStop.status))) {
      throw validationError(context, `${field}.stop.status`, 'invalid_stop_observation');
    }
    const evidence = rawStop.evidence === null ? null : validateRuntimeStopEvidence(rawStop.evidence);
    if ((rawStop.status === 'observed') !== (evidence !== null)) {
      throw validationError(context, `${field}.stop`, 'stop_evidence_status_mismatch');
    }
    stop = { status: rawStop.status as WorkEvidenceStopObservation['status'], evidence };
  }
  return {
    schemaVersion: WORK_EVIDENCE_SCHEMA_VERSION,
    kind: WORK_EVIDENCE_MANIFEST_KIND,
    ...(stop === undefined ? {} : { stop }),
    ...(object.recordingMode === undefined ? {} : { recordingMode: object.recordingMode as 'required' | 'best_effort' }),
    identity: validateIdentity(object.identity, context, `${field}.identity`),
    ...(object.recovery === undefined ? {} : { recovery: validateRuntimeRecoveryRecording(object.recovery) }),
    runtime: boundedManifestText(object.runtime, 128, context, `${field}.runtime`),
    adapterVersion: boundedManifestText(object.adapterVersion, 128, context, `${field}.adapterVersion`),
    scope: validateScope(object.scope, context, `${field}.scope`),
    redaction: {
      applied: redaction.applied,
      secretValueCount: validateNonNegativeInteger(redaction.secretValueCount, context, `${field}.redaction.secretValueCount`),
    },
    chunks,
    watermark: object.watermark === null
      ? null
      : validateNonNegativeInteger(object.watermark, context, `${field}.watermark`),
    finalEventSequence: object.finalEventSequence === null
      ? null
      : validateNonNegativeInteger(object.finalEventSequence, context, `${field}.finalEventSequence`),
    sequenceReconciliation: reconciliation,
    gaps,
    stats: {
      eventsReceived: validateNonNegativeInteger(stats.eventsReceived, context, `${field}.stats.eventsReceived`),
      eventsPersisted: validateNonNegativeInteger(stats.eventsPersisted, context, `${field}.stats.eventsPersisted`),
      duplicatesDropped: validateNonNegativeInteger(stats.duplicatesDropped, context, `${field}.stats.duplicatesDropped`),
      unknownEvents: validateNonNegativeInteger(stats.unknownEvents, context, `${field}.stats.unknownEvents`),
      foreignEvents: validateNonNegativeInteger(stats.foreignEvents, context, `${field}.stats.foreignEvents`),
      lateEvents: validateNonNegativeInteger(stats.lateEvents, context, `${field}.stats.lateEvents`),
      eventsOmitted: validateNonNegativeInteger(stats.eventsOmitted, context, `${field}.stats.eventsOmitted`),
      bytesPersisted: validateNonNegativeInteger(stats.bytesPersisted, context, `${field}.stats.bytesPersisted`),
    },
    usage: validateUsageSummary(object.usage, context, `${field}.usage`),
    result: object.result === null
      ? null
      : validateResultSummary(object.result, context, `${field}.result`),
    resultStatus,
    diagnostics: validateDiagnostics(object.diagnostics, context, `${field}.diagnostics`),
    coverage,
  };
}
