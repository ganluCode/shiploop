/**
 * P04-9 / F-003 单执行槽位 SQLite 事务原语（adapters 层）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.2、core-design/15 §3、
 * docs/p04-9-f001-dispatch-slot-contract.md 与 F-003 契约
 * `ports/execution-slot.ts`。
 *
 * 不变量：
 * - 只读写 `execution_slot_claims` 与只读 `run_dispatch_claims`；不改写
 *   `workspace_leases`、`baseline_occupancy`、`git_operations`、`attempts`、
 *   `runs`、预算表，也不启动进程/网络/文件准备。槽位不是 Attempt 工作区租约；
 * - 容量在装配时用 `validateExecutionSlotCapacity` 固定（缺省 1；必须是受支持的正整数，
 *   非法值直接拒绝）；派发调用方从批准 Batch 快照传入冻结容量；
 * - 获取在同一个短写事务内重核认领行身份（项目/Feature/Run/代次/owner/Host）、
 *   认领状态与租约，再按最小空闲槽号插入；`(slot_index)` 与 `(project, run)`
 *   的活动唯一索引兜底并发竞争，失败方得到结构化阻塞原因，整组回滚；
 * - 续租/释放/隔离都按完整身份 CAS（id + 项目 + 认领 + 代次 + owner + Host），
 *   迟到旧 owner 不能修改当前行；租约到期只转 `quarantined`，从不删除或自动
 *   重新分配，隔离行继续占用量额；
 * - 调用方负责事务边界：写原语要求已打开写事务，不做长检查、不等待外部事件。
 */
import { randomUUID } from 'node:crypto';
import {
  validateExecutionSlotCapacity,
  validateExecutionSlotClaimRecord,
  type ExecutionSlotClaimRecord,
} from '../../ports/execution-dispatch.js';
import {
  ACTIVE_EXECUTION_SLOT_STATES,
  assertExecutionSlotBoundToClaim,
  assertExecutionSlotRelease,
  assertExecutionSlotRenewal,
  validateExecutionSlotAcquireInput,
  validateExecutionSlotIdentity,
  validateExecutionSlotLeaseUntilUtcMs,
  validateExecutionSlotQuarantineReason,
  validateExecutionSlotRef,
  validateExecutionSlotRunRef,
  type ExecutionSlotAccess,
  type ExecutionSlotIdentity,
  type ExecutionSlotRejectionReason,
  EXECUTION_SLOT_LEASE_EXPIRED_REASON,
} from '../../ports/execution-slot.js';
import { StorageError } from '../../ports/errors.js';
import type { StorageEntityRef } from '../../ports/errors.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'ExecutionSlot';

interface SlotSqlRow {
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

interface ClaimSqlRow {
  readonly id: string;
  readonly project_id: string;
  readonly feature_id: string;
  readonly run_id: string;
  readonly claim_version: number;
  readonly owner_id: string;
  readonly host_instance_id: string;
  readonly lease_until: number;
  readonly state: string;
}

const SELECT_SLOT =
  'SELECT id, created_at, project_id, revision, updated_at, slot_index, feature_id, run_id, claim_id, ' +
  'claim_version, owner_id, host_instance_id, acquired_at, lease_until, state, reason, released_at ' +
  'FROM execution_slot_claims';

const SELECT_CLAIM =
  'SELECT id, project_id, feature_id, run_id, claim_version, owner_id, host_instance_id, lease_until, state ' +
  'FROM run_dispatch_claims';

/** 活动槽位状态字面量（源码常量，非外部输入，可安全内联）。 */
const ACTIVE_STATES_SQL = ACTIVE_EXECUTION_SLOT_STATES.map((state) => `'${state}'`).join(', ');

function isSqliteConstraintError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as unknown as { code: string }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 装配槽位窄端口。调用方负责先迁移到 v33+ 并打开会话；import 本模块无副作用。
 *
 * `capacity` 缺省 1；显式容量必须是受支持范围内的正整数，不能用无界或漂移配置
 * 覆盖批准 Batch 快照。
 */
export function createSqliteExecutionSlotAccess(
  session: SqliteStorageSession,
  options: { readonly capacity?: unknown; readonly nowUtcMs?: () => number } = {},
): ExecutionSlotAccess {
  const capacity = validateExecutionSlotCapacity(options.capacity);
  const db = session.database;
  const clock = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', `${OPERATION}.${operation}`, 'SQLite 存储会话已关闭，拒绝继续操作', {
        entity: { type: 'execution_slot_claim' },
      });
    }
  }

  function write(operation: string): void {
    assertOpen(operation);
    if (!db.inTransaction) {
      throw new TypeError(`ExecutionSlot.${operation} 必须在调用方已打开的短写事务内执行`);
    }
  }

  function now(operation: string): number {
    const value = Number(clock());
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new StorageError('validation', `${OPERATION}.${operation}`, '槽位时钟必须是正整数 UTC 毫秒', {
        entity: { type: 'execution_slot_claim' },
        details: { field: 'nowUtcMs', reason: 'invalid_clock' },
      });
    }
    return value;
  }

  function entity(projectId?: string, id?: string): StorageEntityRef {
    return { type: 'execution_slot_claim', ...(projectId === undefined ? {} : { projectId }), ...(id === undefined ? {} : { id }) };
  }

  function fail(
    operation: string,
    kind: 'conflict' | 'ownership',
    reason: ExecutionSlotRejectionReason,
    message: string,
    projectId?: string,
    id?: string,
    details: Readonly<Record<string, unknown>> = {},
  ): never {
    throw new StorageError(kind, `${OPERATION}.${operation}`, message, {
      entity: entity(projectId, id),
      details: { reason, capacity, ...details },
    });
  }

  function slotFromRow(row: SlotSqlRow, operation: string): ExecutionSlotClaimRecord {
    try {
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
    } catch (error) {
      throw new StorageError(
        'corrupt',
        `${OPERATION}.${operation}`,
        `执行槽位行损坏（${error instanceof Error ? error.message : String(error)}）`,
        { entity: entity(row.project_id, row.id), cause: error },
      );
    }
  }

  function readRow(projectId: string, id: string, operation: string): SlotSqlRow | undefined {
    return db.prepare<[string, string], SlotSqlRow>(`${SELECT_SLOT} WHERE project_id = ? AND id = ?`)
      .get(projectId, id) as SlotSqlRow | undefined;
  }

  function readByIdentity(identity: ExecutionSlotIdentity, operation: string): ExecutionSlotClaimRecord {
    const row = readRow(identity.projectId, identity.slotId, operation);
    if (row === undefined) {
      throw new StorageError('not_found', `${OPERATION}.${operation}`, '执行槽位不存在', {
        entity: entity(identity.projectId, identity.slotId),
        details: { reason: 'slot_not_found' },
      });
    }
    const slot = slotFromRow(row, operation);
    if (
      slot.claimId !== identity.claimId ||
      slot.claimVersion !== identity.claimVersion ||
      slot.ownerId !== identity.ownerId ||
      slot.hostInstanceId !== identity.hostInstanceId
    ) {
      fail(
        operation,
        'ownership',
        'slot_identity_mismatch',
        '槽位的认领/代次/owner/Host 与请求身份不一致（旧身份不能修改当前槽位）',
        identity.projectId,
        identity.slotId,
      );
    }
    return slot;
  }

  function activeSlotRow(projectId: string, runId: string, operation: string): SlotSqlRow | undefined {
    return db
      .prepare<[string, string], SlotSqlRow>(
        `${SELECT_SLOT} WHERE project_id = ? AND run_id = ? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY acquired_at DESC, rowid DESC LIMIT 1`,
      )
      .get(projectId, runId) as SlotSqlRow | undefined;
  }

  /** 认领行重核：身份、状态与租约。缺失/漂移一律 fail-closed，不靠调用方自报。 */
  function requireHeldClaim(
    input: {
      readonly projectId: string;
      readonly featureId: string;
      readonly runId: string;
      readonly claimId: string;
      readonly claimVersion: number;
      readonly ownerId: string;
      readonly hostInstanceId: string;
      readonly leaseUntilUtcMs: number;
    },
    operation: string,
  ): ClaimSqlRow {
    const claim = db
      .prepare<[string, string], ClaimSqlRow>(`${SELECT_CLAIM} WHERE project_id = ? AND id = ?`)
      .get(input.projectId, input.claimId) as ClaimSqlRow | undefined;
    if (claim === undefined) {
      throw new StorageError('not_found', `${OPERATION}.${operation}`, 'Run 级派发认领不存在', {
        entity: entity(input.projectId, input.claimId),
        details: { reason: 'claim_not_found' },
      });
    }
    if (
      claim.feature_id !== input.featureId ||
      claim.run_id !== input.runId ||
      claim.claim_version !== input.claimVersion ||
      claim.owner_id !== input.ownerId ||
      claim.host_instance_id !== input.hostInstanceId
    ) {
      fail(
        operation,
        'ownership',
        'slot_claim_identity_mismatch',
        'Run 级派发认领的 Feature/Run/代次/owner/Host 与请求身份不一致（过期或伪造身份被拒绝）',
        input.projectId,
        input.claimId,
      );
    }
    if (claim.state !== 'held') {
      fail(
        operation,
        'conflict',
        'slot_claim_not_held',
        'Run 级派发认领已非 held（隔离/已释放），不能新占或续租槽位',
        input.projectId,
        input.claimId,
        { claimState: claim.state },
      );
    }
    if (claim.lease_until < input.leaseUntilUtcMs) {
      fail(
        operation,
        'conflict',
        'slot_lease_exceeds_claim',
        '槽位租约不得长于 Run 级认领租约（槽位不能比派发归属活得更久）',
        input.projectId,
        input.claimId,
      );
    }
    return claim;
  }

  return {
    capacity,

    readActive(input) {
      const operation = 'readActive';
      assertOpen(operation);
      const ref = validateExecutionSlotRunRef(input);
      const row = activeSlotRow(ref.projectId, ref.runId, operation);
      return row === undefined ? null : slotFromRow(row, operation);
    },

    read(input) {
      const operation = 'read';
      assertOpen(operation);
      const ref = validateExecutionSlotRef(input);
      const row = readRow(ref.projectId, ref.slotId, operation);
      return row === undefined ? null : slotFromRow(row, operation);
    },

    acquireInTransaction(input) {
      const operation = 'acquireInTransaction';
      write(operation);
      const valid = validateExecutionSlotAcquireInput(input);
      const timestamp = now(operation);
      if (valid.leaseUntilUtcMs <= timestamp) {
        throw new StorageError('validation', `${OPERATION}.${operation}`, '槽位租约必须晚于当前时刻', {
          entity: entity(valid.projectId),
          details: { field: 'leaseUntilUtcMs', reason: 'expired_new_slot_lease' },
        });
      }
      requireHeldClaim(valid, operation);
      const active = activeSlotRow(valid.projectId, valid.runId, operation);
      if (active !== undefined) {
        const slot = slotFromRow(active, operation);
        // 同身份重复获取：幂等复用，零新增/零副作用（不延长租约）。
        assertExecutionSlotBoundToClaim(slot, {
          projectId: valid.projectId,
          featureId: valid.featureId,
          runId: valid.runId,
          claimId: valid.claimId,
          claimVersion: valid.claimVersion,
          ownerId: valid.ownerId,
          hostInstanceId: valid.hostInstanceId,
        });
        if (slot.state === 'quarantined') {
          fail(operation, 'conflict', 'slot_quarantined',
            '该 Run 的槽位已隔离，需先核对旧执行；不自动回收或重复获取', valid.projectId, slot.id);
        }
        if (slot.leaseUntilUtcMs <= timestamp) {
          fail(operation, 'conflict', 'slot_lease_expired_unverified',
            '该 Run 的槽位租约已到期，需先核对旧执行是否停止；不自动续租或重分配', valid.projectId, slot.id);
        }
        return slot;
      }
      const occupied = db
        .prepare<[], { slot_index: number }>(
          `SELECT slot_index FROM execution_slot_claims WHERE state IN (${ACTIVE_STATES_SQL})`,
        )
        .all() as { slot_index: number }[];
      if (occupied.length >= capacity) {
        fail(operation, 'conflict', 'execution_slot_unavailable',
          '执行槽位已全部占用（容量已满），本次不获取槽位、不派发、不启动 Runner',
          valid.projectId, undefined, { occupied: occupied.length });
      }
      const used = new Set(occupied.map((row) => row.slot_index));
      let slotIndex = -1;
      for (let index = 0; index < capacity; index += 1) {
        if (!used.has(index)) {
          slotIndex = index;
          break;
        }
      }
      if (slotIndex < 0) {
        fail(operation, 'conflict', 'execution_slot_unavailable', '没有可用执行槽位号，本次不获取槽位');
      }
      const slotId = randomUUID();
      try {
        db.prepare(
          'INSERT INTO execution_slot_claims (id, created_at, project_id, revision, updated_at, slot_index, ' +
            'feature_id, run_id, claim_id, claim_version, owner_id, host_instance_id, acquired_at, lease_until, ' +
            "state, reason, released_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', NULL, NULL)",
        ).run(
          slotId,
          timestamp,
          valid.projectId,
          timestamp,
          slotIndex,
          valid.featureId,
          valid.runId,
          valid.claimId,
          valid.claimVersion,
          valid.ownerId,
          valid.hostInstanceId,
          timestamp,
          valid.leaseUntilUtcMs,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          // 并发竞争兜底：另一消费者已提交槽位（或身份/租约被 DDL 拒绝）。
          fail(operation, 'conflict', 'execution_slot_unavailable',
            '执行槽位被并发消费者取得（唯一索引兜底），本次整组回滚', valid.projectId);
        }
        throw error;
      }
      const inserted = readRow(valid.projectId, slotId, operation);
      if (inserted === undefined) {
        throw new StorageError('corrupt', `${OPERATION}.${operation}`, '执行槽位刚写入却无法读回', {
          entity: entity(valid.projectId, slotId),
        });
      }
      return slotFromRow(inserted, operation);
    },

    renewInTransaction(input, leaseUntilUtcMs) {
      const operation = 'renewInTransaction';
      write(operation);
      const identity = validateExecutionSlotIdentity(input);
      const requested = validateExecutionSlotLeaseUntilUtcMs(leaseUntilUtcMs);
      const timestamp = now(operation);
      const current = readByIdentity(identity, operation);
      const leaseUntil = assertExecutionSlotRenewal(current, requested);
      if (leaseUntil <= timestamp) {
        throw new StorageError('validation', `${OPERATION}.${operation}`, '槽位续租到期时刻必须晚于当前时刻', {
          entity: entity(identity.projectId, identity.slotId),
          details: { field: 'leaseUntilUtcMs', reason: 'expired_new_slot_lease' },
        });
      }
      requireHeldClaim({
        projectId: current.projectId,
        featureId: current.featureId,
        runId: current.runId,
        claimId: current.claimId,
        claimVersion: current.claimVersion,
        ownerId: current.ownerId,
        hostInstanceId: current.hostInstanceId,
        leaseUntilUtcMs: leaseUntil,
      }, operation);
      if (current.leaseUntilUtcMs <= timestamp) {
        // 到期不续租、不删除：转隔离并返回该记录，调用方必须视为不再授权。
        // 该转换属于本次事务的正常提交结果，不抛错以免整组回滚丢失隔离事实。
        db.prepare(
          "UPDATE execution_slot_claims SET state = 'quarantined', reason = ?, revision = revision + 1, updated_at = ? " +
            "WHERE project_id = ? AND id = ? AND state = 'held' AND revision = ?",
        ).run(EXECUTION_SLOT_LEASE_EXPIRED_REASON, timestamp, identity.projectId, identity.slotId, current.revision);
        const quarantined = readRow(identity.projectId, identity.slotId, operation);
        if (quarantined === undefined) {
          throw new StorageError('corrupt', `${OPERATION}.${operation}`, '槽位隔离后无法读回', {
            entity: entity(identity.projectId, identity.slotId),
          });
        }
        return slotFromRow(quarantined, operation);
      }
      const changed = db.prepare(
        "UPDATE execution_slot_claims SET lease_until = ?, revision = revision + 1, updated_at = ? " +
          "WHERE project_id = ? AND id = ? AND state = 'held' AND revision = ? AND lease_until = ?",
      ).run(
        leaseUntil,
        timestamp,
        identity.projectId,
        identity.slotId,
        current.revision,
        current.leaseUntilUtcMs,
      );
      if (changed.changes !== 1) {
        fail(operation, 'conflict', 'slot_identity_mismatch',
          '槽位续租 CAS 失败（并发修改或状态变化），拒绝覆盖当前行', identity.projectId, identity.slotId);
      }
      const renewed = readRow(identity.projectId, identity.slotId, operation);
      if (renewed === undefined) {
        throw new StorageError('corrupt', `${OPERATION}.${operation}`, '槽位续租后无法读回', {
          entity: entity(identity.projectId, identity.slotId),
        });
      }
      return slotFromRow(renewed, operation);
    },

    releaseInTransaction(input) {
      const operation = 'releaseInTransaction';
      write(operation);
      const identity = validateExecutionSlotIdentity(input);
      const timestamp = now(operation);
      const current = readByIdentity(identity, operation);
      assertExecutionSlotRelease(current, timestamp);
      if (current.state === 'released') {
        return current;
      }
      const changed = db.prepare(
        "UPDATE execution_slot_claims SET state = 'released', released_at = ?, reason = NULL, " +
          'revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND state = \'held\' AND revision = ?',
      ).run(timestamp, timestamp, identity.projectId, identity.slotId, current.revision);
      if (changed.changes !== 1) {
        fail(operation, 'conflict', 'slot_identity_mismatch',
          '槽位释放 CAS 失败（并发修改或状态变化），拒绝释放当前行', identity.projectId, identity.slotId);
      }
      const released = readRow(identity.projectId, identity.slotId, operation);
      if (released === undefined) {
        throw new StorageError('corrupt', `${OPERATION}.${operation}`, '槽位释放后无法读回', {
          entity: entity(identity.projectId, identity.slotId),
        });
      }
      return slotFromRow(released, operation);
    },

    quarantineInTransaction(input, reasonInput) {
      const operation = 'quarantineInTransaction';
      write(operation);
      const identity = validateExecutionSlotIdentity(input);
      const reason = validateExecutionSlotQuarantineReason(reasonInput);
      const timestamp = now(operation);
      const current = readByIdentity(identity, operation);
      if (current.state === 'released') {
        fail(operation, 'conflict', 'slot_released', '已释放槽位是终态，不能隔离', identity.projectId, identity.slotId);
      }
      if (current.state === 'quarantined') {
        // 幂等：保留首次隔离原因与时间，不重复提升 revision。
        return current;
      }
      const changed = db.prepare(
        "UPDATE execution_slot_claims SET state = 'quarantined', reason = ?, revision = revision + 1, updated_at = ? " +
          "WHERE project_id = ? AND id = ? AND state = 'held' AND revision = ?",
      ).run(reason, timestamp, identity.projectId, identity.slotId, current.revision);
      if (changed.changes !== 1) {
        fail(operation, 'conflict', 'slot_identity_mismatch',
          '槽位隔离 CAS 失败（并发修改或状态变化），拒绝覆盖当前行', identity.projectId, identity.slotId);
      }
      const quarantined = readRow(identity.projectId, identity.slotId, operation);
      if (quarantined === undefined) {
        throw new StorageError('corrupt', `${OPERATION}.${operation}`, '槽位隔离后无法读回', {
          entity: entity(identity.projectId, identity.slotId),
        });
      }
      return slotFromRow(quarantined, operation);
    },

    expireInTransaction() {
      const operation = 'expireInTransaction';
      write(operation);
      const timestamp = now(operation);
      // 到期只隔离：不删除行、不缩短租约、不重新分配槽号。
      const expired = db
        .prepare<[number], { id: string; project_id: string }>(
          "SELECT id, project_id FROM execution_slot_claims WHERE state = 'held' AND lease_until <= ?",
        )
        .all(timestamp) as { id: string; project_id: string }[];
      const update = db.prepare(
        "UPDATE execution_slot_claims SET state = 'quarantined', reason = ?, revision = revision + 1, updated_at = ? " +
          "WHERE project_id = ? AND id = ? AND state = 'held'",
      );
      for (const row of expired) {
        update.run(EXECUTION_SLOT_LEASE_EXPIRED_REASON, timestamp, row.project_id, row.id);
      }
      return expired.length;
    },
  };
}
