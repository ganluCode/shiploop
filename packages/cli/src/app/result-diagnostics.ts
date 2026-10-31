/**
 * P07-4 / F-003 结果诊断 CLI 投影（纯面层；无 I/O）。
 *
 * 将 execution.result.diagnostics.list 的结构化查询结果投影为文本输出
 * （JSON 信封直接携带查询结果原文，保留 null、缺口和各结果轴）：
 * - 文本清楚展示停止/阻塞原因（blockReasons，仅持久事实）与需授权用户处理的
 *   动作（pendingActions，冻结词汇）；三轴 runtime/task/feature 分行展示，
 *   Runtime 完成 ≠ Task 验收 ≠ Feature 交付，不互相折算；
 * - 未知指标输出 unknown（不以 0 冒充）；引用只展示稳定身份（artifactId/批次
 *   ID/操作 ID），不出现 locator、数据根或内部路径；
 * - 用量标注 basis/coverage/accounting；recorder 与 settlement 两轴并列，
 *   coverage=complete 不折算为 Task/Feature 验收通过。
 */
import type { HostClient } from 'shiploop-host';

type ResultDiagnosticsListResult = Awaited<ReturnType<HostClient['listResultDiagnostics']>>;
export type ResultDiagnosticsRecord = ResultDiagnosticsListResult['records'][number];
export type ResultDiagnosticsParentView = ResultDiagnosticsListResult['parent'];

export const RESULT_DIAGNOSTICS_VIEW_NOTE =
  '三轴互不折算：Runtime 完成 ≠ Task 验收（独立验证批次事实）≠ Feature 交付；' +
  'blockReasons 只来自持久事实，pendingActions 是冻结派生词汇（需授权用户处理）；' +
  '未知指标保持 null/unknown，不以 0 冒充；查询只读：不启动 Runtime、不改业务状态。';

function known(value: number | string | boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

function none(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(',');
}

export interface ResultDiagnosticsDisplay {
  readonly operation: 'execution.result.diagnostics.list';
  readonly parent: ResultDiagnosticsParentView;
  readonly parentFacts: ResultDiagnosticsListResult['parentFacts'];
  readonly records: readonly ResultDiagnosticsRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly eventWatermark: number;
  readonly usage: ResultDiagnosticsListResult['usage'];
  readonly note: string;
}

export function buildResultDiagnosticsView(result: ResultDiagnosticsListResult): ResultDiagnosticsDisplay {
  return {
    operation: 'execution.result.diagnostics.list',
    parent: result.parent,
    parentFacts: result.parentFacts,
    records: result.records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    eventWatermark: result.eventWatermark,
    usage: result.usage,
    note: RESULT_DIAGNOSTICS_VIEW_NOTE,
  };
}

function formatScope(facts: ResultDiagnosticsDisplay['parentFacts']): string {
  switch (facts.kind) {
    case 'batch':
      return `kind=batch batch=${facts.batchId} status=${facts.batchStatus}`;
    case 'run':
      return `kind=run run=${facts.runId} batch=${facts.batchId} status=${facts.runStatus} reason=${facts.runReason ?? 'none'}`;
    case 'attempt':
      return `kind=attempt attempt=${facts.attemptId} run=${facts.runId} batch=${facts.batchId}`;
    default:
      return `kind=session session=${facts.sessionId} attempt=${facts.attemptId} run=${facts.runId} batch=${facts.batchId}`;
  }
}

function formatRecord(row: ResultDiagnosticsRecord): string {
  const lines = [
    `  attempt=${row.attemptId}#${row.number} task=${row.taskId} feature=${row.featureId} ` +
      `run=${row.runId} batch=${row.batchId} stage=${row.executionStage} ` +
      `rework=${row.rework === null ? 'none' : row.rework.previousAttemptId} ` +
      `recovery=${row.recovery === null ? 'none' : `${row.recovery.selection}(${known(row.recovery.sourceAttemptId)})`}`,
    `    runtime: status=${row.runtime.attemptStatus} state=${row.runtime.state} ` +
      `session=${known(row.runtime.sessionStatus)} resultKnown=${row.runtime.resultKnown} ` +
      `exit=${known(row.runtime.exitCode)} start=${known(row.runtime.startedAt)} ` +
      `end=${known(row.runtime.endedAt)} durationMs=${known(row.runtime.durationMs)}`,
    `    task: status=${row.task.taskStatus} manualBlockPending=${row.task.manualBlockPending} ` +
      `verification=${row.task.verification === null
        ? 'none'
        : `${row.task.verification.batchId}(${row.task.verification.operation},${row.task.verification.status},ended=${known(row.task.verification.endedAt)})`}` +
      ` checks=${row.task.verification === null ? 0 : row.task.verification.checks.length}`,
    `    feature: status=${row.feature.featureStatus} delivery=${row.feature.deliveryStatus}`,
    `    stop/block: reasons=${none(row.blockReasons)} actions=${none(row.pendingActions)}`,
    `    refs: code=${known(row.codeRef)} diag=${known(row.diagnosticRef)} ` +
      `result=${known(row.resultArtifactId)} evidence=${known(row.resultEvidenceRef)} ` +
      `checkRefs=${row.checkRefs.length} gitOps=${row.gitOperationRefs.length === 0
        ? 'none'
        : row.gitOperationRefs.map(op => `${op.operationId}(${op.operationType},${op.status})`).join(',')}`,
    `    recording: ${row.recording === null
      ? 'none（无结果证据）'
      : `complete=${row.recording.complete} manifestRef=${known(row.recording.manifestRef)} ` +
        `failure=${row.recording.failure ?? 'none'} gaps=${none(row.recording.gaps)} watermark=${known(row.recording.watermark)}`}`,
    `    recorder: ${row.recorder === null
      ? 'none（无 Work Session 记录）'
      : `sessions=${row.recorder.sessions.length} truncated=${row.recorder.truncated}`}`,
    `    usage: basis=${row.usage.basis} coverage=${row.usage.coverage} input=${known(row.usage.inputTokens)} ` +
      `output=${known(row.usage.outputTokens)} cacheRead=${known(row.usage.cacheReadTokens)} ` +
      `cacheWrite=${known(row.usage.cacheWriteTokens)} costMicros=${known(row.usage.costMicros)} ` +
      `currency=${known(row.usage.currency)}`,
    `    issues: ${none(row.issues)}`,
  ];
  return lines.join('\n');
}

export function formatResultDiagnosticsView(view: ResultDiagnosticsDisplay): string {
  const parentEntry = Object.entries(view.parent).find(([key]) => key !== 'kind')!;
  const lines = [
    `shiploop execution result-diagnostics: ${parentEntry[0]}=${parentEntry[1]} ` +
      `records=${view.records.length} nextCursor=${view.nextCursor ?? 'none'} limit=${view.limit} ` +
      `eventWatermark=${view.eventWatermark}`,
    `  scope: ${formatScope(view.parentFacts)}`,
    `  usage(page): basis=${view.usage.basis} coverage=${view.usage.coverage} accounting=${view.usage.accounting} ` +
      `counted=${view.usage.countedObservations} input=${known(view.usage.inputTokens)} output=${known(view.usage.outputTokens)} ` +
      `cacheRead=${known(view.usage.cacheReadTokens)} cacheWrite=${known(view.usage.cacheWriteTokens)} ` +
      `costMicros=${known(view.usage.costMicros)} diagnostics=${none(view.usage.diagnostics)}`,
  ];
  for (const row of view.records) lines.push(formatRecord(row));
  lines.push(`  （${RESULT_DIAGNOSTICS_VIEW_NOTE}）`, '');
  return lines.join('\n');
}
