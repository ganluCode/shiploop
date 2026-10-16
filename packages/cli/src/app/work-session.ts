/**
 * P03-6 / F-013 Work Session 状态、Runtime 结果与取消接受 CLI 纯视图层
 *（结构化输出与人类行）。
 *
 * 纯函数模块（无 I/O）：把 HostClient 已线校验的实际 Host 公共契约结果
 * （execution.sessions.list / execution.session.get / execution.session.evidence.get
 * / execution.attempt.cancel 回执）投影为 CLI 结构化输出：
 * - 输出显示 Run/Task/Attempt/Session、实际 Runtime、执行阶段、错误原因、
 *   停止状态、覆盖缺口（recording gaps/watermark）与制品引用；
 * - accepted、cancel accepted、Runtime completed、stopped confirmed 与
 *   Task/Feature 验收分别表达，互不折算：取消接受不是停止确认，执行完成不是
 *   验收通过；未装配 Verifier 时明确等待验证能力（verifierAssembled=false）；
 * - Synthetic 用量显式标记 basis=synthetic，不展示为真实消费
 *   （realConsumption 恒 false）；缺失的退出码/耗时/用量保持 null（不填零）；
 * - 人类行只输出脱敏事实字段；不打印正文秘密、凭据或开发机路径。
 */
import type { HostClient } from 'shiploop-host';

type WorkSessionListResult = Awaited<ReturnType<HostClient['listWorkSessions']>>;
type WorkSessionDetailResult = Awaited<ReturnType<HostClient['getWorkSession']>>;
type WorkSessionEvidenceContent = Awaited<ReturnType<HostClient['readWorkSessionEvidence']>>;

export type WorkSessionSummary = WorkSessionListResult['records'][number];
export type WorkSessionAttempt = WorkSessionDetailResult['attempt'];
export type WorkSessionRecord = Exclude<WorkSessionDetailResult['session'], null>;
export type WorkSessionResultEvidence = Exclude<WorkSessionDetailResult['resultEvidence'], null>;

/* ------------------------------------------------------------------ *
 * 受理/完成/停止/验收的分层表达（互不折算）
 * ------------------------------------------------------------------ */

/**
 * 完成与验收的分层事实：
 * - `cancelAccepted` 只是取消请求被接受，不是停止确认；
 * - `runtimeCompleted` 只是 Runtime 执行结束，不是 Task/Feature 验收；
 * - `stoppedConfirmed` 才是停止核验（无停止观察保持 false，不推断）；
 * - 本项未装配 Verifier（verifierAssembled 恒 false）：明确等待验证能力，
 *   Task/Feature 验收恒 false，由后续验证/最终验收另行表达。
 */
export interface WorkSessionAcceptanceFacts {
  readonly cancelAccepted: boolean;
  readonly runtimeCompleted: boolean;
  readonly stoppedConfirmed: boolean;
  /** 执行完成等待验证（awaiting_verification）；不是验收通过。 */
  readonly awaitingVerification: boolean;
  readonly verifierAssembled: false;
  readonly taskAccepted: false;
  readonly featureVerified: false;
  readonly note: string;
}

const ACCEPTANCE_NOTE =
  'accepted/cancel accepted 只是受理，Runtime completed 只是执行结束，stopped confirmed 才是停止确认；' +
  'Task/Feature 验收分别由验证/最终验收决定（本项未装配 Verifier：等待验证能力）；' +
  '执行结束不代表验收；本项尚无完整 Run 恢复';

function acceptanceFacts(facts: {
  readonly cancelAccepted: boolean;
  readonly runtimeCompleted: boolean;
  readonly stoppedConfirmed: boolean;
  readonly awaitingVerification: boolean;
}): WorkSessionAcceptanceFacts {
  return {
    cancelAccepted: facts.cancelAccepted,
    runtimeCompleted: facts.runtimeCompleted,
    stoppedConfirmed: facts.stoppedConfirmed,
    awaitingVerification: facts.awaitingVerification,
    verifierAssembled: false,
    taskAccepted: false,
    featureVerified: false,
    note: ACCEPTANCE_NOTE,
  };
}

/** 取消回执视图不表达 Runtime 结果（未知保持 null，不冒充 false）。 */
export interface AttemptCancelAcceptanceFacts {
  readonly commandAccepted: true;
  readonly cancelAccepted: true;
  readonly stoppedConfirmed: false;
  readonly runtimeCompleted: null;
  readonly taskAccepted: false;
  readonly featureVerified: false;
  readonly verifierAssembled: false;
  readonly note: string;
}

/* ------------------------------------------------------------------ *
 * execution.sessions.list（Work Session 列表）视图
 * ------------------------------------------------------------------ */

export interface WorkSessionListDisplay {
  readonly operation: 'execution.sessions.list';
  readonly parent: { readonly runId?: string; readonly taskId?: string };
  readonly records: readonly WorkSessionSummary[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly acceptance: WorkSessionAcceptanceFacts;
}

export function buildWorkSessionListView(
  result: WorkSessionListResult,
  parent: { readonly runId?: string; readonly taskId?: string },
): WorkSessionListDisplay {
  return {
    operation: 'execution.sessions.list',
    parent,
    records: result.records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    acceptance: acceptanceFacts({
      cancelAccepted: false,
      runtimeCompleted: false,
      stoppedConfirmed: false,
      awaitingVerification: result.records.some(
        (record) => record.executionState === 'awaiting_verification',
      ),
    }),
  };
}

function known(value: number | string | boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

export function formatWorkSessionListView(view: WorkSessionListDisplay): string {
  const lines = [
    `shiploop execution sessions: records=${view.records.length} ` +
      `nextCursor=${view.nextCursor ?? 'none'} limit=${view.limit}`,
  ];
  for (const record of view.records) {
    lines.push(
      `  session=${record.sessionId} attempt=${record.attemptId}#${record.attemptNumber} ` +
        `run=${record.runId} task=${record.taskId} state=${record.executionState} ` +
        `stage=${record.executionStage} runtime=${record.runtime} adapter=${record.adapterVersion} ` +
        `status=${record.status} resultRef=${record.resultRef ?? 'none'} ` +
        `watermark=${known(record.recordingWatermark)} gaps=${known(record.recordingGapCount)} ` +
        `exit/durationMs 见 execution session 详情（未知保持 null）`,
    );
  }
  lines.push(`  （${ACCEPTANCE_NOTE}）`, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.session.get（Work Session 详情）视图
 * ------------------------------------------------------------------ */

export interface WorkSessionUsageDisplay {
  /** synthetic（Fake/测试合成）与 reported（供应商报告）分开；synthetic 不计真实消费。 */
  readonly basis: 'synthetic' | 'reported';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
  /** 只有 reported 才是真实消费；synthetic 恒 false。 */
  readonly realConsumption: boolean;
}

export interface WorkSessionRuntimeResultDisplay {
  readonly terminal: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly lastEventSequence: number | null;
  readonly completed: boolean;
  readonly usage: WorkSessionUsageDisplay | null;
}

export interface WorkSessionStopDisplay {
  /** confirmed=停止已核验；unconfirmed=有停止观察但未核验；unknown=无停止观察（不推断）。 */
  readonly state: 'confirmed' | 'unconfirmed' | 'unknown';
  readonly confirmed: boolean | null;
  readonly checkedAtUtc: string | null;
  readonly detail: string | null;
}

export interface WorkSessionDetailDisplay {
  readonly operation: 'execution.session.get';
  readonly identity: {
    readonly projectId: string;
    readonly featureId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly sessionId: string | null;
    readonly inputRef: string;
    readonly resultRef: string | null;
  };
  /** 实际 Runtime（session 记录的 runtime/adapterVersion；未创建 Session 为 null）。 */
  readonly runtime: { readonly id: string; readonly adapterVersion: string } | null;
  readonly execution: {
    readonly state: WorkSessionDetailResult['executionState'];
    readonly attemptStatus: WorkSessionAttempt['status'];
    readonly executionStage: WorkSessionAttempt['executionStage'];
    readonly sessionStatus: string | null;
  };
  /** 错误原因（失败/中断分类 + 受限 reason token）；无错误为 null。 */
  readonly error: { readonly kind: string; readonly reason: string } | null;
  readonly runtimeResult: WorkSessionRuntimeResultDisplay | null;
  readonly stop: WorkSessionStopDisplay;
  readonly control: {
    readonly reason: string;
    readonly cancel: 'accepted' | 'rejected' | 'failed' | 'unobserved';
    readonly cancelAccepted: boolean;
  } | null;
  /** 覆盖缺口：记录水位、缺口清单与 manifest 引用（未知保持 null）。 */
  readonly recording: {
    readonly complete: boolean;
    readonly manifestRef: string | null;
    readonly watermark: number | null;
    readonly gaps: readonly string[];
  };
  readonly occupancy: WorkSessionDetailResult['occupancy'];
  /** 制品引用（证据索引；只有稳定身份，不含正文/路径）。 */
  readonly evidence: WorkSessionDetailResult['evidence'];
  readonly evidenceTruncated: boolean;
  readonly diagnostics: WorkSessionDetailResult['diagnostics'];
  readonly diagnosticsTruncated: boolean;
  readonly acceptance: WorkSessionAcceptanceFacts;
}

function usageDisplay(
  usage: NonNullable<WorkSessionResultEvidence['result']>['usage'],
): WorkSessionUsageDisplay | null {
  if (usage === null) {
    return null;
  }
  return {
    basis: usage.basis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsdMicros: usage.costUsdMicros,
    realConsumption: usage.basis === 'reported',
  };
}

export function buildWorkSessionDetailView(
  result: WorkSessionDetailResult,
): WorkSessionDetailDisplay {
  const evidence = result.resultEvidence;
  const runtimeResult: WorkSessionRuntimeResultDisplay | null =
    evidence?.result === null || evidence?.result === undefined
      ? null
      : {
          terminal: evidence.result.terminal,
          reason: evidence.result.reason,
          exitCode: evidence.result.exitCode,
          signal: evidence.result.signal,
          durationMs: evidence.result.durationMs,
          lastEventSequence: evidence.result.lastEventSequence,
          completed: evidence.result.terminal === 'completed',
          usage: usageDisplay(evidence.result.usage),
        };
  const stopEvidence = evidence?.stop.evidence ?? null;
  const stop: WorkSessionStopDisplay = {
    state: stopEvidence === null ? 'unknown' : stopEvidence.confirmed ? 'confirmed' : 'unconfirmed',
    confirmed: stopEvidence === null ? null : stopEvidence.confirmed,
    checkedAtUtc: stopEvidence === null ? null : stopEvidence.checkedAtUtc,
    detail: stopEvidence === null ? null : stopEvidence.detail,
  };
  const control = evidence?.control ?? null;
  const recording = evidence?.recording ?? {
    complete: false,
    manifestRef: null,
    watermark: result.session?.recordingWatermark ?? null,
    gaps: result.session?.recordingGaps ?? [],
  };
  return {
    operation: 'execution.session.get',
    identity: {
      projectId: result.attempt.projectId,
      featureId: result.attempt.featureId,
      runId: result.attempt.runId,
      taskId: result.attempt.taskId,
      attemptId: result.attempt.id,
      attemptNumber: result.attempt.number,
      sessionId: result.attempt.sessionId,
      inputRef: result.attempt.inputRef,
      resultRef: result.session?.resultRef ?? null,
    },
    runtime:
      result.session === null
        ? null
        : { id: result.session.runtime, adapterVersion: result.session.adapterVersion },
    execution: {
      state: result.executionState,
      attemptStatus: result.attempt.status,
      executionStage: result.attempt.executionStage,
      sessionStatus: result.session?.status ?? null,
    },
    error:
      evidence?.failure ?? (result.attempt.errorKind === null
        ? null
        : { kind: result.attempt.errorKind, reason: result.attempt.errorKind }),
    runtimeResult,
    stop,
    control:
      control === null
        ? null
        : {
            reason: control.reason,
            cancel: control.cancel,
            cancelAccepted: control.cancel === 'accepted',
          },
    recording: {
      complete: recording.complete,
      manifestRef: recording.manifestRef,
      watermark: recording.watermark,
      gaps: [...recording.gaps],
    },
    occupancy: result.occupancy,
    evidence: result.evidence,
    evidenceTruncated: result.evidenceTruncated,
    diagnostics: result.diagnostics,
    diagnosticsTruncated: result.diagnosticsTruncated,
    acceptance: acceptanceFacts({
      cancelAccepted: control?.cancel === 'accepted',
      runtimeCompleted: runtimeResult?.completed ?? false,
      stoppedConfirmed: stop.state === 'confirmed',
      awaitingVerification: result.executionState === 'awaiting_verification',
    }),
  };
}

export function formatWorkSessionDetailView(view: WorkSessionDetailDisplay): string {
  const { identity, execution, runtimeResult, stop, acceptance } = view;
  const lines = [
    `shiploop execution session: run=${identity.runId} task=${identity.taskId} ` +
      `attempt=${identity.attemptId}#${identity.attemptNumber} session=${identity.sessionId ?? 'none'} ` +
      `state=${execution.state}`,
    `  runtime=${view.runtime?.id ?? 'unknown'} adapter=${view.runtime?.adapterVersion ?? 'unknown'} ` +
      `stage=${execution.executionStage} attemptStatus=${execution.attemptStatus} ` +
      `sessionStatus=${execution.sessionStatus ?? 'none'}`,
  ];
  if (runtimeResult === null) {
    lines.push('  runtimeResult=none（尚无 Runtime 结果证据；不是成功也不是失败）');
  } else {
    const usage =
      runtimeResult.usage === null
        ? 'usage=unknown'
        : runtimeResult.usage.basis === 'synthetic'
          ? `usage=synthetic(input=${known(runtimeResult.usage.inputTokens)} ` +
            `output=${known(runtimeResult.usage.outputTokens)} costUsdMicros=${known(runtimeResult.usage.costUsdMicros)}) ` +
            `synthetic_token_not_real_consumption`
          : `usage=reported(input=${known(runtimeResult.usage.inputTokens)} ` +
            `output=${known(runtimeResult.usage.outputTokens)} costUsdMicros=${known(runtimeResult.usage.costUsdMicros)})`;
    lines.push(
      `  runtimeResult: terminal=${runtimeResult.terminal} reason=${runtimeResult.reason ?? 'none'} ` +
        `exit=${known(runtimeResult.exitCode)} signal=${runtimeResult.signal ?? 'none'} ` +
        `durationMs=${known(runtimeResult.durationMs)} lastEventSequence=${known(runtimeResult.lastEventSequence)} ${usage}`,
    );
  }
  if (view.error !== null) {
    lines.push(`  error: kind=${view.error.kind} reason=${view.error.reason}`);
  }
  lines.push(
    `  stop: state=${stop.state} confirmed=${known(stop.confirmed)} ` +
      `checkedAt=${stop.checkedAtUtc ?? 'unknown'} detail=${stop.detail ?? 'none'}`,
  );
  lines.push(
    `  control: ${view.control === null ? 'none（无取消/停止控制事实）' : `reason=${view.control.reason} cancel=${view.control.cancel}`}`,
  );
  lines.push(
    `  recording: complete=${view.recording.complete} manifestRef=${view.recording.manifestRef ?? 'none'} ` +
      `watermark=${known(view.recording.watermark)} gaps=${view.recording.gaps.length === 0 ? 'none' : view.recording.gaps.join(',')}`,
  );
  lines.push(
    `  evidence: ${view.evidence.length === 0 ? 'none' : view.evidence.map((ref) => `${ref.artifactId}(${ref.kind},${ref.status})`).join(' ')}` +
      `${view.evidenceTruncated ? ' truncated' : ''}`,
  );
  if (view.diagnostics.length > 0) {
    lines.push(
      `  diagnostics: ${view.diagnostics.map((row) => `${row.id}:${row.reason}`).join(' ')}` +
        `${view.diagnosticsTruncated ? ' truncated' : ''}`,
    );
  }
  lines.push(
    `  acceptance: cancelAccepted=${acceptance.cancelAccepted} runtimeCompleted=${acceptance.runtimeCompleted} ` +
      `stoppedConfirmed=${acceptance.stoppedConfirmed} awaitingVerification=${acceptance.awaitingVerification} ` +
      `verifierAssembled=${acceptance.verifierAssembled} taskAccepted=${acceptance.taskAccepted} ` +
      `featureVerified=${acceptance.featureVerified}`,
    `  （${ACCEPTANCE_NOTE}）`,
    '',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.session.evidence.get（诊断证据正文）视图
 * ------------------------------------------------------------------ */

export interface WorkSessionEvidenceDisplay {
  readonly operation: 'execution.session.evidence.get';
  readonly artifact: {
    readonly artifactId: string;
    readonly kind: string;
    readonly mediaType: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
    readonly version: number;
  };
  /** 正文编码：可严格解码为 UTF-8 时为 utf8，否则原样 base64（不伪造文本）。 */
  readonly contentEncoding: 'utf8' | 'base64';
  readonly content: string;
}

export function buildWorkSessionEvidenceView(
  result: WorkSessionEvidenceContent,
): WorkSessionEvidenceDisplay {
  let contentEncoding: 'utf8' | 'base64' = 'utf8';
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(result.content);
  } catch {
    contentEncoding = 'base64';
    content = Buffer.from(result.content).toString('base64');
  }
  return { operation: 'execution.session.evidence.get', artifact: result.artifact, contentEncoding, content };
}

export function formatWorkSessionEvidenceView(view: WorkSessionEvidenceDisplay): string {
  return [
    `shiploop execution session-evidence: artifact=${view.artifact.artifactId} ` +
      `kind=${view.artifact.kind} mediaType=${view.artifact.mediaType} ` +
      `sizeBytes=${view.artifact.sizeBytes} contentHash=${view.artifact.contentHash} ` +
      `version=${view.artifact.version} contentEncoding=${view.contentEncoding}`,
    view.content,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.attempt.cancel（取消接受）视图
 * ------------------------------------------------------------------ */

export interface AttemptCancelDisplay {
  readonly operation: 'execution.attempt.cancel';
  readonly commandId: string;
  readonly replayed: boolean;
  readonly identity: { readonly projectId: string; readonly attemptId: string };
  readonly submission: { readonly accepted: true; readonly status: 'completed' };
  /** cancel accepted：取消请求被接受；stoppedConfirmed 恒 false（停止另查 session 停止证据）。 */
  readonly cancel: {
    readonly accepted: true;
    readonly cancellationRequested: true;
    readonly stoppedConfirmed: false;
  };
  readonly acceptance: AttemptCancelAcceptanceFacts;
}

export function buildAttemptCancelView(
  commandId: string,
  replayed: boolean,
  result: unknown,
  identity: { readonly projectId: string; readonly attemptId: string },
): AttemptCancelDisplay {
  // 回执 result 形状 fail-closed：取消接受必须指向同一 Attempt 且显式请求取消。
  const payload = result as { attemptId?: unknown; cancellationRequested?: unknown } | null;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.attemptId !== identity.attemptId ||
    payload.cancellationRequested !== true
  ) {
    throw new TypeError('取消回执 result 形状非法（execution.attempt.cancel）');
  }
  return {
    operation: 'execution.attempt.cancel',
    commandId,
    replayed,
    identity,
    submission: { accepted: true, status: 'completed' },
    cancel: { accepted: true, cancellationRequested: true, stoppedConfirmed: false },
    acceptance: {
      commandAccepted: true,
      cancelAccepted: true,
      stoppedConfirmed: false,
      runtimeCompleted: null,
      taskAccepted: false,
      featureVerified: false,
      verifierAssembled: false,
      note: ACCEPTANCE_NOTE,
    },
  };
}

export function formatAttemptCancelView(view: AttemptCancelDisplay): string {
  return [
    `shiploop execution cancel: attempt=${view.identity.attemptId} commandId=${view.commandId} ` +
      `replayed=${view.replayed} command=accepted status=${view.submission.status} ` +
      `cancel=accepted stopped=unconfirmed`,
    `  acceptance: commandAccepted=${view.acceptance.commandAccepted} ` +
      `cancelAccepted=${view.acceptance.cancelAccepted} stoppedConfirmed=${view.acceptance.stoppedConfirmed} ` +
      `runtimeCompleted=unknown taskAccepted=${view.acceptance.taskAccepted} ` +
      `featureVerified=${view.acceptance.featureVerified} verifierAssembled=${view.acceptance.verifierAssembled}`,
    `  （${ACCEPTANCE_NOTE}）`,
    '',
  ].join('\n');
}
