/**
 * P07-4 / F-004 独立通知持久模型的 SQLite 适配器（adapters 层）。
 *
 * 纪律（PRD FR-2、设计 03 §3/§5、07 §5）：
 * - 全部写入在单条 BEGIN IMMEDIATE 短事务内完成“原子校验 + 持久化”，拒绝路径
 *   零部分写入；事务内不做网络/文件/长检查；
 * - 项目归属由源 state_events 行在写事务内权威派生，调用方不声明项目；
 *   (project_id,event_id) 同项目复合外键兜底拒绝跨项目/全局事件；
 * - 次数/代次/终态/时间一致性与退避上界在写事务内校验：乱序、迟到代次、
 *   终态覆盖、时钟回退、超界显式退避一律结构化 conflict/validation 拒绝；
 * - 扫描水位单调且不超前当前事件水位（同事务读 MAX(sequence)）；
 * - 行列→记录映射只接受冻结词汇（未知状态/渠道/结果为持久损坏 fail-closed）。
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_NOTIFICATION_DELIVERY_POLICY,
  NOTIFICATION_DELIVERY_CREATE_OPERATION,
  NOTIFICATION_DELIVERY_MAX_RETRY_DELAY_MS,
  NOTIFICATION_DELIVERY_POLICY_VERSION,
  NOTIFICATION_DELIVERY_READ_OPERATION,
  NOTIFICATION_DELIVERY_RESULT_OPERATION,
  NOTIFICATION_DELIVERY_SCAN_OPERATION,
  NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  NOTIFICATION_DELIVERY_STATUSES,
  canonicalNotificationJson,
  computeNotificationPolicyDigest,
  computeNotificationRetryDelayMs,
  notificationDeliveryCorrupt,
  validateNotificationDeliveryCreateInput,
  validateNotificationDeliveryResultInput,
  validateNotificationScanAdvanceInput,
  validateNotificationChannelId,
  type NotificationDeliveryRecord,
  type NotificationDeliveryResultInput,
  type NotificationDeliveryStore,
  type NotificationDeliveryWriteResult,
  type NotificationScanStateRecord,
} from '../../ports/notification-delivery.js';
import { StorageError } from '../../ports/errors.js';
import { validationError, type ValidationContext } from '../../ports/validation.js';
import type { SqliteStorageSession } from './session.js';

type DeliveryRow = {
  id: string; revision: number; created_at: number; updated_at: number;
  project_id: string; event_id: string; channel_id: string; event_sequence: number; event_type: string;
  summary_json: string; status: string; attempt_count: number; next_attempt_at: number;
  policy_version: number; policy_digest: string; claim_generation: number; last_receipt: string | null;
};

type ScanRow = {
  channel_id: string; revision: number; created_at: number; updated_at: number; last_scanned_sequence: number;
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
  for (const [field, value] of [['revision', row.revision], ['attempt_count', row.attempt_count], ['claim_generation', row.claim_generation], ['event_sequence', row.event_sequence], ['policy_version', row.policy_version], ['next_attempt_at', row.next_attempt_at], ['created_at', row.created_at], ['updated_at', row.updated_at]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_READ_OPERATION, `invalid_${field}`);
  }
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
}

/** 独立通知写模型装配：所有入口先经端口校验，再进单事务原子写入。 */
export function createSqliteNotificationDeliveryStore(options: SqliteNotificationDeliveryStoreOptions): NotificationDeliveryStore {
  const { session } = options;
  const now = options.nowUtcMs ?? Date.now;
  const readContext = (operation: string): ValidationContext => ({ operation });

  function conflict(operation: string, reason: string, deliveryId?: string): StorageError {
    return new StorageError('conflict', operation, `通知投递状态机拒绝写入：${reason}`, {
      ...(deliveryId === undefined ? {} : { entity: { type: 'notification_delivery', id: deliveryId } }),
      details: { reason },
    });
  }

  function createDelivery(input: unknown): NotificationDeliveryWriteResult {
    const request = validateNotificationDeliveryCreateInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_CREATE_OPERATION, (db) => {
      const timestamp = now();
      const existing = db.prepare<[string, string], DeliveryRow>(
        'SELECT * FROM notification_deliveries WHERE event_id = ? AND channel_id = ?',
      ).get(request.eventId, request.channelId);
      if (existing !== undefined) {
        // 幂等：同 (event,channel) 同摘要（规范化比较）返回既有行；摘要变化冲突。
        const existingSummary = parseJsonObject(existing.summary_json, NOTIFICATION_DELIVERY_CREATE_OPERATION, 'invalid_summary_json');
        if (canonicalNotificationJson(existingSummary) !== canonicalNotificationJson(request.summary)) {
          throw conflict(NOTIFICATION_DELIVERY_CREATE_OPERATION, 'summary_mismatch', existing.id);
        }
        return { created: false, delivery: mapDeliveryRow(existing) };
      }
      const event = db.prepare<[string], { project_id: string | null; sequence: number; event_type: string; occurred_at: number }>(
        'SELECT project_id, sequence, event_type, occurred_at FROM state_events WHERE id = ?',
      ).get(request.eventId);
      if (event === undefined) {
        throw new StorageError('not_found', NOTIFICATION_DELIVERY_CREATE_OPERATION, `事件 ${request.eventId} 不存在`, {
          entity: { type: 'state_event', id: request.eventId },
        });
      }
      const context = readContext(NOTIFICATION_DELIVERY_CREATE_OPERATION);
      if (event.project_id === null) {
        throw validationError(context, 'eventId', 'event_not_project_scoped', request.eventId);
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || typeof event.event_type !== 'string' || event.event_type.length === 0) {
        throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_CREATE_OPERATION, 'invalid_event_row');
      }
      // 时间一致性：delivery 不得早于源事件发生时间（时钟回退是环境异常，冲突拒绝）。
      if (!Number.isSafeInteger(timestamp) || timestamp < event.occurred_at) {
        throw conflict(NOTIFICATION_DELIVERY_CREATE_OPERATION, 'non_monotonic_time');
      }
      const deliveryId = randomUUID();
      const summaryJson = canonicalNotificationJson(request.summary);
      db.prepare(
        'INSERT INTO notification_deliveries (id, revision, created_at, updated_at, project_id, event_id, channel_id, event_sequence, event_type, summary_json, status, attempt_count, next_attempt_at, policy_version, policy_digest, claim_generation, last_receipt) ' +
          "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0, NULL)",
      ).run(
        deliveryId, timestamp, timestamp, event.project_id, request.eventId, request.channelId,
        event.sequence, event.event_type, summaryJson, timestamp,
        NOTIFICATION_DELIVERY_POLICY_VERSION, computeNotificationPolicyDigest(DEFAULT_NOTIFICATION_DELIVERY_POLICY),
      );
      const row = db.prepare<[string], DeliveryRow>('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
      if (row === undefined) throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_CREATE_OPERATION, 'insert_missing');
      return { created: true, delivery: mapDeliveryRow(row) };
    });
  }

  function recordDeliveryResult(input: unknown): NotificationDeliveryRecord {
    const request: NotificationDeliveryResultInput = validateNotificationDeliveryResultInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_RESULT_OPERATION, (db) => {
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
      if (row.status === 'delivered' || row.status === 'exhausted') {
        throw conflict(NOTIFICATION_DELIVERY_RESULT_OPERATION, 'terminal_status', request.deliveryId);
      }
      if (request.attempt !== row.attempt_count + 1) {
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
        'UPDATE notification_deliveries SET revision = revision + 1, updated_at = ?, status = ?, attempt_count = ?, next_attempt_at = ?, last_receipt = ? WHERE id = ?',
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

  function advanceScanState(input: unknown): NotificationScanStateRecord {
    const request = validateNotificationScanAdvanceInput(input);
    return session.transactWrite(NOTIFICATION_DELIVERY_SCAN_OPERATION, (db) => {
      const timestamp = now();
      const maxRow = db.prepare<[], { max: unknown }>('SELECT COALESCE(MAX(sequence), 0) AS max FROM state_events').get();
      const maxSequence = Number(maxRow?.max);
      if (!Number.isSafeInteger(maxSequence) || maxSequence < 0) {
        throw notificationDeliveryCorrupt(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'invalid_event_watermark');
      }
      if (request.lastScannedSequence > maxSequence) {
        throw conflict(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'sequence_beyond_event_watermark');
      }
      const existing = db.prepare<[string], ScanRow>('SELECT * FROM notification_scan_state WHERE channel_id = ?').get(request.channelId);
      if (existing === undefined) {
        db.prepare(
          'INSERT INTO notification_scan_state (channel_id, revision, created_at, updated_at, last_scanned_sequence) VALUES (?, 1, ?, ?, ?)',
        ).run(request.channelId, timestamp, timestamp, request.lastScannedSequence);
      } else {
        if (request.lastScannedSequence < existing.last_scanned_sequence) {
          throw conflict(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'watermark_regression');
        }
        if (request.lastScannedSequence === existing.last_scanned_sequence) {
          return mapScanRow(existing);
        }
        if (!Number.isSafeInteger(timestamp) || timestamp < existing.created_at) {
          throw conflict(NOTIFICATION_DELIVERY_SCAN_OPERATION, 'non_monotonic_time');
        }
        db.prepare(
          'UPDATE notification_scan_state SET revision = revision + 1, updated_at = ?, last_scanned_sequence = ? WHERE channel_id = ?',
        ).run(timestamp, request.lastScannedSequence, request.channelId);
      }
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

  return Object.freeze({ createDelivery, recordDeliveryResult, advanceScanState, readDelivery, readScanState });
}
