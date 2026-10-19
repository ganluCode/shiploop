import { buildFeatureDeliveryDetailResult } from '../ports/feature-delivery-query.js';
import { featureReportAttemptArtifactIds, type FeatureExecutionReportView, type FeatureReportResultEvidence } from '../ports/feature-execution-report.js';
import { toPublicWorkSessionAttempt, toPublicWorkSessionRecord, toPublicWorkSessionEvidenceRef } from '../ports/work-session-query.js';
import { toPublicVerificationBatchRecord } from '../ports/task-evidence-query.js';
import { toPublicGitOperationRecord } from '../ports/git-operation-query.js';
import { toPublicAttemptDiagnosticRecord } from '../ports/execution-schedule-query.js';
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
    const usageSummary = {
      basis: session?.runtime === 'fake' ? 'synthetic' as const : usage?.basis ?? 'unknown' as const,
      inputTokens: usage?.inputTokens ?? attempt.usageSummary?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? attempt.usageSummary?.outputTokens ?? null,
      costMicros: usage?.costUsdMicros ?? attempt.usageSummary?.costMicros ?? null,
      currency: usage?.costUsdMicros != null ? 'USD' : attempt.usageSummary?.currency ?? null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
    if (usageSummary.inputTokens === null || usageSummary.outputTokens === null || usageSummary.costMicros === null) issues.push('usage_partial');
    // P03 has no normalized cache measurements. Do not fabricate cache rates or
    // reinterpret Fake values as billing; P04/P07 own real aggregation.
    issues.push('cache_unknown');
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
  const tasks = unique(delivery.axes.tasks.records, t => t.taskId).map(current => {
    const history = attempts.filter(a => a.taskId === current.taskId).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id, 'en'));
    const counts: Record<AttemptStatus, number> = { preparing: 0, executing: 0, verifying: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0 };
    for (const attempt of history) counts[attempt.status]++;
    return { current, latestAttempt: history.at(-1) ?? null,
      cumulative: { attempts: history.length, byStatus: counts, reworks: history.filter(a => a.rework !== null).length }, attempts: history };
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
    tasks, sessions,
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
