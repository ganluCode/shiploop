/**
 * P07-4 / F-008：默认 Core 通知运行时——扫描、续投、有限关闭与门控。
 *
 * 覆盖（真实临时 SQLite；PRD FR-2、设计 04 §5、08 §6）：
 * - 默认轮次：投影（持久水位）+ 认领/发送（fencing）一轮完成；start 触发立即
 *   补扫、周期 tick 续扫；close 停止定时器且幂等；
 * - 丢失唤醒补偿：无任何内存唤醒调用，新提交事件由周期持久补扫生成 delivery；
 * - quiesce：enterQuiesce 停止新认领；在途发送有限等待，未确认时 confirmed=false
 *   且 close 拒绝（保库保现场）；发送收尾后确认并允许 close；
 * - 维护门控：维护占用期间通知写事务（投影/认领/结果）busy 拒绝，运行时跳过
 *   该轮并在释放后恢复；通知写入类别纳入维护门控词汇；
 * - 项目生命周期门控：归档/删除中的项目 delivery 不被认领（保持 pending），
 *   active 项目正常认领；
 * - 重启续投：重开 SQLite 后新运行时按持久水位继续，不重复创建 delivery，
 *   发送次数与回执保留。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNotificationDeliveryService, createLocalResultsChannel } from '../../../packages/core/src/application/notification-delivery.ts';
import { createNotificationProjectionService } from '../../../packages/core/src/application/notification-projection.ts';
import { createNotificationRuntime } from '../../../packages/core/src/application/notification-runtime.ts';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createMaintenanceWriteGate } from '../../../packages/core/src/ports/data-maintenance.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import type { NotificationChannel } from '../../../packages/core/src/ports/notification-delivery.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const NOW = 1_900_800_000_000;
/** 项目 ID 必须是 UUID v4（mapStateEvent 公开契约校验 event.projectId）。 */
function projectUuid(index: number): string {
  const suffix = String(index).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

interface ManualTimers {
  scheduled: { callback: () => void; delayMs: number } | null;
  timers: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** 触发当前已调度回调（同步执行；返回其结果由被调方自行异步收尾）。 */
  fire(): void;
}

function manualTimers(): ManualTimers {
  let current: { callback: () => void; delayMs: number } | null = null;
  let handle = 0;
  const timers = {
    setTimeout(callback: () => void, delayMs: number): unknown {
      handle += 1;
      current = { callback, delayMs };
      return handle;
    },
    clearTimeout(): void {
      current = null;
    },
  };
  return {
    timers,
    get scheduled() { return current; },
    fire() {
      const pending = current;
      current = null;
      if (pending !== null) pending.callback();
    },
  };
}

interface SeededEvent {
  readonly id: string;
  readonly sequence: number;
  readonly projectId: string;
  readonly payload: Record<string, unknown>;
}

function seedProject(db: SqliteStorageSession['database'], projectId: string, status = 'active'): void {
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, ?, NULL, '[]')",
  ).run(projectId, NOW, NOW, `项目 ${projectId}`, status);
}

function seedTerminalEvent(db: SqliteStorageSession['database'], event: SeededEvent): string {
  db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    event.id, NOW, NOW, event.projectId, event.sequence, 'task.terminal', 'task', `task-${event.sequence}`,
    JSON.stringify(event.payload), NOW,
  );
  return event.id;
}

function terminalPayload(): Record<string, unknown> {
  return { schemaVersion: 1, status: 'failed', resultCategory: 'runtime_failed', attemptId: `attempt-${randomUUID()}`, runId: `run-${randomUUID()}`, resultRef: `verification-${randomUUID()}` };
}

interface RuntimeFixture {
  readonly session: SqliteStorageSession;
  readonly store: ReturnType<typeof createSqliteNotificationDeliveryStore>;
  readonly gate: ReturnType<typeof createMaintenanceWriteGate>;
  close(): void;
}

async function openRuntimeFixture(prefix: string, options: { maintenanceGate?: boolean } = {}): Promise<RuntimeFixture & { readonly sandbox: ReturnType<typeof createTempSandbox>; readonly path: string }> {
  const sandbox = createTempSandbox(prefix);
  const path = join(sandbox.path, 'core.sqlite');
  const session = openSqliteStorageSession({ path, busyTimeoutMs: 1_000, busyRetryAttempts: 4 });
  await migrateSqliteStorage(session);
  const gate = createMaintenanceWriteGate();
  const store = createSqliteNotificationDeliveryStore({
    session,
    nowUtcMs: () => NOW,
    ...(options.maintenanceGate ? { maintenanceGate: gate } : {}),
  });
  return { sandbox, path, session, store, gate, close: () => session.close() };
}

function deliveries(db: SqliteStorageSession['database']): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM notification_deliveries ORDER BY event_sequence').all() as Array<Record<string, unknown>>;
}

function results(db: SqliteStorageSession['database']): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM notification_delivery_results ORDER BY created_at, id').all() as Array<Record<string, unknown>>;
}

describe('P07-4 / F-008 notification runtime（默认 Core 装配单元）', () => {
  it('[case:default-round-project-claim-deliver] start 触发立即补扫，一轮完成投影+认领+回执；close 幂等收回定时器', async () => {
    const f = await openRuntimeFixture('shiploop-p07-4-f008-default-');
    try {
      seedProject(f.session.database, projectUuid(11));
      seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(11), payload: terminalPayload() });
      const manual = manualTimers();
      const projection = createNotificationProjectionService({ store: f.store });
      const delivery = createNotificationDeliveryService({ store: f.store });
      const runtime = createNotificationRuntime({ projection, delivery, maintenanceGate: f.gate, intervalMs: 1_000, timers: manual.timers });

      expect(runtime.state().started).toBe(false);
      runtime.start();
      expect(runtime.state().started).toBe(true);
      // start 调度立即补扫（无固定 sleep 依赖：断言调度存在后手动触发）。
      expect(manual.scheduled).not.toBeNull();
      expect(manual.scheduled!.delayMs).toBe(0);
      manual.fire();
      await waitFor(() => runtime.state().roundsExecuted === 1);

      const rows = deliveries(f.session.database);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('delivered');
      expect(rows[0].attempt_count).toBe(1);
      const receipts = results(f.session.database);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].outcome).toBe('succeeded');
      // 轮次完成后按周期重新调度。
      expect(manual.scheduled).not.toBeNull();
      expect(manual.scheduled!.delayMs).toBe(1_000);

      runtime.close();
      expect(runtime.isClosed()).toBe(true);
      expect(manual.scheduled).toBeNull();
      runtime.close();
      expect(runtime.isClosed()).toBe(true);
      // close 后 tick 不再产生任何写入。
      const before = deliveries(f.session.database).length + results(f.session.database).length;
      manual.fire();
      await new Promise(resolve => setImmediate(resolve));
      expect(deliveries(f.session.database).length + results(f.session.database).length).toBe(before);
      expect(runtime.state().roundsExecuted).toBe(1);
    } finally { f.close(); f.sandbox.cleanup(); }
  });

  it('[case:lost-wake-periodic-rescan] 无内存唤醒调用，周期持久补扫补偿丢失唤醒', async () => {
    const f = await openRuntimeFixture('shiploop-p07-4-f008-rescan-');
    try {
      seedProject(f.session.database, projectUuid(21));
      seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(21), payload: terminalPayload() });
      const manual = manualTimers();
      const runtime = createNotificationRuntime({
        projection: createNotificationProjectionService({ store: f.store }),
        delivery: createNotificationDeliveryService({ store: f.store }),
        maintenanceGate: f.gate,
        intervalMs: 1_000,
        timers: manual.timers,
      });
      runtime.start();
      manual.fire();
      await waitFor(() => runtime.state().roundsExecuted === 1);
      expect(deliveries(f.session.database)).toHaveLength(1);

      // 第一轮之后新提交的事件：不调用 wake，仅靠下一轮持久补扫发现。
      seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 2, projectId: projectUuid(21), payload: terminalPayload() });
      expect(runtime.state().roundsExecuted).toBe(1);
      manual.fire();
      await waitFor(() => runtime.state().roundsExecuted === 2);
      const rows = deliveries(f.session.database);
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.status === 'delivered')).toBe(true);
      // 水位推进持久化：重复轮次不重复创建 delivery。
      manual.fire();
      await waitFor(() => runtime.state().roundsExecuted === 3);
      expect(deliveries(f.session.database)).toHaveLength(2);
      runtime.close();
    } finally { f.close(); f.sandbox.cleanup(); }
  });

  it('[case:quiesce-bounded-wait-close-guard] 在途发送有限等待；未确认拒绝 close 并保留 in_flight 现场', async () => {
    const f = await openRuntimeFixture('shiploop-p07-4-f008-quiesce-');
    try {
      seedProject(f.session.database, projectUuid(31));
      const eventId = seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(31), payload: terminalPayload() });
      let releaseSend: (() => void) | undefined;
      const hangingChannel: NotificationChannel = {
        channelId: 'local-results',
        send: () => new Promise(resolve => { releaseSend = () => resolve({ channelId: 'local-results', released: true }); }),
        cancel: async () => true,
      };
      const runtime = createNotificationRuntime({
        projection: createNotificationProjectionService({ store: f.store }),
        delivery: createNotificationDeliveryService({ store: f.store, channels: [hangingChannel] }),
        maintenanceGate: f.gate,
        intervalMs: 1_000,
      });
      runtime.start();
      await waitFor(() => deliveries(f.session.database).some(row => row.status === 'in_flight'));

      const entry = runtime.enterQuiesce();
      expect(entry.accepted).toBe(1);
      expect(runtime.state().quiescing).toBe(true);

      const bounded = await runtime.awaitQuiesce(50);
      expect(bounded.confirmed).toBe(false);
      expect(bounded.pending.length).toBeGreaterThan(0);
      // 未确认时 close 拒绝：数据库保持打开，in_flight 现场保留。
      expect(() => runtime.close()).toThrow(/通知/);
      expect(runtime.isClosed()).toBe(false);
      expect(deliveries(f.session.database)[0].status).toBe('in_flight');

      releaseSend!();
      const settled = await runtime.awaitQuiesce(5_000);
      expect(settled.confirmed).toBe(true);
      runtime.close();
      expect(runtime.isClosed()).toBe(true);
      // 在途发送收尾后结果持久化：成功回执 + delivered。
      const row = deliveries(f.session.database)[0];
      expect(row.status).toBe('delivered');
      expect(row.event_id).toBe(eventId);
      expect(results(f.session.database)).toHaveLength(1);
    } finally { f.close(); f.sandbox.cleanup(); }
  });

  it('[case:maintenance-gating] 维护占用期间运行时跳过轮次且写事务 busy 拒绝；释放后恢复', async () => {
    const f = await openRuntimeFixture('shiploop-p07-4-f008-maint-', { maintenanceGate: true });
    try {
      seedProject(f.session.database, projectUuid(41));
      const eventId = seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(41), payload: terminalPayload() });
      const runtime = createNotificationRuntime({
        projection: createNotificationProjectionService({ store: f.store }),
        delivery: createNotificationDeliveryService({ store: f.store, channels: [createLocalResultsChannel()] }),
        maintenanceGate: f.gate,
        intervalMs: 1_000,
      });
      const lease = f.gate.acquire({ operation: 'backup', operationId: 'backup-f008', owner: 'owner-f008', hostInstanceId: 'host-f008', nowUtcMs: NOW });
      const skipped = await runtime.runOnce();
      expect(skipped.skipped).toBe(true);
      expect(skipped.skipReason).toBe('maintenance');
      expect(runtime.state().roundsExecuted).toBe(0);
      expect(deliveries(f.session.database)).toHaveLength(0);
      // 维护期间的直连写事务同样被维护门控拒绝（一致性快照不被通知写入破坏）。
      let busy: unknown;
      try { f.store.createDelivery({ eventId, channelId: 'local-results', summary: { kind: 'task_terminal' } }); }
      catch (error) { busy = error; }
      expect(isStorageError(busy, 'busy')).toBe(true);
      try { f.store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-direct' }); }
      catch (error) { busy = error; }
      expect(isStorageError(busy, 'busy')).toBe(true);

      f.gate.release({ ...lease, confirmed: true });
      const resumed = await runtime.runOnce();
      expect(resumed.skipped).toBe(false);
      expect(resumed.deliveriesCreated).toBe(1);
      await waitFor(() => deliveries(f.session.database)[0]?.status === 'delivered');
      runtime.close();
    } finally { f.close(); f.sandbox.cleanup(); }
  });

  it('[case:project-lifecycle-claim-filter] 归档/删除中的项目 delivery 不被认领，active 正常认领', async () => {
    const f = await openRuntimeFixture('shiploop-p07-4-f008-lifecycle-');
    try {
      seedProject(f.session.database, projectUuid(51), 'active');
      seedProject(f.session.database, projectUuid(52), 'archived');
      seedProject(f.session.database, projectUuid(53), 'deleting');
      const activeEvent = seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(51), payload: terminalPayload() });
      const archivedEvent = seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 2, projectId: projectUuid(52), payload: terminalPayload() });
      const deletingEvent = seedTerminalEvent(f.session.database, { id: randomUUID(), sequence: 3, projectId: projectUuid(53), payload: terminalPayload() });
      // 投影为禁止投递目标创建的 delivery 保留事实行，但认领被项目状态过滤。
      const projected = f.store.projectNotificationBatch({ channelId: 'local-results' });
      expect(projected.createdDeliveries).toHaveLength(3);
      const claimed = f.store.claimDueDeliveries({ channelId: 'local-results', owner: 'worker-filter', limit: 10 });
      expect(claimed.deliveries).toHaveLength(1);
      expect(claimed.deliveries[0].projectId).toBe(projectUuid(51));
      const byProject = new Map(deliveries(f.session.database).map(row => [row.project_id as string, row]));
      expect(byProject.get(projectUuid(51))?.status).toBe('in_flight');
      expect(byProject.get(projectUuid(52))?.status).toBe('pending');
      expect(byProject.get(projectUuid(53))?.status).toBe('pending');
      expect(byProject.get(projectUuid(51))?.event_id).toBe(activeEvent);
      expect(byProject.get(projectUuid(52))?.event_id).toBe(archivedEvent);
      expect(byProject.get(projectUuid(53))?.event_id).toBe(deletingEvent);
    } finally { f.close(); f.sandbox.cleanup(); }
  });

  it('[case:reopen-continuation] 重开后按持久水位续扫，不重复创建 delivery，次数与回执保留', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f008-reopen-');
    const path = join(sandbox.path, 'core.sqlite');
    const first = openSqliteStorageSession({ path, busyTimeoutMs: 1_000, busyRetryAttempts: 4 });
    try {
      await migrateSqliteStorage(first);
      seedProject(first.database, projectUuid(61));
      seedTerminalEvent(first.database, { id: randomUUID(), sequence: 1, projectId: projectUuid(61), payload: terminalPayload() });
      const store = createSqliteNotificationDeliveryStore({ session: first, nowUtcMs: () => NOW });
      const runtime = createNotificationRuntime({
        projection: createNotificationProjectionService({ store }),
        delivery: createNotificationDeliveryService({ store, channels: [createLocalResultsChannel()] }),
      });
      const round = await runtime.runOnce();
      expect(round.deliveriesCreated).toBe(1);
      await waitFor(() => deliveries(first.database)[0]?.status === 'delivered');
      runtime.close();
      first.close();

      // 重开：新会话 + 新运行时（新 owner），按持久水位续扫。
      const second = openSqliteStorageSession({ path, busyTimeoutMs: 1_000, busyRetryAttempts: 4 });
      try {
        const store2 = createSqliteNotificationDeliveryStore({ session: second, nowUtcMs: () => NOW });
        const runtime2 = createNotificationRuntime({
          projection: createNotificationProjectionService({ store: store2 }),
          delivery: createNotificationDeliveryService({ store: store2, channels: [createLocalResultsChannel()] }),
        });
        const replay = await runtime2.runOnce();
        expect(replay.skipped).toBe(false);
        expect(replay.deliveriesCreated).toBe(0);
        expect(replay.deliveriesClaimed).toBe(0);
        const rows = deliveries(second.database);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('delivered');
        expect(rows[0].attempt_count).toBe(1);
        expect(results(second.database)).toHaveLength(1);
        runtime2.close();
      } finally { second.close(); }
    } finally { sandbox.cleanup(); }
  });
});

/** 有界条件等待：超时失败，不用固定 sleep 冒充断言。 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
