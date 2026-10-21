import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  buildUsageProjection,
  normalizeUsageObservations,
  type UsageObservationInput,
} from 'shiploop-core';

const identity = (eventId: string, requestId = 'request-1', model = 'model-a', recovery: UsageObservationInput['identity']['recovery'] = 'new') => ({
  runtime: 'pi', provider: 'provider-a', model, attemptId: 'attempt-1', sessionId: 'session-1',
  invocationId: 'invocation-1', requestId, messageId: null, eventId, providerSessionId: null,
  providerRequestId: null, recovery,
} as const);
const usage = (inputTokens: number | null, outputTokens: number | null, extra: Record<string, unknown> = {}) => ({
  basis: 'reported' as const, inputTokens, outputTokens, costUsdMicros: 10,
  accounting: 'incremental' as const, coverage: 'reported' as const,
  cacheReadTokens: 20, cacheWriteTokens: 1, reasoningTokens: 3, providerTotalTokens: null,
  cacheReadIncludedInInput: true, cacheWriteIncludedInInput: false, reasoningIncludedInOutput: true,
  ...extra,
});
const input = (eventId: string, u: UsageObservationInput['usage'], options: Partial<UsageObservationInput> = {}): UsageObservationInput => ({
  identity: identity(eventId, options.identity?.requestId ?? 'request-1', options.identity?.model ?? 'model-a', options.identity?.recovery ?? 'new'), usage: u, ...options,
});

describe('P04-6 usage normalization and projection', () => {
  it('[case:duplicate-and-final] 去重相同事件，并且最终累计快照不再叠加逐请求明细', () => {
    const rows = normalizeUsageObservations([
      input('event-1', usage(100, 10)),
      input('event-1', usage(100, 10)),
      input('event-final', usage(100, 10, { accounting: 'cumulative' }), { kind: 'attempt', final: true }),
    ]);
    const aggregate = aggregateUsage(rows);
    expect(aggregate.totals.inputTokens).toBe(100);
    expect(aggregate.totals.outputTokens).toBe(10);
    expect(aggregate.countedObservations).toBe(1);
    expect(rows[1].diagnostics).toContain('duplicate_usage_event');
    expect(rows[0].observation.deduplication.action).toBe('exclude_from_additive_total');
  });

  it('[case:cumulative-and-recovery] 累计值只取增量，恢复累计没有明确基线时保持未知', () => {
    const rows = normalizeUsageObservations([
      input('event-1', usage(100, 10, { accounting: 'cumulative' })),
      input('event-2', usage(145, 19, { accounting: 'cumulative' })),
      input('event-replay', usage(200, 40, { accounting: 'cumulative' }), { identity: identity('event-replay', 'request-replay', 'model-a', 'resume') }),
    ]);
    const aggregate = aggregateUsage(rows);
    expect(rows[1].normalizedUsage.inputTokens).toBe(45);
    expect(rows[1].normalizedUsage.outputTokens).toBe(9);
    expect(rows[2].normalizedUsage.inputTokens).toBeNull();
    expect(rows[2].observation.deduplication.reason).toBe('resume_history');
    expect(aggregate.totals.inputTokens).toBe(145);
  });

  it('[case:cache-and-reasoning] 未声明包含关系时不把缓存/推理混入可加总维度，已声明时可计算加权缓存率', () => {
    const known = normalizeUsageObservations([input('event-1', usage(100, 10))]);
    const unknown = normalizeUsageObservations([input('event-2', usage(100, 10, {
      cacheReadIncludedInInput: undefined, cacheWriteIncludedInInput: undefined, reasoningIncludedInOutput: undefined,
    }))]);
    expect(aggregateUsage(known).cache.rate).toBe(0.2);
    expect(aggregateUsage(known).totals.reasoningTokens).toBe(3);
    expect(aggregateUsage(unknown).totals.cacheReadTokens).toBeNull();
    expect(aggregateUsage(unknown).cache.rate).toBeNull();
    expect(aggregateUsage(unknown).cache.reason).toBe('unknown_semantics');
  });

  it('[case:projection-dimensions] Attempt/Task/Run/Feature 和 runtime/provider/model 维度均从同一去重集合计算', () => {
    const records = [
      { ...input('event-1', usage(100, 10)), taskId: 'task-1', runId: 'run-1', featureId: 'feature-1' },
      { ...input('event-2', usage(50, 5), { identity: identity('event-2', 'request-2', 'model-b') }), taskId: 'task-1', runId: 'run-1', featureId: 'feature-1' },
    ];
    const projection = buildUsageProjection(records);
    expect(projection.feature.aggregate.totals.inputTokens).toBe(150);
    expect(projection.tasks[0].aggregate.totals.outputTokens).toBe(15);
    expect(projection.runs[0].aggregate.totals.inputTokens).toBe(150);
    expect(projection.dimensions['provider:provider-a'].aggregate.totals.inputTokens).toBe(150);
    expect(projection.dimensions['model:model-b'].aggregate.totals.inputTokens).toBe(50);
  });

  it('[case:model-switch-and-missing] 同一请求模型切换不均分，缺字段保留 partial/unknown', () => {
    const rows = normalizeUsageObservations([
      input('event-1', usage(100, 10)),
      input('event-2', usage(40, 4), { identity: identity('event-2', 'request-1', 'model-b') }),
      input('event-3', usage(null, null, { cacheReadIncludedInInput: undefined, cacheWriteIncludedInInput: undefined, reasoningIncludedInOutput: undefined })),
    ]);
    const aggregate = aggregateUsage(rows);
    expect(rows[1].counted).toBe(false);
    expect(rows[1].observation.deduplication.reason).toBe('model_switch');
    expect(aggregate.diagnostics).toContain('model_switch_unattributed');
    expect(aggregate.totals.inputTokens).toBeNull();
  });
});
