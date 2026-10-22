/**
 * P03-4 / F-009 调度诊断与 Attempt 审计 CLI 纯视图层（结构化输出与人类行）。
 *
 * 纯函数模块（无 I/O）：把 HostClient 已线校验的 F-008 查询结果
 * （execution.run.schedule / execution.attempts.list /
 * execution.attempt.diagnostics）投影为 CLI 结构化视图：
 * - 派生分类只是只读投影，不改写权威事实、不产生第二套状态：
 *   - `all_passed` + handoff 仅移交 Feature 最终验收（awaiting），不是交付成功；
 *   - Attempt `verifying` 是 Runtime 结果待验证，不是验收通过；
 *   - Attempt `failed` + preflight 是准备失败（保留 stage/errorKind）；
 *   - 任务 `waiting_approval`/manualBlock 是审批等待；`resource_busy` 与
 *     quarantined 占用是资源隔离；
 *   - accepted、无 ready、执行文本成功（exitCode=0）一律不显示为交付成功
 *     （completion.featureVerified/delivered 恒 false）；
 * - 未启动/未知值保持 null（不填零）；executionStage 原样展示；
 * - 人类行只输出脱敏事实字段；不打印正文、凭据、秘密或开发机路径。
 */
import type {
  AttemptDiagnosticsResult,
  AttemptListResult,
  DispatchQueueListResult,
  PublicDispatchQueueRecord,
  PublicDispatchSlotSummary,
  RunScheduleStatusResult,
} from 'shiploop-host';

/* ------------------------------------------------------------------ *
 * execution.schedule（Run 调度诊断）视图
 * ------------------------------------------------------------------ */

/** Run 级派生就绪分类（只读投影；不落库、不是第二套状态）。 */
export type RunScheduleReadinessState =
  | 'awaiting_feature_final_verification'
  | 'ready'
  | 'blocked'
  | 'invalid_graph';

/** 调度视图统一的不交付声明（accepted/无 ready/执行文本成功都不是交付成功）。 */
export interface ScheduleCompletionBoundary {
  readonly featureVerified: false;
  readonly delivered: false;
  readonly note: string;
}

const SCHEDULE_COMPLETION_NOTE =
  '调度诊断是只读派生视图：accepted、无 ready 或执行文本成功均不代表交付成功；' +
  'all_passed 仅移交 Feature 最终验收；本 Feature（P03-4）尚无完整执行/验证闭环';

function completionBoundary(): ScheduleCompletionBoundary {
  return { featureVerified: false, delivered: false, note: SCHEDULE_COMPLETION_NOTE };
}

export interface ExecutionScheduleReadiness {
  readonly state: RunScheduleReadinessState;
  /** 稳定候选（拓扑序；invalid_graph 时为空，不伪造 ready）。 */
  readonly readyTaskIds: readonly string[];
  /** all_passed + handoff：全部受信通过仅移交 Feature 最终验收（不是交付成功）。 */
  readonly allPassedPendingFinalVerification: boolean;
  /** Runtime 结果待验证（最近 Attempt verifying）的任务。 */
  readonly runtimeResultPendingVerificationTaskIds: readonly string[];
  /** 准备失败（最近 Attempt failed 且执行阶段 preflight）的任务。 */
  readonly preparationFailedTaskIds: readonly string[];
  /** 审批等待（waiting_approval 或 manualBlock）的任务。 */
  readonly waitingApprovalTaskIds: readonly string[];
  /** 资源隔离（resource_busy）的任务。 */
  readonly resourceBusyTaskIds: readonly string[];
  /** 隔离占用（quarantined）与持有占用（held）的规范化资源键（哈希键，不是路径）。 */
  readonly quarantinedResourceKeys: readonly string[];
  readonly heldResourceKeys: readonly string[];
}

export interface ExecutionScheduleView {
  readonly operation: 'execution.run.schedule';
  readonly run: RunScheduleStatusResult['run'];
  readonly schedule: RunScheduleStatusResult['schedule'];
  readonly readiness: ExecutionScheduleReadiness;
  readonly completion: ScheduleCompletionBoundary;
  readonly tasks: RunScheduleStatusResult['tasks'];
  readonly occupancy: RunScheduleStatusResult['occupancy'];
}

export function buildExecutionScheduleView(
  result: RunScheduleStatusResult,
): ExecutionScheduleView {
  const allPassedPendingFinalVerification =
    result.schedule.reason === 'all_passed' &&
    result.schedule.handoff === 'feature_final_verification';
  const runtimeResultPendingVerificationTaskIds = result.tasks
    .filter((task) => task.latestAttempt?.status === 'verifying')
    .map((task) => task.taskId);
  const preparationFailedTaskIds = result.tasks
    .filter(
      (task) =>
        task.latestAttempt?.status === 'failed' &&
        task.latestAttempt.executionStage === 'preflight',
    )
    .map((task) => task.taskId);
  const waitingApprovalTaskIds = result.tasks
    .filter((task) => task.reason === 'waiting_approval' || task.manualBlock)
    .map((task) => task.taskId);
  const resourceBusyTaskIds = result.tasks
    .filter((task) => task.reason === 'resource_busy')
    .map((task) => task.taskId);
  const quarantinedResourceKeys = result.occupancy
    .filter((lease) => lease.state === 'quarantined')
    .map((lease) => lease.resourceKey);
  const heldResourceKeys = result.occupancy
    .filter((lease) => lease.state === 'held')
    .map((lease) => lease.resourceKey);
  const state: RunScheduleReadinessState = allPassedPendingFinalVerification
    ? 'awaiting_feature_final_verification'
    : result.schedule.reason === 'invalid_graph'
      ? 'invalid_graph'
      : result.schedule.readyTaskIds.length > 0
        ? 'ready'
        : 'blocked';
  return {
    operation: 'execution.run.schedule',
    run: result.run,
    schedule: result.schedule,
    readiness: {
      state,
      readyTaskIds: result.schedule.readyTaskIds,
      allPassedPendingFinalVerification,
      runtimeResultPendingVerificationTaskIds,
      preparationFailedTaskIds,
      waitingApprovalTaskIds,
      resourceBusyTaskIds,
      quarantinedResourceKeys,
      heldResourceKeys,
    },
    completion: completionBoundary(),
    tasks: result.tasks,
    occupancy: result.occupancy,
  };
}

export function formatExecutionScheduleView(view: ExecutionScheduleView): string {
  const { readiness } = view;
  const tasks = view.tasks
    .map((task) => {
      const attempt = task.latestAttempt;
      const attemptText =
        attempt === null
          ? 'attempt=none'
          : `attempt=${attempt.id}#${attempt.number} status=${attempt.status} stage=${attempt.executionStage}`;
      return (
        `  task=${task.taskId} status=${task.status} reason=${task.reason} ` +
        `executionVersion=${task.executionVersion} manualBlock=${task.manualBlock} ${attemptText}`
      );
    })
    .join('\n');
  const occupancy =
    view.occupancy.length === 0
      ? '  occupancy=none'
      : view.occupancy
          .map(
            (lease) =>
              `  lease=${lease.id} state=${lease.state} kind=${lease.resourceKind} ` +
              `key=${lease.resourceKey} ownerAttempt=${lease.attemptId} ownerRun=${lease.runId}`,
          )
          .join('\n');
  return [
    `shiploop execution schedule: run=${view.run.id} status=${view.run.status} ` +
      `readiness=${readiness.state} reason=${view.schedule.reason} ` +
      `ready=${readiness.readyTaskIds.length > 0 ? readiness.readyTaskIds.join(',') : 'none'} ` +
      `handoff=${view.schedule.handoff ?? 'none'}`,
    tasks,
    occupancy,
    `  （${SCHEDULE_COMPLETION_NOTE}）`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.attempts（Task 的 Attempt 审计）视图
 * ------------------------------------------------------------------ */

/** Attempt 记录的派生分类（只读投影；状态/阶段原样保留）。 */
export interface AttemptAuditClassification {
  /** Runtime 结果待验证（status=verifying；不是验收通过）。 */
  readonly runtimeResultPendingVerification: boolean;
  /** 准备失败（status=failed 且 executionStage=preflight）。 */
  readonly preparationFailed: boolean;
  /** Attempt 级成功（succeeded 只是 Attempt 完成，不代表 Task 通过或交付）。 */
  readonly attemptSucceeded: boolean;
}

export interface ExecutionAttemptAuditRecord {
  readonly record: AttemptListResult['records'][number];
  readonly classification: AttemptAuditClassification;
}

export interface ExecutionAttemptsView {
  readonly operation: 'execution.attempts.list';
  readonly projectId: string;
  readonly taskId: string;
  readonly records: readonly ExecutionAttemptAuditRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completion: ScheduleCompletionBoundary;
}

export function buildExecutionAttemptsView(
  result: AttemptListResult,
): ExecutionAttemptsView {
  const records: ExecutionAttemptAuditRecord[] = result.records.map((record) => ({
    record,
    classification: {
      runtimeResultPendingVerification: record.status === 'verifying',
      preparationFailed: record.status === 'failed' && record.executionStage === 'preflight',
      attemptSucceeded: record.status === 'succeeded',
    },
  }));
  const first = result.records[0];
  return {
    operation: 'execution.attempts.list',
    projectId: first?.projectId ?? '',
    taskId: first?.taskId ?? '',
    records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    completion: completionBoundary(),
  };
}

export function formatExecutionAttemptsView(view: ExecutionAttemptsView): string {
  const lines = [
    `shiploop execution attempts: task=${view.taskId === '' ? 'unknown' : view.taskId} ` +
      `records=${view.records.length} nextCursor=${view.nextCursor ?? 'none'}`,
  ];
  for (const entry of view.records) {
    const record = entry.record;
    const marks: string[] = [];
    if (entry.classification.runtimeResultPendingVerification) {
      marks.push('runtime_result_pending_verification');
    }
    if (entry.classification.preparationFailed) {
      marks.push('preparation_failed');
    }
    const markText = marks.length > 0 ? ` marks=${marks.join(',')}` : '';
    lines.push(
      `  attempt=${record.id}#${record.number} run=${record.runId} owner=${record.owner} ` +
        `host=${record.hostInstanceId} executionVersion=${record.executionVersion} ` +
        `status=${record.status} stage=${record.executionStage} ` +
        `exit=${record.exitCode === null ? 'unknown' : record.exitCode} ` +
        `durationMs=${record.durationMs === null ? 'unknown' : record.durationMs} ` +
        `errorKind=${record.errorKind ?? 'none'}${markText}`,
    );
  }
  lines.push(`  （${SCHEDULE_COMPLETION_NOTE}）`, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.diagnostics（Attempt 迟到/越权通知诊断审计）视图
 * ------------------------------------------------------------------ */

export interface ExecutionDiagnosticsView {
  readonly operation: 'execution.attempt.diagnostics';
  readonly records: AttemptDiagnosticsResult['records'];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completion: ScheduleCompletionBoundary;
}

export function buildExecutionDiagnosticsView(
  result: AttemptDiagnosticsResult,
): ExecutionDiagnosticsView {
  return {
    operation: 'execution.attempt.diagnostics',
    records: result.records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    completion: completionBoundary(),
  };
}

export function formatExecutionDiagnosticsView(view: ExecutionDiagnosticsView): string {
  const lines = [
    `shiploop execution diagnostics: records=${view.records.length} ` +
      `nextCursor=${view.nextCursor ?? 'none'}`,
  ];
  for (const record of view.records) {
    lines.push(
      `  diagnostic=${record.id} attempt=${record.attemptId} reason=${record.reason} ` +
        `digest=${record.notificationDigest} occurredAt=${record.occurredAt}`,
    );
  }
  lines.push(`  （诊断只保留同项目 Attempt 链接、摘要、固定原因与时间；不保留原通知正文/身份/路径）`, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * execution.dispatch（派发队列与执行槽位只读投影）视图
 *
 * 只展示 F-008 已派生的持久事实（Run/认领/槽位/Attempt）与槽位摘要：
 * - 槽位摘要是全局计数 + 跨项目布尔，不展开其他项目/Run/owner 身份；
 * - 等待/隔离原因复用 Core 冻结词汇，转成可理解中文说明（不新增状态）；
 * - Runtime 正常返回、Attempt succeeded 或占槽一律不是验证通过或交付成功。
 * ------------------------------------------------------------------ */

type DispatchBlockingReason = NonNullable<PublicDispatchQueueRecord['blockingReason']>;

/** 等待/隔离分类（只读投影；不落库、不是第二套状态）。 */
export type DispatchWaitCategory = 'none' | 'slot' | 'isolation' | 'control';

interface DispatchReasonExplanation {
  readonly category: DispatchWaitCategory;
  readonly text: string;
}

/** 有界阻塞原因 → 可理解说明（与 Core 冻结词汇一一对应）。 */
const DISPATCH_REASON_EXPLANATIONS: Readonly<
  Record<DispatchBlockingReason, DispatchReasonExplanation>
> = {
  execution_slot_unavailable: {
    category: 'slot',
    text: '等待执行槽位：容量已被占用，不会因为排队自动提升并发或插队',
  },
  claim_quarantined: {
    category: 'isolation',
    text: '派发认领已隔离：需先核对旧 Runner 已停止及副作用后人工处理，不会自动重新派发',
  },
  claim_lease_expired_unverified: {
    category: 'isolation',
    text: '认领租约到期但未确认停止：先核对进程与副作用，不把到期当已停止',
  },
  slot_quarantined: {
    category: 'isolation',
    text: '执行槽位已隔离：核对停止后才能释放，查询不会自动回收',
  },
  slot_ownership_missing: {
    category: 'isolation',
    text: '缺少可核对槽位归属：不会自动补建、释放或唤醒执行',
  },
  slot_identity_mismatch: {
    category: 'isolation',
    text: '槽位归属与当前认领不一致：需人工核对，旧身份不能释放新槽位',
  },
  claim_attempt_identity_mismatch: {
    category: 'isolation',
    text: '活动 Attempt 身份与认领不一致：需人工核对，迟到结果不能改写当前状态',
  },
  run_paused: {
    category: 'control',
    text: 'Run 已暂停：不派发新工作，查询不会自动恢复',
  },
  run_cancelling: {
    category: 'control',
    text: 'Run 正在取消：不派发新工作',
  },
  run_interrupted: {
    category: 'control',
    text: 'Run 已中断：需按恢复政策核对占用与停止证据后另行派发',
  },
};

const DISPATCH_COMPLETION_NOTE =
  '派发/槽位查询是只读投影：Runtime 正常返回、Attempt succeeded 或已占槽均不代表验证通过或交付成功；' +
  '本查询不认领、不扣预算、不唤醒执行，也不释放隔离槽位';

export interface ExecutionDispatchRecordView {
  readonly record: PublicDispatchQueueRecord;
  readonly waitCategory: DispatchWaitCategory;
  /** 有界可理解原因；无阻塞为 null。 */
  readonly blockingExplanation: string | null;
}

export interface ExecutionDispatchView {
  readonly operation: 'execution.dispatch.list';
  /** 槽位摘要：容量/全局活动与隔离计数/本项活动/跨项目布尔。 */
  readonly slots: PublicDispatchSlotSummary;
  readonly records: readonly ExecutionDispatchRecordView[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly completion: ScheduleCompletionBoundary;
}

export function buildExecutionDispatchView(
  result: DispatchQueueListResult,
): ExecutionDispatchView {
  const records: ExecutionDispatchRecordView[] = result.records.map((record) => {
    const explanation =
      record.blockingReason === null
        ? null
        : DISPATCH_REASON_EXPLANATIONS[record.blockingReason];
    return {
      record,
      waitCategory: explanation === null ? 'none' : explanation.category,
      blockingExplanation: explanation === null ? null : explanation.text,
    };
  });
  return {
    operation: 'execution.dispatch.list',
    slots: result.slots,
    records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    completion: {
      featureVerified: false,
      delivered: false,
      note: DISPATCH_COMPLETION_NOTE,
    },
  };
}

/** 人类行：只输出脱敏事实字段与受控原因；不打印正文、凭据或开发机路径。 */
export function formatExecutionDispatchView(view: ExecutionDispatchView): string {
  const { slots } = view;
  const lines = [
    `shiploop execution dispatch: slots capacity=${slots.capacity} active=${slots.activeCount} ` +
      `available=${slots.availableCount} quarantined=${slots.quarantinedCount} ` +
      `projectActive=${slots.projectActiveCount} otherProjectActive=${slots.otherProjectActive} ` +
      `records=${view.records.length} nextCursor=${view.nextCursor ?? 'none'}`,
  ];
  for (const entry of view.records) {
    const record = entry.record;
    const claim = record.claim;
    const slot = record.slot;
    const attempt = record.activeAttempt ?? record.latestAttempt;
    lines.push(
      `  run=${record.runId} feature=${record.featureId} runStatus=${record.runStatus} ` +
        `runReason=${record.runReason ?? 'none'} dispatchOrdinal=${record.dispatchOrdinal} ` +
        `state=${record.state} blocking=${record.blockingReason ?? 'none'} wait=${entry.waitCategory}`,
    );
    lines.push(
      `    claim=${claim === null ? 'none' : claim.claimId} ` +
        `claimVersion=${claim === null ? 'none' : claim.claimVersion} ` +
        `owner=${claim === null ? 'none' : claim.ownerId} ` +
        `claimState=${claim === null ? 'none' : claim.state} ` +
        `slot=${slot === null ? 'none' : slot.slotId} ` +
        `slotIndex=${slot === null ? 'none' : slot.slotIndex} ` +
        `slotState=${slot === null ? 'none' : slot.state} ` +
        `attempt=${attempt === null ? 'none' : `${attempt.id}#${attempt.number}`} ` +
        `stage=${attempt === null ? 'none' : attempt.executionStage} attempts=${record.attemptCount}`,
    );
    if (entry.blockingExplanation !== null) {
      lines.push(`    reason: ${entry.blockingExplanation}`);
    }
  }
  lines.push(`  （${DISPATCH_COMPLETION_NOTE}）`, '');
  return lines.join('\n');
}
