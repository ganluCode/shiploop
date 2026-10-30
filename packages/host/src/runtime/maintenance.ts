import { HostProtocolError, QUIESCE_BUDGET_MS } from '../contract/index.js';
import type {
  AcquireMaintenanceInput,
  MaintenanceLease,
  MaintenanceOperation,
  MaintenanceWriteGate,
  ReleaseMaintenanceInput,
} from 'shiploop-core';
import type { HostActivityGate } from './host-stop.js';

export interface MaintenanceController {
  acquire(input: AcquireMaintenanceInput): Promise<MaintenanceLease>;
  release(input: ReleaseMaintenanceInput): Promise<void>;
  read(): ReturnType<MaintenanceWriteGate['read']>;
}

export interface MaintenanceControllerOptions {
  readonly activityGate: HostActivityGate;
  readonly writeGate: MaintenanceWriteGate;
  readonly quiesceBudgetMs?: number;
  readonly resumeActivity?: () => void;
}

/**
 * Coordinates Host quiesce with the durable Core fencing row. The activity gate
 * closes new accepted work and waits for the exact in-flight count; only after
 * that confirmation is the SQLite occupancy acquired. File copying, migration
 * and long verification remain outside the SQLite transaction.
 */
export function createMaintenanceController(options: MaintenanceControllerOptions): MaintenanceController {
  const budgetMs = options.quiesceBudgetMs ?? QUIESCE_BUDGET_MS;
  if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > QUIESCE_BUDGET_MS) {
    throw new TypeError('维护 quiesce 预算非法');
  }
  let active: MaintenanceLease | null = null;
  return Object.freeze({
    async acquire(input: AcquireMaintenanceInput): Promise<MaintenanceLease> {
      if (active !== null) throw new HostProtocolError('resource_busy', 'commands.submit', '已有维护操作在进行', { details: { reason: 'maintenance_in_progress' } });
      const entry = options.activityGate.enterQuiesce();
      const outcome = await options.activityGate.awaitQuiesce(budgetMs);
      if (!outcome.confirmed) {
        throw new HostProtocolError('resource_busy', 'commands.submit', '活动未在有限预算内停止，保留隔离', {
          details: { reason: 'quiesce_not_confirmed', pendingCount: outcome.pending.length, accepted: entry.accepted },
        });
      }
      try {
        active = options.writeGate.acquire(input);
        return active;
      } catch (error) {
        options.resumeActivity?.();
        throw error;
      }
    },
    async release(input: ReleaseMaintenanceInput): Promise<void> {
      if (active === null) return;
      options.writeGate.release(input);
      active = null;
      if (input.confirmed) options.resumeActivity?.();
    },
    read() { return options.writeGate.read(); },
  });
}

export type { MaintenanceLease, MaintenanceOperation };
