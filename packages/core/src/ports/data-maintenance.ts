/** P07-3 / F-002：备份、迁移和项目维护共用的写入资格契约。
 *
 * 这是 Core 的窄门控，不是第二个调度器：维护者先由 Host quiesce
 * 收拢活动，再持有一次带 fencing 身份的独占占用。所有可能改变数据库、制品
 * 关联、工作区或记录水位的短事务在提交前调用 assertCanWrite；只读查询不经过
 * 该门控。占用不可凭时间或 PID 自动回收，未知停止必须保持 blocked。
 */
import { StorageError } from './errors.js';

export const MAINTENANCE_OPERATIONS = [
  'backup', 'migration', 'restore', 'project_archive', 'project_delete',
] as const;
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];

export const MAINTENANCE_WRITE_KINDS = [
  'planning', 'baseline', 'work', 'verification', 'git', 'recording',
  'configuration', 'artifact', 'cleanup',
] as const;
export type MaintenanceWriteKind = (typeof MAINTENANCE_WRITE_KINDS)[number];

export type MaintenanceOccupancyState = 'idle' | 'held' | 'blocked';

export interface MaintenanceOccupancy {
  readonly state: MaintenanceOccupancyState;
  readonly operation: MaintenanceOperation | null;
  readonly operationId: string | null;
  readonly owner: string | null;
  readonly hostInstanceId: string | null;
  readonly fence: number;
  readonly acquiredAtUtcMs: number | null;
  readonly blockedReason: string | null;
}

export interface MaintenanceLease {
  readonly operation: MaintenanceOperation;
  readonly operationId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly fence: number;
}

export interface AcquireMaintenanceInput {
  readonly operation: MaintenanceOperation;
  readonly operationId: string;
  readonly owner: string;
  readonly hostInstanceId: string;
  readonly nowUtcMs: number;
}

export interface ReleaseMaintenanceInput extends MaintenanceLease {
  /** false means stop/cleanup evidence is incomplete and must preserve isolation. */
  readonly confirmed: boolean;
  readonly reason?: string;
}

export interface MaintenanceWriteGate {
  readonly read: () => MaintenanceOccupancy;
  readonly acquire: (input: AcquireMaintenanceInput) => MaintenanceLease;
  readonly release: (input: ReleaseMaintenanceInput) => MaintenanceOccupancy;
  /** Must be called inside the caller's committing transaction. */
  readonly assertCanWrite: (kind: MaintenanceWriteKind) => void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`维护门控 ${field} 非法`);
  return value;
}

function validNow(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError('维护门控时间非法');
  return Number(value);
}

function validOperation(value: unknown): MaintenanceOperation {
  if (typeof value !== 'string' || !(MAINTENANCE_OPERATIONS as readonly string[]).includes(value)) {
    throw new TypeError('维护门控操作非法');
  }
  return value as MaintenanceOperation;
}

function conflict(reason: string, occupancy: MaintenanceOccupancy): never {
  throw new StorageError('busy', 'MaintenanceGate.write', '维护占用阻止新的写入', {
    entity: { type: 'backup', id: occupancy.operationId ?? undefined },
    details: {
      reason,
      operation: occupancy.operation ?? 'unknown',
      operationId: occupancy.operationId ?? undefined,
      hostInstanceId: occupancy.hostInstanceId ?? undefined,
      fence: occupancy.fence,
    },
  });
}

/**
 * 进程内实现供 Host/测试装配；跨进程生产实现应把同一状态写入 Core SQLite，
 * 并在 BEGIN IMMEDIATE 内执行 acquire/assertCanWrite/release。这里刻意不提供
 * 自动过期或按 PID 回收，避免把不确定的旧写入者当作安全。
 */
export function createMaintenanceWriteGate(initial?: Partial<MaintenanceOccupancy>): MaintenanceWriteGate {
  let occupancy: MaintenanceOccupancy = {
    state: 'idle', operation: null, operationId: null, owner: null, hostInstanceId: null,
    fence: 0, acquiredAtUtcMs: null, blockedReason: null, ...initial,
  };
  const read = (): MaintenanceOccupancy => ({ ...occupancy });
  return Object.freeze({
    read,
    acquire(input: AcquireMaintenanceInput): MaintenanceLease {
      const operation = validOperation(input.operation);
      const operationId = validId(input.operationId, 'operationId');
      const owner = validId(input.owner, 'owner');
      const hostInstanceId = validId(input.hostInstanceId, 'hostInstanceId');
      const now = validNow(input.nowUtcMs);
      if (occupancy.state !== 'idle') conflict(occupancy.state === 'blocked' ? 'maintenance_blocked' : 'maintenance_in_progress', occupancy);
      const fence = occupancy.fence + 1;
      occupancy = { state: 'held', operation, operationId, owner, hostInstanceId, fence, acquiredAtUtcMs: now, blockedReason: null };
      return { operation, operationId, owner, hostInstanceId, fence };
    },
    release(input: ReleaseMaintenanceInput): MaintenanceOccupancy {
      const operation = validOperation(input.operation);
      if (occupancy.state === 'idle') return read();
      if (occupancy.operation !== operation || occupancy.operationId !== input.operationId
        || occupancy.owner !== input.owner || occupancy.hostInstanceId !== input.hostInstanceId
        || occupancy.fence !== input.fence) {
        conflict('stale_maintenance_owner', occupancy);
      }
      validId(input.operationId, 'operationId'); validId(input.owner, 'owner'); validId(input.hostInstanceId, 'hostInstanceId');
      if (occupancy.state === 'blocked' && input.confirmed) conflict('blocked_requires_new_host_recovery', occupancy);
      if (!input.confirmed) {
        occupancy = { ...occupancy, state: 'blocked', blockedReason: validId(input.reason ?? 'cleanup_unconfirmed', 'reason') };
      } else {
        occupancy = { state: 'idle', operation: null, operationId: null, owner: null, hostInstanceId: null,
          fence: occupancy.fence, acquiredAtUtcMs: null, blockedReason: null };
      }
      return read();
    },
    assertCanWrite(kind: MaintenanceWriteKind): void {
      if (!(MAINTENANCE_WRITE_KINDS as readonly string[]).includes(kind)) throw new TypeError('维护写入类别非法');
      if (occupancy.state !== 'idle') conflict(occupancy.state === 'blocked' ? 'maintenance_blocked' : 'maintenance_in_progress', occupancy);
    },
  });
}

export function assertMaintenanceLease(input: unknown): asserts input is MaintenanceLease {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('维护租约非法');
  const value = input as Record<string, unknown>;
  validOperation(value.operation); validId(value.operationId, 'operationId'); validId(value.owner, 'owner');
  validId(value.hostInstanceId, 'hostInstanceId');
  if (!Number.isSafeInteger(value.fence) || Number(value.fence) < 1) throw new TypeError('维护租约 fence 非法');
}
