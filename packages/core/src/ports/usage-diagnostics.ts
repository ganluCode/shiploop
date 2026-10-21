/**
 * P04-6 / F-001 用量与效率诊断公共契约。
 *
 * 这是 Core 的供应商无关数据边界。它只描述可观测事实、来源和归一化边界，
 * 不包含 SDK 类型、凭据、原生会话文件格式或报表存储实现。
 *
 * 约定：null 表示该字段在声明范围内明确不可得；unknown 表示语义、范围或
 * 归属无法确认；partial 表示只覆盖声明范围的一部分。未知值不能用 0 替代。
 */
import { isIsoUtcDateTime } from './commands.js';
import { validateStableId } from './validation.js';

export const USAGE_DIAGNOSTICS_SCHEMA_VERSION = 1;
export const USAGE_DIAGNOSTIC_SOURCE_KINDS = [
  'runtime_event', 'runtime_result', 'recovery_recording', 'artifact', 'provider_report',
] as const;
export type UsageDiagnosticSourceKind = (typeof USAGE_DIAGNOSTIC_SOURCE_KINDS)[number];

export const USAGE_COVERAGE = ['reported', 'partial', 'unknown'] as const;
export type UsageCoverage = (typeof USAGE_COVERAGE)[number];

export const USAGE_ACCOUNTING = ['incremental', 'cumulative', 'unknown'] as const;
export type UsageAccounting = (typeof USAGE_ACCOUNTING)[number];

export const USAGE_NORMALIZATION = [
  'raw', 'deduplicated', 'delta_from_history', 'excluded_parent_summary',
  'excluded_child_detail', 'not_comparable', 'unknown',
] as const;
export type UsageNormalization = (typeof USAGE_NORMALIZATION)[number];

export const USAGE_RECOVERY_ORIGINS = ['new', 'resume', 'replay', 'unknown'] as const;
export type UsageRecoveryOrigin = (typeof USAGE_RECOVERY_ORIGINS)[number];

/** Stable Core identity. Provider/native IDs are evidence and never replace these IDs. */
export interface UsageDiagnosticIdentity {
  readonly runtime: string;
  readonly provider: string;
  /** null when the provider/model cannot be attributed to this observation. */
  readonly model: string | null;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  /** Core request identity; distinct from providerRequestId and eventId. */
  readonly requestId: string | null;
  readonly messageId: string | null;
  readonly eventId: string | null;
  /** Provider-native evidence, never an Attempt or command idempotency key. */
  readonly providerSessionId: string | null;
  readonly providerRequestId: string | null;
  readonly recovery: UsageRecoveryOrigin;
}

export interface UsageDiagnosticSource {
  readonly kind: UsageDiagnosticSourceKind;
  /** Opaque Core/artifact reference, never a native payload or credential. */
  readonly ref: string;
  readonly observedAtUtc: string | null;
}

/** One raw provider dimension plus its accounting and normalization claims. */
export interface UsageMeasurement {
  readonly value: number | null;
  readonly accounting: UsageAccounting;
  readonly coverage: UsageCoverage;
  readonly normalization: UsageNormalization;
  readonly sourceRefs: readonly string[];
}

/**
 * Raw dimensions are deliberately separate. cacheRead may already be included in
 * input, reasoning may already be included in output, and providerTotal may overlap
 * both; consumers must not add them unless the provider declares them disjoint.
 */
export interface UsageTokenMeasurements {
  readonly input: UsageMeasurement;
  readonly output: UsageMeasurement;
  readonly cacheRead: UsageMeasurement;
  readonly cacheWrite: UsageMeasurement;
  readonly reasoning: UsageMeasurement;
  readonly providerTotal: UsageMeasurement;
}

export const USAGE_OBSERVATION_KINDS = [
  'request', 'message', 'attempt', 'session', 'provider_total',
] as const;
export type UsageObservationKind = (typeof USAGE_OBSERVATION_KINDS)[number];

export const USAGE_DEDUPLICATION_ACTIONS = [
  'count_once', 'ignore_duplicate', 'exclude_from_additive_total', 'baseline_only', 'unknown',
] as const;
export type UsageDeduplicationAction = (typeof USAGE_DEDUPLICATION_ACTIONS)[number];

/**
 * Explicit accounting boundary. A final cumulative result, parent summary and
 * resume history baseline are retained as evidence but are not additive observations
 * of the same scope. A missing/ambiguous boundary remains unknown.
 */
export interface UsageDeduplicationBoundary {
  readonly observationKey: string;
  readonly scope: UsageObservationKind;
  readonly action: UsageDeduplicationAction;
  readonly duplicateOf: string | null;
  readonly parentObservationKey: string | null;
  readonly historicalBaselineKey: string | null;
  readonly reason: 'same_event' | 'same_request' | 'final_snapshot' | 'parent_summary'
    | 'child_detail' | 'resume_history' | 'model_switch' | 'scope_unknown' | 'none';
}

export interface UsageDiagnosticObservation {
  readonly schemaVersion: typeof USAGE_DIAGNOSTICS_SCHEMA_VERSION;
  readonly identity: UsageDiagnosticIdentity;
  readonly kind: UsageObservationKind;
  readonly measurements: UsageTokenMeasurements;
  readonly coverage: UsageCoverage;
  readonly accounting: UsageAccounting;
  readonly sourceRefs: readonly UsageDiagnosticSource[];
  readonly deduplication: UsageDeduplicationBoundary;
}

export const EFFICIENCY_FACT_KINDS = [
  'model_request', 'failed_model_request', 'backoff_wait', 'tool_execution',
  'runtime_test', 'verification', 'git', 'finalization',
] as const;
export type EfficiencyFactKind = (typeof EFFICIENCY_FACT_KINDS)[number];

export const EFFICIENCY_FACT_OUTCOMES = ['started', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type EfficiencyFactOutcome = (typeof EFFICIENCY_FACT_OUTCOMES)[number];

/** Observable timing fact. Missing boundaries are explicit and never inferred. */
export interface EfficiencyFact {
  readonly schemaVersion: typeof USAGE_DIAGNOSTICS_SCHEMA_VERSION;
  readonly factId: string;
  readonly kind: EfficiencyFactKind;
  readonly identity: UsageDiagnosticIdentity;
  readonly outcome: EfficiencyFactOutcome;
  readonly observedAtUtc: string;
  readonly startedAtUtc: string | null;
  readonly endedAtUtc: string | null;
  readonly durationMs: number | null;
  readonly coverage: UsageCoverage;
  /** Same overlap group means durations must not be summed as wall-clock time. */
  readonly overlapGroupId: string | null;
  readonly toolCallId: string | null;
  readonly testRunId: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly sourceRefs: readonly UsageDiagnosticSource[];
}

function fail(field: string, reason: string): never {
  throw new TypeError(`UsageDiagnostics: ${field}: ${reason}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field, 'object_required');
  return value as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`${field}.${key}`, 'unknown_key');
}
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0-\x1f\x7f]/.test(value)) fail(field, 'invalid_text');
  return value;
}
function id(value: unknown, field: string): string {
  try { return validateStableId(value, { operation: 'UsageDiagnostics.validate' }, field); }
  catch { return fail(field, 'invalid_id'); }
}
function nullableId(value: unknown, field: string): string | null { return value === null ? null : id(value, field); }
function member<T extends string>(value: unknown, list: readonly T[], field: string): T {
  if (!list.includes(value as T)) fail(field, 'invalid_enum');
  return value as T;
}
function nullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (!isIsoUtcDateTime(value)) fail(field, 'invalid_timestamp');
  return value as string;
}
function date(value: unknown, field: string): string { return nullableDate(value, field) as string; }
function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(field, 'invalid_count');
  return value;
}
function nullableCount(value: unknown, field: string): number | null { return value === null ? null : count(value, field); }
function boundedList<T>(value: unknown, field: string, parse: (v: unknown, f: string) => T, max = 128): T[] {
  if (!Array.isArray(value) || value.length > max) fail(field, 'invalid_list');
  return value.map((item, index) => parse(item, `${field}[${index}]`));
}

export function validateUsageDiagnosticIdentity(value: unknown): UsageDiagnosticIdentity {
  const raw = object(value, 'identity');
  keys(raw, ['runtime', 'provider', 'model', 'attemptId', 'sessionId', 'invocationId', 'requestId', 'messageId', 'eventId', 'providerSessionId', 'providerRequestId', 'recovery'], 'identity');
  return {
    runtime: text(raw.runtime, 'identity.runtime'), provider: text(raw.provider, 'identity.provider'),
    model: raw.model === null ? null : text(raw.model, 'identity.model'),
    attemptId: id(raw.attemptId, 'identity.attemptId'), sessionId: id(raw.sessionId, 'identity.sessionId'),
    invocationId: id(raw.invocationId, 'identity.invocationId'), requestId: nullableId(raw.requestId, 'identity.requestId'),
    messageId: nullableId(raw.messageId, 'identity.messageId'), eventId: nullableId(raw.eventId, 'identity.eventId'),
    providerSessionId: nullableId(raw.providerSessionId, 'identity.providerSessionId'),
    providerRequestId: nullableId(raw.providerRequestId, 'identity.providerRequestId'),
    recovery: member(raw.recovery, USAGE_RECOVERY_ORIGINS, 'identity.recovery'),
  };
}

export function validateUsageDiagnosticSource(value: unknown): UsageDiagnosticSource {
  const raw = object(value, 'source');
  keys(raw, ['kind', 'ref', 'observedAtUtc'], 'source');
  return { kind: member(raw.kind, USAGE_DIAGNOSTIC_SOURCE_KINDS, 'source.kind'), ref: id(raw.ref, 'source.ref'), observedAtUtc: nullableDate(raw.observedAtUtc, 'source.observedAtUtc') };
}

export function validateUsageMeasurement(value: unknown, field = 'measurement'): UsageMeasurement {
  const raw = object(value, field);
  keys(raw, ['value', 'accounting', 'coverage', 'normalization', 'sourceRefs'], field);
  return {
    value: nullableCount(raw.value, `${field}.value`), accounting: member(raw.accounting, USAGE_ACCOUNTING, `${field}.accounting`),
    coverage: member(raw.coverage, USAGE_COVERAGE, `${field}.coverage`), normalization: member(raw.normalization, USAGE_NORMALIZATION, `${field}.normalization`),
    sourceRefs: boundedList(raw.sourceRefs, `${field}.sourceRefs`, (v, f) => id(v, f)),
  };
}

export function validateUsageTokenMeasurements(value: unknown): UsageTokenMeasurements {
  const raw = object(value, 'measurements');
  keys(raw, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'providerTotal'], 'measurements');
  return {
    input: validateUsageMeasurement(raw.input, 'measurements.input'), output: validateUsageMeasurement(raw.output, 'measurements.output'),
    cacheRead: validateUsageMeasurement(raw.cacheRead, 'measurements.cacheRead'), cacheWrite: validateUsageMeasurement(raw.cacheWrite, 'measurements.cacheWrite'),
    reasoning: validateUsageMeasurement(raw.reasoning, 'measurements.reasoning'), providerTotal: validateUsageMeasurement(raw.providerTotal, 'measurements.providerTotal'),
  };
}

export function validateUsageDeduplicationBoundary(value: unknown): UsageDeduplicationBoundary {
  const raw = object(value, 'deduplication');
  keys(raw, ['observationKey', 'scope', 'action', 'duplicateOf', 'parentObservationKey', 'historicalBaselineKey', 'reason'], 'deduplication');
  return {
    observationKey: id(raw.observationKey, 'deduplication.observationKey'), scope: member(raw.scope, USAGE_OBSERVATION_KINDS, 'deduplication.scope'),
    action: member(raw.action, USAGE_DEDUPLICATION_ACTIONS, 'deduplication.action'), duplicateOf: nullableId(raw.duplicateOf, 'deduplication.duplicateOf'),
    parentObservationKey: nullableId(raw.parentObservationKey, 'deduplication.parentObservationKey'), historicalBaselineKey: nullableId(raw.historicalBaselineKey, 'deduplication.historicalBaselineKey'),
    reason: member(raw.reason, ['same_event', 'same_request', 'final_snapshot', 'parent_summary', 'child_detail', 'resume_history', 'model_switch', 'scope_unknown', 'none'] as const, 'deduplication.reason'),
  };
}

export function validateUsageDiagnosticObservation(value: unknown): UsageDiagnosticObservation {
  const raw = object(value, 'usageObservation');
  keys(raw, ['schemaVersion', 'identity', 'kind', 'measurements', 'coverage', 'accounting', 'sourceRefs', 'deduplication'], 'usageObservation');
  if (raw.schemaVersion !== USAGE_DIAGNOSTICS_SCHEMA_VERSION) fail('usageObservation.schemaVersion', 'unsupported_schema_version');
  return {
    schemaVersion: USAGE_DIAGNOSTICS_SCHEMA_VERSION, identity: validateUsageDiagnosticIdentity(raw.identity), kind: member(raw.kind, USAGE_OBSERVATION_KINDS, 'usageObservation.kind'),
    measurements: validateUsageTokenMeasurements(raw.measurements), coverage: member(raw.coverage, USAGE_COVERAGE, 'usageObservation.coverage'),
    accounting: member(raw.accounting, USAGE_ACCOUNTING, 'usageObservation.accounting'), sourceRefs: boundedList(raw.sourceRefs, 'usageObservation.sourceRefs', validateUsageDiagnosticSource),
    deduplication: validateUsageDeduplicationBoundary(raw.deduplication),
  };
}

export function validateEfficiencyFact(value: unknown): EfficiencyFact {
  const raw = object(value, 'efficiencyFact');
  keys(raw, ['schemaVersion', 'factId', 'kind', 'identity', 'outcome', 'observedAtUtc', 'startedAtUtc', 'endedAtUtc', 'durationMs', 'coverage', 'overlapGroupId', 'toolCallId', 'testRunId', 'exitCode', 'signal', 'sourceRefs'], 'efficiencyFact');
  if (raw.schemaVersion !== USAGE_DIAGNOSTICS_SCHEMA_VERSION) fail('efficiencyFact.schemaVersion', 'unsupported_schema_version');
  const startedAtUtc = nullableDate(raw.startedAtUtc, 'efficiencyFact.startedAtUtc');
  const endedAtUtc = nullableDate(raw.endedAtUtc, 'efficiencyFact.endedAtUtc');
  if (startedAtUtc !== null && endedAtUtc !== null && endedAtUtc < startedAtUtc) fail('efficiencyFact', 'end_before_start');
  return {
    schemaVersion: USAGE_DIAGNOSTICS_SCHEMA_VERSION, factId: id(raw.factId, 'efficiencyFact.factId'), kind: member(raw.kind, EFFICIENCY_FACT_KINDS, 'efficiencyFact.kind'),
    identity: validateUsageDiagnosticIdentity(raw.identity), outcome: member(raw.outcome, EFFICIENCY_FACT_OUTCOMES, 'efficiencyFact.outcome'), observedAtUtc: date(raw.observedAtUtc, 'efficiencyFact.observedAtUtc'),
    startedAtUtc, endedAtUtc, durationMs: nullableCount(raw.durationMs, 'efficiencyFact.durationMs'), coverage: member(raw.coverage, USAGE_COVERAGE, 'efficiencyFact.coverage'),
    overlapGroupId: nullableId(raw.overlapGroupId, 'efficiencyFact.overlapGroupId'), toolCallId: nullableId(raw.toolCallId, 'efficiencyFact.toolCallId'), testRunId: nullableId(raw.testRunId, 'efficiencyFact.testRunId'),
    exitCode: nullableCount(raw.exitCode, 'efficiencyFact.exitCode'), signal: raw.signal === null ? null : text(raw.signal, 'efficiencyFact.signal'),
    sourceRefs: boundedList(raw.sourceRefs, 'efficiencyFact.sourceRefs', validateUsageDiagnosticSource),
  };
}

/** A stable key for de-duplicating an observation without using provider session IDs. */
export function usageObservationKey(identity: UsageDiagnosticIdentity, kind: UsageObservationKind): string {
  return [identity.attemptId, identity.invocationId, identity.requestId ?? 'request-unknown', identity.messageId ?? 'message-unknown', kind].join(':');
}
