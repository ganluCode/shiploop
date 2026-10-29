/**
 * P03-9 / F-015 Run/Batch 控制、retryFinal 与恢复诊断 CLI 纯视图层。
 *
 * 纯函数模块（无 I/O）：
 * - 命令视图：把 HostClient 已线校验的 pause/cancel/resume/retryFinal completed
 *   回执投影为 CLI 结构化输出。completed 只代表命令事务已落地：pausing/cancelling
 *   不是已暂停/已停止，stop_uncertain 必须先核对停止证据；工作流 resume ≠
 *   Runtime/SDK 原生续接；retryFinal runtimeStarts=0 是仅收尾重试；
 * - 诊断视图：run/batch 控制查询与 run 恢复查询投影，nextActions 附带可理解
 *   说明；恢复续接记录展示请求模式（auto/new/required）与实际决策（resume/new），
 *   请求续接但实际新建会话即 Fake 新 Session 降级；未知用量/停止确认保持
 *   null（人类行显示 unknown），不以 0/false 冒充；
 * - 人类行：脱敏事实字段；不打印正文、凭据、秘密或开发机路径。
 */
import type {
  BatchControlDetailResult,
  RunControlDetailResult,
  RunRecoveryDetailResult,
  ResourceListResult,
} from 'shiploop-host';

/** nextActions 冻结词汇（与 Core EXECUTION_CONTROL_NEXT_ACTIONS 同源；Host 线类型推导）。 */
type ExecutionControlNextAction =
  | RunControlDetailResult['nextActions'][number]
  | BatchControlDetailResult['nextActions'][number];

/* ------------------------------------------------------------------ *
 * 控制命令回执视图（execution.pause / execution.cancel / execution.resume）
 * ------------------------------------------------------------------ */

export type ExecutionControlOperation = 'execution.pause' | 'execution.cancel' | 'execution.resume';

export interface ExecutionControlCommandResult {
  /** pause/cancel 的事务结果；resume 用 resumed:true 表达成功。 */
  readonly outcome?: string;
  readonly resumed?: true;
  readonly targetKind: string;
  readonly targetId: string;
  readonly status: string;
  readonly revision: number;
  readonly changed?: boolean;
  readonly stopOperationId?: string | null;
  readonly stopStatus?: string | null;
  readonly batchId?: string;
  readonly featureId?: string;
  readonly runIds?: readonly string[];
  readonly alreadyTerminal?: boolean;
  readonly runtimeStarts?: number;
  readonly attemptsCreated?: number;
  readonly nextTaskIds?: readonly string[];
}

export interface ExecutionControlCommandView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly operation: ExecutionControlOperation;
  readonly outcome: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly status: string;
  readonly revision: number;
  readonly changed: boolean;
  readonly stopOperationId: string | null;
  readonly stopStatus: string | null;
  readonly batchId: string | null;
  readonly featureId: string | null;
  readonly runIds: readonly string[];
  /** resume/retryFinal 附带：本次命令产生的 Runtime 启动数（控制命令恒 0）。 */
  readonly runtimeStarts: number | null;
  readonly attemptsCreated: number | null;
  /** 控制事务是否到达稳定终态（already_terminal / interrupted 等）。 */
  readonly finalState: boolean;
  /** 边界说明：本输出不宣称已暂停/已停止/已验收。 */
  readonly note: string;
  /** 可理解的显式下一步。 */
  readonly nextStep: string;
}

function controlNoteAndNextStep(
  operation: ExecutionControlOperation,
  outcome: string,
  targetKind: string,
  stopStatus: string | null,
): { readonly note: string; readonly nextStep: string } {
  if (outcome === 'already_terminal') {
    return {
      note: '目标已是终态：本次命令零写入，不倒写历史、不重新打开终态',
      nextStep: `用 execution ${targetKind === 'run' ? 'control' : 'batch-control'} 查看终态原因与后续动作`,
    };
  }
  if (outcome === 'stop_uncertain' || stopStatus === 'uncertain') {
    return {
      note: '停止不确定：旧进程是否已停止未证实，不冒充已停止、不释放占用、不自动开新执行',
      nextStep: '先用 execution control 核对停止 operation 的 evidenceRef 停止证据，再决定恢复或返工',
    };
  }
  if (operation === 'execution.pause') {
    if (outcome === 'pausing') {
      return {
        note: '暂停意图已登记（pausing）：等待当前 Attempt 验证/收尾后才转 paused，尚未暂停',
        nextStep: '用 execution control 查询最终暂停状态与剩余占用；pause 不中止正在运行的 Attempt',
      };
    }
    return {
      note: '暂停已生效（工作流状态）：不新起认领；不代表验收结果，也不停止已运行的 Attempt',
      nextStep: '用 execution resume 显式继续；用 execution control 查看占用与下一步',
    };
  }
  if (operation === 'execution.cancel') {
    if (outcome === 'cancelling') {
      return {
        note: '取消进行中（cancelling）：停止 operation 尚未结算，尚未停止',
        nextStep: '用 execution control 跟踪停止 operation 结算与停止证据',
      };
    }
    return {
      note: '取消已登记：目标 Run/Batch 不再继续工作；取消不等于验收通过，也不自动恢复',
      nextStep: '用 execution control 查看停止证据与关联 Attempt 终态',
    };
  }
  /* execution.resume */
  return {
    note: '工作流 resume 已提交：继续与否由当前任务策略/输入快照决定（auto/new/required），不等于 Runtime/SDK 原生续接，也不代表验收结果',
    nextStep: '用 execution schedule 或 execution recovery 查看 Run/Attempt 恢复与续接记录',
  };
}

export function buildExecutionControlCommandView(
  commandId: string,
  replayed: boolean,
  operation: ExecutionControlOperation,
  result: ExecutionControlCommandResult,
): ExecutionControlCommandView {
  const outcome = operation === 'execution.resume'
    ? (result.resumed === true ? 'resumed' : 'unexpected_resume_shape')
    : (result.outcome ?? 'unexpected_control_shape');
  const stopStatus = result.stopStatus ?? null;
  const { note, nextStep } = controlNoteAndNextStep(operation, outcome, result.targetKind, stopStatus);
  const finalState =
    outcome === 'already_terminal' ||
    outcome === 'paused' ||
    outcome === 'cancelled' ||
    outcome === 'resumed' ||
    outcome === 'interrupted';
  return {
    commandId,
    replayed,
    operation,
    outcome,
    targetKind: result.targetKind,
    targetId: result.targetId,
    status: result.status,
    revision: result.revision,
    changed: result.changed ?? true,
    stopOperationId: result.stopOperationId ?? null,
    stopStatus,
    batchId: result.batchId ?? null,
    featureId: result.featureId ?? null,
    runIds: result.runIds ?? [],
    runtimeStarts: result.runtimeStarts ?? null,
    attemptsCreated: result.attemptsCreated ?? null,
    finalState,
    note,
    nextStep,
  };
}

export function formatExecutionControlCommandView(view: ExecutionControlCommandView): string {
  const marker = view.replayed ? '（replayed）' : '';
  const target = `${view.targetKind}=${view.targetId}`;
  const stop = view.stopOperationId !== null
    ? ` stop=${view.stopOperationId}/${view.stopStatus ?? 'unknown'}`
    : '';
  const resumed = view.runIds.length > 0 ? ` runs=${view.runIds.join(',')}` : '';
  const starts = view.runtimeStarts !== null
    ? ` runtimeStarts=${view.runtimeStarts} attemptsCreated=${view.attemptsCreated}`
    : '';
  return [
    `shiploop ${view.operation}: outcome=${view.outcome} ${target} status=${view.status} ` +
      `revision=${view.revision} changed=${view.changed}${stop}${resumed}${starts}${marker}`,
    `  ${view.note}`,
    `  下一步：${view.nextStep}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * retryFinal 回执视图（仅收尾重试）
 * ------------------------------------------------------------------ */

export interface ExecutionRetryFinalResult {
  readonly schemaVersion: number;
  readonly retryFinal: boolean;
  readonly dispatched: boolean;
  readonly batchId: string;
  readonly runId: string;
  readonly featureId: string;
  readonly historicalRunId: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly runsCreated: number;
  readonly status: string;
  readonly finalizationScopeDigest: string;
  readonly missingSteps: readonly string[];
  readonly revalidateTaskIds: readonly string[];
  readonly finalCheckKeys: readonly string[];
  readonly runtimeStarts: number;
  readonly attemptsCreated: number;
}

export interface ExecutionRetryFinalView {
  readonly commandId: string;
  readonly replayed: boolean;
  readonly operation: 'execution.retryFinal';
  readonly retryFinal: true;
  readonly dispatched: boolean;
  readonly batchId: string;
  readonly newRunId: string;
  readonly featureId: string;
  readonly historicalRunId: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
  readonly status: string;
  readonly finalizationScopeDigest: string;
  readonly missingSteps: readonly string[];
  readonly revalidateTaskIds: readonly string[];
  readonly finalCheckKeys: readonly string[];
  readonly runtimeStarts: number;
  readonly attemptsCreated: number;
  readonly note: string;
  readonly nextStep: string;
}

export function buildExecutionRetryFinalView(
  commandId: string,
  replayed: boolean,
  result: ExecutionRetryFinalResult,
): ExecutionRetryFinalView {
  if (result.retryFinal !== true || result.dispatched !== true) {
    throw new Error('unexpected_retry_final_result_shape');
  }
  return {
    commandId,
    replayed,
    operation: 'execution.retryFinal',
    retryFinal: true,
    dispatched: result.dispatched,
    batchId: result.batchId,
    newRunId: result.runId,
    featureId: result.featureId,
    historicalRunId: result.historicalRunId,
    workKey: result.workKey,
    dispatchOrdinal: result.dispatchOrdinal,
    status: result.status,
    finalizationScopeDigest: result.finalizationScopeDigest,
    missingSteps: [...result.missingSteps],
    revalidateTaskIds: [...result.revalidateTaskIds],
    finalCheckKeys: [...result.finalCheckKeys],
    runtimeStarts: result.runtimeStarts,
    attemptsCreated: result.attemptsCreated,
    note: '仅收尾重试：新 Run 只执行缺失收尾步骤（检查/审批/提交），零 Runtime 启动、不重复编码；旧 Run 保持终态，预算不重置',
    nextStep: '用 execution recovery 查看收尾 scope 与分轴事实；用 execution control 跟踪新 Run',
  };
}

export function formatExecutionRetryFinalView(view: ExecutionRetryFinalView): string {
  const marker = view.replayed ? '（replayed）' : '';
  return [
    `shiploop execution.retryFinal: newRun=${view.newRunId} historicalRun=${view.historicalRunId} ` +
      `batch=${view.batchId} status=${view.status} runtimeStarts=${view.runtimeStarts} ` +
      `attemptsCreated=${view.attemptsCreated}${marker}`,
    `  missingSteps=${view.missingSteps.join(',') || 'none'} ` +
      `revalidate=${view.revalidateTaskIds.join(',') || 'none'} ` +
      `finalChecks=${view.finalCheckKeys.join(',') || 'none'} ` +
      `scopeDigest=${view.finalizationScopeDigest}`,
    `  ${view.note}`,
    `  下一步：${view.nextStep}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 控制诊断查询视图（execution.run|batch.control.get）
 * ------------------------------------------------------------------ */

/** nextActions 的可理解说明（冻结词汇 → 显式下一步；不改写权威词汇）。 */
export const EXECUTION_CONTROL_NEXT_ACTION_NOTES: Readonly<
  Record<Exclude<ExecutionControlNextAction, 'none'>, string>
> = Object.freeze({
  resume: '目标已暂停且无未收尾占用：可用 execution resume 显式继续',
  resume_blocked_occupancy: '仍有活动 Attempt 或未收尾占用（held/quarantined）：先收尾占用，resume 会被既有授权拒绝',
  await_attempt_settlement: '暂停进行中：等待当前 Attempt 验证/收尾后转 paused，再决定是否 resume',
  await_stop_settlement: '取消进行中：等待停止 operation 结算后再查看停止证据',
  stop_reconcile: '停止不确定：先用 execution control 核对停止 operation 的 evidenceRef 证据，不冒充已停止',
  retry_final: 'finalization-only Run 失败终态：可用 execution retry-final 仅重试收尾步骤，不重复编码',
});

export type ExecutionControlNextActionNote = {
  readonly action: ExecutionControlNextAction;
  readonly description: string;
};

export interface ExecutionControlStopView {
  readonly operationId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly status: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly evidenceRef: string | null;
  readonly stopConfirmed: boolean | null;
  readonly forced: boolean | null;
  readonly checkedAt: string | null;
}

export interface ExecutionResourceQueryView {
  readonly operation: 'execution.resources.list';
  readonly records: ResourceListResult['records'];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completed: false;
}

export function buildExecutionResourceQueryView(result: ResourceListResult): ExecutionResourceQueryView {
  return { operation: 'execution.resources.list', records: result.records, nextCursor: result.nextCursor, limit: result.limit, completed: false };
}

export function formatExecutionResourceQueryView(view: ExecutionResourceQueryView): string {
  const lines = [`shiploop ${view.operation}: resources=${view.records.length} completed=false limit=${view.limit}`];
  for (const record of view.records) {
    lines.push(`  resource=${record.resourceKey} kind=${record.kind} state=${record.state} ` +
      `feature=${record.featureId} batch=${record.batchId} run=${record.runId} ` +
      `owner=${record.ownerId}/${record.ownerVersion} revision=${record.revision} ` +
      `blocking=${record.blockingReason ?? 'none'} waiting=${record.waitingReason?.code ?? 'none'}`);
  }
  if (view.nextCursor !== null) lines.push(`  nextCursor=${view.nextCursor}`);
  return `${lines.join('\n')}\n`;
}
export interface ExecutionControlQueryView {
  readonly operation: 'execution.run.control.get' | 'execution.batch.control.get';
  readonly targetKind: 'run' | 'batch';
  readonly targetId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly batchStatus: string;
  readonly counters: {
    readonly runsCreated: number;
    readonly attemptsCreated: number;
    readonly runtimeStarts: number;
    readonly noProgressRuns: number;
  };
  readonly attempts: {
    readonly records: readonly {
      readonly attemptId: string;
      readonly taskId: string;
      readonly attemptNumber: number;
      readonly status: string;
      readonly executionStage: string;
      readonly diagnosticRef: string | null;
    }[];
    readonly truncated: boolean;
  };
  readonly stopOperations: readonly ExecutionControlStopView[];
  readonly leases: readonly {
    readonly leaseId: string;
    readonly attemptId: string;
    readonly resourceKey: string;
    readonly state: string;
    readonly leaseUntil: string;
  }[];
  readonly nextActions: readonly ExecutionControlNextAction[];
  readonly nextActionNotes: readonly ExecutionControlNextActionNote[];
}

function stopOperationView(raw: {
  readonly operationId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly status: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  readonly evidenceRef: string | null;
  readonly stopConfirmed: boolean | null;
  readonly forced: boolean | null;
  readonly checkedAt: string | null;
}): ExecutionControlStopView {
  return {
    operationId: raw.operationId,
    targetKind: raw.targetKind,
    targetId: raw.targetId,
    status: raw.status,
    reason: raw.reason,
    requestedAt: raw.requestedAt,
    settledAt: raw.settledAt,
    evidenceRef: raw.evidenceRef,
    stopConfirmed: raw.stopConfirmed,
    forced: raw.forced,
    checkedAt: raw.checkedAt,
  };
}

function nextActionNotes(nextActions: readonly ExecutionControlNextAction[]): readonly ExecutionControlNextActionNote[] {
  return nextActions
    .filter((action) => action !== 'none')
    .map((action) => ({
      action,
      description: EXECUTION_CONTROL_NEXT_ACTION_NOTES[action],
    }));
}

export function buildExecutionControlQueryView(
  result: RunControlDetailResult,
): ExecutionControlQueryView;
export function buildExecutionControlQueryView(
  result: BatchControlDetailResult,
): ExecutionControlQueryView;
export function buildExecutionControlQueryView(
  result: RunControlDetailResult | BatchControlDetailResult,
): ExecutionControlQueryView {
  const isRun = result.scope === 'run-control';
  const runBrief = isRun ? result.run : null;
  const batchBrief = result.batch;
  const attempts = result.attempts;
  return {
    operation: isRun ? 'execution.run.control.get' : 'execution.batch.control.get',
    targetKind: isRun ? 'run' : 'batch',
    targetId: isRun ? result.run.runId : batchBrief.batchId,
    batchId: batchBrief.batchId,
    featureId: runBrief?.featureId ?? batchBrief.featureId,
    status: runBrief?.status ?? batchBrief.status,
    reason: runBrief?.reason ?? batchBrief.reason,
    batchStatus: batchBrief.status,
    counters: batchBrief.counters,
    attempts: {
      records: attempts.records.map((attempt) => ({
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        executionStage: attempt.executionStage,
        diagnosticRef: attempt.diagnosticRef,
      })),
      truncated: attempts.truncated,
    },
    stopOperations: result.stopOperations.map(stopOperationView),
    leases: result.leases.map((lease) => ({
      leaseId: lease.leaseId,
      attemptId: lease.attemptId,
      resourceKey: lease.resourceKey,
      state: lease.state,
      leaseUntil: lease.leaseUntil,
    })),
    nextActions: [...result.nextActions],
    nextActionNotes: nextActionNotes(result.nextActions),
  };
}

function nullableText(value: boolean | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : String(value);
}

export function formatExecutionControlQueryView(view: ExecutionControlQueryView): string {
  const target = view.targetKind === 'run' ? `run=${view.targetId}` : `batch=${view.targetId}`;
  const lines = [
    `shiploop ${view.operation}: ${target} status=${view.status} reason=${view.reason ?? 'none'} ` +
      `batch=${view.batchId}/${view.batchStatus}`,
    `  counters: runs=${view.counters.runsCreated} attempts=${view.counters.attemptsCreated} ` +
      `runtimeStarts=${view.counters.runtimeStarts} noProgress=${view.counters.noProgressRuns}`,
  ];
  for (const attempt of view.attempts.records) {
    lines.push(
      `  attempt=${attempt.attemptId} task=${attempt.taskId} #${attempt.attemptNumber} ` +
        `status=${attempt.status} stage=${attempt.executionStage}` +
        `${attempt.diagnosticRef !== null ? ` diagnosticRef=${attempt.diagnosticRef}` : ''}`,
    );
  }
  if (view.attempts.truncated) {
    lines.push('  attempts: truncated（超限截断，完整列表走 Host 查询）');
  }
  for (const stop of view.stopOperations) {
    lines.push(
      `  stop=${stop.operationId} status=${stop.status} evidence=${stop.evidenceRef ?? 'none'} ` +
        `confirmed=${nullableText(stop.stopConfirmed)} forced=${nullableText(stop.forced)}`,
    );
  }
  for (const lease of view.leases) {
    lines.push(
      `  lease=${lease.leaseId} attempt=${lease.attemptId} resource=${lease.resourceKey} ` +
        `state=${lease.state} until=${lease.leaseUntil}`,
    );
  }
  lines.push(
    `  nextActions=${view.nextActions.join(',') || 'none'}`,
  );
  for (const note of view.nextActionNotes) {
    lines.push(`  - ${note.action}: ${note.description}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * 恢复诊断查询视图（execution.run.recovery.get）
 * ------------------------------------------------------------------ */

export interface ExecutionRecoveryContinuationView {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly sourceAttemptId: string | null;
  readonly sourceSessionId: string | null;
  readonly requestedMode: 'new' | 'auto' | 'required';
  readonly requestedKind: 'conversation' | 'checkpoint' | null;
  readonly nativeArchiveRef: string | null;
  readonly decidedMode: 'resume' | 'new';
  readonly decidedReasons: readonly string[];
  readonly handoff: { readonly previousAttemptId: string; readonly previousStatus: string } | null;
  readonly recordedAt: string;
  /**
   * Fake 新 Session 降级：请求了原生续接（auto/required）但实际新建会话。
   * required 降级还意味着策略要求的续接能力未落实。
   */
  readonly degraded: {
    readonly requestedMode: 'auto' | 'required';
    readonly note: string;
  } | null;
}

export interface ExecutionRecoveryObservationView {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly phase: string;
  readonly observationRevision: number;
  readonly observedAt: string;
  readonly evidenceRef: string | null;
  readonly gaps: readonly string[];
  readonly stopConfirmed: boolean;
  readonly processIdentityRecorded: boolean;
  readonly verificationProcessesCount: number;
}

export interface ExecutionRecoveryNextStepView {
  readonly action: 'execution.resume' | 'execution.retry-final';
  readonly executable: boolean;
  readonly blockedBy: readonly string[];
}

export interface ExecutionRecoveryCliView {
  readonly operation: 'execution.run.recovery.get';
  readonly runId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly finalizationPresent: boolean;
  readonly missingFinalSteps: readonly string[];
  readonly continuations: readonly ExecutionRecoveryContinuationView[];
  readonly recoveryTruncated: boolean;
  readonly startup: {
    readonly phase: string;
    readonly interruptedAttempts: readonly { readonly attemptId: string; readonly taskId: string; readonly attemptNumber: number; readonly status: string; readonly executionStage: string }[];
    readonly interruptedTruncated: boolean;
    readonly observations: readonly ExecutionRecoveryObservationView[];
    readonly observationTruncated: boolean;
    readonly quarantinedLeases: number;
    readonly heldLeases: number;
    readonly workspace: { readonly workspaceId: string; readonly status: string; readonly revision: number } | null;
    readonly pendingGitOperations: readonly { readonly operationId: string; readonly kind: string; readonly status: string; readonly attemptId: string | null }[];
    readonly stopOperations: readonly { readonly operationId: string; readonly status: string; readonly stopConfirmed: boolean | null; readonly evidenceRef: string | null }[];
    readonly nextSteps: readonly ExecutionRecoveryNextStepView[];
  };
  readonly budget: {
    readonly batchId: string;
    readonly budgetRevision: number;
    readonly counters: {
      readonly runsCreated: number;
      readonly attemptsCreated: number;
      readonly runtimeStarts: number;
      readonly noProgressRuns: number;
    };
    readonly usage: { readonly tokenUsed: null; readonly costUsed: null };
  };
  readonly note: string;
}

function continuationView(raw: {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly sourceAttemptId: string | null;
  readonly sourceSessionId: string | null;
  readonly requested: {
    readonly mode: 'new' | 'auto' | 'required';
    readonly kind: 'conversation' | 'checkpoint' | null;
    readonly nativeArchiveRef: string | null;
  };
  readonly decided: { readonly mode: 'resume' | 'new'; readonly reasons: readonly string[] };
  readonly handoff: { readonly previousAttemptId: string; readonly previousStatus: string } | null;
  readonly recordedAt: string;
}): ExecutionRecoveryContinuationView {
  const degraded =
    raw.requested.mode !== 'new' && raw.decided.mode === 'new'
      ? {
          requestedMode: raw.requested.mode,
          note:
            raw.requested.mode === 'auto'
              ? 'Fake 新 Session 降级：请求了原生续接（auto），Runtime 不支持时按政策新建会话继续；非绕过占用/锁'
              : 'required 降级拒绝语义：任务策略要求续接（required）但本次新建会话，需核对原因；不得用新 Session 绕过隔离',
        }
      : null;
  return {
    attemptId: raw.attemptId,
    taskId: raw.taskId,
    attemptNumber: raw.attemptNumber,
    sourceAttemptId: raw.sourceAttemptId,
    sourceSessionId: raw.sourceSessionId,
    requestedMode: raw.requested.mode,
    requestedKind: raw.requested.kind,
    nativeArchiveRef: raw.requested.nativeArchiveRef,
    decidedMode: raw.decided.mode,
    decidedReasons: [...raw.decided.reasons],
    handoff: raw.handoff === null
      ? null
      : { previousAttemptId: raw.handoff.previousAttemptId, previousStatus: raw.handoff.previousStatus },
    recordedAt: raw.recordedAt,
    degraded,
  };
}

export function buildExecutionRecoveryCliView(
  result: RunRecoveryDetailResult,
): ExecutionRecoveryCliView {
  const missingFinalSteps = result.finalization.scope === null
    ? []
    : [...result.finalization.scope.missingSteps];
  return {
    operation: 'execution.run.recovery.get',
    runId: result.run.runId,
    batchId: result.run.batchId,
    featureId: result.run.featureId,
    status: result.run.status,
    reason: result.run.reason,
    finalizationPresent: result.finalization.present,
    missingFinalSteps,
    continuations: result.recovery.records.map(continuationView),
    recoveryTruncated: result.recovery.truncated,
    startup: {
      phase: result.startup.phase,
      interruptedAttempts: result.startup.interruptedAttempts.map(attempt => ({
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        executionStage: attempt.executionStage,
      })),
      interruptedTruncated: result.startup.interruptedTruncated,
      observations: result.startup.observations.map(observation => ({
        attemptId: observation.attemptId,
        taskId: observation.taskId,
        attemptNumber: observation.attemptNumber,
        phase: observation.phase,
        observationRevision: observation.observationRevision,
        observedAt: observation.observedAt,
        evidenceRef: observation.evidenceRef,
        gaps: [...observation.gaps],
        stopConfirmed: observation.stopConfirmed,
        processIdentityRecorded: observation.processIdentityRecorded,
        verificationProcessesCount: observation.verificationProcessesCount,
      })),
      observationTruncated: result.startup.observationTruncated,
      quarantinedLeases: result.startup.leases.filter(lease => lease.state === 'quarantined').length,
      heldLeases: result.startup.leases.filter(lease => lease.state === 'held').length,
      workspace: result.startup.workspace === null ? null : {
        workspaceId: result.startup.workspace.workspaceId,
        status: result.startup.workspace.status,
        revision: result.startup.workspace.revision,
      },
      pendingGitOperations: result.startup.pendingGitOperations.map(operation => ({
        operationId: operation.operationId,
        kind: operation.kind,
        status: operation.status,
        attemptId: operation.attemptId,
      })),
      stopOperations: result.startup.stopOperations.map(operation => ({
        operationId: operation.operationId,
        status: operation.status,
        stopConfirmed: operation.stopConfirmed,
        evidenceRef: operation.evidenceRef,
      })),
      nextSteps: result.startup.nextSteps.map(step => ({
        action: step.action,
        executable: step.executable,
        blockedBy: [...step.blockedBy],
      })),
    },
    budget: {
      batchId: result.budget.batchId,
      budgetRevision: result.budget.budgetRevision,
      counters: result.budget.counters,
      usage: result.budget.usage,
    },
    note: '工作流 resume 由显式 execution.resume 发起；恢复模式 auto/new/required 由 Task 策略/输入快照决定；本查询只读，不接管旧执行、不创建 Attempt；诊断资格不作为授权凭据',
  };
}

export function formatExecutionRecoveryCliView(view: ExecutionRecoveryCliView): string {
  const lines = [
    `shiploop execution.recovery: run=${view.runId} batch=${view.batchId} feature=${view.featureId} ` +
      `status=${view.status} reason=${view.reason ?? 'none'}`,
    `  finalization=${view.finalizationPresent ? 'present' : 'none'}` +
      `${view.missingFinalSteps.length > 0 ? ` missingSteps=${view.missingFinalSteps.join(',')}` : ''}`,
    `  startup-recovery: phase=${view.startup.phase}` +
      ` interrupted=${view.startup.interruptedAttempts.length}` +
      `${view.startup.interruptedTruncated ? '+' : ''}` +
      ` quarantinedLeases=${view.startup.quarantinedLeases} heldLeases=${view.startup.heldLeases}` +
      ` workspace=${view.startup.workspace === null ? 'none' : `${view.startup.workspace.status}@r${view.startup.workspace.revision}`}`,
  ];
  for (const attempt of view.startup.interruptedAttempts) {
    lines.push(`    interrupted: attempt=${attempt.attemptId} task=${attempt.taskId} #${attempt.attemptNumber}` +
      ` stage=${attempt.executionStage}`);
  }
  for (const observation of view.startup.observations) {
    lines.push(`    observation: attempt=${observation.attemptId} phase=${observation.phase}` +
      ` rev=${observation.observationRevision} stopConfirmed=${observation.stopConfirmed}` +
      ` evidence=${observation.evidenceRef ?? 'none'}` +
      ` gaps=${observation.gaps.join(',') || 'none'}`);
  }
  if (view.startup.observationTruncated) {
    lines.push('    observations: truncated（超限截断，完整列表走 Host 查询）');
  }
  for (const operation of view.startup.pendingGitOperations) {
    lines.push(`    pending-git: operation=${operation.operationId} kind=${operation.kind}` +
      ` status=${operation.status} attempt=${operation.attemptId ?? 'none'}`);
  }
  for (const operation of view.startup.stopOperations) {
    lines.push(`    stop: operation=${operation.operationId} status=${operation.status}` +
      ` stopConfirmed=${operation.stopConfirmed ?? 'unknown'} evidence=${operation.evidenceRef ?? 'none'}`);
  }
  for (const step of view.startup.nextSteps) {
    lines.push(`    next-step: ${step.action} ${step.executable ? 'executable' : 'blocked'}` +
      `${step.blockedBy.length > 0 ? ` blockedBy=${step.blockedBy.join(',')}` : ''}`);
  }
  if (view.startup.nextSteps.length === 0) {
    lines.push('    next-step: none（目标已取消或无可用显式动作）');
  }
  lines.push(
    `  budget: batch=${view.budget.batchId} revision=${view.budget.budgetRevision} ` +
      `token=${view.budget.usage.tokenUsed ?? 'unknown'} cost=${view.budget.usage.costUsed ?? 'unknown'} ` +
      `runs=${view.budget.counters.runsCreated} attempts=${view.budget.counters.attemptsCreated} ` +
      `runtimeStarts=${view.budget.counters.runtimeStarts}`,
  );
  if (view.continuations.length === 0) {
    lines.push('  无续接记录/无恢复记录：该 Run 尚无同 Task 续接历史');
  }
  for (const entry of view.continuations) {
    lines.push(
      `  attempt=${entry.attemptId} task=${entry.taskId} #${entry.attemptNumber} ` +
        `requested=${entry.requestedMode}/${entry.requestedKind ?? 'none'} decided=${entry.decidedMode} ` +
        `source=${entry.sourceAttemptId ?? 'none'} archive=${entry.nativeArchiveRef ?? 'none'} ` +
        `reasons=${entry.decidedReasons.join(',') || 'none'}`,
    );
    if (entry.handoff !== null) {
      lines.push(`    handoff: previous=${entry.handoff.previousAttemptId}/${entry.handoff.previousStatus}`);
    }
    if (entry.degraded !== null) {
      lines.push(`    降级：${entry.degraded.note}`);
    }
  }
  if (view.recoveryTruncated) {
    lines.push('  records: truncated（超限截断，完整列表走 Host 查询）');
  }
  lines.push(`  ${view.note}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
