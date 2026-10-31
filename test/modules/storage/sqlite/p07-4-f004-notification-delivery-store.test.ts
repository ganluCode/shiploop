/**
 * P07-4 / F-004：独立通知的版本化端口与 SQLite delivery、扫描水位、本地回执持久模型。
 *
 * 覆盖（真实临时 SQLite，非 mock；纯契约部分不触库）：
 * - 版本化端口契约：冻结渠道词汇（内置固定本地渠道）、有限默认策略（次数/延迟上界、
 *   稳定摘要可从记录核验）、create/result/scan 输入的运行时校验在写入前拒绝未知渠道、
 *   未知策略版本、超界次数/延迟/摘要大小（PRD FR-2；设计 03 §2/§5、07 §5）；
 * - 与 Attempt 生命周期通知（attempt_notifications：Runtime→Core 生命周期回执）和
 *   Git 发布交付（delivery-policy/phase_delivery）类型区分：独立表/端口/状态词汇；
 * - SQLite 写模型：delivery 由源事件权威派生项目归属、(event_id,channel_id) 唯一去重、
 *   幂等重放返回原行、摘要变化冲突拒绝；结果记录带占用代次 fencing、顺序/终态/退避
 *   上界原子校验；扫描水位单调、不超前事件水位、关闭重开持久；
 * - 迁移 v61：从 v60 前一受支持版本升级保留既有业务/事件/制品引用、幂等重放、
 *   历史迁移与 checksum 不改写；
 * - P07-3 生命周期表登记：项目删除清点完整（无 unknown_project_table）并把通知
 *   delivery/结果列为随项目删除对象；保留清理对象词汇不含通知/事件，快照扫描
 *   不把未完成 delivery 或未消费事件列为可删除对象。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_DELIVERY_POLICY,
  NOTIFICATION_CHANNEL_IDS,
  NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT,
  NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS,
  NOTIFICATION_DELIVERY_POLICY_DIGEST_DOMAIN,
  NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  computeNotificationPolicyDigest,
  computeNotificationRetryDelayMs,
  validateNotificationDeliveryCreateInput,
  validateNotificationDeliveryPolicy,
  validateNotificationDeliveryResultInput,
  validateNotificationScanAdvanceInput,
} from '../../../../packages/core/src/ports/notification-delivery.ts';
import { createSqliteNotificationDeliveryStore } from '../../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import { openSqliteConnection } from '../../../../packages/core/src/adapters/sqlite/connection.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createSqliteProjectDeleteInventory } from '../../../../packages/core/src/adapters/sqlite/project-delete-inventory.ts';
import { createArtifactFileStore } from '../../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteRetentionCleanupStore } from '../../../../packages/core/src/adapters/sqlite/evidence-retention.ts';
import { createMaintenanceWriteGate } from '../../../../packages/core/src/ports/data-maintenance.ts';
import { RETENTION_CLEANUP_OBJECT_KINDS } from '../../../../packages/core/src/ports/evidence-retention.ts';
import { isStorageError } from '../../../../packages/core/src/ports/errors.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';

const NOW_MS = 1_700_600_000_000;
const VALID_EVENT_A = randomUUID();
const VALID_EVENT_B = randomUUID();
const GLOBAL_EVENT = randomUUID();

/** 校验类错误断言：定位字段与 reason，避免只看错误文本。 */
function expectValidation(error: unknown, field: string, reason: string): void {
  expect(isStorageError(error, 'validation'), `必须是校验错误：${String(error)}`).toBe(true);
  const details = (error as { details?: { field?: string; reason?: string } }).details;
  expect(details?.field).toBe(field);
  expect(details?.reason).toBe(reason);
}

/** 项目 + 两个项目事件 + 一个全局事件的种子（直接 SQL，与 F-003 矩阵同一方式）。 */
function seedProjectAndEvents(db: SqliteStorageSession['database'], now = NOW_MS): void {
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES ('proj-1', ?, 1, ?, '通知项目', 'active', NULL, '[]')",
  ).run(now, now);
  db.prepare(
    "INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, description, labels) VALUES ('proj-2', ?, 1, ?, '项目 B', 'active', NULL, '[]')",
  ).run(now, now);
  const insertEvent = db.prepare(
    'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
  );
  insertEvent.run(VALID_EVENT_A, now, now, 'proj-1', 1, 'execution.run.cancelled', 'run', 'run-1', JSON.stringify({ cancelled: true }), now);
  insertEvent.run(VALID_EVENT_B, now, now, 'proj-2', 2, 'execution.run.cancelled', 'run', 'run-2', JSON.stringify({ cancelled: true }), now);
  insertEvent.run(GLOBAL_EVENT, now, now, null, 3, 'settings.global_updated', 'global_settings', 'global', JSON.stringify({ changedFields: ['strategies'] }), now);
}

type StoreHarness = {
  readonly session: SqliteStorageSession;
  readonly store: ReturnType<typeof createSqliteNotificationDeliveryStore>;
  readonly path: string;
  /** 注入时钟的当前值（毫秒）。 */
  clock: { now: number };
  close(): void;
};

function openStoreHarness(dbPath: string, start = NOW_MS): StoreHarness {
  const session = openSqliteStorageSession({ path: dbPath });
  const clock = { now: start };
  const store = createSqliteNotificationDeliveryStore({ session, nowUtcMs: () => clock.now });
  return { session, store, path: dbPath, clock, close: () => session.close() };
}

/** 完整迁移 + 种子 + 打开的写模型夹具。 */
async function withStoreHarness(fn: (harness: StoreHarness, root: string) => Promise<void> | void): Promise<void> {
  const sandbox = createTempSandbox('shiploop-p07-4-f004-');
  try {
    const dbPath = join(sandbox.path, 'state.db');
    const boot = openStoreHarness(dbPath);
    try {
      await migrateSqliteStorage(boot.session);
      seedProjectAndEvents(boot.session.database);
      await fn(boot, sandbox.path);
    } finally {
      boot.close();
    }
  } finally {
    sandbox.cleanup();
  }
}

const SUMMARY = { kind: 'run_cancelled', subject: 'run-1', status: 'cancelled' };

function createInput(eventId: string, summary: Record<string, unknown> = SUMMARY): Record<string, unknown> {
  return { eventId, channelId: 'local-results', summary };
}

// ---------------------------------------------------------------------------
// 纯端口契约（不触库）
// ---------------------------------------------------------------------------

describe('P07-4 / F-004 notification delivery port contract', () => {
  it('[case:port-frozen-vocabulary-and-policy] 冻结渠道/版本词汇与有限默认策略可从记录核验', () => {
    expect(NOTIFICATION_CHANNEL_IDS).toEqual(['local-results']);
    expect(NOTIFICATION_DELIVERY_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_NOTIFICATION_DELIVERY_POLICY.maxAttempts).toBeLessThanOrEqual(NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT);
    expect(DEFAULT_NOTIFICATION_DELIVERY_POLICY.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_NOTIFICATION_DELIVERY_POLICY.maxDelayMs).toBeLessThanOrEqual(NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS);
    // 指数退避有界：60s → 480s → 封顶 3600s，且不随次数继续增长。
    const delays = [1, 2, 3, 4, 8].map(attempts => computeNotificationRetryDelayMs(DEFAULT_NOTIFICATION_DELIVERY_POLICY, attempts));
    expect(delays.slice(0, 3)).toEqual([60_000, 480_000, 3_600_000]);
    expect(delays[3]).toBe(3_600_000);
    expect(delays[4]).toBe(3_600_000);
    // 摘要稳定且与领域前缀绑定：同一策略重算一致，字段变化即不同。
    const digest = computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeNotificationPolicyDigest({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, maxAttempts: 3 })).not.toBe(digest);
    expect(NOTIFICATION_DELIVERY_POLICY_DIGEST_DOMAIN).toContain('notification');
  });

  it('[case:port-policy-bounds] 超界策略（次数/基础延迟/因子/上限延迟）被拒绝', () => {
    const context = { operation: 'test.policy' };
    expect(() => validateNotificationDeliveryPolicy({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, maxAttempts: 0 }, context, 'policy')).toThrow();
    expect(() => validateNotificationDeliveryPolicy({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, maxAttempts: NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT + 1 }, context, 'policy')).toThrow();
    expect(() => validateNotificationDeliveryPolicy({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, baseDelayMs: 0 }, context, 'policy')).toThrow();
    expect(() => validateNotificationDeliveryPolicy({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, delayFactor: 1 }, context, 'policy')).toThrow();
    expect(() => validateNotificationDeliveryPolicy({ ...DEFAULT_NOTIFICATION_DELIVERY_POLICY, maxDelayMs: NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS + 1 }, context, 'policy')).toThrow();
    expect(validateNotificationDeliveryPolicy(DEFAULT_NOTIFICATION_DELIVERY_POLICY, context, 'policy')).toEqual(DEFAULT_NOTIFICATION_DELIVERY_POLICY);
  });

  it('[case:port-create-input-validation] 未知渠道/策略版本/超界摘要在写入前拒绝', () => {
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput({ ...createInput(VALID_EVENT_A), channelId: 'webhook' }); } catch (error) { return error; } })(),
      'channelId', 'unsupported_channel',
    );
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput({ ...createInput(VALID_EVENT_A), policyVersion: 2 }); } catch (error) { return error; } })(),
      'policyVersion', 'unsupported_policy_version',
    );
    // 摘要必须是对象且序列化后有界。
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput(createInput(VALID_EVENT_A, 'text' as unknown as Record<string, unknown>)); } catch (error) { return error; } })(),
      'summary', 'must_be_object',
    );
    const oversized = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`field${index}`, 'x'.repeat(200)]));
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput(createInput(VALID_EVENT_A, oversized)); } catch (error) { return error; } })(),
      'summary', 'summary_too_large',
    );
    // 单值字符串也有界（脱敏底线：不接受长自由文本冒充摘要）。
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput(createInput(VALID_EVENT_A, { leak: 'y'.repeat(300) })); } catch (error) { return error; } })(),
      'summary', 'summary_value_too_long',
    );
    // 未知键与非法事件 ID。
    expect(() => validateNotificationDeliveryCreateInput({ ...createInput(VALID_EVENT_A), extra: 1 })).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
    expectValidation(
      (() => { try { validateNotificationDeliveryCreateInput(createInput('not-an-uuid')); } catch (error) { return error; } })(),
      'eventId', 'invalid_event_id',
    );
    // 合法输入原样通过。
    expect(validateNotificationDeliveryCreateInput(createInput(VALID_EVENT_A))).toMatchObject({ channelId: 'local-results', eventId: VALID_EVENT_A });
  });

  it('[case:port-result-input-validation] 结果输入：非法次数/结果形状/回执大小在写入前拒绝', () => {
    const base = { deliveryId: 'dlv-1', claimGeneration: 0, attempt: 1, outcome: 'succeeded', receipt: { deliveredTo: 'local' } };
    expect(validateNotificationDeliveryResultInput(base).attempt).toBe(1);
    // 超界次数。
    for (const attempt of [0, NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT + 1, 1.5]) {
      expectValidation(
        (() => { try { validateNotificationDeliveryResultInput({ ...base, attempt }); } catch (error) { return error; } })(),
        'attempt', 'attempt_out_of_range',
      );
    }
    // 未知结果。
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ ...base, outcome: 'maybe' }); } catch (error) { return error; } })(),
      'outcome', 'unsupported_outcome',
    );
    // 成功必须携带回执；失败必须携带原因且不得携带回执。
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ ...base, receipt: undefined }); } catch (error) { return error; } })(),
      'receipt', 'receipt_required',
    );
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ ...base, outcome: 'failed', receipt: { x: 1 }, failureReason: 'timeout' }); } catch (error) { return error; } })(),
      'receipt', 'receipt_not_allowed',
    );
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ deliveryId: 'dlv-1', claimGeneration: 0, attempt: 1, outcome: 'failed' }); } catch (error) { return error; } })(),
      'failureReason', 'failure_reason_required',
    );
    // 回执/原因大小有界。
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ ...base, receipt: { blob: 'z'.repeat(8193) } }); } catch (error) { return error; } })(),
      'receipt', 'receipt_too_large',
    );
    expectValidation(
      (() => { try { validateNotificationDeliveryResultInput({ deliveryId: 'dlv-1', claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'r'.repeat(300) }); } catch (error) { return error; } })(),
      'failureReason', 'failure_reason_too_long',
    );
  });

  it('[case:port-scan-input-validation] 扫描水位输入：未知渠道与非法序号拒绝', () => {
    expect(validateNotificationScanAdvanceInput({ channelId: 'local-results', lastScannedSequence: 7 }).lastScannedSequence).toBe(7);
    expectValidation(
      (() => { try { validateNotificationScanAdvanceInput({ channelId: 'external', lastScannedSequence: 1 }); } catch (error) { return error; } })(),
      'channelId', 'unsupported_channel',
    );
    for (const lastScannedSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectValidation(
        (() => { try { validateNotificationScanAdvanceInput({ channelId: 'local-results', lastScannedSequence }); } catch (error) { return error; } })(),
        'lastScannedSequence', 'sequence_out_of_range',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SQLite 写模型（真实临时库）
// ---------------------------------------------------------------------------

describe('P07-4 / F-004 notification delivery sqlite store', () => {
  it('[case:create-derives-project-and-stamps-policy] 创建派生项目归属并盖上可核验的有限策略', async () => {
    await withStoreHarness((harness) => {
      const result = harness.store.createDelivery(createInput(VALID_EVENT_A));
      expect(result.created).toBe(true);
      const delivery = result.delivery;
      expect(delivery.schemaVersion).toBe(NOTIFICATION_DELIVERY_SCHEMA_VERSION);
      expect(delivery.projectId).toBe('proj-1');
      expect(delivery.eventId).toBe(VALID_EVENT_A);
      expect(delivery.channelId).toBe('local-results');
      expect(delivery.eventSequence).toBe(1);
      expect(delivery.eventType).toBe('execution.run.cancelled');
      expect(delivery.status).toBe('pending');
      expect(delivery.attemptCount).toBe(0);
      expect(delivery.claimGeneration).toBe(0);
      expect(delivery.nextAttemptAt).toBe(NOW_MS);
      expect(delivery.policyVersion).toBe(1);
      expect(delivery.policyDigest).toBe(computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY));
      expect(delivery.summary).toEqual(SUMMARY);
      // 持久化行与记录一致；重开读回一致。
      const row = harness.session.database.prepare("SELECT project_id, status, policy_digest FROM notification_deliveries WHERE id = ?").get(delivery.deliveryId) as { project_id: string; status: string; policy_digest: string };
      expect(row).toEqual({ project_id: 'proj-1', status: 'pending', policy_digest: delivery.policyDigest });
      const reread = harness.store.readDelivery({ deliveryId: delivery.deliveryId });
      expect(reread).toEqual(delivery);
    });
  });

  it('[case:create-idempotent-and-conflict] (event,channel) 幂等去重：重放返回原行，摘要变化冲突拒绝', async () => {
    await withStoreHarness((harness) => {
      const first = harness.store.createDelivery(createInput(VALID_EVENT_A));
      const replay = harness.store.createDelivery(createInput(VALID_EVENT_A));
      expect(replay.created).toBe(false);
      expect(replay.delivery).toEqual(first.delivery);
      // 幂等重放不产生新行、不推进修订。
      expect(harness.session.database.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get()).toMatchObject({ n: 1 });
      // 键序不同的等价摘要仍是同一摘要（规范化比较）。
      const reordered = harness.store.createDelivery({ eventId: VALID_EVENT_A, channelId: 'local-results', summary: { status: 'cancelled', kind: 'run_cancelled', subject: 'run-1' } });
      expect(reordered.created).toBe(false);
      // 同一 (event,channel) 不同摘要 → 冲突。
      expect(() => harness.store.createDelivery(createInput(VALID_EVENT_A, { kind: 'other' }))).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      // 缺失事件 → not_found；全局范围事件 → 校验拒绝；时钟早于事件发生时间 → 冲突。
      expect(() => harness.store.createDelivery(createInput(randomUUID()))).toThrowError(
        expect.objectContaining({ kind: 'not_found' }),
      );
      expectValidation(
        (() => { try { harness.store.createDelivery(createInput(GLOBAL_EVENT)); } catch (error) { return error; } })(),
        'eventId', 'event_not_project_scoped',
      );
      harness.clock.now = NOW_MS - 1;
      expect(() => harness.store.createDelivery(createInput(VALID_EVENT_B))).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      harness.clock.now = NOW_MS;
    });
  });

  it('[case:result-lifecycle-bounded-retry] 结果记录：成功回执、有界退避、次数上限停投', async () => {
    await withStoreHarness((harness) => {
      const { deliveryId } = harness.store.createDelivery(createInput(VALID_EVENT_A)).delivery;
      // 失败 1：60 秒后重试。
      harness.clock.now = NOW_MS + 1_000;
      let record = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'channel_busy' });
      expect(record.status).toBe('retry_scheduled');
      expect(record.attemptCount).toBe(1);
      expect(record.nextAttemptAt).toBe(harness.clock.now + 60_000);
      expect(record.receipt).toBeNull();
      // 失败 2：480 秒。
      harness.clock.now = NOW_MS + 61_000;
      record = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'failed', failureReason: 'channel_busy' });
      expect(record.nextAttemptAt).toBe(harness.clock.now + 480_000);
      // 失败 3：封顶 3600 秒。
      harness.clock.now = NOW_MS + 541_000;
      record = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 3, outcome: 'failed', failureReason: 'still_busy' });
      expect(record.status).toBe('retry_scheduled');
      expect(record.nextAttemptAt).toBe(harness.clock.now + 3_600_000);
      // 失败 4 = 默认上限：exhausted，停止重试。
      harness.clock.now = NOW_MS + 4_141_000;
      record = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 4, outcome: 'failed', failureReason: 'still_busy' });
      expect(record.status).toBe('exhausted');
      expect(record.attemptCount).toBe(4);
      // 每次尝试都有本地结果记录且 (delivery,attempt) 唯一。
      const results = harness.session.database.prepare('SELECT attempt, outcome, failure_reason FROM notification_delivery_results WHERE delivery_id = ? ORDER BY attempt').all(deliveryId) as Array<{ attempt: number; outcome: string; failure_reason: string }>;
      expect(results.map(row => [row.attempt, row.outcome])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
      // 成功路径：另一事件一次送达，回执持久。
      const other = harness.store.createDelivery(createInput(VALID_EVENT_B)).delivery;
      harness.clock.now += 5_000;
      const delivered = harness.store.recordDeliveryResult({ deliveryId: other.deliveryId, claimGeneration: 0, attempt: 1, outcome: 'succeeded', receipt: { channel: 'local-results', items: 1 } });
      expect(delivered.status).toBe('delivered');
      expect(delivered.receipt).toEqual({ channel: 'local-results', items: 1 });
      const receiptRow = harness.session.database.prepare('SELECT last_receipt AS receipt FROM notification_deliveries WHERE id = ?').get(other.deliveryId) as { receipt: string };
      expect(JSON.parse(receiptRow.receipt)).toEqual({ channel: 'local-results', items: 1 });
    });
  });

  it('[case:result-fencing-and-order] fencing/顺序/终态/延迟上界原子拒绝且零部分写入', async () => {
    await withStoreHarness((harness) => {
      const { deliveryId } = harness.store.createDelivery(createInput(VALID_EVENT_A)).delivery;
      harness.clock.now = NOW_MS + 1_000;
      // 乱序：跳号是状态机冲突；非法序号（0）在校验层拒绝。
      expect(() => harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'failed', failureReason: 'x' })).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      expectValidation(
        (() => { try { harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 0, outcome: 'failed', failureReason: 'x' }); } catch (error) { return error; } })(),
        'attempt', 'attempt_out_of_range',
      );
      // 记录第 1 次后重放旧序号同样是冲突。
      harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'first' });
      expect(() => harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'replay' })).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      // 陈旧占用代次拒绝（fencing：迟到写入者不得覆盖新一代占用）。
      expect(() => harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 3, attempt: 1, outcome: 'succeeded', receipt: {} })).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      // 提供显式下次时间：过远被拒、不在未来被拒（均为写入前输入校验）。
      expectValidation(
        (() => { try { harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'failed', failureReason: 'x', nextAttemptAt: harness.clock.now + NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS + 1 }); } catch (error) { return error; } })(),
        'nextAttemptAt', 'retry_delay_out_of_bounds',
      );
      expectValidation(
        (() => { try { harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'failed', failureReason: 'x', nextAttemptAt: harness.clock.now }); } catch (error) { return error; } })(),
        'nextAttemptAt', 'retry_delay_not_in_future',
      );
      // 成功结果不得携带下次时间。
      expectValidation(
        (() => { try { harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'succeeded', receipt: {}, nextAttemptAt: harness.clock.now + 60_000 }); } catch (error) { return error; } })(),
        'nextAttemptAt', 'next_attempt_not_allowed',
      );
      // 拒绝路径零部分写入（重放被拒不追加结果行）。
      expect(harness.session.database.prepare('SELECT COUNT(*) AS n FROM notification_delivery_results').get()).toMatchObject({ n: 1 });
      expect(harness.session.database.prepare('SELECT attempt_count, status FROM notification_deliveries WHERE id = ?').get(deliveryId)).toMatchObject({ attempt_count: 1, status: 'retry_scheduled' });
      // 合法显式退避在界内被接受。
      const record = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 2, outcome: 'failed', failureReason: 'x', nextAttemptAt: harness.clock.now + 120_000 });
      expect(record.status).toBe('retry_scheduled');
      expect(record.nextAttemptAt).toBe(harness.clock.now + 120_000);
      // 终态后再写拒绝。
      const done = harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 3, outcome: 'succeeded', receipt: { ok: true } });
      expect(done.status).toBe('delivered');
      expect(() => harness.store.recordDeliveryResult({ deliveryId, claimGeneration: 0, attempt: 4, outcome: 'failed', failureReason: 'late' })).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      // 时钟回退（早于创建时间）拒绝。
      const second = harness.store.createDelivery(createInput(VALID_EVENT_B)).delivery;
      harness.clock.now = NOW_MS - 10_000;
      expect(() => harness.store.recordDeliveryResult({ deliveryId: second.deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'x' })).toThrowError(
        expect.objectContaining({ kind: 'conflict' }),
      );
      harness.clock.now = NOW_MS + 1_000;
    });
  });

  it('[case:scan-watermark-monotonic-persistent] 扫描水位单调、不超前事件水位、重开持久', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f004-scan-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const boot = openStoreHarness(dbPath);
      try {
        await migrateSqliteStorage(boot.session);
        seedProjectAndEvents(boot.session.database);
        const store = boot.store;
        expect(store.readScanState({ channelId: 'local-results' })).toBeNull();
        harnessAdvance(store, 2);
        // 同值幂等：不推进修订。
        const before = store.readScanState({ channelId: 'local-results' })!;
        harnessAdvance(store, 2);
        expect(store.readScanState({ channelId: 'local-results' })).toEqual(before);
        // 回退拒绝；超前事件水位拒绝。
        expect(() => store.advanceScanState({ channelId: 'local-results', lastScannedSequence: 1 })).toThrowError(
          expect.objectContaining({ kind: 'conflict' }),
        );
        expect(() => store.advanceScanState({ channelId: 'local-results', lastScannedSequence: 99 })).toThrowError(
          expect.objectContaining({ kind: 'conflict' }),
        );
        // 新事件后可推进到 3。
        boot.session.database.prepare("INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) VALUES (?, ?, 1, ?, 'proj-1', 4, 'phase.created', 'phase', 'phase-1', 1, '{}', ?)").run(randomUUID(), NOW_MS, NOW_MS, NOW_MS);
        harnessAdvance(store, 4);
        expect(store.readScanState({ channelId: 'local-results' })!.lastScannedSequence).toBe(4);
      } finally {
        boot.close();
      }
      // 关闭重开：水位持久。
      const reopened = openStoreHarness(dbPath);
      try {
        const state = reopened.store.readScanState({ channelId: 'local-results' });
        expect(state?.lastScannedSequence).toBe(4);
        expect(state?.channelId).toBe('local-results');
      } finally {
        reopened.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

function harnessAdvance(store: ReturnType<typeof createSqliteNotificationDeliveryStore>, sequence: number): void {
  const record = store.advanceScanState({ channelId: 'local-results', lastScannedSequence: sequence });
  expect(record.lastScannedSequence).toBe(sequence);
}

// ---------------------------------------------------------------------------
// 迁移 v61：v60 → v61 升级保留、幂等、历史 checksum 不改写
// ---------------------------------------------------------------------------

describe('P07-4 / F-004 notification schema migration v61', () => {
  it('[case:upgrade-from-v60-preserves-data] 前一版本升级保留业务/事件/制品引用且幂等', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f004-mig-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      // 手工建立 v60 库（真实执行 1..60 并按执行器同构记录 checksum）。
      const setup = openSqliteConnection(dbPath);
      try {
        setup.database.exec('BEGIN IMMEDIATE');
        for (const migration of SQLITE_MIGRATIONS.filter(item => item.version <= 60)) {
          setup.database.exec(migration.sql);
          setup.database
            .prepare('INSERT INTO schema_migrations (id, created_at, version, checksum, applied_at) VALUES (?, ?, ?, ?, ?)')
            .run(`mig-${migration.version}`, NOW_MS, migration.version, migration.checksum, NOW_MS);
        }
        setup.database.exec('COMMIT');
        seedProjectAndEvents(setup.database);
        setup.database.prepare(
          "INSERT INTO artifacts (id, created_at, project_id, revision, updated_at, kind, status, media_type, expected_hash, version, storage_locator) VALUES ('art-1', ?, 'proj-1', 1, ?, 'report', 'pending', 'application/json', ?, 1, 'artifacts/art-1/v1/report.json')",
        ).run(NOW_MS, NOW_MS, 'ab'.repeat(32));
      } finally {
        setup.close();
      }
      // v60 库没有通知表。
      expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(62);

      const session = openSqliteStorageSession({ path: dbPath });
      try {
        await migrateSqliteStorage(session);
        // 既有业务、事件与制品引用逐行保留。
        expect(session.database.prepare('SELECT id, display_name FROM projects ORDER BY id').all()).toEqual([
          { id: 'proj-1', display_name: '通知项目' }, { id: 'proj-2', display_name: '项目 B' },
        ]);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM state_events').get()).toMatchObject({ n: 3 });
        expect(session.database.prepare('SELECT id FROM artifacts').all()).toEqual([{ id: 'art-1' }]);
        // 通知三表存在且为空；历史迁移记录未改写。
        for (const table of ['notification_deliveries', 'notification_scan_state', 'notification_delivery_results']) {
          expect(session.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
        }
        const rows = session.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
        expect(rows).toHaveLength(62);
        for (const row of rows.filter(item => item.version <= 60)) {
          expect(row.checksum).toBe(SQLITE_MIGRATIONS[row.version - 1]?.checksum);
        }
        // 升级后的库可正常写通知。
        const store = createSqliteNotificationDeliveryStore({ session, nowUtcMs: () => NOW_MS });
        const created = store.createDelivery(createInput(VALID_EVENT_A));
        expect(created.created).toBe(true);
        // 幂等：再次迁移零变更。
        await migrateSqliteStorage(session);
        expect(session.database.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get()).toMatchObject({ n: 1 });
      } finally {
        session.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// P07-3 生命周期表登记：删除清点与保留清理
// ---------------------------------------------------------------------------

describe('P07-4 / F-004 lifecycle table registration', () => {
  it('[case:delete-inventory-registered] 删除清点完整并登记通知对象，跨项目严格隔离', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f004-del-');
    try {
      mkdirSync(join(sandbox.path, 'data-root', 'backups'), { recursive: true });
      const dbPath = join(sandbox.path, 'state.db');
      const harness = openStoreHarness(dbPath);
      try {
        await migrateSqliteStorage(harness.session);
        seedProjectAndEvents(harness.session.database);
        const a = harness.store.createDelivery(createInput(VALID_EVENT_A)).delivery;
        harness.store.recordDeliveryResult({ deliveryId: a.deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'pending_retry' });
        harness.store.advanceScanState({ channelId: 'local-results', lastScannedSequence: 2 });
        const inventory = createSqliteProjectDeleteInventory({
          session: harness.session,
          files: createArtifactFileStore({ dataRoot: join(sandbox.path, 'data-root') }),
          backupRoot: join(sandbox.path, 'data-root', 'backups'),
        });
        const preview = await inventory.readInventory('proj-1');
        expect(preview.complete).toBe(true);
        expect(preview.reasons.filter(reason => String(reason).startsWith('unknown_project_table'))).toEqual([]);
        const kinds = new Map(preview.objects.map(object => [`${object.kind}:${object.id}`, object.disposition]));
        expect(kinds.get(`notification_deliveries:${a.deliveryId}`)).toBe('delete');
        const resultRow = harness.session.database.prepare('SELECT id FROM notification_delivery_results WHERE delivery_id = ?').get(a.deliveryId) as { id: string };
        expect(kinds.get(`notification_delivery_results:${resultRow.id}`)).toBe('delete');
        // 跨项目隔离：项目 2 的清点不包含项目 1 的通知对象。
        const previewB = await inventory.readInventory('proj-2');
        expect(previewB.complete).toBe(true);
        expect(previewB.objects.some(object => object.kind === 'notification_deliveries')).toBe(false);
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:retention-keeps-unconsumed-events] 保留清理不把未消费事件/未完成 delivery 列为删除对象', async () => {
    const sandbox = createTempSandbox('shiploop-p07-4-f004-ret-');
    try {
      const dbPath = join(sandbox.path, 'state.db');
      const harness = openStoreHarness(dbPath);
      try {
        await migrateSqliteStorage(harness.session);
        seedProjectAndEvents(harness.session.database);
        const a = harness.store.createDelivery(createInput(VALID_EVENT_A)).delivery;
        harness.store.recordDeliveryResult({ deliveryId: a.deliveryId, claimGeneration: 0, attempt: 1, outcome: 'failed', failureReason: 'pending_retry' });
        const cleanup = createSqliteRetentionCleanupStore({
          session: harness.session,
          dataRoot: sandbox.path,
          maintenanceGate: createMaintenanceWriteGate(),
          nowUtcMs: () => NOW_MS,
        });
        const snapshot = await cleanup.readSnapshot({}, NOW_MS);
        // 对象词汇不含通知/事件类别；快照对象只可能是制品/备份，不引用 state_events 或通知表行。
        expect(RETENTION_CLEANUP_OBJECT_KINDS).not.toContain('notification');
        expect(RETENTION_CLEANUP_OBJECT_KINDS).not.toContain('state_event');
        expect(snapshot.objects.every(object => object.kind === 'artifact' || object.kind === 'backup')).toBe(true);
        expect(snapshot.references.every(reference => reference.objectKind === 'artifact')).toBe(true);
        // 清点后业务行原样保留（未消费事件与未完成 delivery 未被清理路径触碰）。
        expect(harness.session.database.prepare('SELECT COUNT(*) AS n FROM state_events').get()).toMatchObject({ n: 3 });
        expect(harness.session.database.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').get()).toMatchObject({ n: 1 });
        expect(harness.session.database.prepare('SELECT status FROM notification_deliveries WHERE id = ?').get(a.deliveryId)).toMatchObject({ status: 'retry_scheduled' });
      } finally {
        harness.close();
      }
    } finally {
      sandbox.cleanup();
    }
  });
});
