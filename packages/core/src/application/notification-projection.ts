/**
 * P07-4 / F-006 通知投影应用服务（application 层）。
 *
 * 职责（PRD FR-2、设计 03 §5、07 §5）：
 * - 在 NotificationDeliveryStore 的单事务投影原语之上施加有界轮次策略：
 *   每批 ≤ NOTIFICATION_PROJECTION_BATCH_MAX、每轮 ≤ 每轮批次数上限；积压按
 *   持久水位分批处理，不在内存中积累无界事件队列（仅保留计数与最后一批的
 *   有界 delivery 身份）；
 * - 每批是独立短事务：任何一批的容量/存储错误立即中止本轮，已提交批次的
 *   水位推进持久保留（可恢复位置），错误以脱敏结构化错误上抛（F-008 的
 *   Host 生命周期接线负责调度与诊断呈现）；
 * - 投影只读 state_events、只写通知表：不创建 Run/Attempt、不改变 Task、
 *   预算或检查结果（通知失败不改变业务结果）。
 *
 * 纯度不变量：不导入 HTTP/SSE/ORM/Pi SDK；不读时钟/文件系统/网络（时钟由
 * 存储适配器注入）；不建立通用事件工作流平台，也不修改业务派发。
 */
import {
  NOTIFICATION_CHANNEL_IDS,
  NOTIFICATION_PROJECTION_BATCH_DEFAULT,
  NOTIFICATION_PROJECTION_BATCH_MAX,
  type NotificationChannelId,
  type NotificationDeliveryStore,
  type NotificationProjectionBatchResult,
} from '../ports/notification-delivery.js';

/** 每轮默认批次数（小轮次：Host 唤醒间隔内做有界工作，剩余留待下轮）。 */
export const NOTIFICATION_PROJECTION_DEFAULT_BATCHES_PER_ROUND = 8 as const;
/** 每轮批次数硬上限（防止单轮退化为无界循环）。 */
export const NOTIFICATION_PROJECTION_MAX_BATCHES_PER_ROUND = 64 as const;

/** 服务装配选项（批大小/轮次预算越界在构造时拒绝，不静默截断）。 */
export interface NotificationProjectionServiceOptions {
  readonly store: NotificationDeliveryStore;
  /** 单批扫描事件数缺省值（1..500；默认 NOTIFICATION_PROJECTION_BATCH_DEFAULT）。 */
  readonly defaultBatchSize?: number;
  /** 每轮批次数上限（1..64；默认 8）。 */
  readonly maxBatchesPerRound?: number;
}

/** 单批/轮次投影的可选覆盖（渠道缺省为唯一内置本地渠道）。 */
export interface NotificationProjectionBatchOptions {
  readonly channelId?: NotificationChannelId;
  readonly batchSize?: number;
}

/** 一轮投影的有界结果：只保留计数与最后一批新建 delivery 身份。 */
export interface NotificationProjectionRoundResult {
  readonly channelId: NotificationChannelId;
  readonly batchesExecuted: number;
  readonly eventsScanned: number;
  readonly deliveriesCreated: number;
  readonly lastScannedSequence: number;
  readonly moreAvailable: boolean;
  /** 本轮最后一批新建的 delivery 身份（长度 ≤ 单批上限）。 */
  readonly lastBatchCreatedDeliveryIds: readonly string[];
}

export interface NotificationProjectionService {
  /** 投影下一批（单短事务；错误上抛，已推进水位持久保留）。 */
  projectNextBatch(input?: NotificationProjectionBatchOptions): NotificationProjectionBatchResult;
  /** 有界轮次：连续投影至无更多事件或批次数预算耗尽；错误中止并上抛。 */
  runProjectionRound(input?: NotificationProjectionBatchOptions): NotificationProjectionRoundResult;
}

function requireOptionInteger(name: string, value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(
      `createNotificationProjectionService: ${name} 必须是 ${min}..${max} 的整数，实际：${String(value)}`,
    );
  }
  return value;
}

/**
 * 装配通知投影服务。批大小与轮次预算在构造时校验；运行时请求仍由存储端口
 * 逐次校验（未知渠道/越界批大小在写入前拒绝）。
 */
export function createNotificationProjectionService(
  options: NotificationProjectionServiceOptions,
): NotificationProjectionService {
  if (options === null || typeof options !== 'object' || typeof options.store?.projectNotificationBatch !== 'function') {
    throw new TypeError('createNotificationProjectionService: store 必须是 NotificationDeliveryStore');
  }
  const defaultBatchSize = requireOptionInteger(
    'defaultBatchSize', options.defaultBatchSize, 1, NOTIFICATION_PROJECTION_BATCH_MAX, NOTIFICATION_PROJECTION_BATCH_DEFAULT,
  );
  const maxBatchesPerRound = requireOptionInteger(
    'maxBatchesPerRound', options.maxBatchesPerRound, 1, NOTIFICATION_PROJECTION_MAX_BATCHES_PER_ROUND,
    NOTIFICATION_PROJECTION_DEFAULT_BATCHES_PER_ROUND,
  );
  const { store } = options;

  function nextRequest(input: NotificationProjectionBatchOptions | undefined): Record<string, unknown> {
    const channelId = input?.channelId ?? NOTIFICATION_CHANNEL_IDS[0];
    return { channelId, batchSize: input?.batchSize ?? defaultBatchSize };
  }

  function projectNextBatch(
    input: NotificationProjectionBatchOptions | undefined,
  ): NotificationProjectionBatchResult {
    return store.projectNotificationBatch(nextRequest(input));
  }

  function runProjectionRound(
    input: NotificationProjectionBatchOptions | undefined,
  ): NotificationProjectionRoundResult {
    const request = nextRequest(input);
    let batchesExecuted = 0;
    let eventsScanned = 0;
    let deliveriesCreated = 0;
    // 有界循环：批次数预算耗尽或无更多事件即停；每批是独立短事务。
    // maxBatchesPerRound ≥ 1（构造时校验），循环至少执行一批。
    let lastBatch: NotificationProjectionBatchResult | undefined;
    while (batchesExecuted < maxBatchesPerRound) {
      const batch = store.projectNotificationBatch(request);
      batchesExecuted += 1;
      eventsScanned += batch.scannedCount;
      deliveriesCreated += batch.createdDeliveries.length;
      lastBatch = batch;
      if (!batch.moreAvailable) {
        break;
      }
    }
    const finished: NotificationProjectionBatchResult = lastBatch!;
    return {
      channelId: finished.channelId,
      batchesExecuted,
      eventsScanned,
      deliveriesCreated,
      lastScannedSequence: finished.lastScannedSequence,
      moreAvailable: finished.moreAvailable,
      lastBatchCreatedDeliveryIds: finished.createdDeliveries.map((delivery) => delivery.deliveryId),
    };
  }

  return Object.freeze({ projectNextBatch, runProjectionRound });
}
