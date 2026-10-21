/**
 * P03-10 / F-006 执行报告可审阅文本视图与人工操作提示（CLI 纯视图层）。
 *
 * 纯函数模块（无 I/O）：把 HostClient 已线校验的完整 Feature 执行报告投影
 * （F-004/F-005 同一 `feature-execution-report` 投影）重新生成可审阅文本：
 * - 同一报告投影 → 完整且稳定排序的 Task 表与 Attempt 历史；Task 行区分
 *   最新状态（latest）与累计次数（cumulative），各 Run 在 Attempt 归属与
 *   Run 记录中独立列示；不倾倒 JSON、不追加历史报告内容；
 * - 最终检查、批准/阻塞原因、要求的交付状态、证据引用与下一步显式操作单独
 *   成段；未批准但机器全绿时显示等待（waiting=true），不显示已通过，也不
 *   建议跳过人审；下一步均为人工/授权命令动作（automatic=false）；
 * - unknown/partial、Fake 合成指标（basis=fake-synthetic）、累计 Session
 *   时间与墙钟时间清晰标识；null 保持 unknown，不以 0 冒充；不生成真实模型
 *   分组收益、加权缓存率、余额或节省额度结论（真实费用聚合属后续阶段）；
 * - 纯投影：不读时钟、不写任何业务状态；相同报告重复生成语义稳定，
 *   不重复行或计数。
 */
import type { FeatureExecutionReport } from 'shiploop-host';

type ReportTask = FeatureExecutionReport['tasks'][number];
type ReportAttempt = ReportTask['attempts'][number];
type ReportSession = FeatureExecutionReport['sessions'][number];
type ReportRun = FeatureExecutionReport['runs'][number];
type ReportVerification = FeatureExecutionReport['verifications'][number];
type ReportOperation = FeatureExecutionReport['operations'][number];
type ReportEvidence = FeatureExecutionReport['evidence'][number];
type ReportNextStep = FeatureExecutionReport['outcome']['nextStep'];
type ReportUsageAggregate = FeatureExecutionReport['usage']['feature']['aggregate'];
type ReportEfficiency = FeatureExecutionReport['efficiency'];

/* ------------------------------------------------------------------ *
 * 视图形状（结构化展示投影；测试与格式化共用同一派生结果）
 * ------------------------------------------------------------------ */

export interface FeatureReportAttemptRowView {
  readonly id: string;
  readonly taskId: string;
  readonly number: number;
  readonly runId: string;
  readonly status: ReportAttempt['status'];
  readonly executionStage: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly runtimeDurationMs: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly sessionIds: readonly string[];
  readonly usage: {
    readonly basis: 'fake-synthetic' | 'reported' | 'unknown';
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costMicros: number | null;
    readonly currency: string | null;
    readonly cacheReadTokens: number | null;
    readonly cacheWriteTokens: number | null;
  };
  readonly reworkPreviousAttemptId: string | null;
  readonly recoverySourceAttemptId: string | null;
  readonly evidenceCount: number;
  readonly diagnosticsCount: number;
  readonly completeness: 'complete' | 'partial';
  readonly issues: readonly string[];
}

export interface FeatureReportTaskRowView {
  readonly taskId: string;
  readonly status: ReportTask['current']['status'];
  readonly manualBlock: boolean;
  readonly firstPassedAt: string | null;
  readonly latest: { readonly id: string; readonly number: number; readonly status: ReportAttempt['status'] } | null;
  readonly cumulative: ReportTask['cumulative'];
  readonly usage: ReportUsageAggregate | null;
  readonly timing: ReportTask['timing'];
  readonly attemptIds: readonly string[];
}

export interface FeatureReportRunRowView {
  readonly id: string;
  readonly batchId: string;
  readonly status: ReportRun['status'];
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly attemptIds: readonly string[];
}

export interface FeatureReportSessionRowView {
  readonly id: string;
  readonly attemptId: string;
  readonly parentSessionId: string | null;
  readonly runtime: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly recordingWatermark: number | null;
  readonly completeness: 'complete' | 'partial';
  readonly issues: readonly string[];
}

export interface FeatureReportVerificationView {
  readonly axisStatus: string;
  readonly finalBatchId: string | null;
  readonly batches: readonly {
    readonly id: string;
    readonly operation: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly status: string;
    readonly codeDigest: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly checks: readonly {
      readonly checkKey: string;
      readonly required: boolean;
      readonly status: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly timedOut: boolean;
    }[];
  }[];
}

export interface FeatureReportApprovalView {
  readonly status: string;
  readonly reason: string | null;
  readonly itemsTruncated: boolean;
  readonly items: readonly {
    readonly id: string;
    readonly taskId: string;
    readonly kind: string;
    readonly status: string;
    readonly responsibleParty: string;
    readonly decision: string | null;
    readonly decisionReason: string | null;
    readonly description: string;
  }[];
  /** 机器全绿（全部 Task passed 且最终检查 passed）。 */
  readonly machineAllGreen: boolean;
  /** 未获人工批准但机器全绿：显示等待，绝不判定通过或建议跳过人审。 */
  readonly waiting: boolean;
}

export interface FeatureReportDeliveryView {
  readonly requiredStatus: string;
  readonly axisStatus: string;
  readonly operation: {
    readonly operationId: string;
    readonly operationType: string;
    readonly status: string;
    readonly deliveryStatus: string | null;
    readonly reasonCode: string | null;
    readonly expectedHead: string;
    readonly candidateTree: string;
    readonly actualCommit: string | null;
    readonly actualParent: string | null;
    readonly receiptRecorded: boolean;
    readonly exitCode: number | null;
    readonly durationMs: number | null;
  } | null;
}

export interface FeatureReportNextActionView {
  readonly action: string;
  readonly detail: string;
  /** 全部为人工/授权命令动作；视图绝不暗示自动重跑编码或自动放行。 */
  readonly automatic: false;
}

export interface FeatureReportTextView {
  readonly scope: 'feature-execution-report-text';
  readonly summary: {
    readonly featureId: string;
    readonly outcome: string;
    readonly outcomeReason: string;
    readonly nextStep: string;
    readonly completeness: 'complete' | 'partial';
    readonly issues: readonly string[];
    readonly eventWatermark: number;
    readonly counts: FeatureExecutionReport['counts'];
  };
  readonly taskRows: readonly FeatureReportTaskRowView[];
  readonly attemptRows: readonly FeatureReportAttemptRowView[];
  readonly runRows: readonly FeatureReportRunRowView[];
  readonly sessionRows: readonly FeatureReportSessionRowView[];
  readonly verification: FeatureReportVerificationView;
  readonly approval: FeatureReportApprovalView;
  readonly delivery: FeatureReportDeliveryView;
  readonly evidenceRows: readonly { readonly artifactId: string; readonly availability: string }[];
  readonly timing: {
    readonly cumulativeSessionMs: number | null;
    readonly wallClockMs: number | null;
    readonly measuredSessions: number;
    readonly totalSessions: number;
    readonly completeness: 'complete' | 'partial';
  };
  readonly usage: FeatureExecutionReport['usage'];
  readonly usageDimensions: readonly FeatureExecutionReport['usage']['dimensions'][number][];
  readonly efficiency: ReportEfficiency;
  readonly metricNotes: readonly string[];
  readonly nextActions: readonly FeatureReportNextActionView[];
}

/* ------------------------------------------------------------------ *
 * 纯派生（不读时钟、不写状态；排序稳定）
 * ------------------------------------------------------------------ */

const byText = (a: string, b: string): number => a.localeCompare(b, 'en');

const NEXT_STEP_ACTIONS: Record<ReportNextStep, string> = {
  none: '无待办显式操作（已完成或需人工按证据引用核查现场）',
  continue_execution: '经授权执行命令继续既有 Task 执行循环（不自动重跑编码）',
  feature_verification_continue: '经授权命令 feature.verification.continue 显式重新请求最终收尾',
  feature_approval_decision: '责任主体经 task.approval.* 显式做出当前批准/拒绝决定',
  manual_block_resolution: '责任主体经 task.approval.unblock 显式解除当前人工阻塞',
  git_operation_reconcile: '经授权命令 git.operation.reconcile 显式核对提交事实',
  rework_authorization: '最终检查需要代码修复：先明确失效范围与返工授权（不自动新建编码会话）',
};

export const FEATURE_REPORT_METRIC_NOTES: readonly string[] = [
  '指标口径：basis=fake-synthetic 为 Fake 合成指标，basis=reported 为 Runtime 报告值；null/未知显示 unknown，不以 0 冒充',
  '缓存：cacheRead/cacheWrite=unknown（无归一化缓存测量，不计算加权缓存率）',
  '费用结论：不生成真实模型分组收益、余额或节省额度结论（真实费用聚合属后续阶段）',
];

function usageBasis(basis: ReportAttempt['usage']['basis']): FeatureReportAttemptRowView['usage']['basis'] {
  return basis === 'synthetic' ? 'fake-synthetic' : basis === 'reported' ? 'reported' : 'unknown';
}

export function buildFeatureReportTextView(report: FeatureExecutionReport): FeatureReportTextView {
  const tasks = [...report.tasks].sort((a, b) => byText(a.current.taskId, b.current.taskId));
  const usageByTask = new Map(report.usage.tasks.map((node) => [node.id, node.aggregate]));
  const attemptRows: FeatureReportAttemptRowView[] = [];
  const taskRows = tasks.map((task) => {
    const attempts = [...task.attempts].sort((a, b) => a.number - b.number || byText(a.id, b.id));
    for (const attempt of attempts) {
      attemptRows.push({
        id: attempt.id,
        taskId: attempt.taskId,
        number: attempt.number,
        runId: attempt.runId,
        status: attempt.status,
        executionStage: attempt.executionStage,
        exitCode: attempt.exitCode,
        signal: attempt.signal,
        durationMs: attempt.durationMs,
        runtimeDurationMs: attempt.runtimeDurationMs,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        sessionIds: [...attempt.sessionIds],
        usage: {
          basis: usageBasis(attempt.usage.basis),
          inputTokens: attempt.usage.inputTokens,
          outputTokens: attempt.usage.outputTokens,
          costMicros: attempt.usage.costMicros,
          currency: attempt.usage.currency,
          cacheReadTokens: attempt.usage.cacheReadTokens,
          cacheWriteTokens: attempt.usage.cacheWriteTokens,
        },
        reworkPreviousAttemptId: attempt.rework?.previousAttemptId ?? null,
        recoverySourceAttemptId: attempt.recovery?.sourceAttemptId ?? null,
        evidenceCount: attempt.evidence.length,
        diagnosticsCount: attempt.diagnostics.length,
        completeness: attempt.completeness,
        issues: [...attempt.issues],
      });
    }
    const latest = task.latestAttempt;
    return {
      taskId: task.current.taskId,
      status: task.current.status,
      manualBlock: task.current.manualBlock,
      firstPassedAt: task.current.firstPassedAt,
      latest: latest === null ? null : { id: latest.id, number: latest.number, status: latest.status },
      cumulative: {
        attempts: task.cumulative.attempts,
        byStatus: { ...task.cumulative.byStatus },
        reworks: task.cumulative.reworks,
      },
      usage: usageByTask.get(task.current.taskId) ?? null,
      timing: { ...task.timing },
      attemptIds: attempts.map((attempt) => attempt.id),
    };
  });

  const attemptIdsByRun = new Map<string, string[]>();
  for (const attempt of attemptRows) {
    const list = attemptIdsByRun.get(attempt.runId) ?? [];
    list.push(attempt.id);
    attemptIdsByRun.set(attempt.runId, list);
  }
  const runRows: FeatureReportRunRowView[] = [...report.runs]
    .sort((a, b) => byText(a.id, b.id))
    .map((run) => ({
      id: run.id,
      batchId: run.batchId,
      status: run.status,
      reason: run.reason,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      attemptIds: [...(attemptIdsByRun.get(run.id) ?? [])].sort(byText),
    }));

  const sessionRows: FeatureReportSessionRowView[] = [...report.sessions]
    .sort((a, b) => byText(a.id, b.id))
    .map((session: ReportSession) => ({
      id: session.id,
      attemptId: session.attemptId,
      parentSessionId: session.parentSessionId,
      runtime: session.runtime,
      status: session.status,
      durationMs: session.durationMs,
      recordingWatermark: session.recordingWatermark,
      completeness: session.completeness,
      issues: [...session.issues],
    }));

  const batches = [...report.verifications]
    .sort((a, b) => byText(a.id, b.id))
    .map((batch: ReportVerification) => ({
      id: batch.id,
      operation: batch.operation,
      taskId: batch.taskId,
      attemptId: batch.attemptId,
      status: batch.status,
      codeDigest: batch.codeDigest,
      startedAt: batch.startedAt,
      endedAt: batch.endedAt,
      checks: [...batch.checks]
        .sort((a, b) => byText(a.checkKey, b.checkKey) || byText(a.id, b.id))
        .map((check) => ({
          checkKey: check.checkKey,
          required: check.required,
          status: check.status,
          exitCode: check.exitCode,
          signal: check.signal,
          timedOut: check.timedOut,
        })),
    }));
  const verification: FeatureReportVerificationView = {
    axisStatus: report.axes.verification.status,
    finalBatchId: report.axes.verification.batch?.id ?? null,
    batches,
  };

  const approvalAxis = report.axes.approval;
  const machineAllGreen = report.axes.tasks.allPassed && report.axes.verification.status === 'passed';
  const approval: FeatureReportApprovalView = {
    status: approvalAxis.status,
    reason: approvalAxis.reason,
    itemsTruncated: approvalAxis.itemsTruncated,
    items: [...approvalAxis.items]
      .sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id))
      .map((item) => ({
        id: item.id,
        taskId: item.taskId,
        kind: item.kind,
        status: item.status,
        responsibleParty: item.responsibleParty,
        decision: item.decision,
        decisionReason: item.decisionReason,
        description: boundedSummary(item.description),
      })),
    machineAllGreen,
    waiting: machineAllGreen && approvalAxis.status !== 'approved',
  };

  const deliveryOperation = report.axes.delivery.operation;
  const delivery: FeatureReportDeliveryView = {
    requiredStatus: report.feature.deliveryStatus,
    axisStatus: report.axes.delivery.status,
    operation: deliveryOperation === null ? null : {
      operationId: deliveryOperation.operationId,
      operationType: deliveryOperation.operationType,
      status: deliveryOperation.status,
      deliveryStatus: deliveryOperation.deliveryStatus,
      reasonCode: deliveryOperation.reasonCode,
      expectedHead: deliveryOperation.expectedHead,
      candidateTree: deliveryOperation.candidateTree,
      actualCommit: deliveryOperation.actualCommit,
      actualParent: deliveryOperation.actualParent,
      receiptRecorded: deliveryOperation.receipt !== null,
      exitCode: deliveryOperation.exitCode,
      durationMs: deliveryOperation.durationMs,
    },
  };

  const evidenceRows = [...report.evidence]
    .sort((a, b) => byText(a.artifactId, b.artifactId))
    .map((ref: ReportEvidence) => ({ artifactId: ref.artifactId, availability: ref.availability }));

  return {
    scope: 'feature-execution-report-text',
    summary: {
      featureId: report.feature.featureId,
      outcome: report.outcome.status,
      outcomeReason: report.outcome.reason,
      nextStep: report.outcome.nextStep,
      completeness: report.completeness,
      issues: [...report.issues],
      eventWatermark: report.consistency.eventWatermark,
      counts: { ...report.counts },
    },
    taskRows,
    attemptRows,
    runRows,
    sessionRows,
    verification,
    approval,
    delivery,
    evidenceRows,
    timing: {
      cumulativeSessionMs: report.timing.cumulativeSessionMs,
      wallClockMs: report.timing.wallClockMs,
      measuredSessions: report.timing.measuredSessions,
      totalSessions: report.timing.totalSessions,
      completeness: report.timing.completeness,
    },
    usage: report.usage,
    usageDimensions: [...report.usage.dimensions].sort((a, b) => byText(a.key, b.key)),
    efficiency: report.efficiency,
    metricNotes: FEATURE_REPORT_METRIC_NOTES,
    nextActions: [{
      action: report.outcome.nextStep,
      detail: NEXT_STEP_ACTIONS[report.outcome.nextStep],
      automatic: false,
    }],
  };
}

/* ------------------------------------------------------------------ *
 * 文本格式化（稳定行序；仅展示视图字段）
 * ------------------------------------------------------------------ */

function cell(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
}

function boundedSummary(value: string, max = 240): string {
  const clean = cell(value);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function unknown(value: string | number | null): string {
  return value === null ? 'unknown' : String(value);
}

function none(value: string | null): string {
  return value === null ? 'none' : value;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(',');
}

export function formatFeatureReportTextView(view: FeatureReportTextView): string {
  const lines: string[] = [];
  const summary = view.summary;
  lines.push('# ShipLoop Feature 执行报告文本视图（由同一报告投影生成，不追加历史报告内容）');
  lines.push(
    `feature=${summary.featureId} outcome=${summary.outcome} ` +
      `completeness=${summary.completeness} issues=${list([...summary.issues].sort(byText))}`,
  );
  lines.push(`outcomeReason=${summary.outcomeReason} nextStep=${summary.nextStep}`);
  lines.push(
    `consistency mode=single-read-transaction eventWatermark=${summary.eventWatermark}` +
      '（水位引用，不是原生存储版本）',
  );
  lines.push(
    `counts tasks=${summary.counts.tasks} runs=${summary.counts.runs} attempts=${summary.counts.attempts} ` +
      `sessions=${summary.counts.sessions} operations=${summary.counts.operations}`,
  );

  lines.push('');
  lines.push(
    `## Task 表（稳定排序 ${view.taskRows.length} 项；latest=最新 Attempt，cumulative=累计次数，各 Run 归属见 Attempt 历史）`,
  );
  lines.push(
    '| Task | status | manualBlock | latestAttempt | latestStatus | attempts | succeeded | failed | cancelled | ' +
      'interrupted | preparing | executing | verifying | reworks | firstPassedAt |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of view.taskRows) {
    lines.push(
      `| ${cell(row.taskId)} | ${row.status} | ${String(row.manualBlock)} | ${none(row.latest?.id ?? null)} | ` +
        `${row.latest === null ? 'unknown' : row.latest.status} | ${row.cumulative.attempts} | ` +
        `${row.cumulative.byStatus.succeeded} | ${row.cumulative.byStatus.failed} | ${row.cumulative.byStatus.cancelled} | ` +
        `${row.cumulative.byStatus.interrupted} | ${row.cumulative.byStatus.preparing} | ` +
        `${row.cumulative.byStatus.executing} | ${row.cumulative.byStatus.verifying} | ${row.cumulative.reworks} | ` +
        `${unknown(row.firstPassedAt)} |`,
    );
  }

  lines.push('');
  lines.push('## Attempt 历史（按 Task 分组，number/id 稳定排序；unknown=未知，不以 0 冒充）');
  for (const row of view.taskRows) {
    lines.push(`### ${cell(row.taskId)}（${row.attemptIds.length}）`);
    for (const attempt of view.attemptRows.filter((a) => a.taskId === row.taskId)) {
      lines.push(
        `- #${attempt.number} ${attempt.id} run=${attempt.runId} status=${attempt.status} ` +
          `stage=${attempt.executionStage} exitCode=${unknown(attempt.exitCode)} signal=${unknown(attempt.signal)} ` +
          `durationMs=${unknown(attempt.durationMs)} runtimeDurationMs=${unknown(attempt.runtimeDurationMs)} ` +
          `startedAt=${unknown(attempt.startedAt)} endedAt=${unknown(attempt.endedAt)} ` +
          `sessions=[${list([...attempt.sessionIds].sort(byText))}] ` +
          `rework=${none(attempt.reworkPreviousAttemptId)} recovery=${none(attempt.recoverySourceAttemptId)} ` +
          `evidence=${attempt.evidenceCount} diagnostics=${attempt.diagnosticsCount} ` +
          `completeness=${attempt.completeness} issues=${list([...attempt.issues].sort(byText))}`,
      );
      lines.push(
        `  usage basis=${attempt.usage.basis} inputTokens=${unknown(attempt.usage.inputTokens)} ` +
          `outputTokens=${unknown(attempt.usage.outputTokens)} costMicros=${unknown(attempt.usage.costMicros)} ` +
          `currency=${unknown(attempt.usage.currency)} cacheRead=${unknown(attempt.usage.cacheReadTokens)} ` +
          `cacheWrite=${unknown(attempt.usage.cacheWriteTokens)}`,
      );
    }
  }

  lines.push('');
  lines.push('## 用量诊断（Core 归一化投影；文本层不重新计算）');
  const usageLine = (scope: string, id: string, aggregate: ReportUsageAggregate): string =>
    `- ${scope}=${id} basis=${aggregate.basis} coverage=${aggregate.coverage} accounting=${aggregate.accounting} ` +
    `normalization=${aggregate.normalization} inputTokens=${unknown(aggregate.totals.inputTokens)} ` +
    `outputTokens=${unknown(aggregate.totals.outputTokens)} cacheRead=${unknown(aggregate.totals.cacheReadTokens)} ` +
    `cacheWrite=${unknown(aggregate.totals.cacheWriteTokens)} reasoning=${unknown(aggregate.totals.reasoningTokens)} ` +
    `providerTotal=${unknown(aggregate.totals.providerTotalTokens)} costMicros=${unknown(aggregate.totals.costUsdMicros)} ` +
    `cacheRate=${unknown(aggregate.cache.rate)} cacheReason=${aggregate.cache.reason} ` +
    `observations=${aggregate.countedObservations} diagnostics=${list([...aggregate.diagnostics].sort(byText))} ` +
    `sourceRefs=${list([...aggregate.sourceRefs].map((source) => source.ref).sort(byText))}`;
  lines.push(usageLine('feature', summary.featureId, view.usage.feature.aggregate));
  for (const task of view.taskRows) {
    if (task.usage !== null) lines.push(usageLine('task', task.taskId, task.usage));
    else lines.push(`- task=${task.taskId} usage=unknown coverage=unknown`);
    lines.push(`  taskTiming cumulativeMs=${unknown(task.timing.cumulativeMs)} wallClockMs=${unknown(task.timing.wallClockMs)} completeness=${task.timing.completeness}`);
  }
  for (const attempt of [...view.usage.attempts].sort((a, b) => byText(a.id, b.id))) {
    lines.push(usageLine('attempt', attempt.id, attempt.aggregate));
  }
  const attemptUsage = [...view.usageDimensions]
    .filter((dimension) => dimension.key.split('|').length === 1)
    .sort((a, b) => byText(a.key, b.key));
  for (const dimension of attemptUsage) lines.push(usageLine('dimension', dimension.key, dimension.aggregate));
  for (const dimension of view.usageDimensions.filter((item) => item.key.split('|').length === 3)) {
    lines.push(`- model runtime=${cell(dimension.runtime)} provider=${cell(dimension.provider)} model=${cell(dimension.model)} ` +
      `basis=${dimension.aggregate.basis} coverage=${dimension.aggregate.coverage} inputTokens=${unknown(dimension.aggregate.totals.inputTokens)} ` +
      `outputTokens=${unknown(dimension.aggregate.totals.outputTokens)} cacheRate=${unknown(dimension.aggregate.cache.rate)} ` +
      `calls=${dimension.calls} sessions=${dimension.sessions} cumulativeDurationMs=${unknown(dimension.cumulativeDurationMs)} ` +
      `wallClockDurationMs=${unknown(dimension.wallClockDurationMs)} sourceRefs=${list([...dimension.aggregate.sourceRefs].map((source) => source.ref).sort(byText))}`);
  }

  lines.push('');
  lines.push('## 效率与耗时分解（Core 事实投影；running 不是实时进程探测）');
  lines.push(`- modelRequestTimingBasis=${view.efficiency.modelRequestTimingBasis} coverage=${view.efficiency.coverage} ` +
    `issues=${list([...view.efficiency.issues].sort(byText))}`);
  for (const kind of Object.keys(view.efficiency.stages).sort(byText) as Array<keyof ReportEfficiency['stages']>) {
    const stage = view.efficiency.stages[kind];
    lines.push(`- stage=${kind} cumulativeMs=${unknown(stage.cumulativeMs)} activeWallClockMs=${unknown(stage.activeWallClockMs)} ` +
      `wallClockSpanMs=${unknown(stage.wallClockSpanMs)} measuredFacts=${stage.measuredFacts}/${stage.totalFacts} coverage=${stage.coverage}`);
  }
  for (const fact of [...view.efficiency.facts].sort((a, b) => byText(a.factId, b.factId))) {
    lines.push(`- fact=${fact.factId} kind=${fact.kind} lifecycle=${fact.lifecycleStatus} outcome=${fact.outcome} ` +
      `durationMs=${unknown(fact.durationMs)} reportedDurationMs=${unknown(fact.reportedDurationMs)} ` +
      `processLiveness=${fact.processLiveness} exitCode=${unknown(fact.exitCode)} budgetMs=${unknown(fact.budgetMs)} ` +
      `coverage=${fact.coverage} reason=${unknown(fact.unknownReason)} issues=${list([...fact.issues].sort(byText))} ` +
      `sourceRefs=${list([...fact.sourceRefs].map((source) => source.ref).sort(byText))}`);
  }
  for (const [name, metric] of Object.entries(view.efficiency.metrics).sort(([a], [b]) => byText(a, b))) {
    lines.push(`- metric=${name} value=${unknown(metric.value)} coverage=${metric.coverage} sourceRefs=${list([...metric.sourceRefs].sort(byText))}`);
  }
  lines.push(`- context basis=${view.efficiency.context.basis} first=${unknown(view.efficiency.context.first)} ` +
    `peak=${unknown(view.efficiency.context.peak)} last=${unknown(view.efficiency.context.last)} coverage=${view.efficiency.context.coverage} ` +
    `sourceRefs=${list([...view.efficiency.context.sourceRefs].sort(byText))}`);

  lines.push('');
  lines.push('## Run 记录（各 Run 独立列示，不合并历史计数）');
  for (const run of view.runRows) {
    lines.push(
      `- run ${run.id} batch=${run.batchId} status=${run.status} reason=${none(run.reason)} ` +
        `startedAt=${unknown(run.startedAt)} endedAt=${unknown(run.endedAt)} ` +
        `attempts=${run.attemptIds.length} attemptIds=[${list(run.attemptIds)}]`,
    );
  }

  lines.push('');
  lines.push('## Session 记录（稳定排序；unknown=边界缺失，durationMs 不以 0 冒充）');
  for (const session of view.sessionRows) {
    lines.push(
      `- ${session.id} attempt=${session.attemptId} parent=${none(session.parentSessionId)} ` +
        `runtime=${session.runtime} status=${session.status} durationMs=${unknown(session.durationMs)} ` +
        `watermark=${unknown(session.recordingWatermark)} completeness=${session.completeness} ` +
        `issues=${list([...session.issues].sort(byText))}`,
    );
  }

  lines.push('');
  lines.push('## 最终检查（机器检查轴；机器结果不构成人工批准）');
  lines.push(`- axis status=${view.verification.axisStatus} batch=${none(view.verification.finalBatchId)}`);
  for (const batch of view.verification.batches) {
    lines.push(
      `- batch ${batch.id} operation=${batch.operation} task=${batch.taskId} attempt=${batch.attemptId} ` +
        `status=${batch.status} codeDigest=${batch.codeDigest} startedAt=${unknown(batch.startedAt)} ` +
        `endedAt=${unknown(batch.endedAt)}`,
    );
    for (const check of batch.checks) {
      lines.push(
        `  - check ${check.checkKey} required=${String(check.required)} status=${check.status} ` +
          `exitCode=${unknown(check.exitCode)} signal=${unknown(check.signal)} timedOut=${String(check.timedOut)}`,
      );
    }
  }

  lines.push('');
  lines.push('## 人工批准/阻塞（仅责任人显式决定；机器结果不构成批准）');
  lines.push(
    `approval status=${view.approval.status} reason=${none(view.approval.reason)} ` +
      `items=${view.approval.items.length} truncated=${String(view.approval.itemsTruncated)} ` +
      `waiting=${String(view.approval.waiting)} machineAllGreen=${String(view.approval.machineAllGreen)}`,
  );
  for (const item of view.approval.items) {
    lines.push(
      `- item ${item.id} task=${item.taskId} kind=${item.kind} status=${item.status} ` +
        `responsible=${item.responsibleParty} decision=${none(item.decision)} ` +
        `decisionReason=${none(item.decisionReason)} description=${cell(item.description)}`,
    );
  }
  if (view.approval.waiting) {
    lines.push('（等待）机器全绿不构成人工批准：保持等待，仅责任人显式决定可生效');
  }

  lines.push('');
  lines.push('## 要求的交付状态');
  lines.push(`requiredStatus=${view.delivery.requiredStatus} axisStatus=${view.delivery.axisStatus}`);
  const operation = view.delivery.operation;
  if (operation === null) {
    lines.push('- operation none');
  } else {
    lines.push(
      `- operation ${operation.operationId} type=${operation.operationType} status=${operation.status} ` +
        `deliveryStatus=${unknown(operation.deliveryStatus)} reasonCode=${none(operation.reasonCode)} ` +
        `expectedHead=${operation.expectedHead} candidateTree=${operation.candidateTree} ` +
        `actualCommit=${unknown(operation.actualCommit)} actualParent=${unknown(operation.actualParent)} ` +
        `receipt=${operation.receiptRecorded ? 'recorded' : 'none'} exitCode=${unknown(operation.exitCode)} ` +
        `durationMs=${unknown(operation.durationMs)}`,
    );
  }

  lines.push('');
  lines.push('## 证据引用（仅稳定身份与可用性；不含正文或路径）');
  for (const ref of view.evidenceRows) {
    lines.push(`- ${ref.artifactId} availability=${ref.availability}`);
  }

  lines.push('');
  lines.push('## 时间与指标标识');
  lines.push(`- cumulativeSessionMs=${unknown(view.timing.cumulativeSessionMs)}（累计 Session 时间，含重叠 Session）`);
  lines.push(`- wallClockMs=${unknown(view.timing.wallClockMs)}（墙钟时间，Session 首末边界；边界缺失为 unknown）`);
  lines.push(
    `- sessions measured=${view.timing.measuredSessions}/${view.timing.totalSessions} ` +
      `timingCompleteness=${view.timing.completeness}`,
  );
  for (const note of view.metricNotes) {
    lines.push(`- ${note}`);
  }

  lines.push('');
  lines.push('## 下一步显式操作（人工/授权命令动作；本视图只读，不执行任何操作）');
  lines.push(`nextStep=${view.summary.nextStep}`);
  for (const action of view.nextActions) {
    lines.push(`- ${action.action}：${action.detail}（automatic=false）`);
  }
  return `${lines.join('\n')}\n`;
}
