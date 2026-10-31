/**
 * P07-4 / F-009 通知与 delivery 发送状态 CLI 投影（纯面层；无 I/O）。
 *
 * 将 notifications.list / notifications.get 的结构化查询结果投影为文本输出
 * （JSON 信封直接携带查询结果原文，保留 null/未知字段）：
 * - 发送状态清楚区分等待发送（pending）/正在发送（in_flight）/待重试
 *   （retry_scheduled）/已发送（delivered）/停止重试（exhausted）；
 * - 时间一律 ISO UTC（nextAttemptAt 仅等待/待重试有意义，其余 unknown）；
 *   次数原样展示；未知字段保持 unknown，不以 0 冒充；
 * - 引用只展示稳定身份（deliveryId/eventId/实体 ID）；摘要/回执是投影端
 *   已脱敏的冻结摘要（有界），不出现数据根、locator 或凭据；
 * - 查询只读：不认领、不重试、不改投递状态。
 */
import type { HostClient } from 'shiploop-host';

type NotificationListResult = Awaited<ReturnType<HostClient['listNotifications']>>;
type NotificationDetailResult = Awaited<ReturnType<HostClient['getNotification']>>;
export type NotificationListRecord = NotificationListResult['records'][number];
export type NotificationDetailAttempt = NotificationDetailResult['attempts'][number];

export const NOTIFICATIONS_VIEW_NOTE =
  '发送状态词汇：pending=等待发送，in_flight=正在发送，retry_scheduled=待重试，' +
  'delivered=已发送，exhausted=停止重试；时间 ISO UTC；未知保持 unknown，不以 0 冒充；' +
  '查询只读：不认领、不重试、不改投递状态；摘要/回执为脱敏冻结摘要，不含凭据或数据根。';

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: '等待发送',
  in_flight: '正在发送',
  retry_scheduled: '待重试',
  delivered: '已发送',
  exhausted: '停止重试',
});

function known(value: number | string | boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

function compactJson(value: Readonly<Record<string, unknown>> | null): string {
  return value === null ? 'none' : JSON.stringify(value);
}

function formatSummary(summary: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      parts.push(`${key}=${String(value)}`);
    } else if (typeof value === 'string') {
      parts.push(`${key}=${value}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts.length === 0 ? 'none' : parts.join(' ');
}

export interface NotificationListDisplay {
  readonly operation: 'notifications.list';
  readonly filter: NotificationListResult['filter'];
  readonly records: readonly NotificationListRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly note: string;
}

export interface NotificationDetailDisplay {
  readonly operation: 'notifications.get';
  readonly delivery: NotificationDetailResult['delivery'];
  readonly attempts: readonly NotificationDetailAttempt[];
  readonly note: string;
}

export function buildNotificationsListView(result: NotificationListResult): NotificationListDisplay {
  return {
    operation: 'notifications.list',
    filter: result.filter,
    records: result.records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    note: NOTIFICATIONS_VIEW_NOTE,
  };
}

export function buildNotificationsDetailView(result: NotificationDetailResult): NotificationDetailDisplay {
  return {
    operation: 'notifications.get',
    delivery: result.delivery,
    attempts: result.attempts,
    note: NOTIFICATIONS_VIEW_NOTE,
  };
}

function formatRecord(row: NotificationListRecord): string[] {
  return [
    `  delivery=${row.deliveryId} event=${row.eventId} seq=${row.eventSequence} ` +
      `channel=${row.channelId} type=${row.eventType}`,
    `    entity=${row.entity.kind}:${row.entity.id} status=${row.status}` +
      `（${STATUS_LABELS[row.status] ?? 'unknown'}） attempts=${row.attemptCount} ` +
      `lastOutcome=${known(row.lastOutcome)} lastReason=${row.lastFailureReason ?? 'none'} ` +
      `nextAttempt=${known(row.nextAttemptAt)}`,
    `    receipt=${compactJson(row.receipt)}`,
    `    summary: ${formatSummary(row.summary)}`,
    `    created=${row.createdAt} updated=${row.updatedAt}`,
  ];
}

export function formatNotificationsListView(view: NotificationListDisplay): string {
  const filter = view.filter;
  const filterText = [
    ...(filter.entity === undefined ? [] : [`entity=${filter.entity.kind}:${filter.entity.id}`]),
    ...(filter.status === undefined ? [] : [`status=${filter.status}`]),
  ].join(' ');
  const lines = [
    `shiploop notifications list: records=${view.records.length} ` +
      `nextCursor=${view.nextCursor ?? 'none'} limit=${view.limit} ` +
      `filter=${filterText.length === 0 ? 'none' : filterText}`,
  ];
  for (const row of view.records) lines.push(...formatRecord(row));
  lines.push(`  （${NOTIFICATIONS_VIEW_NOTE}）`, '');
  return lines.join('\n');
}

export function formatNotificationsDetailView(view: NotificationDetailDisplay): string {
  const row = view.delivery;
  const lines = [
    `shiploop notifications get: delivery=${row.deliveryId} event=${row.eventId} ` +
      `channel=${row.channelId} type=${row.eventType} attempts=${view.attempts.length}`,
    ...formatRecord(row),
    `  attempts: ${view.attempts.length === 0 ? 'none（尚未尝试）' : ''}`,
  ];
  for (const attempt of view.attempts) {
    lines.push(`    #${attempt.attempt} outcome=${attempt.outcome} ` +
      `reason=${attempt.failureReason ?? 'none'} occurredAt=${attempt.occurredAt} ` +
      `receipt=${compactJson(attempt.receipt)}`);
  }
  lines.push(`  （${NOTIFICATIONS_VIEW_NOTE}）`, '');
  return lines.join('\n');
}
