/**
 * P07-4 / F-009 通知与 delivery 发送状态只读查询的 SQLite 装配（adapters 层）。
 *
 * 不变量（与 ports/notification-query.ts 同一契约）：
 * - 整页组装位于单一 BEGIN DEFERRED 一致读事务（复用
 *   transactSqliteConsistentRead）；本模块无任何写原语——不认领、不记录
 *   结果、不推进水位、不写事件、不触发重试或业务执行；
 * - 复用 F-004 写存储的行映射与校验（mapNotificationDeliveryRow /
 *   mapNotificationResultRow），不建立第二套规则；损坏持久行 fail-closed
 *   （StorageError corrupt）；
 * - 项目范围谓词下推 SQL（project_id 先收窄再分页）；实体筛选按冻结摘要
 *   键 json_extract 精确匹配（不接受任意 JSON 路径）；状态筛选按冻结词汇
 *   绑定参数，不拼接 SQL 片段；
 * - 键集分页：复合排序键（event_sequence, delivery id）排他下界、稳定排序；
 *   跨项目/不存在详情统一 undefined（存在性折叠由应用层完成）。
 */
import { StorageError } from '../../ports/errors.js';
import { NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT } from '../../ports/notification-delivery.js';
import type {
  NotificationDeliveryDetail,
  NotificationDeliveryListRow,
  NotificationDeliveryPage,
  NotificationEntityFilter,
  NotificationListRequest,
  NotificationQueryReadStore,
} from '../../ports/notification-query.js';
import { validateStableId } from '../../ports/validation.js';
import {
  mapNotificationDeliveryRow,
  mapNotificationResultRow,
  type NotificationDeliveryRow,
  type NotificationResultRow,
} from './notification-delivery-store.js';
import { transactSqliteConsistentRead } from './state-store.js';
import type { SqliteStorageSession } from './session.js';

const OPERATION = 'NotificationQueryStore';

/** 实体类别 → 冻结摘要键（与 deriveNotificationSummary 输出同源）。 */
const ENTITY_SUMMARY_KEYS = {
  task: 'taskId',
  run: 'runId',
  feature: 'featureId',
} as const;

function corrupt(message: string, deliveryId?: string): never {
  throw new StorageError('corrupt', OPERATION, message, {
    ...(deliveryId === undefined ? {} : { entity: { type: 'notification_delivery', id: deliveryId } }),
    details: { reason: 'notification_query_corrupt' },
  });
}

interface ListRow extends NotificationDeliveryRow {
  readonly last_outcome: string | null;
  readonly last_failure_reason: string | null;
}

function toListRow(row: ListRow): NotificationDeliveryListRow {
  const delivery = mapNotificationDeliveryRow(row);
  let lastOutcome: NotificationDeliveryListRow['lastOutcome'] = null;
  if (row.last_outcome !== null) {
    if (row.last_outcome !== 'succeeded' && row.last_outcome !== 'failed') {
      corrupt('最近尝试结果词汇损坏', row.id);
    }
    lastOutcome = row.last_outcome;
  }
  if ((lastOutcome === 'failed') !== (row.last_failure_reason !== null)) {
    corrupt('最近尝试失败原因形状损坏', row.id);
  }
  if (row.last_failure_reason !== null && (row.last_failure_reason.length === 0 || row.last_failure_reason.length > 256)) {
    corrupt('最近尝试失败原因长度损坏', row.id);
  }
  return { delivery, lastOutcome, lastFailureReason: row.last_failure_reason };
}

function assertRequest(request: NotificationListRequest): void {
  if (
    request === null || typeof request !== 'object'
    || request.after !== null && (request.after === undefined
      || typeof request.after.eventSequence !== 'number' || !Number.isSafeInteger(request.after.eventSequence) || request.after.eventSequence < 0
      || typeof request.after.deliveryId !== 'string' || request.after.deliveryId.length === 0)
    || typeof request.limit !== 'number' || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200
  ) {
    throw new TypeError('NotificationQueryStore: 非法分页请求（服务端内部调用）');
  }
}

/**
 * 通知发送状态/详情只读查询装配。session 生命周期由调用方管理；import
 * 本模块无副作用。
 */
export function createSqliteNotificationQueryStore(
  session: SqliteStorageSession,
): NotificationQueryReadStore {
  return {
    listNotificationDeliveries(project, requestInput): NotificationDeliveryPage {
      const projectId = validateStableId(project, { operation: OPERATION }, 'projectId');
      const request = requestInput as NotificationListRequest;
      assertRequest(request);
      if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
      const assemble = (): NotificationDeliveryPage => {
        const clauses: string[] = ['d.project_id = ?'];
        const params: unknown[] = [projectId];
        if (request.status !== undefined) {
          clauses.push('d.status = ?');
          params.push(request.status);
        }
        if (request.entity !== undefined) {
          const entity: NotificationEntityFilter = request.entity;
          const summaryKey = ENTITY_SUMMARY_KEYS[entity.kind];
          clauses.push("json_extract(d.summary_json, '$." + summaryKey + "') = ?");
          params.push(entity.id);
        }
        if (request.after !== null) {
          const after = request.after;
          clauses.push('(d.event_sequence > ? OR (d.event_sequence = ? AND d.id > ?))');
          params.push(after.eventSequence, after.eventSequence, after.deliveryId);
        }
        const rows = db.prepare<unknown[], ListRow>(
          `SELECT d.*, ` +
            '(SELECT r.outcome FROM notification_delivery_results r WHERE r.delivery_id = d.id ORDER BY r.attempt DESC LIMIT 1) AS last_outcome, ' +
            '(SELECT r.failure_reason FROM notification_delivery_results r WHERE r.delivery_id = d.id ORDER BY r.attempt DESC LIMIT 1) AS last_failure_reason ' +
            `FROM notification_deliveries d WHERE ${clauses.join(' AND ')} ORDER BY d.event_sequence, d.id LIMIT ?`,
        ).all(...params, request.limit + 1);
        const kept = rows.length > request.limit ? rows.slice(0, request.limit) : rows;
        const last = kept[kept.length - 1];
        return {
          rows: kept.map(toListRow),
          nextKey: rows.length > request.limit && last !== undefined
            ? { eventSequence: last.event_sequence, deliveryId: last.id }
            : null,
        };
      };
      const db = session.database;
      return db.inTransaction ? assemble() : transactSqliteConsistentRead(session, OPERATION, assemble);
    },

    readNotificationDelivery(project, deliveryIdInput): NotificationDeliveryDetail | undefined {
      const projectId = validateStableId(project, { operation: OPERATION }, 'projectId');
      const deliveryId = validateStableId(deliveryIdInput, { operation: OPERATION }, 'deliveryId');
      if (!session.isOpen()) throw new StorageError('corrupt', OPERATION, 'Storage session is closed');
      const assemble = (): NotificationDeliveryDetail | undefined => {
        const row = db.prepare<[string], NotificationDeliveryRow>(
          'SELECT * FROM notification_deliveries WHERE id = ?',
        ).get(deliveryId);
        if (row === undefined || row.project_id !== projectId) return undefined;
        const delivery = mapNotificationDeliveryRow(row);
        const resultRows = db.prepare<[string], NotificationResultRow>(
          'SELECT * FROM notification_delivery_results WHERE delivery_id = ? ORDER BY attempt ASC',
        ).all(deliveryId);
        if (resultRows.length > NOTIFICATION_DELIVERY_MAX_ATTEMPTS_LIMIT) {
          corrupt('本地结果链超出次数硬上限', deliveryId);
        }
        const results = resultRows.map(mapNotificationResultRow);
        for (const result of results) {
          if (result.projectId !== projectId) corrupt('本地结果链项目归属损坏', deliveryId);
        }
        const lastResult = results.length === 0 ? undefined : results[results.length - 1];
        return {
          delivery,
          lastOutcome: lastResult === undefined ? null : lastResult.outcome,
          lastFailureReason: lastResult === undefined ? null : lastResult.failureReason,
          results,
        };
      };
      const db = session.database;
      return db.inTransaction ? assemble() : transactSqliteConsistentRead(session, OPERATION, assemble);
    },
  };
}
