import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { projectEfficiency, validateEfficiencyFact, validateEfficiencyObservation } from '../../../packages/core/src/index.ts';
import type { EfficiencyFact, EfficiencyObservation, UsageDiagnosticIdentity } from '../../../packages/core/src/index.ts';

const identity: UsageDiagnosticIdentity = {
  runtime: 'pi', provider: 'provider-a', model: 'model-a', attemptId: 'attempt-1', sessionId: 'session-1',
  invocationId: 'invocation-1', requestId: 'request-1', messageId: null, eventId: null,
  providerSessionId: null, providerRequestId: null, recovery: 'new',
};
const utc = (ms: number) => new Date(Date.UTC(2026, 9, 20) + ms).toISOString();
function fact(factId: string, kind: EfficiencyFact['kind'], start: number | null, end: number | null,
  extra: Partial<EfficiencyFact> = {}): EfficiencyFact {
  return { schemaVersion: 1, factId, kind, identity: { ...identity, requestId: factId }, outcome: 'completed',
    observedAtUtc: utc(end ?? start ?? 0), startedAtUtc: start === null ? null : utc(start),
    endedAtUtc: end === null ? null : utc(end), durationMs: start === null || end === null ? null : end - start,
    coverage: 'reported', overlapGroupId: null, toolCallId: null, testRunId: null, exitCode: null, signal: null,
    sourceRefs: [{ kind: 'artifact', ref: `evidence-${factId}`, observedAtUtc: utc(end ?? start ?? 0) }], ...extra };
}

describe('P04-6 效率与耗时投影', () => {
  it('[case:request-failure-backoff] 分列成功请求、失败与退避，回放不重复记账', () => {
    const success = fact('request-ok', 'model_request', 300, 1000);
    const failed = fact('request-fail', 'model_request', 0, 200, { outcome: 'failed' });
    const backoff = fact('retry-wait', 'backoff_wait', 200, 300);
    const result = projectEfficiency({ facts: [success, failed, backoff, success], coverage: 'reported' });
    expect(result.modelRequestTimingBasis).toBe('waiting_network_generation');
    expect(result.stages.model_request.cumulativeMs).toBe(700);
    expect(result.stages.failed_model_request.cumulativeMs).toBe(200);
    expect(result.stages.backoff_wait.cumulativeMs).toBe(100);
    expect(result.timing).toMatchObject({ cumulativeMs: 1000, activeWallClockMs: 1000, wallClockSpanMs: 1000, coverage: 'reported' });
    expect(result.facts).toHaveLength(3);
    expect(result.facts.find(f => f.factId === 'request-fail')?.sourceRefs[0].ref).toBe('evidence-request-fail');
  });

  it('[case:overlap-and-gaps] 累计、区间并集和含空隙跨度分别计算，嵌套不产生负时长', () => {
    const result = projectEfficiency({ coverage: 'reported', facts: [
      fact('a', 'tool_execution', 0, 100, { toolCallId: 'a', overlapGroupId: 'parallel' }),
      fact('b', 'tool_execution', 20, 40, { toolCallId: 'b', overlapGroupId: 'parallel' }),
      fact('c', 'runtime_test', 80, 150, { testRunId: 'test-c' }),
      fact('d', 'git', 200, 250), fact('e', 'finalization', 250, 270),
    ] });
    expect(result.timing).toMatchObject({ cumulativeMs: 260, activeWallClockMs: 220, wallClockSpanMs: 270 });
    expect(result.stages.tool_execution).toMatchObject({ cumulativeMs: 120, activeWallClockMs: 100, wallClockSpanMs: 100 });
    expect(result.stages.runtime_test.cumulativeMs).toBe(70);
    expect(result.stages.git.cumulativeMs).toBe(50);
    expect(result.stages.finalization.cumulativeMs).toBe(20);
  });

  it('[case:background-real-exit] 后台返回仍为未确认运行，收到真实退出后才计完整测试耗时', async () => {
    // IPC barrier keeps a real short child alive without sleeps or timing races.
    const child = spawn(process.execPath, ['-e', "process.send('ready'); process.on('message', () => process.exit(7));"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(child, 'close');
    try {
      await once(child, 'message');
      const started = fact('test-start', 'runtime_test', 100, null, { identity, outcome: 'started',
        testRunId: `test-${child.pid}`, budgetMs: 5000, durationMs: 2 });
      const running = projectEfficiency({ facts: [started], coverage: 'reported' });
      expect(running.facts[0]).toMatchObject({ durationMs: null, reportedDurationMs: 2, exitCode: null,
        budgetMs: 5000, lifecycleStatus: 'running', processLiveness: 'unknown' });
      expect(running.timing.wallClockSpanMs).toBeNull();
      child.send('finish');
      const [exitCode, signal] = await closed;
      const ended = fact('test-end', 'runtime_test', 100, 1600, { identity, testRunId: started.testRunId,
        outcome: 'failed', exitCode: exitCode as number, signal: signal as string | null, budgetMs: 5000 });
      const result = projectEfficiency({ facts: [ended, { ...started, observedAtUtc: utc(2000) }], coverage: 'reported' });
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]).toMatchObject({ durationMs: 1500, exitCode: 7, budgetMs: 5000, lifecycleStatus: 'failed' });
      expect(result.facts[0].sourceRefs.map(s => s.ref)).toEqual(['evidence-test-end', 'evidence-test-start']);
      expect(result.stages.runtime_test.cumulativeMs).toBe(1500);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
    }
  });

  it('[case:partial-unknown-truncation] 缺边界、截断、未知字段与时长冲突都不伪造完整结果', () => {
    const result = projectEfficiency({ facts: [fact('known', 'verification', 10, 60, { testRunId: 'verify', exitCode: 0 }),
      fact('missing', 'tool_execution', null, 100), fact('running', 'runtime_test', 0, null, { outcome: 'started' })],
      coverage: 'reported', truncated: true });
    expect(result.timing).toMatchObject({ cumulativeMs: 50, wallClockSpanMs: null, coverage: 'partial' });
    expect(result.stages.verification.cumulativeMs).toBe(50);
    expect(result.stages.tool_execution.coverage).toBe('unknown');
    expect(result.facts.find(f => f.factId === 'missing')).toMatchObject({ durationMs: null, budgetMs: null,
      unknownReason: 'time_boundary_missing' });
    expect(result.issues).toContain('input_truncated');
    const mismatch = projectEfficiency({ facts: [fact('mismatch', 'git', 10, 60, { durationMs: 2 })], coverage: 'reported' });
    expect(mismatch.facts[0]).toMatchObject({ durationMs: 50, reportedDurationMs: 2, coverage: 'partial' });
    expect(mismatch.timing.wallClockSpanMs).toBeNull();
    expect(projectEfficiency({ facts: [] }).timing.coverage).toBe('unknown');
  });

  it('[case:metrics-and-context] 有效回复、父工具与叶操作、可得批量指标和上下文首峰末分列', () => {
    const base = { identity, coverage: 'reported' as const, sourceRefs: fact('metric', 'git', 0, 1).sourceRefs };
    const observations: EfficiencyObservation[] = [
      { ...base, observationId: 'reply', kind: 'reply', observedAtUtc: utc(0), identity: { ...identity, messageId: 'reply-1' }, effective: true },
      { ...base, observationId: 'tool-parent', kind: 'tool', observedAtUtc: utc(1), toolCallId: 'parent', parentToolCallId: null,
        replyMessageId: 'reply-1', batch: true, codemode: true, repeatedRead: false, error: false, largeOutput: false },
      { ...base, observationId: 'tool-leaf', kind: 'tool', observedAtUtc: utc(2), toolCallId: 'leaf', parentToolCallId: 'parent',
        replyMessageId: 'reply-1', batch: false, codemode: false, repeatedRead: true, error: true, largeOutput: true },
      ...[100, 300, 200].map((inputTokens, i): EfficiencyObservation => ({ ...base, observationId: `context-${i}`,
        identity: { ...identity, requestId: `req-${i}` }, kind: 'context', observedAtUtc: utc(i), inputTokens })),
    ];
    const result = projectEfficiency({ facts: [], observations: [...observations, observations[1]], coverage: 'reported' });
    expect(result.metrics.effectiveReplies).toMatchObject({ value: 1, coverage: 'reported' });
    expect(result.metrics.toolCalls.value).toBe(1);
    expect(result.metrics.leafToolOperations.value).toBe(1);
    expect(result.metrics.toolsPerReply.value).toBe(1);
    expect(result.metrics.batchToolCalls.value).toBe(1);
    expect(result.metrics.codemodeCalls.value).toBe(1);
    expect(result.metrics.repeatedReads.value).toBe(1);
    expect(result.metrics.toolErrors.value).toBe(1);
    expect(result.metrics.largeOutputs.value).toBe(1);
    expect(result.context).toMatchObject({ first: 100, peak: 300, last: 200, coverage: 'reported', basis: 'per_request_input' });
    expect(result.observations).toHaveLength(observations.length);
    expect(result.replyTools).toMatchObject([{ identity: { messageId: 'reply-1' }, toolCalls: 1, coverage: 'reported' }]);
    expect(projectEfficiency({ facts: [], observations: [...observations].reverse(), coverage: 'reported' })).toEqual(
      projectEfficiency({ facts: [], observations, coverage: 'reported' }));
  });

  it('[case:lifecycle-merge-conflict] 合并分离的开始结束事实，冲突终态保持未知且不与其他调用混合', () => {
    const started = fact('start', 'tool_execution', 10, null, { identity, toolCallId: 'tool-1', outcome: 'started', budgetMs: 900 });
    const ended = fact('end', 'tool_execution', null, 110, { identity, toolCallId: 'tool-1', exitCode: 0 });
    const result = projectEfficiency({ facts: [ended, started], coverage: 'reported' });
    expect(result.facts[0]).toMatchObject({ startedAtUtc: utc(10), endedAtUtc: utc(110), durationMs: 100, budgetMs: 900 });
    const conflict = projectEfficiency({ coverage: 'reported', facts: [started, ended,
      { ...ended, factId: 'conflicting-end', outcome: 'failed', exitCode: 7, observedAtUtc: utc(120) }] });
    expect(conflict.facts[0]).toMatchObject({ durationMs: null, outcome: 'unknown', exitCode: null, unknownReason: 'conflicting_lifecycle' });
    expect(conflict.timing.cumulativeMs).toBeNull();
    const reversed = projectEfficiency({ facts: [{ ...started, startedAtUtc: utc(200) }, ended], coverage: 'reported' });
    expect(reversed.facts[0]).toMatchObject({ durationMs: null, unknownReason: 'end_before_start' });
    expect(reversed.timing.cumulativeMs).toBeNull();
    const foreign = { ...ended, factId: 'other-attempt', identity: { ...identity, attemptId: 'attempt-2' } };
    expect(projectEfficiency({ facts: [ended, foreign] }).facts).toHaveLength(2);
    const launcher = projectEfficiency({ facts: [{ ...started, endedAtUtc: utc(12), durationMs: 2, exitCode: 0 }] });
    expect(launcher.facts[0]).toMatchObject({ endedAtUtc: null, durationMs: null, exitCode: null, lifecycleStatus: 'running' });
  });

  it('[case:invalid-evidence] 拒绝非法时间、预算、身份、指标和无界输入', () => {
    const base = fact('valid', 'git', 10, 60);
    for (const bad of [{ ...base, budgetMs: -1 }, { ...base, observedAtUtc: null },
      { ...base, startedAtUtc: utc(100) }, { ...base, exitCode: 1.5 }]) {
      expect(() => validateEfficiencyFact(bad)).toThrow();
    }
    expect(() => projectEfficiency({ facts: Array(10001).fill(base) })).toThrow('input_limit');
    expect(() => validateEfficiencyObservation({ kind: 'context', observationId: 'ctx', identity,
      observedAtUtc: utc(0), coverage: 'reported', sourceRefs: base.sourceRefs, inputTokens: -1 })).toThrow();
  });

  it('[case:metrics-unknown] 未采集或未归属的指标为 unknown，截断只报告已知小计', () => {
    const unknown = projectEfficiency({ facts: [] });
    expect(unknown.metrics.effectiveReplies).toMatchObject({ value: null, coverage: 'unknown' });
    expect(unknown.metrics.toolsPerReply.value).toBeNull();
    expect(unknown.context).toMatchObject({ first: null, peak: null, last: null, coverage: 'unknown' });
    const sample: EfficiencyObservation = { observationId: 'tool', identity, kind: 'tool', observedAtUtc: utc(0),
      coverage: 'reported', sourceRefs: fact('src', 'git', 0, 1).sourceRefs, toolCallId: 't', parentToolCallId: null,
      replyMessageId: null, batch: null, codemode: null, repeatedRead: null, error: true, largeOutput: null };
    const result = projectEfficiency({ facts: [], observations: [sample], coverage: 'reported', truncated: true });
    expect(result.metrics.toolErrors).toMatchObject({ value: 1, coverage: 'partial' });
    expect(result.metrics.codemodeCalls).toMatchObject({ value: null, coverage: 'unknown' });
    expect(result.metrics.toolsPerReply.value).toBeNull();
  });

  it('[case:cross-stage-lifecycle] 两次尝试的失败退避、并发工具测试与收尾按受控边界分解', () => {
    const start = fact('background-start', 'runtime_test', 110, 112, {
      testRunId: 'background-1', outcome: 'started', durationMs: 2, budgetMs: 5000, exitCode: 0,
    });
    const running = { ...start, factId: 'background-running', observedAtUtc: utc(150) };
    const pending = projectEfficiency({ facts: [start, running], coverage: 'reported' });
    expect(pending.facts).toHaveLength(1);
    expect(pending.facts[0]).toMatchObject({ lifecycleStatus: 'running', durationMs: null, endedAtUtc: null,
      reportedDurationMs: 2, exitCode: null, processLiveness: 'unknown', budgetMs: 5000 });
    expect(pending.stages.runtime_test.cumulativeMs).toBeNull();
    const completed = fact('background-completed', 'runtime_test', null, 210, {
      testRunId: 'background-1', exitCode: 0, budgetMs: 5000,
    });
    const facts = [
      fact('failed-request', 'model_request', 0, 20, { outcome: 'failed' }),
      fact('backoff', 'backoff_wait', 20, 30), fact('success-request', 'model_request', 30, 100),
      fact('tool', 'tool_execution', 100, 200, { toolCallId: 'tool-1' }),
      start, completed, running, completed,
      fact('verification', 'verification', 210, 240, { testRunId: 'verifier-1', exitCode: 0 }),
      fact('git', 'git', 240, 250), fact('finalization', 'finalization', 250, 260),
      fact('cancelled-request', 'model_request', 0, 50, {
        identity: { ...identity, attemptId: 'attempt-2', sessionId: 'session-2' }, outcome: 'cancelled' }),
    ];
    const result = projectEfficiency({ facts, coverage: 'reported' });
    expect(result.timing).toMatchObject({ cumulativeMs: 400, activeWallClockMs: 260, wallClockSpanMs: 260,
      totalFacts: 9, measuredFacts: 9, coverage: 'reported' });
    expect(Object.fromEntries(Object.entries(result.stages).map(([key, stage]) => [key, stage.cumulativeMs]))).toEqual({
      model_request: 70, failed_model_request: 70, backoff_wait: 10, tool_execution: 100,
      runtime_test: 100, verification: 30, git: 10, finalization: 10,
    });
    expect(result.facts.find(f => f.kind === 'runtime_test')).toMatchObject({ lifecycleStatus: 'completed',
      startedAtUtc: utc(110), endedAtUtc: utc(210), durationMs: 100, exitCode: 0 });
    expect(projectEfficiency({ facts: [...facts].reverse(), coverage: 'reported' })).toEqual(result);
    const partial = projectEfficiency({ facts: [...facts, fact('missing-boundary', 'tool_execution', null, 270)], coverage: 'reported' });
    expect(partial.timing).toMatchObject({ cumulativeMs: 400, activeWallClockMs: 260, wallClockSpanMs: null, coverage: 'partial' });
    expect(partial.facts.find(f => f.factId === 'missing-boundary')).toMatchObject({ durationMs: null, unknownReason: 'time_boundary_missing' });
  });
});
