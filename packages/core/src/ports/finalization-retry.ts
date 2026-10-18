/**
 * P03-9 / F-009 最终收尾重试资格与有限 scope 契约（ports 契约层：冻结词汇、
 * 只读输入/输出形态；无 I/O、无写原语）。
 *
 * 设计依据：input/p03-run-control.md FR-3（历史终态 Run、相同 workKey/当前代码、
 * 有效 Task 证据、显式 retryFinal；只继续缺失的最终检查/审批/提交，不重复成功
 * 编码）与 core-design/04（终态旧 Run 不复活；新 Run 仍属有额度的授权 Batch；
 * 已发生提交先核对）。
 *
 * 契约要点：
 * - 本层只回答「显式 retryFinal 是否具备资格」以及「受限 finalization scope」，
 *   不创建 Batch/Run/Attempt/Session，不启动 Runtime，不写预算/事件/回执；
 * - 历史 Run/Attempt/VerificationBatch/策略快照均为只读事实；历史 passed 记录
 *   不因当前代码/环境/检查变化被改写，只把相关「当前可复用证据」标为待重验；
 * - 输出永远不包含编码 Task：失效证据不得自动转成新编码 Attempt；显式修复
 *   授权、新 Run 创建与预算扣减属于后续交付；
 * - 最终审批只对应当前 planDigest + 当前代码摘要；解除阻塞或历史批准不自动
 *   构成当前批准，也不触发重跑；
 * - 已发生 Git 提交先核对（reconcile_commit），不可凭旧回执再次提交。
 */

/** 显式收尾重试操作名（后续 Host/CLI 接线沿用）。 */
export const FINALIZATION_RETRY_OPERATION = 'execution.retryFinal' as const;

/** 资格拒绝原因（冻结；终态旧 Run 不复活）。 */
export const FINALIZATION_RETRY_REJECTED_REASONS = [
  /** 历史 Run 不存在或不属于请求项目。 */
  'run_not_found',
  /** Feature/Run/Batch 归属身份不一致。 */
  'identity_mismatch',
  /** 请求 workKey 与历史 Run/当前计划输入身份不一致。 */
  'work_key_mismatch',
  /** 历史 Run 不是可重试的终态（queued/running/paused/cancelling/interrupted）。 */
  'run_not_terminal',
  /** 历史 Run 不是 Work 执行用途（不能借其它用途绕过授权）。 */
  'unsupported_run_purpose',
  /** 项目当前不是 active。 */
  'project_not_active',
  /** 当前计划批准/检查政策或 Phase 状态失效。 */
  'authorization_invalid',
  /** 仍有必需 Task 未 passed（收尾重试不能修复编码）。 */
  'tasks_not_passed',
  /** 旧 Attempt/租约仍活动、隔离或未确认停止。 */
  'occupancy_unresolved',
  /** 受管 worktree 缺失、身份不符或检查失败。 */
  'workspace_invalid',
  /** Feature 已完成且所有轴证据当前有效：成功成果不自动重跑。 */
  'already_finalized',
] as const;
export type FinalizationRetryRejectedReason =
  (typeof FINALIZATION_RETRY_REJECTED_REASONS)[number];

/** 输出中仍缺失的收尾步骤（稳定顺序由应用层定义）。 */
export const FINALIZATION_PENDING_STEPS = [
  /** 相关 Task 证据需在当前代码/检查定义上重验（不新建编码 Attempt）。 */
  'task_revalidation',
  /** Feature 全量/最终检查仍需执行。 */
  'feature_verification',
  /** 当前 planDigest + 当前代码摘要的人审批准仍缺失/失效。 */
  'approval',
  /** Git 提交已发生或结果未知，必须先核对实际副作用。 */
  'reconcile_commit',
  /** 尚未观察到提交，仅收尾范围可提交。 */
  'commit',
  /** 证据/审批/提交均已就绪，只需完成 Feature 终态收尾。 */
  'finalize',
] as const;
export type FinalizationPendingStep = (typeof FINALIZATION_PENDING_STEPS)[number];

/** 当前证据不可直接复用的结构化原因（历史事实不被改写）。 */
export const FINALIZATION_EVIDENCE_REASONS = [
  'current',
  'verification_missing',
  'verification_not_passed',
  'source_changed',
  'requirements_changed',
  'config_changed',
  'check_definition_changed',
  'environment_changed',
  'artifact_missing',
  'artifact_corrupt',
  'code_evidence_missing',
  'tasks_changed',
] as const;
export type FinalizationEvidenceReason = (typeof FINALIZATION_EVIDENCE_REASONS)[number];

/** 显式 retryFinal 请求（全部身份来自可信输入；不接受路径/原生库/自报成功）。 */
export interface FinalizationRetryRequest {
  readonly projectId: string;
  readonly featureId: string;
  /** 明确的历史终态 Run；不复用最新 Run 猜测。 */
  readonly historicalRunId: string;
  /** 历史 Run 的 workKey；必须与当前计划/输入身份一致。 */
  readonly workKey: string;
}

/** 单个检查的当前复用结论。 */
export interface FinalizationRetryCheckDecision {
  readonly checkKey: string;
  readonly status: 'valid' | 'revalidate';
  readonly reasons: readonly FinalizationEvidenceReason[];
}

/** 单个 Task 的当前证据复用结论。 */
export interface FinalizationRetryTaskDecision {
  readonly taskId: string;
  readonly taskStatus: string;
  /** 当前可复用的 Task 证据；revalidate 仅影响当前检查，不改写历史 passed。 */
  readonly evidence: 'valid' | 'revalidate';
  readonly retainedCheckKeys: readonly string[];
  readonly checks: readonly FinalizationRetryCheckDecision[];
  readonly reasons: readonly FinalizationEvidenceReason[];
  readonly latestAttemptId: string | null;
  readonly latestVerificationBatchId: string | null;
}

/** 仍缺失的最终检查（空 required=false 表示当前 Feature 检查证据可复用）。 */
export interface FinalizationRetryFinalVerification {
  readonly required: boolean;
  readonly checkKeys: readonly string[];
  readonly reasons: readonly FinalizationEvidenceReason[];
  readonly latestBatchId: string | null;
}

/** 当前最终人审批结论（只绑定当前 planDigest + 当前代码摘要）。 */
export interface FinalizationRetryApproval {
  readonly required: boolean;
  readonly valid: boolean;
  readonly approvalItemId: string | null;
  readonly reason: string | null;
}

/** 提交轴结论：未知/已发生提交只核对，不自动重复提交。 */
export interface FinalizationRetryCommit {
  readonly required: boolean;
  readonly reconcileRequired: boolean;
  readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed';
  readonly operationId: string | null;
  readonly reason: string | null;
}

/** 受限收尾 scope：编码 Task/新 Attempt/Runtime 启动恒为零。 */
export interface FinalizationRetryPlan {
  readonly schemaVersion: 1;
  readonly kind: 'finalization-retry-plan';
  readonly projectId: string;
  readonly featureId: string;
  readonly historicalRunId: string;
  readonly historicalBatchId: string;
  readonly workKey: string;
  readonly historicalRunStatus: string;
  readonly historicalRunDispatchOrdinal: number;
  readonly current: {
    readonly featureRevision: number;
    readonly featureStatus: string;
    readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed';
    readonly planDigest: string;
    readonly checkPolicyDigest: string;
    readonly headCommit: string;
    readonly codeDigest: string;
    readonly workspaceId: string;
    readonly workspaceRevision: number;
  };
  readonly tasks: readonly FinalizationRetryTaskDecision[];
  readonly retainedTaskIds: readonly string[];
  readonly revalidateTasks: readonly {
    readonly taskId: string;
    readonly checkKeys: readonly string[];
    readonly reasons: readonly FinalizationEvidenceReason[];
  }[];
  readonly finalVerification: FinalizationRetryFinalVerification;
  readonly approval: FinalizationRetryApproval;
  readonly commit: FinalizationRetryCommit;
  readonly missingSteps: readonly FinalizationPendingStep[];
  readonly coding: {
    readonly taskIds: readonly [];
    readonly runtimeStarts: 0;
    readonly newAttempts: 0;
  };
  readonly historicalRecordsMutated: false;
}

export type FinalizationRetryResult =
  | { readonly status: 'eligible'; readonly plan: FinalizationRetryPlan }
  | {
      readonly status: 'rejected';
      readonly reason: FinalizationRetryRejectedReason;
      /** 受控附加身份/原因；不含绝对路径、正文或凭据。 */
      readonly detail: string | null;
    };
