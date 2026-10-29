/**
 * P03-8 / F-010 Feature 分轴结果查询（Task/最终检查/人工审批/交付）只读窄端口
 *（ports 层）。
 *
 * 契约要点：
 * - 单一 detail 查询 `features.delivery.get` 从持久 SQLite 一致读视图重建
 *   Feature 交付全景：全部必需 Task 当前有效结果与历史引用（latestAttemptId）、
 *   独立 Feature VerificationBatch（operation='FeatureVerification.full'）及
 *   逐检查状态、最终审批/阻塞事项、Git operation 与 deliveryStatus；
 * - completed 不掩盖缺失证据或其他轴的失败：Feature completed 但最终检查证据
 *   缺失/未通过、交付事实缺失或当前审批出现新阻塞时，overall outcome 绝不
 *   报告 completed；
 * - 所有 Task passed 但最终失败、机器通过待人工批准、Git 已提交但新阻塞、
 *   提交结果未知/失败与正常完成是可区分的结构化 outcome；失败阶段使用
 *   executionStage（Feature 级冻结词汇），附相关身份、可理解原因码与显式
 *   下一步（下一步绝不暗示自动重跑编码）；
 * - 查询零写入、零事件、零续租、不触发 Git/Runtime/预算；重复读取不增加
 *   任何计数；缺失耗时/退出信息保持 null（不以 0 冒充）；审批事项有界
 *   （超限置 itemsTruncated，Task 数受计划导入上限约束）；
 * - 授权与存在性折叠在应用层（能力位 project.read；跨项目/不存在统一
 *   not_found）；脱敏投影复用 F-013/F-009 既有公共形状，不新增第二套词汇。
 */
import type {
  FeaturePlanStatus,
  FeatureStatus,
  TaskApprovalItemRecord,
  TaskStatus,
} from './plan-store.js';
import type { ExecutionBatchStatus, ExecutionRunStatus } from './execution-store.js';
import type { FeatureDeliveryStatus, GitOperationRecord } from './git-operations.js';
import type {
  CheckResultRecord,
  VerificationBatchRecord,
} from './verification-store.js';
import {
  toPublicGitOperationRecord,
  type PublicGitOperationRecord,
} from './git-operation-query.js';
import {
  toPublicTaskApprovalItemRecord,
  toPublicVerificationBatchRecord,
  type PublicTaskApprovalItemRecord,
  type PublicVerificationBatchRecord,
} from './task-evidence-query.js';
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';

/* ------------------------------------------------------------------ *
 * 操作身份（冻结词汇；Host 传输/能力白名单与公共 Schema 同源同步）
 * ------------------------------------------------------------------ */

export const FEATURE_DELIVERY_GET_OPERATION = 'features.delivery.get' as const;

export const FEATURE_DELIVERY_QUERY_OPERATIONS = [
  FEATURE_DELIVERY_GET_OPERATION,
] as const;

export type FeatureDeliveryQueryOperation = (typeof FEATURE_DELIVERY_QUERY_OPERATIONS)[number];

/* ------------------------------------------------------------------ *
 * 冻结展示词汇
 * ------------------------------------------------------------------ */

/** 最终检查轴展示状态（none = 尚无独立 Feature VerificationBatch）。 */
export const FEATURE_VERIFICATION_AXIS_STATUSES = [
  'none',
  'running',
  'passed',
  'failed',
  'error',
  'inconclusive',
] as const;
export type FeatureVerificationAxisStatus = (typeof FEATURE_VERIFICATION_AXIS_STATUSES)[number];

/**
 * 最终审批轴展示状态（只反映持久人审事项与当前计划/代码身份绑定关系）：
 * - none：无任何事项；pending：当前审批事项待决定；approved：当前决定有效；
 * - rejected：当前决定拒绝；blocked：当前人工阻塞未解除；
 * - stale：事项均绑定历史计划/代码身份（历史记录，不构成当前授权）。
 */
export const FEATURE_APPROVAL_AXIS_STATUSES = [
  'none',
  'pending',
  'approved',
  'rejected',
  'blocked',
  'stale',
] as const;
export type FeatureApprovalAxisStatus = (typeof FEATURE_APPROVAL_AXIS_STATUSES)[number];

/**
 * Feature 级失败阶段（executionStage 冻结词汇；completed 为 null）。
 * 与 Attempt 级 executionStage 分开：这里是交付轴定位，不是 Attempt 现场。
 */
export const FEATURE_DELIVERY_STAGES = [
  'task_execution',
  'feature_verification',
  'final_approval',
  'git_delivery',
] as const;
export type FeatureDeliveryStage = (typeof FEATURE_DELIVERY_STAGES)[number];

/**
 * Feature 分轴总体结果（可区分的结构化 outcome）：
 * - in_progress：执行或收尾尚未到达终态；
 * - tasks_failed：终态但必需 Task 未全部有效通过；
 * - final_verification_failed：所有 Task passed 但最终检查失败/错误/不确定；
 * - awaiting_approval：机器通过待人工批准（持久 awaiting_approval）；
 * - delivery_uncertain：提交结果未知（deliveryStatus pending，待核对）；
 * - delivery_failed：提交失败（含提交权威缺失）；
 * - committed_but_blocked：Git 已提交但当前审批出现新阻塞/拒绝；
 * - evidence_incomplete：完成/终态但必需证据缺失或状态互不一致；
 * - completed：全部轴干净完成。
 */
export const FEATURE_DELIVERY_OUTCOMES = [
  'in_progress',
  'tasks_failed',
  'final_verification_failed',
  'awaiting_approval',
  'delivery_uncertain',
  'delivery_failed',
  'committed_but_blocked',
  'evidence_incomplete',
  'completed',
] as const;
export type FeatureDeliveryOutcome = (typeof FEATURE_DELIVERY_OUTCOMES)[number];

/**
 * 显式下一步（冻结词汇；均为人工/授权命令动作，绝不暗示自动重跑编码）：
 * - none：无下一步（已完成或需人工核查现场）；
 * - continue_execution：Task 未完成，继续既有正常执行循环；
 * - feature_verification_continue：经授权命令 feature.verification.continue
 *   重新请求最终收尾；
 * - feature_approval_decision：责任主体经 task.approval.* 做出当前决定；
 * - manual_block_resolution：责任主体先解除当前人工阻塞；
 * - git_operation_reconcile：经授权命令 git.operation.reconcile 核对提交；
 * - rework_authorization：最终检查失败需代码修复——先明确失效范围与返工
 *   授权（不在本命令面内，绝不自动新建编码会话）。
 */
export const FEATURE_DELIVERY_NEXT_STEPS = [
  'none',
  'continue_execution',
  'feature_verification_continue',
  'feature_approval_decision',
  'manual_block_resolution',
  'git_operation_reconcile',
  'rework_authorization',
] as const;
export type FeatureDeliveryNextStep = (typeof FEATURE_DELIVERY_NEXT_STEPS)[number];

/** 人审事项展示上限（超出置 itemsTruncated，不静默丢弃语义）。 */
export const FEATURE_DELIVERY_APPROVAL_ITEMS_MAX_COUNT = 128;

/* ------------------------------------------------------------------ *
 * 一致读视图（adapters 层产出；应用层授权完成后消费）
 * ------------------------------------------------------------------ */

/** Feature 持久事实行（查询展示所需的最小列）。 */
export interface FeatureDeliveryFeatureRow {
  readonly projectId: string;
  readonly featureId: string;
  readonly status: FeatureStatus;
  readonly deliveryStatus: FeatureDeliveryStatus;
  readonly planStatus: FeaturePlanStatus;
  readonly planDigest: string | null;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
}

/** 必需 Task 当前有效结果与历史引用（latestAttemptId 无 Attempt 为 null）。 */
export interface FeatureDeliveryTaskRow {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly manualBlock: boolean;
  readonly firstPassedAtUtcMs: number | null;
  readonly latestAttemptId: string | null;
}

/** Feature 最近 Run 持久事实（无 Run 为 null）。 */
export interface FeatureDeliveryRunRow {
  readonly id: string;
  readonly batchId: string;
  readonly labels: readonly string[];
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAtUtcMs: number | null;
  readonly endedAtUtcMs: number | null;
}

/** 最近 Run 所属单 Feature Batch 持久事实。 */
export interface FeatureDeliveryBatchRow {
  readonly id: string;
  readonly status: ExecutionBatchStatus;
  readonly reason: string | null;
}

/** 最近独立 Feature VerificationBatch + 逐检查结果。 */
export interface FeatureDeliveryVerificationView {
  readonly batch: VerificationBatchRecord;
  readonly checks: readonly CheckResultRecord[];
}

/** Feature 分轴一致读视图（同一 BEGIN DEFERRED 读事务内组装）。 */
export interface FeatureDeliveryView {
  readonly feature: FeatureDeliveryFeatureRow;
  readonly tasks: readonly FeatureDeliveryTaskRow[];
  readonly run: FeatureDeliveryRunRow | null;
  readonly batch: FeatureDeliveryBatchRow | null;
  /** 最近独立 Feature VerificationBatch（operation='FeatureVerification.full'）。 */
  readonly verification: FeatureDeliveryVerificationView | null;
  /** Feature 最近 Git operation（无则为 null）。 */
  readonly gitOperation: GitOperationRecord | null;
  /** 有界人审事项（(created_at,id) 升序；超限置 approvalItemsTruncated）。 */
  readonly approvalItems: readonly TaskApprovalItemRecord[];
  readonly approvalItemsTruncated: boolean;
}

/**
 * Feature 分轴结果只读窄端口：只读（无任何写原语）；跨项目/不存在目标统一
 * undefined（存在性折叠由应用层完成）；持久行损坏 fail-closed
 * （StorageError corrupt），不把损坏内容折算成空结果。
 */
export interface FeatureDeliveryQueryReadStore {
  readFeatureDeliveryView(projectId: unknown, featureId: unknown): FeatureDeliveryView | undefined;
}

/* ------------------------------------------------------------------ *
 * 公开形状（稳定 Schema；Host 公共面按这些冻结字段集做线校验）
 * ------------------------------------------------------------------ */

/** Task 轴单项：当前有效结果（effectivePassed 恒等于 status==='passed'）+ 历史引用。 */
export interface PublicFeatureDeliveryTaskResult {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly effectivePassed: boolean;
  readonly manualBlock: boolean;
  readonly firstPassedAt: string | null;
  readonly latestAttemptId: string | null;
}

export interface PublicFeatureDeliveryTasksAxis {
  readonly total: number;
  readonly passed: number;
  readonly allPassed: boolean;
  readonly records: readonly PublicFeatureDeliveryTaskResult[];
}

export interface PublicFeatureDeliveryVerificationAxis {
  readonly status: FeatureVerificationAxisStatus;
  /** 最近独立 Feature VerificationBatch（含逐检查；无批次为 null）。 */
  readonly batch: PublicVerificationBatchRecord | null;
}

export interface PublicFeatureDeliveryApprovalAxis {
  readonly status: FeatureApprovalAxisStatus;
  /** 派生原因码（none 为 null；与 evaluateFeatureFinalApproval 词汇同源）。 */
  readonly reason: string | null;
  readonly items: readonly PublicTaskApprovalItemRecord[];
  readonly itemsTruncated: boolean;
}

export interface PublicFeatureDeliveryDeliveryAxis {
  readonly status: FeatureDeliveryStatus;
  /** Feature 最近 Git operation 脱敏投影（无则为 null）。 */
  readonly operation: PublicGitOperationRecord | null;
}

/** 最近 Run 引用（持久控制原因原样展示；未开始/未结束保持 null）。 */
export interface PublicFeatureDeliveryRunRef {
  readonly id: string;
  readonly batchId: string;
  readonly status: ExecutionRunStatus;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** 总体结构化结果：失败阶段 + 相关身份 + 可理解原因码 + 显式下一步。 */
export interface PublicFeatureDeliveryOutcome {
  readonly status: FeatureDeliveryOutcome;
  readonly executionStage: FeatureDeliveryStage | null;
  readonly reason: string;
  readonly nextStep: FeatureDeliveryNextStep;
  readonly identities: {
    readonly featureId: string;
    readonly runId: string | null;
    readonly batchId: string | null;
    readonly verificationBatchId: string | null;
    readonly gitOperationId: string | null;
  };
}

/** features.delivery.get 结果（单 Feature 分轴全景 + 总体 outcome）。 */
export interface FeatureDeliveryDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'feature-delivery';
  readonly feature: {
    readonly featureId: string;
    readonly status: FeatureStatus;
    readonly deliveryStatus: FeatureDeliveryStatus;
    readonly planStatus: FeaturePlanStatus;
    readonly planDigest: string | null;
    readonly revision: number;
    readonly updatedAt: string;
  };
  readonly run: PublicFeatureDeliveryRunRef | null;
  readonly axes: {
    readonly tasks: PublicFeatureDeliveryTasksAxis;
    readonly verification: PublicFeatureDeliveryVerificationAxis;
    readonly approval: PublicFeatureDeliveryApprovalAxis;
    readonly delivery: PublicFeatureDeliveryDeliveryAxis;
  };
  readonly outcome: PublicFeatureDeliveryOutcome;
}

/* ------------------------------------------------------------------ *
 * 纯投影与派生（确定性；不读时钟、不产生写入、不解析日志或模型文本）
 * ------------------------------------------------------------------ */

function isoOr(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function toPublicFeatureDeliveryTaskResult(
  row: FeatureDeliveryTaskRow,
): PublicFeatureDeliveryTaskResult {
  return {
    taskId: row.taskId,
    status: row.status,
    // 有效 Task passed 恒等于持久 status==='passed'；机器绿色不折算。
    effectivePassed: row.status === 'passed',
    manualBlock: row.manualBlock,
    firstPassedAt: isoOr(row.firstPassedAtUtcMs),
    latestAttemptId: row.latestAttemptId,
  };
}

export function deriveFeatureDeliveryVerificationAxis(
  verification: FeatureDeliveryVerificationView | null,
): PublicFeatureDeliveryVerificationAxis {
  if (verification === null) return { status: 'none', batch: null };
  return {
    status: verification.batch.status,
    batch: toPublicVerificationBatchRecord(verification),
  };
}

/**
 * 最终审批轴派生（只读版 evaluateFeatureFinalApproval：同一绑定规则——事项
 * 绑定当前 planDigest 与当前最终检查代码身份才构成当前事实；历史绑定事项
 * 保留展示但不构成当前授权）。无最终检查批次时代码身份未知，绑定代码摘要
 * 的事项不算当前。
 */
export function deriveFeatureDeliveryApprovalAxis(
  view: Pick<FeatureDeliveryView, 'feature' | 'verification' | 'approvalItems' | 'approvalItemsTruncated'>,
): PublicFeatureDeliveryApprovalAxis {
  const codeDigest = view.verification?.batch.codeDigest ?? null;
  const isCurrent = (item: TaskApprovalItemRecord): boolean => {
    if (item.planDigest !== view.feature.planDigest) return false;
    if (item.codeDigest === null) return true;
    return codeDigest !== null && item.codeDigest === codeDigest;
  };
  const items = view.approvalItems.map(toPublicTaskApprovalItemRecord);
  let status: FeatureApprovalAxisStatus = 'none';
  let reason: string | null = null;
  let sawStale = false;
  let approved: TaskApprovalItemRecord | null = null;
  for (const item of view.approvalItems) {
    if (!isCurrent(item)) {
      if (item.kind === 'approval' || item.status === 'pending') sawStale = true;
      continue;
    }
    if (item.kind === 'block' && item.status === 'pending') {
      status = 'blocked';
      reason = 'manual_block';
      continue;
    }
    if (item.kind !== 'approval') continue;
    if (item.status === 'pending') {
      if (status !== 'blocked') {
        status = 'pending';
        reason = 'approval_pending';
      }
      continue;
    }
    if (item.status === 'rejected') {
      if (status !== 'blocked') {
        status = 'rejected';
        reason = 'approval_rejected';
      }
      continue;
    }
    if (item.status !== 'approved') continue;
    // 代码身份已知时决定必须绑定当前代码；未知时不冒充有效批准。
    if (codeDigest !== null && item.decisionCodeDigest === codeDigest && approved === null) {
      approved = item;
    } else {
      sawStale = true;
    }
  }
  if (status === 'none' && approved !== null) {
    status = 'approved';
    reason = null;
  }
  if (status === 'none' && sawStale) {
    status = 'stale';
    reason = 'approval_identity_stale';
  }
  return {
    status,
    reason,
    items,
    itemsTruncated: view.approvalItemsTruncated,
  };
}

const FEATURE_TERMINAL_STATUSES: readonly FeatureStatus[] = ['completed', 'partial', 'failed'];

/**
 * 总体 outcome 派生：只取持久 Feature/Run/Batch/验证/交付/审批事实；持久
 * Run 原因码优先（finalization 写入），缺失时使用派生码。completed 必先
 * 核对最终检查证据、交付事实与当前审批，任何缺失/新阻塞都不报告 completed。
 */
export function deriveFeatureDeliveryOutcome(input: {
  readonly view: FeatureDeliveryView;
  readonly tasksAllPassed: boolean;
  readonly verification: PublicFeatureDeliveryVerificationAxis;
  readonly approval: PublicFeatureDeliveryApprovalAxis;
  readonly deliveryStatus: FeatureDeliveryStatus;
}): PublicFeatureDeliveryOutcome {
  const { view, tasksAllPassed, verification, approval, deliveryStatus } = input;
  const identities = {
    featureId: view.feature.featureId,
    runId: view.run?.id ?? null,
    batchId: view.run?.batchId ?? null,
    verificationBatchId: view.verification?.batch.id ?? null,
    gitOperationId: view.gitOperation?.intent.operationId ?? null,
  };
  const runReason = view.run?.reason ?? null;
  const outcome = (
    status: FeatureDeliveryOutcome,
    executionStage: FeatureDeliveryStage | null,
    reason: string,
    nextStep: FeatureDeliveryNextStep,
  ): PublicFeatureDeliveryOutcome => ({ status, executionStage, reason, nextStep, identities });

  if (view.feature.status === 'completed') {
    // completed 不掩盖缺失证据或其他轴失败：逐项核对最终检查、交付与审批。
    if (verification.status !== 'passed') {
      return outcome('evidence_incomplete', 'feature_verification',
        'feature_verification_evidence_missing', 'feature_verification_continue');
    }
    if (deliveryStatus !== 'succeeded' || view.gitOperation === null) {
      return outcome('evidence_incomplete', 'git_delivery',
        'delivery_evidence_missing', 'git_operation_reconcile');
    }
    if (approval.status === 'blocked') {
      return outcome('committed_but_blocked', 'final_approval', 'manual_block', 'manual_block_resolution');
    }
    if (approval.status === 'rejected') {
      return outcome('committed_but_blocked', 'final_approval',
        'approval_rejected', 'feature_approval_decision');
    }
    return outcome('completed', null, runReason ?? 'feature_finalized', 'none');
  }

  if (view.feature.status === 'awaiting_approval') {
    if (approval.status === 'blocked') {
      return outcome('awaiting_approval', 'final_approval', 'manual_block', 'manual_block_resolution');
    }
    return outcome('awaiting_approval', 'final_approval',
      runReason ?? approval.reason ?? 'approval_required', 'feature_approval_decision');
  }

  if (FEATURE_TERMINAL_STATUSES.includes(view.feature.status)) {
    if (deliveryStatus === 'pending') {
      return outcome('delivery_uncertain', 'git_delivery',
        runReason ?? 'delivery_outcome_unknown', 'git_operation_reconcile');
    }
    if (deliveryStatus === 'failed') {
      return outcome('delivery_failed', 'git_delivery',
        runReason ?? 'delivery_failed', 'feature_verification_continue');
    }
    if (deliveryStatus === 'succeeded') {
      // 提交已成功但 Feature 未 completed：只在当前审批出现新阻塞时成立。
      if (approval.status === 'blocked' || approval.status === 'rejected') {
        return outcome('committed_but_blocked', 'final_approval',
          approval.reason ?? 'manual_block',
          approval.status === 'blocked' ? 'manual_block_resolution' : 'feature_approval_decision');
      }
      return outcome('evidence_incomplete', 'git_delivery',
        runReason ?? 'finalization_state_incomplete', 'feature_verification_continue');
    }
    // deliveryStatus === 'not_requested'：交付前终态。
    if (
      verification.status === 'failed' ||
      verification.status === 'error' ||
      verification.status === 'inconclusive'
    ) {
      return outcome('final_verification_failed', 'feature_verification',
        runReason ?? 'feature_verification_failed', 'rework_authorization');
    }
    if (!tasksAllPassed) {
      return outcome('tasks_failed', 'task_execution',
        runReason ?? 'tasks_not_passed', 'rework_authorization');
    }
    if (verification.status === 'passed') {
      // 机器通过但未走到审批/交付的终态是不完整现场（如提交权威缺失前的
      // 部分写入），绝不显示为 completed 或待批准。
      return outcome('evidence_incomplete', 'final_approval',
        runReason ?? 'finalization_state_incomplete', 'feature_verification_continue');
    }
    return outcome('evidence_incomplete', 'feature_verification',
      runReason ?? 'feature_verification_evidence_missing', 'feature_verification_continue');
  }

  // 非终态（draft/ready/running）：按各轴当前进度定位阶段。
  if (!tasksAllPassed) {
    return outcome('in_progress', 'task_execution', 'tasks_not_passed', 'continue_execution');
  }
  if (verification.status !== 'passed') {
    return outcome('in_progress', 'feature_verification',
      'final_verification_pending', 'feature_verification_continue');
  }
  if (approval.status === 'blocked') {
    return outcome('in_progress', 'final_approval', 'manual_block', 'manual_block_resolution');
  }
  return outcome('in_progress', 'final_approval',
    approval.reason ?? 'final_approval_pending',
    approval.status === 'approved' ? 'feature_verification_continue' : 'feature_approval_decision');
}

/** Task 轴组装（records 保持视图顺序：稳定 taskId 升序）。 */
export function buildFeatureDeliveryTasksAxis(
  tasks: readonly FeatureDeliveryTaskRow[],
): PublicFeatureDeliveryTasksAxis {
  const records = tasks.map(toPublicFeatureDeliveryTaskResult);
  const passed = records.filter((record) => record.effectivePassed).length;
  return {
    total: records.length,
    passed,
    allPassed: records.length > 0 && passed === records.length,
    records,
  };
}

/** Feature 分轴结果组装（纯函数；输入为一致读视图）。 */
export function buildFeatureDeliveryDetailResult(
  view: FeatureDeliveryView,
): FeatureDeliveryDetailResult {
  const tasks = buildFeatureDeliveryTasksAxis(view.tasks);
  const verification = deriveFeatureDeliveryVerificationAxis(view.verification);
  const approval = deriveFeatureDeliveryApprovalAxis(view);
  const delivery: PublicFeatureDeliveryDeliveryAxis = {
    status: view.feature.deliveryStatus,
    operation:
      view.gitOperation === null ? null : toPublicGitOperationRecord(view.gitOperation),
  };
  return {
    schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
    scope: 'feature-delivery',
    feature: {
      featureId: view.feature.featureId,
      status: view.feature.status,
      deliveryStatus: view.feature.deliveryStatus,
      planStatus: view.feature.planStatus,
      planDigest: view.feature.planDigest,
      revision: view.feature.revision,
      updatedAt: isoOr(view.feature.updatedAtUtcMs) ?? new Date(0).toISOString(),
    },
    run: view.run === null
      ? null
      : {
          id: view.run.id,
          batchId: view.run.batchId,
          status: view.run.status,
          reason: view.run.reason,
          startedAt: isoOr(view.run.startedAtUtcMs),
          endedAt: isoOr(view.run.endedAtUtcMs),
        },
    axes: { tasks, verification, approval, delivery },
    outcome: deriveFeatureDeliveryOutcome({
      view,
      tasksAllPassed: tasks.allPassed,
      verification,
      approval,
      deliveryStatus: view.feature.deliveryStatus,
    }),
  };
}
