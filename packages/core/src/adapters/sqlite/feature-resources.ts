import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assertFeatureResourceLeaseOwner,
  assertFeatureResourceLeaseTransition,
  normalizeFeatureResourceSet,
  validateFeatureResourceAcquireInput,
  validateFeatureResourceDeclaration,
  validateFeatureResourceLeaseRecord,
  validateFeatureResourceOwner,
  FEATURE_RESOURCE_KIND_ORDER,
  type FeatureResourceAccess,
  type FeatureResourceAcquireInput,
  type FeatureResourceDeclaration,
  type FeatureResourceLeaseRecord,
  type FeatureResourceOwner,
  type FeatureResourceWaitReason,
} from '../../ports/feature-resources.js';
import { StorageError } from '../../ports/errors.js';
import { validateStableId } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'FeatureResources';
const ACTIVE_STATES_SQL = "'held', 'quarantined'";

type FeatureResourceSqlRow = {
  readonly id: string;
  readonly created_at: number;
  readonly project_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly resource_key: string;
  readonly resource_kind: string;
  readonly access_mode: string;
  readonly lease_mode: string;
  readonly owner_id: string;
  readonly owner_version: number;
  readonly acquired_at: number;
  readonly lease_until: number;
  readonly state: string;
  readonly waiting_reason: string | null;
  readonly released_at: number | null;
};

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    && (error as unknown as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}

function asAcquireInput(value: unknown): FeatureResourceAcquireInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return validateFeatureResourceAcquireInput(value);
  }
  const raw = value as Record<string, unknown>;
  if (raw.owner !== undefined) return validateFeatureResourceAcquireInput(value);
  // Accept the flat shape used by older internal callers while validating the same
  // canonical nested port shape. Preserve unknown-key rejection at this compatibility boundary.
  const allowed = new Set(['resourceSet', 'ownerId', 'ownerVersion', 'leaseUntilUtcMs']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new StorageError('validation', `${OPERATION}.validateAcquire`, `未知认领输入字段：${key}`, {
        entity: { type: 'feature_resource_lease' }, details: { field: key },
      });
    }
  }
  return validateFeatureResourceAcquireInput({
    resourceSet: raw.resourceSet,
    owner: { ownerId: raw.ownerId, ownerVersion: raw.ownerVersion },
    leaseUntilUtcMs: raw.leaseUntilUtcMs,
  });
}

function asResourceDeclaration(value: unknown): FeatureResourceDeclaration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return validateFeatureResourceDeclaration(value);
  }
  const raw = value as Record<string, unknown>;
  const { accessMode, leaseMode, ...declaration } = raw;
  const normalized = validateFeatureResourceDeclaration(declaration);
  if ((accessMode !== undefined && accessMode !== normalized.accessMode)
    || (leaseMode !== undefined && leaseMode !== normalized.leaseMode)) {
    throw new StorageError('validation', `${OPERATION}.validateDeclaration`, '资源占用语义不能由输入改写', {
      entity: { type: 'feature_resource_lease', projectId: normalized.projectId },
    });
  }
  return normalized;
}

export interface SqliteFeatureResourceAccessOptions {
  readonly nowUtcMs?: () => number;
}

export function createSqliteFeatureResourceAccess(
  session: SqliteStorageSession,
  options: SqliteFeatureResourceAccessOptions = {},
): FeatureResourceAccess {
  const db = session.database;
  const clock = options.nowUtcMs ?? Date.now;

  function assertOpen(operation: string): void {
    if (!session.isOpen()) {
      throw new StorageError('corrupt', `${OPERATION}.${operation}`, 'SQLite 存储会话已关闭，拒绝继续操作', {
        entity: { type: 'feature_resource_lease' },
      });
    }
  }

  function assertTransaction(operation: string): void {
    assertOpen(operation);
    if (!db.inTransaction) {
      throw new TypeError(`FeatureResources.${operation} 必须在调用方已打开的短写事务内执行`);
    }
  }

  function now(operation: string): number {
    const value = Number(clock());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StorageError('validation', `${OPERATION}.${operation}`, '资源租约时钟必须是非负安全整数 UTC 毫秒', {
        entity: { type: 'feature_resource_lease' },
        details: { field: 'nowUtcMs', reason: 'invalid_clock' },
      });
    }
    return value;
  }

  function entity(projectId?: string, id?: string) {
    return { type: 'feature_resource_lease' as const, ...(projectId === undefined ? {} : { projectId }), ...(id === undefined ? {} : { id }) };
  }

  function conflict(
    operation: string,
    message: string,
    projectId: string,
    details: Readonly<Record<string, unknown>> = {},
  ): never {
    throw new StorageError('conflict', `${OPERATION}.${operation}`, message, {
      entity: entity(projectId),
      details,
    });
  }

  function rowToRecord(row: FeatureResourceSqlRow, operation: string): FeatureResourceLeaseRecord {
    let waitingReason: FeatureResourceWaitReason | null = null;
    if (row.waiting_reason !== null) {
      try {
        waitingReason = JSON.parse(row.waiting_reason) as FeatureResourceWaitReason;
      } catch (error) {
        throw new StorageError('corrupt', `${OPERATION}.${operation}`, '资源租约 waitingReason 不是合法 JSON', {
          entity: entity(row.project_id, row.id), cause: error,
        });
      }
    }
    try {
      return validateFeatureResourceLeaseRecord({
        id: row.id,
        projectId: row.project_id,
        revision: row.revision,
        resource: {
          projectId: row.project_id,
          kind: row.resource_kind,
          key: row.resource_key,
          accessMode: row.access_mode,
          leaseMode: row.lease_mode,
        },
        ownerId: row.owner_id,
        ownerVersion: row.owner_version,
        acquiredAtUtcMs: row.acquired_at,
        leaseUntilUtcMs: row.lease_until,
        state: row.state,
        waitingReason,
        releasedAtUtcMs: row.released_at,
      });
    } catch (error) {
      throw new StorageError('corrupt', `${OPERATION}.${operation}`, '资源租约行损坏', {
        entity: entity(row.project_id, row.id), cause: error,
      });
    }
  }

  function rowsFor(projectId: string, resourceKey: string): FeatureResourceSqlRow[] {
    return db.prepare<[string, string], FeatureResourceSqlRow>(
      'SELECT id, created_at, project_id, revision, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state, waiting_reason, released_at ' +
      'FROM feature_resource_leases WHERE project_id = ? AND resource_key = ? ORDER BY acquired_at, id',
    ).all(projectId, resourceKey) as FeatureResourceSqlRow[];
  }

  function activeRows(projectId: string, resourceKey: string): FeatureResourceSqlRow[] {
    return db.prepare<[string, string], FeatureResourceSqlRow>(
      `SELECT id, created_at, project_id, revision, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state, waiting_reason, released_at FROM feature_resource_leases WHERE project_id = ? AND resource_key = ? AND state IN (${ACTIVE_STATES_SQL}) ORDER BY acquired_at, id`,
    ).all(projectId, resourceKey) as FeatureResourceSqlRow[];
  }

  function ownerRecords(projectId: string, owner: FeatureResourceOwner, operation: string): FeatureResourceLeaseRecord[] {
    const rows = db.prepare<[string, string, number], FeatureResourceSqlRow>(
      'SELECT id, created_at, project_id, revision, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state, waiting_reason, released_at ' +
      'FROM feature_resource_leases WHERE project_id = ? AND owner_id = ? AND owner_version = ?',
    ).all(projectId, owner.ownerId, owner.ownerVersion) as FeatureResourceSqlRow[];
    return rows.map(row => rowToRecord(row, operation)).sort((a, b) => {
      const kindOrder = FEATURE_RESOURCE_KIND_ORDER.indexOf(a.resource.kind) - FEATURE_RESOURCE_KIND_ORDER.indexOf(b.resource.kind);
      return kindOrder !== 0 ? kindOrder : a.resource.key.localeCompare(b.resource.key);
    });
  }

  function currentOrReleased(resource: FeatureResourceDeclaration, owner: FeatureResourceOwner, operation: string): FeatureResourceLeaseRecord {
    const active = activeRows(resource.projectId, resource.key);
    const owned = active.find((row) => row.owner_id === owner.ownerId && row.owner_version === owner.ownerVersion);
    if (owned !== undefined) return rowToRecord(owned, operation);
    const sameOwner = active.find((row) => row.owner_id === owner.ownerId);
    if (sameOwner !== undefined) {
      const record = rowToRecord(sameOwner, operation);
      assertFeatureResourceLeaseOwner(record, owner);
      return record;
    }
    if (active[0] !== undefined) {
      const record = rowToRecord(active[0], operation);
      assertFeatureResourceLeaseOwner(record, owner);
      return record;
    }
    const history = rowsFor(resource.projectId, resource.key);
    const latest = history.at(-1);
    if (latest === undefined) {
      throw new StorageError('not_found', `${OPERATION}.${operation}`, '资源租约不存在', {
        entity: entity(resource.projectId), details: { resourceKey: resource.key, reason: 'resource_not_found' },
      });
    }
    const record = rowToRecord(latest, operation);
    assertFeatureResourceLeaseOwner(record, owner);
    return record;
  }

  function waitReasonFor(record: FeatureResourceLeaseRecord, atUtcMs: number): FeatureResourceWaitReason {
    const code = record.state === 'quarantined'
      ? 'resource_quarantined'
      : record.leaseUntilUtcMs <= atUtcMs ? 'lease_expired_unverified' : 'resource_occupied';
    return {
      code,
      resourceKey: record.resource.key,
      blockingOwnerId: record.ownerId,
      blockingOwnerVersion: record.ownerVersion,
    };
  }

  function updateRecord(
    previous: FeatureResourceLeaseRecord,
    changes: Pick<FeatureResourceLeaseRecord, 'leaseUntilUtcMs' | 'state' | 'waitingReason' | 'releasedAtUtcMs'>,
    operation: string,
  ): FeatureResourceLeaseRecord {
    const next = validateFeatureResourceLeaseRecord({
      ...previous,
      ...changes,
      revision: previous.revision + 1,
    });
    assertFeatureResourceLeaseTransition(previous, next);
    const result = db.prepare(
      'UPDATE feature_resource_leases SET revision = ?, updated_at = ?, lease_until = ?, state = ?, waiting_reason = ?, released_at = ? WHERE project_id = ? AND id = ? AND revision = ?',
    ).run(
      next.revision,
      next.releasedAtUtcMs ?? next.leaseUntilUtcMs,
      next.leaseUntilUtcMs,
      next.state,
      next.waitingReason === null ? null : JSON.stringify(next.waitingReason),
      next.releasedAtUtcMs,
      next.projectId,
      next.id,
      previous.revision,
    );
    if (result.changes !== 1) {
      conflict(operation, '资源租约 revision CAS 冲突', previous.projectId, {
        reason: 'revision_conflict', resourceKey: previous.resource.key, expectedRevision: previous.revision,
      });
    }
    return next;
  }

  return {
    normalize: normalizeFeatureResourceSet,

    read(resource: unknown): readonly FeatureResourceLeaseRecord[] {
      assertOpen('read');
      const declaration = asResourceDeclaration(resource);
      return rowsFor(declaration.projectId, declaration.key).map((row) => rowToRecord(row, 'read'));
    },

    listOwnerInTransaction(projectIdInput, ownerInput) {
      assertTransaction('listOwnerInTransaction');
      const projectId = validateStableId(projectIdInput, { operation: `${OPERATION}.listOwnerInTransaction` }, 'projectId');
      const owner = validateFeatureResourceOwner(ownerInput);
      return ownerRecords(projectId, owner, 'listOwnerInTransaction');
    },

    acquireInTransaction(input: unknown): readonly FeatureResourceLeaseRecord[] {
      assertTransaction('acquireInTransaction');
      const valid = asAcquireInput(input);
      const timestamp = now('acquireInTransaction');
      if (valid.leaseUntilUtcMs <= timestamp) {
        throw new StorageError('validation', `${OPERATION}.acquireInTransaction`, '资源租约必须晚于当前时刻', {
          entity: entity(valid.resourceSet.projectId), details: { field: 'leaseUntilUtcMs', reason: 'expired_new_lease' },
        });
      }

      const existing = new Map<string, FeatureResourceLeaseRecord>();
      for (const resource of valid.resourceSet.resources) {
        const rows = activeRows(valid.resourceSet.projectId, resource.key);
        const owned = rows.find((row) => row.owner_id === valid.owner.ownerId && row.owner_version === valid.owner.ownerVersion);
        if (owned !== undefined) {
          const record = rowToRecord(owned, 'acquireInTransaction');
          if (record.state === 'held' && record.leaseUntilUtcMs > timestamp) {
            existing.set(resource.key, record);
            continue;
          }
          const waitReason = waitReasonFor(record, timestamp);
          conflict('acquireInTransaction', '资源集合存在冲突，整组认领已回滚', valid.resourceSet.projectId, {
            reason: waitReason.code, resourceKey: resource.key, waitReason,
          });
        }
        const sameOwner = rows.find((row) => row.owner_id === valid.owner.ownerId);
        const blocking = resource.accessMode === 'shared' ? sameOwner : rows[0];
        if (blocking !== undefined) {
          const record = rowToRecord(blocking, 'acquireInTransaction');
          const waitReason = waitReasonFor(record, timestamp);
          conflict('acquireInTransaction', '资源集合存在冲突，整组认领已回滚', valid.resourceSet.projectId, {
            reason: waitReason.code, resourceKey: resource.key, waitReason,
          });
        }
      }

      const result: FeatureResourceLeaseRecord[] = [];
      for (const resource of valid.resourceSet.resources) {
        const reused = existing.get(resource.key);
        if (reused !== undefined) {
          result.push(reused);
          continue;
        }
        const record = validateFeatureResourceLeaseRecord({
          id: randomUUID(),
          projectId: valid.resourceSet.projectId,
          resource,
          ownerId: valid.owner.ownerId,
          ownerVersion: valid.owner.ownerVersion,
          revision: 1,
          acquiredAtUtcMs: timestamp,
          leaseUntilUtcMs: valid.leaseUntilUtcMs,
          state: 'held',
          waitingReason: null,
          releasedAtUtcMs: null,
        });
        try {
          db.prepare(
            'INSERT INTO feature_resource_leases (id, created_at, project_id, revision, updated_at, resource_key, resource_kind, access_mode, lease_mode, owner_id, owner_version, acquired_at, lease_until, state, waiting_reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(record.id, timestamp, record.projectId, record.revision, timestamp, record.resource.key,
            record.resource.kind, record.resource.accessMode, record.resource.leaseMode, record.ownerId,
            record.ownerVersion, record.acquiredAtUtcMs, record.leaseUntilUtcMs, record.state, null, null);
        } catch (error) {
          if (isConstraintError(error)) {
            conflict('acquireInTransaction', '资源集合并发认领冲突，整组认领已回滚', valid.resourceSet.projectId, {
              reason: 'resource_occupied', resourceKey: resource.key,
            });
          }
          throw error;
        }
        result.push(record);
      }
      return result;
    },

    renewInTransaction(ownerInput: unknown, resourceInput: unknown, leaseUntilUtcMsInput: unknown): FeatureResourceLeaseRecord {
      assertTransaction('renewInTransaction');
      const owner = validateFeatureResourceOwner(ownerInput);
      const resource = asResourceDeclaration(resourceInput);
      const leaseUntilUtcMs = Number(leaseUntilUtcMsInput);
      if (!Number.isSafeInteger(leaseUntilUtcMs) || leaseUntilUtcMs < 0) {
        throw new StorageError('validation', `${OPERATION}.renewInTransaction`, '租约截止时间必须是非负安全整数', {
          entity: entity(resource.projectId), details: { field: 'leaseUntilUtcMs' },
        });
      }
      const current = currentOrReleased(resource, owner, 'renewInTransaction');
      const timestamp = now('renewInTransaction');
      if (current.state !== 'held' || current.leaseUntilUtcMs <= timestamp) {
        const reason: FeatureResourceWaitReason = {
          code: current.state === 'quarantined' ? 'resource_quarantined' : 'lease_expired_unverified',
          resourceKey: resource.key, blockingOwnerId: current.ownerId, blockingOwnerVersion: current.ownerVersion,
        };
        if (current.state === 'held') {
          return updateRecord(current, { leaseUntilUtcMs: current.leaseUntilUtcMs, state: 'quarantined', waitingReason: reason, releasedAtUtcMs: null }, 'renewInTransaction');
        }
        conflict('renewInTransaction', '资源租约已隔离，不能续租', resource.projectId, { reason: reason.code, resourceKey: resource.key, waitReason: reason });
      }
      if (leaseUntilUtcMs < current.leaseUntilUtcMs) {
        throw new StorageError('validation', `${OPERATION}.renewInTransaction`, '续租不得缩短当前租约', {
          entity: entity(resource.projectId, current.id), details: { field: 'leaseUntilUtcMs', current: current.leaseUntilUtcMs },
        });
      }
      return updateRecord(current, { leaseUntilUtcMs, state: 'held', waitingReason: null, releasedAtUtcMs: null }, 'renewInTransaction');
    },

    releaseInTransaction(ownerInput: unknown, resourceInput: unknown): FeatureResourceLeaseRecord {
      assertTransaction('releaseInTransaction');
      const owner = validateFeatureResourceOwner(ownerInput);
      const resource = asResourceDeclaration(resourceInput);
      const current = currentOrReleased(resource, owner, 'releaseInTransaction');
      if (current.state === 'released') return current;
      const timestamp = now('releaseInTransaction');
      if (current.state === 'quarantined') {
        conflict('releaseInTransaction', '已隔离资源不能通过普通释放完成', resource.projectId, {
          reason: 'resource_quarantined', resourceKey: resource.key,
        });
      }
      if (current.leaseUntilUtcMs <= timestamp) {
        conflict('releaseInTransaction', '资源租约已到期，需先核对停止证据', resource.projectId, {
          reason: 'lease_expired_unverified', resourceKey: resource.key,
        });
      }
      return updateRecord(current, { leaseUntilUtcMs: current.leaseUntilUtcMs, state: 'released', waitingReason: null, releasedAtUtcMs: timestamp }, 'releaseInTransaction');
    },

    releaseOwnerInTransaction(projectIdInput, ownerInput) {
      assertTransaction('releaseOwnerInTransaction');
      const projectId = validateStableId(projectIdInput, { operation: `${OPERATION}.releaseOwnerInTransaction` }, 'projectId');
      const owner = validateFeatureResourceOwner(ownerInput);
      const records = ownerRecords(projectId, owner, 'releaseOwnerInTransaction');
      const timestamp = now('releaseOwnerInTransaction');
      // Release order is canonical and deterministic. The caller's transaction
      // rolls back all earlier rows if a later row fails its stop/lease guard.
      return records.map(record => {
        if (record.state === 'released') return record;
        if (record.state === 'quarantined') {
          conflict('releaseOwnerInTransaction', '已隔离资源不能通过普通释放完成', projectId, {
            reason: 'resource_quarantined', resourceKey: record.resource.key,
          });
        }
        if (record.leaseUntilUtcMs <= timestamp) {
          conflict('releaseOwnerInTransaction', '资源租约已到期，需先核对停止证据', projectId, {
            reason: 'lease_expired_unverified', resourceKey: record.resource.key,
          });
        }
        return updateRecord(record, { leaseUntilUtcMs: record.leaseUntilUtcMs, state: 'released',
          waitingReason: null, releasedAtUtcMs: timestamp }, 'releaseOwnerInTransaction');
      });
    },

    releaseOwnerAfterStopInTransaction(projectIdInput, ownerInput) {
      assertTransaction('releaseOwnerAfterStopInTransaction');
      const projectId = validateStableId(projectIdInput, { operation: `${OPERATION}.releaseOwnerAfterStopInTransaction` }, 'projectId');
      const owner = validateFeatureResourceOwner(ownerInput);
      const timestamp = now('releaseOwnerAfterStopInTransaction');
      return ownerRecords(projectId, owner, 'releaseOwnerAfterStopInTransaction').map(record => record.state === 'released'
        ? record
        : updateRecord(record, {
          leaseUntilUtcMs: record.leaseUntilUtcMs, state: 'released', waitingReason: null,
          releasedAtUtcMs: Math.max(timestamp, record.acquiredAtUtcMs),
        }, 'releaseOwnerAfterStopInTransaction'));
    },

    quarantineOwnerInTransaction(projectIdInput, ownerInput, reasonInput) {
      assertTransaction('quarantineOwnerInTransaction');
      const projectId = validateStableId(projectIdInput, { operation: `${OPERATION}.quarantineOwnerInTransaction` }, 'projectId');
      const owner = validateFeatureResourceOwner(ownerInput);
      const records = ownerRecords(projectId, owner, 'quarantineOwnerInTransaction');
      const rawReason = typeof reasonInput === 'object' && reasonInput !== null ? reasonInput as Record<string, unknown> : {};
      const code: FeatureResourceWaitReason['code'] = rawReason.code === 'lease_expired_unverified'
        ? 'lease_expired_unverified' : 'resource_quarantined';
      return records.map(record => record.state === 'held'
        ? updateRecord(record, { leaseUntilUtcMs: record.leaseUntilUtcMs, state: 'quarantined', waitingReason: {
          code, resourceKey: record.resource.key, blockingOwnerId: owner.ownerId, blockingOwnerVersion: owner.ownerVersion,
        }, releasedAtUtcMs: null }, 'quarantineOwnerInTransaction') : record);
    },

    renewOwnerInTransaction(projectIdInput, ownerInput, leaseUntilUtcMsInput) {
      assertTransaction('renewOwnerInTransaction');
      const projectId = validateStableId(projectIdInput, { operation: `${OPERATION}.renewOwnerInTransaction` }, 'projectId');
      const owner = validateFeatureResourceOwner(ownerInput);
      const leaseUntilUtcMs = Number(leaseUntilUtcMsInput);
      if (!Number.isSafeInteger(leaseUntilUtcMs) || leaseUntilUtcMs < 0) {
        throw new StorageError('validation', `${OPERATION}.renewOwnerInTransaction`, '租约截止时间必须是非负安全整数', {
          entity: entity(projectId), details: { field: 'leaseUntilUtcMs' },
        });
      }
      const records = ownerRecords(projectId, owner, 'renewOwnerInTransaction');
      if (records.length === 0) return records;
      const timestamp = now('renewOwnerInTransaction');
      if (records.some(record => record.state === 'quarantined' || record.leaseUntilUtcMs <= timestamp)) {
        const reasonCode: FeatureResourceWaitReason['code'] = records.some(record => record.state === 'quarantined')
          ? 'resource_quarantined' : 'lease_expired_unverified';
        const quarantined = records.map(record => record.state === 'held'
          ? updateRecord(record, { leaseUntilUtcMs: record.leaseUntilUtcMs, state: 'quarantined', waitingReason: {
            code: reasonCode, resourceKey: record.resource.key, blockingOwnerId: owner.ownerId, blockingOwnerVersion: owner.ownerVersion,
          }, releasedAtUtcMs: null }, 'renewOwnerInTransaction') : record);
        return quarantined;
      }
      if (records.some(record => leaseUntilUtcMs < record.leaseUntilUtcMs)) {
        throw new StorageError('validation', `${OPERATION}.renewOwnerInTransaction`, '续租不得缩短当前资源组租约', {
          entity: entity(projectId), details: { field: 'leaseUntilUtcMs' },
        });
      }
      return records.map(record => updateRecord(record, {
        leaseUntilUtcMs, state: 'held', waitingReason: null, releasedAtUtcMs: null,
      }, 'renewOwnerInTransaction'));
    },

    quarantineInTransaction(ownerInput: unknown, resourceInput: unknown, reasonInput: unknown): FeatureResourceLeaseRecord {
      assertTransaction('quarantineInTransaction');
      const owner = validateFeatureResourceOwner(ownerInput);
      const resource = asResourceDeclaration(resourceInput);
      const current = currentOrReleased(resource, owner, 'quarantineInTransaction');
      if (current.state === 'released') return current;
      const reason = reasonInput as FeatureResourceWaitReason;
      const nextReason = {
        code: reason?.code ?? 'lease_expired_unverified',
        resourceKey: resource.key,
        blockingOwnerId: reason?.blockingOwnerId ?? current.ownerId,
        blockingOwnerVersion: reason?.blockingOwnerVersion ?? current.ownerVersion,
      };
      return updateRecord(current, { leaseUntilUtcMs: current.leaseUntilUtcMs, state: 'quarantined', waitingReason: nextReason, releasedAtUtcMs: null }, 'quarantineInTransaction');
    },
  };
}
