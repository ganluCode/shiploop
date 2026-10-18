/**
 * P03-9 / F-012 finalization-only Run 收尾完成契约（ports 层：冻结词汇与窄端口）。
 *
 * F-011 只执行必要重验与 Feature 全量检查；本层回答后续两个问题：
 * 1. 当前 planDigest + 当前代码摘要的最终人审是否有效？缺失时只进入等待，
 *    绝不重复编码或无条件重跑已经有效的检查；
 * 2. 需要提交时，复用既有持久 Git operation/真实 Git 事实；只有全部轴满足
 *    才通过 CAS 完成 Run/Batch/Feature。
 *
 * 不可变量：
 * - 编码 Task、新 Attempt、Runtime 启动恒为零；提交失败不触发 Runtime；
 * - 状态/权限/预算/代码/HEAD/审批在提交前再次核对；旧回执、取消竞争和
 *   外部 HEAD 漂移都不得覆盖当前终态或 reset 代码；
 * - 不新增 push/PR/自动分支合并能力；Git 副作用必须可核对。
 */
import { createHash } from 'node:crypto';
import type { ConfirmedGitIdentity } from './delivery-policy.js';
import type { GitCommitReconciliation } from './git-commit-reconciliation.js';
import type { GitOperationEvidenceRef, GitOperationStatus } from './git-operations.js';
import type { WorkspaceBaseline } from './workspace.js';

/** 完成收尾的操作名（Core 应用操作；Host 接线由 F-014 负责）。 */
export const FINALIZATION_COMPLETION_OPERATION = 'FinalizationCompletion.run' as const;

export const FINALIZATION_COMPLETION_STATUSES = [
  /** 审批有效、提交（或无差异）已完成，Feature/Run/Batch 已 CAS 完成。 */
  'completed',
  /** 已存在成功提交或没有差异；复用真实 Git 事实后完成。 */
  'no_change',
  /** 当前最终审批缺失/待决定/被拒/人工阻塞：保持等待，不改写已完成事实。 */
  'awaiting_approval',
  /** Run 已暂停等待显式继续；批准命令本身不会提交。 */
  'awaiting_resume',
  /** 明确的提交失败：不触发 Runtime，保留代码现场等待重验/诊断。 */
  'commit_failed',
  /** 提交结果未知或仍需 reconcile：不得再次提交，等待核对。 */
  'reconcile_required',
  /** 代码/HEAD/授权/证据在收尾期间失效。 */
  'invalidated',
  /** 必需检查仍未完成；本操作不会自动重跑有效检查。 */
  'verification_required',
  /** 取消/暂停竞争或旧 revision 回执，不得覆盖当前终态。 */
  'control_interrupted',
  /** 预算/deadline 已耗尽：不提交、不重置，需显式增额后再继续。 */
  'budget_exhausted',
  /** 目标不是受限 finalization-only Run。 */
  'not_finalization_run',
  /** Feature/Run/Batch 已经处于终态完成，重复调用不再执行副作用。 */
  'already_completed',
] as const;
export type FinalizationCompletionStatus = (typeof FINALIZATION_COMPLETION_STATUSES)[number];

/** 受限 finalization scope 的稳定身份（F-009/F-010 已持久化字段）。 */
export interface FinalizationCompletionScope {
  readonly schemaVersion: 1;
  readonly kind: 'finalization-only';
  readonly retryPlanDigest: string;
  readonly historicalRunId: string;
  readonly historicalBatchId: string;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly headCommit: string;
  readonly codeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly commit: {
    readonly required: boolean;
    readonly reconcileRequired: boolean;
    readonly operationId: string | null;
    readonly deliveryStatus: string;
  };
  readonly codingTaskIds: readonly [];
  readonly runtimeStarts: 0;
  readonly newAttempts: 0;
}

export interface FinalizationCompletionRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

/** 收尾提交所需的最小可信身份（来自持久 scope/计划批准，不接受请求自报）。 */
export interface FinalizationCommitRequest {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  /** 新操作或显式重试时的新 operationId；同一 operationId 不得重复提交。 */
  readonly operationId: string;
  readonly expectedHead: string;
  readonly codeDigest: string;
  readonly planDigest: string;
  readonly checkPolicyDigest: string;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly verificationRefs: readonly GitOperationEvidenceRef[];
  readonly approvalRefs: readonly GitOperationEvidenceRef[];
  readonly baseline: WorkspaceBaseline;
  /** 历史 Attempt 归属只作为受控提交身份；本操作绝不启动该 Attempt。 */
  readonly attempt: {
    readonly attemptId: string;
    readonly executionVersion: number;
    readonly owner: string;
    readonly hostInstanceId: string;
  };
  readonly message: string;
  readonly gitIdentity: ConfirmedGitIdentity;
  readonly deliveryPolicyDigest: string;
}

/** Git operation 的公开最小视图（不暴露原生路径或凭据）。 */
export interface FinalizationGitOperationView {
  readonly operationId: string;
  readonly status: GitOperationStatus;
  readonly expectedHead: string;
  readonly candidateTree: string;
  readonly actualCommit: string | null;
  readonly actualTree: string | null;
  readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed' | null;
  readonly reasonCode: string | null;
}

export interface FinalizationDeliveryVerification {
  readonly matched: boolean;
  readonly reasonCode: string | null;
}

/**
 * 受信 Git 交付窄端口。实现必须使用持久 operation 意图、受界 workspace
 * inspector 与真实 Git driver；不得 reset 代码、不得重放未知提交、不得在
 * 调用方事务内执行外部 I/O。
 */
export interface FinalizationDeliveryPort {
  /** 读取既有 operation；不存在返回 null。 */
  readOperation(projectId: string, operationId: string): FinalizationGitOperationView | null;
  /** 核对已终态 operation 与当前真实 HEAD/tree 是否一致（不执行提交）。 */
  verifyOperation(request: FinalizationCommitRequest, operationId: string): Promise<FinalizationDeliveryVerification>;
  /** 执行或显式重试提交；实现负责固定意图、暂存、hook 与回执。 */
  commit(request: FinalizationCommitRequest): Promise<FinalizationGitOperationView>;
  /** 只核对未知/pending operation，不执行提交。 */
  reconcile(request: FinalizationCommitRequest, operationId: string): Promise<GitCommitReconciliation>;
}

/** 提交轴的分轴结果（用于查询/审计，不代替 Git operation 事实）。 */
export interface FinalizationCompletionCommitAxis {
  readonly required: boolean;
  readonly operationId: string | null;
  readonly status: string | null;
  readonly deliveryStatus: 'not_requested' | 'pending' | 'succeeded' | 'failed' | null;
  readonly reused: boolean;
  readonly reason: string | null;
}

export interface FinalizationCompletionApprovalAxis {
  readonly required: true;
  readonly valid: boolean;
  readonly approvalItemId: string | null;
  readonly reason: string | null;
}

export interface FinalizationCompletionResult {
  readonly schemaVersion: 1;
  readonly status: FinalizationCompletionStatus;
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly batchId: string;
  readonly reason: string;
  readonly runStatus: string;
  readonly featureStatus: string;
  readonly deliveryStatus: string | null;
  readonly missingSteps: readonly string[];
  readonly approval: FinalizationCompletionApprovalAxis;
  readonly commit: FinalizationCompletionCommitAxis;
  readonly runtimeStarts: 0;
  readonly newAttempts: 0;
}

export interface FinalizationCompletionPort {
  execute(input: unknown): Promise<FinalizationCompletionResult>;
}

/** 提交所需的可信交付配置（消息、确认身份、交付政策摘要）。 */
export interface FinalizationDeliveryConfig {
  readonly message: string;
  readonly gitIdentity: ConfirmedGitIdentity;
  readonly deliveryPolicyDigest: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stable UUIDv4-shaped operation id for a finalization Run (retry-safe). */
export function computeFinalizationOperationId(seed: string): string {
  // Domain separation keeps finalization operation identity distinct from command
  // receipts and native runtime identifiers.
  const hex = createHash('sha256').update(`shiploop:finalization-operation:v1\u0000${seed}`).digest('hex');
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = 'a';
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
