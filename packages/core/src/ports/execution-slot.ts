/**
 * P04-9 / F-003 单执行槽位事务原语契约（ports 层：身份、输入校验、纯绑定检查；
 * 无任何 I/O）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.2、core-design/15
 * §3 与 F-001 契约 docs/p04-9-f001-dispatch-slot-contract.md。
 *
 * 职责边界（四种资源职责不得互相冒充）：
 * - 执行槽位（本契约）：只限制「同时运行的 Run 消费者数量」；
 * - `global:execution`、`project:<id>:work`、workspace 三组 Attempt 租约：
 *   由 `ports/work-resources.ts` 与既有 Task 认领事务维护，槽位不得伪造、替代、
 *   释放或改写它们；
 * - 基线占用与 Git 公共元数据短锁：由既有 baseline/Git 端口维护。
 *
 * 身份与代次：槽位绑定项目 / Feature / Run / 认领行 / Run 级认领版本 / owner /
 * Host 实例。`claimVersion` 是 Run 级消费者代次（F-001），与 Task/Attempt
 * `executionVersion` 无关；本契约从不比较二者。
 *
 * 状态与自动回收：`held`（持有）→ `released`（核对停止后释放，终态）或
 * `quarantined`（待核对隔离）。租约到期只转成 `quarantined`，从不自动删除、
 * 缩短或重新分配给新持有者；隔离行继续占用量额，必须经受信恢复流程核对后才能
 * 释放（本契约不提供未经核对的隔离释放入口）。
 *
 * 事务纪律：全部写原语只在调用方已打开的短写事务内使用，不做进程/网络/文件
 * 准备或测试；调用方负责整组提交或回滚。
 */
import type { ExecutionSlotClaimRecord } from './execution-dispatch.js';
import { StorageError } from './errors.js';
import type { StorageEntityType } from './errors.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

const OPERATION = 'ExecutionSlot';

/** 槽位拒绝/阻塞原因（有界枚举；用于结构化错误，不是可编辑的第二套状态）。 */
export const EXECUTION_SLOT_REJECTION_REASONS = [
  /** 容量已满（其他 Run 占用，或同 Run 已有不同认领身份的槽位）。 */
  'execution_slot_unavailable',
  /** 同一 Run 的活动槽位属于另一代认领/owner/host。 */
  'slot_identity_conflict',
  /** 认领行缺失或与请求身份不一致（旧 owner/version 不能抢占）。 */
  'slot_claim_identity_mismatch',
  /** 认领已非 held（隔离/已释放），不能新占或续租槽位。 */
  'slot_claim_not_held',
  /** 槽位行与请求身份不一致（旧 owner/version 不能续租/释放当前槽位）。 */
  'slot_identity_mismatch',
  /** 槽位已释放（终态，不复活）。 */
  'slot_released',
  /** 槽位已隔离：只能经受信核对后处理，不自动回收。 */
  'slot_quarantined',
  /** 槽位租约已到期，需先核对旧执行是否停止。 */
  'slot_lease_expired_unverified',
  /** 槽位租约不得长于 Run 级认领租约。 */
  'slot_lease_exceeds_claim',
] as const;
export type ExecutionSlotRejectionReason = (typeof EXECUTION_SLOT_REJECTION_REASONS)[number];

/** 槽位活动集（`held` 与 `quarantined` 都占用活动身份/量额）。 */
export const ACTIVE_EXECUTION_SLOT_STATES = ['held', 'quarantined'] as const;

/** 租约到期隔离原因（有界、无正文/凭据；与 F-001 展示原因同族）。 */
export const EXECUTION_SLOT_LEASE_EXPIRED_REASON = 'lease_expired_unverified';

/**
 * 读取输入：以项目 + Run 定位活动槽位（不打开事务，单语句一致读）。
 */
export interface ExecutionSlotRunRef {
  readonly projectId: string;
  readonly runId: string;
}

/** 精确读取输入：项目 + 槽位 id（诊断/审计用，含已释放历史行）。 */
export interface ExecutionSlotRef {
  readonly projectId: string;
  readonly slotId: string;
}

/**
 * 槽位身份：精确到一槽一持有者。更新/续租/释放必须提供完整身份，
 * 旧 owner/version 或伪造 id 不能命中当前槽位。
 */
export interface ExecutionSlotIdentity {
  readonly projectId: string;
  readonly slotId: string;
  readonly claimId: string;
  readonly claimVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

/** 获取输入：绑定 Run 级认领身份的完整准入事实（不含手工 slotIndex/状态）。 */
export interface ExecutionSlotAcquireInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly claimVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
  readonly leaseUntilUtcMs: number;
}

/** 槽位与认领行的绑定事实（纯检查，不读写存储）。 */
export interface ExecutionSlotClaimBinding {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly claimVersion: number;
  readonly ownerId: string;
  readonly hostInstanceId: string;
}

/**
 * 单执行槽位窄端口：可组合的短事务原语。
 * - 所有 `*InTransaction` 方法要求调用方已打开写事务，且只做同步 SQL；
 * - 获取失败一律返回结构化冲突（`details.reason` 见
 *   `EXECUTION_SLOT_REJECTION_REASONS`），失败路径不留下部分写入，由调用方
 *   整组回滚（因此不会产生 Attempt、预算扣减或 Runner 启动）。
 */
export interface ExecutionSlotAccess {
  /** 装配时核验并固定的容量（首版恒为 1；>1/0/负数/非整数在装配时拒绝）。 */
  readonly capacity: number;
  /** 项目 + Run 的活动槽位（held/quarantined）；无则 null。只读。 */
  readActive(input: unknown): ExecutionSlotClaimRecord | null;
  /** 项目 + 槽位 id 的任意状态记录；无则 null。只读。 */
  read(input: unknown): ExecutionSlotClaimRecord | null;
  /**
   * 获取或复用槽位（幂等）：同一认领身份重复获取返回同一行，零新增；
   * 容量已满/同 Run 异身份/租约到期/已隔离一律 fail-closed。
   */
  acquireInTransaction(input: unknown): ExecutionSlotClaimRecord;
  /**
   * 续租：必须匹配当前身份；不得缩短租约、不得长于认领租约。
   * 若槽位租约已到期，则不延长而是转 `quarantined` 并返回该记录，
   * 调用方必须把非 held 结果视为不再授权（隔离不会被自动回收）。
   */
  renewInTransaction(input: unknown, leaseUntilUtcMs: unknown): ExecutionSlotClaimRecord;
  /**
   * 核对停止后的正常释放：必须匹配当前身份且租约仍有效；已释放幂等返回。
   * 已隔离或已到期一律拒绝（需后续受信恢复流程核对，不能在此伪造释放）。
   */
  releaseInTransaction(input: unknown): ExecutionSlotClaimRecord;
  /** 显式隔离（如停止不确定）：必须匹配当前身份；重复隔离幂等返回原原因。 */
  quarantineInTransaction(input: unknown, reason: unknown): ExecutionSlotClaimRecord;
  /** 把到期的 held 槽位转 quarantined（只隔离，不删除、不重新分配）；返回条数。 */
  expireInTransaction(): number;
}

function context(operation: string, id?: string): ValidationContext {
  return { operation: `${OPERATION}.${operation}`, entity: { type: 'execution_slot_claim' as StorageEntityType, id } };
}

function fail(
  operation: string,
  kind: 'conflict' | 'ownership' | 'not_found' | 'validation',
  reason: ExecutionSlotRejectionReason,
  message: string,
  entity: { projectId?: string; id?: string } = {},
): never {
  throw new StorageError(kind, `${OPERATION}.${operation}`, message, {
    entity: { type: 'execution_slot_claim', ...entity },
    details: { reason },
  });
}

/** 校验 Run 定位输入（项目 + Run）。 */
export function validateExecutionSlotRunRef(value: unknown): ExecutionSlotRunRef {
  const ctx = context('readActive');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'runId'], ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
  };
}

/** 校验精确槽位读取输入（项目 + 槽位 id）。 */
export function validateExecutionSlotRef(value: unknown): ExecutionSlotRef {
  const ctx = context('read');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ['projectId', 'slotId'], ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    slotId: validateStableId(raw.slotId, ctx, 'slotId'),
  };
}

const IDENTITY_KEYS = [
  'projectId',
  'slotId',
  'claimId',
  'claimVersion',
  'ownerId',
  'hostInstanceId',
] as const;

/** 校验槽位精确身份（续租/释放/隔离都必须提供完整身份）。 */
export function validateExecutionSlotIdentity(value: unknown): ExecutionSlotIdentity {
  const ctx = context('identity');
  const raw = requirePlainObject(value, ctx, 'identity');
  rejectUnknownKeys(raw, IDENTITY_KEYS, ctx, 'identity');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    slotId: validateStableId(raw.slotId, ctx, 'slotId'),
    claimId: validateStableId(raw.claimId, ctx, 'claimId'),
    claimVersion: validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
  };
}

const ACQUIRE_KEYS = [
  'projectId',
  'featureId',
  'runId',
  'claimId',
  'claimVersion',
  'ownerId',
  'hostInstanceId',
  'leaseUntilUtcMs',
] as const;

/**
 * 校验获取输入。显式拒绝 `slotIndex`/`state`/`executionVersion` 等额外字段：
 * 槽位编号由容量与活动占用派生，状态由原语维护，Attempt 版本与本契约无关。
 */
export function validateExecutionSlotAcquireInput(value: unknown): ExecutionSlotAcquireInput {
  const ctx = context('acquire');
  const raw = requirePlainObject(value, ctx, 'input');
  rejectUnknownKeys(raw, ACQUIRE_KEYS, ctx, 'input');
  return {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    claimId: validateStableId(raw.claimId, ctx, 'claimId'),
    claimVersion: validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
    leaseUntilUtcMs: validatePositiveInteger(raw.leaseUntilUtcMs, ctx, 'leaseUntilUtcMs'),
  };
}

/** 校验租约到期时刻（正整数 UTC 毫秒）。 */
export function validateExecutionSlotLeaseUntilUtcMs(value: unknown): number {
  return validatePositiveInteger(value, context('renew'), 'leaseUntilUtcMs');
}

/** 校验隔离原因：有界（1..512）、无正文/凭据。 */
export function validateExecutionSlotQuarantineReason(value: unknown): string {
  const ctx = context('quarantine');
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw validationError(ctx, 'reason', '必须是 1..512 字符的有界原因（不含正文或凭据）', value);
  }
  return value;
}

/** 校验槽位记录与认领绑定的不可变事实（旧身份不能冒充新代次）。 */
export function assertExecutionSlotBoundToClaim(
  slot: ExecutionSlotClaimRecord,
  binding: ExecutionSlotClaimBinding,
): void {
  const ctx = context('binding', slot.id);
  const raw = requirePlainObject(binding, ctx, 'binding');
  rejectUnknownKeys(raw, ['projectId', 'featureId', 'runId', 'claimId', 'claimVersion', 'ownerId', 'hostInstanceId'], ctx, 'binding');
  const expected: ExecutionSlotClaimBinding = {
    projectId: validateStableId(raw.projectId, ctx, 'projectId'),
    featureId: validateStableId(raw.featureId, ctx, 'featureId'),
    runId: validateStableId(raw.runId, ctx, 'runId'),
    claimId: validateStableId(raw.claimId, ctx, 'claimId'),
    claimVersion: validatePositiveInteger(raw.claimVersion, ctx, 'claimVersion'),
    ownerId: validateStableId(raw.ownerId, ctx, 'ownerId'),
    hostInstanceId: validateStableId(raw.hostInstanceId, ctx, 'hostInstanceId'),
  };
  if (slot.projectId !== expected.projectId) {
    fail('binding', 'ownership', 'slot_claim_identity_mismatch',
      '槽位不属于该项目的 Run 级认领（跨项目槽位不能复用）', { projectId: expected.projectId, id: slot.id });
  }
  if (slot.featureId !== expected.featureId || slot.runId !== expected.runId) {
    fail('binding', 'ownership', 'slot_claim_identity_mismatch',
      '槽位的 Feature/Run 与请求身份不一致（一个 Run 一个活动槽位）', { projectId: expected.projectId, id: slot.id });
  }
  if (slot.claimId !== expected.claimId || slot.claimVersion !== expected.claimVersion) {
    fail('binding', 'conflict', 'slot_identity_conflict',
      '槽位属于另一代 Run 认领（旧认领/版本不能占用或释放当前槽位）', { projectId: expected.projectId, id: slot.id });
  }
  if (slot.ownerId !== expected.ownerId || slot.hostInstanceId !== expected.hostInstanceId) {
    fail('binding', 'conflict', 'slot_identity_conflict',
      '槽位的 owner/Host 实例与请求身份不一致（迟到旧 owner 不能抢占或释放）', { projectId: expected.projectId, id: slot.id });
  }
  if (slot.leaseUntilUtcMs < slot.acquiredAtUtcMs) {
    throw validationError(ctx, 'leaseUntilUtcMs', '槽位租约不得早于获得时刻', slot.leaseUntilUtcMs);
  }
}

/** 校验续租不得缩短租约（纯检查；实际更新由存储原语 CAS 执行）。 */
export function assertExecutionSlotRenewal(
  current: ExecutionSlotClaimRecord,
  leaseUntilUtcMs: unknown,
): number {
  const ctx = context('renew', current.id);
  const next = validatePositiveInteger(leaseUntilUtcMs, ctx, 'leaseUntilUtcMs');
  if (current.state === 'released') {
    fail('renew', 'conflict', 'slot_released', '已释放槽位是终态，不能续租', { id: current.id });
  }
  if (current.state === 'quarantined') {
    fail('renew', 'conflict', 'slot_quarantined', '已隔离槽位不能续租（需受信核对，不自动回收）', { id: current.id });
  }
  if (next < current.leaseUntilUtcMs) {
    throw validationError(ctx, 'leaseUntilUtcMs', '续租不得缩短当前槽位租约', next);
  }
  return next;
}

/** 校验正常释放前置（纯检查）：已释放幂等；隔离/到期不得伪造释放。 */
export function assertExecutionSlotRelease(current: ExecutionSlotClaimRecord, nowUtcMs: unknown): void {
  const ctx = context('release', current.id);
  const now = validateNonNegativeInteger(nowUtcMs, ctx, 'nowUtcMs');
  if (current.state === 'released') return;
  if (current.state === 'quarantined') {
    fail('release', 'conflict', 'slot_quarantined',
      '已隔离槽位必须先经受信停止核对才能释放（此处不提供无证据释放）', { id: current.id });
  }
  if (current.leaseUntilUtcMs <= now) {
    fail('release', 'conflict', 'slot_lease_expired_unverified',
      '槽位租约已到期，需先核对旧执行是否停止；不得直接释放或重新分配', { id: current.id });
  }
}
