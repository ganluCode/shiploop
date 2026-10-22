import { describe, expect, it } from 'vitest';
import { validateRuntimeEvent, validateRuntimeUsageReport } from '../../../packages/core/src/ports/runtime-execution.ts';

describe('Runtime usage report and event use the same validated contract', () => {
  const base = { basis: 'reported', inputTokens: 5, outputTokens: 2, costUsdMicros: null };
  const event = (payload: unknown) => ({ schemaVersion: 1, eventId: 'evt.invocation.1', kind: 'usage',
    sequence: 1, occurredAtUtc: '2026-10-23T00:00:00.000Z', payload });

  it('accepts a validated basic report including its optional undefined fields', () => {
    const report = validateRuntimeUsageReport(base);
    expect(validateRuntimeEvent(event(report))).toMatchObject({ payload: { kind: 'usage', usage: base } });
  });

  it('preserves cache, reasoning, coverage and normalization instead of dropping observations', () => {
    const report = validateRuntimeUsageReport({ ...base, cacheReadTokens: 4, cacheWriteTokens: null,
      reasoningTokens: 1, providerTotalTokens: 11, cacheReadIncludedInInput: true, coverage: 'partial',
      normalization: 'raw', sourceRefs: ['source.1'], accounting: 'unknown', completeness: 'partial' });
    expect(validateRuntimeEvent(event(report))).toMatchObject({ payload: { usage: report } });
  });

  it('still rejects unrecognized fields at the event boundary', () => {
    expect(() => validateRuntimeEvent(event({ ...base, unknownField: true }))).toThrow();
  });
});
