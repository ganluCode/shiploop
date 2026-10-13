import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = new URL('../docs/p03-3-handoff.md', import.meta.url);

describe('F-014 integration handoff', () => {
  it('records public integration points, compatibility and later ownership without claiming runtime completion', () => {
    const text = readFileSync(doc, 'utf8');
    for (const term of [
      'FR-1', 'FR-2', 'T13', 'T21', 'T25', 'T31',
      'CommandTransaction', 'reserveTaskAttempt', 'reserveRuntimeStart',
      'settleExecutionRunOutcome', 'execution.budget.revise', 'getExecutionBudget',
      'maxCodeAttempts', 'maxAttemptsPerTask', 'baseline',
      'P03-4', 'P03-6', 'P03-9', 'accepted', 'not_run',
      'dist-host-entry-catalog.mjs', 'p03-3-cli-built.test.ts',
    ]) expect(text, term).toContain(term);
    expect(text).toContain('scheduler_not_assembled');
    expect(text).toContain('runtimeStartsReserved=0');
    expect(text).toContain('capabilityCatalog');
  });
});
