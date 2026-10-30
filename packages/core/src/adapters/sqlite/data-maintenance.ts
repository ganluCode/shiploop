import type { SqliteStorageSession } from './session.js';
import { StorageError } from '../../ports/errors.js';
import {
  MAINTENANCE_OPERATIONS,
  MAINTENANCE_WRITE_KINDS,
  type AcquireMaintenanceInput,
  type MaintenanceLease,
  type MaintenanceOccupancy,
  type MaintenanceOperation,
  type MaintenanceWriteGate,
  type ReleaseMaintenanceInput,
} from '../../ports/data-maintenance.js';

const ROW_ID = 'global';
const operationName = 'MaintenanceOccupancy';

type Row = {
  state: 'idle' | 'held' | 'blocked'; operation: MaintenanceOperation | null; operation_id: string | null;
  owner_id: string | null; host_instance_id: string | null; fence: number; acquired_at: number | null; blocked_reason: string | null;
};

function readRow(session: SqliteStorageSession): MaintenanceOccupancy {
  const row = session.database.prepare<[string], Row>('SELECT state, operation, operation_id, owner_id, host_instance_id, fence, acquired_at, blocked_reason FROM maintenance_occupancy WHERE id = ?').get(ROW_ID);
  if (row === undefined) throw new StorageError('corrupt', operationName, '维护占用事实缺失');
  return { state: row.state, operation: row.operation, operationId: row.operation_id, owner: row.owner_id,
    hostInstanceId: row.host_instance_id, fence: row.fence, acquiredAtUtcMs: row.acquired_at, blockedReason: row.blocked_reason };
}

function assertInput(input: AcquireMaintenanceInput): void {
  if (!(MAINTENANCE_OPERATIONS as readonly string[]).includes(input.operation) ||
      ![input.operationId, input.owner, input.hostInstanceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128) ||
      !Number.isSafeInteger(input.nowUtcMs) || input.nowUtcMs < 1) throw new TypeError('维护占用输入非法');
}

function fail(reason: string, current: MaintenanceOccupancy): never {
  throw new StorageError('busy', operationName, '维护占用阻止该操作', {
    entity: { type: 'backup', id: current.operationId ?? undefined },
    details: { reason, operation: current.operation ?? 'unknown', operationId: current.operationId ?? undefined, fence: current.fence },
  });
}

/**
 * SQLite-backed fencing gate. Every mutating method owns a short BEGIN IMMEDIATE;
 * callers perform file copying, process observation and long verification outside it.
 */
export function createSqliteMaintenanceWriteGate(session: SqliteStorageSession): MaintenanceWriteGate {
  return Object.freeze({
    read(): MaintenanceOccupancy {
      if (session.database.inTransaction) return readRow(session);
      return readRow(session);
    },
    acquire(input: AcquireMaintenanceInput): MaintenanceLease {
      assertInput(input);
      return session.transactWrite(`${operationName}.acquire`, () => {
        const current = readRow(session);
        if (current.state !== 'idle') fail(current.state === 'blocked' ? 'maintenance_blocked' : 'maintenance_in_progress', current);
        const fence = current.fence + 1;
        session.database.prepare(`UPDATE maintenance_occupancy SET state = 'held', operation = ?, operation_id = ?, owner_id = ?, host_instance_id = ?, fence = ?, acquired_at = ?, blocked_reason = NULL, revision = revision + 1 WHERE id = ? AND state = 'idle' AND fence = ?`)
          .run(input.operation, input.operationId, input.owner, input.hostInstanceId, fence, input.nowUtcMs, ROW_ID, current.fence);
        return { operation: input.operation, operationId: input.operationId, owner: input.owner, hostInstanceId: input.hostInstanceId, fence };
      });
    },
    release(input: ReleaseMaintenanceInput): MaintenanceOccupancy {
      return session.transactWrite(`${operationName}.release`, () => {
        const current = readRow(session);
        if (current.state === 'idle') return current;
        if (current.operation !== input.operation || current.operationId !== input.operationId || current.owner !== input.owner
          || current.hostInstanceId !== input.hostInstanceId || current.fence !== input.fence) fail('stale_maintenance_owner', current);
        if (current.state === 'blocked' && input.confirmed) fail('blocked_requires_new_host_recovery', current);
        if (!input.confirmed) {
          const reason = input.reason ?? 'cleanup_unconfirmed';
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reason)) throw new TypeError('维护阻塞原因非法');
          session.database.prepare("UPDATE maintenance_occupancy SET state = 'blocked', blocked_reason = ?, revision = revision + 1 WHERE id = ? AND fence = ?")
            .run(reason, ROW_ID, current.fence);
        } else {
          session.database.prepare("UPDATE maintenance_occupancy SET state = 'idle', operation = NULL, operation_id = NULL, owner_id = NULL, host_instance_id = NULL, acquired_at = NULL, blocked_reason = NULL, revision = revision + 1 WHERE id = ? AND fence = ?")
            .run(ROW_ID, current.fence);
        }
        return readRow(session);
      });
    },
    assertCanWrite(kind: (typeof MAINTENANCE_WRITE_KINDS)[number]): void {
      if (!(MAINTENANCE_WRITE_KINDS as readonly string[]).includes(kind)) throw new TypeError('维护写入类别非法');
      const current = readRow(session);
      if (current.state !== 'idle') fail(current.state === 'blocked' ? 'maintenance_blocked' : 'maintenance_in_progress', current);
    },
  });
}
