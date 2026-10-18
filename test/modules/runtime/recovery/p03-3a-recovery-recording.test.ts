import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { SyntheticEventRecorder, SyntheticUsageLedger } from '../../../helpers/runtime-recovery/recording.ts';
import type { SyntheticUsage } from '../../../helpers/runtime-recovery/recording.ts';

const event = (nativeEventKey = 'event-1', payload = 'same text', providerSessionId = 'native-1') => ({
  nativeEventKey, providerSessionId, requestId: 'request-1', payload,
});
const usage = (change: Partial<SyntheticUsage> = {}): SyntheticUsage => ({
  usageId: 'usage-1', providerSessionId: 'native-1', scopeId: 'request-1', covers: ['request-1'],
  mode: 'incremental', phase: 'current', tokens: 7, ...change,
});

describe('F-003 synthetic event identity and durable-prefix watermarks', () => {
  it('deduplicates replay across restart by native identity, not text or invocation', () => withTempSandbox(root => {
    let recorder = new SyntheticEventRecorder(root);
    expect(recorder.append(event())).toBe('persisted');
    expect(recorder.watermark).toBe(1);
    expect(recorder.append(event())).toBe('duplicate');
    recorder = new SyntheticEventRecorder(root);
    expect(recorder.append(event())).toBe('duplicate');
    expect(recorder.append(event('event-2'))).toBe('persisted');
    expect(recorder.append(event('event-1', 'same text', 'native-2'))).toBe('persisted');
    expect(recorder.watermark).toBe(3);
    expect(recorder.coverage(3)).toBe('complete');
    expect(readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  }));

  it('advances no watermark before persistence, and marks an interrupted stream partial', () => withTempSandbox(root => {
    const recorder = new SyntheticEventRecorder(root);
    recorder.append(event());
    expect(() => recorder.append(event('event-2'), 'before-persist')).toThrow('synthetic_disk_failure');
    expect(recorder.watermark).toBe(1);
    expect(new SyntheticEventRecorder(root).watermark).toBe(1);
    expect(recorder.coverage(2)).toBe('partial');
    const replay = new SyntheticEventRecorder(root);
    replay.append(event());
    replay.append(event('event-2'));
    expect(replay.watermark).toBe(2);
    expect(replay.coverage(2)).toBe('complete');
    expect(replay.coverage()).toBe('partial');
  }));

  it('preserves a torn tail, acknowledges only the complete prefix, and refuses further appends', () => withTempSandbox(root => {
    new SyntheticEventRecorder(root).append(event());
    appendFileSync(join(root, 'events.jsonl'), '{"sequence":2,"payload":');
    const bytes = readFileSync(join(root, 'events.jsonl'));
    const recorder = new SyntheticEventRecorder(root);
    expect(recorder.watermark).toBe(1);
    expect(recorder.coverage(1)).toBe('partial');
    expect(() => recorder.append(event('event-2'))).toThrow('recording_tail_needs_reconciliation');
    expect(readFileSync(join(root, 'events.jsonl'))).toEqual(bytes);
  }));

  it('does not invent stable identities or overwrite conflicting native events', () => withTempSandbox(root => {
    const recorder = new SyntheticEventRecorder(root);
    recorder.append(event());
    expect(recorder.append(event('event-1', 'conflicting text'))).toBe('conflict');
    expect(recorder.watermark).toBe(1);
    expect(new SyntheticEventRecorder(root).coverage(1)).toBe('partial');
    const missing = { ...event(), nativeEventKey: undefined };
    recorder.append(missing);
    recorder.append(missing);
    expect(recorder.watermark).toBe(3);
    expect(recorder.coverage(3)).toBe('partial');
    expect(recorder.diagnostics).toContain('native_identity_conflict');
    expect(new SyntheticEventRecorder(root).coverage(3)).toBe('partial');
  }));
});

describe('F-003 synthetic usage scopes and historical baselines', () => {
  it('counts stable incremental identities once even after replay', () => {
    const records = [usage(), usage(), usage({ usageId: 'usage-2', tokens: 3 })];
    for (const ledger of [new SyntheticUsageLedger(), new SyntheticUsageLedger()]) {
      records.forEach(record => ledger.add(record));
      expect(ledger.summary()).toEqual({ tokens: 10, coverage: 'complete', reasons: [] });
      expect(ledger.add(usage({ tokens: 99 }))).toBe('conflict');
      expect(ledger.summary()).toMatchObject({ tokens: 10, coverage: 'partial', reasons: ['usage_identity_conflict'] });
    }
  });

  it('uses the latest cumulative counter minus explicit history, never sums snapshots or history', () => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage({ phase: 'historical', tokens: 100 }));
    ledger.add(usage({ mode: 'cumulative', tokens: 107, historyBaseline: 100 }));
    ledger.add(usage({ usageId: 'final', mode: 'cumulative', tokens: 110, historyBaseline: 100 }));
    ledger.add(usage({ usageId: 'final-replay', mode: 'cumulative', tokens: 110, historyBaseline: 100 }));
    expect(ledger.summary()).toEqual({ tokens: 10, coverage: 'complete', reasons: [] });
    expect(ledger.add(usage({ usageId: 'old-counter', mode: 'cumulative', tokens: 109, historyBaseline: 100 }))).toBe('excluded');
    expect(ledger.summary()).toMatchObject({ tokens: 10, coverage: 'partial', reasons: ['cumulative_counter_regressed'] });
  });

  it.each(['incremental', 'cumulative'] as const)('rejects mixing %s with the other mode on the same scope', mode => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage({ mode, historyBaseline: mode === 'cumulative' ? 0 : undefined }));
    expect(ledger.add(usage({ usageId: 'final', mode: mode === 'incremental' ? 'cumulative' : 'incremental', historyBaseline: 0 }))).toBe('excluded');
    expect(ledger.summary()).toMatchObject({ tokens: 7, coverage: 'partial', reasons: ['usage_mode_mismatch'] });
  });

  it.each(['parent-first', 'children-first'])('never adds overlapping parent aggregate and child details (%s)', order => {
    const ledger = new SyntheticUsageLedger();
    const parent = usage({ scopeId: 'agent-tree', covers: ['request-1', 'request-2'], tokens: 20 });
    const children = [usage({ usageId: 'child-1', tokens: 7 }),
      usage({ usageId: 'child-2', scopeId: 'request-2', covers: ['request-2'], tokens: 13 })];
    (order === 'parent-first' ? [parent, ...children] : [...children, parent]).forEach(row => ledger.add(row));
    expect(ledger.summary()).toMatchObject({ tokens: 20, coverage: 'partial', reasons: ['overlapping_usage_scope'] });
  });

  it('allows non-overlapping child scopes and separates native sessions', () => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage());
    ledger.add(usage({ usageId: 'child-2', scopeId: 'request-2', covers: ['request-2'], tokens: 3 }));
    ledger.add(usage({ providerSessionId: 'native-2', tokens: 2 }));
    expect(ledger.summary()).toEqual({ tokens: 12, coverage: 'complete', reasons: [] });
  });

  it.each(['usageId', 'providerSessionId', 'scopeId', 'covers', 'mode', 'phase', 'tokens'] as const)
    ('missing %s is unknown, not zero or a guessed duplicate', field => {
      const ledger = new SyntheticUsageLedger();
      const row = { ...usage(), [field]: undefined };
      expect(ledger.add(row)).toBe('excluded');
      expect(ledger.summary()).toMatchObject({ tokens: null, coverage: 'unknown' });
      ledger.add(usage());
      expect(ledger.summary()).toMatchObject({ tokens: 7, coverage: 'partial' });
    });

  it.each([undefined, null, -1, 200])('rejects unknown or contradictory cumulative baseline %s', historyBaseline => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage({ mode: 'cumulative', tokens: 110, historyBaseline }));
    expect(ledger.summary()).toMatchObject({ tokens: null, coverage: 'unknown' });
  });

  it('excludes changed baseline/scope and does not use historical successes as new usage', () => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage({ phase: 'historical' }));
    expect(ledger.summary()).toMatchObject({ tokens: null, coverage: 'unknown' });
    ledger.add(usage({ mode: 'cumulative', tokens: 10, historyBaseline: 5 }));
    expect(ledger.add(usage({ usageId: 'changed-baseline', mode: 'cumulative', tokens: 10, historyBaseline: 0 }))).toBe('excluded');
    expect(ledger.add(usage({ usageId: 'changed-scope', mode: 'cumulative', tokens: 20, historyBaseline: 5, covers: ['request-1', 'request-2'] }))).toBe('excluded');
    expect(ledger.summary()).toMatchObject({ tokens: 5, coverage: 'partial' });
  });

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])('invalid/unknown tokens %s remain unknown', tokens => {
    const ledger = new SyntheticUsageLedger();
    ledger.add(usage({ tokens }));
    expect(ledger.summary()).toMatchObject({ tokens: null, coverage: 'unknown' });
  });
});
