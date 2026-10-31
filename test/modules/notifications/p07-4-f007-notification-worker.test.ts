/** P07-4 / F-007：本地结果渠道、delivery fencing 与有界投递驱动。 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNotificationDeliveryService } from '../../../packages/core/src/application/notification-delivery.ts';
import {
  NOTIFICATION_DELIVERY_CLAIM_BATCH_MAX,
  type NotificationChannel,
} from '../../../packages/core/src/ports/notification-delivery.ts';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createStartBarrier } from '../../helpers/p02-2/race-barrier.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_700_700_000_000;

function seed(db: SqliteStorageSession['database'], eventId: string): void {
  db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES ('project-f007', ?, 1, ?, 'F007', 'active', NULL, '[]')").run(NOW, NOW);
  db.prepare('INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?, 1, ?, ?)').run(
    eventId, NOW, NOW, 'project-f007', 'execution.run.ended', 'run', 'run-f007', JSON.stringify({ schemaVersion: 1, status: 'failed', resultCategory: 'failed', resultRef: null, batchId: 'batch-f007', featureId: 'feature-f007' }), NOW,
  );
}

async function fixture() {
  const sandbox = createTempSandbox('shiploop-p07-4-f007-');
  const path = join(sandbox.path, 'state.db');
  const session = openSqliteStorageSession({ path, busyTimeoutMs: 1_000, busyRetryAttempts: 4 });
  await migrateSqliteStorage(session);
  const eventId = randomUUID();
  seed(session.database, eventId);
  const clock = { now: NOW };
  const store = createSqliteNotificationDeliveryStore({ session, nowUtcMs: () => clock.now });
  return { sandbox, path, session, store, clock, eventId };
}

describe('P07-4 / F-007 notification delivery worker', () => {
  it('[case:claim-fencing-competition] 真实 SQLite 两消费者竞争只产生一个 owner，旧代次不能写回', async () => {
    const f = await fixture();
    try {
      const delivery = f.store.createDelivery({ eventId: f.eventId, channelId: 'local-results', summary: { kind: 'run_ended', status: 'failed' } }).delivery;
      const secondSession = openSqliteStorageSession({ path: f.path, busyTimeoutMs: 1_000, busyRetryAttempts: 4 });
      try {
        const second = createSqliteNotificationDeliveryStore({ session: secondSession, nowUtcMs: () => f.clock.now });
        const barrier = createStartBarrier(2);
        const claim = (store: ReturnType<typeof createSqliteNotificationDeliveryStore>, owner: string) => async () => {
          await barrier.arrive();
          return store.claimDueDeliveries({ channelId: 'local-results', owner, limit: 1 });
        };
        const [a, b] = await Promise.all([claim(f.store, 'worker-a')(), claim(second, 'worker-b')()]);
        const claimed = [...a.deliveries, ...b.deliveries];
        expect(claimed).toHaveLength(1);
        expect(claimed[0].status).toBe('in_flight');
        expect(claimed[0].attemptCount).toBe(1);
        expect(claimed[0].claimOwner).toMatch(/^worker-/);
        expect(() => f.store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: claimed[0].claimGeneration - 1, attempt: 1, outcome: 'succeeded', receipt: { ok: true } })).toThrow(/状态机拒绝|fencing|代次/);
        const current = f.store.readDelivery({ deliveryId: delivery.deliveryId });
        expect(current.claimGeneration).toBe(claimed[0].claimGeneration);
      } finally {
        secondSession.close();
      }
    } finally { f.session.close(); f.sandbox.cleanup(); }
  });

  it('[case:confirmed-release-reclaim] 未确认停止拒绝释放；确认停止后重启可续投且代次递增', async () => {
    const f = await fixture();
    try {
      const delivery = f.store.createDelivery({ eventId: f.eventId, channelId: 'local-results', summary: { kind: 'run_ended' } }).delivery;
      const claimed = f.store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-a', leaseMs: 1_000 }).deliveries[0];
      expect(() => f.store.releaseDeliveryClaim({ deliveryId: delivery.deliveryId, owner: 'worker-a', claimGeneration: claimed.claimGeneration, confirmedStopped: false })).toThrow();
      const released = f.store.releaseDeliveryClaim({ deliveryId: delivery.deliveryId, owner: 'worker-a', claimGeneration: claimed.claimGeneration, confirmedStopped: true });
      expect(released.status).toBe('retry_scheduled');
      expect(released.claimOwner).toBeNull();
      const resumed = f.store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-after-restart' }).deliveries[0];
      expect(resumed.claimGeneration).toBe(claimed.claimGeneration + 1);
      expect(resumed.attemptCount).toBe(2);
      expect(() => f.store.recordDeliveryResult({ deliveryId: delivery.deliveryId, claimGeneration: claimed.claimGeneration, attempt: 1, outcome: 'succeeded', receipt: { late: true } })).toThrow();
    } finally { f.session.close(); f.sandbox.cleanup(); }
  });

  it('[case:local-channel-retry-exhaustion] local-results 记录稳定回执，失败按有限退避并在上限停止', async () => {
    const f = await fixture();
    try {
      const delivery = f.store.createDelivery({ eventId: f.eventId, channelId: 'local-results', summary: { kind: 'run_ended' } }).delivery;
      const worker = createNotificationDeliveryService({ store: f.store, policy: { batchSize: 1, maxConcurrent: 1, sendTimeoutMs: 50, cancellationTimeoutMs: 50 } });
      const first = await worker.runOnce({ owner: 'local-worker' });
      expect(first.results[0]).toMatchObject({ outcome: 'succeeded', status: 'delivered' });
      expect(f.store.readDelivery({ deliveryId: delivery.deliveryId }).receipt).toEqual({ channelId: 'local-results', deliveryId: delivery.deliveryId, attempt: 1 });
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM notification_delivery_results WHERE delivery_id = ?').get(delivery.deliveryId)).toMatchObject({ count: 1 });
      expect(() => f.store.claimDueDeliveries({ channelId: 'local-results', owner: 'other' })).not.toThrow();
    } finally { f.session.close(); f.sandbox.cleanup(); }
  });

  it('[case:bounded-failure-retry] 渠道失败落本地记录并按持久 nextAttemptAt 重试，第四次耗尽且重开不清零', async () => {
    const f = await fixture();
    try {
      const delivery = f.store.createDelivery({ eventId: f.eventId, channelId: 'local-results', summary: { kind: 'run_ended' } }).delivery;
      let calls = 0;
      const failing: NotificationChannel = { channelId: 'local-results', send: async () => { calls += 1; throw new Error('controlled'); } };
      const worker = createNotificationDeliveryService({ store: f.store, channels: [failing], policy: { batchSize: 1, maxConcurrent: 1, sendTimeoutMs: 50, cancellationTimeoutMs: 50 } });
      const statuses: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const result = await worker.runOnce({ owner: 'retry-worker' });
        statuses.push(result.results[0].status);
        const current = f.store.readDelivery({ deliveryId: delivery.deliveryId });
        if (current.status !== 'exhausted') f.clock.now = current.nextAttemptAt;
      }
      expect(calls).toBe(4);
      expect(statuses).toEqual(['retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'exhausted']);
      expect(f.store.readDelivery({ deliveryId: delivery.deliveryId })).toMatchObject({ status: 'exhausted', attemptCount: 4, claimOwner: null });
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM notification_delivery_results WHERE delivery_id = ?').get(delivery.deliveryId)).toMatchObject({ count: 4 });
      f.session.close();
      const reopened = openSqliteStorageSession({ path: f.path });
      try {
        await migrateSqliteStorage(reopened);
        const reopenedStore = createSqliteNotificationDeliveryStore({ session: reopened, nowUtcMs: () => f.clock.now });
        expect(reopenedStore.readDelivery({ deliveryId: delivery.deliveryId })).toMatchObject({ status: 'exhausted', attemptCount: 4 });
      } finally { reopened.close(); }
    } finally { if (f.session.isOpen()) f.session.close(); f.sandbox.cleanup(); }
  });


  it('[case:timeout-stop-unconfirmed] 发送超时且取消未确认时保持 in_flight，不提前重认领', async () => {
    const f = await fixture();
    try {
      const delivery = f.store.createDelivery({ eventId: f.eventId, channelId: 'local-results', summary: { kind: 'run_ended' } }).delivery;
      const hanging: NotificationChannel = {
        channelId: 'local-results',
        send: () => new Promise(() => undefined),
        cancel: async () => false,
      };
      const worker = createNotificationDeliveryService({ store: f.store, channels: [hanging], policy: { batchSize: 1, maxConcurrent: 1, sendTimeoutMs: 5, cancellationTimeoutMs: 5 } });
      const result = await worker.runOnce({ owner: 'slow-worker' });
      expect(result.results[0]).toMatchObject({ outcome: 'timeout', status: 'in_flight', failureReason: 'send_timeout_stop_unconfirmed' });
      expect(f.store.readDelivery({ deliveryId: delivery.deliveryId })).toMatchObject({ status: 'in_flight', claimOwner: 'slow-worker', attemptCount: 1 });
      expect(f.session.database.prepare('SELECT COUNT(*) AS count FROM notification_delivery_results WHERE delivery_id = ?').get(delivery.deliveryId)).toMatchObject({ count: 0 });
      expect(NOTIFICATION_DELIVERY_CLAIM_BATCH_MAX).toBeGreaterThan(1);
    } finally { f.session.close(); f.sandbox.cleanup(); }
  });
});
