/**
 * P07-4 独立通知持久模型的 SQLite 适配器（adapters 层；F-004 交付持久写模型，
 * F-006 增加持久事件 → delivery 的有界幂等投影）。
 *
 * 纪律（PRD FR-2、设计 03 §3/§5、07 §5）：
 * - 全部写入在单条 BEGIN IMMEDIATE 短事务内完成“原子校验 + 持久化”，拒绝路径
 *   零部分写入；事务内不做网络/文件/长检查；
 * - 项目归属由源 state_events 行在写事务内权威派生，调用方不声明项目；
 *   (project_id,event_id) 同项目复合外键兜底拒绝跨项目/全局事件；
 * - 次数/代次/终态/时间一致性与退避上界在写事务内校验：乱序、迟到代次、
 *   终态覆盖、时钟回退、超界显式退避一律结构化 conflict/validation 拒绝；
 * - 扫描水位单调且不超前当前事件水位（同事务读 MAX(sequence)）；
 * - 行列→记录映射只接受冻结词汇（未知状态/渠道/结果为持久损坏 fail-closed）；
 * - F-006 投影：单事务内“有界扫描 → 订阅事件幂等建 delivery → 水位推进”，
 *   损坏事件/未知必需事件版本/水位断档显式 corrupt（带 sequence 定位，不回显
 *   行列原文），空批次零写入；事件事实源是持久审计表，不是 SSE/内存回调。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PublicError } from '../../ports/commands.js';
import { mapStateEvent } from '../../ports/events.js';
import {
  DEFAULT_NOTIFICATION_DELIVERY_POLICY,
  NOTIFICATION_DELIVERY_CREATE_OPERATION,
  NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS,
  NOTIFICATION_DELIVERY_CLAIM_OPERATION,
  NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION,
  NOTIFICATION_DELIVERY_CLAIM_BATCH_DEFAULT,
  NOTIFICATION_DELIVERY_CLAIM_LEASE_MS,
  NOTIFICATION_DELIVERY_CLAIM_MAX_LEASE_MS,
  NOTIFICATION_DELIVERY_CLAIM_MIN_LEASE_MS,
  NOTIFICATION_DELIVERY_RESULT_READ_OPERATION,
  NOTIFICATION_DELIVERY_POLICY_VERSION,
  NOTIFICATION_DELIVERY_READ_OPERATION,
  NOTIFICATION_DELIVERY_RESULT_OPERATION,
  NOTIFICATION_DELIVERY_SCAN_OPERATION,
  NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_PROJECTION_OPERATION,
  canonicalNotificationJson,
  computeNotificationPolicyDigest,
  computeNotificationRetryDelayMs,
  deriveNotificationSummary,
  notificationDeliveryCorrupt,
  validateNotificationDeliveryCreateInput,
  validateNotificationDeliveryClaimInput,
  validateNotificationDeliveryClaimReleaseInput,
  validateNotificationDeliveryResultReadInput,
  validateNotificationDeliveryResultInput,
  validateNotificationScanAdvanceInput,
  validateNotificationProjectionBatchRequest,
  validateNotificationChannelId,
  validateNotificationSummary,
  type NotificationDeliveryClaimResult,
  type NotificationDeliveryRecord,
  type NotificationDeliveryResultRecord,
  type NotificationDeliveryResultInput,
  type NotificationDeliveryClaimReleaseInput,
  type NotificationDeliveryStore,
  type NotificationDeliveryWriteResult,
  type NotificationProjectionBatchResult,
  type NotificationScanStateRecord,
} from '../../ports/notification-delivery.js';
import { StorageError } from '../../ports/errors.js';
import type { MaintenanceWriteGate } from '../../ports/data-maintenance.js';
import { validationError, type ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

type DeliveryRow = {
  id: string; revision: number; created_at: number; updated_at: number;
  project_id: string; event_id: string; channel_id: string; event_sequence: number; event_type: string;
  summary_json: string; status: string; attempt_count: number; next_attempt_at: number;
  policy_version: number; policy_digest: string; claim_generation: number;
  claim_owner: string | null; claim_until_at: number | null; last_receipt: string | null;
};

type ResultRow = {
  id: string; created_at: number; project_id: string; delivery_id: string; attempt: number;
  outcome: string; receipt: string | null; failure_reason: string | null; occurred_at: number;
};

/** F-009 查询面复用的行类型/映射导出（只读；不重复第二套规则）。 */
export type NotificationDeliveryRow = DeliveryRow;
export type NotificationResultRow = ResultRow;
export const mapNotificationDeliveryRow = mapDeliveryRow;
export const mapNotificationResultRow = mapResultRow;

function mapResultRow(row: ResultRow): NotificationDeliveryResultRecord {
  if (row.outcome !== 'succeeded' && row.outcome !== 'failed') throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_READ_OPERATION, 'unknown_result_outcome');
  if (!Number.isSafeInteger(row.attempt) || row.attempt < 1 || row.attempt > 16 || !Number.isSafeInteger(row.occurred_at) || row.occurred_at < 1) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_READ_OPERATION, 'invalid_result_row');
  const receipt = row.receipt === null ? null : parseJsonObject(row.receipt, NOTIFICATION_DELIVERY_RESULT_READ_OPERATION, 'invalid_result_receipt');
  if (row.outcome === 'succeeded' && (receipt === null || row.failure_reason !== null)) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_READ_OPERATION, 'invalid_success_result_shape');
  if (row.outcome === 'failed' && (receipt !== null || typeof row.failure_reason !== 'string')) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_READ_OPERATION, 'invalid_failure_result_shape');
  return { schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION, resultId: row.id, projectId: row.project_id,
    deliveryId: row.delivery_id, attempt: row.attempt, outcome: row.outcome, receipt,
    failureReason: row.failure_reason, occurredAt: row.occurred_at };
}

type ScanRow = {
  channel_id: string; revision: number; created_at: number; updated_at: number; last_scanned_sequence: number;
};

/** F-006：投影扫描的 state_events 行（列名与查询存储同一形态）。 */
type ScanEventRow = {
  id: string; sequence: number; event_type: string; aggregate_type: string; aggregate_id: string;
  aggregate_revision: number; project_id: string | null; payload: string; occurred_at: number;
};

function parseJsonObject(value: unknown, operation: string, reason: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'string') throw notificationDeliveryCorrupt(operation, reason);
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw notificationDeliveryCorrupt(operation, reason);
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw notificationDeliveryCorrupt(operation, reason);
  }
}

function mapDeliveryRow(row: DeliveryRow): NotificationDeliveryRecord {
  const status = NOTIFICATION_DELIVERY_STATUSES.find(candidate => candidate === row.status);
  if (status === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'unknown_status');
  if (row.channel_id !== 'local-results') throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'unknown_channel');
  if ((row.claim_owner === null) !== (row.claim_until_at === null)) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_claim_shape');
  if (row.claim_owner !== null && (typeof row.claim_owner !== 'string' || row.claim_owner.length > 128)) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_claim_owner');
  for (const [field, value] of [['revision', row.revision], ['attempt_count', row.attempt_count], ['claim_generation', row.claim_generation], ['event_sequence', row.event_sequence], ['policy_version', row.policy_version], ['next_attempt_at', row.next_attempt_at], ['created_at', row.created_at], ['updated_at', row.updated_at]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, `invalid_${field}`);
  }
  if (row.claim_until_at !== null && (!Number.isSafeInteger(row.claim_until_at) || row.claim_until_at < row.created_at)) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_claim_until_at');
  return {
    schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    deliveryId: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    channelId: row.channel_id,
    eventSequence: row.event_sequence,
    eventType: row.event_type,
    summary: parseJsonObject(row.summary_json, NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_summary_json'),
    status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    claimOwner: row.claim_owner,
    claimUntilAt: row.claim_until_at,
    claimGeneration: row.claim_generation,
    receipt: row.last_receipt === null ? null : parseJsonObject(row.last_receipt, NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_receipt_json'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapScanRow(row: ScanRow): NotificationScanStateRecord {
  if (row.channel_id !== 'local-results') throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'unknown_channel');
  if (!Number.isSafeInteger(row.last_scanned_sequence) || row.last_scanned_sequence < 0 || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, 'invalid_scan_row');
  }
  return {
    schemaVersion: NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    channelId: row.channel_id,
    lastScannedSequence: row.last_scanned_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export interface SqliteNotificationDeliveryStoreOptions {
  readonly session: SqliteStorageSession;
  /** 注入时钟（UTC 毫秒）；缺省 Date.now。 */
  readonly nowUtcMs?: () => number;
  /**
   * P07-4 / F-008：维护门控（可选）。备份/迁移/恢复/项目归档/删除占用期间，
   * 全部通知写事务在提交前 assertCanWrite('notification') busy 拒绝，
   * 不因新增通知写入破坏一致性快照；只读入口不经过该门控。
   */
  readonly maintenanceGate?: MaintenanceWriteGate;
}

/** 独立通知写模型装配：所有入口先经端口校验，再进单事务原子写入。 */
export function createSqliteNotificationDeliveryStore(options: SqliteNotificationDeliveryStoreOptions): NotificationDeliveryStore {
  const { session } = options;
  const now = options.nowUtcMs ?? Date.now;
  const maintenanceGate = options.maintenanceGate;
  /** 写事务内的维护门控检查（占用期间一致性快照不被通知写入穿透）。 */
  const assertWritable = (): void => maintenanceGate?.assertCanWrite('notification');
  const readContext = (operation: string): ValidationContext => ({ operation });

  function conflict(operation: string, reason: string, deliveryId?: string): StorageError {
    return new StorageError('conflict', operation, `通知投递状态机拒绝写入：${reason}`, {
      ...(deliveryId === undefined ? {} : { entity: { type: 'notification_delivery', id: deliveryId } }),
      details: { reason },
    });
  }

  /**
   * 事务内幂等插入 delivery（createDelivery 与 F-006 投影共用）：项目归属由
   * 源 state_events 行在当前写事务内权威派生；(event_id,channel_id) 已存在时
   * 同摘要幂等返回既有行，摘要变化冲突拒绝。
   */
  function insertDeliveryInTransaction(
    db: Database.Database,
    operation: string,
    eventId: string,
    channelId: string,
    summary: Readonly<Record<string, unknown>>,
    timestamp: number,
  ): NotificationDeliveryWriteResult {
    const existing = db.prepare<[string, string], DeliveryRow>(
      'SELECT * FROM notification_deliveries WHERE event_id = ? AND channel_id = ?',
    ).get(eventId, channelId);
    if (existing !== undefined) {
      // 幂等：同 (event,channel) 同摘要（规范化比较）返回既有行；摘要变化冲突。
      const existingSummary = parseJsonObject(existing.summary_json, operation, 'invalid_summary_json');
      if (canonicalNotificationJson(existingSummary) !== canonicalNotificationJson(summary)) {
        throw conflict(operation, 'summary_mismatch', existing.id);
      }
      return { created: false, delivery: mapDeliveryRow(existing) };
    }
    const event = db.prepare<[string], { project_id: string | null; sequence: number; event_type: string; occurred_at: number }>(
      'SELECT project_id, sequence, event_type, occurred_at FROM state_events WHERE id = ?',
    ).get(eventId);
    if (event === undefined) {
      throw new StorageError('not_found', operation, `事件 ${eventId} 不存在`, {
        entity: { type: 'state_event', id: eventId },
      });
    }
    const context = readContext(operation);
    if (event.project_id === null) {
      throw validationError(context, 'eventId', 'event_not_project_scoped', eventId);
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.event_type !== 'string' || event.event_type.length === 0) {
      throw notificationDeliveryCorrupt(operation, 'invalid_event_row');
    }
    // 时间一致性：delivery 不得早于源事件发生时间（时钟回退是环境异常，冲突拒绝）。
    if (!Number.isSafeInteger(timestamp) || timestamp < event.occurred_at) {
      throw conflict(operation, 'non_monotonic_time');
    }
    const deliveryId = randomUUID();
    const summaryJson = canonicalNotificationJson(summary);
    db.prepare(
      'INSERT INTO notification_deliveries (id, revision, created_at, updated_at, project_id, event_id, channel_id, event_sequence, event_type, summary_json, status, attempt_count, next_attempt_at, policy_version, policy_digest, claim_generation, last_receipt) ' +
        "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0, NULL)",
    ).run(
      deliveryId, timestamp, timestamp, event.project_id, eventId, channelId,
      event.sequence, event.event_type, summaryJson, timestamp,
      NOTIFICATION_DELIVERY_POLICY_VERSION, computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY),
    );
    const row = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
    if (row === undefined) throw notificationDeliveryCorrupt(operation, 'insert_missing');
    return { created: true, delivery: mapDeliveryRow(row) };
  }

  function createDelivery(input: unknown): NotificationDeliveryWriteResult {
    const request = validateNotificationDeliveryCreateInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_CREATE_OPERATION, (db) => {
      assertWritable();
      return insertDeliveryInTransaction(
        db, NOTIFICATION_DELIVERY_CREATE_OPERATION, request.eventId, request.channelId, request.summary, now(),
      );
    });
  }

  function recordDeliveryResult(input: unknown): NotificationDeliveryRecord {
    const request: NotificationDeliveryResultInput = validateNotificationDeliveryResultInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_RESULT_OPERATION, (db) => {
      assertWritable();
      const timestamp = now();
      const context = readContext(NOTIFICATION_DELIVERY_RESULT_OPERATION);
      // 输入级退避界检查（只依赖时钟，不依赖行状态）：写入前拒绝超界/非未来延迟。
      if (request.outcome === 'failed' && request.nextAttemptAt !== undefined) {
        if (request.nextAttemptAt <= timestamp) {
          throw validationError(context, 'nextAttemptAt', 'retry_delay_not_in_future');
        }
        if (request.nextAttemptAt > timestamp + NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS) {
          throw validationError(context, 'nextAttemptAt', 'retry_delay_out_of_bounds');
        }
      }
      const row = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(request.deliveryId);
      if (row === undefined) {
        throw new StorageError('not_found', NOTIFICATION_DELIVERY_RESULT_OPERATION, `投递 ${request.deliveryId} 不存在`, {
          entity: { type: 'notification_delivery', id: request.deliveryId },
        });
      }
      const existingResult = db.prepare<[string, number], ResultRow>('SELECT * FROM notification_delivery_results WHERE delivery_id = ? AND attempt = ?').get(request.deliveryId, request.attempt);
      if (existingResult !== undefined) {
        const mapped = mapResultRow(existingResult);
        const same = mapped.outcome === request.outcome
          && mapped.failureReason === (request.outcome === 'failed' ? request.failureReason : null)
          && canonicalNotificationJson(mapped.receipt ?? {}) === canonicalNotificationJson(request.receipt ?? {});
        if (!same) throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'result_identity_conflict', request.deliveryId);
        return mapDeliveryRow(row);
      }
      if (row.status === 'delivered' || row.status === 'exhausted') {
        throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'terminal_status', request.deliveryId);
      }
      const expectedAttempt = row.status === 'in_flight' ? row.attempt_count : row.attempt_count + 1;
      if (request.attempt !== expectedAttempt) {
        throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'out_of_order_result', request.deliveryId);
      }
      if (request.claimGeneration !== row.claim_generation) {
        throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'stale_claim_generation', request.deliveryId);
      }
      if (row.policy_version !== NOTIFICATION_DELIVERY_POLICY_VERSION || row.policy_digest !== computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY)) {
        throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'unsupported_policy_on_record');
      }
      // 时间一致性：结果不得早于 delivery 创建（时钟回退拒绝）。
      if (!Number.isSafeInteger(timestamp) || timestamp < row.created_at) {
        throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'non_monotonic_time', request.deliveryId);
      }
      let status: string;
      let nextAttemptAt = row.next_attempt_at;
      if (request.outcome === 'succeeded') {
        status = 'delivered';
      } else {
        if (request.attempt >= DEFAULT_NOTIFICATION_DELIVERY_POLICY.maxAttempts) {
          if (request.nextAttemptAt !== undefined) {
            throw validationError(context, 'nextAttemptAt', 'next_attempt_not_allowed');
          }
          status = 'exhausted';
        } else {
          status = 'retry_scheduled';
          nextAttemptAt = request.nextAttemptAt === undefined
            ? timestamp + computeNotificationRetryDelayMs(DEFAULT_NOTIFICATION_DELIVERY_POLICY, request.attempt)
            : request.nextAttemptAt;
        }
      }
      const receiptJson = request.outcome === 'succeeded' ? canonicalNotificationJson(request.receipt as Readonly<Record<string, unknown>>) : null;
      db.prepare(
        'UPDATE notification_deliveries SET revision = revision + 1, updated_at = ?, status = ?, attempt_count = ?, next_attempt_at = ?, claim_owner = NULL, claim_until_at = NULL, last_receipt = ? WHERE id = ?',
      ).run(timestamp, status, request.attempt, nextAttemptAt, receiptJson, request.deliveryId);
      db.prepare(
        'INSERT INTO notification_delivery_results (id, created_at, project_id, delivery_id, attempt, outcome, receipt, failure_reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        randomUUID(), timestamp, row.project_id, request.deliveryId, request.attempt, request.outcome,
        receiptJson, request.outcome === 'failed' ? request.failureReason ?? null : null, timestamp,
      );
      const updated = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(request.deliveryId);
      if (updated === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'update_missing');
      return mapDeliveryRow(updated);
    });
  }

  function readDeliveryResult(input: unknown): NotificationDeliveryResultRecord | null {
    const request = validateNotificationDeliveryResultReadInput(input);
    const row = session.database.prepare<[string, number], ResultRow>(
      'SELECT * FROM notification_delivery_results WHERE delivery_id = ? AND attempt = ?',
    ).get(request.deliveryId, request.attempt);
    return row === undefined ? null : mapResultRow(row);
  }

  function claimDueDeliveries(input: unknown): NotificationDeliveryClaimResult {
    const request = validateNotificationDeliveryClaimInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_CLAIM_OPERATION, (db) => {
      assertWritable();
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw conflict(NOTIFICATION_DELIVERY_CLAIM_OPERATION, 'invalid_clock');
      // P07-4 / F-008：项目生命周期门控——只认领 active 项目的 delivery；
      // 归档/删除中的项目是禁止投递目标，事实行保留待项目状态恢复。
      const rows = db.prepare<[string, number, number], DeliveryRow>(
        "SELECT d.* FROM notification_deliveries d JOIN projects p ON p.id = d.project_id " +
        "WHERE d.channel_id = ? AND d.status IN ('pending','retry_scheduled') AND d.next_attempt_at <= ? " +
        "AND p.status = 'active' ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?",
      ).all(request.channelId, timestamp, request.limit);
      const deliveries: NotificationDeliveryRecord[] = [];
      for (const row of rows) {
        if (row.attempt_count >= DEFAULT_NOTIFICATION_DELIVERY_POLICY.maxAttempts) {
          throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_CLAIM_OPERATION, 'retry_row_at_attempt_limit');
        }
        const until = timestamp + request.leaseMs;
        db.prepare(
          'UPDATE notification_deliveries SET revision = revision + 1, updated_at = ?, status = \'in_flight\', attempt_count = attempt_count + 1, claim_generation = claim_generation + 1, claim_owner = ?, claim_until_at = ? WHERE id = ? AND status IN (\'pending\',\'retry_scheduled\')',
        ).run(timestamp, request.owner, until, row.id);
        const claimed = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(row.id);
        if (claimed === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_CLAIM_OPERATION, 'claim_missing');
        deliveries.push(mapDeliveryRow(claimed));
      }
      return { channelId: request.channelId, owner: request.owner, deliveries };
    });
  }

  function releaseDeliveryClaim(input: unknown): NotificationDeliveryRecord {
    const request: NotificationDeliveryClaimReleaseInput = validateNotificationDeliveryClaimReleaseInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, (db) => {
      assertWritable();
      const timestamp = now();
      const row = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(request.deliveryId);
      if (row === undefined) throw new StorageError('not_found', NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, '投递不存在', { entity: { type: 'notification_delivery', id: request.deliveryId } });
      if (!request.confirmedStopped) throw conflict(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, 'stop_unconfirmed', request.deliveryId);
      if (row.status !== 'in_flight') throw conflict(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, 'not_in_flight', request.deliveryId);
      if (row.claim_owner !== request.owner) throw conflict(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, 'stale_claim_owner', request.deliveryId);
      if (row.claim_generation !== request.claimGeneration) throw conflict(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, 'stale_claim_generation', request.deliveryId);
      const status = row.attempt_count >= DEFAULT_NOTIFICATION_DELIVERY_POLICY.maxAttempts ? 'exhausted' : 'retry_scheduled';
      db.prepare('UPDATE notification_deliveries SET revision = revision + 1, updated_at = ?, status = ?, next_attempt_at = ?, claim_owner = NULL, claim_until_at = NULL WHERE id = ?')
        .run(timestamp, status, timestamp, request.deliveryId);
      const updated = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(request.deliveryId);
      if (updated === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_CLAIM_RELEASE_OPERATION, 'release_missing');
      return mapDeliveryRow(updated);
    });
  }


  function upsertScanStateInTransaction(
    db: Database.Database,
    operation: string,
    channelId: string,
    lastScannedSequence: number,
    timestamp: number,
  ): void {
    const existing = db.prepare<[string], ScanRow>('SELECT * FROM notification_scan_state WHERE channel_id = ?').get(channelId);
    if (existing === undefined) {
      db.prepare(
        'INSERT INTO notification_scan_state (channel_id, revision, created_at, updated_at, last_scanned_sequence) VALUES (?, 1, ?, ?, ?)',
      ).run(channelId, timestamp, timestamp, lastScannedSequence);
      return;
    }
    if (lastScannedSequence < existing.last_scanned_sequence) {
      throw conflict(operation, 'watermark_regression');
    }
    if (lastScannedSequence === existing.last_scanned_sequence) {
      return;
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < existing.created_at) {
      throw conflict(operation, 'non_monotonic_time');
    }
    db.prepare(
      'UPDATE notification_scan_state SET revision = revision + 1, updated_at = ?, last_scanned_sequence = ? WHERE channel_id = ?',
    ).run(timestamp, lastScannedSequence, channelId);
  }

  function advanceScanState(input: unknown): NotificationScanStateRecord {
    const request = validateNotificationScanAdvanceInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_SCAN_OPERATION, (db) => {
      assertWritable();
      const timestamp = now();
      const maxRow = db.prepare<[], { max: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS max FROM state_events').get();
      const maxSequence = Number(maxRow?.max);
      if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
        throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'invalid_event_watermark');
      }
      if (request.lastScannedSequence > maxSequence) {
        throw conflict(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'sequence_beyond_event_watermark');
      }
      upsertScanStateInTransaction(db, NOTIFICATION_DELIVERY_SCAN_OPERATION, request.channelId, request.lastScannedSequence, timestamp);
      const updated = db.prepare<[string], ScanRow>('SELECT * FROM notification_scan_state WHERE channel_id = ?').get(request.channelId);
      if (updated === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'upsert_missing');
      return mapScanRow(updated);
    });
  }

  function readDelivery(input: unknown): NotificationDeliveryRecord {
    const context = readContext(NOTIFICATION_DELIVERY_READ_OPERATION);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw validationError(context, 'request', '必须是 JSON 对象', input);
    }
    const deliveryId = (input as Record<string, unknown>).deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0 || deliveryId.length > 128) {
      throw validationError(context, 'deliveryId', 'invalid_delivery_id', deliveryId);
    }
    const row = session.database.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
    if (row === undefined) {
      throw new StorageError('not_found', NOTIFICATION_DELIVERY_READ_OPERATION, `投递 ${deliveryId} 不存在`, {
        entity: { type: 'notification_delivery', id: deliveryId },
      });
    }
    return mapDeliveryRow(row);
  }

  function readScanState(input: unknown): NotificationScanStateRecord | null {
    const context = readContext(NOTIFICATION_DELIVERY_READ_OPERATION);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw validationError(context, 'request', '必须是 JSON 对象', input);
    }
    const channelId = validateNotificationChannelId((input as Record<string, unknown>).channelId, context, 'channelId');
    const row = session.database.prepare<[string], ScanRow>('SELECT * FROM notification_scan_state WHERE channel_id = ?').get(channelId);
    return row === undefined ? null : mapScanRow(row);
  }

  /** 投影扫描行 → 公开事件（白名单/形状校验；损坏显式失败、不回显原文）。 */
  function mapScannedEvent(row: ScanEventRow): ReturnType<typeof mapStateEvent> {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw notificationDeliveryCorrupt(NOTIFICATION_PROJECTION_OPERATION, 'event_payload_not_json');
    }
    try {
      return mapStateEvent({
        id: row.id,
        sequence: row.sequence,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateRevision: row.aggregate_revision,
        projectId: row.project_id,
        payload,
        occurredAtUtcMs: row.occurred_at,
      }, NOTIFICATION_PROJECTION_OPERATION);
    } catch (error) {
      // 损坏/未知必需事件版本：定位到 sequence 进入可诊断状态，不携带行列原文。
      if (error instanceof PublicError && error.code === 'corrupt_state') {
        throw new StorageError('corrupt', NOTIFICATION_PROJECTION_OPERATION,
          '事件投影中止：持久事件行超出公开契约（详见 reason/sequence，不回显原文）', {
            details: { reason: 'event_mapping_failed', cause: error.details?.reason ?? 'unknown', sequence: row.sequence },
          });
      }
      throw error;
    }
  }

  /**
   * F-006 单短事务投影：有界扫描 → 订阅事件幂等建 delivery → 消费水位同事务
   * 原子推进。空批次零写入；损坏事件/水位断档 fail-closed，事务整体回滚，
   * 已推进水位不受影响；重复扫描/重放依赖 (event_id,channel_id) 唯一约束与
   * 幂等插入，两个投影者给终只保留一条 delivery。
   */
  function projectNotificationBatch(input: unknown): NotificationProjectionBatchResult {
    const request = validateNotificationProjectionBatchRequest(input);
    return session.transactWrite(NOTIFICATION_PROJECTION_OPERATION, (db) => {
      assertWritable();
      const timestamp = now();
      // 1) 持久消费水位（未建立按 0；损坏 fail-closed）。
      const existingScan = db.prepare<[string], ScanRow>(
        'SELECT * FROM notification_scan_state WHERE channel_id = ?',
      ).get(request.channelId);
      const watermark = existingScan === undefined ? 0 : existingScan.last_scanned_sequence;
      if (!Number.isSafeInteger(watermark) || watermark < 0) {
        throw notificationDeliveryCorrupt(NOTIFICATION_PROJECTION_OPERATION, 'invalid_scan_watermark');
      }
      // 2) 水位断档：消费水位超前真实事件日志（如恢复旧备份/库被替换）显式可诊断。
      const maxRow = db.prepare<[], { max: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS max FROM state_events').get();
      const maxSequence = Number(maxRow?.max);
      if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
        throw notificationDeliveryCorrupt(NOTIFICATION_PROJECTION_OPERATION, 'invalid_event_watermark');
      }
      if (watermark > maxSequence) {
        throw notificationDeliveryCorrupt(NOTIFICATION_PROJECTION_OPERATION, 'watermark_beyond_event_log');
      }
      // 3) 有界扫描（sequence 升序、排他下界，与公开补读同一谓词；不建内存队列）。
      const rows = db.prepare<[number, number], ScanEventRow>(
        'SELECT id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, project_id, payload, occurred_at ' +
          'FROM state_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?',
      ).all(watermark, request.batchSize);
      if (rows.length === 0) {
        // 空批次：零写入（水位/revision/行数均不变）。
        return {
          channelId: request.channelId,
          lastScannedSequence: watermark,
          scannedCount: 0,
          createdDeliveries: [],
          moreAvailable: false,
        };
      }
      // 4) 逐行白名单/形状核验 + 脱敏摘要派生；非订阅事件只推进扫描位置。
      const context = readContext(NOTIFICATION_PROJECTION_OPERATION);
      const created: NotificationDeliveryRecord[] = [];
      for (const row of rows) {
        const event = mapScannedEvent(row);
        const summary = deriveNotificationSummary(event);
        if (summary === null) {
          continue;
        }
        // 防御性摘要上界核验（派生路径只产冻结词汇；越界属编程错误，fail-closed）。
        validateNotificationSummary(summary, context, 'summary');
        const result = insertDeliveryInTransaction(db, NOTIFICATION_PROJECTION_OPERATION, event.eventId, request.channelId, summary, timestamp);
        if (result.created) {
          created.push(result.delivery);
        }
      }
      // 5) 消费水位与 delivery 同事务推进（同值幂等零变更）。
      const newWatermark = rows[rows.length - 1]!.sequence;
      if (!Number.isSafeInteger(newWatermark) || newWatermark < 1) {
        throw notificationDeliveryCorrupt(NOTIFICATION_PROJECTION_OPERATION, 'invalid_batch_watermark');
      }
      upsertScanStateInTransaction(db, NOTIFICATION_PROJECTION_OPERATION, request.channelId, newWatermark, timestamp);
      return {
        channelId: request.channelId,
        lastScannedSequence: newWatermark,
        scannedCount: rows.length,
        createdDeliveries: created,
        moreAvailable: rows.length >= request.batchSize,
      };
    });
  }

  return Object.freeze({
    createDelivery,
    recordDeliveryResult,
    readDeliveryResult,
    claimDueDeliveries,
    releaseDeliveryClaim,
    advanceScanState,
    readDelivery,
    readScanState,
    projectNotificationBatch,
  });
}
