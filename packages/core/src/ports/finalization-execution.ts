/**
 * P03-9 / F-011 finalization-only Run 执行契约（ports 层：冻结词汇与窄端口）。
 *
 * 本层只描述「受限 finalization Run 需要执行哪些重验/最终步骤」以及执行结果；
 * 不创建 Run/Attempt、不启动 Runtime、不写业务表。所有落库、预算与停止核验
 * 仍由既有 ExecutionStore/VerificationStore/StopControl 承担。
 *
 * 不可变量：
 * - 只有 `input_snapshot.finalization.kind === 'finalization-only'` 的 Run 可以
 *   进入本执行路径；编码 Task、Runtime 启动与新 Attempt 恒为零；
 * - 应用编排按 F-009 scope 的 `revalidateTasks`/`finalVerification` 逐项执行，
 *   不自行扩大检查范围；
 * - Verifier 必须返回可核验的真实批次结果；缺检查、not_run、error、inconclusive、
 *   零测试或证据缺口都不得视为通过。
 */

/** finalization 执行操作名（内部应用操作；不新增公开命令）。 */
export const FINALIZATION_EXECUTION_OPERATION = 'FinalizationExecution.run' as const;

/** Task 重验批次的 operation 标签（非 Feature 全量批次）。 */
export const FINALIZATION_TASK_VERIFICATION_OPERATION = 'FinalizationVerification.task' as const;

/** finalization Run 的持久用途标记（写入 input_snapshot.finalization）。 */
export const FINALIZATION_ONLY_RUN_KIND = 'finalization-only' as const;

export const FINALIZATION_EXECUTION_STATUSES = [
  'verification_passed',
  'verification_failed',
  'invalidated',
  'control_interrupted',
  'not_finalization_run',
] as const;
export type FinalizationExecutionStatus = (typeof FINALIZATION_EXECUTION_STATUSES)[number];

/** F-009 scope 中与执行直接相关的最小持久形状（approval/commit 由 F-012 处理）。 */
export interface FinalizationScopeSnapshot {
  readonly schemaVersion: 1;
  readonly kind: typeof FINALIZATION_ONLY_RUN_KIND;
  readonly retryPlanDigest: string;
  readonly historicalRunId: string;
  readonly historicalBatchId: string;
  readonly historicalRunStatus: string;
  readonly historicalRunDispatchOrdinal: number;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly retainedTaskIds: readonly string[];
  readonly revalidateTasks: readonly {
    readonly taskId: string;
    readonly checkKeys: readonly string[];
    readonly reasons: readonly string[];
  }[];
  readonly finalVerification: {
    readonly required: boolean;
    readonly checkKeys: readonly string[];
  };
  readonly codingTaskIds: readonly [];
  readonly runtimeStarts: 0;
  readonly newAttempts: 0;
}

export interface FinalizationExecutionRequest {
  readonly projectId: string;
  readonly runId: string;
  /** 取消/暂停边界；Verifier 必须沿同一受控 CommandProcess 停止路径收尾。 */
  readonly signal?: AbortSignal;
}

interface FinalizationVerificationInputBase {
  readonly projectId: string;
  readonly featureId: string;
  readonly finalizationRunId: string;
  readonly historicalRunId: string;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly codeDigest: string;
  readonly headCommit: string;
  readonly workspaceBaseline: Readonly<Record<string, unknown>>;
  readonly checkKeys: readonly string[];
  /** 父 Run/Batch 已持久化的绝对截止时间；已到期不再启动检查。 */
  readonly deadlineUtcMs: number;
  readonly signal?: AbortSignal;
}

export interface FinalizationTaskRevalidationInput extends FinalizationVerificationInputBase {
  readonly taskId: string;
  readonly reasons: readonly string[];
}

export interface FinalizationFeatureVerificationInput extends FinalizationVerificationInputBase {
  readonly reasons: readonly string[];
}

/** 单个检查的持久结果视图（resultId/outputArtifactId 必须来自真实批次）。 */
export interface FinalizationCheckEvidence {
  readonly checkKey: string;
  readonly status: 'passed' | 'failed' | 'error' | 'inconclusive' | 'not_run';
  readonly resultId: string;
  readonly outputArtifactId: string | null;
  /** 零测试（0）或未知（null）都不能冒充有效检查；通过要求 ≥1。 */
  readonly testCount: number | null;
}

/** 一次 Task 重验或 Feature 全量检查的持久批次证据。 */
export interface FinalizationVerificationEvidence {
  readonly batchId: string;
  readonly operation: string;
  readonly status: 'passed' | 'failed' | 'error' | 'inconclusive';
  /** 检查期间源码/检查定义变化时为 true；调用方必须使本次结果失效。 */
  readonly invalidated: boolean;
  readonly checks: readonly FinalizationCheckEvidence[];
  /** 受控的失败/失效原因；不得含正文、路径或凭据。 */
  readonly reason?: string | null;
}

/**
 * 受信 Verifier 窄端口：实现必须复用既有 Node 检查执行器、Artifact 证据与
 * 停止控制，不得直接更新 Task/Run/Feature 状态或创建 Attempt。
 */
export interface FinalizationVerifier {
  revalidateTask(input: FinalizationTaskRevalidationInput): Promise<FinalizationVerificationEvidence>;
  verifyFeature(input: FinalizationFeatureVerificationInput): Promise<FinalizationVerificationEvidence>;
}

export interface FinalizationExecutionResult {
  readonly schemaVersion: 1;
  readonly status: FinalizationExecutionStatus;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly reason: string;
  readonly runStatus: string;
  readonly missingSteps: readonly string[];
  readonly revalidatedTaskIds: readonly string[];
  readonly verification: {
    readonly required: boolean;
    readonly performed: boolean;
    readonly batchId: string | null;
    readonly status: string | null;
  };
  readonly runtimeStarts: 0;
  readonly newAttempts: 0;
}

export interface FinalizationExecutionPort {
  execute(input: unknown): Promise<FinalizationExecutionResult>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFinalizationOnlyRun(
  run: { readonly inputSnapshot: Readonly<Record<string, unknown>> },
): boolean {
  const finalization = run.inputSnapshot['finalization'];
  return isObject(finalization)
    && finalization['schemaVersion'] === 1
    && finalization['kind'] === FINALIZATION_ONLY_RUN_KIND;
}
