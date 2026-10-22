/**
 * P04-9 / F-001 Run 级持久派发与单执行槽位契约（纯 ports 契约，无 I/O）。
 *
 * 覆盖验收点：派发身份固定为「同项目、同 Feature 的 Run」（workKey 不是唯一键）、
 * 受控认领代次与恢复关联、Run 级 owner/host/version 与 Task/Attempt
 * executionVersion 的区分与关联、展示状态从 Run/认领/占用派生，以及槽位容量 1
 * 的 fail-closed 校验。
 */
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_SLOT_CAPACITY_DEFAULT,
  assertDispatchClaimOwnsAttempt,
  assertRunDispatchClaimAllowed,
  assertRunDispatchClaimTransition,
  assertRunDispatchResumeLink,
  deriveDispatchWorkIdentity,
  deriveRunDispatchDisplay,
  validateExecutionSlotCapacity,
  validateExecutionSlotClaimRecord,
  validateRunDispatchClaimRecord,
} from '../../../packages/core/src/ports/execution-dispatch.ts';
import type {
  ExecutionSlotClaimRecord,
  RunDispatchClaimRecord,
} from '../../../packages/core/src/ports/execution-dispatch.ts';

const NOW = 1_900_000_200_000;

function claim(overrides: Record<string, unknown> = {}): RunDispatchClaimRecord {
  return validateRunDispatchClaimRecord({
    id: 'claim-1',
    createdAtUtcMs: NOW,
    projectId: 'proj-1',
    revision: 1,
    updatedAtUtcMs: NOW,
    featureId: 'feature-1',
    runId: 'run-1',
    claimVersion: 1,
    origin: 'dispatch',
    resumedFromClaimId: null,
    resumedFromClaimVersion: null,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    acquiredAtUtcMs: NOW,
    leaseUntilUtcMs: NOW + 60_000,
    state: 'held',
    reason: null,
    settledAtUtcMs: null,
    ...overrides,
  });
}

function releasedClaim(): RunDispatchClaimRecord {
  return claim({ state: 'released', settledAtUtcMs: NOW + 1_000 });
}

function resumeClaim(overrides: Record<string, unknown> = {}): RunDispatchClaimRecord {
  return claim({
    id: 'claim-2',
    revision: 1,
    claimVersion: 2,
    origin: 'resume',
    resumedFromClaimId: 'claim-1',
    resumedFromClaimVersion: 1,
    acquiredAtUtcMs: NOW + 2_000,
    leaseUntilUtcMs: NOW + 62_000,
    ...overrides,
  });
}

function slot(overrides: Record<string, unknown> = {}): ExecutionSlotClaimRecord {
  return validateExecutionSlotClaimRecord({
    id: 'slot-1',
    createdAtUtcMs: NOW,
    projectId: 'proj-1',
    revision: 1,
    updatedAtUtcMs: NOW,
    slotIndex: 0,
    featureId: 'feature-1',
    runId: 'run-1',
    claimId: 'claim-1',
    claimVersion: 1,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    acquiredAtUtcMs: NOW,
    leaseUntilUtcMs: NOW + 60_000,
    state: 'held',
    reason: null,
    releasedAtUtcMs: null,
    ...overrides,
  });
}

describe('P04-9 F-001 dispatch identity', () => {
  it('[case:dispatch-identity-is-run] 派发身份是同项目/Feature 的 Run，workKey 不是队列唯一键', () => {
    const first = deriveDispatchWorkIdentity({ projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1' });
    expect(first).toEqual({ projectId: 'proj-1', featureId: 'feature-1', runId: 'run-1' });
    // 重复入队：同一 Run 稳定返回同一工作身份（不含时间/随机量）。
    expect(deriveDispatchWorkIdentity({ ...first })).toEqual(first);
    // 显式重试的新 Run 有独立派发身份，即使共享同一 workKey。
    const retry = deriveDispatchWorkIdentity({ ...first, runId: 'run-2' });
    expect(retry.runId).not.toBe(first.runId);
    // workKey 不属于身份，也不允许被当作唯一键塞入。
    expect(() => deriveDispatchWorkIdentity({ ...first, workKey: 'shared-logical-work' })).toThrow(
      /未知字段 workKey/,
    );
    expect(() => deriveDispatchWorkIdentity({ projectId: 'proj-1', featureId: 'feature-1' })).toThrow(
      /runId/,
    );
  });

  it('[case:claim-generation-and-lineage] 首代恒为 dispatch/v1，resume 只追加 version+1 且引用已释放的上一代', () => {
    expect(claim().origin).toBe('dispatch');
    expect(claim().claimVersion).toBe(1);
    // 首代不能是 v2 / resume 形状。
    expect(() => claim({ claimVersion: 2 })).toThrow(/dispatch\/v1/);
    expect(() => claim({ origin: 'resume', resumedFromClaimId: 'claim-0', resumedFromClaimVersion: 0 })).toThrow();
    expect(() => claim({ resumedFromClaimId: 'claim-0' })).toThrow(/dispatch\/v1/);
    // resume 必须指向 version-1 的上一代认领。
    expect(resumeClaim().claimVersion).toBe(2);
    expect(() => resumeClaim({ resumedFromClaimVersion: 2 })).toThrow(/version-1/);
    expect(() => resumeClaim({ resumedFromClaimId: null, resumedFromClaimVersion: null })).toThrow(/version-1/);
    // 只有核对停止并释放的上一代才能生成下一代；终态 Run 不允许再认领。
    expect(() =>
      assertRunDispatchResumeLink({ previousClaim: releasedClaim(), nextClaim: resumeClaim() }),
    ).not.toThrow();
    expect(() =>
      assertRunDispatchResumeLink({ previousClaim: claim(), nextClaim: resumeClaim() }),
    ).toThrow(/未核对停止并释放/);
    expect(() =>
      assertRunDispatchResumeLink({
        previousClaim: releasedClaim(),
        nextClaim: resumeClaim({ runId: 'run-2' }),
      }),
    ).toThrow(/同一项目\/Feature\/Run/);
    for (const status of ['queued', 'running', 'paused', 'interrupted'] as const) {
      expect(() => assertRunDispatchClaimAllowed(status)).not.toThrow();
    }
    for (const status of ['pausing', 'cancelling', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(() => assertRunDispatchClaimAllowed(status)).toThrow(/不允许产生新的 Run 级认领/);
    }
  });
});

describe('P04-9 F-001 claim transitions and fencing', () => {
  it('[case:claim-transition-fencing] 身份列不可变、revision 严格递增，旧 owner/version 不能释放当前认领', () => {
    const held = claim();
    const renewed = claim({ revision: 2, updatedAtUtcMs: NOW + 10, leaseUntilUtcMs: NOW + 120_000 });
    expect(() => assertRunDispatchClaimTransition(held, renewed)).not.toThrow();
    expect(() =>
      assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW + 10, state: 'released', settledAtUtcMs: NOW + 10 })),
    ).not.toThrow();
    expect(() =>
      assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW + 10, state: 'quarantined', settledAtUtcMs: NOW + 10, reason: 'lease_expired_unverified' })),
    ).not.toThrow();
    // 非法状态转换：已释放终态不复活；隔离不自动回收为 held。
    const released = releasedClaim();
    expect(() => assertRunDispatchClaimTransition(released, claim({ id: 'claim-1', revision: 2, updatedAtUtcMs: NOW + 5 }))).toThrow(/illegal|非法认领转换/);
    const quarantined = claim({ state: 'quarantined', settledAtUtcMs: NOW + 1_000, reason: 'lease_expired_unverified' });
    expect(() => assertRunDispatchClaimTransition(quarantined, claim({ revision: 2, updatedAtUtcMs: NOW + 2_000 }))).toThrow(/非法认领转换/);
    expect(() =>
      assertRunDispatchClaimTransition(quarantined, claim({ revision: 2, updatedAtUtcMs: NOW + 2_000, state: 'released', settledAtUtcMs: NOW + 2_000 })),
    ).not.toThrow();
    // CAS 跳号、身份改写、owner 变更、缩短租约、时间回退全部拒绝。
    expect(() => assertRunDispatchClaimTransition(held, claim({ revision: 3, updatedAtUtcMs: NOW + 10 }))).toThrow(/revision\+1/);
    expect(() => assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW + 10, claimVersion: 2, origin: 'resume', resumedFromClaimId: 'claim-0', resumedFromClaimVersion: 1 }))).toThrow(/不可变/);
    expect(() => assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW + 10, ownerId: 'owner-2' }))).toThrow(/不可变/);
    expect(() => assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW + 10, leaseUntilUtcMs: NOW + 30_000 }))).toThrow(/续租不得缩短/);
    expect(() => assertRunDispatchClaimTransition(held, claim({ revision: 2, updatedAtUtcMs: NOW - 1 }))).toThrow(/更新时间不得回退/);
  });

  it('[case:claim-attempt-fencing] Run 级认领与 Attempt executionVersion 关联但不相等', () => {
    const base = {
      projectId: 'proj-1',
      featureId: 'feature-1',
      runId: 'run-1',
      ownerId: 'owner-1',
      hostInstanceId: 'host-1',
      executionVersion: 7,
      createdAtUtcMs: NOW + 500,
    };
    // claimVersion=1 与 executionVersion=7 独立成立（版本计数器不可等同）。
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: base })).not.toThrow();
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, executionVersion: 1 } })).not.toThrow();
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, executionVersion: 0 } })).toThrow(/executionVersion/);
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, ownerId: 'owner-2' } })).toThrow(/owner\/host/);
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, hostInstanceId: 'host-2' } })).toThrow(/owner\/host/);
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, runId: 'run-2' } })).toThrow(/同项目\/Feature\/Run/);
    expect(() => assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, featureId: 'feature-2' } })).toThrow(/同项目\/Feature\/Run/);
    expect(() =>
      assertDispatchClaimOwnsAttempt({ claim: claim(), attempt: { ...base, createdAtUtcMs: NOW - 1 } }),
    ).toThrow(/早于该认领代次/);
    expect(() => assertDispatchClaimOwnsAttempt({ claim: releasedClaim(), attempt: base })).toThrow(/非 held 认领/);
  });
});

describe('P04-9 F-001 derived display state', () => {
  const baseFacts = {
    runStatus: 'running' as const,
    claim: claim(),
    slot: slot(),
    activeAttempt: { executionVersion: 3, ownerId: 'owner-1', hostInstanceId: 'host-1' },
    slotCapacityAvailable: true,
    nowUtcMs: NOW + 1_000,
  };

  it('[case:display-derived] 展示状态从 Run、认领与占用派生，不成为第二套业务状态', () => {
    expect(deriveRunDispatchDisplay(baseFacts)).toEqual({ state: 'running', blockingReason: null });
    expect(deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'queued' })).toEqual({ state: 'claimed', blockingReason: null });
    expect(deriveRunDispatchDisplay({ ...baseFacts, activeAttempt: null })).toEqual({ state: 'claimed', blockingReason: null });
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'queued', claim: null, slot: null }),
    ).toEqual({ state: 'queued', blockingReason: null });
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'queued', claim: null, slot: null, slotCapacityAvailable: false }),
    ).toEqual({ state: 'waiting_slot', blockingReason: 'execution_slot_unavailable' });
    // 已释放的认领回落到排队事实，不复活旧执行。
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'queued', claim: releasedClaim(), slot: null, slotCapacityAvailable: false }),
    ).toEqual({ state: 'waiting_slot', blockingReason: 'execution_slot_unavailable' });
    expect(deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'paused' })).toEqual({ state: 'paused', blockingReason: 'run_paused' });
    expect(deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'cancelling' })).toEqual({ state: 'cancelling', blockingReason: 'run_cancelling' });
    expect(deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'cancelled' })).toEqual({ state: 'cancelled', blockingReason: null });
    expect(deriveRunDispatchDisplay({ ...baseFacts, runStatus: 'interrupted' })).toEqual({ state: 'interrupted', blockingReason: 'run_interrupted' });
    // 需要核对的阻塞原因，绝不自动转成已停止或再次运行。
    expect(
      deriveRunDispatchDisplay({
        ...baseFacts,
        claim: claim({ state: 'quarantined', settledAtUtcMs: NOW + 10, reason: 'lease_expired_unverified' }),
      }),
    ).toEqual({ state: 'blocked', blockingReason: 'claim_quarantined' });
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, nowUtcMs: NOW + 60_001 }),
    ).toEqual({ state: 'blocked', blockingReason: 'claim_lease_expired_unverified' });
    expect(deriveRunDispatchDisplay({ ...baseFacts, slot: null })).toEqual({ state: 'blocked', blockingReason: 'slot_ownership_missing' });
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, slot: slot({ claimId: 'claim-9' }) }),
    ).toEqual({ state: 'blocked', blockingReason: 'slot_identity_mismatch' });
    expect(
      deriveRunDispatchDisplay({
        ...baseFacts,
        slot: slot({ state: 'quarantined', reason: 'lease_expired_unverified' }),
      }),
    ).toEqual({ state: 'blocked', blockingReason: 'slot_quarantined' });
    expect(
      deriveRunDispatchDisplay({ ...baseFacts, activeAttempt: { ...baseFacts.activeAttempt, ownerId: 'owner-2' } }),
    ).toEqual({ state: 'blocked', blockingReason: 'claim_attempt_identity_mismatch' });
    expect(() => deriveRunDispatchDisplay({ ...baseFacts, nowUtcMs: -1 })).toThrow(/nowUtcMs/);
  });
});

describe('P04-9 F-001 slot capacity and record validation', () => {
  it('[case:slot-capacity-single] 容量缺省 1，大于 1 明确拒绝而不是暗中串行', () => {
    expect(EXECUTION_SLOT_CAPACITY_DEFAULT).toBe(1);
    expect(validateExecutionSlotCapacity()).toBe(1);
    expect(validateExecutionSlotCapacity(1)).toBe(1);
    expect(() => validateExecutionSlotCapacity(2)).toThrow(/大于 1 尚未支持/);
    try {
      validateExecutionSlotCapacity(2);
    } catch (error) {
      expect(error).toMatchObject({ kind: 'validation', details: { reason: 'capacity_unsupported' } });
    }
    for (const bad of [0, -1, 1.5, Number.NaN, '1', null]) {
      expect(() => validateExecutionSlotCapacity(bad)).toThrow();
    }
  });

  it('[case:slot-record-shape] 槽位记录拒绝错误版本、状态形状与未知字段', () => {
    expect(slot().state).toBe('held');
    expect(() => slot({ claimVersion: 0 })).toThrow(/claimVersion/);
    expect(() => slot({ slotIndex: -1 })).toThrow(/slotIndex/);
    expect(() => slot({ state: 'unknown' })).toThrow(/held\|quarantined\|released/);
    expect(() => slot({ releasedAtUtcMs: NOW })).toThrow(/不得携带释放时间/);
    expect(() => slot({ state: 'released' })).toThrow(/释放时间/);
    expect(() => slot({ state: 'quarantined' })).toThrow(/原因必填/);
    expect(() =>
      slot({ state: 'released', releasedAtUtcMs: NOW + 1, reason: 'x'.repeat(513) }),
    ).toThrow(/512/);
    expect(() => slot({ workKey: 'logical' })).toThrow(/未知字段/);
    expect(() => slot({ leaseUntilUtcMs: NOW - 1 })).toThrow(/租约到期/);
  });

  it('[case:claim-record-shape] 认领记录拒绝非法结算/来源/未知字段', () => {
    expect(() => claim({ state: 'held', settledAtUtcMs: NOW + 1 })).toThrow(/held 认领不得携带/);
    expect(() => claim({ state: 'released' })).toThrow(/结束时间/);
    expect(() => claim({ state: 'quarantined', settledAtUtcMs: NOW + 1 })).toThrow(/原因必填/);
    expect(() => claim({ settledAtUtcMs: NOW + 1 })).toThrow(/held 认领不得携带/);
    expect(() => claim({ origin: 'manual' })).toThrow(/dispatch\|resume/);
    expect(() => claim({ state: 'passed' })).toThrow(/held\|quarantined\|released/);
    expect(() => claim({ leaseUntilUtcMs: NOW - 1 })).toThrow(/租约到期/);
    expect(() => claim({ executionVersion: 3 })).toThrow(/未知字段/);
    expect(() => validateRunDispatchClaimRecord({})).toThrow();
    expect(() => validateExecutionSlotClaimRecord({})).toThrow();
  });
});
