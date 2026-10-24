/**
 * P04-9 / F-006 Run 级派发归属与执行槽位的收尾/续租（adapters 层，真实 SQLite）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.3/§3.5、core-design/04 §2–§4，
 * 契约见 `ports/dispatch-settlement.ts`。本模块补齐 F-003/F-004 明确留给
 * F-006 的部分：Run 结束/暂停/取消时的释放、停止不确定时的隔离、执行期间的
 * 有围栏续租，以及「迟到结果不得释放新归属」的 CAS。
 *
 * 不变量：
 * - 只读写 `run_dispatch_claims` 与 `execution_slot_claims`；只读 `runs`、
 *   `attempts`、`task_claim_receipts`、`workspace_leases`。不改写 Run/Batch/
 *   Task/Attempt 状态、预算、证据或 Git 记录；不终止进程；
 * - 释放前必须同时满足：无活动 Attempt（preparing/executing/verifying）、
 *   该 Run 的 Attempt 上没有保留的工作区占用、Run 处于终态或已收口暂停、
 *   认领仍 held 且身份完全匹配。任一不满足则保留或隔离并给出有界原因；
 * - 释放顺序遵循 DDL 触发器：先释放槽位（且租约仍有效），再释放认领；
 *   槽位租约到期只转隔离，不伪装正常释放；
 * - 所有写操作按完整身份 + revision CAS：旧 owner/旧代次/旧 Attempt 的迟到
 *   调用得到 `stale_dispatch_identity`，不产生任何写入；
 * - 重复收尾幂等：已释放返回 replayed，已隔离返回 retained，不重复提升
 *   revision，不产生第二条完成事实。
 */
import {
  validateExecutionSlotCapacity,
  validateExecutionSlotClaimRecord,
  validateRunDispatchClaimRecord,
  type ExecutionSlotClaimRecord,
  type RunDispatchClaimRecord,
} from '../../ports/execution-dispatch.js';
import { resolveApprovedBatchConcurrency } from '../../ports/feature-dispatch.js';
import { EXECUTION_SLOT_LEASE_EXPIRED_REASON } from '../../ports/execution-slot.js';
import {
  decideDispatchSettlement,
  validateDispatchRenewalInput,
  validateDispatchSettlementInput,
  validateDispatchSettlementRef,
  type DispatchRenewalResult,
  type DispatchSettlementFacts,
  type DispatchSettlementInput,
  type DispatchSettlementResult,
  type RunDispatchSettlementAccess,
} from '../../ports/dispatch-settlement.js';
import { StorageError } from '../../ports/errors.js';
import { createSqliteExecutionSlotAccess } from './execution-slots.js';
import type { SqliteStorageSession } from './session.js';
import { transactSqliteConsistentRead } from './state-store.js';

const OPERATION = 'DispatchSettlement';
const ACTIVE_ATTEMPT_STATES = ['preparing', 'executing', 'verifying'] as const;

interface ClaimRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly feature_id: string;
  readonly run_id: string;
  readonly claim_version: number;
  readonly origin: string;
  readonly resumed_from_claim_id: string | null;
  readonly resumed_from_claim_version: number | null;
  readonly owner_id: string;
  readonly host_instance_id: string;
  readonly acquired_at: number;
  readonly lease_until: number;
  readonly state: string;
  readonly reason: string | null;
  readonly settled_at: number | null;
}

interface SlotRow {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly slot_index: number;
  readonly feature_id: string;
  readonly run_id: string;
  readonly claim_id: string;
  readonly claim_version: number;
  readonly owner_id: string;
  readonly host_instance_id: string;
  readonly acquired_at: number;
  readonly lease_until: number;
  readonly state: string;
  readonly reason: string | null;
  readonly released_at: number | null;
}

interface AttemptFenceRow {
  readonly id: string;
  readonly project_id: string;
  readonly feature_id: string;
  readonly run_id: string;
  readonly owner_id: string;
  readonly host_instance_id: string;
  readonly execution_version: number;
  readonly status: string;
}

interface ReceiptDispatchRow {
  readonly receipt: string;
}

const SELECT_CLAIM =
  'SELECT id, created_at, project_id, revision, updated_at, feature_id, run_id, claim_version, origin, ' +
  'resumed_from_claim_id, resumed_from_claim_version, owner_id, host_instance_id, acquired_at, lease_until, ' +
  'state, reason, settled_at FROM run_dispatch_claims';
const SELECT_SLOT =
  'SELECT id, created_at, project_id, revision, updated_at, slot_index, feature_id, run_id, claim_id, ' +
  'claim_version, owner_id, host_instance_id, acquired_at, lease_until, state, reason, released_at ' +
  'FROM execution_slot_claims';

function claimFromRow(row: ClaimRow): RunDispatchClaimRecord {
  return validateRunDispatchClaimRecord({
    id: row.id,
    createdAtUtcMs: row.created_at,
    projectId: row.project_id,
    revision: row.revision,
    updatedAtUtcMs: row.updated_at,
    featureId: row.feature_id,
    runId: row.run_id,
    claimVersion: row.claim_version,
    origin: row.origin,
    resumedFromClaimId: row.resumed_from_claim_id,
    resumedFromClaimVersion: row.resumed_from_claim_version,
    ownerId: row.owner_id,
    hostInstanceId: row.host_instance_id,
    acquiredAtUtcMs: row.acquired_at,
    leaseUntilUtcMs: row.lease_until,
    state: row.state,
    reason: row.reason,
    settledAtUtcMs: row.settled_at,
  });
}

function slotFromRow(row: SlotRow): ExecutionSlotClaimRecord {
  return validateExecutionSlotClaimRecord({
    id: row.id,
    createdAtUtcMs: row.created_at,
    projectId: row.project_id,
    revision: row.revision,
    updatedAtUtcMs: row.updated_at,
    slotIndex: row.slot_index,
    featureId: row.feature_id,
    runId: row.run_id,
    claimId: row.claim_id,
    claimVersion: row.claim_version,
    ownerId: row.owner_id,
    hostInstanceId: row.host_instance_id,
    acquiredAtUtcMs: row.acquired_at,
    leaseUntilUtcMs: row.lease_until,
    state: row.state,
    reason: row.reason,
    releasedAtUtcMs: row.released_at,
  });
}

/**
 * 装配收尾/续租窄端口。调用方负责迁移到 v33+ 并管理会话生命周期；
 * import 本模块无副作用。`capacity` 仅用于派生「是否还有空槽」的只读事实，
 * 实际容量校验仍由 `execution-slots` 装配期执行。
 */
export function createSqliteRunDispatchSettlement(
  session: SqliteStorageSession,
  options: { readonly nowUtcMs?: () => number; readonly capacity?: number } = {},
): RunDispatchSettlementAccess {
  const db = session.database;
  const clock = options.nowUtcMs ?? Date.now;
  const configuredCapacity = options.capacity === undefined ? undefined : validateExecutionSlotCapacity(options.capacity);
  const slots = createSqliteExecutionSlotAccess(session, { nowUtcMs: () => clock() });

  function write(operation: string): void {
    if (!session.isOpen() || !db.inTransaction) {
      throw new TypeError(`DispatchSettlement.${operation} 必须在调用方已打开的短写事务内执行`);
    }
  }

  function now(operation: string): number {
    const value = Number(clock());
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new StorageError('validation', `${OPERATION}.${operation}`, '收尾时钟必须是正整数 UTC 毫秒', {
        entity: { type: 'run_dispatch_claim' },
        details: { field: 'nowUtcMs', reason: 'invalid_clock' },
      });
    }
    return value;
  }

  function fail(operation: string, reason: string, message: string, projectId?: string, id?: string): never {
    throw new StorageError('conflict', `${OPERATION}.${operation}`, message, {
      entity: { type: 'run_dispatch_claim', ...(projectId === undefined ? {} : { projectId }), ...(id === undefined ? {} : { id }) },
      details: { reason },
    });
  }

  /** 活动认领优先；无活动时返回最近一代（可能是已释放），用于幂等重放与解释。 */
  function readClaim(projectId: string, runId: string): ClaimRow | undefined {
    const active = db.prepare<[string, string], ClaimRow>(
      `${SELECT_CLAIM} WHERE project_id = ? AND run_id = ? AND state IN ('held', 'quarantined') ` +
      'ORDER BY claim_version DESC LIMIT 1',
    ).get(projectId, runId) as ClaimRow | undefined;
    if (active !== undefined) return active;
    return db.prepare<[string, string], ClaimRow>(
      `${SELECT_CLAIM} WHERE project_id = ? AND run_id = ? ORDER BY claim_version DESC LIMIT 1`,
    ).get(projectId, runId) as ClaimRow | undefined;
  }

  function readSlot(projectId: string, runId: string, claimId: string): SlotRow | undefined {
    const active = db.prepare<[string, string, string], SlotRow>(
      `${SELECT_SLOT} WHERE project_id = ? AND run_id = ? AND claim_id = ? AND state IN ('held', 'quarantined') ` +
      'ORDER BY acquired_at DESC, rowid DESC LIMIT 1',
    ).get(projectId, runId, claimId) as SlotRow | undefined;
    if (active !== undefined) return active;
    return db.prepare<[string, string, string], SlotRow>(
      `${SELECT_SLOT} WHERE project_id = ? AND run_id = ? AND claim_id = ? ORDER BY acquired_at DESC, rowid DESC LIMIT 1`,
    ).get(projectId, runId, claimId) as SlotRow | undefined;
  }

  function readFacts(projectId: string, runId: string): {
    readonly runStatus: string;
    readonly pauseRequested: boolean;
    readonly claim: RunDispatchClaimRecord | null;
    readonly slot: ExecutionSlotClaimRecord | null;
    readonly activeAttempt: DispatchSettlementFacts['activeAttempt'];
    readonly activeAttemptCount: number;
    readonly retainedLeaseCount: number;
    readonly stopUncertain: boolean;
    readonly slotCapacityAvailable: boolean;
  } {
    const run = db.prepare<[string, string], { status: string; pause_requested_at: number | null; batch_id: string }>(
      'SELECT status, pause_requested_at, batch_id FROM runs WHERE project_id = ? AND id = ?',
    ).get(projectId, runId);
    if (run === undefined) {
      throw new StorageError('not_found', `${OPERATION}.read`, 'Run 不存在', {
        entity: { type: 'run', projectId, id: runId },
        details: { reason: 'run_not_found' },
      });
    }
    const batch = db.prepare<[string, string], { config_snapshot: string }>(
      'SELECT config_snapshot FROM execution_batches WHERE project_id = ? AND id = ?',
    ).get(projectId, run.batch_id);
    if (batch === undefined) {
      throw new StorageError('corrupt', `${OPERATION}.read`, 'Run 的 Batch 不存在', {
        entity: { type: 'run', projectId, id: runId }, details: { reason: 'batch_not_found' },
      });
    }
    let batchSnapshot: unknown;
    try {
      batchSnapshot = JSON.parse(batch.config_snapshot);
    } catch (cause) {
      throw new StorageError('corrupt', `${OPERATION}.read`, 'Batch config snapshot JSON 损坏', {
        entity: { type: 'run', projectId, id: runId }, details: { reason: 'invalid_config_snapshot_json' }, cause,
      });
    }
    const capacity = configuredCapacity ?? resolveApprovedBatchConcurrency(batchSnapshot);
    const slots = createSqliteExecutionSlotAccess(session, { capacity, nowUtcMs: () => clock() });
    const claimRow = readClaim(projectId, runId);
    const claim = claimRow === undefined ? null : claimFromRow(claimRow);
    const slotRow = claim === null ? undefined : readSlot(projectId, runId, claim.id);
    const slot = slotRow === undefined ? null : slotFromRow(slotRow);
    const activeRows = db.prepare<[string, string], AttemptFenceRow>(
      `SELECT id, project_id, feature_id, run_id, owner_id, host_instance_id, execution_version, status FROM attempts
        WHERE project_id = ? AND run_id = ? AND status IN ('preparing', 'executing', 'verifying')
        ORDER BY number`,
    ).all(projectId, runId) as AttemptFenceRow[];
    const first = activeRows[0];
    const leases = db.prepare<[string, string], { state: string; count: number }>(
      `SELECT l.state AS state, COUNT(*) AS count FROM workspace_leases l
        JOIN attempts a ON a.id = l.owner_id
        WHERE a.project_id = ? AND a.run_id = ? AND l.state IN ('held', 'quarantined')
        GROUP BY l.state`,
    ).all(projectId, runId) as { state: string; count: number }[];
    const retained = leases.reduce((total, row) => total + row.count, 0);
    const interrupted = db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM attempts WHERE project_id = ? AND run_id = ? AND status = 'interrupted'",
    ).get(projectId, runId)!.count;
    const occupied = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM execution_slot_claims WHERE state IN ('held', 'quarantined')",
    ).get()!.count;
    return {
      runStatus: run.status,
      pauseRequested: run.pause_requested_at !== null,
      claim,
      slot,
      activeAttempt: first === undefined ? null : {
        attemptId: first.id,
        executionVersion: first.execution_version,
        ownerId: first.owner_id,
        hostInstanceId: first.host_instance_id,
      },
      activeAttemptCount: activeRows.length,
      retainedLeaseCount: retained,
      stopUncertain: interrupted > 0 || leases.some((row) => row.state === 'quarantined'),
      slotCapacityAvailable: occupied < capacity,
    };
  }

  function factsWith(input: { readonly projectId: string; readonly runId: string }): DispatchSettlementFacts {
    return { projectId: input.projectId, runId: input.runId, ...readFacts(input.projectId, input.runId) };
  }

  /** 认领身份 + 关联 Attempt 围栏（Attempt 行与已提交回执的 dispatch 关联）。 */
  function assertFence(claim: RunDispatchClaimRecord, input: DispatchSettlementInput, slot: ExecutionSlotClaimRecord | null): void {
    if (claim.projectId !== input.projectId || claim.runId !== input.runId
      || claim.id !== input.expected.claimId || claim.claimVersion !== input.expected.claimVersion
      || claim.ownerId !== input.expected.ownerId || claim.hostInstanceId !== input.expected.hostInstanceId) {
      fail('settleInTransaction', 'stale_dispatch_identity',
        '认领身份与请求不一致（旧 owner/旧代次不能结算当前归属）', input.projectId, input.expected.claimId);
    }
    const fence = input.attempt;
    if (fence === undefined) return;
    const attempt = db.prepare<[string], AttemptFenceRow>(
      `SELECT id, project_id, feature_id, run_id, owner_id, host_instance_id, execution_version, status
        FROM attempts WHERE id = ?`,
    ).get(fence.attemptId) as AttemptFenceRow | undefined;
    if (attempt === undefined || attempt.project_id !== claim.projectId || attempt.run_id !== claim.runId
      || attempt.feature_id !== claim.featureId
      || attempt.owner_id !== fence.ownerId || attempt.host_instance_id !== fence.hostInstanceId
      || attempt.execution_version !== fence.executionVersion) {
      fail('settleInTransaction', 'stale_dispatch_identity',
        '关联 Attempt 围栏与认领不一致（旧 Attempt 不能结算当前归属）', input.projectId, claim.id);
    }
    const receipt = db.prepare<[string, string], ReceiptDispatchRow>(
      'SELECT receipt FROM task_claim_receipts WHERE project_id = ? AND attempt_id = ?',
    ).get(claim.projectId, fence.attemptId);
    if (receipt === undefined) {
      fail('settleInTransaction', 'stale_dispatch_identity',
        '关联 Attempt 缺失已提交认领回执（不能凭内存结果结算）', input.projectId, claim.id);
    }
    let dispatch: { claimId?: unknown; claimVersion?: unknown; slotId?: unknown };
    try {
      dispatch = (JSON.parse(receipt!.receipt) as { dispatch?: typeof dispatch }).dispatch ?? {};
    } catch {
      fail('settleInTransaction', 'stale_dispatch_identity', '认领回执不可解析，拒绝结算', input.projectId, claim.id);
    }
    if (dispatch.claimId !== claim.id || dispatch.claimVersion !== claim.claimVersion
      || (slot !== null && dispatch.slotId !== slot.id)) {
      fail('settleInTransaction', 'stale_dispatch_identity',
        '回执中的派发身份与当前认领/槽位不一致（迟到结果不能释放新归属）', input.projectId, claim.id);
    }
  }

  function releaseClaim(row: ClaimRow, timestamp: number): boolean {
    const changed = db.prepare(
      "UPDATE run_dispatch_claims SET state = 'released', settled_at = ?, reason = NULL, " +
      'revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND state = \'held\' AND revision = ?',
    ).run(timestamp, timestamp, row.project_id, row.id, row.revision);
    return changed.changes === 1;
  }

  function quarantineClaim(row: ClaimRow, reason: string, timestamp: number): boolean {
    const changed = db.prepare(
      "UPDATE run_dispatch_claims SET state = 'quarantined', settled_at = ?, reason = ?, " +
      'revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND state = \'held\' AND revision = ?',
    ).run(timestamp, reason, timestamp, row.project_id, row.id, row.revision);
    return changed.changes === 1;
  }

  return {
    read(input) {
      const ref = validateDispatchSettlementRef(input);
      if (!session.isOpen()) {
        throw new StorageError('corrupt', `${OPERATION}.read`, 'SQLite 存储会话已关闭', {
          entity: { type: 'run_dispatch_claim', projectId: ref.projectId },
        });
      }
      return db.inTransaction
        ? factsWith(ref)
        : transactSqliteConsistentRead(session, `${OPERATION}.read`, () => factsWith(ref));
    },

    settleInTransaction(rawInput) {
      write('settleInTransaction');
      const input = validateDispatchSettlementInput(rawInput);
      const timestamp = now('settleInTransaction');
      const claimRow = readClaim(input.projectId, input.runId);
      if (claimRow === undefined) {
        return { ...factsWith(input), decision: 'absent', reason: null, changed: false };
      }
      const claim = claimFromRow(claimRow);
      const slotRow = readSlot(input.projectId, input.runId, claim.id);
      const slot = slotRow === undefined ? null : slotFromRow(slotRow);
      assertFence(claim, input, slot);
      const facts = factsWith(input);
      if (claim.state === 'released') {
        // 幂等重放：已释放是终态，不重复提升 revision，也不复活。
        return { ...facts, decision: 'replayed', reason: 'claim_released', changed: false };
      }
      const decision = decideDispatchSettlement({
        runStatus: facts.runStatus,
        pauseRequested: facts.pauseRequested,
        claimState: claim.state,
        slotState: slot === null ? null : slot.state,
        slotLeaseExpired: slot !== null && slot.leaseUntilUtcMs <= timestamp,
        activeAttemptCount: facts.activeAttemptCount,
        retainedLeaseCount: facts.retainedLeaseCount,
        stopUncertain: facts.stopUncertain,
      });
      if (decision.decision === 'retained') {
        return { ...facts, decision: 'retained', reason: decision.reason, changed: false };
      }
      if (decision.decision === 'quarantined') {
        if (slotRow !== undefined && slotRow.state === 'held') {
          slots.quarantineInTransaction({
            projectId: slotRow.project_id, slotId: slotRow.id, claimId: slotRow.claim_id,
            claimVersion: slotRow.claim_version, ownerId: slotRow.owner_id, hostInstanceId: slotRow.host_instance_id,
          }, decision.reason);
        }
        const changed = quarantineClaim(claimRow, decision.reason, timestamp);
        return { ...factsWith(input), decision: 'quarantined', reason: decision.reason, changed };
      }
      // released：先释放槽位（触发器要求），到期则改判隔离。
      if (slotRow !== undefined && slotRow.state === 'held') {
        try {
          slots.releaseInTransaction({
            projectId: slotRow.project_id, slotId: slotRow.id, claimId: slotRow.claim_id,
            claimVersion: slotRow.claim_version, ownerId: slotRow.owner_id, hostInstanceId: slotRow.host_instance_id,
          });
        } catch (error) {
          if (!(error instanceof StorageError)) throw error;
          const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'slot_release_failed';
          if (reason !== EXECUTION_SLOT_LEASE_EXPIRED_REASON && reason !== 'slot_lease_expired_unverified'
            && reason !== 'slot_identity_mismatch' && reason !== 'slot_quarantined') throw error;
          // 槽位已到期/漂移：不伪装正常释放，隔离认领并保留占槽。
          const quarantineReason = reason === EXECUTION_SLOT_LEASE_EXPIRED_REASON || reason === 'slot_lease_expired_unverified'
            ? 'slot_lease_expired_unverified' : 'slot_identity_mismatch';
          const changed = quarantineClaim(claimRow, quarantineReason, timestamp);
          return {
            ...factsWith(input),
            decision: 'quarantined',
            reason: quarantineReason as DispatchSettlementResult['reason'],
            changed,
          };
        }
      }
      const changed = releaseClaim(claimRow, timestamp);
      if (!changed) {
        // 并发修改：宁可保留，不覆盖当前行。
        fail('settleInTransaction', 'settlement_conflict',
          '认领 CAS 失败（并发修改或状态变化），保留当前归属', input.projectId, claim.id);
      }
      return { ...factsWith(input), decision: 'released', reason: decision.reason, changed: true };
    },

    renewInTransaction(rawInput): DispatchRenewalResult {
      write('renewInTransaction');
      const input = validateDispatchRenewalInput(rawInput);
      const timestamp = now('renewInTransaction');
      if (input.leaseUntilUtcMs <= timestamp) {
        throw new StorageError('validation', `${OPERATION}.renewInTransaction`, '续租到期时刻必须晚于当前时刻', {
          entity: { type: 'run_dispatch_claim', projectId: input.projectId, id: input.expected.claimId },
          details: { field: 'leaseUntilUtcMs', reason: 'expired_new_lease' },
        });
      }
      const claimRow = readClaim(input.projectId, input.runId);
      if (claimRow === undefined || claimRow.state !== 'held') {
        fail('renewInTransaction', 'claim_not_held', '当前没有 held 的 Run 级认领，拒绝续租', input.projectId);
      }
      const claim = claimFromRow(claimRow);
      const slotRow = readSlot(input.projectId, input.runId, claim.id);
      const slot = slotRow === undefined ? null : slotFromRow(slotRow);
      assertFence(claim, input, slot);
      const facts = factsWith(input);
      if (slot === null) {
        fail('renewInTransaction', 'slot_not_found', 'Run 认领缺少对应槽位，拒绝续租', input.projectId, claim.id);
      }
      if (slot.state === 'quarantined') {
        quarantineClaim(claimRow, 'slot_quarantined', timestamp);
        return { ...factsWith(input), decision: 'quarantined', reason: 'slot_quarantined' };
      }
      if (claim.leaseUntilUtcMs <= timestamp) {
        // 认领已到期：不延长，隔离后交受信核对。
        quarantineClaim(claimRow, 'slot_lease_expired_unverified', timestamp);
        return { ...factsWith(input), decision: 'quarantined', reason: 'slot_lease_expired_unverified' };
      }
      if (input.leaseUntilUtcMs <= claim.leaseUntilUtcMs) {
        return { ...facts, decision: 'unchanged', reason: null };
      }
      const changed = db.prepare(
        "UPDATE run_dispatch_claims SET lease_until = ?, revision = revision + 1, updated_at = ? " +
          "WHERE project_id = ? AND id = ? AND state = 'held' AND revision = ? AND lease_until = ?",
      ).run(input.leaseUntilUtcMs, timestamp, claim.projectId, claim.id, claim.revision, claim.leaseUntilUtcMs);
      if (changed.changes !== 1) {
        fail('renewInTransaction', 'settlement_conflict',
          '认领续租 CAS 失败（并发修改），拒绝覆盖当前行', input.projectId, claim.id);
      }
      const renewedSlot = slots.renewInTransaction({
        projectId: slot.projectId, slotId: slot.id, claimId: slot.claimId,
        claimVersion: slot.claimVersion, ownerId: slot.ownerId, hostInstanceId: slot.hostInstanceId,
      }, input.leaseUntilUtcMs);
      if (renewedSlot.state !== 'held') {
        // 槽位在续租时到期：连同认领一起隔离（用续租后的最新 revision）。
        const current = db.prepare<[string, string], ClaimRow>(
          `${SELECT_CLAIM} WHERE project_id = ? AND id = ?`,
        ).get(input.projectId, claim.id) as ClaimRow | undefined;
        if (current !== undefined) quarantineClaim(current, 'slot_lease_expired_unverified', timestamp);
        return { ...factsWith(input), decision: 'quarantined', reason: 'slot_lease_expired_unverified' };
      }
      return { ...factsWith(input), decision: 'renewed', reason: null };
    },
  };
}
