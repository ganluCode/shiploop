import { buildFeatureDeliveryDetailResult } from '../ports/feature-delivery-query.js';
import { featureReportAttemptArtifactIds } from '../ports/feature-execution-report.js';
import type { FeatureExecutionReportView, FeatureReportResultEvidence } from '../ports/feature-execution-report.js';
import { toPublicWorkSessionAttempt, toPublicWorkSessionRecord, toPublicWorkSessionEvidenceRef } from '../ports/work-session-query.js';
import { toPublicVerificationBatchRecord } from '../ports/task-evidence-query.js';
import { toPublicGitOperationRecord } from '../ports/git-operation-query.js';
import { toPublicAttemptDiagnosticRecord } from '../ports/execution-schedule-query.js';
import { normalizeRuntimeUsage, aggregateUsage, buildUsageProjection } from './usage-normalization.js';
import type { UsageProjectionRecord } from './usage-normalization.js';
import { projectEfficiency } from './efficiency-projection.js';
import type { EfficiencyFact, UsageDiagnosticIdentity } from '../ports/usage-diagnostics.js';
import type { RuntimeUsageReport } from '../ports/runtime-execution.js';
import type { AttemptStatus } from '../ports/attempt-store.js';

const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
function unique<T>(rows: readonly T[], id: (row: T) => string): T[] {
  return [...new Map(rows.map(row => [id(row), row])).values()].sort((a, b) => id(a).localeCompare(id(b), 'en'));
}

/** Pure reconstruction; never reads a clock, mutates a domain entity, or adds
 * overlapping Task/Run/Session usage summaries together. Artifact bodies have
 * already been verified against the snapshot's ready immutable references.
 */
export function buildFeatureExecutionReport(
  view: FeatureExecutionReportView,
  results: ReadonlyMap<string, FeatureReportResultEvidence> = new Map(),
) {
  const diagnosticView = view as FeatureExecutionReportView & {
    readonly usageObservations?: readonly UsageProjectionRecord[];
    readonly efficiency?: Parameters<typeof projectEfficiency>[0];
  };
  const delivery = buildFeatureDeliveryDetailResult({ ...view.delivery, tasks: unique(view.delivery.tasks, t => t.taskId),
    approvalItems: unique(view.delivery.approvalItems, a => a.id) });
  const artifacts = unique(view.artifacts, a => a.id);
  const artifactIndex = new Map(artifacts.map(a => [a.id, a]));
  const reference = (artifactId: string) => {
    const artifact = artifactIndex.get(artifactId);
    return { artifactId, availability: artifact?.status === 'ready' ? 'ready' as const : artifact === undefined ? 'missing' as const : 'unavailable' as const,
      artifact: artifact === undefined ? null : toPublicWorkSessionEvidenceRef(artifact) };
  };
  const sessions = unique(view.sessions, s => s.session.id).map(({ session, attemptId }) => {
    const durationMs = session.startedAtUtcMs === null || session.endedAtUtcMs === null ? null : session.endedAtUtcMs - session.startedAtUtcMs;
    const issues: string[] = [];
    if (durationMs === null) issues.push('session_timing_partial');
    if (session.recordingGaps?.length) issues.push('recording_partial');
    return { attemptId, parentSessionId: session.parentSessionId, ...toPublicWorkSessionRecord(session), durationMs,
      completeness: issues.length === 0 ? 'complete' as const : 'partial' as const, issues };
  });
  const usageInputs: UsageProjectionRecord[] = [];
  const efficiencyFacts: EfficiencyFact[] = [];
  const attempts = unique(view.attempts, a => a.attempt.id).map(detail => {
    const { attempt, session } = detail;
    const resolved = results.get(attempt.id);
    const result = resolved?.evidence?.result ?? null;
    const usage = result?.usage;
    const issues: string[] = [];
    if (resolved?.issue) issues.push(resolved.issue);
    if (session === null) issues.push('session_missing');
    if (attempt.startedAtUtcMs === null || attempt.endedAtUtcMs === null || attempt.durationMs === null) issues.push('attempt_timing_partial');
    if (attempt.exitCode === null && result?.exitCode == null) issues.push('exit_code_unknown');
    if (resolved?.evidence == null) issues.push('runtime_result_unknown');
    if (detail.evidenceTruncated) issues.push('evidence_index_truncated');
    if (detail.diagnosticsTruncated) issues.push('diagnostics_truncated');
    if (session?.recordingGaps?.length || resolved?.evidence?.recording.complete === false) issues.push('recording_partial');
    const ids = new Set<string>(detail.evidence.map(e => e.id));
    for (const id of featureReportAttemptArtifactIds(attempt)) ids.add(id);
    if (session?.resultRef != null) ids.add(session.resultRef);
    const rework = attempt.inputSnapshot.rework;
    const evidence = [...ids].sort().map(reference);
    if (evidence.some(e => e.availability !== 'ready')) issues.push('evidence_unavailable');
    const usageIdentity: UsageDiagnosticIdentity = {
      runtime: session?.runtime ?? 'unknown', provider: resolved?.evidence?.routing?.selected?.provider ?? 'unknown',
      model: resolved?.evidence?.routing?.selected?.model ?? null, attemptId: attempt.id,
      sessionId: session?.id ?? attempt.id, invocationId: attempt.invocationId ?? attempt.id,
      requestId: null, messageId: null, eventId: null, providerSessionId: null,
      providerRequestId: null, recovery: attempt.inputSnapshot.recovery == null ? 'new' : 'resume',
    };
    const normalizedUsage = usage === undefined || usage === null ? null : aggregateUsage([normalizeRuntimeUsage({
      identity: usageIdentity, usage, kind: 'attempt', final: true,
      sourceRefs: (usage.sourceRefs ?? []).map(ref => ({ kind: 'runtime_result' as const, ref, observedAtUtc: null })),
    })]);
    const usageSummary = {
      basis: session?.runtime === 'fake' ? 'synthetic' as const : usage?.basis ?? 'unknown' as const,
      inputTokens: normalizedUsage === null ? usage?.inputTokens ?? attempt.usageSummary?.inputTokens ?? null : normalizedUsage.totals.inputTokens,
      outputTokens: normalizedUsage === null ? usage?.outputTokens ?? attempt.usageSummary?.outputTokens ?? null : normalizedUsage.totals.outputTokens,
      costMicros: normalizedUsage === null ? usage?.costUsdMicros ?? attempt.usageSummary?.costMicros ?? null : normalizedUsage.totals.costUsdMicros,
      currency: usage?.costUsdMicros != null ? 'USD' : attempt.usageSummary?.currency ?? null,
      cacheReadTokens: normalizedUsage?.totals.cacheReadTokens ?? null,
      cacheWriteTokens: normalizedUsage?.totals.cacheWriteTokens ?? null,
    };
    const reportUsage: RuntimeUsageReport | null = usage ?? (attempt.usageSummary === null ||
      [attempt.usageSummary.inputTokens, attempt.usageSummary.outputTokens, attempt.usageSummary.costMicros].every(value => value === null)
      ? null : { basis: session?.runtime === 'fake' ? 'synthetic' : 'reported', inputTokens: attempt.usageSummary.inputTokens,
        outputTokens: attempt.usageSummary.outputTokens, costUsdMicros: attempt.usageSummary.costMicros,
        completeness: 'partial', coverage: 'partial', accounting: 'unknown' });
    if (usageSummary.inputTokens === null || usageSummary.outputTokens === null || usageSummary.costMicros === null) issues.push('usage_partial');
    if (reportUsage !== null) {
      usageInputs.push({ featureId: attempt.featureId, taskId: attempt.taskId, runId: attempt.runId, identity: usageIdentity,
        usage: reportUsage,
        kind: 'attempt', final: true,
        sourceRefs: (reportUsage.sourceRefs ?? []).map(ref => ({ kind: 'runtime_result' as const, ref, observedAtUtc: null })) });
    }
    const outcome: EfficiencyFact['outcome'] = attempt.status === 'succeeded' ? 'completed' : attempt.status === 'failed' ? 'failed'
      : attempt.status === 'cancelled' ? 'cancelled' : ['preparing', 'executing', 'verifying'].includes(attempt.status) ? 'started' : 'unknown';
    efficiencyFacts.push({ schemaVersion: 1, factId: `attempt-${attempt.id}`, kind: 'model_request', identity: usageIdentity,
      outcome, observedAtUtc: iso(attempt.updatedAtUtcMs)!, startedAtUtc: iso(attempt.startedAtUtcMs), endedAtUtc: outcome === 'started' ? null : iso(attempt.endedAtUtcMs),
      durationMs: attempt.durationMs, coverage: 'unknown', overlapGroupId: null, toolCallId: null, testRunId: null,
      exitCode: attempt.exitCode, signal: null, sourceRefs: [{ kind: 'runtime_result', ref: attempt.id, observedAtUtc: iso(attempt.updatedAtUtcMs) }] });

    if (usage === undefined || usage === null || usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined ||
      usage.cacheReadIncludedInInput === undefined || usage.cacheWriteIncludedInInput === undefined) issues.push('cache_unknown');
    return {
      ...toPublicWorkSessionAttempt(attempt),
      exitCode: attempt.exitCode ?? result?.exitCode ?? null,
      signal: result?.signal ?? null,
      runtimeDurationMs: result?.durationMs ?? null,
      usage: usageSummary,
      rework: rework == null ? null : { previousAttemptId: rework.previousAttemptId, failureEvidenceRefs: rework.failureEvidenceRefs.map(r => r.artifactId) },
      recovery: attempt.inputSnapshot.recovery == null ? null : {
        sourceAttemptId: attempt.inputSnapshot.recovery.sourceAttemptId,
        sourceSessionId: attempt.inputSnapshot.recovery.sourceSessionId,
        selection: attempt.inputSnapshot.recovery.selection,
        decision: attempt.inputSnapshot.recovery.decision,
      },
      sessionIds: sessions.filter(s => s.attemptId === attempt.id).map(s => s.id),
      evidence,
      diagnostics: unique(detail.diagnostics, d => d.id).map(toPublicAttemptDiagnosticRecord),
      resultEvidence: resolved?.evidence ?? null,
      completeness: issues.length === 0 ? 'complete' as const : 'partial' as const,
      issues,
    };
  });
  const usageProjection = buildUsageProjection([...(diagnosticView.usageObservations ?? []), ...usageInputs]);
  const efficiency = projectEfficiency(diagnosticView.efficiency ?? { facts: efficiencyFacts });
  const modelDimensions = Object.entries(usageProjection.dimensions)
    .filter(([key]) => key.split('|').length === 3)
    .map(([key, node]) => {
      const parts = Object.fromEntries(key.split('|').map(part => part.split(':', 2))) as { runtime: string; provider: string; model: string };
      const records = [...(diagnosticView.usageObservations ?? []), ...usageInputs].filter(record =>
        record.identity.runtime === parts.runtime && record.identity.provider === parts.provider && (record.identity.model ?? 'unknown') === parts.model);
      const sessionIds = [...new Set(records.map(record => record.identity.sessionId))].sort();
      const dimensionSessions = sessions.filter(session => sessionIds.includes(session.id));
      const measuredDimensionSessions = dimensionSessions.filter(session => session.durationMs !== null);
      const completeDimensionTimes = dimensionSessions.length > 0 && measuredDimensionSessions.length === dimensionSessions.length;
      const starts = dimensionSessions.flatMap(session => session.startedAt === null ? [] : [Date.parse(session.startedAt)]);
      const ends = dimensionSessions.flatMap(session => session.endedAt === null ? [] : [Date.parse(session.endedAt)]);
      return { key, runtime: parts.runtime, provider: parts.provider, model: parts.model, aggregate: node.aggregate,
        calls: node.aggregate.countedObservations, sessions: sessionIds.length,
        cumulativeDurationMs: measuredDimensionSessions.length === 0 ? null : measuredDimensionSessions.reduce((sum, session) => sum + session.durationMs!, 0),
        wallClockDurationMs: completeDimensionTimes ? Math.max(...ends) - Math.min(...starts) : null,
        coverage: node.aggregate.coverage, accounting: node.aggregate.accounting, diagnostics: node.aggregate.diagnostics };
    });
  const usage = { attempts: usageProjection.attempts, tasks: usageProjection.tasks, runs: usageProjection.runs,
    feature: usageProjection.feature, dimensions: modelDimensions, aggregate: usageProjection.feature.aggregate };
  const taskUsage = new Map(usageProjection.tasks.map(node => [node.id, node.aggregate]));
  const taskTiming = (history: readonly (typeof attempts[number])[]) => {
    const taskSessions = sessions.filter(session => history.some(attempt => attempt.id === session.attemptId));
    const measuredTaskSessions = taskSessions.filter(session => session.durationMs !== null);
    const completeTaskTimes = taskSessions.length > 0 && measuredTaskSessions.length === taskSessions.length;
    const starts = taskSessions.flatMap(session => session.startedAt === null ? [] : [Date.parse(session.startedAt)]);
    const ends = taskSessions.flatMap(session => session.endedAt === null ? [] : [Date.parse(session.endedAt)]);
    return { cumulativeMs: measuredTaskSessions.length === 0 ? null : measuredTaskSessions.reduce((sum, session) => sum + session.durationMs!, 0),
      wallClockMs: completeTaskTimes ? Math.max(...ends) - Math.min(...starts) : null,
      completeness: completeTaskTimes ? 'complete' as const : 'partial' as const };
  };
  const tasks = unique(delivery.axes.tasks.records, t => t.taskId).map(current => {
    const history = attempts.filter(a => a.taskId === current.taskId).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id, 'en'));
    const counts: Record<AttemptStatus, number> = { preparing: 0, executing: 0, verifying: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0 };
    for (const attempt of history) counts[attempt.status]++;
    return { current, latestAttempt: history.at(-1) ?? null,
      cumulative: { attempts: history.length, byStatus: counts, reworks: history.filter(a => a.rework !== null).length },
      usage: { aggregate: taskUsage.get(current.taskId) ?? aggregateUsage([]) }, timing: taskTiming(history),
      codeChangeRefs: [...new Set(history.flatMap(attempt => {
        const codeRef = view.attempts.find(detail => detail.attempt.id === attempt.id)?.attempt.codeRef;
        return codeRef === null || codeRef === undefined ? [] : [codeRef];
      }))].sort(),
      evidenceRefs: [...new Set(history.flatMap(attempt => attempt.evidence.map(ref => ref.artifactId)))].sort(), attempts: history };

  });
  const measured = sessions.filter(s => s.durationMs !== null);
  const starts = sessions.flatMap(s => s.startedAt === null ? [] : [Date.parse(s.startedAt)]);
  const ends = sessions.flatMap(s => s.endedAt === null ? [] : [Date.parse(s.endedAt)]);
  const completeTimes = sessions.length > 0 && measured.length === sessions.length;
  const issues = [...new Set([...attempts.flatMap(a => a.issues), ...sessions.flatMap(s => s.issues)])].sort();
  if (view.delivery.approvalItemsTruncated) issues.push('approval_items_truncated');
  const evidence = [...new Set([...view.artifactIds, ...artifacts.map(a => a.id)])].sort().map(reference);
  if (evidence.some(e => e.availability !== 'ready') && !issues.includes('evidence_unavailable')) issues.push('evidence_unavailable');
  return {
    schemaVersion: 1 as const,
    scope: 'feature-execution-report' as const,
    consistency: { mode: 'single-read-transaction' as const, eventWatermark: view.eventWatermark },
    feature: delivery.feature, axes: delivery.axes, outcome: delivery.outcome,
    tasks, usage, efficiency, sessions,

    runs: unique(view.runs, r => r.id).map(r => ({ id: r.id, batchId: r.batchId, status: r.status, reason: r.reason,
      startedAt: iso(r.startedAtUtcMs), endedAt: iso(r.endedAtUtcMs) })),
    verifications: unique(view.verifications, v => v.batch.id).map(toPublicVerificationBatchRecord),
    operations: unique(view.operations, o => o.intent.operationId).map(toPublicGitOperationRecord),
    evidence,
    timing: {
      cumulativeSessionMs: measured.length === 0 ? null : measured.reduce((total, s) => total + s.durationMs!, 0),
      // Wall clock spans all Sessions including overlap and gaps. Incomplete
      // boundaries remain unknown; no current clock is substituted for an end.
      wallClockMs: completeTimes ? Math.max(...ends) - Math.min(...starts) : null,
      measuredSessions: measured.length, totalSessions: sessions.length,
      completeness: completeTimes ? 'complete' as const : 'partial' as const,
    },
    counts: { tasks: tasks.length, runs: new Set(view.runs.map(r => r.id)).size, attempts: attempts.length,
      sessions: sessions.length, operations: new Set(view.operations.map(o => o.intent.operationId)).size },
    completeness: issues.length > 0 || !completeTimes ? 'partial' as const : 'complete' as const,
    issues,
  };
}

export type FeatureExecutionReport = ReturnType<typeof buildFeatureExecutionReport>;
