import { describe, expect, it } from 'vitest';
import {
  validateEfficiencyFact,
  validateRuntimeUsageReport,
  validateUsageDiagnosticObservation,
  usageObservationKey,
} from '../../../packages/core/src/index.ts';

const identity = {
  runtime: 'pi', provider: 'provider-a', model: 'model-a', attemptId: 'attempt-1', sessionId: 'session-1',
  invocationId: 'invocation-1', requestId: 'request-1', messageId: 'message-1', eventId: 'event-1',
  providerSessionId: 'native-session-1', providerRequestId: 'native-request-1', recovery: 'new',
} as const;
const source = { kind: 'runtime_event', ref: 'event-1', observedAtUtc: '2026-10-20T12:00:00.000Z' } as const;
const measurement = (value: number | null) => ({ value, accounting: 'incremental', coverage: 'reported', normalization: 'raw', sourceRefs: ['event-1'] } as const);

const observation = {
  schemaVersion: 1, identity, kind: 'request', coverage: 'reported', accounting: 'incremental', sourceRefs: [source],
  measurements: {
    input: measurement(100), output: measurement(20), cacheRead: measurement(null), cacheWrite: measurement(null),
    reasoning: measurement(null), providerTotal: measurement(120),
  },
  deduplication: {
    observationKey: 'observation-1', scope: 'request', action: 'count_once', duplicateOf: null,
    parentObservationKey: null, historicalBaselineKey: null, reason: 'none',
  },
} as const;

describe('P04-6 用量与效率诊断公共契约', () => {
  it('[case:usage-identity-and-boundary] 保留 Core 身份分层、模型归属和恢复来源', () => {
    const parsed = validateUsageDiagnosticObservation(observation);
    expect(parsed.identity.attemptId).toBe('attempt-1');
    expect(parsed.identity.sessionId).toBe('session-1');
    expect(parsed.identity.invocationId).toBe('invocation-1');
    expect(parsed.identity.providerSessionId).toBe('native-session-1');
    expect(usageObservationKey(parsed.identity, parsed.kind)).toContain('attempt-1:invocation-1:request-1');
    expect(parsed.deduplication.action).toBe('count_once');
  });

  it('[case:usage-null-and-dimensions] 保留六类原始维度、口径和未知值', () => {
    const parsed = validateUsageDiagnosticObservation(observation);
    expect(parsed.measurements).toMatchObject({
      input: { value: 100, accounting: 'incremental' },
      output: { value: 20 }, cacheRead: { value: null }, cacheWrite: { value: null },
      reasoning: { value: null }, providerTotal: { value: 120 },
    });
    expect(parsed.measurements.cacheRead.coverage).toBe('reported');
    expect(parsed.measurements.reasoning.normalization).toBe('raw');
  });

  it('[case:usage-dedup-boundaries] 表达累计终态、父子汇总、恢复基线和模型切换边界', () => {
    for (const reason of ['final_snapshot', 'parent_summary', 'resume_history', 'model_switch'] as const) {
      const parsed = validateUsageDiagnosticObservation({
        ...observation,
        identity: { ...identity, model: reason === 'model_switch' ? 'model-b' : 'model-a', recovery: reason === 'resume_history' ? 'resume' : 'new' },
        accounting: reason === 'final_snapshot' ? 'cumulative' : 'incremental',
        deduplication: {
          ...observation.deduplication,
          action: reason === 'resume_history' ? 'baseline_only' : 'exclude_from_additive_total',
          reason,
          duplicateOf: reason === 'final_snapshot' ? 'observation-1' : null,
          historicalBaselineKey: reason === 'resume_history' ? 'history-1' : null,
          parentObservationKey: reason === 'parent_summary' ? 'parent-1' : null,
        },
      });
      expect(parsed.deduplication.reason).toBe(reason);
    }
  });

  it('[case:efficiency-facts-and-overlap] 覆盖请求失败、退避、工具、测试、验证、Git 和收尾事实', () => {
    const kinds = ['model_request', 'failed_model_request', 'backoff_wait', 'tool_execution', 'runtime_test', 'verification', 'git', 'finalization'] as const;
    for (const kind of kinds) {
      const fact = validateEfficiencyFact({
        schemaVersion: 1, factId: `fact-${kind}`, kind, identity, outcome: kind === 'failed_model_request' ? 'failed' : 'completed',
        observedAtUtc: '2026-10-20T12:00:02.000Z', startedAtUtc: '2026-10-20T12:00:00.000Z', endedAtUtc: '2026-10-20T12:00:02.000Z',
        durationMs: 2000, coverage: 'reported', overlapGroupId: kind === 'tool_execution' ? 'parallel-1' : null,
        toolCallId: kind === 'tool_execution' ? 'tool-1' : null, testRunId: kind === 'runtime_test' ? 'test-1' : null,
        exitCode: kind === 'runtime_test' ? 0 : null, signal: null, sourceRefs: [source],
      });
      expect(fact.kind).toBe(kind);
    }
  });

  it('[case:runtime-usage-extension] 兼容旧 Runtime 用量并接受新增原始维度', () => {
    expect(validateRuntimeUsageReport({ basis: 'reported', inputTokens: 100, outputTokens: 20, costUsdMicros: null })).toEqual({
      basis: 'reported', inputTokens: 100, outputTokens: 20, costUsdMicros: null,
    });
    expect(validateRuntimeUsageReport({
      basis: 'reported', inputTokens: 100, outputTokens: 20, costUsdMicros: null, cacheReadTokens: null,
      cacheWriteTokens: 4, reasoningTokens: null, providerTotalTokens: 124, coverage: 'partial', normalization: 'not_comparable',
      sourceRefs: ['event-1'], accounting: 'incremental', completeness: 'partial',
    })).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: 4, providerTotalTokens: 124, coverage: 'partial' });
    expect(validateRuntimeUsageReport({
      basis: 'reported', inputTokens: 100, outputTokens: 20, costUsdMicros: null,
      cacheReadTokens: 20, cacheWriteTokens: 4, reasoningTokens: 3, providerTotalTokens: 124,
      cacheReadIncludedInInput: true, cacheWriteIncludedInInput: false, reasoningIncludedInOutput: true,
    })).toMatchObject({ cacheReadIncludedInInput: true, cacheWriteIncludedInInput: false, reasoningIncludedInOutput: true });
    expect(() => validateRuntimeUsageReport({
      basis: 'reported', inputTokens: 1, outputTokens: 1, costUsdMicros: null, cacheReadIncludedInInput: 'yes',
    })).toThrow();
    expect(() => validateRuntimeUsageReport({ basis: 'reported', inputTokens: null, outputTokens: null, costUsdMicros: null, accounting: 'invalid' })).toThrow();
  });

  it('[case:unknown-is-not-zero] 拒绝以负数伪造未知用量，并保留未知字段为 null', () => {
    expect(() => validateUsageDiagnosticObservation({
      ...observation, measurements: { ...observation.measurements, reasoning: { ...measurement(-1) } },
    })).toThrow();
    expect(validateUsageDiagnosticObservation(observation).measurements.reasoning.value).toBeNull();
  });
});
