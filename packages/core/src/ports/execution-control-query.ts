/**
 * P03-9 / F-013 Run/Batch 控制进度、恢复诊断与 finalization 收尾结果只读查询
 *（ports 契约层：操作身份、冻结词汇、只读视图与纯投影；无 I/O、无写原语）。
 *
 * 设计依据：input/p03-run-control.md FR-1/FR-2/FR-3（控制进度、恢复诊断与
 * retryFinal 收尾结果按查询暴露）、core-design/04-scheduling-and-recovery.md
 *（状态与原因来自持久 SQLite，不以日志推断完成）、P03-9 F-001/F-002/F-003
 *（pauseRequestedAt、停止 operation 与隔离/停止证据）、F-007/F-008（恢复
 * 请求/实际模式与来源快照）与 F-010/F-012（finalization scope 与分轴结果）。
 *
 * 契约要点：
 * - 全部内容取自持久 SQLite 一致读视图（ExecutionControlQueryReadStore，
 *   适配器以 BEGIN DEFERRED 读事务组装）；查询零写入、零事件、零唤醒、
 *   零续租——不创建 Attempt、不扣预算、不启动或停止任何执行；重复查询
 *   不产生执行、计数或副作用；
 * - 控制查询展示 pausing/cancelling/paused/interrupted 的持久状态与原因、
 *   关联 Attempt、停止 operation、停止/隔离证据引用（Artifact 身份）与
 *   从持久事实派生的显式后续动作；绝不内联日志/输出正文，绝不以日志、
 *   Runtime 声明或事件流推断完成；
 * - 恢复查询展示 finalization-only Run 的受限 scope（来源、缺失步骤、零
 *   编码承诺）、同 Run Attempt 的续接记录（请求模式 vs 实际决策、来源
 *   Attempt/Session 引用）、父 Batch 累计预算与计数，以及复用 P03-8 F-010
 *   公共形状的 Task/最终检查/审批/提交分轴事实——不新增第二套业务事实源；
 * - 未知即 null：未启动时间、耗时、退出码、用量、停止确认与强制升级保持
 *   null（不以 0 或 false 冒充）；历史 Attempt/Run 全部可追溯（有界列出，
 *   超限置 truncated 标记）；
 * - 跨项目/不存在目标统一 undefined（应用层折叠为 not_found，不泄漏存在
 *   性）；损坏持久 JSON/scope fail-closed（corrupt_state），不折算空结果；
 * - finalization scope 是写入 Run.input_snapshot 的身份级快照（F-010 契约），
 *   本层只做读取校验；审批/提交轴结论一律来自持久事实重建。
 */
import type {
  AttemptExecutionStage,
  AttemptRecord,
  AttemptStatus,
  WorkspaceLeaseRecord,
} from './attempt-store.js';
import type {
  ExecutionBatchRecord,
  ExecutionBatchStatus,
  ExecutionRunStatus,
  ExecutionStopOperationRecord,
  ExecutionStopOperationStatus,
  RunRecord,
} from './execution-store.js';
import type {
  FinalizationEvidenceReason,
  FinalizationPendingStep,
  FinalizationRetryScope,
} from './finalization-retry.js';
import {
  FINALIZATION_EVIDENCE_REASONS,
  FINALIZATION_PENDING_STEPS,
} from './finalization-retry.js';
import type { WorkRecoveryContinuationRecord } from './work-recovery-continuation.js';
import type { ExecutionBudgetSnapshot } from './execution-budget.js';
import type { FeatureDeliveryDetailResult, FeatureDeliveryView } from './feature-delivery-query.js';
import { buildFeatureDeliveryDetailResult } from './feature-delivery-query.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import { readFixedExecutionBatchFeatureIds } from './execution-budget-query.js';
import type { ValidationContext } from './validation.js';
import type {
  FeatureResourceLeaseRecord,
  FeatureResourceWaitReason,
} from './feature-resources.js';

/* ------------------------------------------------------------------ *
 * 操作身份（PublicError.operation 与 Host 路由共用；冻结词汇）
 * ------------------------------------------------------------------ */

export const EXECUTION_RUN_CONTROL_GET_OPERATION = 'execution.run.control.get' as const;
export const EXECUTION_BATCH_CONTROL_GET_OPERATION = 'execution.batch.control.get' as const;
export const EXECUTION_RUN_RECOVERY_GET_OPERATION = 'execution.run.recovery.get' as const;

export const EXECUTION_RESOURCE_LIST_OPERATION = 'execution.resources.list' as const;

export const EXECUTION_CONTROL_QUERY_OPERATIONS = [
  EXECUTION_RUN_CONTROL_GET_OPERATION,
  EXECUTION_BATCH_CONTROL_GET_OPERATION,
  EXECUTION_RUN_RECOVERY_GET_OPERATION,
  EXECUTION_RESOURCE_LIST_OPERATION,
] as const;

export type ExecutionControlQueryOperation = (typeof EXECUTION_CONTROL_QUERY_OPERATIONS)[number];
export interface ExecutionResourceListRequest {
  readonly after: { readonly sort: number; readonly id: string } | null;
  readonly limit: number;
}

export interface ExecutionResourceListSelector {
  readonly featureId?: string;
  readonly batchId?: string;
}

export interface ExecutionResourceQueryRow {
  readonly lease: FeatureResourceLeaseRecord;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
}

export interface ExecutionResourceListPage {
  readonly records: readonly ExecutionResourceQueryRow[];
  readonly nextKey: { readonly sort: number; readonly id: string } | null;
}

export type PublicResourceBlockingReason =
  | 'resource_conflict'
  | 'stop_verification'
  | 'authorization_blocked';

export interface PublicExecutionResourceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly ownerVersion: number;
  readonly revision: number;
  readonly kind: FeatureResourceLeaseRecord['resource']['kind'];
  readonly accessMode: FeatureResourceLeaseRecord['resource']['accessMode'];
  readonly leaseMode: FeatureResourceLeaseRecord['resource']['leaseMode'];
  readonly resourceKey: string;
  readonly state: 'held' | 'quarantined';
  readonly waitingReason: FeatureResourceWaitReason | null;
  readonly blockingReason: PublicResourceBlockingReason | null;
  readonly acquiredAt: string;
  readonly leaseUntil: string;
}

export interface ResourceListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'execution-resources';
  readonly records: readonly PublicExecutionResourceRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}


/** 单目标 Attempt 展示上限（与调度查询分页同一量级）。 */
export const EXECUTION_CONTROL_ATTEMPTS_MAX = 200;
/** Batch 视图 Run 展示上限（单 Feature Batch 的 Run 数受 maxRuns 约束）。 */
export const EXECUTION_CONTROL_RUNS_MAX = 50;
/** 停止 operation 展示上限（取消/停止 operation 与命令一一对应）。 */
export const EXECUTION_CONTROL_STOP_OPERATIONS_MAX = 50;
/** 恢复查询续接记录展示上限。 */
export const EXECUTION_RECOVERY_CONTINUATIONS_MAX = 200;

/* ------------------------------------------------------------------ *
 * 显式后续动作（冻结词汇；均为授权命令/人工动作，绝不暗示自动执行）
 * ------------------------------------------------------------------ */

/**
 * - none：无可用动作（活动执行、等待收尾或终态且无需显式后续）；
 * - resume：目标 paused（或 Batch 内有 paused Run）且无未收尾占用 → 显式
 *   execution.resume；
 * - resume_blocked_occupancy：可 resume 但仍有活动 Attempt/held/quarantined
 *   租约——先收尾占用，resume 会被既有授权拒绝；
 * - await_attempt_settlement：pausing 等待当前 Attempt 验证/收尾后转 paused；
 * - await_stop_settlement：cancelling/stopping 等待停止 operation 结算；
 * - stop_reconcile：停止 operation uncertain——先核对停止证据（evidenceRef），
 *   不冒充已停止；
 * - retry_final：finalization-only Run 失败终态——显式 execution.retryFinal
 *   只重试收尾步骤。
 */
export const EXECUTION_CONTROL_NEXT_ACTIONS = [
  'none',
  'resume',
  'resume_blocked_occupancy',
  'await_attempt_settlement',
  'await_stop_settlement',
  'stop_reconcile',
  'retry_final',
] as const;
export type ExecutionControlNextAction = (typeof EXECUTION_CONTROL_NEXT_ACTIONS)[number];

/* ------------------------------------------------------------------ *
 * 一致读视图（adapters 层产出；应用层授权完成后消费）
 * ------------------------------------------------------------------ */

/** Attempt 占用租约条目（state 原样：held/quarantined 都是未收尾占用）。 */
export interface ExecutionControlLeaseEntry {
  readonly lease: WorkspaceLeaseRecord;
  readonly attemptId: string;
}

/** Run 控制视图（同一 BEGIN DEFERRED 读事务内组装）。 */
export interface ExecutionRunControlView {
  readonly run: RunRecord;
  readonly batch: ExecutionBatchRecord;
  /** Run 下全部 Attempt（稳定 (task_id,number,id) 升序；有界）。 */
  readonly attempts: readonly AttemptRecord[];
  readonly attemptsTruncated: boolean;
  /** 关联停止 operation：run 级目标 + 父 Batch 级目标（requested_at,id 升序；有界）。 */
  readonly stopOperations: readonly ExecutionStopOperationRecord[];
  /** 该 Run 的 Attempt 仍未释放的租约（含 held/quarantined）。 */
  readonly leases: readonly ExecutionControlLeaseEntry[];
}

/** Batch 控制视图（含子 Run/Attempt 有界扫描）。 */
export interface ExecutionBatchControlView {
  readonly batch: ExecutionBatchRecord;
  readonly runs: readonly RunRecord[];
  readonly runsTruncated: boolean;
  readonly attempts: readonly AttemptRecord[];
  readonly attemptsTruncated: boolean;
  readonly stopOperations: readonly ExecutionStopOperationRecord[];
  readonly leases: readonly ExecutionControlLeaseEntry[];
}

/** 恢复查询的续接记录条目（Attempt + 已校验续接记录）。 */
export interface ExecutionRunRecoveryContinuationEntry {
  readonly attempt: AttemptRecord;
  readonly recovery: WorkRecoveryContinuationRecord;
}

/** Run 恢复/收尾视图（finalization scope 与分轴事实同视图组装）。 */
export interface ExecutionRunRecoveryView {
  readonly run: RunRecord;
  readonly batch: ExecutionBatchRecord;
  /** Run.input_snapshot.finalization（非 finalization-only Run 为 null）。 */
  readonly finalization: FinalizationRetryScope | null;
  /** 带 F-007 续接记录的 Attempt（稳定 (task_id,number,id) 升序；有界）。 */
  readonly continuations: readonly ExecutionRunRecoveryContinuationEntry[];
  readonly continuationsTruncated: boolean;
  /** 实际扫描的 Attempt 总数（含无续接记录者；供 truncated 语义核对）。 */
  readonly attemptsScanned: number;
  /** Feature 分轴持久事实（复用 P03-8 F-010 同一读视图）。 */
  readonly delivery: FeatureDeliveryView;
}

/**
 * 控制查询只读窄端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（存在性折叠由应用层完成）；持久行/JSON 损坏 fail-closed
 *（StorageError corrupt），不把损坏内容折算成空结果。
 */
export interface ExecutionControlQueryReadStore {
  readRunControlView(projectId: unknown, runId: unknown): ExecutionRunControlView | undefined;
  readBatchControlView(projectId: unknown, batchId: unknown): ExecutionBatchControlView | undefined;
  readRunRecoveryView(projectId: unknown, runId: unknown): ExecutionRunRecoveryView | undefined;
  listFeatureResourceRecords(
    projectId: unknown,
    request: ExecutionResourceListRequest,
    selector?: ExecutionResourceListSelector,
  ): ExecutionResourceListPage;
}

/* ------------------------------------------------------------------ *
 * finalization scope 读取校验（身份级快照；损坏 fail-closed）
 * ------------------------------------------------------------------ */

const SCOPE_CONTEXT: ValidationContext = { operation: 'ExecutionControlQuery.validate' };

function scopeObject(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const raw = requirePlainObject(value, SCOPE_CONTEXT, field);
  rejectUnknownKeys(raw, keys, SCOPE_CONTEXT, field);
  return raw;
}

function scopeDigest(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validationError(SCOPE_CONTEXT, field, 'invalid_digest');
  return validateSha256Digest(value, SCOPE_CONTEXT, field);
}

function scopeId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validationError(SCOPE_CONTEXT, field, 'invalid_id');
  return validateStableId(value, SCOPE_CONTEXT, field);
}

function scopeInt(value: unknown, field: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw validationError(SCOPE_CONTEXT, field, 'invalid_safe_integer');
  }
  return value;
}

function scopeBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(SCOPE_CONTEXT, field, 'invalid_boolean');
  return value;
}

function scopeTextOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError(SCOPE_CONTEXT, field, 'invalid_text');
  return value;
}

function scopeIdOrNull(value: unknown, field: string): string | null {
  return value === null ? null : scopeId(value, field);
}

function scopeBoundedTextArray(
  value: unknown,
  field: string,
  allowed: readonly string[] | null,
): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw validationError(SCOPE_CONTEXT, field, 'invalid_bounded_array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw validationError(SCOPE_CONTEXT, `${field}[${index}]`, 'invalid_text');
    }
    if (allowed !== null && !allowed.includes(entry)) {
      throw validationError(SCOPE_CONTEXT, `${field}[${index}]`, 'invalid_enum');
    }
    return entry;
  });
}

function scopeRevalidateTasks(value: unknown, field: string): FinalizationRetryScope['revalidateTasks'] {
  if (!Array.isArray(value) || value.length > 256) {
    throw validationError(SCOPE_CONTEXT, field, 'invalid_bounded_array');
  }
  return value.map((entry, index) => {
    const raw = scopeObject(entry, ['taskId', 'checkKeys', 'reasons'], `${field}[${index}]`);
    return {
      taskId: scopeId(raw.taskId, `${field}[${index}].taskId`),
      checkKeys: scopeBoundedTextArray(raw.checkKeys, `${field}[${index}].checkKeys`, null),
      reasons: scopeBoundedTextArray(
        raw.reasons,
        `${field}[${index}].reasons`,
        FINALIZATION_EVIDENCE_REASONS,
      ) as readonly FinalizationEvidenceReason[],
    };
  });
}

/**
 * 校验 Run.input_snapshot.finalization（F-010 写入的受限收尾 scope）。
 * 无该键（或 null）返回 null（普通 Work Run）；存在但形状非法时抛
 * validationError（适配器折算 corrupt_state，绝不静默降级成普通 Run）。
 */
export function validateRunFinalizationScope(value: unknown): FinalizationRetryScope | null {
  if (value === undefined || value === null) return null;
  const raw = scopeObject(value, [
    'schemaVersion',
    'kind',
    'retryPlanDigest',
    'historicalRunId',
    'historicalBatchId',
    'historicalRunStatus',
    'historicalRunDispatchOrdinal',
    'planDigest',
    'checkPolicyDigest',
    'headCommit',
    'codeDigest',
    'workspaceId',
    'workspaceRevision',
    'retainedTaskIds',
    'revalidateTasks',
    'finalVerification',
    'approval',
    'commit',
    'missingSteps',
    'codingTaskIds',
    'runtimeStarts',
    'newAttempts',
  ], 'finalization');
  if (raw.schemaVersion !== 1) {
    throw validationError(SCOPE_CONTEXT, 'finalization.schemaVersion', 'unsupported_schema_version');
  }
  if (raw.kind !== 'finalization-only') {
    throw validationError(SCOPE_CONTEXT, 'finalization.kind', 'invalid_kind');
  }
  const headCommit = raw.headCommit;
  if (typeof headCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headCommit)) {
    throw validationError(SCOPE_CONTEXT, 'finalization.headCommit', 'invalid_commit');
  }
  const finalVerification = scopeObject(
    raw.finalVerification,
    ['required', 'checkKeys'],
    'finalization.finalVerification',
  );
  const approval = scopeObject(
    raw.approval,
    ['required', 'valid', 'approvalItemId', 'reason'],
    'finalization.approval',
  );
  if (approval.required !== true) {
    throw validationError(SCOPE_CONTEXT, 'finalization.approval.required', 'approval_required');
  }
  const commit = scopeObject(
    raw.commit,
    ['required', 'reconcileRequired', 'deliveryStatus', 'operationId', 'reason'],
    'finalization.commit',
  );
  const deliveryStatus = commit.deliveryStatus;
  if (
    deliveryStatus !== 'not_requested' &&
    deliveryStatus !== 'pending' &&
    deliveryStatus !== 'succeeded' &&
    deliveryStatus !== 'failed'
  ) {
    throw validationError(SCOPE_CONTEXT, 'finalization.commit.deliveryStatus', 'invalid_enum');
  }
  if (
    raw.codingTaskIds !== undefined &&
    Array.isArray(raw.codingTaskIds) &&
    raw.codingTaskIds.length !== 0
  ) {
    throw validationError(SCOPE_CONTEXT, 'finalization.codingTaskIds', 'coding_forbidden');
  }
  if (raw.runtimeStarts !== 0 || raw.newAttempts !== 0) {
    throw validationError(SCOPE_CONTEXT, 'finalization.runtimeStarts', 'must_be_zero');
  }
  return {
    schemaVersion: 1,
    kind: 'finalization-only',
    retryPlanDigest: scopeDigest(raw.retryPlanDigest, 'finalization.retryPlanDigest'),
    historicalRunId: scopeId(raw.historicalRunId, 'finalization.historicalRunId'),
    historicalBatchId: scopeId(raw.historicalBatchId, 'finalization.historicalBatchId'),
    historicalRunStatus: scopeTextOrNull(raw.historicalRunStatus, 'finalization.historicalRunStatus') ?? '',
    historicalRunDispatchOrdinal: scopeInt(raw.historicalRunDispatchOrdinal, 'finalization.historicalRunDispatchOrdinal', 0),
    planDigest: scopeDigest(raw.planDigest, 'finalization.planDigest'),
    checkPolicyDigest: scopeDigest(raw.checkPolicyDigest, 'finalization.checkPolicyDigest'),
    headCommit,
    codeDigest: scopeDigest(raw.codeDigest, 'finalization.codeDigest'),
    workspaceId: scopeId(raw.workspaceId, 'finalization.workspaceId'),
    workspaceRevision: scopeInt(raw.workspaceRevision, 'finalization.workspaceRevision', 1),
    retainedTaskIds: scopeBoundedTextArray(raw.retainedTaskIds, 'finalization.retainedTaskIds', null),
    revalidateTasks: scopeRevalidateTasks(raw.revalidateTasks, 'finalization.revalidateTasks'),
    finalVerification: {
      required: scopeBool(finalVerification.required, 'finalization.finalVerification.required'),
      checkKeys: scopeBoundedTextArray(
        finalVerification.checkKeys,
        'finalization.finalVerification.checkKeys',
        null,
      ),
    },
    approval: {
      required: true,
      valid: scopeBool(approval.valid, 'finalization.approval.valid'),
      approvalItemId: scopeIdOrNull(approval.approvalItemId, 'finalization.approval.approvalItemId'),
      reason: scopeTextOrNull(approval.reason, 'finalization.approval.reason'),
    },
    commit: {
      required: scopeBool(commit.required, 'finalization.commit.required'),
      reconcileRequired: scopeBool(commit.reconcileRequired, 'finalization.commit.reconcileRequired'),
      deliveryStatus,
      operationId: scopeIdOrNull(commit.operationId, 'finalization.commit.operationId'),
      reason: scopeTextOrNull(commit.reason, 'finalization.commit.reason'),
    },
    missingSteps: scopeBoundedTextArray(
      raw.missingSteps,
      'finalization.missingSteps',
      FINALIZATION_PENDING_STEPS,
    ) as readonly FinalizationPendingStep[],
    codingTaskIds: [] as readonly [],
    runtimeStarts: 0,
    newAttempts: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 公开形状（稳定 Schema；时间一律 ISO UTC 或 null）
 * ------------------------------------------------------------------ */

/** Attempt 用量投影（部分上报时未上报维度保持 null；无任何用量为 null）。 */
export interface PublicExecutionControlUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicros: number | null;
  readonly currency: string | null;
}

/** Attempt 控制投影：身份/状态/原因 + 未知即 null 的运行事实。 */
export interface PublicExecutionControlAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly executionStage: AttemptExecutionStage;
  readonly errorKind: string | null;
  /** 停止/失败诊断 Artifact 引用（受控通道读取正文；查询不内联）。 */
  readonly diagnosticRef: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly usage: PublicExecutionControlUsage | null;
}

/** 停止 operation 投影（stopConfirmed/forced 未知保持 null，不以 false 冒充）。 */
export interface PublicExecutionControlStopOperation {
  readonly operationId: string;
  readonly targetKind: 'run' | 'batch' | 'feature';
  readonly targetId: string;
  readonly batchId: string;
  readonly featureId: string | null;
  readonly runId: string | null;
  readonly status: ExecutionStopOperationStatus;
  readonly reason: string;
  readonly requestedAt: string;
  readonly settledAt: string | null;
  /** 停止证据 Artifact 引用（核验前为 null；正文走既有受控 Artifact 通道）。 */
  readonly evidenceRef: string | null;
  readonly stopConfirmed: boolean | null;
  readonly forced: boolean | null;
  readonly checkedAt: string | null;
}

/** Attempt 占用租约投影（held/quarantined 都是未收尾占用，state 原样）。 */
export interface PublicExecutionControlLease {
  readonly leaseId: string;
  readonly attemptId: string;
  readonly resourceKey: string;
  readonly state: 'held' | 'quarantined';
  readonly leaseUntil: string;
}

/** Run 控制简报（持久控制原因原样；未启动/未结束保持 null）。 */
export interface PublicExecutionControlRunBrief {
  readonly runId: string;
  readonly batchId: string;
  readonly featureId: string;
  readonly purpose: string;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly pauseRequestedAt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly updatedAt: string;
}

/** Batch 控制简报（含累计计数；预算明细走 execution.budget.get）。 */
export interface PublicExecutionControlBatchBrief {
  readonly batchId: string;
  readonly featureId: string;
  readonly featureIds?: readonly string[];
  readonly phaseId?: string;
  readonly status: ExecutionBatchStatus;
  readonly reason: string | null;
  readonly pauseRequestedAt: string | null;
  readonly deadlineAt: string;
  readonly budgetRevision: number;
  readonly counters: {
    readonly runsCreated: number;
    readonly attemptsCreated: number;
    readonly runtimeStarts: number;
    readonly noProgressRuns: number;
  };
  readonly updatedAt: string;
}

/** execution.run.control.get 结果。 */
export interface RunControlDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'run-control';
  readonly run: PublicExecutionControlRunBrief;
  readonly batch: PublicExecutionControlBatchBrief;
  readonly attempts: {
    readonly records: readonly PublicExecutionControlAttempt[];
    readonly truncated: boolean;
  };
  readonly stopOperations: readonly PublicExecutionControlStopOperation[];
  readonly leases: readonly PublicExecutionControlLease[];
  readonly nextActions: readonly ExecutionControlNextAction[];
}

/** execution.batch.control.get 结果。 */
export interface BatchControlDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'batch-control';
  readonly batch: PublicExecutionControlBatchBrief;
  readonly runs: {
    readonly records: readonly PublicExecutionControlRunBrief[];
    readonly truncated: boolean;
  };
  readonly attempts: {
    readonly records: readonly PublicExecutionControlAttempt[];
    readonly truncated: boolean;
  };
  readonly stopOperations: readonly PublicExecutionControlStopOperation[];
  readonly leases: readonly PublicExecutionControlLease[];
  readonly nextActions: readonly ExecutionControlNextAction[];
}

/** 续接记录投影：请求模式/来源 vs 实际决策（F-007 记录的只读展示）。 */
export interface PublicExecutionRecoveryContinuation {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly sourceAttemptId: string | null;
  readonly sourceSessionId: string | null;
  readonly requested: {
    readonly mode: 'new' | 'auto' | 'required';
    readonly kind: 'conversation' | 'checkpoint' | null;
    /** 请求来源的原生档案 Artifact 引用（无来源为 null）。 */
    readonly nativeArchiveRef: string | null;
  };
  readonly decided: {
    readonly mode: 'resume' | 'new';
    readonly reasons: readonly string[];
  };
  readonly handoff: {
    readonly previousAttemptId: string;
    readonly previousStatus: string;
  } | null;
  readonly recordedAt: string;
}

/** execution.run.recovery.get 结果。 */
export interface RunRecoveryDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'run-recovery';
  readonly run: {
    readonly runId: string;
    readonly batchId: string;
    readonly featureId: string;
    readonly purpose: string;
    readonly workKey: string;
    readonly dispatchOrdinal: number;
    readonly status: ExecutionRunStatus;
    readonly reason: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
  };
  readonly finalization: {
    /** finalization-only Run 才为 true（scope 来自持久 input_snapshot）。 */
    readonly present: boolean;
    /** 受限收尾 scope 投影（来源、缺失步骤、零编码承诺；非 finalization 为 null）。 */
    readonly scope: FinalizationRetryScope | null;
    /** Task/最终检查/审批/提交分轴事实（复用 P03-8 F-010 公共形状）。 */
    readonly axes: FeatureDeliveryDetailResult['axes'];
  };
  readonly recovery: {
    readonly records: readonly PublicExecutionRecoveryContinuation[];
    readonly truncated: boolean;
    readonly attemptsScanned: number;
  };
  readonly budget: {
    readonly batchId: string;
    readonly budgetRevision: number;
    readonly deadlineAt: string;
    /** 当前批准预算快照（上限身份；用量未知恒 null，不以 0 冒充）。 */
    readonly limits: ExecutionBudgetSnapshot;
    readonly counters: {
      readonly runsCreated: number;
      readonly attemptsCreated: number;
      readonly runtimeStarts: number;
      readonly noProgressRuns: number;
    };
    readonly usage: {
      /** 当前结算账本无用量列：恒 null（未知），与 execution.budget.get 同语义。 */
      readonly tokenUsed: null;
      readonly costUsed: null;
    };
  };
}

/* ------------------------------------------------------------------ *
 * 纯投影与派生（确定性；不读时钟、不产生写入、不解析日志或模型文本）
 * ------------------------------------------------------------------ */

function isoOr(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

/** Attempt 控制投影（usage/退出/耗时未知保持 null；部分上报保留 null 维度）。 */
export function toPublicExecutionControlAttempt(
  record: AttemptRecord,
): PublicExecutionControlAttempt {
  const usage = record.usageSummary;
  return {
    attemptId: record.id,
    taskId: record.taskId,
    attemptNumber: record.number,
    status: record.status,
    executionStage: record.executionStage,
    errorKind: record.errorKind,
    diagnosticRef: record.diagnosticRef,
    startedAt: isoOr(record.startedAtUtcMs),
    endedAt: isoOr(record.endedAtUtcMs),
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    usage:
      usage === null
        ? null
        : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicros: usage.costMicros,
            currency: usage.currency,
          },
  };
}

/** 停止 operation 投影（证据引用原样；未结算时间保持 null）。 */
export function toPublicExecutionControlStopOperation(
  record: ExecutionStopOperationRecord,
): PublicExecutionControlStopOperation {
  return {
    operationId: record.id,
    targetKind: record.targetKind,
    targetId: record.targetId,
    batchId: record.batchId,
    featureId: record.featureId,
    runId: record.runId,
    status: record.status,
    reason: record.reason,
    requestedAt: iso(record.requestedAtUtcMs),
    settledAt: isoOr(record.settledAtUtcMs),
    evidenceRef: record.evidenceRef,
    stopConfirmed: record.stopConfirmed,
    forced: record.forced,
    checkedAt: isoOr(record.checkedAtUtcMs),
  };
}

/** 租约投影（resourceKey 是规范化哈希键，不是路径）。 */
export function toPublicExecutionControlLease(
  entry: ExecutionControlLeaseEntry,
): PublicExecutionControlLease {
  return {
    leaseId: entry.lease.id,
    attemptId: entry.attemptId,
    resourceKey: entry.lease.resourceKey,
    state: entry.lease.state,
    leaseUntil: iso(entry.lease.leaseUntilUtcMs),
  };
}

/** Run 控制简报投影。 */
export function toPublicExecutionControlRunBrief(record: RunRecord): PublicExecutionControlRunBrief {
  return {
    runId: record.id,
    batchId: record.batchId,
    featureId: record.featureId,
    purpose: record.purpose,
    status: record.status,
    reason: record.reason,
    pauseRequestedAt: isoOr(record.pauseRequestedAtUtcMs),
    startedAt: isoOr(record.startedAtUtcMs),
    endedAt: isoOr(record.endedAtUtcMs),
    updatedAt: iso(record.updatedAtUtcMs),
  };
}

/** Batch 控制简报投影（含累计计数；不推断剩余额度）。 */
export function toPublicExecutionControlBatchBrief(
  record: ExecutionBatchRecord,
): PublicExecutionControlBatchBrief {
  const featureIds = readFixedExecutionBatchFeatureIds(record);
  return {
    batchId: record.id,
    featureId: record.featureId,
    ...(featureIds.length > 1 ? { phaseId: record.phaseId, featureIds } : {}),
    status: record.status,
    reason: record.reason,
    pauseRequestedAt: isoOr(record.pauseRequestedAtUtcMs),
    deadlineAt: iso(record.deadlineAtUtcMs),
    budgetRevision: record.budgetRevision,
    counters: {
      runsCreated: record.runsCreated,
      attemptsCreated: record.attemptsCreated,
      runtimeStarts: record.runtimeStarts,
      noProgressRuns: record.noProgressRuns,
    },
    updatedAt: iso(record.updatedAtUtcMs),
  };
}

const ACTIVE_ATTEMPT_STATUSES: readonly string[] = ['preparing', 'executing', 'verifying'];

function isOpenLease(entry: ExecutionControlLeaseEntry): boolean {
  return entry.lease.state === 'held' || entry.lease.state === 'quarantined';
}

/**
 * 从持久事实派生显式后续动作（稳定词汇顺序、去重；集合为空时为 ['none']）。
 * 只看输入事实：不读日志、不推断 Runtime/Verifier 状态、不承诺自动执行。
 */
export function deriveExecutionControlNextActions(input: {
  readonly targetStatus: ExecutionRunStatus;
  readonly hasActiveAttempt: boolean;
  readonly hasOpenLease: boolean;
  readonly hasStoppingOperation: boolean;
  readonly hasUncertainOperation: boolean;
  readonly hasPausedRun: boolean;
  readonly hasPausingRun: boolean;
  readonly hasCancellingRun: boolean;
  readonly hasFailedFinalizationRun: boolean;
}): readonly ExecutionControlNextAction[] {
  const selected = new Set<ExecutionControlNextAction>();
  if (input.hasStoppingOperation || input.targetStatus === 'cancelling' || input.hasCancellingRun) {
    selected.add('await_stop_settlement');
  }
  if (input.hasUncertainOperation) {
    selected.add('stop_reconcile');
  }
  if (input.targetStatus === 'pausing' || input.hasPausingRun) {
    selected.add('await_attempt_settlement');
  }
  if (input.targetStatus === 'paused' || input.hasPausedRun) {
    if (input.hasActiveAttempt || input.hasOpenLease) {
      selected.add('resume_blocked_occupancy');
    } else {
      selected.add('resume');
    }
  }
  if (input.hasFailedFinalizationRun) {
    selected.add('retry_final');
  }
  if (selected.size === 0) {
    selected.add('none');
  }
  return EXECUTION_CONTROL_NEXT_ACTIONS.filter((action) => selected.has(action));
}

/** 续接记录投影（F-007 词汇同源；来源引用原样保留 Artifact 身份）。 */
export function toPublicExecutionRecoveryContinuation(
  entry: ExecutionRunRecoveryContinuationEntry,
): PublicExecutionRecoveryContinuation {
  const { attempt, recovery } = entry;
  const selection = recovery.selection;
  const requestedMode = selection.mode;
  const source = recovery.source;
  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    attemptNumber: attempt.number,
    sourceAttemptId: recovery.sourceAttemptId,
    sourceSessionId: recovery.sourceSessionId,
    requested: {
      mode: requestedMode,
      kind: selection.mode === 'new' ? null : selection.kind,
      nativeArchiveRef: source?.nativeArchiveRef ?? null,
    },
    decided: {
      mode: recovery.decision.mode === 'resume' ? 'resume' : 'new',
      reasons: [...recovery.decision.reasons],
    },
    handoff:
      recovery.handoff === null
        ? null
        : {
            previousAttemptId: recovery.handoff.previousAttemptId,
            previousStatus: recovery.handoff.previousStatus,
          },
    recordedAt: iso(recovery.recordedAtUtcMs),
  };
}

export function toPublicExecutionResourceRecord(
  row: ExecutionResourceQueryRow,
): PublicExecutionResourceRecord {
  const lease = row.lease;
  const blockingReason: PublicResourceBlockingReason | null =
    lease.waitingReason?.code === 'lease_expired_unverified'
      ? 'stop_verification'
      : lease.waitingReason?.code === 'resource_occupied' ||
          lease.waitingReason?.code === 'resource_quarantined'
        ? 'resource_conflict'
        : null;
  return {
    id: lease.id,
    projectId: lease.projectId,
    featureId: row.featureId,
    batchId: row.batchId,
    runId: row.runId,
    claimId: lease.ownerId,
    ownerId: lease.ownerId,
    ownerVersion: lease.ownerVersion,
    revision: lease.revision,
    kind: lease.resource.kind,
    accessMode: lease.resource.accessMode,
    leaseMode: lease.resource.leaseMode,
    resourceKey: lease.resource.key,
    state: lease.state === 'released' ? 'held' : lease.state,
    waitingReason: lease.waitingReason,
    blockingReason,
    acquiredAt: iso(lease.acquiredAtUtcMs),
    leaseUntil: iso(lease.leaseUntilUtcMs),
  };
}

/** Run 控制结果组装（纯函数；输入为一致读视图）。 */
export function buildRunControlDetailResult(view: ExecutionRunControlView): RunControlDetailResult {
  const finalization =
    view.run.status === 'failed'
      ? validateRunFinalizationScope(view.run.inputSnapshot['finalization']) !== null
      : false;
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'run-control',
    run: toPublicExecutionControlRunBrief(view.run),
    batch: toPublicExecutionControlBatchBrief(view.batch),
    attempts: {
      records: view.attempts.map(toPublicExecutionControlAttempt),
      truncated: view.attemptsTruncated,
    },
    stopOperations: view.stopOperations.map(toPublicExecutionControlStopOperation),
    leases: view.leases.map(toPublicExecutionControlLease),
    nextActions: deriveExecutionControlNextActions({
      targetStatus: view.run.status,
      hasActiveAttempt: view.attempts.some((attempt) => ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)),
      hasOpenLease: view.leases.some(isOpenLease),
      hasStoppingOperation: view.stopOperations.some((operation) => operation.status === 'stopping'),
      hasUncertainOperation: view.stopOperations.some((operation) => operation.status === 'uncertain'),
      hasPausedRun: false,
      hasPausingRun: false,
      hasCancellingRun: false,
      hasFailedFinalizationRun: finalization,
    }),
  };
}

/** Batch 控制结果组装（子 Run/Attempt 有界扫描；超限置 truncated）。 */
export function buildBatchControlDetailResult(view: ExecutionBatchControlView): BatchControlDetailResult {
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'batch-control',
    batch: toPublicExecutionControlBatchBrief(view.batch),
    runs: {
      records: view.runs.map(toPublicExecutionControlRunBrief),
      truncated: view.runsTruncated,
    },
    attempts: {
      records: view.attempts.map(toPublicExecutionControlAttempt),
      truncated: view.attemptsTruncated,
    },
    stopOperations: view.stopOperations.map(toPublicExecutionControlStopOperation),
    leases: view.leases.map(toPublicExecutionControlLease),
    nextActions: deriveExecutionControlNextActions({
      targetStatus: view.batch.status,
      hasActiveAttempt: view.attempts.some((attempt) => ACTIVE_ATTEMPT_STATUSES.includes(attempt.status)),
      hasOpenLease: view.leases.some(isOpenLease),
      hasStoppingOperation: view.stopOperations.some((operation) => operation.status === 'stopping'),
      hasUncertainOperation: view.stopOperations.some((operation) => operation.status === 'uncertain'),
      hasPausedRun: view.runs.some((run) => run.status === 'paused'),
      hasPausingRun: view.runs.some((run) => run.status === 'pausing'),
      hasCancellingRun: view.runs.some((run) => run.status === 'cancelling'),
      hasFailedFinalizationRun: view.runs.some(
        (run) =>
          run.status === 'failed' &&
          validateRunFinalizationScope(run.inputSnapshot['finalization']) !== null,
      ),
    }),
  };
}

/** Run 恢复/收尾结果组装（finalization scope + 续接记录 + 预算 + 分轴）。 */
export function buildRunRecoveryDetailResult(view: ExecutionRunRecoveryView): RunRecoveryDetailResult {
  const delivery = buildFeatureDeliveryDetailResult(view.delivery);
  const continuations = view.continuations.map(toPublicExecutionRecoveryContinuation);
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'run-recovery',
    run: {
      runId: view.run.id,
      batchId: view.run.batchId,
      featureId: view.run.featureId,
      purpose: view.run.purpose,
      workKey: view.run.workKey,
      dispatchOrdinal: view.run.dispatchOrdinal,
      status: view.run.status,
      reason: view.run.reason,
      startedAt: isoOr(view.run.startedAtUtcMs),
      endedAt: isoOr(view.run.endedAtUtcMs),
    },
    finalization: {
      present: view.finalization !== null,
      scope: view.finalization,
      axes: delivery.axes,
    },
    recovery: {
      records: continuations,
      truncated: view.continuationsTruncated,
      attemptsScanned: view.attemptsScanned,
    },
    budget: {
      batchId: view.batch.id,
      budgetRevision: view.batch.budgetRevision,
      deadlineAt: iso(view.batch.deadlineAtUtcMs),
      limits: view.batch.budgetSnapshot,
      counters: {
        runsCreated: view.batch.runsCreated,
        attemptsCreated: view.batch.attemptsCreated,
        runtimeStarts: view.batch.runtimeStarts,
        noProgressRuns: view.batch.noProgressRuns,
      },
      usage: { tokenUsed: null, costUsed: null },
    },
  };
}
