import type { ExecutionBatchRecord, RunRecord } from '../ports/execution-store.js';

/** Deterministic Git/checks create no Run, Attempt or model start. Already reserved counters may equal their ceilings. */
export function existingRunBudgetAllowsIntegration(batch: Pick<ExecutionBatchRecord,
  'budgetSnapshot' | 'runsCreated' | 'attemptsCreated' | 'runtimeStarts' | 'noProgressRuns' | 'deadlineAtUtcMs'>,
  run: Pick<RunRecord, 'startedAtUtcMs' | 'runTimeLimitMs'>, nowUtcMs: number): boolean {
  const limits = batch.budgetSnapshot.batch;
  const counters = [[batch.runsCreated, limits.maxRuns], [batch.attemptsCreated, limits.maxTotalAttempts],
    [batch.runtimeStarts, limits.maxRuntimeStarts], [batch.noProgressRuns, limits.maxNoProgressRuns]];
  return Number.isSafeInteger(nowUtcMs) && nowUtcMs < batch.deadlineAtUtcMs
    && nowUtcMs < limits.deadlineUtcMs
    && counters.every(([used, limit]) => Number.isSafeInteger(used) && used >= 0 && used <= limit)
    && (run.startedAtUtcMs === null || nowUtcMs < run.startedAtUtcMs + run.runTimeLimitMs);
}
