/**
 * P07-4 / F-009 本地通知与 delivery 发送状态只读查询契约（ports 纯契约层）。
 *
 * 协议依据：p07-result-notifications PRD FR-2（输出发送状态）与 FR-1 权限
 * 边界、设计 08 §2/§4/§5.1（Host/CLI 查询契约）。事实源是 F-004 交付的
 * notification_deliveries / notification_delivery_results 持久行；本端口
 * 只做形状校验、冻结词汇与确定性派生，不建立第二套可写状态。
 *
 * 不变量：
 * - 查询面零写入、零事件、零唤醒：不创建 delivery、不认领、不记录结果、
 *   不触发重试或业务重跑；重复读取不增加计数、不改 revision；
 * - 发送状态词汇与 NOTIFICATION_DELIVERY_STATUSES 同源（pending/in_flight/
 *   delivered/retry_scheduled/exhausted），用户可区分等待发送、正在发送、
 *   待重试、已发送与停止重试；详细执行审计沿稳定 deliveryId 引用；
 * - 「适用实体」由脱敏摘要确定性派生（task_terminal/task_action_required →
 *   Task、run_ended → Run、feature_finalized(_blocked) → Feature）；摘要
 *   形态超出冻结派生结果是持久损坏 fail-closed（corrupt），不猜测量化；
 * - 列表复用计划分页同一规范：limit 默认 50 / 上限 200、plcur_v1_ 受控游标
 *   （绑定数据根 + 项目 + 实体/状态筛选范围，跨项目/跨筛选/跨根重放一律
 *   invalid_cursor）；排序键（event_sequence, delivery id）复合键集分页；
 * - 跨项目/不存在统一 undefined（应用层折叠 not_found，不区分存在性）；
 *   本端口不授予受限 Agent 任何管理权限（认领/释放/记录结果不在查询面）。
 */
import { WIRE_MESSAGE_SCHEMA_VERSION } from './commands.js';
import { StorageError } from './errors.js';
import {
  NOTIFICATION_DELIVERY_STATUSES,
  type NotificationChannelId,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryRecord,
  type NotificationDeliveryResultRecord,
  type NotificationDeliveryStatus,
} from './notification-delivery.js';
import { validateStableId, validationError } from './validation.js';
import type { ValidationContext } from './validation.js';

/* ------------------------------------------------------------------ *
 * 查询操作身份（PublicError.operation 与 Host 路由共用）
 * ------------------------------------------------------------------ */

export const NOTIFICATIONS_LIST_OPERATION = 'notifications.list' as const;
export const NOTIFICATIONS_GET_OPERATION = 'notifications.get' as const;

/** 通知列表请求面允许的键（与 Host 查询参数白名单同源）。 */
export const NOTIFICATION_LIST_INPUT_KEYS = [
  'projectId', 'taskId', 'runId', 'featureId', 'status', 'limit', 'cursor',
] as const;

/** 实体筛选键（请求面至多提供一个）。 */
export const NOTIFICATION_ENTITY_KEYS = ['taskId', 'runId', 'featureId'] as const;

/** 已归一化的实体筛选（与游标 scope 的 entityKind/entityId 对应）。 */
export interface NotificationEntityFilter {
  readonly kind: 'task' | 'run' | 'feature';
  readonly id: string;
}

/** 通知列表筛选校验：实体键至多一个、状态必须是冻结词汇（先于读取拒绝）。 */
export function validateNotificationListSelector(
  value: Record<string, unknown>,
  operation: string,
): { readonly entity?: NotificationEntityFilter; readonly status?: NotificationDeliveryStatus } {
  const context: ValidationContext = { operation, entity: { type: 'project' } };
  const provided = NOTIFICATION_ENTITY_KEYS.filter(key => value[key] !== undefined);
  if (provided.length > 1) {
    throw validationError(context, 'selector', 'taskId / runId / featureId 至多提供一个', provided);
  }
  let entity: NotificationEntityFilter | undefined;
  if (provided.length === 1) {
    const key = provided[0]!;
    const id = validateStableId(
      value[key],
      { operation, entity: { type: key === 'taskId' ? 'task' : key === 'runId' ? 'run' : 'feature' } },
      key,
    );
    entity = { kind: key === 'taskId' ? 'task' : key === 'runId' ? 'run' : 'feature', id };
  }
  let status: NotificationDeliveryStatus | undefined;
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !(NOTIFICATION_DELIVERY_STATUSES as readonly string[]).includes(value.status)) {
      throw validationError(context, 'status', 'unsupported_status', value.status);
    }
    status = value.status as NotificationDeliveryStatus;
  }
  return {
    ...(entity === undefined ? {} : { entity }),
    ...(status === undefined ? {} : { status }),
  };
}

/* ------------------------------------------------------------------ *
 * 适用实体派生（纯函数；摘要超出冻结派生形状 → 持久损坏）
 * ------------------------------------------------------------------ */

/** 摘要 kind → 实体类别（与 deriveNotificationSummary 的冻结输出同源）。 */
const NOTIFICATION_SUMMARY_ENTITY_KINDS = {
  task_terminal: 'task',
  task_action_required: 'task',
  run_ended: 'run',
  feature_finalized: 'feature',
  feature_finalization_blocked: 'feature',
} as const;

const NOTIFICATION_ENTITY_ID_KEYS = {
  task: 'taskId',
  run: 'runId',
  feature: 'featureId',
} as const;

export function deriveNotificationEntity(
  summary: Readonly<Record<string, unknown>>,
  operation: string,
): NotificationEntityFilter {
  const kind = summary.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(NOTIFICATION_SUMMARY_ENTITY_KINDS, kind)) {
    throw new StorageError('corrupt', operation, '通知摘要 kind 超出冻结派生词汇（持久行损坏）', {
      details: { reason: 'unknown_summary_kind' },
    });
  }
  const entityKind = NOTIFICATION_SUMMARY_ENTITY_KINDS[kind as keyof typeof NOTIFICATION_SUMMARY_ENTITY_KINDS];
  const idKey = NOTIFICATION_ENTITY_ID_KEYS[entityKind];
  const id = summary[idKey];
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new StorageError('corrupt', operation, `通知摘要 ${idKey} 缺失或形态损坏`, {
      details: { reason: 'invalid_summary_entity_id' },
    });
  }
  return { kind: entityKind, id };
}

/* ------------------------------------------------------------------ *
 * 列表/详情读取窄端口（adapters 层实现；只读）
 * ------------------------------------------------------------------ */

/** 列表复合排序键（event_sequence, delivery id；键集分页排他下界）。 */
export interface NotificationListCursorKey {
  readonly eventSequence: number;
  readonly deliveryId: string;
}

/** 列表行：持久 delivery + 最近一次尝试结果轴（最后一次尝试的结果/原因）。 */
export interface NotificationDeliveryListRow {
  readonly delivery: NotificationDeliveryRecord;
  /** 最近一次已记录尝试的结果；尚无尝试（pending）为 null。 */
  readonly lastOutcome: NotificationDeliveryOutcome | null;
  /** 最近一次尝试失败时的原因；成功或无尝试为 null。 */
  readonly lastFailureReason: string | null;
}

export interface NotificationListRequest {
  readonly after: NotificationListCursorKey | null;
  readonly limit: number;
  readonly entity?: NotificationEntityFilter;
  readonly status?: NotificationDeliveryStatus;
}

export interface NotificationDeliveryPage {
  readonly rows: readonly NotificationDeliveryListRow[];
  readonly nextKey: NotificationListCursorKey | null;
}

/** 详情视图：delivery + 有界执行审计（本地结果链，attempt 升序）。 */
export interface NotificationDeliveryDetail {
  readonly delivery: NotificationDeliveryRecord;
  readonly lastOutcome: NotificationDeliveryOutcome | null;
  readonly lastFailureReason: string | null;
  readonly results: readonly NotificationDeliveryResultRecord[];
}

export interface NotificationQueryReadStore {
  /** 项目范围分页列表（实体/状态筛选下推 SQL；跨项目行不可见）。 */
  listNotificationDeliveries(projectId: unknown, request: NotificationListRequest): NotificationDeliveryPage;
  /** 点读详情 + 执行审计；不存在/跨项目统一 undefined（存在性折叠在应用层）。 */
  readNotificationDelivery(projectId: unknown, deliveryId: string): NotificationDeliveryDetail | undefined;
}

/* ------------------------------------------------------------------ *
 * 公开投影（Host wire / CLI 同源；未知保持 null，不以 0 冒充）
 * ------------------------------------------------------------------ */

export interface PublicNotificationDeliveryRecord {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly channelId: NotificationChannelId;
  readonly eventType: string;
  readonly eventSequence: number;
  readonly entity: NotificationEntityFilter;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly status: NotificationDeliveryStatus;
  readonly attemptCount: number;
  readonly lastOutcome: NotificationDeliveryOutcome | null;
  readonly lastFailureReason: string | null;
  readonly receipt: Readonly<Record<string, unknown>> | null;
  /** 下次尝试时间（ISO UTC）；仅等待发送/待重试有意义，其余为 null。 */
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicNotificationDeliveryAttempt {
  readonly attempt: number;
  readonly outcome: NotificationDeliveryOutcome;
  readonly receipt: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly occurredAt: string;
}

export interface NotificationDeliveryListResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'notifications';
  /** 已归一化筛选回显（实体/状态与请求一致；游标绑定同一范围）。 */
  readonly filter: { readonly entity?: NotificationEntityFilter; readonly status?: NotificationDeliveryStatus };
  readonly records: readonly PublicNotificationDeliveryRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface NotificationDeliveryDetailResult {
  readonly schemaVersion: typeof WIRE_MESSAGE_SCHEMA_VERSION;
  readonly scope: 'notification';
  readonly delivery: PublicNotificationDeliveryRecord;
  /** 执行审计：本地结果链（attempt 升序；有界 ≤ 次数硬上限）。 */
  readonly attempts: readonly PublicNotificationDeliveryAttempt[];
}

/** 列表/详情行 → 公开记录投影（时间 ISO UTC；终态/发送中无下次尝试保持 null）。 */
export function toPublicNotificationDeliveryRecord(
  row: NotificationDeliveryListRow | NotificationDeliveryDetail,
  operation: string,
): PublicNotificationDeliveryRecord {
  const delivery = row.delivery;
  return {
    deliveryId: delivery.deliveryId,
    eventId: delivery.eventId,
    channelId: delivery.channelId,
    eventType: delivery.eventType,
    eventSequence: delivery.eventSequence,
    entity: deriveNotificationEntity(delivery.summary, operation),
    summary: delivery.summary,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    lastOutcome: row.lastOutcome,
    lastFailureReason: row.lastFailureReason,
    receipt: delivery.receipt,
    nextAttemptAt: delivery.status === 'pending' || delivery.status === 'retry_scheduled'
      ? new Date(delivery.nextAttemptAt).toISOString()
      : null,
    createdAt: new Date(delivery.createdAt).toISOString(),
    updatedAt: new Date(delivery.updatedAt).toISOString(),
  };
}
