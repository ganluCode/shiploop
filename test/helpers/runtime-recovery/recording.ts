// This is a recording contract fixture, not the production SessionRecorder.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from '../../../packages/core/src/ports/feature-plan.ts';

export interface SyntheticEvent {
  nativeEventKey?: string;
  providerSessionId?: string;
  requestId?: string;
  toolCallId?: string;
  payload: string;
}
interface PersistedEvent { sequence: number; event: SyntheticEvent }
const key = (...parts: string[]) => JSON.stringify(parts);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export class SyntheticEventRecorder {
  private readonly path: string;
  private readonly gapPath: string;
  private readonly identities = new Map<string, SyntheticEvent>();
  private torn = false;
  private partial = false;
  watermark = 0;
  readonly diagnostics: string[] = [];
  constructor(root: string) {
    this.path = join(root, 'events.jsonl');
    this.gapPath = join(root, 'recording-gaps.json');
    if (existsSync(this.gapPath)) { this.partial = true; this.diagnostics.push('persisted_recording_gap'); }
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n');
    const tail = lines.pop();
    if (tail) { this.torn = true; this.partial = true; this.diagnostics.push('torn_recording_tail'); }
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as PersistedEvent;
        if (row.sequence !== this.watermark + 1 || typeof row.event?.payload !== 'string') throw new Error('invalid_event_prefix');
        this.remember(row.event);
        this.watermark = row.sequence;
      } catch {
        this.torn = true; this.partial = true; this.diagnostics.push('corrupt_recording_prefix'); break;
      }
    }
  }
  private identity(event: SyntheticEvent) {
    return text(event.nativeEventKey) && text(event.providerSessionId) ? key(event.providerSessionId, event.nativeEventKey) : undefined;
  }
  private remember(event: SyntheticEvent) {
    const id = this.identity(event);
    if (!id) { this.partial = true; this.diagnostics.push('native_identity_missing'); }
    else this.identities.set(id, structuredClone(event));
  }
  append(event: SyntheticEvent, fault?: 'before-persist'): 'persisted' | 'duplicate' | 'conflict' {
    if (this.torn) throw new Error('recording_tail_needs_reconciliation');
    const detached = structuredClone(event);
    const id = this.identity(detached);
    const existing = id ? this.identities.get(id) : undefined;
    if (existing) {
      if (same(existing, detached)) return 'duplicate';
      this.partial = true;
      this.diagnostics.push('native_identity_conflict');
      writeFileSync(this.gapPath, JSON.stringify({ synthetic: true, reason: 'native_identity_conflict' }), { flush: true });
      return 'conflict';
    }
    if (fault === 'before-persist') throw new Error('synthetic_disk_failure');
    const sequence = this.watermark + 1;
    const fd = openSync(this.path, 'a');
    try {
      const bytes = Buffer.from(`${JSON.stringify({ sequence, event: detached })}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error('recording_write_stalled');
        offset += written;
      }
      fsyncSync(fd);
    } catch (error) { this.torn = true; this.partial = true; throw error; }
    finally { closeSync(fd); }
    this.remember(detached);
    this.watermark = sequence;
    return 'persisted';
  }
  coverage(finalSequence?: number) {
    return !this.partial && finalSequence === this.watermark ? 'complete' : 'partial';
  }
}

export interface SyntheticUsage {
  usageId?: string;
  providerSessionId?: string;
  scopeId?: string;
  /** Explicit disjoint leaf-call identities included by this statistic. */
  covers?: readonly string[];
  mode?: 'incremental' | 'cumulative';
  phase?: 'historical' | 'current';
  tokens?: number | null;
  /** Cumulative baseline must be explicit, including 0 for a fresh scope. */
  historyBaseline?: number | null;
}
interface ScopeCounter {
  mode: 'incremental' | 'cumulative';
  covers: readonly string[];
  historyBaseline?: number;
  latest: number;
  value: number;
  providerSessionId: string;
}
export class SyntheticUsageLedger {
  private readonly identities = new Map<string, SyntheticUsage>();
  private readonly scopes = new Map<string, ScopeCounter>();
  private readonly reasons = new Set<string>();
  add(record: SyntheticUsage): 'counted' | 'historical' | 'duplicate' | 'conflict' | 'excluded' {
    const exclude = (reason: string) => { this.reasons.add(reason); return 'excluded' as const; };
    if (!text(record.usageId) || !text(record.providerSessionId) || !text(record.scopeId) ||
        !Array.isArray(record.covers) || record.covers.length === 0 || !record.covers.every(text) ||
        new Set(record.covers).size !== record.covers.length ||
        (record.mode !== 'incremental' && record.mode !== 'cumulative') ||
        (record.phase !== 'historical' && record.phase !== 'current') || !counter(record.tokens)) {
      return exclude('usage_fields_unknown');
    }
    const covers = [...record.covers].sort();
    const normalized = { ...record, covers };
    const id = key(record.providerSessionId, record.phase, record.usageId);
    const previous = this.identities.get(id);
    if (previous) {
      if (same(previous, normalized)) return 'duplicate';
      this.reasons.add('usage_identity_conflict');
      return 'conflict';
    }
    this.identities.set(id, structuredClone(normalized));
    if (record.phase === 'historical') return 'historical';
    if (record.mode === 'cumulative' && (!counter(record.historyBaseline) || record.historyBaseline > record.tokens)) {
      return exclude('cumulative_baseline_unknown');
    }
    const scopeId = key(record.providerSessionId, record.scopeId);
    const scope = this.scopes.get(scopeId);
    if (scope) {
      if (!same(scope.covers, covers)) return exclude('usage_scope_changed');
      if (scope.mode !== record.mode) return exclude('usage_mode_mismatch');
      if (scope.mode === 'cumulative') {
        if (scope.historyBaseline !== record.historyBaseline) return exclude('cumulative_baseline_changed');
        if (record.tokens < scope.latest) return exclude('cumulative_counter_regressed');
      }
    } else {
      for (const other of this.scopes.values()) {
        if (other.providerSessionId === record.providerSessionId && covers.some(leaf => other.covers.includes(leaf))) {
          return exclude('overlapping_usage_scope');
        }
      }
    }
    const value = record.mode === 'incremental' ? (scope?.value ?? 0) + record.tokens : record.tokens - record.historyBaseline!;
    if (!counter(value) || !counter([...this.scopes.entries()].reduce((sum, [id, current]) => sum + (id === scopeId ? 0 : current.value), value))) {
      return exclude('usage_counter_overflow');
    }
    this.scopes.set(scopeId, { mode: record.mode, covers, latest: record.tokens, value,
      providerSessionId: record.providerSessionId,
      ...(record.mode === 'cumulative' ? { historyBaseline: record.historyBaseline! } : {}) });
    return 'counted';
  }
  summary() {
    const values = [...this.scopes.values()];
    return { tokens: values.length ? values.reduce((sum, value) => sum + value.value, 0) : null,
      coverage: values.length === 0 ? 'unknown' : this.reasons.size ? 'partial' : 'complete', reasons: [...this.reasons] };
  }
}
