/**
 * P07-4 / F-006：持久 state_events → 脱敏 notification delivery 的有界幂等投影。
 *
 * 覆盖（真实临时 SQLite，非 mock；纯契约部分不触库；PRD FR-2、设计 03 §5、07 §5）：
 * - 订阅注册表与请求校验：默认订阅 = Task 终态 + 设计 07 §5 默认（Feature 完成、
 *   Run 结束、失败和需人处理）；批大小默认/上限（1..500）与未知渠道在写入前拒绝；
 * - 脱敏摘要派生：只含冻结 kind、固定身份、结果类别、安全枚举与查询引用；
 *   非订阅事件（含 execution.batch.ended、attempt 更新、Run 取消）派生 null，
 *   扫描位置照常推进且不产生 delivery；不复制 payload 原文/错误正文/路径；
 * - 同一短事务：delivery 创建与消费水位推进原子完成；同一 (eventId,channelId)
 *   重复扫描/水位回退重放/双投影者屏障竞争只保留一条 delivery；
 * - 崩溃窗口：delivery 插入失败（触发器注入）整体回滚、水位不动；提交后未唤醒/
 *   重开真实 SQLite 补扫不漏通知、不重复创建；空批次零写入；
 * - 有界积压：批大小与每轮批次数有上限，按持久水位分批，不建无界内存队列；
 * - 损坏事件（未知类型/未知 payload 版本）与水位超前事件日志显式进入可诊断
 *   状态（corrupt、带 sequence 定位、不回显原文），不静默越过；
 * - 真实结算事件（budget fixture 的 execution.run.ended/execution.batch.ended）
 *   投影后不创建 Run/Attempt、不改变 Task/预算/检查结果。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_DELIVERY_POLICY,
  NOTIFICATION_PROJECTION_BATCH_DEFAULT,
  NOTIFICATION_PROJECTION_BATCH_MAX,
  NOTIFICATION_SUBSCRIPTION_EVENT_TYPES,
  computeNotificationPolicyDigest,
  deriveNotificationSummary,
  validateNotificationProjectionBatchRequest,
  type NotificationDeliveryRecord,
} from '../../../packages/core/src/ports/notification-delivery.ts';
import type { PublicStateEvent } from '../../../packages/core/src/ports/events.ts';
import { createSqliteNotificationDeliveryStore } from '../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { createNotificationProjectionService } from '../../../packages/core/src/application/notification-projection.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { createStartBarrier } from '../../helpers/p02-2/race-barrier.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { openBudgetFixture, BUDGET, NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';

const NOW_MS = 1_900_200_000_000;
const CHANNEL = 'local-results';
const PROJ_A = '12345678-1234-4123-8234-1234567890ab';
const PROJ_B = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';

/** 校验类错误断言：定位字段与 reason，避免只看错误文本。 */
function expectValidation(error: unknown, field: string, reason: string): void {
  expect(isStorageError(error, 'validation'), `必须是校验错误：${String(error)}`).toBe(true);
  const details = (error as { details?: { field?: string; reason?: string } }).details;
  expect(details?.field).toBe(field);
  expect(details?.reason).toBe(reason);
}

/* ------------------------------------------------------------------ *
 * 种子事件（直接 SQL，与 F-003/F-004 矩阵同一方式；形状遵守 §9.2 白名单）
 * ------------------------------------------------------------------ */

interface SeededEvent {
  readonly id?: string;
  readonly sequence: number;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly projectId: string | null;
  readonly payload: Record<string, unknown>;
}

function seedProjects(db: SqliteStorageSession['database'], now = NOW_MS): void {
  const insert = db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES (?, ?, 1, ?, ?, 'active', NULL, '[]')",
  );
  insert.run(PROJ_A, now, now, '通知项目');
  insert.run(PROJ_B, now, now, '项目 B');
}

function seedEvents(db: SqliteStorageSession['database'], events: readonly SeededEvent[], now = NOW_MS): void {
  const insert = db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  );
  for (const event of events) {
    insert.run(event.id ?? randomUUID(), now, now, event.projectId, event.sequence, event.type,
      event.aggregateType, event.aggregateId, JSON.stringify(event.payload), now);
  }
}

/** 8 个混合事件：seq 2/3/5/6/7 为订阅事件，1/4/8 为非订阅事件。 */
function mixedEvents(): SeededEvent[] {
  return [
    { sequence: 1, type: 'task.attempt.updated', aggregateType: 'task', aggregateId: 'task-0', projectId: PROJ_A, payload: { updated: true } },
    { sequence: 2, type: 'task.terminal', aggregateType: 'task', aggregateId: 'task-1', projectId: PROJ_A,
      payload: { schemaVersion: 1, status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-1', runId: 'run-1', resultRef: 'verification-1' } },
    { sequence: 3, type: 'execution.run.ended', aggregateType: 'run', aggregateId: 'run-1', projectId: PROJ_A,
      payload: { schemaVersion: 1, status: 'failed', resultCategory: 'failed', resultRef: 'settle-1', batchId: 'batch-1', featureId: 'feature-1' } },
    { sequence: 4, type: 'execution.batch.ended', aggregateType: 'execution_batch', aggregateId: 'batch-1', projectId: PROJ_A,
      payload: { schemaVersion: 1, status: 'failed', resultCategory: 'budget_exhausted', resultRef: 'settle-1', batchId: 'batch-1', featureId: 'feature-1' } },
    { sequence: 5, type: 'task.action_required', aggregateType: 'task', aggregateId: 'task-2', projectId: PROJ_A,
      payload: { schemaVersion: 1, action: 'manual_review', itemId: 'item-1', reason: 'approval_required' } },
    { sequence: 6, type: 'feature.finalized', aggregateType: 'feature', aggregateId: 'feature-1', projectId: PROJ_A,
      payload: { schemaVersion: 1, outcome: 'complete', deliveryStatus: 'succeeded', reasonCode: 'delivered', runId: 'run-1', batchId: 'batch-1', operationId: 'gitop-1' } },
    { sequence: 7, type: 'feature.finalization_blocked', aggregateType: 'feature', aggregateId: 'feature-2', projectId: PROJ_B,
      payload: { schemaVersion: 1, outcome: 'partial', deliveryStatus: 'not_requested', reasonCode: 'verification_failed', runId: 'run-2', batchId: 'batch-2', operationId: null } },
    { sequence: 8, type: 'execution.run.cancelled', aggregateType: 'run', aggregateId: 'run-9', projectId: PROJ_A, payload: { cancelled: true } },
  ];
}

const EXPECTED_SUMMARIES: Record<number, Record<string, unknown>> = {
  2: { schemaVersion: 1, kind: 'task_terminal', taskId: 'task-1', status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-1', runId: 'run-1', resultRef: 'verification-1' },
  3: { schemaVersion: 1, kind: 'run_ended', runId: 'run-1', status: 'failed', resultCategory: 'failed', resultRef: 'settle-1', batchId: 'batch-1', featureId: 'feature-1' },
  5: { schemaVersion: 1, kind: 'task_action_required', taskId: 'task-2', action: 'manual_review', itemId: 'item-1', reason: 'approval_required' },
  6: { schemaVersion: 1, kind: 'feature_finalized', featureId: 'feature-1', outcome: 'complete', deliveryStatus: 'succeeded', reasonCode: 'delivered', runId: 'run-1', batchId: 'batch-1', operationId: 'gitop-1' },
  7: { schemaVersion: 1, kind: 'feature_finalization_blocked', featureId: 'feature-2', outcome: 'partial', deliveryStatus: 'not_requested', reasonCode: 'verification_failed', runId: 'run-2', batchId: 'batch-2', operationId: null },
};

interface ProjectionHarness {
  readonly session: SqliteStorageSession;
  readonly store: ReturnType<typeof createSqliteNotificationDeliveryStore>;
  readonly service: ReturnType<typeof createNotificationProjectionService>;
  readonly path: string;
  close(): void;
}

function openProjectionHarness(dbPath: string): ProjectionHarness {
  const session = openSqliteStorageSession({ path: dbPath });
  const store = createSqliteNotificationDeliveryStore({ session, nowUtcMs: () => NOW_MS + 1_000 });
  const service = createNotificationProjectionService({ store });
  return { session, store, service, path: dbPath, close: () => session.close() };
}

async function withProjectionHarness(
  events: readonly SeededEvent[],
  fn: (harness: ProjectionHarness) => Promise<void> | void,
): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p07-4-f006-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const harness = openProjectionHarness(dbPath);
    try {
      await migrateSqliteStorage(harness.session);
      seedProjects(harness.session.database);
      seedEvents(harness.session.database, events);
      await fn(harness);
    } finally {
      harness.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

function deliveryRows(db: SqliteStorageSession['database']): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM notification_deliveries ORDER BY event_sequence').all() as Array<Record<string, unknown>>;
}

function scanRow(db: SqliteStorageSession['database']): { last_scanned_sequence: number; revision: number } | undefined {
  return db.prepare('SELECT last_scanned_sequence, revision FROM notification_scan_state WHERE channel_id = ?').get(CHANNEL) as
    { last_scanned_sequence: number; revision: number } | undefined;
}

// ---------------------------------------------------------------------------
// 纯端口契约（不触库）
// ---------------------------------------------------------------------------

describe('P07-4 / F-006 notification projection port contract', () => {
  it('[case:registry-and-request-validation] 冻结订阅注册表；批大小默认/上限与未知渠道写入前拒绝', () => {
    expect([...NOTIFICATION_SUBSCRIPTION_EVENT_TYPES]).toEqual([
      'task.terminal', 'task.action_required', 'execution.run.ended', 'feature.finalized', 'feature.finalization_blocked',
    ]);
    expect(validateNotificationProjectionBatchRequest({ channelId: CHANNEL })).toMatchObject({
      channelId: CHANNEL, batchSize: NOTIFICATION_PROJECTION_BATCH_DEFAULT,
    });
    expect(validateNotificationProjectionBatchRequest({ channelId: CHANNEL, batchSize: 1 }).batchSize).toBe(1);
    expect(validateNotificationProjectionBatchRequest({ channelId: CHANNEL, batchSize: NOTIFICATION_PROJECTION_BATCH_MAX }).batchSize)
      .toBe(NOTIFICATION_PROJECTION_BATCH_MAX);
    expectValidation(
      (() => { try { validateNotificationProjectionBatchRequest({ channelId: CHANNEL, batchSize: 0 }); } catch (error) { return error; } })(),
      'batchSize', 'batch_size_out_of_range',
    );
    expectValidation(
      (() => { try { validateNotificationProjectionBatchRequest({ channelId: CHANNEL, batchSize: NOTIFICATION_PROJECTION_BATCH_MAX + 1 }); } catch (error) { return error; } })(),
      'batchSize', 'batch_size_out_of_range',
    );
    expectValidation(
      (() => { try { validateNotificationProjectionBatchRequest({ channelId: 'webhook', batchSize: 10 }); } catch (error) { return error; } })(),
      'channelId', 'unsupported_channel',
    );
    expect(() => validateNotificationProjectionBatchRequest({ channelId: CHANNEL, batchSize: 10, extra: true })).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });

  it('[case:sanitized-summary-derivation] 五类订阅事件只派生冻结摘要；非订阅与旧短形态可区分', () => {
    const mkEvent = (
      type: PublicStateEvent['type'],
      aggregate: PublicStateEvent['aggregate'],
      payload: Record<string, unknown>,
      projectId = PROJ_A,
    ): PublicStateEvent => ({
      schemaVersion: 1, eventId: randomUUID(), sequence: 1, type,
      scope: { kind: 'project', projectId },
      aggregate, occurredAt: new Date(NOW_MS).toISOString(), payload,
    });
    const taskAggregate = { type: 'task' as const, id: 'task-1', revision: 3 };
    expect(deriveNotificationSummary(mkEvent('task.terminal', taskAggregate,
      { schemaVersion: 1, status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-1', runId: 'run-1', resultRef: 'verification-1' })))
      .toEqual(EXPECTED_SUMMARIES[2]);
    expect(deriveNotificationSummary(mkEvent('task.action_required', { ...taskAggregate, id: 'task-2' },
      { schemaVersion: 1, action: 'manual_review', itemId: 'item-1', reason: 'approval_required' })))
      .toEqual(EXPECTED_SUMMARIES[5]);
    expect(deriveNotificationSummary(mkEvent('execution.run.ended', { type: 'run' as const, id: 'run-1', revision: 3 },
      { schemaVersion: 1, status: 'failed', resultCategory: 'failed', resultRef: 'settle-1', batchId: 'batch-1', featureId: 'feature-1' })))
      .toEqual(EXPECTED_SUMMARIES[3]);
    expect(deriveNotificationSummary(mkEvent('feature.finalized', { type: 'feature' as const, id: 'feature-1', revision: 3 },
      { schemaVersion: 1, outcome: 'complete', deliveryStatus: 'succeeded', reasonCode: 'delivered', runId: 'run-1', batchId: 'batch-1', operationId: 'gitop-1' })))
      .toEqual(EXPECTED_SUMMARIES[6]);
    expect(deriveNotificationSummary(mkEvent('feature.finalization_blocked', { type: 'feature' as const, id: 'feature-2', revision: 3 },
      { schemaVersion: 1, outcome: 'partial', deliveryStatus: 'not_requested', reasonCode: 'verification_failed', runId: 'run-2', batchId: 'batch-2', operationId: null }, PROJ_B)))
      .toEqual(EXPECTED_SUMMARIES[7]);
    // 旧短形态（历史行兼容）：只有固定身份与 kind，不伪造结果轴。
    expect(deriveNotificationSummary(mkEvent('feature.finalized', { type: 'feature' as const, id: 'feature-1', revision: 3 }, { finalized: true })))
      .toEqual({ schemaVersion: 1, kind: 'feature_finalized', featureId: 'feature-1' });
    expect(deriveNotificationSummary(mkEvent('feature.finalization_blocked', { type: 'feature' as const, id: 'feature-2', revision: 3 }, { blocked: true })))
      .toEqual({ schemaVersion: 1, kind: 'feature_finalization_blocked', featureId: 'feature-2' });
    // 非订阅事件：null（不产生 delivery）。
    expect(deriveNotificationSummary(mkEvent('execution.batch.ended', { type: 'execution_batch' as PublicStateEvent['aggregate']['type'], id: 'batch-1', revision: 3 },
      { schemaVersion: 1, status: 'failed', resultCategory: 'budget_exhausted', resultRef: null, batchId: 'batch-1', featureId: 'feature-1' }))).toBeNull();
    expect(deriveNotificationSummary(mkEvent('task.attempt.updated', taskAggregate, { updated: true }))).toBeNull();
    expect(deriveNotificationSummary(mkEvent('execution.run.cancelled', { type: 'run' as const, id: 'run-9', revision: 3 }, { cancelled: true }))).toBeNull();
  });

  it('[case:service-bounds-validation] 服务默认批大小/每轮批次数越界在构造时拒绝', () => {
    expect(() => createNotificationProjectionService({ store: null as never, defaultBatchSize: 0 })).toThrow(TypeError);
    expect(() => createNotificationProjectionService({ store: null as never, defaultBatchSize: NOTIFICATION_PROJECTION_BATCH_MAX + 1 })).toThrow(TypeError);
    expect(() => createNotificationProjectionService({ store: null as never, maxBatchesPerRound: 0 })).toThrow(TypeError);
    expect(() => createNotificationProjectionService({ store: null as never, maxBatchesPerRound: 10_000 })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 真实 SQLite 投影
// ---------------------------------------------------------------------------

describe('P07-4 / F-006 notification projection (real SQLite)', () => {
  it('[case:projects-subscription-events] 单事务投影订阅事件，摘要/身份可追溯，非订阅事件只推进水位', async () => {
    const events = mixedEvents();
    await withProjectionHarness(events, (harness) => {
      const result = harness.store.projectNotificationBatch({ channelId: CHANNEL });
      expect(result.scannedCount).toBe(8);
      expect(result.lastScannedSequence).toBe(8);
      expect(result.moreAvailable).toBe(false);
      expect(result.createdDeliveries).toHaveLength(5);
      const rows = deliveryRows(harness.session.database);
      expect(rows).toHaveLength(5);
      const bySequence = new Map(rows.map((row) => [Number(row.event_sequence), row]));
      for (const sequence of [2, 3, 5, 6, 7]) {
        const row = bySequence.get(sequence)!;
        const seeded = events.find((event) => event.sequence === sequence)!;
        expect(row.event_id).toBe(seeded.id ?? row.event_id);
        expect(row.event_type).toBe(seeded.type);
        expect(row.project_id).toBe(seeded.projectId);
        expect(row.status).toBe('pending');
        expect(row.attempt_count).toBe(0);
        expect(row.policy_version).toBe(1);
        expect(row.policy_digest).toBe(computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY));
        // 摘要为冻结形状（深度相等），不携带 payload 原文之外的任何自由文本。
        expect(JSON.parse(String(row.summary_json))).toEqual(EXPECTED_SUMMARIES[sequence]);
      }
      // 源事件身份可追溯：delivery.eventId 命中真实 state_events 行。
      for (const row of rows) {
        const source = harness.session.database.prepare('SELECT id FROM state_events WHERE id = ?').get(row.event_id);
        expect(source).toBeDefined();
      }
      // 非订阅/全局事件只推进水位，不产生 delivery。
      expect(scanRow(harness.session.database)?.last_scanned_sequence).toBe(8);
      // 投影不创建任何业务执行行。
      expect(harness.session.database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
      expect(harness.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 0 });
      expect(harness.session.database.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    });
  });

  it('[case:bounded-backlog-and-empty-batch] 积压按持久水位分批；每轮批次数有上限；空批次零写入', async () => {
    await withProjectionHarness(mixedEvents(), (harness) => {
      const bounded = createNotificationProjectionService({ store: harness.store, maxBatchesPerRound: 2, defaultBatchSize: 3 });
      const round1 = bounded.runProjectionRound({});
      expect(round1.batchesExecuted).toBe(2);
      expect(round1.eventsScanned).toBe(6);
      expect(round1.deliveriesCreated).toBe(4);
      expect(round1.lastScannedSequence).toBe(6);
      expect(round1.moreAvailable).toBe(true);
      expect(round1.lastBatchCreatedDeliveryIds.length).toBeLessThanOrEqual(3);
      const round2 = bounded.runProjectionRound({});
      expect(round2.batchesExecuted).toBe(1);
      expect(round2.eventsScanned).toBe(2);
      expect(round2.deliveriesCreated).toBe(1);
      expect(round2.lastScannedSequence).toBe(8);
      expect(round2.moreAvailable).toBe(false);
      // 空批次：零写入、水位与 revision 不变。
      const revisionBefore = scanRow(harness.session.database)!.revision;
      const empty = bounded.runProjectionRound({});
      expect(empty.batchesExecuted).toBe(1);
      expect(empty.eventsScanned).toBe(0);
      expect(empty.deliveriesCreated).toBe(0);
      expect(empty.lastScannedSequence).toBe(8);
      expect(scanRow(harness.session.database)).toMatchObject({ last_scanned_sequence: 8, revision: revisionBefore });
      expect(deliveryRows(harness.session.database)).toHaveLength(5);
    });
  });

  it('[case:duplicate-rescan-idempotent] 水位回退重放/重复扫描不重复创建 delivery', async () => {
    await withProjectionHarness(mixedEvents(), (harness) => {
      const first = harness.store.projectNotificationBatch({ channelId: CHANNEL });
      expect(first.createdDeliveries).toHaveLength(5);
      // 模拟崩溃后重放：持久水位被回退（或另一投影者从旧水位重新扫描）。
      harness.session.database.prepare('UPDATE notification_scan_state SET last_scanned_sequence = 0 WHERE channel_id = ?').run(CHANNEL);
      const replay = harness.store.projectNotificationBatch({ channelId: CHANNEL });
      expect(replay.scannedCount).toBe(8);
      expect(replay.createdDeliveries).toHaveLength(0);
      expect(replay.lastScannedSequence).toBe(8);
      expect(deliveryRows(harness.session.database)).toHaveLength(5);
      // 逐事件幂等：直连 createDelivery 同摘要返回既有行。
      const events = harness.session.database.prepare(
        "SELECT id FROM state_events WHERE event_type = 'task.terminal' AND project_id = ?",
      ).all(PROJ_A) as Array<{ id: string }>;
      const direct = harness.store.createDelivery({ eventId: events[0]!.id, channelId: CHANNEL, summary: EXPECTED_SUMMARIES[2] });
      expect(direct.created).toBe(false);
      expect(deliveryRows(harness.session.database)).toHaveLength(5);
    });
  });

  it('[case:concurrent-projectors-single-delivery] 确定性屏障下双投影者竞争仍只保留一条 delivery', async () => {
    await withProjectionHarness(mixedEvents(), async (harness) => {
      const secondSession = openSqliteStorageSession({ path: harness.path });
      try {
        const secondStore = createSqliteNotificationDeliveryStore({ session: secondSession, nowUtcMs: () => NOW_MS + 1_000 });
        const barrier = createStartBarrier(2);
        const run = (store: typeof harness.store) => async () => {
          await barrier.arrive();
          return store.projectNotificationBatch({ channelId: CHANNEL });
        };
        const [a, b] = await Promise.all([run(harness.store)(), run(secondStore)()]);
        // 两个投影者都成功；创建集合互不重复，总量恰为订阅事件数。
        const createdIds = [...a.createdDeliveries, ...b.createdDeliveries].map((delivery: NotificationDeliveryRecord) => delivery.deliveryId);
        expect(new Set(createdIds).size).toBe(createdIds.length);
        expect(createdIds.length).toBe(5);
        expect(deliveryRows(harness.session.database)).toHaveLength(5);
        const finalScan = scanRow(harness.session.database);
        expect(finalScan?.last_scanned_sequence).toBe(8);
        // 竞争后再次扫描为空批，不重复。
        const drain = harness.store.projectNotificationBatch({ channelId: CHANNEL });
        expect(drain.scannedCount).toBe(0);
        expect(drain.createdDeliveries).toHaveLength(0);
      } finally {
        secondSession.close();
      }
    });
  });

  it('[case:pre-commit-rollback] delivery 写入失败整体回滚：零 delivery、水位不动；修复后可重投', async () => {
    await withProjectionHarness(mixedEvents(), (harness) => {
      const db = harness.session.database;
      db.exec("CREATE TRIGGER f006_dlv_fail BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'f006_projection_inject'); END");
      expect(() => harness.store.projectNotificationBatch({ channelId: CHANNEL })).toThrow('f006_projection_inject');
      db.exec('DROP TRIGGER f006_dlv_fail');
      // 提交前崩溃窗口：事务整体回滚，无部分写入。
      expect(deliveryRows(db)).toHaveLength(0);
      expect(scanRow(db)).toBeUndefined();
      const retried = harness.store.projectNotificationBatch({ channelId: CHANNEL });
      expect(retried.createdDeliveries).toHaveLength(5);
      expect(scanRow(db)?.last_scanned_sequence).toBe(8);
    });
  });

  it('[case:post-commit-restart-reread] 提交后未唤醒/重开真实 SQLite：补扫不漏通知、不重复创建', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f006-restart-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const boot = openProjectionHarness(dbPath);
      try {
        await migrateSqliteStorage(boot.session);
        seedProjects(boot.session.database);
        seedEvents(boot.session.database, mixedEvents().slice(0, 3));
        const first = boot.store.projectNotificationBatch({ channelId: CHANNEL });
        expect(first.createdDeliveries).toHaveLength(2);
      } finally {
        boot.close();
      }
      // 重开真实 SQLite（新会话、新存储实例）。
      const reopened = openProjectionHarness(dbPath);
      try {
        const again = reopened.store.projectNotificationBatch({ channelId: CHANNEL });
        expect(again.scannedCount).toBe(0);
        expect(again.createdDeliveries).toHaveLength(0);
        expect(deliveryRows(reopened.session.database)).toHaveLength(2);
        // 新事件到达后补扫不漏。
        seedEvents(reopened.session.database, [{
          sequence: 4, type: 'task.terminal', aggregateType: 'task', aggregateId: 'task-9', projectId: PROJ_B,
          payload: { schemaVersion: 1, status: 'cancelled', resultCategory: 'cancelled', attemptId: 'attempt-9', runId: 'run-9', resultRef: null },
        }]);
        const topUp = reopened.store.projectNotificationBatch({ channelId: CHANNEL });
        expect(topUp.scannedCount).toBe(1);
        expect(topUp.createdDeliveries).toHaveLength(1);
        expect(scanRow(reopened.session.database)?.last_scanned_sequence).toBe(4);
        expect(deliveryRows(reopened.session.database)).toHaveLength(3);
      } finally {
        reopened.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:corrupt-events-diagnosable] 损坏事件显式失败带 sequence 定位，水位不越过；修复后继续', async () => {
    await withProjectionHarness(mixedEvents().slice(0, 2), (harness) => {
      const db = harness.session.database;
      seedEvents(db, [{ sequence: 3, type: 'future.unknown.event', aggregateType: 'task', aggregateId: 'task-x', projectId: PROJ_A, payload: { schemaVersion: 1 } }]);
      let error: unknown;
      try { harness.store.projectNotificationBatch({ channelId: CHANNEL }); } catch (caught) { error = caught; }
      expect(isStorageError(error, 'corrupt'), `必须是 corrupt：${String(error)}`).toBe(true);
      const details = (error as { details?: { reason?: string; sequence?: number; cause?: string } }).details;
      expect(details).toMatchObject({ reason: 'event_mapping_failed', sequence: 3, cause: 'unknown_event_type' });
      // 错误信息脱敏：不回显 payload 原文。
      expect(String((error as Error).message)).not.toContain('future.unknown.event');
      // 不静默越过：零部分写入（seq2 的 delivery 也回滚）、水位不动。
      expect(deliveryRows(db)).toHaveLength(0);
      expect(scanRow(db)).toBeUndefined();
      // 修复未知类型后同一批次继续投影。
      db.prepare("UPDATE state_events SET event_type = 'task.terminal', payload = ? WHERE sequence = 3").run(JSON.stringify({
        schemaVersion: 1, status: 'passed', resultCategory: 'passed', attemptId: 'attempt-3', runId: 'run-3', resultRef: 'verification-3',
      }));
      const fixed = harness.store.projectNotificationBatch({ channelId: CHANNEL });
      expect(fixed.createdDeliveries).toHaveLength(2);
      expect(fixed.lastScannedSequence).toBe(3);
      // 未知必需 payload 版本（水位之后的新事件）同样显式失败，不静默越过。
      seedEvents(db, [
        { sequence: 4, type: 'task.attempt.updated', aggregateType: 'task', aggregateId: 'task-0', projectId: PROJ_A, payload: { updated: true } },
        { sequence: 5, type: 'task.terminal', aggregateType: 'task', aggregateId: 'task-4', projectId: PROJ_A,
          payload: { schemaVersion: 2, status: 'failed', resultCategory: 'runtime_failed', attemptId: 'attempt-4', runId: 'run-4', resultRef: null } },
      ]);
      let versionError: unknown;
      try { harness.store.projectNotificationBatch({ channelId: CHANNEL }); } catch (caught) { versionError = caught; }
      expect(isStorageError(versionError, 'corrupt')).toBe(true);
      expect((versionError as { details?: { sequence?: number; cause?: string } }).details).toMatchObject({ sequence: 5, cause: 'event_payload_violation' });
      expect(scanRow(db)?.last_scanned_sequence).toBe(3);
    });
  });

  it('[case:watermark-gap-diagnosable] 消费水位超前事件日志（断档）显式可诊断，不静默推进', async () => {
    await withProjectionHarness(mixedEvents(), (harness) => {
      const db = harness.session.database;
      harness.store.projectNotificationBatch({ channelId: CHANNEL });
      // 模拟恢复旧备份/库替换后水位超前 MAX(sequence)。
      db.prepare('UPDATE notification_scan_state SET last_scanned_sequence = 999 WHERE channel_id = ?').run(CHANNEL);
      let error: unknown;
      try { harness.store.projectNotificationBatch({ channelId: CHANNEL }); } catch (caught) { error = caught; }
      expect(isStorageError(error, 'corrupt')).toBe(true);
      expect((error as { details?: { reason?: string } }).details).toMatchObject({ reason: 'watermark_beyond_event_log' });
      // 重复调用保持可诊断（不静默越过、不改写水位）。
      expect(() => harness.store.projectNotificationBatch({ channelId: CHANNEL })).toThrow(
        expect.objectContaining({ kind: 'corrupt' }),
      );
      expect(scanRow(db)?.last_scanned_sequence).toBe(999);
      expect(deliveryRows(db)).toHaveLength(5);
    });
  });

  it('[case:real-settlement-no-business-side-effects] 真实结算事件投影不改 Task/Run/预算/检查结果', async () => {
    const fixture = await openBudgetFixture({ ...BUDGET, batch: { ...BUDGET.batch, maxNoProgressRuns: 1 } });
    try {
      const ids = await fixture.start();
      const db = fixture.session.database;
      db.prepare("UPDATE execution_batches SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.batchId);
      db.prepare("UPDATE runs SET status = 'running', revision = revision + 1 WHERE id = ?").run(ids.runId);
      const access = createSqliteExecutionAccess(fixture.session, { nowUtcMs: () => NOW + 10 });
      const run = db.prepare('SELECT revision FROM runs WHERE id = ?').get(ids.runId) as { revision: number };
      const settled = fixture.session.transactWrite('f006.settle', () => access.settleExecutionRunOutcomeInTransaction({
        projectId: ids.projectId, batchId: ids.batchId, runId: ids.runId, runRevision: run.revision,
        resultKey: `f006-${randomUUID()}`, outcome: 'failed', reason: 'runtime_failed',
      }));
      // 真实结算事务写入 Run/Batch 终态事件（F-005 已证）。
      const runEnded = db.prepare(
        "SELECT id, sequence, payload FROM state_events WHERE event_type = 'execution.run.ended'",
      ).get() as { id: string; sequence: number; payload: string };
      expect(runEnded).toBeDefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM state_events WHERE event_type = 'execution.batch.ended'").get())
        .toEqual({ count: 1 });
      const before = {
        runs: db.prepare('SELECT COUNT(*) AS count FROM runs').get(),
        attempts: db.prepare('SELECT COUNT(*) AS count FROM attempts').get(),
        tasks: db.prepare("SELECT id, status, revision FROM tasks WHERE id = ?").get(ids.taskId),
        runRow: db.prepare('SELECT status, reason FROM runs WHERE id = ?').get(ids.runId),
        batchRow: db.prepare('SELECT status, reason FROM execution_batches WHERE id = ?').get(ids.batchId),
        budgetRevisions: db.prepare('SELECT COUNT(*) AS count FROM batch_budget_revisions').get(),
      };
      const store = createSqliteNotificationDeliveryStore({ session: fixture.session, nowUtcMs: () => NOW + 1_000 });
      const service = createNotificationProjectionService({ store });
      const round = service.runProjectionRound({});
      // 只有 execution.run.ended 是订阅事件；batch.ended 不是默认订阅。
      expect(round.deliveriesCreated).toBe(1);
      expect(round.lastScannedSequence).toBe(
        (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max FROM state_events').get() as { max: number }).max,
      );
      const deliveries = db.prepare('SELECT event_id, event_type, project_id, summary_json FROM notification_deliveries').all() as Array<Record<string, unknown>>;
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.event_id).toBe(runEnded.id);
      expect(deliveries[0]!.event_type).toBe('execution.run.ended');
      expect(deliveries[0]!.project_id).toBe(ids.projectId);
      const runPayload = JSON.parse(runEnded.payload) as Record<string, unknown>;
      expect(JSON.parse(String(deliveries[0]!.summary_json))).toEqual({
        schemaVersion: 1, kind: 'run_ended', runId: ids.runId,
        status: runPayload.status, resultCategory: runPayload.resultCategory,
        resultRef: runPayload.resultRef, batchId: runPayload.batchId, featureId: runPayload.featureId,
      });
      // 投影零业务副作用：Run/Attempt/Task/预算/结算事实不变。
      expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual(before.runs);
      expect(db.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual(before.attempts);
      expect(db.prepare('SELECT id, status, revision FROM tasks WHERE id = ?').get(ids.taskId)).toEqual(before.tasks);
      expect(db.prepare('SELECT status, reason FROM runs WHERE id = ?').get(ids.runId)).toEqual(before.runRow);
      expect(db.prepare('SELECT status, reason FROM execution_batches WHERE id = ?').get(ids.batchId)).toEqual(before.batchRow);
      expect(db.prepare('SELECT COUNT(*) AS count FROM batch_budget_revisions').get()).toEqual(before.budgetRevisions);
      expect(settled).toBeDefined();
    } finally {
      fixture.close();
    }
  });
});
