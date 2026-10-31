/**
 * P07-4 / F-008：默认 Host 通知生命周期接线（真实临时数据根 / 真实锁 / 真实监听）。
 *
 * 覆盖：
 * - 默认启动：Host 在锁 + Schema + 恢复核对后自动启动本地通知服务；测试只提交
 *   事件事实（不手动启动消费者、不插入 delivery），积压被扫描并投递；通知活动
 *   不创建 Run/Attempt（仅恢复通知，不恢复业务执行）；
 * - 关闭重开续投：失败通知保留发送次数与回执；重开后到期 delivery 续投成功，
 *   不重复创建 delivery；
 * - 发送中停止与关闭超时：在途发送使 quiesce 有限预算内未确认 → close 拒绝并
 *   保留 in_flight 现场与锁；发送收尾后重试 close 成功、状态库关闭、锁释放
 *   （以同根再次成功启动为外部证据）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHostProtocolError, startHost, type HostStartOptions, type RunningHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { NotificationChannel } from '../../../packages/core/src/ports/notification-delivery.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/index.ts';

const EMPTY_CATALOG = createStaticRuntimeCapabilityCatalog([]);
/** 项目 ID 必须是 UUID v4（mapStateEvent 公开契约校验 event.projectId）。 */
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001';

function baseOptions(dataRoot: string, extra: Partial<HostStartOptions> = {}): HostStartOptions {
  return { dataRoot, capabilityCatalog: EMPTY_CATALOG, env: {}, ...extra };
}

function openFacts(path: string): SqliteStorageSession {
  return openSqliteStorageSession({ path, busyTimeoutMs: 2_000, busyRetryAttempts: 8 });
}

function seedTerminalEvent(db: SqliteStorageSession['database'], sequence: number): void {
  const row = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(PROJECT_ID);
  if (row === undefined) {
    db.prepare(
      "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, 'active', NULL, '[]')",
    ).run(PROJECT_ID, Date.now(), Date.now(), 'F008 Host 通知');
  }
  db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  ).run(
    randomUUID(), Date.now(), Date.now(), PROJECT_ID, sequence, 'task.terminal', 'task', `task-${sequence}`,
    JSON.stringify({ schemaVersion: 1, status: 'failed', resultCategory: 'runtime_failed', attemptId: `attempt-${sequence}`, runId: `run-${sequence}`, resultRef: `verification-${sequence}` }),
    Date.now(),
  );
}

interface DeliveryRow { id: string; project_id: string; status: string; attempt_count: number; next_attempt_at: number }

function deliveryRows(db: SqliteStorageSession['database']): DeliveryRow[] {
  return db.prepare('SELECT id, project_id, status, attempt_count, next_attempt_at FROM notification_deliveries ORDER BY created_at, id').all() as DeliveryRow[];
}

function resultRows(db: SqliteStorageSession['database']): Array<{ delivery_id: string; attempt: number; outcome: string }> {
  return db.prepare('SELECT delivery_id, attempt, outcome FROM notification_delivery_results ORDER BY created_at, id').all() as Array<{ delivery_id: string; attempt: number; outcome: string }>;
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function closeQuietly(host: RunningHost | undefined): Promise<void> {
  if (host === undefined) return;
  try { await host.close(); } catch { /* 已由用例断言失败路径 */ }
}

describe('P07-4 / F-008 默认 Host 通知生命周期', () => {
  it('[case:host-default-startup-backlog] 自动启动通知服务扫描积压，不创建业务执行；close 后锁释放', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-p07-4-f008-start-' });
    let host: RunningHost | undefined;
    let facts: SqliteStorageSession | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('start');
      const databasePath = join(canonicalRoot, 'core.sqlite');
      host = await startHost(baseOptions(canonicalRoot));
      expect(host.lifecycleState).toBe('ready');
      expect(host.core.notificationRuntime.state().started).toBe(true);

      facts = openFacts(databasePath);
      seedTerminalEvent(facts.database, 1);
      seedTerminalEvent(facts.database, 2);
      await waitFor('积压事件被投递', () => deliveryRows(facts!.database).length === 2 && deliveryRows(facts!.database).every(row => row.status === 'delivered'));
      expect(resultRows(facts.database)).toHaveLength(2);
      // 通知活动不创建 Run/Attempt，不恢复业务执行。
      expect(facts.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
      expect(facts.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toMatchObject({ n: 0 });
      facts.close();
      facts = undefined;

      await host.close();
      host = undefined;
      // 锁已释放：同根再次成功启动并正常关闭。
      const second = await startHost(baseOptions(canonicalRoot));
      try {
        expect(second.lifecycleState).toBe('ready');
        expect(second.core.notificationRuntime.state().started).toBe(true);
      } finally { await second.close(); }
    } finally {
      await closeQuietly(host);
      facts?.close();
      env.dispose();
    }
  });

  it('[case:host-restart-continuation] 关闭重开后续投到期 delivery，保留发送次数与回执且不重复创建', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-p07-4-f008-restart-' });
    let host: RunningHost | undefined;
    let facts: SqliteStorageSession | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('restart');
      const databasePath = join(canonicalRoot, 'core.sqlite');
      const failing: NotificationChannel = {
        channelId: 'local-results',
        async send() { throw new Error('channel down'); },
        async cancel() { return true; },
      };
      host = await startHost(baseOptions(canonicalRoot, { notificationChannels: [failing] }));
      facts = openFacts(databasePath);
      seedTerminalEvent(facts.database, 1);
      await waitFor('失败通知进入有界重试', () => deliveryRows(facts!.database).some(row => row.status === 'retry_scheduled'));
      const failedRow = deliveryRows(facts.database)[0];
      expect(failedRow.attempt_count).toBe(1);
      expect(resultRows(facts.database)).toHaveLength(1);
      expect(resultRows(facts.database)[0]).toMatchObject({ attempt: 1, outcome: 'failed' });
      const firstResultCount = resultRows(facts.database).length;
      facts.close();
      facts = undefined;
      await host.close();
      host = undefined;

      // 模拟退避时间流逝：把下次尝试时间改为已到期（不插入/修改 delivery 身份；
      // 约束 next_attempt_at >= created_at，故用 created_at 本身作为到期时刻）。
      facts = openFacts(databasePath);
      facts.database.prepare('UPDATE notification_deliveries SET next_attempt_at = created_at WHERE id = ?').run(failedRow.id);
      facts.close();
      facts = undefined;

      host = await startHost(baseOptions(canonicalRoot));
      facts = openFacts(databasePath);
      await waitFor('重开后续投成功', () => deliveryRows(facts!.database)[0]?.status === 'delivered');
      const rows = deliveryRows(facts.database);
      expect(rows).toHaveLength(1);
      expect(rows[0].attempt_count).toBe(2);
      const receipts = resultRows(facts.database);
      expect(receipts).toHaveLength(firstResultCount + 1);
      expect(receipts.find(r => r.attempt === 1)?.outcome).toBe('failed');
      expect(receipts.find(r => r.attempt === 2)?.outcome).toBe('succeeded');
    } finally {
      await closeQuietly(host);
      facts?.close();
      env.dispose();
    }
  });

  it('[case:host-stop-during-send-close-timeout] 在途发送使 close 未确认并保留现场；收尾后重试成功且锁释放', async () => {
    const env = createIsolatedHostEnvironment({ prefix: 'shiploop-p07-4-f008-stop-' });
    let host: RunningHost | undefined;
    let facts: SqliteStorageSession | undefined;
    let releaseSend: (() => void) | undefined;
    try {
      const { canonicalRoot } = env.dataRoot('stop');
      const databasePath = join(canonicalRoot, 'core.sqlite');
      const hanging: NotificationChannel = {
        channelId: 'local-results',
        send: () => new Promise(resolve => { releaseSend = () => resolve({ channelId: 'local-results', released: true }); }),
        async cancel() { return true; },
      };
      host = await startHost(baseOptions(canonicalRoot, { notificationChannels: [hanging], quiesceBudgetMs: 300 }));
      facts = openFacts(databasePath);
      seedTerminalEvent(facts.database, 1);
      await waitFor('发送在途（in_flight）', () => deliveryRows(facts!.database).some(row => row.status === 'in_flight'));

      // 关闭超时：有限预算内未确认 → 拒绝关闭并保留现场（quiescing、in_flight、锁）。
      let closeError: unknown;
      try { await host.close(); } catch (error) { closeError = error; }
      expect(isHostProtocolError(closeError)).toBe(true);
      expect((closeError as { details?: { reasonCode?: string } }).details?.reasonCode).toBe('quiesce_not_confirmed');
      expect(host.lifecycleState).toBe('quiescing');
      expect(deliveryRows(facts.database)[0].status).toBe('in_flight');
      facts.close();
      facts = undefined;

      // 发送收尾后重试关闭：确认通知不再写入 → 关库 → 清理 → 释锁。
      releaseSend!();
      await waitFor('在途发送结果持久化', () => {
        facts ??= openFacts(databasePath);
        return deliveryRows(facts.database)[0]?.status === 'delivered';
      });
      await host.close();
      host = undefined;

      // 锁释放的外部证据：同根再次成功启动。
      const second = await startHost(baseOptions(canonicalRoot));
      try { expect(second.lifecycleState).toBe('ready'); }
      finally { await second.close(); }
    } finally {
      await closeQuietly(host);
      facts?.close();
      env.dispose();
    }
  });
});
