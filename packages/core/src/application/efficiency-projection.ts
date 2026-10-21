import { EFFICIENCY_FACT_KINDS, validateEfficiencyFact, validateEfficiencyObservation } from '../ports/usage-diagnostics.js';
import type { EfficiencyFact, EfficiencyFactKind, EfficiencyObservation, UsageCoverage } from '../ports/usage-diagnostics.js';

export interface EfficiencyProjectionInput {
  readonly facts: readonly EfficiencyFact[];
  /** Completeness of the supplied range, never inferred from successful outcomes. */
  readonly coverage?: UsageCoverage;
  readonly truncated?: boolean;
  readonly observations?: readonly EfficiencyObservation[];
}

export interface ProjectedEfficiencyFact extends EfficiencyFact {
  readonly reportedDurationMs: number | null;
  readonly issues: readonly string[];
  readonly budgetMs: number | null;
  readonly unknownReason: string | null;
  readonly lifecycleStatus: 'running' | Exclude<EfficiencyFact['outcome'], 'started'>;
  /** Stored running/terminal facts are historical observations, not a live OS probe. */
  readonly processLiveness: 'unknown';
}

/** Stable invocation boundaries, not provider/native identities or replay event IDs. */
function callKey(f: EfficiencyFact): string {
  const family = f.kind === 'failed_model_request' ? 'model_request' : f.kind;
  const call = family === 'model_request' ? f.identity.requestId
    : family === 'tool_execution' ? f.toolCallId
    : family === 'runtime_test' || family === 'verification' ? f.testRunId : null;
  return JSON.stringify([f.identity.attemptId, f.identity.sessionId, f.identity.invocationId, family, call ?? f.factId]);
}

function projectFact(f: EfficiencyFact): ProjectedEfficiencyFact {
  const issues: string[] = [];
  const endedAtUtc = f.outcome === 'started' ? null : f.endedAtUtc;
  const boundaryDuration = f.startedAtUtc === null || endedAtUtc === null ? null : Date.parse(endedAtUtc) - Date.parse(f.startedAtUtc);
  const durationMs = boundaryDuration !== null && boundaryDuration >= 0 ? boundaryDuration : null;
  if (boundaryDuration !== null && boundaryDuration < 0) issues.push('end_before_start');
  if (durationMs === null) issues.push('time_boundary_missing');
  if (f.outcome === 'started') issues.push('completion_unobserved');
  if (f.outcome === 'unknown') issues.push('outcome_unknown');
  if (f.sourceRefs.length === 0) issues.push('source_missing');
  if ((f.kind === 'model_request' || f.kind === 'failed_model_request') && f.identity.requestId === null
    || f.kind === 'tool_execution' && f.toolCallId === null
    || (f.kind === 'runtime_test' || f.kind === 'verification') && f.testRunId === null) issues.push('call_identity_missing');
  if (durationMs !== null && f.durationMs !== null && durationMs !== f.durationMs) issues.push('duration_boundary_mismatch');
  return { ...f, kind: f.kind === 'model_request' && (f.outcome === 'failed' || f.outcome === 'cancelled') ? 'failed_model_request' : f.kind,
    endedAtUtc, durationMs, reportedDurationMs: f.durationMs, budgetMs: f.budgetMs ?? null,
    exitCode: f.outcome === 'started' ? null : f.exitCode, signal: f.outcome === 'started' ? null : f.signal,
    unknownReason: f.unknownReason ?? issues[0] ?? (f.exitCode === null ? 'exit_code_not_collected' : f.budgetMs == null ? 'budget_not_collected' : null),
    lifecycleStatus: f.outcome === 'started' ? 'running' : f.outcome, processLiveness: 'unknown',
    coverage: f.coverage === 'unknown' ? 'unknown' : issues.length > 0 ? 'partial' : f.coverage, issues };
}

function timing(facts: readonly ProjectedEfficiencyFact[], coverage: UsageCoverage) {
  const measured = facts.filter(f => f.durationMs !== null);
  const intervals = measured.map(f => [Date.parse(f.startedAtUtc!), Date.parse(f.endedAtUtc!)] as const).sort((a, b) => a[0] - b[0]);
  let active = 0;
  let end: number | null = null;
  for (const [start, stop] of intervals) {
    active += Math.max(0, stop - Math.max(start, end ?? start));
    end = Math.max(end ?? stop, stop);
  }
  const complete = coverage === 'reported' && measured.length === facts.length && facts.every(f => f.coverage === 'reported');
  const known = intervals.length > 0;
  return {
    cumulativeMs: known ? measured.reduce((sum, f) => sum + f.durationMs!, 0) : null,
    // Union across every interval, including overlap across different stage/group IDs.
    activeWallClockMs: known ? active : null,
    wallClockSpanMs: complete && known ? Math.max(...intervals.map(i => i[1])) - intervals[0][0] : null,
    measuredFacts: measured.length, totalFacts: facts.length,
    coverage: complete && known ? 'reported' as const : known ? 'partial' as const : 'unknown' as const,
  };
}

/** Metric identity excludes replay event IDs and scopes native-looking IDs to Core invocations. */
function observationKey(o: EfficiencyObservation): string {
  return JSON.stringify([o.identity.attemptId, o.identity.sessionId, o.identity.invocationId, o.kind,
    o.kind === 'tool' ? o.toolCallId : o.kind === 'reply' ? o.identity.messageId ?? o.observationId : o.identity.requestId ?? o.observationId]);
}

function projectMetrics(raw: readonly EfficiencyObservation[], coverage: UsageCoverage) {
  const byCall = new Map<string, EfficiencyObservation>();
  // Sort before selecting latest samples so input order/replay cannot change a report.
  const sorted = raw.map(validateEfficiencyObservation).sort((a, b) => a.observedAtUtc.localeCompare(b.observedAtUtc)
    || a.observationId.localeCompare(b.observationId, 'en') || JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  for (const observation of sorted) {
    const key = observationKey(observation);
    const previous = byCall.get(key);
    const sourceRefs = [...new Map([...(previous?.sourceRefs ?? []), ...observation.sourceRefs].map(s => [JSON.stringify(s), s])).values()]
      .sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
    byCall.set(key, { ...observation, sourceRefs });
  }
  const observations = [...byCall.values()].sort((a, b) => a.observedAtUtc.localeCompare(b.observedAtUtc)
    || observationKey(a).localeCompare(observationKey(b), 'en'));
  const replies = observations.filter(o => o.kind === 'reply');
  const tools = observations.filter(o => o.kind === 'tool');
  const contexts = observations.filter(o => o.kind === 'context');
  const parentKeys = new Set(tools.filter(o => o.parentToolCallId !== null).map(o => JSON.stringify([
    o.identity.attemptId, o.identity.sessionId, o.identity.invocationId, o.parentToolCallId])));
  const roots = tools.filter(o => o.parentToolCallId === null);
  const leaves = tools.filter(o => o.parentToolCallId !== null && !parentKeys.has(JSON.stringify([
    o.identity.attemptId, o.identity.sessionId, o.identity.invocationId, o.toolCallId])));
  function metric<T extends EfficiencyObservation>(samples: readonly T[], value: (sample: T) => boolean | null) {
    const known = samples.filter(s => value(s) !== null && s.coverage !== 'unknown' && s.sourceRefs.length > 0
      && (s.kind !== 'reply' || s.identity.messageId !== null));
    return { value: known.length === 0 ? null : known.filter(s => value(s)).length,
      coverage: known.length === 0 ? 'unknown' as const
        : coverage === 'reported' && known.length === samples.length && samples.every(s => s.coverage === 'reported') ? 'reported' as const : 'partial' as const,
      sourceRefs: [...new Set(known.flatMap(s => s.sourceRefs.map(r => r.ref)))].sort() };
  }
  const effectiveReplies = metric(replies, r => r.effective);
  const toolCalls = metric(roots, () => true);
  const replyKeys = new Set(replies.filter(r => r.effective === true && r.identity.messageId !== null).map(r => JSON.stringify([
    r.identity.attemptId, r.identity.sessionId, r.identity.invocationId, r.identity.messageId])));
  const attributed = roots.every(t => t.replyMessageId !== null && replyKeys.has(JSON.stringify([
    t.identity.attemptId, t.identity.sessionId, t.identity.invocationId, t.replyMessageId])));
  const toolsPerReply = { value: !attributed || !effectiveReplies.value || toolCalls.value === null ? null : toolCalls.value / effectiveReplies.value,
    coverage: !attributed || !effectiveReplies.value || toolCalls.value === null ? 'unknown' as const
      : effectiveReplies.coverage === 'reported' && toolCalls.coverage === 'reported' ? 'reported' as const : 'partial' as const,
    sourceRefs: [...new Set([...effectiveReplies.sourceRefs, ...toolCalls.sourceRefs])].sort() };
  const knownContext = contexts.filter(c => c.inputTokens !== null && c.coverage !== 'unknown' && c.sourceRefs.length > 0 && c.identity.requestId !== null);
  const completeContext = coverage === 'reported' && contexts.length > 0 && knownContext.length === contexts.length
    && contexts.every(c => c.coverage === 'reported' && c.identity.requestId !== null);
  return { observations,
    metrics: { effectiveReplies, toolCalls, leafToolOperations: metric(leaves, () => true), toolsPerReply,
      batchToolCalls: metric(roots, t => t.batch), codemodeCalls: metric(roots, t => t.codemode),
      repeatedReads: metric(tools, t => t.repeatedRead), toolErrors: metric(tools, t => t.error), largeOutputs: metric(tools, t => t.largeOutput) },
    replyTools: replies.map(reply => {
      const linked = roots.filter(t => t.replyMessageId !== null && t.replyMessageId === reply.identity.messageId
        && t.identity.attemptId === reply.identity.attemptId && t.identity.sessionId === reply.identity.sessionId
        && t.identity.invocationId === reply.identity.invocationId);
      return { identity: reply.identity, effective: reply.effective,
        toolCalls: reply.identity.messageId === null || tools.length === 0 ? null : linked.length,
        coverage: reply.identity.messageId === null || tools.length === 0 ? 'unknown' as const
          : coverage === 'reported' && attributed && reply.coverage === 'reported' ? 'reported' as const : 'partial' as const,
        sourceRefs: [...new Set([...reply.sourceRefs, ...linked.flatMap(t => t.sourceRefs)].map(s => s.ref))].sort() };
    }),
    context: { basis: 'per_request_input' as const, first: completeContext ? contexts[0].inputTokens : null,
      peak: knownContext.length > 0 ? Math.max(...knownContext.map(c => c.inputTokens!)) : null,
      last: completeContext ? contexts.at(-1)!.inputTokens : null,
      coverage: completeContext ? 'reported' as const : knownContext.length > 0 ? 'partial' as const : 'unknown' as const,
      sourceRefs: [...new Set(knownContext.flatMap(c => c.sourceRefs.map(r => r.ref)))].sort() },
  };
}

/** Pure projection over public events/Artifact facts. No clock, I/O or SDK state. */
export function projectEfficiency(input: EfficiencyProjectionInput) {
  if (input.facts.length > 10000 || (input.observations?.length ?? 0) > 10000) throw new TypeError('EfficiencyProjection: input_limit');
  const coverage = input.truncated ? 'partial' : input.coverage ?? 'unknown';
  if (!['reported', 'partial', 'unknown'].includes(coverage)) throw new TypeError('EfficiencyProjection: invalid_coverage');
  const calls = new Map<string, EfficiencyFact[]>();
  for (const value of input.facts) {
    const fact = validateEfficiencyFact(value);
    const key = callKey(fact);
    const history = calls.get(key);
    if (history === undefined) calls.set(key, [fact]);
    else history.push(fact);
  }
  const facts = [...calls.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, history]) => {
    // A late replay of a start cannot replace a previously observed terminal fact.
    history.sort((a, b) => Number(a.outcome !== 'started') - Number(b.outcome !== 'started')
      || a.observedAtUtc.localeCompare(b.observedAtUtc) || a.factId.localeCompare(b.factId));
    const latest = history.at(-1)!;
    const starts = [...new Set(history.flatMap(f => f.startedAtUtc === null ? [] : [f.startedAtUtc]))];
    const terminals = history.filter(f => f.outcome !== 'started');
    const terminalSignatures = new Set(terminals.map(f => JSON.stringify([f.outcome, f.endedAtUtc, f.exitCode, f.signal])));
    const models = new Set(history.map(f => JSON.stringify([f.identity.runtime, f.identity.provider, f.identity.model])));
    const conflict = starts.length > 1 || terminalSignatures.size > 1 || models.size > 1;
    const sourceRefs = [...new Map(history.flatMap(f => f.sourceRefs).map(s => [JSON.stringify(s), s])).values()]
      .sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
    const projected = projectFact({ ...latest, sourceRefs, startedAtUtc: starts.length === 1 ? starts[0] : latest.startedAtUtc,
      budgetMs: latest.budgetMs ?? history.find(f => f.budgetMs != null)?.budgetMs ?? null });
    const reconciled: ProjectedEfficiencyFact = conflict ? { ...projected, durationMs: null, coverage: 'unknown', outcome: 'unknown',
      lifecycleStatus: 'unknown', exitCode: null, unknownReason: 'conflicting_lifecycle',
      issues: [...projected.issues, 'conflicting_lifecycle'] } : projected;
    return reconciled;
  });
  return {
    ...projectMetrics(input.observations ?? [], coverage),
    schemaVersion: 1 as const,
    modelRequestTimingBasis: 'waiting_network_generation' as const,
    facts,
    stages: Object.fromEntries(EFFICIENCY_FACT_KINDS.map(kind => [kind, timing(facts.filter(f => f.kind === kind), coverage)])) as Record<EfficiencyFactKind, ReturnType<typeof timing>>,
    timing: timing(facts, coverage),
    coverage,
    issues: [...new Set([...(input.truncated ? ['input_truncated'] : []), ...facts.flatMap(f => f.issues)])].sort(),
  };
}
