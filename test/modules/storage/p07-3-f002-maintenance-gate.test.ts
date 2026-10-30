import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceWriteGate } from '../../../packages/core/src/ports/data-maintenance.ts';
import { createSqliteMaintenanceWriteGate } from '../../../packages/core/src/adapters/sqlite/data-maintenance.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createMaintenanceController } from '../../../packages/host/src/runtime/maintenance.ts';
import type { HostActivityGate } from '../../../packages/host/src/runtime/host-stop.ts';

const now = 1_900_000_300_000;
const leaseInput = {
  operation: 'backup' as const,
  operationId: 'backup-1',
  owner: 'owner-1',
  hostInstanceId: 'host-1',
  nowUtcMs: now,
};

function barrierGate(): { gate: HostActivityGate; release: () => void; calls: string[] } {
  let resolve: (() => void) | undefined;
  const calls: string[] = [];
  const pending = new Promise<void>(r => { resolve = r; });
  return {
    calls,
    release: () => resolve?.(),
    gate: {
      enterQuiesce() { calls.push('enter'); return { accepted: 1 }; },
      async awaitQuiesce() { calls.push('await'); await pending; calls.push('confirmed'); return { confirmed: true, pending: [] }; },
    },
  };
}

describe('P07-3 F-002 maintenance fencing and quiesce gate', () => {
  it('[case:maintenance-write-fence] blocks every mutating class and preserves uncertain cleanup as blocked', () => {
    const gate = createMaintenanceWriteGate();
    const lease = gate.acquire(leaseInput);
    for (const kind of ['planning', 'baseline', 'work', 'verification', 'git', 'recording', 'configuration', 'artifact', 'cleanup'] as const) {
      expect(() => gate.assertCanWrite(kind)).toThrowError(expect.objectContaining({ kind: 'busy' }));
    }
    expect(gate.release({ ...lease, confirmed: false, reason: 'cleanup_unconfirmed' })).toMatchObject({ state: 'blocked', blockedReason: 'cleanup_unconfirmed' });
    expect(() => gate.acquire({ ...leaseInput, operationId: 'backup-2' })).toThrowError(expect.objectContaining({ kind: 'busy' }));
  });

  it('[case:maintenance-quiesce-before-occupancy] waits for accepted activity before acquiring the durable lease', async () => {
    const barrier = barrierGate();
    const writeGate = createMaintenanceWriteGate();
    const controller = createMaintenanceController({ activityGate: barrier.gate, writeGate, quiesceBudgetMs: 100 });
    let settled = false;
    const acquiring = controller.acquire(leaseInput).then(lease => { settled = true; return lease; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(barrier.calls).toEqual(['enter', 'await']);
    expect(writeGate.read().state).toBe('idle');
    barrier.release();
    const lease = await acquiring;
    expect(settled).toBe(true);
    expect(barrier.calls).toEqual(['enter', 'await', 'confirmed']);
    expect(lease.fence).toBe(1);
    await controller.release({ ...lease, confirmed: true });
    expect(writeGate.read().state).toBe('idle');
  });

  it('[case:maintenance-sqlite-fence-persists] persists the holder and refuses a second host without expiry or PID assumptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shiploop-p073-f002-'));
    const path = join(root, 'core.sqlite');
    const first = openSqliteStorageSession({ path });
    const second = openSqliteStorageSession({ path });
    try {
      await migrateSqliteStorage(first);
      const firstGate = createSqliteMaintenanceWriteGate(first);
      const secondGate = createSqliteMaintenanceWriteGate(second);
      const lease = firstGate.acquire(leaseInput);
      expect(secondGate.read()).toMatchObject({ state: 'held', operationId: leaseInput.operationId, fence: 1 });
      expect(() => secondGate.acquire({ ...leaseInput, owner: 'owner-2', hostInstanceId: 'host-2', operationId: 'backup-2' }))
        .toThrowError(expect.objectContaining({ kind: 'busy' }));
      expect(() => secondGate.assertCanWrite('work')).toThrowError(expect.objectContaining({ kind: 'busy' }));
      expect(firstGate.release({ ...lease, confirmed: false, reason: 'old_writer_unknown' })).toMatchObject({ state: 'blocked' });
      expect(() => secondGate.acquire({ ...leaseInput, owner: 'owner-2', hostInstanceId: 'host-2', operationId: 'backup-2' }))
        .toThrowError(expect.objectContaining({ kind: 'busy' }));
      expect(() => firstGate.release({ ...lease, hostInstanceId: 'host-2', confirmed: true })).toThrowError(expect.objectContaining({ kind: 'busy' }));
    } finally {
      second.close();
      first.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
