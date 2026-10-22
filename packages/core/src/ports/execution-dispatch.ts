/**
 * P04-9 / F-001 Run 级持久派发与单执行槽位契约（ports 契约层：记录形态、纯校验、
 * 合法转换与展示派生；无任何 I/O）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.1、§3.2、§3.4 与
 * core-design/15-feature-concurrency-and-integration.md §2；实施理由与不能复用的
 * 具体原因见 docs/p04-9-f001-dispatch-slot-contract.md。
 *
 * 事实来源（本模块不新增第二套业务状态机）：
 * - `runs` 的 queued/控制/终态与不可变授权快照仍是 Run 的业务事实；
 * - 本契约只补既有结构无法表达的 Run 级认领代次、槽位归属与恢复关联；
 * - 展示状态由 Run + 认领 + 槽位 + 活动 Attempt 派生，不是可任意编辑的持久状态；
 * - 派发身份是「同项目、同 Feature 的 Run」自身；`workKey` 只表示可跨重试的逻辑
 *   工作，不参与队列唯一键（`work_key` 不是本契约字段）。显式重试产生新 Run，
 *   因此有独立派发身份；同 Run 的显式 resume 只追加下一代认领，不重开终态 Attempt。
 *
 * 两个版本计数器严格分离：
 * - `RunDispatchClaimRecord.claimVersion`：Run 级消费者代次（owner/hostInstanceId 属于
 *   该代次；迁移/续租/释放必须匹配 owner + hostInstanceId + claimVersion）；
 * - `TaskAttemptLink.executionVersion`：Task/Attempt 级 fencing 计数，与 claimVersion
 *   不相等、不同步、不可互相代替。二者只通过 `assertDispatchClaimOwnsAttempt` 关联：
 *   同一项目/Feature/Run、同 owner/host，且 Attempt 在该认领代次取得之后创建。
 *
 * 边界（后续 Task 实现）：入队/补扫事务与提交后唤醒（F-002）、槽位竞争/续租/释放
 * 原语与容量装配（F-003）、与既有 Task 原子认领和 Runtime 启动前重核（F-004）。
 * 本模块不打开数据库、不读取时钟、不启动进程，也不提供任何队列状态编辑入口。
 */
import { createHash } from 'node:crypto';
import type { ExecutionBatchStatus, ExecutionRunStatus } from './execution-store.js';
import { StorageError } from './errors.js';
import type { StorageEntityType } from './errors.js';
import { stableStringify } from './feature-plan.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

const OPERATION = 'ExecutionDispatch';

/** 首版生产开放的执行槽位容量（默认且唯一允许值；>1 明确拒绝，不暗中串行）。 */
export const EXECUTION_SLOT_CAPACITY_DEFAULT = 1;

/** Run 级认领来源：首次派发 vs 核对停止后的显式恢复代次。 */
export const RUN_DISPATCH_CLAIM_ORIGINS = ['dispatch', 'resume'] as const;
export type RunDispatchClaimOrigin = (typeof RUN_DISPATCH_CLAIM_ORIGINS)[number];

/** 认领/槽位状态：held=持有，quarantined=待核对隔离，released=已核对停止。 */
export const RUN_DISPATCH_CLAIM_STATES = ['held', 'quarantined', 'released'] as const;
export type RunDispatchClaimState = (typeof RUN_DISPATCH_CLAIM_STATES)[number];

/**
 * 派发工作身份：同项目、同 Feature 的已授权 Run 自身。
 * 重复入队稳定返回同一身份；`workKey` 不是身份，也不作为唯一键。
 */
export interface DispatchWorkIdentity {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
}

/** Run 级持久认领记录（迁移 v33 run_dispatch_claims 行）。 */
export interface RunDispatchClaimRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly featureId: string;
  readonly runId: string;
  /** Run 级代次（≥1；同一 Run 内唯一且只增）。 */
  readonly claimVersion: number;
  readonly origin: RunDispatchClaimOrigin;
  /** 恢复关联：上一代认领身份（仅 resume；与版本同时存在）。 */
  readonly resumedFromClaimId: string | null;
  readonly resumedFromClaimVersion: number | null;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly acquiredAtUtcMs: number;
  readonly leaseUntilUtcMs: number;
  readonly state: RunDispatchClaimState;
  /** 有界原因（隔离必须给出；不保存正文/凭据）。 */
  readonly reason: string | null;
  /** 该代次结束时刻（held 为 NULL；租约到期不等于已停止）。 */
  readonly settledAtUtcMs: number | null;
}

/** 单执行槽位认领记录（迁移 v33 execution_slot_claims 行）。 */
export interface ExecutionSlotClaimRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAtUtcMs: number;
  readonly slotIndex: number;
  readonly featureId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly claimVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly acquiredAtUtcMs: number;
  readonly leaseUntilUtcMs: number;
  readonly state: RunDispatchClaimState;
  readonly reason: string | null;
  readonly releasedAtUtcMs: number | null;
}

/**
 * 展示状态：优先复用 Run 领域状态，只额外表达排队事实。
 * `waiting_slot`=已授权等待空槽；`blocked`=认领/占用需要人工核对（原因见下）。
 *
 * 独立导出冻结词汇（F-009）：Host 响应解码只复用该来源，不复制第二份枚举。
 */
export const DISPATCH_DISPLAY_STATES = [
  'queued',
  'waiting_slot',
  'claimed',
  'running',
  'blocked',
  'pausing',
  'paused',
  'cancelling',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type DispatchDisplayState = (typeof DISPATCH_DISPLAY_STATES)[number];

/** 可理解阻塞原因（有界枚举；不是可编辑的第二套状态）。 */
export const DISPATCH_BLOCKING_REASONS = [
  'execution_slot_unavailable',
  'claim_quarantined',
  'claim_lease_expired_unverified',
  'slot_quarantined',
  'slot_ownership_missing',
  'slot_identity_mismatch',
  'claim_attempt_identity_mismatch',
  'run_paused',
  'run_cancelling',
  'run_interrupted',
] as const;
export type DispatchBlockingReason = (typeof DISPATCH_BLOCKING_REASONS)[number];

/** 展示派生输入：Run 状态 + 当前认领/槽位 + 活动 Attempt 身份 + 空槽事实。 */
export interface RunDispatchDisplayFacts {
  readonly runStatus: ExecutionRunStatus;
  /** 该 Run 当前最活动（held/quarantined）或最近一代认领；无则 null。 */
  readonly claim: RunDispatchClaimRecord | null;
  /** 与 claim 对应的活动槽位；无则 null（不是自动补建的理由）。 */
  readonly slot: ExecutionSlotClaimRecord | null;
  /** 当前活动 Attempt 的 fencing 身份（与 claimVersion 无关）。 */
  readonly activeAttempt: {
    readonly executionVersion: number;
    readonly ownerId: string;
    readonly hostInstanceId: string;
  } | null;
  /** 是否仍有可用槽位额度（容量与全局占用由调用方按持久事实计算）。 */
  readonly slotCapacityAvailable: boolean;
  readonly nowUtcMs: number;
}

export interface DispatchDisplay {
  readonly state: DispatchDisplayState;
  readonly blockingReason: DispatchBlockingReason | null;
}

const TERMINAL_RUN_STATUSES: readonly ExecutionRunStatus[] = ['succeeded', 'failed', 'cancelled'];
/** 允许产生 Run 级认领的 Run 状态（终态、pausing/cancelling 不得再认领）。 */
const CLAIMABLE_RUN_STATUSES: readonly ExecutionRunStatus[] = [
  'queued',
  'running',
  'paused',
  'interrupted',
];

const CLAIM_FIELDS = [
  'id',
  'createdAtUtcMs',
  'projectId',
  'revision',
  'updatedAtUtcMs',
  'featureId',
  'runId',
  'claimVersion',
  'origin',
  'resumedFromClaimId',
  'resumedFromClaimVersion',
  'ownerId',
  'hostInstanceId',
  'acquiredAtUtcMs',
  'leaseUntilUtcMs',
  'state',
  'reason',
  'settledAtUtcMs',
] as const;

const SLOT_FIELDS = [
  'id',
  'createdAtUtcMs',
  'projectId',
  'revision',
  'updatedAtUtcMs',
  'slotIndex',
  'featureId',
  'runId',
  'claimId',
  'claimVersion',
  'ownerId',
  'hostInstanceId',
  'acquiredAtUtcMs',
  'leaseUntilUtcMs',
  'state',
  'reason',
  'releasedAtUtcMs',
] as const;

function context(
  operation: string,
  entityType: StorageEntityType,
  id?: string,
): ValidationContext {
  return { operation: `${OPERATION}.${operation}`, entity: { type: entityType, id } };
}

function requireState<T extends string>(
  value: unknown,
  allowed: readonly T[],
  ctx: ValidationContext,
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationError(ctx, field, `必须是 ${allowed.join('|')} 之一`, value);
  }
  return value as T;
}

function requireBoundedReason(
  value: unknown,
  ctx: ValidationContext,
  field: string,
  required: boolean,
): string | null {
  if (value === null || value === undefined) {
    if (required) {
      throw validationError(ctx, field, '隔离/阻塞原因必填（有界、不含正文或凭据）', value);
    }
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw validationError(ctx, field, '必须是 1..512 字符的有界原因', value);
  }
  return value;
}

function requireOptionalId(
  value: unknown,
  ctx: ValidationContext,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return validateStableId(value, ctx, field);
}

/**
 * 派生派发工作身份：只接受 Run 的项目/Feature/Run 身份。
 * 显式拒绝 `workKey` 等额外字段——它表示可跨重试的逻辑工作，不是队列唯一键。
 */
export function deriveDispatchWorkIdentity(value: unknown): DispatchWorkIdentity {
  const ctx = context('deriveWorkIdentity', 'run');
  const raw = requirePlainObject(value, ctx, 'identity');
  rejectUnknownKeys(raw, ['projectId', 'featureId', 'runId'], ctx, 'identity');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
  };
}

/** 校验 Run 级认领记录（读取/写入两侧共用；非法形状不进入任何 SQL）。 */
export function validateRunDispatchClaimRecord(value: unknown): RunDispatchClaimRecord {
  const raw = requirePlainObject(
    value,
    context('validateClaimRecord', 'run_dispatch_claim'),
    'claim',
  );
  const ctx = context(
    'validateClaimRecord',
    'run_dispatch_claim',
    typeof raw.id === 'string' ? raw.id : undefined,
  );
  rejectUnknownKeys(raw, CLAIM_FIELDS, ctx, 'claim');
  const origin = requireState(raw.origin, RUN_DISPATCH_CLAIM_ORIGINS, ctx, 'origin');
  const state = requireState(raw.state, RUN_DISPATCH_CLAIM_STATES, ctx, 'state');
  const claimVersion = validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion');
  const resumedFromClaimId = requireOptionalId(raw.resumedFromClaimId, ctx, 'resumedFromClaimId');
  const resumedFromClaimVersion =
    raw.resumedFromClaimVersion === null || raw.resumedFromClaimVersion === undefined
      ? null
      : validatePositiveInteger(raw.resumedFromClaimVersion, ctx, 'resumedFromClaimVersion');
  if (origin === 'dispatch') {
    if (claimVersion !== 1 || resumedFromClaimId !== null || resumedFromClaimVersion !== null) {
      throw validationError(
        ctx,
        'origin',
        '首代认领必须是 dispatch/v1 且无恢复来源（workKey 不参与身份）',
        origin,
      );
    }
  } else if (
    resumedFromClaimId === null ||
    resumedFromClaimVersion === null ||
    resumedFromClaimVersion !== claimVersion - 1
  ) {
    throw validationError(
      ctx,
      'resumedFromClaimId',
      'resume 认领必须关联上一代（version-1）的已释放认领',
      resumedFromClaimId,
    );
  }
  const acquiredAtUtcMs = validatePositiveInteger(raw.acquiredAtUtcMs, ctx, 'acquiredAtUtcMs');
  const leaseUntilUtcMs = validatePositiveInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs');
  if (leaseUntilUtcMs < acquiredAtUtcMs) {
    throw validationError(ctx, 'leaseUntilUtcMs', '租约到期不得早于认领时刻', leaseUntilUtcMs);
  }
  const settledAtUtcMs =
    raw.settledAtUtcMs === null || raw.settledAtUtcMs === undefined
      ? null
      : validateNonNegativeInteger(raw.settledAtUtcMs, ctx, 'settledAtUtcMs');
  const reason = requireBoundedReason(raw.reason, ctx, 'reason', state === 'quarantined');
  if (state === 'held') {
    if (settledAtUtcMs !== null || reason !== null) {
      throw validationError(ctx, 'state', 'held 认领不得携带结束时间或原因', state);
    }
  } else if (settledAtUtcMs === null || settledAtUtcMs < acquiredAtUtcMs) {
    throw validationError(ctx, 'settledAtUtcMs', '已结算认领必须有 ≥ 认领时刻的结束时间', settledAtUtcMs);
  }
  return {
    id: validateStableId(raw.id, ctx, 'id'),
    createdAtUtcMs: validateNonNegativeInteger(raw.createdAtUtcMs, ctx, 'createdAtUtcMs'),
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    revision: validatePositiveInteger(raw.revision, ctx, 'revision'),
    updatedAtUtcMs: validateNonNegativeInteger(raw.updatedAtUtcMs, ctx, 'updatedAtUtcMs'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    claimVersion,
    origin,
    resumedFromClaimId,
    resumedFromClaimVersion,
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
    acquiredAtUtcMs,
    leaseUntilUtcMs,
    state,
    reason,
    settledAtUtcMs,
  };
}

/** 校验单执行槽位认领记录（读取/写入两侧共用）。 */
export function validateExecutionSlotClaimRecord(value: unknown): ExecutionSlotClaimRecord {
  const raw = requirePlainObject(
    value,
    context('validateSlotRecord', 'execution_slot_claim'),
    'slot',
  );
  const ctx = context(
    'validateSlotRecord',
    'execution_slot_claim',
    typeof raw.id === 'string' ? raw.id : undefined,
  );
  rejectUnknownKeys(raw, SLOT_FIELDS, ctx, 'slot');
  const state = requireState(raw.state, RUN_DISPATCH_CLAIM_STATES, ctx, 'state');
  const acquiredAtUtcMs = validatePositiveInteger(raw.acquiredAtUtcMs, ctx, 'acquiredAtUtcMs');
  const leaseUntilUtcMs = validatePositiveInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs');
  if (leaseUntilUtcMs < acquiredAtUtcMs) {
    throw validationError(ctx, 'leaseUntilUtcMs', '租约到期不得早于获得时刻', leaseUntilUtcMs);
  }
  const releasedAtUtcMs =
    raw.releasedAtUtcMs === null || raw.releasedAtUtcMs === undefined
      ? null
      : validateNonNegativeInteger(raw.releasedAtUtcMs, ctx, 'releasedAtUtcMs');
  const reason = requireBoundedReason(raw.reason, ctx, 'reason', state === 'quarantined');
  if (state === 'released') {
    if (releasedAtUtcMs === null || releasedAtUtcMs < acquiredAtUtcMs) {
      throw validationError(ctx, 'releasedAtUtcMs', '已释放槽位必须有 ≥ 获得时刻的释放时间', releasedAtUtcMs);
    }
  } else if (releasedAtUtcMs !== null) {
    throw validationError(ctx, 'releasedAtUtcMs', '未释放槽位不得携带释放时间', releasedAtUtcMs);
  }
  if (state === 'held' && reason !== null) {
    throw validationError(ctx, 'reason', 'held 槽位不得携带原因', state);
  }
  return {
    id: validateStableId(raw.id, ctx, 'id'),
    createdAtUtcMs: validateNonNegativeInteger(raw.createdAtUtcMs, ctx, 'createdAtUtcMs'),
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    revision: validatePositiveInteger(raw.revision, ctx, 'revision'),
    updatedAtUtcMs: validateNonNegativeInteger(raw.updatedAtUtcMs, ctx, 'updatedAtUtcMs'),
    slotIndex: validateNonNegativeInteger(raw.slotIndex, ctx, 'slotIndex'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    claimId: validateStableId(raw.claimId, ctx, 'claimId'),
    claimVersion: validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
    acquiredAtUtcMs,
    leaseUntilUtcMs,
    state,
    reason,
    releasedAtUtcMs,
  };
}

/**
 * 校验执行槽位容量：缺省 1；大于 1 明确拒绝（不支持/配置拒绝），0、负数、
 * 非整数与非数字同样 fail-closed；不做「接受配置后暗中串行」。
 */
export function validateExecutionSlotCapacity(value: unknown = EXECUTION_SLOT_CAPACITY_DEFAULT): number {
  const ctx = context('validateSlotCapacity', 'execution_slot_claim');
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError(ctx, 'capacity', '必须是 ≥1 的整数执行槽位容量', value);
  }
  if (value > EXECUTION_SLOT_CAPACITY_DEFAULT) {
    throw new StorageError(
      'validation',
      ctx.operation,
      '执行槽位容量大于 1 尚未支持（不表面接受后暗中串行）',
      { entity: ctx.entity, details: { field: 'capacity', reason: 'capacity_unsupported', capacity: value } },
    );
  }
  return value;
}

/** 该 Run 状态是否允许产生 Run 级认领（终态、pausing/cancelling 均拒绝）。 */
export function assertRunDispatchClaimAllowed(runStatus: ExecutionRunStatus): void {
  const ctx = context('assertClaimAllowed', 'run_dispatch_claim');
  if (!CLAIMABLE_RUN_STATUSES.includes(runStatus)) {
    throw new StorageError(
      'conflict',
      ctx.operation,
      `Run 状态 ${runStatus} 不允许产生新的 Run 级认领（终态不重开、控制中不抢占）`,
      { entity: ctx.entity, details: { field: 'runStatus', reason: 'run_not_claimable' } },
    );
  }
}

/**
 * 校验认领更新：身份列不可变、revision 严格递增、状态转换合法、
 * held 续租不得缩短租约。旧 owner/version 不能借此释放新持有者。
 */
export function assertRunDispatchClaimTransition(
  previous: RunDispatchClaimRecord,
  next: RunDispatchClaimRecord,
): void {
  const prev = validateRunDispatchClaimRecord(previous);
  const cur = validateRunDispatchClaimRecord(next);
  const ctx = context('assertClaimTransition', 'run_dispatch_claim', prev.id);
  const immutable: readonly (keyof RunDispatchClaimRecord)[] = [
    'id',
    'createdAtUtcMs',
    'projectId',
    'featureId',
    'runId',
    'claimVersion',
    'origin',
    'resumedFromClaimId',
    'resumedFromClaimVersion',
    'ownerId',
    'hostInstanceId',
    'acquiredAtUtcMs',
  ];
  for (const field of immutable) {
    if (prev[field] !== cur[field]) {
      throw new StorageError(
        'conflict',
        ctx.operation,
        `Run 级认领身份字段 ${field} 不可变（旧 owner/version 不能改写当前认领）`,
        { entity: ctx.entity, details: { field } },
      );
    }
  }
  if (cur.revision !== prev.revision + 1) {
    throw new StorageError(
      'conflict',
      ctx.operation,
      'Run 级认领更新必须按 revision+1 做 CAS（不得跳号或回退）',
      { entity: ctx.entity, details: { field: 'revision', expectedRevision: prev.revision + 1 } },
    );
  }
  if (cur.updatedAtUtcMs < prev.updatedAtUtcMs) {
    throw validationError(ctx, 'updatedAtUtcMs', '更新时间不得回退', cur.updatedAtUtcMs);
  }
  const legal: Record<RunDispatchClaimState, readonly RunDispatchClaimState[]> = {
    held: ['held', 'released', 'quarantined'],
    quarantined: ['quarantined', 'released'],
    released: ['released'],
  };
  if (!legal[prev.state].includes(cur.state)) {
    throw new StorageError(
      'conflict',
      ctx.operation,
      `非法认领转换 ${prev.state}→${cur.state}（隔离不自动回收，已释放终态不复活）`,
      { entity: ctx.entity, details: { field: 'state', reason: 'illegal_state_transition' } },
    );
  }
  if (prev.state === 'held' && cur.state === 'held' && cur.leaseUntilUtcMs < prev.leaseUntilUtcMs) {
    throw validationError(ctx, 'leaseUntilUtcMs', '续租不得缩短当前租约', cur.leaseUntilUtcMs);
  }
}

/**
 * 校验 resume 代次关联：上一代必须已释放（停止已核对），新代次只更新受控代次，
 * 不修改旧认领行、不重开终态 Attempt、不清理预算/证据。
 */
export function assertRunDispatchResumeLink(input: {
  readonly previousClaim: RunDispatchClaimRecord;
  readonly nextClaim: RunDispatchClaimRecord;
}): void {
  const previous = validateRunDispatchClaimRecord(input.previousClaim);
  const next = validateRunDispatchClaimRecord(input.nextClaim);
  const ctx = context('assertResumeLink', 'run_dispatch_claim', previous.id);
  if (previous.projectId !== next.projectId || previous.featureId !== next.featureId || previous.runId !== next.runId) {
    throw new StorageError('ownership', ctx.operation, 'resume 认领必须属于同一项目/Feature/Run', {
      entity: ctx.entity,
      details: { field: 'identity', reason: 'resume_scope_mismatch' },
    });
  }
  if (previous.state !== 'released') {
    throw new StorageError(
      'conflict',
      ctx.operation,
      '上一代认领未核对停止并释放，不得生成 resume 代次',
      { entity: ctx.entity, details: { field: 'state', reason: 'previous_claim_not_released' } },
    );
  }
  if (next.origin !== 'resume' || next.claimVersion !== previous.claimVersion + 1) {
    throw new StorageError(
      'conflict',
      ctx.operation,
      'resume 只能追加受控认领代次（origin=resume 且 version=上一代+1）',
      { entity: ctx.entity, details: { field: 'claimVersion', reason: 'illegal_claim_generation' } },
    );
  }
  if (next.resumedFromClaimId !== previous.id || next.resumedFromClaimVersion !== previous.claimVersion) {
    throw new StorageError(
      'conflict',
      ctx.operation,
      'resume 认领必须精确引用上一代认领身份与版本',
      { entity: ctx.entity, details: { field: 'resumedFromClaimId', reason: 'lineage_mismatch' } },
    );
  }
}

/** Attempt 与 Run 级认领的关联输入（executionVersion 是独立 fencing 计数）。 */
export interface DispatchClaimAttemptLink {
  readonly claim: RunDispatchClaimRecord;
  readonly attempt: {
    readonly projectId: string;
    readonly featureId: string;
    readonly runId: string;
    readonly ownerId: string;
    readonly hostInstanceId: string;
    readonly executionVersion: number;
    readonly createdAtUtcMs: number;
  };
}

/**
 * 校验 Attempt 归属当前 Run 级认领：同项目/Feature/Run、同 owner/host，且在该代次
 * 取得之后创建。`executionVersion` 只要求 ≥1 且与 `claimVersion` 无关（不可等同）。
 */
export function assertDispatchClaimOwnsAttempt(link: DispatchClaimAttemptLink): void {
  const claim = validateRunDispatchClaimRecord(link.claim);
  const ctx = context('assertClaimOwnsAttempt', 'run_dispatch_claim', claim.id);
  const attempt = requirePlainObject(link.attempt, ctx, 'attempt');
  const attemptProject = validateStableId(attempt.projectId, ctx, 'attempt.projectId');
  const attemptFeature = validateStableId(attempt.featureId, ctx, 'attempt.featureId');
  const attemptRun = validateStableId(attempt.runId, ctx, 'attempt.runId');
  const attemptOwner = validateStableId(attempt.ownerId, ctx, 'attempt.ownerId');
  const attemptHost = validateStableId(attempt.hostInstanceId, ctx, 'attempt.hostInstanceId');
  const executionVersion = validatePositiveInteger(attempt.executionVersion, ctx, 'attempt.executionVersion');
  const createdAtUtcMs = validateNonNegativeInteger(attempt.createdAtUtcMs, ctx, 'attempt.createdAtUtcMs');
  if (claim.state !== 'held') {
    throw new StorageError('conflict', ctx.operation, '非 held 认领不得创建或接管 Attempt', {
      entity: ctx.entity,
      details: { field: 'state', reason: 'claim_not_held' },
    });
  }
  if (
    attemptProject !== claim.projectId ||
    attemptFeature !== claim.featureId ||
    attemptRun !== claim.runId
  ) {
    throw new StorageError('ownership', ctx.operation, 'Attempt 必须属于该 Run 级认领的同项目/Feature/Run', {
      entity: ctx.entity,
      details: { field: 'identity', reason: 'attempt_scope_mismatch' },
    });
  }
  if (attemptOwner !== claim.ownerId || attemptHost !== claim.hostInstanceId) {
    throw new StorageError('conflict', ctx.operation, 'Attempt 的 owner/host 与当前 Run 级认领不一致（fencing）', {
      entity: ctx.entity,
      details: { field: 'ownerId', reason: 'claim_owner_mismatch' },
    });
  }
  if (createdAtUtcMs < claim.acquiredAtUtcMs) {
    throw new StorageError('conflict', ctx.operation, 'Attempt 早于该认领代次取得时刻，不能归入本代次', {
      entity: ctx.entity,
      details: { field: 'createdAtUtcMs', reason: 'attempt_predates_claim' },
    });
  }
  // 独立计数器：这里只做范围校验，绝不比较 executionVersion 与 claimVersion。
  if (executionVersion < 1) {
    throw validationError(ctx, 'attempt.executionVersion', '必须是 ≥1 的独立 Task/Attempt 版本', executionVersion);
  }
}

/**
 * 从 Run、认领与占用派生展示状态。持久层不保存可任意编辑的展示状态；
 * 租约到期、隔离与缺失占用都只呈现为需核对的阻塞原因，不自动改写为已停止。
 */
export function deriveRunDispatchDisplay(facts: RunDispatchDisplayFacts): DispatchDisplay {
  const ctx = context('deriveDisplay', 'run_dispatch_claim');
  const nowUtcMs = validateNonNegativeInteger(facts.nowUtcMs, ctx, 'nowUtcMs');
  if (typeof facts.slotCapacityAvailable !== 'boolean') {
    throw validationError(ctx, 'slotCapacityAvailable', '必须是布尔值', facts.slotCapacityAvailable);
  }
  const runStatus = facts.runStatus;
  if (TERMINAL_RUN_STATUSES.includes(runStatus)) {
    return { state: runStatus as DispatchDisplayState, blockingReason: null };
  }
  if (runStatus === 'pausing') {
    return { state: 'pausing', blockingReason: 'run_paused' };
  }
  if (runStatus === 'paused') {
    return { state: 'paused', blockingReason: 'run_paused' };
  }
  if (runStatus === 'cancelling') {
    return { state: 'cancelling', blockingReason: 'run_cancelling' };
  }
  if (runStatus === 'interrupted') {
    return { state: 'interrupted', blockingReason: 'run_interrupted' };
  }
  const claim =
    facts.claim !== null && facts.claim.state !== 'released'
      ? validateRunDispatchClaimRecord(facts.claim)
      : null;
  if (claim === null) {
    return facts.slotCapacityAvailable
      ? { state: 'queued', blockingReason: null }
      : { state: 'waiting_slot', blockingReason: 'execution_slot_unavailable' };
  }
  if (claim.state === 'quarantined') {
    return { state: 'blocked', blockingReason: 'claim_quarantined' };
  }
  if (nowUtcMs > claim.leaseUntilUtcMs) {
    return { state: 'blocked', blockingReason: 'claim_lease_expired_unverified' };
  }
  const slot = facts.slot === null ? null : validateExecutionSlotClaimRecord(facts.slot);
  if (slot === null) {
    return { state: 'blocked', blockingReason: 'slot_ownership_missing' };
  }
  if (
    slot.projectId !== claim.projectId ||
    slot.runId !== claim.runId ||
    slot.claimId !== claim.id ||
    slot.claimVersion !== claim.claimVersion
  ) {
    return { state: 'blocked', blockingReason: 'slot_identity_mismatch' };
  }
  if (slot.state === 'quarantined') {
    return { state: 'blocked', blockingReason: 'slot_quarantined' };
  }
  if (slot.state === 'released') {
    return { state: 'blocked', blockingReason: 'slot_ownership_missing' };
  }
  const activeAttempt = facts.activeAttempt;
  if (activeAttempt !== null) {
    if (
      activeAttempt.ownerId !== claim.ownerId ||
      activeAttempt.hostInstanceId !== claim.hostInstanceId
    ) {
      return { state: 'blocked', blockingReason: 'claim_attempt_identity_mismatch' };
    }
    validatePositiveInteger(activeAttempt.executionVersion, ctx, 'activeAttempt.executionVersion');
    if (runStatus === 'running') {
      return { state: 'running', blockingReason: null };
    }
  }
  return { state: 'claimed', blockingReason: null };
}

/* ------------------------------------------------------------------ *
 * P04-9 / F-002 持久入队意图（Run 已授权即持久执行意图）
 *
 * 复用与新增边界：
 * - Run 行（queued + 不可变授权快照）仍是唯一业务事实，入队不创建第二套
 *   Batch/Run/预算；本结构只补既有列无法表达的「入队事实」：第几次以何种
 *   授权来源登记、授权身份摘要，以及可用于有界补扫的登记顺序；
 * - 入队意图在启动/重试/resume/仅收尾同一短写事务内登记，与 Run、命令回执、
 *   脱敏事件同生共死；不是「先 accepted 再靠内存回调补写」；
 * - 意图按派发身份（projectId + runId）唯一：同 Run 重复入队稳定复用同一行，
 *   不新增 Run/Attempt/预算或事件；显式重试产生新 Run，因此有独立意图，
 *   `workKey` 不是唯一键；
 * - 仅插入（身份与原因列由 trigger 冻结）：消费/认领交由 F-003/F-004 的槽位
 *   与 Task 认领原语；本契约不预建消费状态机；
 * - 入口只在受信 Core 事务上下文（CommandTransaction）内可用，不新增模型可
 *   自由写队列的命令操作。
 * ------------------------------------------------------------------ */

/** 入队来源：首次授权、同父 Batch 显式重试、显式 resume、仅收尾重试。 */
export const RUN_DISPATCH_INTENT_SOURCES = [
  'start',
  'retry',
  'resume',
  'finalization_retry',
] as const;
export type RunDispatchIntentSource = (typeof RUN_DISPATCH_INTENT_SOURCES)[number];

/** 授权身份摘要领域前缀（把摘要锚定到 Run 级派发授权身份 v1）。 */
export const RUN_DISPATCH_INTENT_DIGEST_DOMAIN = 'shiploop:run-dispatch-intent:v1';

/** 有界原因长度（与既有派发/隔离原因上限一致；不含正文/凭据）。 */
export const RUN_DISPATCH_INTENT_REASON_MAX_LENGTH = 512;

/** 补扫上限（有界查询；不是全表扫描授权）。 */
export const RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT = 100;

/** Run 入队意图记录（迁移 v34 run_dispatch_intents 行；插入后身份不可变）。 */
export interface RunDispatchIntentRecord {
  readonly id: string;
  readonly createdAtUtcMs: number;
  readonly projectId: string;
  readonly updatedAtUtcMs: number;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly source: RunDispatchIntentSource;
  /** 授权身份摘要（见 computeRunDispatchAuthorizationDigest；同身份异摘要即冲突）。 */
  readonly authorizationDigest: string;
  readonly enqueuedAtUtcMs: number;
  /** 有界排队原因（如未装配调度器；不含正文/凭据）。 */
  readonly reason: string | null;
}

/** 入队意图写入输入（id/时间戳/摘要由存储原语在同一事务内定值）。 */
export interface RunDispatchIntentInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly source: RunDispatchIntentSource;
  readonly authorizationDigest: string;
  readonly reason?: string | null;
}

/** 入队结果：created=首次登记；reused=同身份重复入队（零新增/零事件）。 */
export interface RunDispatchIntentRegistration {
  readonly intent: RunDispatchIntentRecord;
  readonly outcome: 'created' | 'reused';
}

/** 有界补扫输入（同项目；limit 必填且有上限）。 */
export interface RunDispatchIntentScanInput {
  readonly projectId: string;
  readonly limit: number;
}

/**
 * 补扫记录：意图 + 当前 Run 状态 + 活动认领身份（只读事实，不判定消费策略）。
 * 补扫命中不代表可自动执行：暂停/取消/终态仍由后续消费方按原有授权核对。
 */
export interface RunDispatchIntentScanRecord extends RunDispatchIntentRecord {
  readonly runStatus: ExecutionRunStatus;
  readonly activeClaimId: string | null;
}

const INTENT_INPUT_KEYS = [
  'projectId',
  'featureId',
  'batchId',
  'runId',
  'source',
  'authorizationDigest',
  'reason',
] as const;

const INTENT_RECORD_KEYS = [
  'id',
  'createdAtUtcMs',
  'projectId',
  'updatedAtUtcMs',
  'featureId',
  'batchId',
  'runId',
  'source',
  'authorizationDigest',
  'enqueuedAtUtcMs',
  'reason',
] as const;

function requireIntentSource(
  value: unknown,
  ctx: ValidationContext,
  field: string,
): RunDispatchIntentSource {
  if (typeof value !== 'string' || !(RUN_DISPATCH_INTENT_SOURCES as readonly string[]).includes(value)) {
    throw validationError(ctx, field, `必须是 ${RUN_DISPATCH_INTENT_SOURCES.join('|')} 之一`, value);
  }
  return value as RunDispatchIntentSource;
}

function requireIntentReason(
  value: unknown,
  ctx: ValidationContext,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > RUN_DISPATCH_INTENT_REASON_MAX_LENGTH
  ) {
    throw validationError(
      ctx,
      field,
      `必须是 1..${RUN_DISPATCH_INTENT_REASON_MAX_LENGTH} 字符的有界原因（不含正文或凭据）`,
      value,
    );
  }
  return value;
}

/** 授权身份摘要输入：只取 Run 行的授权身份级字段（不含 revision/状态/时间）。 */
export interface RunDispatchAuthorizationIdentity {
  readonly projectId: string;
  readonly featureId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly purpose: string;
  readonly scopeDigest: string;
  readonly workKey: string;
  readonly dispatchOrdinal: number;
}

/**
 * 授权身份摘要：SHA-256(`${DOMAIN}\n${canonical}`)。同 Run 的 resume 不改变
 * 这些成分（只改状态/revision），因此重复入队稳定复用；伪造/过期身份
 * （换 scopeDigest、workKey、dispatchOrdinal 或跨项目 Run）摘要不一致 →
 * 存储原语在事务内重算并拒绝。
 */
export function computeRunDispatchAuthorizationDigest(
  identity: RunDispatchAuthorizationIdentity,
): string {
  const ctx = context('computeAuthorizationDigest', 'run_dispatch_intent');
  const raw = requirePlainObject(identity, ctx, 'identity');
  rejectUnknownKeys(
    raw,
    ['projectId', 'featureId', 'batchId', 'runId', 'purpose', 'scopeDigest', 'workKey', 'dispatchOrdinal'],
    ctx,
    'identity',
  );
  const canonical = stableStringify({
    schemaVersion: 1,
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    batchId: validateStableId(raw.batchId, ctx, 'batchId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    purpose: validateStableId(raw.purpose, ctx, 'purpose'),
    scopeDigest: validateSha256Digest(raw.scopeDigest, ctx, 'scopeDigest'),
    workKey: validateStableId(raw.workKey, ctx, 'workKey'),
    dispatchOrdinal: validatePositiveInteger(raw.dispatchOrdinal, ctx, 'dispatchOrdinal'),
  });
  return createHash('sha256').update(`${RUN_DISPATCH_INTENT_DIGEST_DOMAIN}\n${canonical}`, 'utf8').digest('hex');
}

/** 校验入队写入输入（拒绝 workKey 等额外字段：workKey 不是队列唯一键）。 */
export function validateRunDispatchIntentInput(value: unknown): RunDispatchIntentInput {
  const ctx = context('validateIntentInput', 'run_dispatch_intent');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, INTENT_INPUT_KEYS, ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    batchId: validateStableId(raw.batchId, ctx, 'batchId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    source: requireIntentSource(raw.source, ctx, 'source'),
    authorizationDigest: validateSha256Digest(raw.authorizationDigest, ctx, 'authorizationDigest'),
    reason: requireIntentReason(raw.reason, ctx, 'reason'),
  };
}

/** 校验入队意图记录（读取/写入两侧共用；非法形状不进入任何 SQL）。 */
export function validateRunDispatchIntentRecord(value: unknown): RunDispatchIntentRecord {
  const raw = requirePlainObject(
    value,
    context('validateIntentRecord', 'run_dispatch_intent'),
    'intent',
  );
  const ctx = context(
    'validateIntentRecord',
    'run_dispatch_intent',
    typeof raw.id === 'string' ? raw.id : undefined,
  );
  rejectUnknownKeys(raw, INTENT_RECORD_KEYS, ctx, 'intent');
  const enqueuedAtUtcMs = validatePositiveInteger(raw.enqueuedAtUtcMs, ctx, 'enqueuedAtUtcMs');
  const createdAtUtcMs = validateNonNegativeInteger(raw.createdAtUtcMs, ctx, 'createdAtUtcMs');
  const updatedAtUtcMs = validateNonNegativeInteger(raw.updatedAtUtcMs, ctx, 'updatedAtUtcMs');
  if (updatedAtUtcMs < createdAtUtcMs) {
    throw validationError(ctx, 'updatedAtUtcMs', '更新时间不得早于创建时间', updatedAtUtcMs);
  }
  return {
    id: validateStableId(raw.id, ctx, 'id'),
    createdAtUtcMs,
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    updatedAtUtcMs,
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    batchId: validateStableId(raw.batchId, ctx, 'batchId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    source: requireIntentSource(raw.source, ctx, 'source'),
    authorizationDigest: validateSha256Digest(raw.authorizationDigest, ctx, 'authorizationDigest'),
    enqueuedAtUtcMs,
    reason: requireIntentReason(raw.reason, ctx, 'reason'),
  };
}

/** 校验补扫输入：项目身份 + 1..100 的有界每轮上限。 */
export function validateRunDispatchIntentScanInput(value: unknown): RunDispatchIntentScanInput {
  const ctx = context('validateIntentScan', 'run_dispatch_intent');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'limit'], ctx, 'input');
  const limit = validatePositiveInteger(raw.limit, ctx, 'limit');
  if (limit > RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT) {
    throw validationError(ctx, 'limit', `必须是 1..${RUN_DISPATCH_INTENT_SCAN_MAX_LIMIT} 的有界上限`, limit);
  }
  return { projectId: validateStableId(raw.projectId, ctx, 'projectId'), limit };
}

/**
 * 入队可创建性：只对「已授权、尚未开始」的意图成立（Run queued、Batch 未终态
 * 且未进入暂停/取消控制、项目 active）。已存在的意图走复用路径，不受本检查
 * 影响——复用不重新授权、不产生新 Run。
 */
export function assertRunDispatchIntentEnqueueable(input: {
  readonly runStatus: ExecutionRunStatus;
  readonly batchStatus: ExecutionBatchStatus;
  readonly projectStatus: string;
}): void {
  const ctx = context('assertIntentEnqueueable', 'run_dispatch_intent');
  const raw = requirePlainObject(input, ctx, 'input');
  rejectUnknownKeys(raw, ['runStatus', 'batchStatus', 'projectStatus'], ctx, 'input');
  const runStatus = raw.runStatus;
  const batchStatus = raw.batchStatus;
  const projectStatus = raw.projectStatus;
  if (typeof projectStatus !== 'string' || projectStatus.length === 0) {
    throw validationError(ctx, 'projectStatus', '必须是项目状态字符串', projectStatus);
  }
  if (projectStatus !== 'active') {
    throw new StorageError('conflict', ctx.operation, '项目非 active，不得登记新的派发意图', {
      entity: ctx.entity,
      details: { field: 'projectStatus', reason: 'project_not_active' },
    });
  }
  if (runStatus !== 'queued') {
    throw new StorageError(
      'conflict',
      ctx.operation,
      `Run 状态 ${String(runStatus)} 不接受新的派发意图（已开始/暂停/取消/终态不重开）`,
      { entity: ctx.entity, details: { field: 'runStatus', reason: 'run_not_enqueueable' } },
    );
  }
  if (batchStatus !== 'queued' && batchStatus !== 'running') {
    throw new StorageError(
      'conflict',
      ctx.operation,
      `Batch 状态 ${String(batchStatus)} 不接受新的派发意图（终态/控制中不重开）`,
      { entity: ctx.entity, details: { field: 'batchStatus', reason: 'batch_not_enqueueable' } },
    );
  }
}
