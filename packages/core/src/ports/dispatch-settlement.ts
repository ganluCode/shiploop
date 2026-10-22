/**
 * P04-9 / F-006 Run 派发归属与执行槽位的收尾/续租契约（ports 层：身份、输入
 * 校验与纯决策；无任何 I/O）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.3、§3.5 标准 4–5、
 * core-design/04 §2–§4，以及 F-001..F-005 的派发/槽位契约。
 *
 * 职责边界：
 * - 本契约只结算「Run 级派发归属（run_dispatch_claims）+ 执行槽位
 *   （execution_slot_claims）」这一对资源；
 * - 不改变 Run/Batch/Task/Attempt 的业务状态、预算、证据、Git 记录，也不再
 *   重做进程树终止。暂停/取消的状态与意图仍由既有命令与生命周期维护；
 * - 完成事实、停止确认、验证通过和资源安全释放不能互相替代：只有「没有活动
 *   Attempt、没有仍需保留的工作区占用」时才释放；不确定时保留或隔离并给出
 *   有界原因，绝不因结果 Promise 结束而提前回收。
 *
 * 身份与围栏：
 * - 释放/隔离必须提供完整 Run 级认领身份（项目/Run/认领 id/认领代次/owner/
 *   Host），旧 owner、旧代次、旧 Attempt 或重复结果都不能命中当前认领；
 * - 传入的关联 Attempt 围栏（attemptId + executionVersion + owner + Host）必须
 *   与该认领的回执关联一致，并同时核对 Attempt 行；
 * - 续租同样校验认领身份与 Attempt 关联；续租不缩短租约，也不得绕过隔离。
 */
import type {
  ExecutionSlotClaimRecord,
  RunDispatchClaimRecord,
} from './execution-dispatch.js';
import type { StorageEntityType } from './errors.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

const OPERATION = 'DispatchSettlement';

/** 收尾决策（有界枚举；不是可编辑的第二套状态）。 */
export const DISPATCH_SETTLEMENT_DECISIONS = ['released', 'retained', 'quarantined', 'replayed', 'absent'] as const;
export type DispatchSettlementDecision = (typeof DISPATCH_SETTLEMENT_DECISIONS)[number];

/**
 * 保留/隔离原因（有界枚举）：
 * - `run_still_active`：Run/Batch 仍在执行窗口，或暂停意图尚未由生命周期收口；
 * - `active_attempt_present`：仍有 preparing/executing/verifying 的 Attempt；
 * - `workspace_retained`：暂停/审批等待期间工作区被有意保留（后续返工或验证复用）；
 * - `workspace_uncertain_after_terminal`：终态 Run 仍有占用，停止/副作用需先核对；
 * - `run_interrupted` / `stop_unverified`：Run 中断或停止/副作用不确定 → 隔离；
 * - `claim_quarantined` / `slot_quarantined`：已隔离，需受信核对后处理；
 * - `slot_lease_expired_unverified`：槽位租约已到期，不能伪装正常释放；
 * - `run_terminal_settled` / `run_paused_settled` / `slot_absent_settled`：已安全结算。
 */
export const DISPATCH_SETTLEMENT_REASONS = [
  'run_still_active',
  'active_attempt_present',
  'workspace_retained',
  'workspace_uncertain_after_terminal',
  'run_interrupted',
  'stop_unverified',
  'claim_quarantined',
  'claim_released',
  'slot_quarantined',
  'slot_lease_expired_unverified',
  'run_terminal_settled',
  'run_paused_settled',
  'slot_absent_settled',
] as const;
export type DispatchSettlementReason = (typeof DISPATCH_SETTLEMENT_REASONS)[number];

/** 允许安全结算的 Run 状态：终态，或已由生命周期收口为暂停/中断。 */
const SETTLEABLE_PAUSED_RUN_STATUSES = ['paused'] as const;
const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/** Run 级认领身份（与 F-003 槽位身份、F-004 回执关联同一事实）。 */
export interface DispatchSettlementClaimIdentity {
  readonly claimId: string;
  readonly claimVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

/** 关联 Attempt 围栏：与认领代次分开的独立计数器。 */
export interface DispatchAttemptFence {
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

export interface DispatchSettlementRef {
  readonly projectId: string;
  readonly runId: string;
}

export interface DispatchSettlementInput extends DispatchSettlementRef {
  readonly expected: DispatchSettlementClaimIdentity;
  readonly attempt?: DispatchAttemptFence;
}

export interface DispatchRenewalInput extends DispatchSettlementInput {
  readonly leaseUntilUtcMs: number;
}

/** 只读事实：用于决策与查询解释，不含任何写副作用。 */
export interface DispatchSettlementFacts extends DispatchSettlementRef {
  readonly runStatus: string;
  readonly pauseRequested: boolean;
  /** 活动（held/quarantined）认领；无则最近一代已释放认领；都没有则 null。 */
  readonly claim: RunDispatchClaimRecord | null;
  /** 与该认领对应的槽位（任意状态）；无则 null。 */
  readonly slot: ExecutionSlotClaimRecord | null;
  /** 该 Run 当前活动（preparing/executing/verifying）Attempt 的围栏身份。 */
  readonly activeAttempt: {
    readonly attemptId: string;
    readonly executionVersion: number;
    readonly ownerId: string;
    readonly hostInstanceId: string;
  } | null;
  readonly activeAttemptCount: number;
  /** 该 Run 的 Attempt 上仍存在的 workspace_leases 行数（held 或 quarantined）。 */
  readonly retainedLeaseCount: number;
  /**
   * 停止/副作用是否不确定：存在 interrupted Attempt，或工作区占用已被隔离。
   * 该事实优先于「保留工作区」，不得用检查点/结果 Promise 冒充停止确认。
   */
  readonly stopUncertain: boolean;
  /** 是否仍有可用槽位额度（容量与真实占用由适配器按持久事实计算）。 */
  readonly slotCapacityAvailable: boolean;
}

export interface DispatchSettlementResult extends DispatchSettlementFacts {
  readonly decision: DispatchSettlementDecision;
  readonly reason: DispatchSettlementReason | null;
  readonly changed: boolean;
}

export interface DispatchRenewalResult extends DispatchSettlementFacts {
  readonly decision: 'renewed' | 'unchanged' | 'quarantined';
  readonly reason: DispatchSettlementReason | null;
}

/** 纯决策输入：只由持久事实派生，不读时钟以外的外部状态。 */
export interface DispatchSettlementDecisionInput {
  readonly runStatus: string;
  readonly pauseRequested: boolean;
  readonly claimState: 'held' | 'quarantined' | 'released';
  readonly slotState: 'held' | 'quarantined' | 'released' | null;
  readonly slotLeaseExpired: boolean;
  readonly activeAttemptCount: number;
  readonly retainedLeaseCount: number;
  readonly stopUncertain: boolean;
}

export interface DispatchSettlementDecisionResult {
  readonly decision: Exclude<DispatchSettlementDecision, 'absent' | 'replayed'>;
  readonly reason: DispatchSettlementReason;
}

/**
 * 收尾决策（纯函数）：
 * 1. 已隔离的认领/槽位不自动回收；
 * 2. 仍在执行窗口、暂停意图未收口、或仍有活动 Attempt 时不释放；
 * 3. interrupted 视为停止不确定 → 隔离；
 * 4. 终态 Run 仍有工作区占用 → 隔离（副作用/停止待核对）；
 * 5. 暂停 Run 仍有保留工作区 → 保留（等待审批/后续显式继续复用同一现场）；
 * 6. 槽位租约到期 → 隔离（不能伪装正常释放）；
 * 7. 其余（无活动 Attempt、无占用、Run 终态或已收口暂停）→ 安全释放。
 */
export function decideDispatchSettlement(input: DispatchSettlementDecisionInput): DispatchSettlementDecisionResult {
  if (input.claimState === 'released') return { decision: 'retained', reason: 'claim_released' };
  if (input.claimState === 'quarantined') return { decision: 'retained', reason: 'claim_quarantined' };
  if (input.slotState === 'quarantined') return { decision: 'quarantined', reason: 'slot_quarantined' };
  const status = input.runStatus;
  const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  const paused = (SETTLEABLE_PAUSED_RUN_STATUSES as readonly string[]).includes(status);
  // 活动 Attempt 优先于 Run 状态解释：暂停/取消期间当前 Attempt 仍可完成验证与收尾。
  if (input.activeAttemptCount > 0) return { decision: 'retained', reason: 'active_attempt_present' };
  if (input.pauseRequested || (!terminal && !paused && status !== 'interrupted')) {
    return { decision: 'retained', reason: 'run_still_active' };
  }
  if (status === 'interrupted') return { decision: 'quarantined', reason: 'run_interrupted' };
  if (input.stopUncertain) return { decision: 'quarantined', reason: 'stop_unverified' };
  if (input.retainedLeaseCount > 0) {
    return terminal
      ? { decision: 'quarantined', reason: 'workspace_uncertain_after_terminal' }
      : { decision: 'retained', reason: 'workspace_retained' };
  }
  if (input.slotState === 'held' && input.slotLeaseExpired) {
    return { decision: 'quarantined', reason: 'slot_lease_expired_unverified' };
  }
  return {
    decision: 'released',
    reason: terminal ? 'run_terminal_settled' : input.slotState === null ? 'slot_absent_settled' : 'run_paused_settled',
  };
}

function context(operation: string, id?: string): ValidationContext {
  return { operation: `${OPERATION}.${operation}`, entity: { type: 'run_dispatch_claim' as StorageEntityType, id } };
}

const EXPECTED_KEYS = ['claimId', 'claimVersion', 'ownerId', 'hostInstanceId'] as const;
const ATTEMPT_KEYS = ['attemptId', 'executionVersion', 'ownerId', 'hostInstanceId'] as const;

/** 校验 Run 定位（项目 + Run）。 */
export function validateDispatchSettlementRef(value: unknown): DispatchSettlementRef {
  const ctx = context('read');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'runId'], ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
  };
}

export function validateDispatchSettlementClaimIdentity(value: unknown): DispatchSettlementClaimIdentity {
  const ctx = context('identity');
  const raw = requirePlainObject(value, ctx, 'expected');
  rejectUnknownKeys(raw, EXPECTED_KEYS, ctx, 'expected');
  return {
    claimId: validateStableId(raw.claimId, ctx, 'claimId'),
    claimVersion: validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
  };
}

export function validateDispatchAttemptFence(value: unknown): DispatchAttemptFence {
  const ctx = context('attempt');
  const raw = requirePlainObject(value, ctx, 'attempt');
  rejectUnknownKeys(raw, ATTEMPT_KEYS, ctx, 'attempt');
  return {
    attemptId: validateStableId(raw.attemptId, ctx, 'attemptId'),
    executionVersion: validatePositiveInteger(raw.executionVersion, ctx, 'executionVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
  };
}

export function validateDispatchSettlementInput(value: unknown): DispatchSettlementInput {
  const ctx = context('settle');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'runId', 'expected', 'attempt'], ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    expected: validateDispatchSettlementClaimIdentity(raw.expected),
    ...(raw.attempt === undefined ? {} : { attempt: validateDispatchAttemptFence(raw.attempt) }),
  };
}

export function validateDispatchRenewalInput(value: unknown): DispatchRenewalInput {
  const ctx = context('renew');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'runId', 'expected', 'attempt', 'leaseUntilUtcMs'], ctx, 'input');
  if (raw.attempt === undefined) {
    // 续租必须绑定关联 Attempt 围栏：没有 Attempt 的续租无法证明执行身份。
    throw validationError(ctx, 'attempt', '续租必须提供关联 Attempt 围栏', raw.attempt);
  }
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    expected: validateDispatchSettlementClaimIdentity(raw.expected),
    attempt: validateDispatchAttemptFence(raw.attempt),
    leaseUntilUtcMs: validatePositiveInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs'),
  };
}

/**
 * Run 级派发归属与槽位的收尾/续租窄端口。
 * - `read` 只读（一致读），用于决策与查询解释；
 * - `settleInTransaction` / `renewInTransaction` 要求调用方已打开短写事务，
 *   只做同步 SQL，不等待 Runtime/Git/文件或测试。
 */
export interface RunDispatchSettlementAccess {
  read(input: unknown): DispatchSettlementFacts;
  settleInTransaction(input: unknown): DispatchSettlementResult;
  renewInTransaction(input: unknown): DispatchRenewalResult;
}
