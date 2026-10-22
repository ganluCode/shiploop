import { expect, test } from 'vitest';
import {
  aggregateUsage, buildUsageProjection, normalizeUsageObservations,
  type RuntimeUsageReport, type UsageDiagnosticIdentity, type UsageProjectionRecord,
} from '../../../packages/core/src/index.ts';

function record(eventId: string, overrides: Partial<UsageProjectionRecord> = {}): UsageProjectionRecord {
  return {
    taskId: 'task-1', runId: 'run-1', featureId: 'feature-1',
    identity: { runtime: 'pi', provider: 'provider-a', model: 'model-a', attemptId: 'attempt-1',
      sessionId: 'session-1', invocationId: 'invocation-1', requestId: 'request-1', messageId: null,
      eventId, providerSessionId: null, providerRequestId: null, recovery: 'new' },
    usage: usage(100, 10), ...overrides,
  };
}
function usage(inputTokens: number | null, outputTokens: number | null,
  overrides: Partial<RuntimeUsageReport> = {}): RuntimeUsageReport {
  return { basis: 'reported', inputTokens, outputTokens, costUsdMicros: null,
    cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 3, providerTotalTokens: null,
    cacheReadIncludedInInput: true, cacheWriteIncludedInInput: true, reasoningIncludedInOutput: true,
    accounting: 'incremental', coverage: 'reported', ...overrides };
}
function identity(eventId: string, overrides: Partial<UsageDiagnosticIdentity>): UsageDiagnosticIdentity {
  return { ...record(eventId).identity, ...overrides };
}

test('[case:unattributed-replay-coverage] 已知小计保留，无法归属的恢复累计使各层覆盖度为 partial', () => {
  const known = record('known');
  const replay = record('replay', {
    identity: identity('replay', { attemptId: 'attempt-2', invocationId: 'invocation-2', recovery: 'replay' }),
    usage: usage(200, 20, { accounting: 'cumulative' }),
  });
  const rows = normalizeUsageObservations([known, replay]);
  expect(rows[1]).toMatchObject({ counted: false, normalizedUsage: { inputTokens: null, outputTokens: null },
    observation: { deduplication: { action: 'unknown', reason: 'resume_history' } } });
  const result = buildUsageProjection([known, replay]);
  for (const aggregate of [aggregateUsage(rows), result.feature.aggregate, result.tasks[0].aggregate,
    result.runs[0].aggregate, result.dimensions['model:model-a'].aggregate]) {
    expect(aggregate.totals).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(aggregate.coverage).toBe('partial');
    expect(aggregate.diagnostics).toContain('cumulative_without_recovery_baseline');
  }
  expect(result.attempts[1].aggregate).toMatchObject({ coverage: 'unknown', countedObservations: 0,
    totals: { inputTokens: null, outputTokens: null } });
  expect(rows[1].rawUsage).toEqual(replay.usage);
  expect(rows[1].observation.identity.recovery).toBe('replay');
});

test('[case:model-attribution-consistent] 同一请求模型归属冲突在模型维度仍未知，不因分组重新计入', () => {
  const records = [record('model-a'), record('model-b', {
    identity: identity('model-b', { model: 'model-b' }), usage: usage(40, 4),
  })];
  const result = buildUsageProjection(records);
  expect(result.feature.aggregate).toMatchObject({ coverage: 'partial', totals: { inputTokens: 100 } });
  expect(result.dimensions['model:model-a'].aggregate.totals.inputTokens).toBe(100);
  expect(result.dimensions['model:model-b'].aggregate).toMatchObject({
    countedObservations: 0, coverage: 'unknown', totals: { inputTokens: null, outputTokens: null },
  });
  expect(result.dimensions['model:model-b'].aggregate.diagnostics).toContain('model_switch_unattributed');
});

test('[case:attempts-final-baseline-switch] 多次尝试、最终累计、重复回放与换模型按同一集合汇总', () => {
  const first = record('failed-final', { kind: 'attempt', final: true,
    usage: usage(100, 10, { accounting: 'cumulative' }) });
  const resumed = record('cancelled-final', { runId: 'run-2', kind: 'attempt', final: true,
    identity: identity('cancelled-final', { attemptId: 'attempt-2', sessionId: 'session-2', invocationId: 'invocation-2', recovery: 'resume' }),
    usage: usage(150, 15, { accounting: 'cumulative', cacheReadTokens: 30, reasoningTokens: 4 }),
    historicalBaseline: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 3 },
    historicalBaselineKey: 'attempt-1-watermark-7',
    sourceRefs: [{ kind: 'recovery_recording', ref: 'recovery-from-attempt-1', observedAtUtc: null }],
  });
  const rework = record('rework-final', { runId: 'run-2', kind: 'attempt', final: true,
    identity: identity('rework-final', { attemptId: 'attempt-3', sessionId: 'session-3', invocationId: 'invocation-3', model: 'model-b' }),
    usage: usage(30, 3, { cacheReadTokens: 6, reasoningTokens: 1 }),
  });
  const records = [record('failed-detail'), first, first, resumed, rework];
  const rows = normalizeUsageObservations(records);
  expect(rows.map(row => row.counted)).toEqual([false, true, false, true, true]);
  expect(rows[0].observation.deduplication).toMatchObject({ reason: 'child_detail', action: 'exclude_from_additive_total' });
  expect(rows[2].observation.deduplication).toMatchObject({ reason: 'same_event', duplicateOf: 'failed-final:attempt' });
  expect(rows[3]).toMatchObject({ rawUsage: { inputTokens: 150 }, normalizedUsage: { inputTokens: 50, outputTokens: 5 },
    observation: { identity: { recovery: 'resume' }, deduplication: { historicalBaselineKey: 'attempt-1-watermark-7' } } });
  const result = buildUsageProjection(records);
  const totals = { inputTokens: 180, outputTokens: 18, cacheReadTokens: 36, cacheWriteTokens: 0,
    reasoningTokens: 5, providerTotalTokens: null, costUsdMicros: null };
  expect(result.feature.aggregate).toMatchObject({ totals, countedObservations: 3, coverage: 'reported',
    cache: { comparableInputTokens: 180, rate: 0.2, reason: 'computed' } });
  expect(result.tasks[0].aggregate.totals).toEqual(totals);
  expect(result.runs.map(node => node.aggregate.totals.inputTokens)).toEqual([100, 80]);
  expect(result.attempts.map(node => node.aggregate.totals.inputTokens)).toEqual([100, 50, 30]);
  expect(result.dimensions['model:model-a'].aggregate.totals.inputTokens).toBe(150);
  expect(result.dimensions['model:model-b'].aggregate.totals.inputTokens).toBe(30);
  expect(result.feature.aggregate.sourceRefs).toEqual(resumed.sourceRefs);
  expect(buildUsageProjection(records)).toEqual(result);
});

test('[case:cache-weighted-missing-zero] 缓存加权且不重复输入/推理，缺失和零分母不填零', () => {
  const first = record('weighted-a', { usage: usage(100, 20, { cacheReadTokens: 80, reasoningTokens: 5, providerTotalTokens: 120 }) });
  const second = record('weighted-b', { identity: identity('weighted-b', { requestId: 'request-2' }),
    usage: usage(900, 80, { cacheReadTokens: 90, reasoningTokens: 15, providerTotalTokens: 980 }) });
  const aggregate = buildUsageProjection([first, second]).feature.aggregate;
  expect(aggregate.totals).toEqual({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 170,
    cacheWriteTokens: 0, reasoningTokens: 20, providerTotalTokens: 1100, costUsdMicros: null });
  expect(aggregate.cache).toEqual({ readTokens: 170, writeTokens: 0, comparableInputTokens: 1000, rate: 0.17, reason: 'computed' });
  const zero = aggregateUsage(normalizeUsageObservations([record('zero', { usage: usage(0, 0, { cacheReadTokens: 0 }) })]));
  expect(zero.cache).toMatchObject({ rate: null, comparableInputTokens: 0, reason: 'zero_denominator' });
  const missing = record('missing', { usage: usage(null, null, { basis: 'synthetic', coverage: 'partial',
    cacheReadIncludedInInput: undefined, reasoningIncludedInOutput: undefined }) });
  const partial = aggregateUsage(normalizeUsageObservations([first, missing]));
  expect(partial).toMatchObject({ basis: 'mixed', coverage: 'partial', totals: {
    inputTokens: null, outputTokens: null, cacheReadTokens: null, reasoningTokens: null }, cache: { rate: null, reason: 'unknown_semantics' } });
  expect(aggregateUsage(normalizeUsageObservations([missing])).basis).toBe('synthetic');
  expect(aggregateUsage(normalizeUsageObservations([{ ...missing, usage: { ...missing.usage, coverage: 'unknown' } }])).coverage).toBe('unknown');
});

test('[case:parent-child-once] 父级汇总与叶明细择一，分组保持同一个去重决定及原始证据', () => {
  const parent = record('parent', { observationKey: 'parent-summary', kind: 'provider_total', final: true });
  const child = record('child', { identity: identity('child', { invocationId: 'child-invocation', model: 'model-b' }),
    parentObservationKey: 'parent-summary', usage: usage(100, 10) });
  const rows = normalizeUsageObservations([child, parent]);
  expect(rows[0]).toMatchObject({ counted: false, rawUsage: child.usage,
    observation: { deduplication: { parentObservationKey: 'parent-summary', reason: 'child_detail' } } });
  const result = buildUsageProjection([child, parent]);
  expect(result.feature.aggregate).toMatchObject({ countedObservations: 1, totals: { inputTokens: 100, outputTokens: 10 } });
  expect(result.dimensions['model:model-b'].aggregate).toMatchObject({ countedObservations: 0, totals: { inputTokens: null } });
});
