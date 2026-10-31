/**
 * P07-4 / F-009 通知与 delivery 发送状态 wire 校验器（纯函数；无 I/O）。
 *
 * 与 result-diagnostics-wire.ts 同一纪律：
 * - 形状按 Core notification-query 公开投影冻结（delivery/event/channel 身份、
 *   适用实体、脱敏摘要、本地回执、发送状态、次数、最近结果/原因、下次尝试
 *   时间与执行审计链）；未知字段、错误 scope、坏游标、records 超出 limit、
 *   行形状与词汇不符一律 response_malformed；schema 版本不符 →
 *   unsupported_schema_version；
 * - 冻结词汇（状态/结果/实体类别）与 Core NOTIFICATION_DELIVERY_STATUSES /
 *   NOTIFICATION_DELIVERY_OUTCOMES 同源，不漂移；摘要/回执只接受有界 JSON
 *   对象（字节上界与 Core 契约一致），不接受任意路径或凭据字段回显；
 * - 未知保持 null（最近结果/原因/下次尝试），不以 0 冒充；列表行按请求
 *   筛选/项目范围不在此重复（详情行归属与请求 deliveryId 逐一复核）。
 */
import { Buffer } from 'node:buffer';
import {
  NOTIFICATION_DELIVERY_OUTCOMES,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_RECEIPT_MAX_BYTES,
  NOTIFICATION_SUMMARY_MAX_BYTES,
  WIRE_MESSAGE_SCHEMA_VERSION,
  isIsoUtcDateTime,
} from 'shiploop-core/protocol';
import type {
  NotificationDeliveryDetailResult,
  NotificationDeliveryListResult,
  PublicNotificationDeliveryAttempt,
} from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const natural: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && Number(v) >= 0;
const positive: Check = v => natural(v) && Number(v) > 0;
const nullable = (check: Check): Check => v => v === null || check(v);
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const boundedJson: Check = v => isPlainObject(v)
  && Buffer.byteLength(JSON.stringify(v), 'utf8') <= NOTIFICATION_SUMMARY_MAX_BYTES;
const receiptJson: Check = v => isPlainObject(v)
  && Buffer.byteLength(JSON.stringify(v), 'utf8') <= NOTIFICATION_RECEIPT_MAX_BYTES;
const reason: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const status = oneOf(NOTIFICATION_DELIVERY_STATUSES);
const outcome = oneOf(NOTIFICATION_DELIVERY_OUTCOMES);
const entity = oneOf(['task', 'run', 'feature']);
const date: Check = v => isIsoUtcDateTime(v);

const record: Check = v => isPlainObject(v)
  && id(v.deliveryId) && id(v.eventId) && v.channelId === 'local-results'
  && typeof v.eventType === 'string' && v.eventType.length > 0 && v.eventType.length <= 64
  && positive(v.eventSequence)
  && isPlainObject(v.entity) && entity(v.entity.kind) && id(v.entity.id)
  && boundedJson(v.summary)
  && status(v.status)
  && natural(v.attemptCount) && Number(v.attemptCount) <= 16
  && nullable(outcome)(v.lastOutcome)
  && nullable(reason)(v.lastFailureReason)
  && nullable(receiptJson)(v.receipt)
  && nullable(date)(v.nextAttemptAt)
  && date(v.createdAt) && date(v.updatedAt);

const attempt: Check = v => isPlainObject(v)
  && positive(v.attempt) && Number(v.attempt) <= 16
  && outcome(v.outcome)
  && nullable(receiptJson)(v.receipt)
  && nullable(reason)(v.failureReason)
  && date(v.occurredAt);

function malformed(operation: HostOperation, reason = 'notification_malformed'): never {
  throw new HostProtocolError('response_malformed', operation, '通知查询响应不符合线协议', { details: { reason } });
}
function validate(operation: HostOperation, value: unknown, check: Check): void {
  if (isPlainObject(value) && value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', operation, '不支持的查询响应版本');
  }
  if (!check(value)) malformed(operation);
}

export function validateNotificationListWire(value: unknown): NotificationDeliveryListResult {
  const operation = 'notifications.list';
  validate(operation, value, v => isPlainObject(v)
    && v.schemaVersion === WIRE_MESSAGE_SCHEMA_VERSION
    && v.scope === 'notifications'
    && (v.filter === undefined || isPlainObject(v.filter)
      && (v.filter.entity === undefined || (isPlainObject(v.filter.entity) && entity(v.filter.entity.kind) && id(v.filter.entity.id)))
      && (v.filter.status === undefined || status(v.filter.status)))
    && Array.isArray(v.records) && v.records.length <= 200 && v.records.every(record)
    && (v.nextCursor === null || (typeof v.nextCursor === 'string' && /^plcur_v1_/.test(v.nextCursor)))
    && positive(v.limit) && Number(v.limit) <= 200);
  const result = value as NotificationDeliveryListResult;
  if (result.records.length > result.limit) malformed(operation, 'notification_malformed');
  return result;
}

export function validateNotificationGetWire(value: unknown): NotificationDeliveryDetailResult {
  const operation = 'notifications.get';
  validate(operation, value, v => isPlainObject(v)
    && v.schemaVersion === WIRE_MESSAGE_SCHEMA_VERSION
    && v.scope === 'notification'
    && record(v.delivery)
    && Array.isArray(v.attempts) && v.attempts.length <= 16 && v.attempts.every(attempt));
  const result = value as NotificationDeliveryDetailResult;
  if (result.attempts.length > result.delivery.attemptCount) {
    malformed(operation, 'notification_malformed');
  }
  // 空审计链不得携带最近结果；末次尝试与最近结果轴逐一对应。
  const last = result.attempts[result.attempts.length - 1] as PublicNotificationDeliveryAttempt | undefined;
  if (last === undefined) {
    if (result.delivery.lastOutcome !== null || result.delivery.lastFailureReason !== null) {
      malformed(operation, 'notification_malformed');
    }
  } else {
    if (result.delivery.lastOutcome !== last.outcome) malformed(operation, 'notification_malformed');
    if (result.delivery.lastFailureReason !== last.failureReason) malformed(operation, 'notification_malformed');
  }
  return result;
}
