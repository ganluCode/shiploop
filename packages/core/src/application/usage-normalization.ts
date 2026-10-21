import type { RuntimeUsageReport } from '../ports/runtime-execution.js';
import {
  USAGE_DIAGNOSTICS_SCHEMA_VERSION,
  usageObservationKey,
  type UsageAccounting,
  type UsageCoverage,
  type UsageDiagnosticIdentity,
  type UsageDiagnosticObservation,
  type UsageDiagnosticSource,
  type UsageDeduplicationAction,
  type UsageNormalization,
  type UsageObservationKind,
  type UsageTokenMeasurements,
} from '../ports/usage-diagnostics.js';

/**
 * F-002 的 usage 输入。Runtime 的最终结果、usage 事件和 Recorder 的摘要都
 * 可以转换成这一形状；父层汇总应使用同一批原始观察，而不是把父层结果再次
 * 作为 observation 传入。
 */
export interface UsageObservationInput {
  readonly identity: UsageDiagnosticIdentity;
  readonly usage: RuntimeUsageReport;
  readonly kind?: UsageObservationKind;
  readonly observationKey?: string;
  readonly sourceRefs?: readonly UsageDiagnosticSource[];
  readonly parentObservationKey?: string | null;
  readonly historicalBaseline?: UsageTokenVector | null;
  readonly historicalBaselineKey?: string | null;
  /** Runtime result/Recorder finalReported；用于取代同一范围内的逐请求明细。 */
  readonly final?: boolean;
}

export interface UsageTokenVector {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly providerTotalTokens?: number | null;
  readonly costUsdMicros?: number | null;
}

export interface NormalizedUsageObservation {
  readonly observation: UsageDiagnosticObservation;
  /** 原始供应商/Runtime 字段，供审计与回放使用。 */
  readonly rawUsage: RuntimeUsageReport;
  /** 经过累计差分/恢复基线处理后实际参与汇总的值。 */
  readonly normalizedUsage: RuntimeUsageReport;
  readonly counted: boolean;
  readonly diagnostics: readonly string[];
}

export interface UsageTotals extends UsageTokenVector {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly costUsdMicros: number | null;
}

export interface UsageCacheRate {
  readonly readTokens: number | null;
  readonly writeTokens: number | null;
  readonly comparableInputTokens: number | null;
  readonly rate: number | null;
  readonly reason: 'computed' | 'zero_denominator' | 'unknown_semantics' | 'unknown_input';
}

export interface UsageAggregate {
  readonly basis: 'synthetic' | 'reported' | 'mixed' | 'none';
  readonly totals: UsageTotals;
  readonly cache: UsageCacheRate;
  readonly countedObservations: number;
  readonly observationKeys: readonly string[];
  readonly identities: readonly UsageDiagnosticIdentity[];
  readonly coverage: UsageCoverage;
  readonly accounting: UsageAccounting;
  readonly normalization: UsageNormalization;
  readonly sourceRefs: readonly UsageDiagnosticSource[];
  readonly diagnostics: readonly string[];
  readonly observations: readonly UsageDiagnosticObservation[];
}

export interface UsageProjectionRecord extends UsageObservationInput {
  readonly taskId: string;
  readonly runId: string;
  readonly featureId: string;
}

export interface UsageProjectionNode {
  readonly scope: 'attempt' | 'task' | 'run' | 'feature';
  readonly id: string;
  readonly aggregate: UsageAggregate;
}

export interface UsageProjection {
  readonly attempts: readonly UsageProjectionNode[];
  readonly tasks: readonly UsageProjectionNode[];
  readonly runs: readonly UsageProjectionNode[];
  readonly feature: UsageProjectionNode;
  readonly dimensions: Readonly<Record<string, UsageProjectionNode>>;
}

type Dimension = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'providerTotalTokens' | 'costUsdMicros';
const DIMENSIONS: readonly Dimension[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'providerTotalTokens', 'costUsdMicros'];

function vectorFromUsage(usage: RuntimeUsageReport): UsageTokenVector {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    reasoningTokens: usage.reasoningTokens ?? null,
    providerTotalTokens: usage.providerTotalTokens ?? null,
    costUsdMicros: usage.costUsdMicros,
  };
}

function difference(value: number | null | undefined, baseline: number | null | undefined): number | null {
  if (value == null || baseline == null) return null;
  const delta = value - baseline;
  return delta < 0 ? null : delta;
}

function deltaUsage(usage: RuntimeUsageReport, baseline: UsageTokenVector): RuntimeUsageReport {
  return {
    ...usage,
    inputTokens: difference(usage.inputTokens, baseline.inputTokens),
    outputTokens: difference(usage.outputTokens, baseline.outputTokens),
    cacheReadTokens: usage.cacheReadTokens === undefined ? undefined : difference(usage.cacheReadTokens, baseline.cacheReadTokens),
    cacheWriteTokens: usage.cacheWriteTokens === undefined ? undefined : difference(usage.cacheWriteTokens, baseline.cacheWriteTokens),
    reasoningTokens: usage.reasoningTokens === undefined ? undefined : difference(usage.reasoningTokens, baseline.reasoningTokens),
    providerTotalTokens: usage.providerTotalTokens === undefined ? undefined : difference(usage.providerTotalTokens, baseline.providerTotalTokens),
    costUsdMicros: difference(usage.costUsdMicros, baseline.costUsdMicros),
    accounting: 'incremental',
    normalization: 'delta_from_history',
  };
}

function modelKey(identity: UsageDiagnosticIdentity): string {
  return [identity.attemptId, identity.invocationId, identity.requestId ?? '', identity.messageId ?? ''].join('|');
}

function exactKey(input: UsageObservationInput, kind: UsageObservationKind): string {
  if (input.observationKey !== undefined) return input.observationKey;
  // eventId is the strongest recorder identity. Runtime request identity is the
  // fallback for replayed messages that have no event id.
  if (input.identity.eventId !== null) return `${input.identity.eventId}:${kind}`;
  if (input.identity.providerRequestId !== null) return `${input.identity.providerRequestId}:${kind}`;
  return usageObservationKey(input.identity, kind);
}

function sourceRefs(input: UsageObservationInput): readonly UsageDiagnosticSource[] {
  if (input.sourceRefs !== undefined) return input.sourceRefs;
  return (input.usage.sourceRefs ?? []).map(ref => ({ kind: 'provider_report' as const, ref, observedAtUtc: null }));
}

function measurement(value: number | null | undefined, usage: RuntimeUsageReport, source: readonly UsageDiagnosticSource[], normalization: UsageNormalization): { value: number | null; accounting: UsageAccounting; coverage: UsageCoverage; normalization: UsageNormalization; sourceRefs: readonly string[] } {
  return {
    value: value ?? null,
    accounting: usage.accounting ?? 'unknown',
    coverage: usage.coverage ?? (usage.completeness === 'complete' ? 'reported' : usage.completeness === 'partial' ? 'partial' : 'unknown'),
    normalization,
    sourceRefs: source.map(item => item.ref),
  };
}

function asMeasurements(usage: RuntimeUsageReport, sources: readonly UsageDiagnosticSource[], normalization: UsageNormalization): UsageTokenMeasurements {
  const cacheReadNormalization = usage.cacheReadIncludedInInput === undefined ? 'unknown' as const : normalization;
  const cacheWriteNormalization = usage.cacheWriteIncludedInInput === undefined ? 'unknown' as const : normalization;
  const reasoningNormalization = usage.reasoningIncludedInOutput === undefined ? 'unknown' as const : normalization;
  return {
    input: measurement(usage.inputTokens, usage, sources, normalization),
    output: measurement(usage.outputTokens, usage, sources, normalization),
    cacheRead: measurement(usage.cacheReadIncludedInInput === undefined ? null : usage.cacheReadTokens, usage, sources, cacheReadNormalization),
    cacheWrite: measurement(usage.cacheWriteIncludedInInput === undefined ? null : usage.cacheWriteTokens, usage, sources, cacheWriteNormalization),
    reasoning: measurement(usage.reasoningIncludedInOutput === undefined ? null : usage.reasoningTokens, usage, sources, reasoningNormalization),
    providerTotal: measurement(usage.providerTotalTokens, usage, sources, normalization),
  };
}

function addReason(reason: string, diagnostics: string[]): void {
  if (!diagnostics.includes(reason)) diagnostics.push(reason);
}

/**
 * Normalize raw Runtime/Recorder reports. The function is deterministic: input
 * order is retained for cumulative deltas and all returned lists are stable.
 */
export function normalizeUsageObservations(inputs: readonly UsageObservationInput[]): readonly NormalizedUsageObservation[] {
  const kindOf = (input: UsageObservationInput): UsageObservationKind => input.kind ?? (input.final ? 'attempt' : 'request');
  const candidates = inputs.map(input => ({ input, kind: kindOf(input), key: exactKey(input, kindOf(input)) }));
  const seen = new Map<string, NormalizedUsageObservation>();
  const result: NormalizedUsageObservation[] = [];
  const finalByScope = new Set<string>();
  for (const candidate of candidates) if (candidate.input.final || candidate.kind === 'attempt' || candidate.kind === 'session') {
    finalByScope.add(`${candidate.input.identity.attemptId}|${candidate.input.identity.invocationId}`);
  }

  const cumulativeLast = new Map<string, UsageTokenVector>();
  const modelByRequest = new Map<string, string | null>();
  for (const candidate of candidates) {
    const { input, kind, key } = candidate;
    const diagnostics: string[] = [];
    const previous = seen.get(key);
    if (previous !== undefined) {
      const boundary = { ...previous.observation.deduplication, action: 'ignore_duplicate' as const, duplicateOf: previous.observation.deduplication.observationKey, reason: 'same_event' as const };
      const ignored: NormalizedUsageObservation = { ...previous, counted: false, diagnostics: [...previous.diagnostics, 'duplicate_usage_event'], observation: { ...previous.observation, deduplication: boundary } };
      result.push(ignored);
      continue;
    }

    const requestScope = modelKey(input.identity);
    const invocationScope = `${input.identity.attemptId}|${input.identity.invocationId}`;
    const oldModel = modelByRequest.get(requestScope);
    if (oldModel !== undefined && oldModel !== input.identity.model) {
      addReason('model_switch_unattributed', diagnostics);
    } else modelByRequest.set(requestScope, input.identity.model);

    let usage = input.usage;
    let counted = true;
    let action: UsageDeduplicationAction = 'count_once';
    let reason: UsageDiagnosticObservation['deduplication']['reason'] = 'none';
    let normalization: UsageNormalization = usage.normalization ?? 'raw';
    let historicalBaselineKey = input.historicalBaselineKey ?? null;

    if (oldModel !== undefined && oldModel !== input.identity.model) {
      counted = false; action = 'unknown'; reason = 'model_switch'; normalization = 'not_comparable';
    } else if ((kind === 'request' || kind === 'message') && finalByScope.has(invocationScope)) {
      counted = false; action = 'exclude_from_additive_total'; reason = 'child_detail'; normalization = 'excluded_child_detail';
      addReason('final_snapshot_supersedes_request_detail', diagnostics);
    }

    if (usage.accounting === 'cumulative' && counted) {
      const series = `${requestScope}|${kind}|${input.identity.model ?? ''}`;
      if (input.historicalBaseline !== undefined && input.historicalBaseline !== null) {
        usage = deltaUsage(usage, input.historicalBaseline);
        historicalBaselineKey = historicalBaselineKey ?? 'explicit-baseline';
      } else if (cumulativeLast.has(series)) {
        usage = deltaUsage(usage, cumulativeLast.get(series)!);
      } else if (input.identity.recovery === 'resume' || input.identity.recovery === 'replay') {
        usage = { ...usage, inputTokens: null, outputTokens: null, cacheReadTokens: usage.cacheReadTokens === undefined ? undefined : null,
          cacheWriteTokens: usage.cacheWriteTokens === undefined ? undefined : null, reasoningTokens: usage.reasoningTokens === undefined ? undefined : null,
          providerTotalTokens: usage.providerTotalTokens === undefined ? undefined : null, costUsdMicros: null, normalization: 'not_comparable' };
        counted = false; action = 'unknown'; reason = 'resume_history'; normalization = 'not_comparable';
        addReason('cumulative_without_recovery_baseline', diagnostics);
      }
      cumulativeLast.set(series, vectorFromUsage(input.usage));
    }

    if (input.parentObservationKey !== undefined && input.parentObservationKey !== null && kind === 'request') {
      // A request that explicitly identifies a parent summary is a child detail.
      counted = false; action = 'exclude_from_additive_total'; reason = 'child_detail'; normalization = 'excluded_child_detail';
      addReason('parent_summary_present', diagnostics);
    }

    const sources = sourceRefs(input);
    const coverage = usage.coverage ?? (usage.completeness === 'complete' ? 'reported' : usage.completeness === 'partial' ? 'partial' : 'unknown');
    const observation: UsageDiagnosticObservation = {
      schemaVersion: USAGE_DIAGNOSTICS_SCHEMA_VERSION,
      identity: input.identity,
      kind,
      measurements: asMeasurements(usage, sources, normalization),
      coverage,
      accounting: usage.accounting ?? 'unknown',
      sourceRefs: sources,
      deduplication: { observationKey: key, scope: kind, action, duplicateOf: null,
        parentObservationKey: input.parentObservationKey ?? null, historicalBaselineKey,
        reason },
    };
    const normalized = { observation, rawUsage: input.usage, normalizedUsage: usage, counted, diagnostics };
    seen.set(key, normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeRuntimeUsage(input: UsageObservationInput): NormalizedUsageObservation {
  return normalizeUsageObservations([input])[0];
}

function fieldValue(item: NormalizedUsageObservation, dimension: Dimension): number | null {
  if (dimension === 'costUsdMicros') return item.normalizedUsage.costUsdMicros;
  const key = dimension === 'inputTokens' ? 'input' : dimension === 'outputTokens' ? 'output' : dimension === 'cacheReadTokens' ? 'cacheRead' : dimension === 'cacheWriteTokens' ? 'cacheWrite' : dimension === 'reasoningTokens' ? 'reasoning' : 'providerTotal';
  return item.observation.measurements[key].value;
}

function aggregateDimension(observations: readonly NormalizedUsageObservation[], dimension: Dimension): number | null {
  if (observations.length === 0) return null;
  let total = 0;
  for (const observation of observations) {
    const value = fieldValue(observation, dimension);
    if (value === null) return null;
    total += value;
  }
  return total;
}

function basisOf(observations: readonly NormalizedUsageObservation[]): UsageAggregate['basis'] {
  const bases = new Set(observations.map(item => item.rawUsage.basis));
  if (bases.size === 0) return 'none';
  return bases.size === 1 ? [...bases][0] : 'mixed';
}

/** Weighted cache rate. Unknown/zero comparable input never becomes 0%. */
export function calculateCacheRate(inputTokens: number | null, cacheReadTokens: number | null, cacheWriteTokens: number | null, semanticsKnown = true): UsageCacheRate {
  if (!semanticsKnown) return { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens, comparableInputTokens: null, rate: null, reason: 'unknown_semantics' };
  if (inputTokens === null || cacheReadTokens === null) return { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens, comparableInputTokens: inputTokens, rate: null, reason: 'unknown_input' };
  if (inputTokens === 0) return { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens, comparableInputTokens: 0, rate: null, reason: 'zero_denominator' };
  return { readTokens: cacheReadTokens, writeTokens: cacheWriteTokens, comparableInputTokens: inputTokens, rate: cacheReadTokens / inputTokens, reason: 'computed' };
}

function isNormalized(value: NormalizedUsageObservation | UsageDiagnosticObservation): value is NormalizedUsageObservation {
  return 'rawUsage' in value;
}

export function aggregateUsage(observations: readonly NormalizedUsageObservation[] | readonly UsageDiagnosticObservation[]): UsageAggregate {
  const normalized: readonly NormalizedUsageObservation[] = observations.length === 0 ? [] : isNormalized(observations[0])
    ? observations as readonly NormalizedUsageObservation[]
    : (observations as readonly UsageDiagnosticObservation[]).map(observation => {
      const effective = {
        basis: 'reported' as const, inputTokens: observation.measurements.input.value, outputTokens: observation.measurements.output.value, costUsdMicros: null,
        cacheReadTokens: observation.measurements.cacheRead.value, cacheWriteTokens: observation.measurements.cacheWrite.value,
        reasoningTokens: observation.measurements.reasoning.value, providerTotalTokens: observation.measurements.providerTotal.value,
      };
      return { observation, rawUsage: effective, normalizedUsage: effective, counted: observation.deduplication.action === 'count_once', diagnostics: [] };
    });
  const counted = normalized.filter(item => item.counted);
  const rows = counted;
  const rowObservations = rows.map(item => item.observation);
  const diagnostics = [...new Set(normalized.flatMap(item => item.diagnostics).concat(rowObservations.flatMap(o => o.coverage === 'unknown' ? ['usage_coverage_unknown'] : o.coverage === 'partial' ? ['usage_coverage_partial'] : [])))].sort();
  const totals = Object.fromEntries(DIMENSIONS.map(dimension => [dimension, aggregateDimension(rows, dimension)])) as unknown as UsageTotals;
  const cacheSemanticsKnown = rowObservations.every(o => o.measurements.cacheRead.normalization !== 'unknown' && o.measurements.cacheRead.normalization !== 'not_comparable');
  const cache = calculateCacheRate(totals.inputTokens, totals.cacheReadTokens, totals.cacheWriteTokens, cacheSemanticsKnown);
  if (cache.reason !== 'computed') diagnostics.push(`cache_rate_${cache.reason}`);
  const unresolved = normalized.some(item => item.observation.deduplication.action === 'unknown');
  const coverage: UsageCoverage = rows.length === 0 ? 'unknown' : rows.some(o => o.observation.coverage === 'unknown') ? 'unknown' : unresolved || rows.some(o => o.observation.coverage === 'partial') ? 'partial' : 'reported';
  const accounting: UsageAccounting = rows.length === 0 ? 'unknown' : rows.some(o => o.observation.accounting === 'unknown') ? 'unknown' : rows.some(o => o.observation.accounting === 'cumulative') ? 'cumulative' : 'incremental';
  const normalization: UsageNormalization = rows.length === 0 ? 'unknown' : rows.some(o => o.observation.deduplication.action !== 'count_once') ? 'deduplicated' : rows.some(o => o.observation.deduplication.reason === 'resume_history') ? 'not_comparable' : 'deduplicated';
  return {
    basis: basisOf(rows), totals, cache, countedObservations: rows.length,
    observationKeys: rowObservations.map(o => o.deduplication.observationKey), identities: rowObservations.map(o => o.identity), coverage, accounting, normalization,
    sourceRefs: [...new Map(rowObservations.flatMap(o => o.sourceRefs).map(ref => [ref.ref, ref])).values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    diagnostics: [...new Set(diagnostics)].sort(), observations: rowObservations,
  };
}

export function aggregateUsageObservations(observations: readonly NormalizedUsageObservation[]): UsageAggregate {
  return aggregateUsage(observations);
}

/** Build non-overlapping projections from one normalized observation set. */
export function buildUsageProjection(records: readonly UsageProjectionRecord[]): UsageProjection {
  // Resolve replay, parent/final boundaries and model attribution before filtering
  // dimensions; a filtered subset cannot independently reconstruct those facts.
  const normalized = normalizeUsageObservations(records);
  const groupAggregate = (filter: (record: UsageProjectionRecord) => boolean) =>
    aggregateUsage(normalized.filter((_, index) => filter(records[index])));
  const attempts = [...new Set(records.map(r => r.identity.attemptId))].sort().map(id => ({ scope: 'attempt' as const, id, aggregate: groupAggregate(r => r.identity.attemptId === id) }));
  const tasks = [...new Set(records.map(r => r.taskId))].sort().map(id => ({ scope: 'task' as const, id, aggregate: groupAggregate(r => r.taskId === id) }));
  const runs = [...new Set(records.map(r => r.runId))].sort().map(id => ({ scope: 'run' as const, id, aggregate: groupAggregate(r => r.runId === id) }));
  const featureIds = [...new Set(records.map(r => r.featureId))].sort();
  const featureId = featureIds[0] ?? 'unknown-feature';
  const feature = { scope: 'feature' as const, id: featureId, aggregate: groupAggregate(r => featureIds.length === 0 || r.featureId === featureId) };
  const dimensionRecords = new Map<string, UsageProjectionNode>();
  const dimensions = [...new Set(records.flatMap(r => [`runtime:${r.identity.runtime}`, `provider:${r.identity.provider}`, `model:${r.identity.model ?? 'unknown'}`, `runtime:${r.identity.runtime}|provider:${r.identity.provider}`, `runtime:${r.identity.runtime}|provider:${r.identity.provider}|model:${r.identity.model ?? 'unknown'}`]))].sort();
  for (const key of dimensions) dimensionRecords.set(key, { scope: 'feature', id: key, aggregate: groupAggregate(r => {
    const parts = key.split('|');
    const runtimePart = parts.find(part => part.startsWith('runtime:'));
    const providerPart = parts.find(part => part.startsWith('provider:'));
    const modelPart = parts.find(part => part.startsWith('model:'));
    return (runtimePart === undefined || runtimePart === `runtime:${r.identity.runtime}`) &&
      (providerPart === undefined || providerPart === `provider:${r.identity.provider}`) &&
      (modelPart === undefined || modelPart === `model:${r.identity.model ?? 'unknown'}`);
  }) });
  return { attempts, tasks, runs, feature, dimensions: Object.fromEntries(dimensionRecords) };
}

export const projectUsage = buildUsageProjection;
