/**
 * P07-4 / F-001 结果诊断纯重建（application 层）。
 *
 * 不变量：
 * - 输入是 ResultDiagnosticsQueryReadStore 在单一一致读事务内组装的行与
 *   已按不可变快照核验过的结果证据正文；本模块不读时钟、不触存储、不改
 *   任何领域实体；
 * - 用量复用 usage-normalization 归一化与聚合：每个 Attempt 至多一条终值
 *   观察（kind='attempt', final），页级聚合只由本页 Attempt 观察各计一次
 *   组成，绝不叠加 Session 明细或父级汇总；未知 Token 维度保持 null，
 *   部分覆盖显式标注（coverage）；
 * - 三轴（runtime / task / feature）各自独立投影；Runtime 成功不推导
 *   Task 验收，Task 通过不推导 Feature 交付；
 * - 结果证据缺失/损坏/身份不匹配只产生结构化 issue
 *   （result_evidence_missing / result_evidence_invalid），绝不伪造空正文、
 *   零 Token 或 complete 记录。
 */
import { normalizeRuntimeUsage, aggregateUsage } from './usage-normalization.js';
import type { NormalizedUsageObservation } from './usage-normalization.js';
import type { RuntimeUsageReport } from '../ports/runtime-execution.js';
import type { UsageDiagnosticIdentity, UsageCoverage } from '../ports/usage-diagnostics.js';
import type { PublicWorkSessionResultEvidence } from '../ports/work-session-query.js';
import { deriveWorkSessionQueryState } from '../ports/work-session-query.js';
import {
  deriveResultPendingActions,
  deriveResultBlockReasons,
  type PublicResultDiagnosticRecord,
  type PublicResultPageUsage,
  type PublicResultUsageSummary,
  type ResultDiagnosticsRow,
} from '../ports/result-diagnostics-query.js';

export interface ResultEvidenceResolution {
  readonly evidence: PublicWorkSessionResultEvidence | null;
  readonly issue: 'result_evidence_missing' | 'result_evidence_invalid' | null;
}

/** 复用 Feature 报告的观察身份规则：Attempt 终值观察，recovery 原样携带。 */
function usageIdentity(row: ResultDiagnosticsRow, evidence: PublicWorkSessionResultEvidence | null): UsageDiagnosticIdentity {
  return {
    runtime: row.session?.runtime ?? 'unknown',
    provider: evidence?.routing?.selected?.provider ?? 'unknown',
    model: evidence?.routing?.selected?.model ?? null,
    attemptId: row.attempt.id,
    sessionId: row.session?.id ?? row.attempt.id,
    invocationId: row.attempt.invocationId ?? row.attempt.id,
    requestId: null,
    messageId: null,
    eventId: null,
    providerSessionId: null,
    providerRequestId: null,
    recovery: row.attempt.inputSnapshot.recovery == null ? 'new' : 'resume',
  };
}

const usageCoverageOf = (usage: RuntimeUsageReport | null | undefined, fallback: UsageCoverage): UsageCoverage =>
  usage?.coverage ?? (usage?.completeness === 'complete' ? 'reported' : usage?.completeness === 'partial' ? 'partial' : fallback);

/** 单条公开记录构建结果（纯函数）。 */
export interface BuiltResultDiagnostic {
  readonly record: PublicResultDiagnosticRecord;
  /** 参与 页级聚合的已归一化 Attempt 终值观察；无可用用量时为 null。 */
  readonly normalized: NormalizedUsageObservation | null;
}

export function buildResultDiagnosticRecord(
  row: ResultDiagnosticsRow,
  resolution: ResultEvidenceResolution,
): BuiltResultDiagnostic {
  const { attempt, session } = row;
  const evidence = resolution.evidence;
  const result = evidence?.result ?? null;
  const usage: RuntimeUsageReport | null = result?.usage ?? null;
  const issues: string[] = [];
  if (resolution.issue) issues.push(resolution.issue);
  if (session === null) issues.push('session_missing');
  if (attempt.startedAtUtcMs === null || attempt.endedAtUtcMs === null || attempt.durationMs === null) issues.push('attempt_timing_partial');
  if (attempt.exitCode === null && result?.exitCode == null) issues.push('exit_code_unknown');
  if (evidence == null) issues.push('runtime_result_unknown');
  if (row.diagnosticsTruncated) issues.push('diagnostics_truncated');
  if (row.stopOperationsTruncated) issues.push('stop_operations_truncated');
  if (row.verificationChecksTruncated) issues.push('verification_checks_truncated');
  if (row.gitOperationsTruncated) issues.push('git_operations_truncated');
  if (row.evidenceTruncated) issues.push('evidence_index_truncated');

  const identity = usageIdentity(row, evidence);
  let normalized: NormalizedUsageObservation | null = null;
  if (usage !== null) {
    normalized = normalizeRuntimeUsage({
      identity,
      usage,
      kind: 'attempt',
      final: true,
      sourceRefs: (usage.sourceRefs ?? []).map(ref => ({ kind: 'runtime_result' as const, ref, observedAtUtc: null })),
    });
  }
  const fallbackSummary = attempt.usageSummary;
  const fallbackUnknown = fallbackSummary === null ||
    [fallbackSummary.inputTokens, fallbackSummary.outputTokens, fallbackSummary.costMicros].every(value => value === null);
  const aggregate = normalized === null ? null : aggregateUsage([normalized]);
  const usageSummary: PublicResultUsageSummary = {
    basis: usage === null
      ? (fallbackUnknown ? 'unknown' : session?.runtime === 'fake' ? 'synthetic' : 'reported')
      : usage.basis,
    coverage: usage === null
      ? usageCoverageOf(null, fallbackUnknown ? 'unknown' : 'partial')
      : aggregate?.coverage ?? usageCoverageOf(usage, 'unknown'),
    inputTokens: aggregate?.totals.inputTokens ?? usage?.inputTokens ?? fallbackSummary?.inputTokens ?? null,
    outputTokens: aggregate?.totals.outputTokens ?? usage?.outputTokens ?? fallbackSummary?.outputTokens ?? null,
    cacheReadTokens: aggregate?.totals.cacheReadTokens ?? null,
    cacheWriteTokens: aggregate?.totals.cacheWriteTokens ?? null,
    costMicros: aggregate?.totals.costUsdMicros ?? usage?.costUsdMicros ?? fallbackSummary?.costMicros ?? null,
    currency: usage?.costUsdMicros != null ? 'USD' : fallbackSummary?.currency ?? null,
  };
  if (usageSummary.inputTokens === null || usageSummary.outputTokens === null) issues.push('usage_partial');
  if (usage === null || usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined ||
    usage.cacheReadIncludedInInput === undefined || usage.cacheWriteIncludedInInput === undefined) issues.push('cache_unknown');

  const recording = evidence === null ? null : {
    complete: evidence.recording.complete,
    manifestRef: evidence.recording.manifestRef,
    failure: evidence.recording.failure,
    gaps: [...evidence.recording.gaps],
    watermark: evidence.recording.watermark,
  };
  if (recording !== null && (!recording.complete || recording.gaps.length > 0)) issues.push('recording_partial');

  const rework = attempt.inputSnapshot.rework;
  const recovery = attempt.inputSnapshot.recovery;
  const stopStatuses = row.stopOperations.map(stop => stop.status);
  const worstStop = stopStatuses.includes('uncertain') ? 'uncertain' as const
    : stopStatuses.includes('stopping') ? 'stopping' as const
    : stopStatuses.includes('stopped') ? 'stopped' as const
    : null;
  const verification = row.verification === null ? null : {
    batchId: row.verification.batchId,
    operation: row.verification.operation,
    status: row.verification.status,
    endedAt: row.verification.endedAtUtcMs === null ? null : new Date(row.verification.endedAtUtcMs).toISOString(),
    checks: row.verification.checks.map(check => ({ checkKey: check.checkKey, status: check.status, outputArtifactId: check.outputArtifactId })),
  };
  const record: PublicResultDiagnosticRecord = {
    attemptId: attempt.id,
    number: attempt.number,
    taskId: attempt.taskId,
    featureId: attempt.featureId,
    runId: attempt.runId,
    batchId: row.run.batchId,
    executionStage: attempt.executionStage,
    rework: rework == null ? null : { previousAttemptId: rework.previousAttemptId },
    recovery: recovery == null ? null : { sourceAttemptId: recovery.sourceAttemptId, selection: recovery.selection.mode },
    runtime: {
      attemptStatus: attempt.status,
      state: deriveWorkSessionQueryState(attempt, session),
      sessionStatus: session?.status ?? null,
      resultKnown: evidence != null,
      exitCode: attempt.exitCode ?? result?.exitCode ?? null,
      startedAt: attempt.startedAtUtcMs === null ? null : new Date(attempt.startedAtUtcMs).toISOString(),
      endedAt: attempt.endedAtUtcMs === null ? null : new Date(attempt.endedAtUtcMs).toISOString(),
      durationMs: attempt.durationMs,
    },
    task: {
      taskStatus: row.plan.taskStatus,
      manualBlockPending: row.plan.manualBlockPending,
      verification,
    },
    feature: {
      featureStatus: row.plan.featureStatus,
      deliveryStatus: row.plan.featureDeliveryStatus,
    },
    blockReasons: deriveResultBlockReasons(row.run.runReason, row.stopOperations, row.diagnostics, row.plan.manualBlockPending),
    pendingActions: deriveResultPendingActions({
      attemptStatus: attempt.status,
      executionState: deriveWorkSessionQueryState(attempt, session),
      runStatus: row.run.runStatus,
      stopStatus: worstStop,
      manualBlockPending: row.plan.manualBlockPending,
      taskStatus: row.plan.taskStatus,
      featureStatus: row.plan.featureStatus,
      featureDeliveryStatus: row.plan.featureDeliveryStatus,
    }),
    codeRef: attempt.codeRef,
    diagnosticRef: attempt.diagnosticRef,
    resultArtifactId: session?.resultRef ?? null,
    checkRefs: verification === null ? [] : [{ batchId: verification.batchId, operation: verification.operation, status: verification.status, endedAt: verification.endedAt }],
    gitOperationRefs: row.gitOperations.map(op => ({ ...op })),
    recording,
    usage: usageSummary,
    issues: [...new Set(issues)].sort(),
  };
  return { record, normalized };
}

/** 页级用量聚合：仅由本页各 Attempt 终值观察各计一次（不叠加父级汇总）。 */
export function buildResultPageUsage(
  observations: readonly (NormalizedUsageObservation | null)[],
): PublicResultPageUsage {
  const counted = observations.filter((item): item is NormalizedUsageObservation => item !== null);
  // 直接对已归一化观察聚合（观察已按 Attempt 终值去重），保持与投影同一去重键。
  const aggregate = aggregateUsage(counted);
  return {
    basis: aggregate.basis,
    coverage: aggregate.coverage,
    accounting: aggregate.accounting,
    countedObservations: aggregate.countedObservations,
    inputTokens: aggregate.totals.inputTokens,
    outputTokens: aggregate.totals.outputTokens,
    cacheReadTokens: aggregate.totals.cacheReadTokens,
    cacheWriteTokens: aggregate.totals.cacheWriteTokens,
    costMicros: aggregate.totals.costUsdMicros,
    diagnostics: [...aggregate.diagnostics],
  };
}
