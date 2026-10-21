import { afterEach, expect, test } from 'vitest';
import { projectEfficiency } from 'shiploop-core';
import { BUDGET, openBudgetFixture, type BudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { reportAttempt, reportQueries } from '../../helpers/p03-10/report-fixture.ts';
import { buildFeatureReportTextView, formatFeatureReportTextView } from '../../../packages/cli/src/app/report.ts';
import type { FeatureExecutionReport } from '../../../packages/core/src/application/feature-execution-report.ts';
import type { UsageAggregate } from '../../../packages/core/src/application/usage-normalization.ts';

const fixtures: BudgetFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const identity = {
  runtime: 'pi', provider: 'provider-a', model: 'model-a', attemptId: 'attempt-diagnostics', sessionId: 'session-diagnostics',
  invocationId: 'invocation-diagnostics', requestId: 'request-diagnostics', messageId: null, eventId: null,
  providerSessionId: null, providerRequestId: null, recovery: 'new' as const,
};
const source = [{ kind: 'artifact' as const, ref: 'evidence-diagnostics', observedAtUtc: '2026-10-20T12:00:00.000Z' }];
const fact = {
  schemaVersion: 1 as const, factId: 'fact-running-test', kind: 'runtime_test' as const, identity,
  outcome: 'started' as const, observedAtUtc: '2026-10-20T12:00:01.000Z', startedAtUtc: '2026-10-20T12:00:00.000Z',
  endedAtUtc: null, durationMs: null, coverage: 'reported' as const, overlapGroupId: null,
  toolCallId: null, testRunId: 'test-running', exitCode: null, signal: null, sourceRefs: source, budgetMs: 5000,
};

function aggregate(base: UsageAggregate, inputTokens: number | null, cacheRate: number | null): UsageAggregate {
  return {
    ...base,
    basis: 'reported',
    totals: { ...base.totals, inputTokens, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: null, reasoningTokens: null, providerTotalTokens: 100, costUsdMicros: null },
    cache: { ...base.cache, readTokens: 80, writeTokens: null, comparableInputTokens: 100, rate: cacheRate, reason: cacheRate === null ? 'unknown_semantics' : 'computed' },
    coverage: cacheRate === null ? 'partial' : 'reported',
    accounting: 'incremental',
    normalization: 'deduplicated',
    sourceRefs: source,
    diagnostics: cacheRate === null ? ['cache_semantics_unknown'] : [],
  };
}

test('[case:diagnostic-report-text] 文本报告展示 Core 用量投影、模型维度、效率阶段与 running 缺口', async () => {
  const fixture = await openBudgetFixture(BUDGET, [{ id: 't-1', title: 'Diagnostics', acceptance: { criteria: ['diagnostics'] }, dependsOn: [] }]);
  fixtures.push(fixture);
  const runId = (await fixture.start()).runId!;
  reportAttempt(fixture, { id: 'attempt-diagnostics', runId, status: 'executing' });
  const report = await reportQueries(fixture).getFeatureReport(fixture.owner, { projectId: fixture.projectId, featureId: fixture.featureId });
  const enriched = structuredClone(report) as FeatureExecutionReport & { usage: FeatureExecutionReport['usage']; efficiency: FeatureExecutionReport['efficiency'] };
  const taskAggregate = aggregate(report.usage.feature.aggregate, 100, 0.8);
  const modelAggregate = aggregate(report.usage.feature.aggregate, 100, 0.8);
  enriched.usage = {
    ...report.usage,
    tasks: [{ scope: 'task', id: 't-1', aggregate: taskAggregate }],
    feature: { ...report.usage.feature, aggregate: taskAggregate },
    dimensions: [{
      key: 'runtime:pi|provider:provider-a|model:model-a', runtime: 'pi', provider: 'provider-a', model: 'model-a',
      aggregate: modelAggregate, calls: 1, sessions: 1, cumulativeDurationMs: null, wallClockDurationMs: null,
      coverage: 'reported', accounting: 'incremental', diagnostics: [],
    }],
  };
  enriched.efficiency = projectEfficiency({ facts: [fact], coverage: 'reported' });

  const view = buildFeatureReportTextView(enriched);
  const text = formatFeatureReportTextView(view);

  expect(view.taskRows[0]).toMatchObject({ usage: { totals: { inputTokens: 100 } }, timing: { completeness: 'complete' } });
  expect(view.usageDimensions).toHaveLength(1);
  expect(view.efficiency.facts[0]).toMatchObject({ lifecycleStatus: 'running', durationMs: null, processLiveness: 'unknown' });
  expect(text).toContain('## 用量诊断');
  expect(text).toContain('task=t-1 basis=reported coverage=reported');
  expect(text).toContain('inputTokens=100');
  expect(text).toContain('cacheRate=0.8 cacheReason=computed');
  expect(text).toContain('model runtime=pi provider=provider-a model=model-a');
  expect(text).toContain('## 效率与耗时分解');
  expect(text).toContain('stage=runtime_test');
  expect(text).toContain('lifecycle=running');
  expect(text).toContain('processLiveness=unknown');
  expect(text).toContain('issues=completion_unobserved,time_boundary_missing');
  expect(text).toContain('sourceRefs=evidence-diagnostics');
  expect(text).not.toContain('session-diagnostics/private');
});
